import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '..', '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('image matches the compose manager contract (UID 1000, port 8080, healthcheck)', () => {
  const docker = read('Dockerfile')
  assert.match(docker, /^\s*USER 1000:1000\s*$/m)
  assert.match(docker, /^\s*EXPOSE 8080\s*$/m)
  assert.match(docker, /^\s*HEALTHCHECK /m)
  assert.match(docker, /DSH_LISTEN_PORT=8080/)
  assert.match(docker, /flybot-image\/entrypoint\.sh/)
  const engine = readFileSync(join(repo, 'openteamily', 'manager', 'engine.py'), 'utf8')
  assert.match(engine, /'target': 8080/)
  assert.match(engine, /'user': '1000:1000'/)
  assert.match(engine, /'read_only': True/)
  assert.match(engine, /'target': '\/data'/)
})

test('entrypoint is non-root and keeps the workspace on /data', () => {
  const entry = read('entrypoint.sh')
  const body = entry.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(body, /\b(gosu|groupmod|usermod|chown)\b/)
  assert.match(entry, /DSH_LISTEN_PORT:-8080/)
  assert.match(entry, /mkdir -p \/data\/workspace/)
  assert.match(entry, /TMPDIR=\/data\/tmp/)
  assert.match(entry, /launch\.mjs/)
  assert.match(entry, /cd \/data\/workspace/)
  const patch = read('docker.patch.yml')
  assert.match(patch, /workspace: \/data\/workspace/)
})

test('wrapper plugin boots upstream createRuntime and the social façade once', () => {
  const plugin = read('plugin/index.js')
  assert.match(plugin, /from '\.\.\/\.\.\/ds-bot-upstream\/ds-bot\/index\.js'/)
  assert.match(plugin, /from '\.\.\/\.\.\/flybot-social-host\/index\.js'/)
  assert.match(plugin, /createRuntime\(/)
  assert.match(plugin, /applyOnRuntime\(/)
  assert.match(plugin, /onboard: false/)
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /name !== 'ds-bot'/)
  assert.match(prepare, /symlinkSync\(dir, dest\)/)
  assert.match(prepare, /link:\$\{dir\}/)

  assert.match(prepare, /@openteamily\/flybot-runtime/)
  const manifest = JSON.parse(read('plugin/package.json'))
  assert.equal(manifest.name, '@openteamily/flybot-runtime')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('recipe does not edit the vendored upstream tree', () => {
  const docker = read('Dockerfile')
  assert.match(docker, /COPY ds-bot-upstream\/ds-bot /)
  assert.match(docker, /npm ci --omit=dev/)
  assert.match(docker, /COPY ds-bot-upstream\/LICENSE \/opt\/licenses\/ds-bot\/LICENSE/)
  assert.match(docker, /COPY ds-bot-upstream\/NOTICE \/opt\/licenses\/ds-bot\/NOTICE/)
  assert.match(docker, /COPY flybot\/LICENSE \/opt\/licenses\/flybot\/LICENSE/)
  assert.match(docker, /warm-native-bindings\.cjs/)
  assert.doesNotMatch(docker, /sk-[A-Za-z0-9]/)
  assert.doesNotMatch(docker, /api_key\s*=/)
})

test('image recipe does not bake a model API key', () => {
  const files = ['Dockerfile', 'entrypoint.sh', 'launch.mjs', 'docker.patch.yml', 'plugin/index.js']
  for (const rel of files) {
    const text = read(rel)
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/, rel)
    assert.doesNotMatch(text, /["']api_key["']\s*:\s*["'][^"']+["']/, rel)
  }
})
