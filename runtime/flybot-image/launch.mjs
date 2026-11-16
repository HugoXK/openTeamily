// Last step of the image entrypoint: load the operator model API secret into
// the process environment, then exec dsh. The key is never written to stdout.
import { spawn } from 'node:child_process'
import { applyModelApi, loadModelApi, ModelApiError, redact } from './model-api.js'

try {
  const config = loadModelApi(process.env)
  if (config) applyModelApi(config, process.env, { info: (msg) => console.error(msg) })
  else console.error('model API: no secret file; start without a provider key (operator must supply one)')
} catch (error) {
  const message = error instanceof ModelApiError ? error.message : 'model API could not be loaded'
  console.error(`entrypoint: ${message}`)
  if (!(error instanceof ModelApiError) && error?.message) {
    console.error(redact(String(error.message)))
  }
  process.exit(1)
}

const child = spawn('dsh', process.argv.slice(2), { stdio: 'inherit', env: process.env })
const forward = (signal) => {
  try { child.kill(signal) } catch { /* child already gone */ }
}
process.on('SIGTERM', () => forward('SIGTERM'))
process.on('SIGINT', () => forward('SIGINT'))
child.on('error', (error) => {
  console.error('entrypoint: failed to start dsh:', error.message)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
