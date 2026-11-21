// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { compatHandler } from '../../lib/b4/compat.js'
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'
import { HEX32 } from '../../featurekit/http.js'

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

function notificationItem(notification, workspace) {
  const {id, seq, kind, data, created_at, read} = notification
  const header = {id,seq,kind,created:Math.floor(created_at / 1000),read}
  if (kind === 'meeting.shared') {
    const {share_id,title,organizer,workspace_id} = data ?? {}
    if (typeof share_id !== 'string' || !HEX32.test(share_id) || (workspace_id && workspace_id !== workspace)) return null
    const hash = new URLSearchParams({workspace,shared:share_id})
    return {...header,share_id,title,organizer,workspace_id:workspace,path:'/meetings#' + hash}
  }
  if (kind === 'discover.published') {
    const {slug,title,creator,listing_kind = data?.kind} = data ?? {}
    const prefix = listing_kind === 'work' ? '/w/' : listing_kind === 'agent' ? '/a/' : ''
    const path = prefix && typeof slug === 'string' && SLUG.test(slug) ? prefix + slug : undefined
    return {...header,listing_kind,slug,title,actor_username:creator?.display_name || creator?.handle,path}
  }
  return {...data,...header}
}

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  return {
    pages: ['contacts'],
    endpoints: {
      v1: compatHandler([
        { method: 'GET', path: /^\/v1\/contacts$/,
          handle: () => wrap(async () => {
            const [data, binding] = await Promise.all([bs().get('/v1/ot/contacts'), host.call('agents/personal-binding', {})])
            return [200, {...data, workspace_id: binding?.workspace_id ?? null}]
          }) },
        { method: 'GET', path: /^\/v1\/contacts\/lookup$/,
          handle: ({query}) => wrap(async () => {
            const values = new URLSearchParams(query).getAll('handle')
            return [200, await bs().get('/v1/ot/contacts/lookup' + qs({handle: values.length === 1 ? values[0] : ''}))]
          }) },
        { method: 'POST', path: /^\/v1\/contacts$/,
          handle: ({body}) => wrap(async () => [200, await bs().post('/v1/ot/contacts', {handle: body?.handle})]) },
        { method: 'POST', path: /^\/v1\/contacts\/(otcpt_[a-zA-Z0-9_-]{1,80})$/,
          handle: ({match, body}) => wrap(async () => [200, await bs().post('/v1/ot/contacts/' + match[1], {action: body?.action})]) },
        { method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications$/,
          handle: ({ match, query }) => wrap(async () => {
            const binding = await host.call?.('agents/personal-binding', {})
            const personal = binding?.workspace_id === match[1]
            const scope = personal ? {personal:'1'} : {workspace_id:match[1]}
            const unread = new URLSearchParams(query).get('filter') === 'unread' ? '1' : undefined
            const data = await bs().get('/v1/ot/notifications' + qs({limit:200,latest:'1',...scope,unread}))
            const items = data.notifications.map(n => notificationItem(n, match[1])).filter(Boolean)
            return [200, {items, unread_count:data.unread, limit:200}]
          }) },
        { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications\/read$/,
          handle: ({ match, body }) => wrap(async () => {
            const binding = await host.call?.('agents/personal-binding', {})
            const personal = binding?.workspace_id === match[1]
            const scope = personal ? {personal:true} : {workspace_id:match[1]}
            const result = await bs().post('/v1/ot/notifications/read', { notification_id: body?.notification_id, all: body?.all, ...scope })
            return [200, { unread_count: result.unread }]
          }) },
      ]),
      status: async () => bs().status(),
      identity: async () => bs().identity(),
      profile: async () => bs().get('/v1/ot/me'),
      updateProfile: async (p) => bs().put('/v1/ot/profile', { display_name: p?.display_name, bio: p?.bio }),
      notifications: async (p) => bs().get('/v1/ot/notifications' + qs({ after: p?.after, limit: p?.limit })),
      readNotifications: async (p) => bs().post('/v1/ot/notifications/read', { up_to: p?.up_to }),
    },
  }
}
