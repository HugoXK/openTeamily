import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The management workflow does not use a glob: it names every node test file on
// its own line. A page test that nobody adds there silently never runs, and two
// PRs that each add the same line run it twice, so this guard compares the
// directory against the workflow text in both directions and counts repeats.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'tests.yml');

export function listedTestFiles(source) {
  const listed = [];
  for (const match of source.matchAll(/node --test (tests\/[\w.-]+\.test\.mjs)/g)) {
    listed.push(match[1]);
  }
  return listed;
}

export function testFilesOnDisk(testsDir) {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => 'tests/' + name);
}

test('the CI workflow names every tests/*.test.mjs exactly once, and names none that is gone', () => {
  const listed = listedTestFiles(readFileSync(WORKFLOW, 'utf8'));
  const onDisk = testFilesOnDisk(path.join(root, 'tests'));
  const counted = new Map();
  for (const file of listed) counted.set(file, (counted.get(file) || 0) + 1);
  const missing = onDisk.filter((file) => !counted.has(file));
  const repeated = [...counted].filter(([, times]) => times > 1).map(([file]) => file).sort();
  const stale = [...counted.keys()].filter((file) => !onDisk.includes(file)).sort();
  assert.deepEqual(
    missing,
    [],
    'these test files exist but CI never runs them: ' + (missing.join(', ') || '(none)'),
  );
  assert.deepEqual(
    repeated,
    [],
    'the workflow runs these test files more than once: ' + (repeated.join(', ') || '(none)'),
  );
  assert.deepEqual(
    stale,
    [],
    'the workflow names test files that no longer exist: ' + (stale.join(', ') || '(none)'),
  );
});
