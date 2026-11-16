import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const collect = join(root, 'inventory/collect.mjs')
const validate = join(root, 'inventory/validate.mjs')
const fixture = join(root, 'inventory/testdata/fake-root')
const claudeFixture = join(root, 'inventory/testdata/fake-root-with-claude')

function runCollect(tree) {
  const out = mkdtempSync(join(tmpdir(), 'ot-inv-'))
  const result = spawnSync(process.execPath, [collect, '--root', tree, '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return {
    out,
    inventory: JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8')),
    summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')),
    markdown: readFileSync(join(out, 'inventory.md'), 'utf8'),
  }
}

function runValidate(path, extra = []) {
  return spawnSync(process.execPath, [validate, ...extra, '--inventory', path], { encoding: 'utf8' })
}

test('fixture inventory records OS, npm closures, fonts, and bundled notices', () => {
  const { out, inventory, summary, markdown } = runCollect(fixture)
  try {
    assert.equal(inventory.not_a_legal_opinion, true)
    assert.equal(inventory.public_redistributable_image, false)
    assert.equal(inventory.office_functionality, 'retained')
    assert.equal(inventory.os.os_release.VERSION_CODENAME, 'bookworm')
    assert.equal(inventory.os.package_count, 2)
    const git = inventory.os.packages.find((p) => p.name === 'git')
    assert.ok(git)
    assert.equal(git.source_package, 'git')
    assert.equal(git.copyright_path, '/usr/share/doc/git/copyright')
    assert.match(git.copyright_sha256, /^[0-9a-f]{64}$/)
    assert.ok(git.copyright_fields.licenses.includes('GPL-2'))
    assert.equal(git.source_pointer.kind, 'debian_deb_src_pointer')
    assert.match(git.source_pointer.note, /apt-get source/)

    const dsh = inventory.npm.trees.global_dsh.packages.find((p) => p.name === '@deepseek-ai/dsh')
    assert.equal(dsh.version, '0.2.2-rc.1')
    assert.equal(dsh.license_field, 'MIT')
    assert.equal(dsh.license_field_is, 'npm metadata declaration')
    const kit = inventory.npm.trees.global_dsh.packages.find((p) => p.name === '@deepseek-ai/libreoffice-kit')
    assert.equal(kit.license_field, 'MPL-2.0')
    assert.ok(inventory.npm.trees.dsbot.packages.some((p) => p.name === 'ws'))
    assert.ok(inventory.npm.trees.profile_web.packages.some((p) => p.name === 'katex'))
    assert.ok(inventory.npm.trees.profile_web.packages.some((p) => p.name === 'linked-fixture-pkg'))

    assert.equal(inventory.claude.present, false)
    assert.equal(inventory.fonts.file_count, 1)
    assert.ok(inventory.fonts.files[0].path.endsWith('KaTeX_Main-Regular.woff2'))
    const ofl = inventory.fonts.notices.find((n) => n.path.endsWith('/OFL.txt'))
    assert.ok(ofl)
    assert.match(ofl.text, /SIL OPEN FONT LICENSE/)
    const flybotNotice = inventory.bundled_notices.files.find((f) => f.path === '/opt/licenses/flybot/NOTICE')
    assert.equal(flybotNotice.mentions_trademark, true)
    assert.ok(inventory.bundled_notices.files.some((f) => f.path.includes('libreoffice-kit')))
    assert.match(markdown, /not.*legal opinion/i)
    assert.equal(summary.claude_present, false)

    const checked = runValidate(join(out, 'inventory.json'))
    assert.equal(checked.status, 0, checked.stderr || checked.stdout)
    const imageLike = structuredClone(inventory)
    imageLike.npm.trees.profile_web.package_count = 1
    imageLike.bundled_notices.files = [
      ...(imageLike.bundled_notices.files || []),
      { path: '/opt/licenses/font-notices/katex/LICENSE' },
      { path: '/opt/licenses/sharp-libvips/THIRD-PARTY-NOTICES.md' },
      { path: '/opt/licenses/sharp-libvips/LGPL-3.0.txt' },
      { path: '/opt/licenses/anthropic-sdk/LICENSE' },
    ]
    imageLike.fonts.files = [...(imageLike.fonts.files || []), { path: '/opt/demo/KaTeX_Main-Regular.woff2' }]
    imageLike.fonts.notices = [...(imageLike.fonts.notices || []), { path: '/opt/demo/KaTeX-LICENSE.txt' }]
    const weak = join(out, 'weak-profile.json')
    writeFileSync(weak, JSON.stringify(imageLike))
    const expectImage = runValidate(weak, ['--expect-image'])
    assert.notEqual(expectImage.status, 0)
    assert.match(expectImage.stderr, /linked packages/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('claude payload presence and license text are recorded when the tree contains them', () => {
  const { out, inventory } = runCollect(claudeFixture)
  try {
    assert.equal(inventory.claude.present, true)
    const sdk = inventory.claude.packages_found.find((p) => p.name === '@anthropic-ai/claude-agent-sdk')
    assert.ok(sdk)
    assert.equal(sdk.license_field, 'SEE LICENSE IN LICENSE.md')
    assert.match(sdk.license_texts[0].text, /Commercial terms fixture/)
    assert.equal(inventory.public_redistributable_image, false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('validate rejects a public-image clearance claim', () => {
  const { out, inventory } = runCollect(fixture)
  try {
    inventory.public_redistributable_image = true
    const bad = join(out, 'bad.json')
    writeFileSync(bad, JSON.stringify(inventory))
    const checked = runValidate(bad)
    assert.notEqual(checked.status, 0)
    assert.match(checked.stderr, /public redistributable image/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
