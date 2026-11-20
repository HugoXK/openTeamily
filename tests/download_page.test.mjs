import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { platformLabel } from '../openteamily/static/download/app.mjs';

const root = new URL('..', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

test('the download page says which platform the visitor is on', () => {
  const html = read('openteamily/static/download/index.html');
  assert.match(html, /id="download-platform"/,
    'the download page must name the platform the visitor is on');
});

test('platformLabel names the OS and browser from the user agent, and admits when it cannot', () => {
  const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  assert.equal(platformLabel({userAgent: chromeMac, platform: 'MacIntel'}), 'macOS · Chrome');
  const edgeWin = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
  assert.equal(platformLabel({userAgent: edgeWin, platform: 'Win32'}), 'Windows · Edge');
  const firefoxLinux = 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0';
  assert.equal(platformLabel({userAgent: firefoxLinux, platform: 'Linux x86_64'}), 'Linux · Firefox');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(platformLabel({userAgent: iphone, platform: 'iPhone'}), 'iOS · Safari');
  assert.equal(platformLabel({userAgent: '', platform: ''}), '未知平台');
});

test('every install command the page prints exists in this repository', () => {
  const html = read('openteamily/static/download/index.html');
  const flybot = read('openteamily/flybot.py');
  const server = read('openteamily/settings_page.py');
  const commands = [...html.matchAll(/python3 [^\n<]+/g)].map((match) => match[0].trim());
  assert.ok(commands.length > 0, 'the page still prints at least one real command');
  for (const command of commands) {
    if (command.includes('flybot.pyz')) {
      assert.match(command, /daemon start --origin __ORIGIN__ --key-file/,
        `page prints a runtime command the repo does not implement: ${command}`);
      for (const flag of ['--origin', '--key-file', 'daemon start']) {
        assert.ok(flybot.includes(flag), `openteamily/flybot.py must implement ${flag}, quoted by: ${command}`);
      }
    } else if (command.includes('-m openteamily.flybot')) {
      assert.ok(flybot.includes("if __name__ == '__main__'"),
        `source-tree command needs an executable module entry point: ${command}`);
    } else {
      assert.fail(`page prints a command with no source in this repo: ${command}`);
    }
  }
  const links = [...html.matchAll(/href="(\/install\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(links.length > 0, 'the page still links the runtime download');
  for (const link of links) {
    assert.ok(server.includes(`'${link}'`),
      `page links a download the server does not serve: ${link}`);
  }
});

test('the page still says there is no official desktop or mobile client and links no store', () => {
  const html = read('openteamily/static/download/index.html');
  assert.match(html, /没有 OpenTeamily 的 iOS、Android、macOS 或 Windows 官方客户端/);
  assert.ok(!/apps\.apple\.com|play\.google\.com|microsoft\.com\/store/.test(html),
    'an honest download page must not link an app store');
});
