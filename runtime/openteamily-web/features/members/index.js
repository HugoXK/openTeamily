// Stream C: team members, roles and suspension (legacy members.py), shared via Bot Social.
import { sharedBotSocial, seg } from '../../lib/c/bot-social.js'

export default function members(host) {
  const bs = () => sharedBotSocial(host)
  const base = (p) => `/v1/ot/teams/${seg(p?.team_id, 'team_id')}/members`
  return {
    pages: ['members'],
    endpoints: {
      list: async (p) => bs().get(base(p)),
      setRole: async (p) => bs().patch(`${base(p)}/${seg(p?.handle, 'handle')}`, { role: p?.role }),
      suspend: async (p) => bs().patch(`${base(p)}/${seg(p?.handle, 'handle')}`, { suspended: p?.suspended !== false }),
      remove: async (p) => bs().del(`${base(p)}/${seg(p?.handle, 'handle')}`),
      leave: async (p) => {
        const me = await bs().get('/v1/ot/me')
        return bs().del(`${base(p)}/${seg(me.handle, 'handle')}`)
      },
    },
  }
}
