// Stream C: invite links and join requests (legacy invites.py), shared via Bot Social.
// The invite code is shown once to the creator and travels only inside the link they share.
import { sharedBotSocial, seg, qs } from '../../lib/c/bot-social.js'

export default function invites(host) {
  const bs = () => sharedBotSocial(host)
  const team = (p) => `/v1/ot/teams/${seg(p?.team_id, 'team_id')}`
  return {
    endpoints: {
      create: async (p) => bs().post(`${team(p)}/invites`, { role: p?.role, ttl_days: p?.ttl_days, max_uses: p?.max_uses, requires_approval: p?.requires_approval === true }),
      list: async (p) => bs().get(`${team(p)}/invites`),
      freeze: async (p) => bs().patch(`${team(p)}/invites/${seg(p?.invite_id, 'invite_id')}`, { frozen: p?.frozen !== false }),
      revoke: async (p) => bs().patch(`${team(p)}/invites/${seg(p?.invite_id, 'invite_id')}`, { revoked: true }),
      preview: async (p) => bs().post('/v1/ot/invites/preview', { code: p?.code }),
      accept: async (p) => bs().post('/v1/ot/invites/accept', { code: p?.code }),
      requests: async (p) => bs().get(`${team(p)}/join-requests` + qs({ status: p?.status })),
      decide: async (p) => bs().post(`${team(p)}/join-requests/${seg(p?.request_id, 'request_id')}`, { decision: p?.decision }),
      mine: async () => bs().get('/v1/ot/join-requests/mine'),
    },
  }
}
