// DSH plugin entry: OpenTeamily inside the user's own DS-Bot (phase A shell).
// Registers two exact, DSH-authenticated Fetch routes on the shared /api channel:
//   GET  /api/openteamily/page?path=/chat/   the OpenTeamily pages bundled in the image
//   POST /api/openteamily                    {endpoint, payload} dispatch (same shape as /api/bot)
// DSH applies its Host/Origin fence and browser-session authentication before
// either handler runs; this plugin adds no authentication bypass of its own.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPageHandler, PAGE_PATH } from './src/pages.js'
import { createDispatch, API_PATH } from './src/dispatch.js'
import { loadIdentity } from './src/identity.js'

export const name = 'openteamily-web'
export const inject = ['connection']

const HERE = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, config = {}) {
  if (!ctx?.connection?.fetch?.register || !ctx?.effect) {
    throw new Error('openteamily-web: dsh connection fetch registry is required')
  }
  const identity = loadIdentity({
    env: process.env,
    dataDir: config.dataDir ?? process.env.DSH_HOME ?? '/data',
  })
  const pagesDir = config.pagesDir ?? join(HERE, 'pages')
  const page = createPageHandler({ pagesDir, identity })
  const dispatch = createDispatch({ identity })
  ctx.effect(() => ctx.connection.fetch.register({
    path: PAGE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: page,
  }), 'openteamily-web: page route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: dispatch,
  }), 'openteamily-web: api route')
  return { identity }
}
