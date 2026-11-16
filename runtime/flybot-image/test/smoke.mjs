// CI smoke for the OpenTeamily FlyBot runtime image. Requires Docker.
// Starts the image the way the compose manager does: user 1000, read-only
// rootfs, /data volume, tmpfs /tmp, no extra /workspace mount. Probes dsh web
// on 8080 and the Bot API. Does not claim a license-complete release.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2]
assert.ok(image, 'usage: node test/smoke.mjs <image>')
const name = `ot-flybot-smoke-${randomUUID()}`
const data = `${name}-data`
const containers = new Set()
const volumes = []

const docker = (args, { allowFailure = false } = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

try {
  // Do not pre-create the volume. docker run will create it and seed /data
  // (UID 1000 ownership) from the image, the same way Compose does on first create.
  volumes.push(data)

  const inspect = JSON.parse(docker(['image', 'inspect', image]).stdout)
  const cfg = inspect[0].Config
  assert.equal(String(cfg.User), '1000:1000', 'image user must be 1000:1000')
  assert.ok((cfg.ExposedPorts ?? {})['8080/tcp'], 'image must expose 8080')
  assert.ok(cfg.Healthcheck?.Test, 'image must declare a HEALTHCHECK')

  const server = `${name}-web`
  containers.add(server)
  docker([
    'run', '--detach', '--name', server, '--network', 'none',
    '--user', '1000:1000',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
    '--mount', `type=volume,src=${data},dst=/data`,
    '-e', 'DSH_TELEMETRY_DISABLED=1',
    '-e', 'DSH_LISTEN_PORT=8080',
    image,
  ])
  await setTimeout(1500)
  const running = docker(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}} {{.State.Error}}', server], { allowFailure: true })
  if (running.stdout.trim().split(/\s+/)[0] !== 'true') {
    const logs = docker(['logs', server], { allowFailure: true })
    throw new Error(`container exited before it became ready: ${running.stdout.trim()}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`)
  }

  const address = docker(['exec', server, 'sh', '-c', 'hostname -i 2>/dev/null || echo 127.0.0.1']).stdout.trim().split(/\s+/)[0]
  assert.ok(address, 'container must have a bind address')
  const probe = `
    const response = await fetch('http://${address}:8080/');
    if (![200, 401].includes(response.status)) throw new Error('Unexpected HTTP status: ' + response.status);
  `
  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline) {
    if (docker(['exec', server, 'node', '--input-type=module', '-e', probe], { allowFailure: true }).status === 0) {
      ready = true
      break
    }
    await setTimeout(500)
  }
  const logs = docker(['logs', server])
  const combined = `${logs.stdout}\n${logs.stderr}`
  assert.ok(ready, `web server must answer HTTP on 8080\n${combined}`)

  const processOwner = docker(['exec', server, 'stat', '-c', '%u:%g', '/proc/1']).stdout.trim()
  assert.equal(processOwner, '1000:1000', 'PID 1 must run as 1000:1000')

  const profileJson = docker(['exec', server, 'node', '--input-type=module', '-e',
    "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('/data/profiles/web/package.json','utf8'))",
  ]).stdout
  const manifest = JSON.parse(profileJson)
  assert.equal(manifest.dependencies['@openteamily/flybot-runtime']?.startsWith('link:'), true, 'wrapper must be linked from the image path')
  assert.ok(manifest.dsh?.profile?.bundles?.includes('@openteamily/flybot-runtime'), 'wrapper must be a profile bundle')
  assert.ok(!manifest.dsh?.profile?.bundles?.includes('ds-bot'), 'upstream ds-bot must not also be a bundle')

  const loginUrl = combined.match(/http:\/\/127\.0\.0\.1:8080\/\?token=[^\s]+/)?.[0]
    ?? combined.match(/http:\/\/[0-9.]+:8080\/\?token=[^\s]+/)?.[0]
  assert.ok(loginUrl, `web server must print a login URL on 8080\n${combined}`)
  const tokenUrl = loginUrl.replace(/http:\/\/127\.0\.0\.1:8080/, `http://${address}:8080`)
  docker(['exec', server, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const login = await fetch(process.argv[1], { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'login must return a cookie')
    const response = await fetch('http://${address}:8080/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
    })
    assert.ok(response.ok, 'the Bot API must answer: ' + response.status)
    const result = await response.json()
    assert.ok(result.ok, result.error?.message)
    assert.ok(Array.isArray(result.value.bots), 'the DS Bot runtime must load')
  `, tokenUrl])

  console.log('PASS: image user 1000, port 8080, read-only start, profile wrapper, Bot API')
} finally {
  for (const container of containers) docker(['rm', '--force', container], { allowFailure: true })
  for (const volume of volumes) docker(['volume', 'rm', volume], { allowFailure: true })
}
