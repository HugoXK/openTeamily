// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { compatHandler } from '../../lib/b4/compat.js'
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'

// #284: a notification switch is only real if this read path honours it. The
// preferences are stored by the settings feature (settings.js notificationPrefs),
// so the inbox asks that feature instead of keeping a second copy. Each row's
// Bot Social kind maps to the category the settings page calls by name; a kind
// outside the three (team membership, calls, adds) is never hidden.
const NOTIFY_CATEGORY = {
  'messenger.mention': 'mentions',
  mention: 'mentions',
  agent_reply: 'task_completion',
  artifact: 'artifacts',
  'discover.published': 'artifacts',
  follow_work: 'artifacts',
}

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  // A runtime without the settings feature has no switches to read, so it shows
  // every row rather than silently hiding one.
  async function notificationPrefs() {
    try { return (await host.call('settings/notificationPrefs', {}))?.prefs ?? {} }
    catch { return {} }
  }
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
          async handle({ match, query }) {
            const binding = await host.call?.('agents/personal-binding', {})
            const personal = binding?.workspace_id === match[1]
            if (!personal) await bs().get('/v1/ot/teams/by-workspace/' + match[1])
            const scope = personal ? {personal:'1'} : {workspace_id:match[1]}
            const data = await bs().get('/v1/ot/notifications' + qs({ limit: 200, ...scope, unread: new URLSearchParams(query).get('filter') === 'unread' ? '1' : undefined }))
            const prefs = await notificationPrefs()
            const items = data.notifications.map(n => ({ ...n.data, id: n.id, seq: n.seq, kind: n.kind, created: Math.floor(n.created_at / 1000), read: n.read }))
            const shown = items.filter(item => prefs[NOTIFY_CATEGORY[item.kind]] !== false)
            // A hidden row must not keep the badge up: once anything is filtered
            // the count is the unread rows this page actually shows. Bot Social
            // caps one page at 200 rows, so this is exact for the common case and
            // never higher than what the listing shows.
            const unreadCount = shown.length === items.length ? data.unread : shown.filter(item => !item.read).length
            return [200, { items: shown, unread_count: unreadCount, limit: 200 }]
          } },
        { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications\/read$/,
          async handle({ match, body }) {
            const binding = await host.call?.('agents/personal-binding', {})
            const personal = binding?.workspace_id === match[1]
            if (!personal) await bs().get('/v1/ot/teams/by-workspace/' + match[1])
            const scope = personal ? {personal:true} : {workspace_id:match[1]}
            const result = await bs().post('/v1/ot/notifications/read', { notification_id: body?.notification_id, all: body?.all, ...scope })
            return [200, { unread_count: result.unread }]
          } },
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
