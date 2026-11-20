#!/usr/bin/env node
/**
 * Fold one shots.mjs report into evidence/<issue>/report.json.
 *
 *   node scripts/evidence-report.mjs <issue> <.shots/<slug>/report.json>
 *
 * Repeated runs MERGE instead of replacing, so a slice can be shot in passes
 * (e.g. 1440 full states first, then the 390 layout) without losing frames.
 * The result keeps, per image, the arm, the relative path, the PNG size, the
 * sha256, the DOM facts and the console lines — the same shape the earlier
 * evidence branches already publish.
 */
import fs from 'node:fs';
import path from 'node:path';

const [issue, source] = process.argv.slice(2);
if (!issue || !source) {
  process.stderr.write('usage: evidence-report.mjs <issue> <.shots/<slug>/report.json>\n');
  process.exit(2);
}

const incoming = JSON.parse(fs.readFileSync(source, 'utf8'));
const dir = path.join('evidence', issue);
const target = path.join(dir, 'report.json');
fs.mkdirSync(dir, {recursive: true});
const previous = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;

const arms = {...(previous?.arms || {})};
for (const side of incoming.sides || []) {
  if (side.ref) arms[side.name] = side.ref;
}

const images = new Map();
for (const image of previous?.images || []) images.set(`${image.arm}:${image.file}`, image);
const viewportOf = (image) => image.viewport
  || `${image.png?.width}x${image.png?.height}`;
for (const image of incoming.images || []) {
  const viewport = image.viewport || viewportOf(image);
  images.set(`${image.arm}:${image.file}`, {
    arm: image.arm,
    file: image.file,
    state: image.state,
    viewport,
    locale: image.locale,
    theme: image.theme,
    route: image.route,
    png: image.png,
    viewport_size_ok: Boolean(image.png)
      && image.png.width === Number(viewport.split('x')[0])
      && image.png.height === Number(viewport.split('x')[1]),
    sha256: image.sha256,
    facts: image.facts,
    console: image.console,
  });
}

const failures = [];
for (const failure of [...(previous?.failures || []), ...(incoming.failures || [])]) {
  const key = `${failure.arm}:${failure.viewport}:${failure.locale}:${failure.theme}`;
  if (!failures.some((item) => `${item.arm}:${item.viewport}:${item.locale}:${item.theme}` === key)) {
    failures.push(failure);
  }
}

const sorted = [...images.values()].sort((a, b) => {
  const arm = String(a.arm).localeCompare(String(b.arm));
  if (arm) return arm;
  const vp = Number(b.viewport.split('x')[0]) - Number(a.viewport.split('x')[0]);
  if (vp) return vp;
  const state = String(a.state).localeCompare(String(b.state));
  return state || String(a.file).localeCompare(String(b.file));
});

const perArm = {};
for (const image of sorted) {
  perArm[image.arm] = perArm[image.arm] || {ref: arms[image.arm] || '', count: 0};
  perArm[image.arm].count += 1;
}
for (const name of Object.keys(arms)) {
  perArm[name] = perArm[name] || {ref: arms[name], count: 0};
  perArm[name].ref = arms[name];
}

const report = {
  issue,
  arms,
  grid: {
    viewports: [...new Set(sorted.map((image) => image.viewport))].sort(),
    locales: [...new Set(sorted.map((image) => image.locale))].sort(),
    themes: [...new Set(sorted.map((image) => image.theme))].sort(),
    states: [...new Set(sorted.map((image) => image.state))].sort(),
  },
  counts: perArm,
  reuse: incoming.reuse || previous?.reuse,
  generated_at: new Date().toISOString(),
  images: sorted,
  failures,
};
fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);

const png = sorted.length;
const bad = sorted.filter((image) => image.viewport_size_ok === false).length;
process.stdout.write(`evidence/${issue}/report.json: ${png} png, size-mismatch=${bad}, `
  + `failures=${failures.length}, arms=${JSON.stringify(arms)}\n`);
if (report.reuse?.theme) process.stdout.write(`Reuse: dsh ${report.reuse.theme.split(' — ')[0]}\n`);
if (bad || failures.length) process.exitCode = 1;
