// Memory feature (stream B3): memory pages, revisions/restore, export, 做梦,
// actions, links, graph, profile and preferences run inside this user's DS-Bot;
// data in /data/openteamily/features/memory.
// memory/pages serves chat recall (#378) in-process via host.call;
// memory/personal gives the owner's preferences and profile for DS-Bot turns.
import { defineFeature } from '../../featurekit/feature.js'
import { IMPORT_TABLES, MIGRATIONS } from './schema.js'
import { allPages, routes as pageRoutes, search } from './pages.js'
import { personal, routes as extraRoutes } from './extras.js'
import { actor } from './common.js'

export default defineFeature({
  name: 'memory',
  pages: ['memory'],
  migrations: MIGRATIONS,
  importTables: IMPORT_TABLES,
  routes: [...extraRoutes, ...pageRoutes],
  search,
  endpoints: ({ store, owner }) => ({
    async pages(payload) { return allPages(store, payload) },
    async personal() { return personal(store, actor({ store, owner })) },
  }),
})
