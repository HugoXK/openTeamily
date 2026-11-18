import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResolvedTheme, resolveTheme } from '../openteamily/static/shell/app.mjs';

function at(hours, minutes = 0) {
  return new Date(2026, 10, 16, hours, minutes, 0);
}

test('resolveTheme keeps explicit light and dark', () => {
  assert.equal(resolveTheme({appearance: 'light'}), 'light');
  assert.equal(resolveTheme({appearance: 'dark'}), 'dark');
});

test('resolveTheme follows the system preference when appearance is system', () => {
  assert.equal(resolveTheme({appearance: 'system'}, at(12), {matches: true}), 'dark');
  assert.equal(resolveTheme({appearance: 'system'}, at(12), {matches: false}), 'light');
  assert.equal(resolveTheme({}, at(12), {matches: false}), 'light');
});

test('resolveTheme uses a custom auto window, including ranges that wrap midnight', () => {
  const values = {appearance: 'auto', appearance_schedule: 'custom',
                  appearance_start: '22:00', appearance_end: '06:30'};
  assert.equal(resolveTheme(values, at(22, 0), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(23, 15), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(6, 29), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(6, 30), {matches: false}), 'light');
  assert.equal(resolveTheme(values, at(12, 0), {matches: true}), 'light');
  const daytime = {appearance: 'auto', appearance_schedule: 'custom',
                   appearance_start: '09:00', appearance_end: '17:00'};
  assert.equal(resolveTheme(daytime, at(9, 0), {matches: false}), 'dark');
  assert.equal(resolveTheme(daytime, at(16, 59), {matches: false}), 'dark');
  assert.equal(resolveTheme(daytime, at(17, 0), {matches: false}), 'light');
});

/*「自动」has no location to work from, so sunset_sunrise resolves to a fixed night window
instead of silently handing the answer to prefers-color-scheme: 22:00 inclusive to 06:00
exclusive is night, the rest of the day is light. Every call passes `media` explicitly, so a
light answer proves the window decided rather than the device. */
test('resolveTheme reads sunset_sunrise as the fixed 22:00-06:00 night window', () => {
  const values = {appearance: 'auto', appearance_schedule: 'sunset_sunrise',
                  appearance_start: '22:00', appearance_end: '06:30'};
  assert.equal(resolveTheme(values, at(21, 59), {matches: false}), 'light');
  assert.equal(resolveTheme(values, at(22, 0), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(5, 59), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(6, 0), {matches: false}), 'light');
  assert.equal(resolveTheme(values, at(12, 0), {matches: true}), 'light');
});

test('the night window is the same block of hours on either side of midnight', () => {
  const night = {appearance: 'auto', appearance_schedule: 'sunset_sunrise'};
  for (const now of [at(22, 0), at(23, 30), at(0, 0), at(3, 0), at(5, 59)]) {
    assert.equal(resolveTheme(night, now, {matches: false}), 'dark', now.toTimeString());
  }
  for (const now of [at(6, 0), at(9, 0), at(12, 0), at(18, 0), at(21, 59)]) {
    assert.equal(resolveTheme(night, now, {matches: true}), 'light', now.toTimeString());
  }
});

test('following the system still follows prefers-color-scheme, night or not', () => {
  assert.equal(resolveTheme({appearance: 'system'}, at(23, 30), {matches: true}), 'dark');
  assert.equal(resolveTheme({appearance: 'system'}, at(23, 30), {matches: false}), 'light');
  assert.equal(resolveTheme({}, at(23, 30), {matches: false}), 'light');
});

test('resolveTheme falls back when a custom window is incomplete', () => {
  const values = {appearance: 'auto', appearance_schedule: 'custom',
                  appearance_start: '22:00'};
  assert.equal(resolveTheme(values, at(23, 0), {matches: true}), 'dark');
  assert.equal(resolveTheme({appearance: 'auto', appearance_schedule: 'custom',
                             appearance_start: '08:00', appearance_end: '08:00'},
                            at(8, 0), {matches: false}), 'light');
});

test('applyResolvedTheme records the resolved theme on the document', () => {
  const doc = {documentElement: {dataset: {}}, body: {dataset: {}}};
  assert.equal(applyResolvedTheme(doc, {appearance: 'dark'}), 'dark');
  assert.equal(doc.documentElement.dataset.themeResolved, 'dark');
  assert.equal(doc.body.dataset.themeResolved, 'dark');
});
