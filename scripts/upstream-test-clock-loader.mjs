// Owned test-only completion overlay; pinned vendor bytes/assertions stay intact.
// The component runs in a VM Promise realm, so even a host microtask barrier
// cannot order its awaited send. Observe the ACTUAL dismiss/error callback.
import { createHash } from 'node:crypto';
import {target as cleanupTarget,transformRestartFixture} from './upstream-test-cleanup-overlay.mjs';
export const target = new URL('../runtime/ds-bot-upstream/ds-bot/test/text-annotation.test.js', import.meta.url).href;
export const oldHelper = 'const settle = () => new Promise(resolve => setTimeout(resolve, 5))';
export const newHelper = 'const settle = app => app.settled';
export const replacements = [
  [oldHelper, newHelper, 1],
  ['  const calls = { clear: 0, dismiss: 0 }', '  const calls = { clear: 0, dismiss: 0 }\n  let finish\n  const settled = new Promise(resolve => { finish = resolve })', 1],
  ['dismiss: () => { calls.dismiss += 1 }', 'dismiss: () => { calls.dismiss += 1; finish() }', 1],
  ['reportError: (...args) => { errors.push(args) }', 'reportError: (...args) => { errors.push(args); finish() }', 1],
  ['return { props, sent, inserted, errors, calls, render, openEditor, setSelectedText(next)', 'return { props, sent, inserted, errors, calls, render, openEditor, settled, setSelectedText(next)', 1],
  ['await settle()', 'await settle(app)', 5],
];
const expected = 'a5ada9ad5a0fc2f4ea2b034c6ea028f5de4972bf2e91aee9462f29d612eec4e7';
export function transformAnnotationFixture(source) {
  if (createHash('sha256').update(source).digest('hex') !== expected)
    throw new Error('Upstream annotation fixture changed: review completion overlay, never silently patch it');
  for (const [before, after, count] of replacements) {
    if (source.split(before).length !== count + 1) throw new Error('Unexpected completion fixture wiring');
    source = source.replaceAll(before, after);
  }
  return source;
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if(url===cleanupTarget)return {...result,source:transformRestartFixture(Buffer.from(result.source).toString('utf8'))};
  if (url !== target) return result;
  return { ...result, source: transformAnnotationFixture(Buffer.from(result.source).toString('utf8')) };
}
