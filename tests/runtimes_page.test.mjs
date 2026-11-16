import assert from 'node:assert/strict';
import test from 'node:test';
import { installCommands, listItemHasSecret, readKeyForm } from '../openteamily/static/runtimes/app.mjs';

test('readKeyForm omits expiry when never is selected', () => {
  const values = {name: ' Laptop ', expires: 'never'};
  const fake = {get(name) { return values[name]; }};
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readKeyForm({}), {name: 'Laptop'});
    values.expires = 'd7';
    assert.deepEqual(readKeyForm({}), {name: 'Laptop', expires_in: 604800});
  } finally {
    globalThis.FormData = original;
  }
});

test('install commands use the current origin and FlyBot names', () => {
  const commands = installCommands('https://management.test/');
  assert.match(commands.unix, /install\/flybot\.pyz/);
  assert.equal(commands.daemon, 'python3 flybot.pyz daemon start --origin https://management.test --key-file ./runtime-key');
  assert.equal(commands.unix.includes('teamily.com'), false);
  assert.equal(commands.unix.includes('curl -fsSL'), false);
  assert.equal(listItemHasSecret({name: 'x', prefix: 'abcd1234'}), false);
  assert.equal(listItemHasSecret({name: 'x', prefix: 'abcd1234', token: 'secret'}), true);
});
