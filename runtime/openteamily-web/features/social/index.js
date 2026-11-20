// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { compatHandler } from '../../lib/b4/compat.js'
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  return {
    endpoints: {
      v1: compatHandler([
        { method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications$/,
          async handle({ match, query }) {
            await bs().get('/v1/ot/teams/by-workspace/' + match[1])
            const data = await bs().get('/v1/ot/notifications' + qs({ limit: 200, workspace_id: match[1], unread: new URLSearchParams(query).get('filter') === 'unread' ? '1' : undefined }))
            return [200, { items: data.notifications.map(n => ({ ...n.data, id: n.id, seq: n.seq, kind: n.kind, created: Math.floor(n.created_at / 1000), read: n.read })), unread_count: data.unread, limit: 200 }]
          } },
        { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications\/read$/,
          async handle({ match, body }) {
            await bs().get('/v1/ot/teams/by-workspace/' + match[1])
            const result = await bs().post('/v1/ot/notifications/read', { notification_id: body?.notification_id, all: body?.all, workspace_id: match[1] })
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
