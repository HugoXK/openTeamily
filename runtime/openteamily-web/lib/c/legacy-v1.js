// Legacy /v1 compatibility for Stream C pages (members, team, messenger, discover).
// When the core stream flips those pages onto the user's own DS-Bot, dsbot-api.mjs
// posts {endpoint:'<feature>/v1', payload:{method,path,body}} here. The handlers
// talk to Bot Social and return the Flask JSON shapes those pages already expect.
// GET/POST /v1/workspaces and POST /v1/teams are served here too: every workspace
// is a Bot Social team with a 32-hex workspace_id; the platform keeps only auth.
import { compatHandler } from '../b4/compat.js'
import { Fault } from '../b4/http.js'
import { ownerId } from '../../featurekit/v1.js'
import { sharedBotSocial, seg, qs } from './bot-social.js'

const HEX = /^[0-9a-f]{32}$/
const WORK_LABELS = {
  document: '文档', website: '网页', whiteboard: '白板', media: '媒体',
  image: '图片', audio: '音频', video: '视频', slides: '幻灯片', dashboard: '看板',
}

const unix = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

const usernameOf = (profile) => {
  const handle = String(profile?.handle || '').replace(/^@/, '')
  if (!handle) return profile?.display_name || ''
  return handle.endsWith('.home') ? handle.slice(0, -5) : handle
}

function userIdOf(profile, me, env) {
  if (profile?.platform_user_id && HEX.test(String(profile.platform_user_id))) return profile.platform_user_id
  const mine = me && (profile?.handle === me.handle || profile?.owner_id === me.owner_id || profile?.owner_id === me.ownerId)
  if (mine) {
    const id = ownerId(env)
    if (HEX.test(id)) return id
  }
  return profile?.owner_id || profile?.handle || ''
}

function memberItem(row, me, env) {
  return {
    user_id: userIdOf(row, me, env),
    username: usernameOf(row) || row.display_name || '',
    handle: row.handle || null,
    role: row.role,
    created: unix(row.joined_at || row.created_at),
    suspended: !!row.suspended,
  }
}

function inviteItem(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: workspaceId || row.workspace_id || row.team_id,
    role: row.role,
    created: unix(row.created_at),
    expires: unix(row.expires_at),
    created_by: row.created_by || null,
    max_uses: row.max_uses,
    use_count: row.use_count,
    revoked: !!row.revoked,
    frozen: !!row.frozen,
    requires_approval: !!row.requires_approval,
  }
}

function requestItem(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: workspaceId || row.workspace_id || row.team_id,
    user_id: row.member?.owner_id || row.member?.platform_user_id || row.owner_id,
    username: usernameOf(row.member || row),
    role: row.role,
    status: row.status,
    created: unix(row.created_at),
    decided: unix(row.decided_at) || null,
    decided_by: row.decided_by || null,
  }
}

function conversationItem(row, me, env, workspaceId) {
  const members = (row.members || []).map((m) => ({
    ...memberItem({ ...m, role: m.role || 'member' }, me, env),
  }))
  return {
    id: row.id,
    workspace_id: workspaceId,
    kind: row.kind,
    title: row.title || '',
    created: unix(row.created_at),
    updated: unix(row.updated_at),
    preview: row.last_message && !row.last_message.retracted ? (row.last_message.body || '') : '',
    unread_count: row.unread ?? 0,
    muted: !!row.muted,
    pinned: !!row.pinned,
    first_unread_seq: row.unread > 0 ? (row.read_seq || 0) + 1 : null,
    members,
    agent_members: (row.agents || []).map((a) => ({ id: a.agent_ref, name: a.name, auto_reply: !!a.auto_reply })),
  }
}

function messageItem(row, me, env, workspaceId) {
  const author = row.author || { handle: null, owner_id: row.author_id, display_name: row.agent_name }
  const agent = row.author_kind === 'agent' || author.kind === 'agent'
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    workspace_id: workspaceId,
    user_id: agent ? null : userIdOf(author, me, env),
    body: row.retracted ? '' : (row.body || ''),
    created: unix(row.created_at),
    revision: row.revision || 1,
    edited: unix(row.edited_at) || null,
    retracted: !!row.retracted,
    ...(agent ? { role: 'agent', agent_id: row.agent_ref || author.agent_ref, agent_name: row.agent_name || author.name, source: 'runtime_infer' } : {}),
  }
}

function workItem(row) {
  const kind = row.work_kind || (row.kind === 'work' ? 'document' : row.kind)
  return {
    slug: row.slug,
    title: row.title,
    kind,
    kind_label: WORK_LABELS[kind] || kind,
    author: usernameOf(row.creator) || row.creator?.display_name || '',
    updated: unix(row.updated_at),
    path: row.path || ('/w/' + row.slug),
    likes: row.likes ?? 0,
    collections: row.collections ?? 0,
    liked: !!row.liked,
    collected: !!row.collected,
    following: !!row.following,
    own_work: !!row.own,
  }
}

function agentItem(row) {
  return {
    slug: row.slug,
    name: row.title || row.name,
    summary: row.summary || '',
    category: row.category || '',
    updated: unix(row.updated_at),
    tags: [],
    members: [],
  }
}

function rethrow(error) {
  if (error instanceof Fault) throw error
  const raw = String(error?.code ?? '')
  const code = raw.replace(/^social\//, '')
  const status = Number(error?.status) || (
    code === 'not-configured' || code === 'not-connected' || raw === 'social/not-configured' || raw === 'social/not-connected' ? 503
      : code === 'unreachable' ? 503 : 500
  )
  const mapped = ({
    team_not_found: 'not_found',
    member_not_found: 'not_found',
    invite_not_found: 'not_found',
    invite_unusable: 'not_found',
    invalid_request: 'invalid',
    slug_taken: 'conflict',
    forbidden: 'forbidden',
    not_reachable: 'invalid',
    not_in_team: 'invalid',
    too_many_teams: 'quota',
  })[code] || (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 410 ? 'not_found' : status === 429 ? 'quota' : code || 'internal')
  throw new Fault(status === 410 ? 404 : status, mapped, error?.message || 'Bot Social request failed')
}

async function wrap(fn) {
  try { return await fn() } catch (error) { rethrow(error) }
}

async function meOf(bs, env) {
  return bs.get('/v1/ot/me')
}

async function teamFor(bs, workspaceId, name, env) {
  if (!HEX.test(String(workspaceId || ''))) throw new Fault(400, 'invalid', 'Invalid workspace')
  // Workspace ownership is platform authority, never first-browser-call wins.
  // A verified migration must pre-link the team and preserve its full membership.
  try { return await bs.get(`/v1/ot/teams/by-workspace/${seg(workspaceId, 'workspace_id')}`) }
  catch (error) {
    if (error?.status === 404) throw new Fault(409, 'membership_migration_required', 'This workspace needs verified Bot Social membership migration; legacy data is unchanged')
    throw error
  }
}

function ttlDays(expiresIn) {
  const seconds = Number(expiresIn)
  if (!Number.isFinite(seconds) || seconds <= 0) return 7
  return Math.min(30, Math.max(1, Math.round(seconds / 86400) || 7))
}

function parseQuery(query) {
  return new URLSearchParams(String(query || '').replace(/^\?/, ''))
}

function client(host) {
  return sharedBotSocial(host)
}

function membersRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/members`)
          return [200, { items: (data.members || []).map((m) => memberItem(m, me, env)) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/members`, {
            handle: body?.username || body?.handle, role: body?.role,
          })
          // Bot Social returns the member; treat first-time add as 201 when we cannot tell.
          return [201, { member: memberItem(data, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members\/([A-Za-z0-9._-]{1,80})$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.patch(`/v1/ot/teams/${seg(team.id, 'team_id')}/members/${seg(match[2], 'handle')}`, { role: body?.role })
          return [200, { member: memberItem(data, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members\/([A-Za-z0-9._-]{1,80})\/(remove|suspend|unsuspend)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const action = match[3]
          const path = `/v1/ot/teams/${seg(team.id, 'team_id')}/members/${seg(match[2], 'handle')}`
          if (action === 'remove') {
            await bs.del(path)
            return [200, {}]
          }
          const data = await bs.patch(path, { suspended: action === 'suspend' })
          return [200, { member: memberItem(data, me, env) }]
        })
      },
    },
  ]
}

function invitesRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites`)
          return [200, { items: (data.invites || []).map((row) => inviteItem(row, match[1])) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites`, {
            role: body?.role, ttl_days: ttlDays(body?.expires_in), max_uses: body?.max_uses,
            requires_approval: body?.requires_approval === true,
          })
          return [201, { invite: inviteItem(data.invite || data, match[1]), token: data.code }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites\/([A-Za-z0-9._-]{1,80})\/(revoke|freeze|unfreeze)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const action = match[3]
          const patch = action === 'revoke' ? { revoked: true } : { frozen: action === 'freeze' }
          const data = await bs.patch(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites/${seg(match[2], 'invite_id')}`, patch)
          return [200, { invite: inviteItem(data.invite || data, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/invites\/accept$/,
      async handle({ body }) {
        return wrap(async () => {
          const bs = client(host)
          const data = await bs.post('/v1/ot/invites/accept', { code: body?.token || body?.code })
          if (data.status === 'pending') {
            return [202, { join_request: { id: data.request_id, status: 'pending', team_id: data.team_id } }]
          }
          if (data.status === 'suspended') throw new Fault(403, 'forbidden', 'Your membership in this workspace is suspended')
          return [200, { workspace: { id: data.workspace_id || data.team_id }, member: { role: 'member' } }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/join-requests$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/join-requests` + qs({ status: 'pending' }))
          return [200, { items: (data.requests || []).map((row) => requestItem(row, match[1])) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/join-requests\/([A-Za-z0-9._-]{1,80})\/(approve|reject)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/join-requests/${seg(match[2], 'request_id')}`, {
            decision: match[3],
          })
          return [200, { join_request: requestItem(data.request || data, match[1]) }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/join-requests$/,
      async handle() {
        return wrap(async () => {
          const bs = client(host)
          const data = await bs.get('/v1/ot/join-requests/mine')
          return [200, { items: (data.requests || []).map((row) => requestItem(row)) }]
        })
      },
    },
  ]
}

function workspaceItem(team, me, env) {
  return {
    id: team.workspace_id,
    owner_id: userIdOf(team.owner || {}, me, env),
    name: team.name,
    created: unix(team.created_at),
    kind: team.slug ? 'team' : 'workspace',
    slug: team.slug || null,
    team_name: team.slug ? team.name : null,
    converted: false,
    role: team.role || null,
    member_count: team.member_count ?? 1,
  }
}

const IDEM = /^[A-Za-z0-9_-]{16,64}$/

function teamsRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces$/,
      async handle({ query }) {
        return wrap(async () => {
          const bs = client(host)
          const q = parseQuery(query)
          const limit = Math.min(Math.max(Number(q.get('limit') || 20) || 20, 1), 100)
          const cursor = q.get('cursor') || ''
          const [me, data] = await Promise.all([meOf(bs, env), bs.get('/v1/ot/workspaces')])
          let rows = (data.workspaces || []).filter((t) => HEX.test(String(t.workspace_id || '')))
          if (cursor) {
            const at = rows.findIndex((t) => t.workspace_id === cursor)
            rows = at >= 0 ? rows.slice(at + 1) : []
          }
          const page = rows.slice(0, limit)
          return [200, { items: page.map((t) => workspaceItem(t, me, env)), cursor: rows.length > limit ? page[page.length - 1].workspace_id : null }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces$/,
      async handle({ body, idempotency_key: key }) {
        return wrap(async () => {
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          if (!name || name.length > 80) throw new Fault(400, 'invalid', 'Workspace name must be 1–80 characters without controls')
          if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
          const bs = client(host)
          const [me, team] = await Promise.all([meOf(bs, env), bs.post('/v1/ot/workspaces', { name, idempotency_key: key })])
          return [201, { workspace: workspaceItem(team, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/teams$/,
      async handle({ body, idempotency_key: key }) {
        return wrap(async () => {
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          const slug = body?.slug
          if (!name || !['new', 'convert'].includes(body?.mode)) throw new Fault(400, 'invalid', 'Provide a team name, a valid Team ID, and new or convert')
          if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
          const bs = client(host)
          const me = await meOf(bs, env)
          const team = body.mode === 'new'
            ? await bs.post('/v1/ot/workspaces', { name, slug, idempotency_key: key })
            : await bs.post(`/v1/ot/workspaces/${seg(body?.workspace_id, 'workspace_id')}/convert`, { name, slug })
          return [body.mode === 'new' ? 201 : 200, { workspace: { ...workspaceItem(team, me, env), converted: body.mode === 'convert' } }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/team-directory$/,
      async handle({ query }) {
        return wrap(async () => {
          const bs = client(host)
          const q = parseQuery(query)
          const data = await bs.get('/v1/ot/directory' + qs({ q: q.get('q'), limit: q.get('limit') }))
          return [200, {
            items: (data.teams || []).map((t) => ({
              name: t.name,
              summary: t.summary || '',
              member_count: t.member_count ?? 0,
              workspace_id: t.workspace_id || t.id,
              membership: t.membership || null,
            })),
          }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/team-directory\/([A-Za-z0-9._-]{1,80})\/join$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const id = match[1]
          const teamId = HEX.test(id)
            ? (await bs.get(`/v1/ot/teams/by-workspace/${seg(id, 'workspace_id')}`)).id
            : id
          const data = await bs.post(`/v1/ot/directory/${seg(teamId, 'team_id')}/join`)
          if (data.status === 'pending') return [202, { join_request: { id: data.request_id, status: 'pending' } }]
          return [200, { status: data.status || 'member' }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/directory$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          return [200, { listing: { listed: !!team.listed, summary: team.summary || '' } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/directory$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.put(`/v1/ot/teams/${seg(team.id, 'team_id')}/listing`, {
            listed: body?.listed === true, summary: body?.summary,
          })
          return [200, { listing: { listed: !!data.listed, summary: data.summary || '' } }]
        })
      },
    },
  ]
}

function messengerRoutes(host) {
  const env = process.env
  const convPath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations$/
  const onePath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})$/
  return [
    {
      method: 'GET', path: convPath,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.get('/v1/ot/conversations')
          const items = (data.conversations || []).map((c) => conversationItem(c, me, env, match[1]))
          return [200, { items, cursor: null }]
        })
      },
    },
    {
      method: 'POST', path: convPath,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const kind = body?.kind
          const ids = Array.isArray(body?.member_ids) ? body.member_ids : []
          let data
          if (kind === 'dm') {
            data = await bs.post('/v1/ot/conversations', { kind: 'dm', peer: ids[0] })
          } else {
            data = await bs.post('/v1/ot/conversations', {
              kind: 'group', title: body?.title, team_id: team.id, members: ids,
            })
          }
          const conversation = conversationItem(data, me, env, match[1])
          return [data.id && conversation.id ? 201 : 200, { conversation }]
        })
      },
    },
    {
      method: 'GET', path: onePath,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const conv = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}`)
          const page = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages` + qs({ limit: 100 }))
          return [200, {
            conversation: conversationItem(conv, me, env, match[1]),
            items: (page.messages || []).map((m) => messageItem({ ...m, conversation_id: conv.id }, me, env, match[1])),
            agent_replies: [],
            pinned_messages: [],
            cursor: null,
          }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages$/,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const q = parseQuery(query)
          const page = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages` + qs({ limit: q.get('limit') }))
          return [200, { items: (page.messages || []).map((m) => messageItem({ ...m, conversation_id: match[2] }, me, env, match[1])), cursor: null }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages$/,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.post(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages`, { body: body?.body, client_key: idempotency_key, mentions: body?.mentions, reply_to: body?.reply_to })
          return [201, { message: messageItem({ ...data, conversation_id: match[2] }, me, env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/read$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/read`, body?.seq === undefined ? {} : { seq: body.seq })
          return [200, { unread_count: data.unread ?? 0 }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/preferences$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.patch(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}`, { pinned: body?.pinned, muted: body?.muted })
          return [200, { pinned: !!data.pinned, muted: !!data.muted }]
        })
      },
    },
  ]
}

function discoverRoutes(host) {
  const env = process.env
  const feed = (kind) => async ({ query }) => wrap(async () => {
    const bs = client(host)
    const q = parseQuery(query)
    const data = await bs.get('/v1/ot/discover' + qs({
      kind, tab: q.get('tab'), q: q.get('q'), work_kind: q.get('kind'), creator: q.get('creator'),
      before: q.get('cursor'), limit: q.get('limit'),
    }))
    const items = (data.items || []).map((row) => (kind === 'agent' ? agentItem(row) : workItem(row)))
    return [200, { items, cursor: data.next_before ?? null }]
  })
  return [
    { method: 'GET', path: /^\/v1\/discover\/agents$/, handle: feed('agent') },
    { method: 'GET', path: /^\/v1\/discover\/works$/, handle: feed('work') },
    { method: 'GET', path: /^\/v1\/discover\/me\/works$/, handle: feed('work') },
    {
      method: 'POST', path: /^\/v1\/discover\/works\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/engagement$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const listing = await bs.get(`/v1/ot/discover/${seg(match[1], 'slug')}`)
          const action = body?.action
          const on = body?.enabled !== false
          if (action === 'like') await bs.post(`/v1/ot/listings/${seg(listing.id, 'listing_id')}/like`, { on })
          else if (action === 'collect') await bs.post(`/v1/ot/listings/${seg(listing.id, 'listing_id')}/collect`, { on })
          else if (action === 'follow') await bs.post('/v1/ot/follows', { handle: listing.creator?.handle, on })
          else throw new Fault(400, 'invalid', 'Provide like/collect/follow and a boolean enabled')
          const fresh = await bs.get(`/v1/ot/discover/${seg(match[1], 'slug')}`)
          return [200, { likes: fresh.likes ?? 0, collections: fresh.collections ?? 0, liked: !!fresh.liked, collected: !!fresh.collected, following: !!fresh.following }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const mine = await bs.get('/v1/ot/listings/mine')
          const row = (mine.listings || []).find((l) => l.kind === 'agent' && l.ref === match[2] && l.listed)
          return [200, { discover: row ? { listed: true, slug: row.slug, updated: unix(row.updated_at) } : { listed: false } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const slug = body?.slug
          const data = await bs.put('/v1/ot/listings', {
            kind: 'agent', ref: match[2], slug, title: body?.title || slug, summary: body?.summary || '',
          })
          return [data.id ? 200 : 200, { discover: { listed: true, slug: data.slug, updated: unix(data.updated_at) } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover\/revoke$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const mine = await bs.get('/v1/ot/listings/mine')
          const row = (mine.listings || []).find((l) => l.kind === 'agent' && l.ref === match[2])
          if (row) await bs.del(`/v1/ot/listings/${seg(row.id, 'listing_id')}`)
          return [200, { discover: { listed: false } }]
        })
      },
    },
  ]
}

export function membersV1(host) { return compatHandler(membersRoutes(host)) }
export function invitesV1(host) { return compatHandler(invitesRoutes(host)) }
export function teamsV1(host) { return compatHandler(teamsRoutes(host)) }
export function messengerV1(host) { return compatHandler(messengerRoutes(host)) }
export function discoverV1(host) { return compatHandler(discoverRoutes(host)) }
