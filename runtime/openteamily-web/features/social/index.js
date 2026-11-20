// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  return {
    endpoints: {
      status: async () => bs().status(),
      identity: async () => bs().identity(),
      profile: async () => bs().get('/v1/ot/me'),
      updateProfile: async (p) => bs().put('/v1/ot/profile', { display_name: p?.display_name, bio: p?.bio }),
      notifications: async (p) => bs().get('/v1/ot/notifications' + qs({ after: p?.after, limit: p?.limit })),
      readNotifications: async (p) => bs().post('/v1/ot/notifications/read', { up_to: p?.up_to }),
    },
  }
}
