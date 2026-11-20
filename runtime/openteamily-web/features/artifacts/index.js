// Artifacts feature (stream B3): the works library runs inside this user's
// DS-Bot. artifacts/create is the in-process entry B2 team runs call to store
// a finished step's output. Legacy /v1 studio routes, media, boards, slides,
// dashboards, history, export and authenticated share records are served here;
// public /share/<token> pages are rendered by Bot Social (snapshot published here).
import { defineFeature } from '../../featurekit/feature.js'
import { HEX32, refuse } from '../../featurekit/http.js'
import { createArtifact, listFiles, PER_WORKSPACE, search } from './library.js'
import { IMPORT_TABLES, MIGRATIONS } from './schema.js'
import { routes } from './routes.js'
import { importMedia } from './media.js'

export { PER_WORKSPACE }

export default defineFeature({
  name: 'artifacts',
  pages: ['artifacts'],
  migrations: MIGRATIONS,
  importTables: IMPORT_TABLES,
  afterImport: importMedia,
  routes,
  search,
  endpoints: (context) => {
    const ctx = { ...context, featureDir: context.host.featureDir() }
    return {
    async create(payload) {
      const input = payload ?? {}
      const result = createArtifact(ctx, input.workspace_id, input, input.idempotency_key)
      return { artifact: result.body.artifact }
    },
    async files(payload) {
      const workspaceId = payload?.workspace_id
      if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
      const text = String(payload?.q ?? '')
      const cursor = String(payload?.cursor ?? '')
      const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 51)
      if (text.length > 80 || (cursor && !HEX32.test(cursor))) refuse(400, 'invalid', 'Invalid resource search parameters')
      return { items: listFiles(ctx.store, workspaceId, text, cursor, limit) }
    },
  } },
})
