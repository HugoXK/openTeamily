// Apply the OpenTeamily integration to an image's copy of the pinned Apache-2.0
// DS-Bot source. Keep the upstream tree and pin in Git independently verifiable.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceDir = fileURLToPath(new URL('../ds-bot-upstream/ds-bot/', import.meta.url))
const patch = fileURLToPath(new URL('./native-ds-bot.patch', import.meta.url))
const files = {
  'client.js': [
    'cf6f9ddbf898ded9429c6895c43eea8175c9b57e2777f4800c8c4f89acd97035',
    'b9d2961997b21f6949d5a69500a80baf35db81273349e9c472f1228ed6b87fbc',
  ],
  'src/client/group-settings.js': [
    '4f4aa19f4972f734c6fe8d71553a6c17386d9418bd84e56106ed4e48b9b7fdca',
    'bd0c0d833731c1a43a5d6413faf9201d10125188813a0fb571a791670157ab5a',
  ],
  'src/client/i18n.js': [
    '1124fb90ac4409c3bfff7f092800e98aa5590437c5372d3823a446ee427a2506',
    '5467513ec2ab35c6c8a6fd34555ff98c8f12a0d9904022f6d9f2dae49c0d840b',
  ],
  'src/client/new-chat.js': [
    '1086a6d2a199959cb73f088f8c19492dd2ad654425eb324688a0ae8b6c2d5176',
    '746883260e16ac825f6daf434bf5100b1f6182dd35dc5f2d8d37d6dcc968b53c',
  ],
  'src/client/team-actions.js': [
    '2c7bb430115cc4bc44d714c1c7f12ec0965049774b6785d5434d20379ce714a6',
    'b2e71f4025da27fd8a1451ec5fe0a7954c26bb50cd652260ac0cf7dc6b14b770',
  ],
  'src/host/capabilities.js': [
    'de00bf540137da28f4bd3e28cec2af87b95a5f9672e4f5461da9c9e94a1cc1c3',
    '39669aba5c52ffc9ae505c6bf52e8494c443a4d2f5f84206213962a8b5c2cba8',
  ],
  'src/host/channel.js': [
    '705ef779835e55100f3eaa04cd7e995e4fcc7a02eb3ad9fd976cedbd904d6aa4',
    '85af8f7e5aed482bf79f36cd750452c6486acb60c27e74303803f5a52146f76e',
  ],
}

const digest = (root, path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')

export function applyNativeOverlay(root) {
  const observed = Object.entries(files).map(([path, [upstream, deployed]]) => ({
    path, upstream, deployed, bytes: digest(root, path),
  }))
  if (observed.every(file => file.bytes === file.deployed)) return
  const invalid = observed.find(file => file.bytes !== file.upstream)
  if (invalid) throw new Error(`Unexpected pinned DS-Bot source: ${invalid.path}`)
  execFileSync('git', ['apply', '--check', patch], { cwd: root, stdio: 'inherit' })
  execFileSync('git', ['apply', patch], { cwd: root, stdio: 'inherit' })
  for (const { path, deployed } of observed) {
    if (digest(root, path) !== deployed) throw new Error(`Unexpected DS-Bot overlay result: ${path}`)
  }
}

export function assertNativeConsentOverlay(root = sourceDir) {
  const path = 'src/host/capabilities.js'
  if (digest(root, path) !== files[path][1]) {
    throw new Error('Build the FlyBot image to load the OpenTeamily native skill consent integration')
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Pass the image build copy of the DS-Bot source directory')
  applyNativeOverlay(resolve(process.argv[2]))
}
