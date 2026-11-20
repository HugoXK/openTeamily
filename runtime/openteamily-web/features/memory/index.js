// Memory feature (stream B3): memory pages, revisions/restore, export and 做梦
// run inside this user's DS-Bot; data in /data/openteamily/features/memory.
// memory/pages serves chat recall (#378) in-process via host.call.
import { defineFeature } from '../../featurekit/feature.js'
import { IMPORT_TABLES, MIGRATIONS } from './schema.js'
import { allPages, routes, search } from './pages.js'

export default defineFeature({
  name: 'memory',
  pages: ['memory'],
  migrations: MIGRATIONS,
  importTables: IMPORT_TABLES,
  routes,
  search,
  endpoints: ({ store }) => ({
    async pages(payload) { return allPages(store, payload) },
  }),
})
