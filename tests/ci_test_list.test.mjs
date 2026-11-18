import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The management workflow does not use a glob: it names every node test file on
// its own line. A page test that nobody adds there silently never runs, so this
// guard compares the directory against the workflow text.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'tests.yml');

export function listedTestFiles(source) {
  const listed = new Set();
  for (const match of source.matchAll(/node --test (tests\/[\w.-]+\.test\.mjs)/g)) {
    listed.add(match[1]);
  }
  return listed;
}

export function testFilesOnDisk(testsDir) {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => 'tests/' + name);
}

test('the CI workflow names every tests/*.test.mjs, and names none that is gone', () => {
  const listed = listedTestFiles(readFileSync(WORKFLOW, 'utf8'));
  const onDisk = testFilesOnDisk(path.join(root, 'tests'));
  const missing = onDisk.filter((file) => !listed.has(file));
  const stale = [...listed].filter((file) => !onDisk.includes(file)).sort();
  assert.deepEqual(
    missing,
    [],
    'these test files exist but CI never runs them: ' + (missing.join(', ') || '(none)'),
  );
  assert.deepEqual(
    stale,
    [],
    'the workflow names test files that no longer exist: ' + (stale.join(', ') || '(none)'),
  );
});
