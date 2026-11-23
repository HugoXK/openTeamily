// Deterministic, explainable ranking for Discover works and agents (#462).
//
// This module moved from `runtime/openteamily-web/features/discover/ranking.js` to
// Bot Social because Discover candidates (public listings, likes, collections,
// follows) are shared state; the per-user DS-Bot copy could not see another
// member's engagement. It is a pure heuristic: no ML model, no personalisation,
// no network, no database and no clock. The caller passes the candidates, the
// current time, the caller's workspace, optional follow and seen ids and weights;
// the same inputs always produce the same order.
//
// Isolation is part of the contract, not a caller courtesy: only candidates that
// are explicitly public (`listed: true`) and belong to the caller's workspace are
// ranked. Anything else is dropped before its id/author/created is validated, so
// a foreign or private row can neither enter the result nor make the call fail.
//
// Scoring: recency is `0.5 ** (age / DEFAULT_RECENCY_HALF_LIFE)` with
// `age = max(0, now - created)`, so a future timestamp never scores above 1.
// Engagement is `log1p(sum(weight * metric))`; missing or malformed metrics are
// zero. A followed author adds the follow weight. A seen id multiplies the final
// score by `seen_penalty` and is never excluded. Author diversity is a hard cap
// on the returned top list, so a request can return fewer than `limit` rows.
//
// Tie-breaking is deterministic and locale-free: score descending, then
// `created` descending, then id ascending by code unit. Duplicate ids are
// rejected. `paginate` uses an opaque URL-safe base64 offset cursor; it is opaque
// for API ergonomics, not signed, so callers must page the same ranked list.

export type Mapping = Record<string, any>;

export const DEFAULT_RECENCY_HALF_LIFE = 7 * 24 * 60 * 60;
export const MAX_LIMIT = 100;
export const MAX_AUTHOR_CAP = 100;
export const MAX_WEIGHT = 1000;

const INVALID = "discover/ranking-invalid";
const DEFAULT_LIMIT = 50;
const CURSOR_PREFIX = "otr1:";

export const DEFAULT_WORK_WEIGHTS = Object.freeze({
  recency: 1,
  engagement: 1,
  likes: 1,
  collects: 2,
  comments: 1.5,
  follow: 1,
  seen_penalty: 0.25,
  author_cap: 3,
});

export const DEFAULT_AGENT_WEIGHTS = Object.freeze({
  recency: 1,
  engagement: 1,
  likes: 1.5,
  installs: 2,
  uses: 1,
  follow: 1,
  seen_penalty: 0.25,
  author_cap: 3,
});

type Weights = Record<string, number>;

const WORK_METRICS: [string, string][] = [["likes", "likes"], ["collects", "collects"], ["comments", "comments"]];
const AGENT_METRICS: [string, string][] = [["likes", "likes"], ["installs", "installs"], ["uses", "uses"]];
const REASON_KEYS = ["recency", "engagement", "engagement_value", "follow", "base", "seen_penalty", "score"];

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID });
}

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return value !== null && value !== undefined && typeof (value as any)[Symbol.iterator] === "function";
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value;
}

function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function limitOf(value: unknown, fallback = DEFAULT_LIMIT): number {
  const limit = value === undefined ? fallback : value;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    fail(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit as number;
}

function weightsOf(weights: unknown, defaults: Readonly<Weights>): Weights {
  const resolved: Weights = { ...defaults };
  if (weights === undefined || weights === null) return resolved;
  if (!isMapping(weights)) fail("weights must be a mapping");
  for (const [key, value] of Object.entries(weights as Mapping)) {
    if (!Object.hasOwn(defaults, key)) fail(`unknown weight: ${key}`);
    if (key === "author_cap") {
      if (!Number.isInteger(value) || value < 1 || value > MAX_AUTHOR_CAP) {
        fail(`author_cap must be an integer between 1 and ${MAX_AUTHOR_CAP}`);
      }
      resolved[key] = value;
      continue;
    }
    const number = count(value, `weight ${key}`);
    if (number < 0) fail("weights must be non-negative");
    if (number > MAX_WEIGHT) fail(`weight ${key} exceeds ${MAX_WEIGHT}`);
    if (key === "seen_penalty" && number > 1) fail("seen_penalty must be between 0 and 1");
    resolved[key] = number;
  }
  return resolved;
}

function idSet(value: unknown, name: string): Set<string> {
  if (value === undefined || value === null) return new Set();
  const candidates = typeof value === "string" ? [value] : isIterable(value) ? [...value] : null;
  if (candidates === null) fail(`${name} must be an iterable of ids`);
  const result = new Set<string>();
  for (const candidate of candidates) result.add(text(candidate, `${name} entry`));
  return result;
}

function metricOf(item: Mapping, key: string): number {
  const value = item[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function authorOf(item: Mapping, fields: string[]): string {
  for (const field of fields) {
    const value = item[field];
    if (value !== undefined && value !== null) return text(value, field);
  }
  return fail(`item is missing a required author field: ${fields.join("/")}`);
}

// Public, same-workspace candidates only. A malformed foreign row is dropped
// before validation; a malformed item that claims to be ours is refused.
function visible(item: unknown, workspaceId: string): item is Mapping {
  if (!isMapping(item)) fail("item must be a mapping");
  return item.workspace_id === workspaceId && (item.listed === true || item.listed === 1);
}

export interface RankOptions {
  workspaceId?: string;
  weights?: Mapping;
  followingAuthors?: unknown;
  followingCreators?: unknown;
  seenIds?: unknown;
  limit?: number;
}

export interface RankedItem extends Mapping {
  id: string;
  score: number;
  reasons: Mapping;
}

interface Candidate {
  score: number;
  created: number;
  id: string;
  author: string;
  result: RankedItem;
}

function rank(
  items: unknown,
  now: unknown,
  options: RankOptions | undefined,
  defaults: Readonly<Weights>,
  authorFields: string[],
  metricKeys: [string, string][],
): RankedItem[] {
  const opts: Mapping = options === undefined || options === null ? {} : options;
  if (!isMapping(opts)) fail("options must be a mapping");
  const nowValue = count(now, "now");
  const workspaceId = text(opts.workspaceId, "workspaceId");
  const weights = weightsOf(opts.weights, defaults);
  const limit = limitOf(opts.limit);
  const following = idSet(opts.followingAuthors ?? opts.followingCreators, "following ids");
  const seen = idSet(opts.seenIds, "seen_ids");
  const source: unknown[] = items === undefined || items === null ? [] : isIterable(items) ? [...items] : fail("items must be an iterable");

  const candidates: Candidate[] = [];
  const itemIds = new Set<string>();
  for (const item of source) {
    if (!visible(item, workspaceId)) continue;
    const itemId = text(item.id, "id");
    if (itemIds.has(itemId)) fail(`duplicate item id: ${itemId}`);
    itemIds.add(itemId);
    const author = authorOf(item, authorFields);
    const created = count(item.created, "created");
    const result = { ...item } as RankedItem;

    const age = Math.max(0, nowValue - created);
    const recency = 0.5 ** (age / DEFAULT_RECENCY_HALF_LIFE);
    let weightedCounts = 0;
    for (const [itemKey, weightKey] of metricKeys) weightedCounts += weights[weightKey] * metricOf(item, itemKey);
    const engagementValue = Math.log1p(weightedCounts);

    const recencyComponent = weights.recency * recency;
    const engagementComponent = weights.engagement * engagementValue;
    const followComponent = following.has(author) ? weights.follow : 0;
    const base = recencyComponent + engagementComponent + followComponent;
    const seenPenalty = seen.has(itemId) ? weights.seen_penalty : 1;
    const score = base * seenPenalty;

    result.score = score;
    result.reasons = {
      recency: recencyComponent,
      engagement: engagementComponent,
      engagement_value: engagementValue,
      follow: followComponent,
      base,
      seen_penalty: seenPenalty,
      score,
    };
    candidates.push({ score, created, id: itemId, author, result });
  }

  candidates.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.created !== right.created) return right.created - left.created;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const authorCounts = new Map<string, number>();
  const ranked: RankedItem[] = [];
  for (const row of candidates) {
    const held = authorCounts.get(row.author) ?? 0;
    if (held >= weights.author_cap) continue;
    authorCounts.set(row.author, held + 1);
    ranked.push(row.result);
    if (ranked.length >= limit) break;
  }
  return ranked;
}

export function rankWorks(items: unknown, now: unknown, options?: RankOptions): RankedItem[] {
  return rank(items, now, options, DEFAULT_WORK_WEIGHTS, ["author_id", "creator_id"], WORK_METRICS);
}

export function rankAgents(items: unknown, now: unknown, options?: RankOptions): RankedItem[] {
  return rank(items, now, options, DEFAULT_AGENT_WEIGHTS, ["creator_id", "author_id"], AGENT_METRICS);
}

export function explain(rankedItem: unknown): Mapping {
  if (!isMapping(rankedItem)) fail("ranked item must be a mapping");
  const reasons = rankedItem.reasons;
  if (!isMapping(reasons)) fail("ranked item has no reasons");
  for (const key of REASON_KEYS) {
    if (!Object.hasOwn(reasons, key)) fail(`ranked item reasons are missing ${key}`);
  }
  return { ...reasons };
}

function encodeCursor(offset: number): string {
  return Buffer.from(CURSOR_PREFIX + String(offset), "ascii").toString("base64url");
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail("invalid cursor");
  const raw = Buffer.from(cursor as string, "base64url").toString("ascii");
  if (!/^otr1:\d+$/.test(raw)) fail("invalid cursor");
  return Number(raw.slice(CURSOR_PREFIX.length));
}

export interface RankingPage {
  items: RankedItem[];
  next_cursor: string | null;
  cursor: string | null;
}

export function paginate(ranked: unknown, cursor: unknown, limit?: unknown): RankingPage {
  const resolvedLimit = limitOf(limit);
  const source: RankedItem[] = ranked === undefined || ranked === null ? [] : isIterable(ranked) ? ([...ranked] as RankedItem[]) : fail("ranked must be an iterable");
  const offset = decodeCursor(cursor);
  const page = source.slice(offset, offset + resolvedLimit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    next_cursor: nextOffset < source.length ? encodeCursor(nextOffset) : null,
    cursor: cursor === undefined || cursor === null || cursor === "" ? null : (cursor as string),
  };
}
