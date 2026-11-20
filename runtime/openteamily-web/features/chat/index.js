// Private chat with the personal agent, executed as native DS-Bot turns in the
// user's own DS-Bot (moved from conversations.py / personal.py / agent_memory.py).
// Private chat now delegates to the same mapped native Bot as its workspace agent.
// Former plugin:<id> Main-Bot parts and local rows are retained and adopted once.
import { openDatabase, newId, fail } from '../../src/store.js'
import { rank, noteBlock } from './recall.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created, id);
CREATE TABLE IF NOT EXISTS chat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`
const ms = (value) => { const n = Number(value) || 0; return n > 0 && n < 1e12 ? Math.round(n * 1000) : Math.round(n) }
const clip = (value, max) => String(value ?? '').slice(0, max)
const ID = /^[0-9a-f]{32}$/
const now = () => Date.now()

export function composePrompt({ text, profile, notes }) {
  const parts = []
  if (profile?.instructions) parts.push(`(Owner's standing instructions for ${profile.name}: ${profile.instructions})`)
  if (notes) parts.push(notes)
  parts.push(text)
  return parts.join('\n\n')
}

export default function chat(host) {
  let db
  const database = async () => {
    if (!db) { db = await openDatabase(host, 'chat.sqlite3'); db.exec(SCHEMA) }
    return db
  }
  const conversation = async (id) => {
    if (typeof id !== 'string' || !ID.test(id)) fail('chat/invalid', 'conversation_id required')
    const row = (await database()).prepare('SELECT * FROM conversations WHERE id=?').get(id)
    if (!row) fail('chat/not-found', 'Conversation not found')
    return row
  }

  async function recall(text, profile) {
    if (profile?.recall === 'off') return { notes: '', refs: [] }
    let pages = []
    try { pages = await host.call('memory/pages', {}) } catch (error) { if (error?.code !== 'openteamily/not-found') throw error }
    const hits = rank(text, Array.isArray(pages) ? pages : [])
    return { notes: noteBlock(hits, text), refs: hits.map(({ page, score }) => ({ id: page.id, revision: page.revision ?? 1, title: page.title ?? '', score: Number(score.toFixed(3)) })) }
  }

  const feature = {
    pages: ['chat'],
    endpoints: {
      async exportLegacy() {
        const d = await database()
        return {conversations:d.prepare('SELECT * FROM conversations ORDER BY created,id').all().map(c=>({...c,messages:d.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created,id').all(c.id).map(m=>({...m,meta:JSON.parse(m.meta)}))}))}
      },
      async conversations() {
        return { items: (await database()).prepare('SELECT * FROM conversations ORDER BY updated DESC, id LIMIT 200').all() }
      },
      async create(payload) {
        const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : 'New chat'
        const row = { id: newId(), title, created: now(), updated: now() }
        ;(await database()).prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(row.id, row.title, row.created, row.updated)
        return row
      },
      async rename(payload) {
        await conversation(payload?.conversation_id)
        const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 120) : ''
        if (!title) fail('chat/invalid', 'title required')
        ;(await database()).prepare('UPDATE conversations SET title=?, updated=? WHERE id=?').run(title, now(), payload.conversation_id)
        return conversation(payload.conversation_id)
      },
      async remove(payload) {
        await conversation(payload?.conversation_id)
        ;(await database()).prepare('DELETE FROM conversations WHERE id=?').run(payload.conversation_id)
        return { removed: true }
      },
      async messages(payload) {
        await conversation(payload?.conversation_id)
        const rows = (await database()).prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created, id').all(payload.conversation_id)
        return { items: rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) })) }
      },
      // One-time copy of this user's own platform chat history (the browser reads it
      // with the user's session and hands it to their own DS-Bot). Idempotent: legacy
      // ids are kept, so re-sending the same rows changes nothing.
      async importStatus() {
        const row = (await database()).prepare("SELECT value FROM chat_state WHERE key='legacy_import'").get()
        return row ? JSON.parse(row.value) : { done: false }
      },
      async import(payload) {
        const d = await database()
        const list = Array.isArray(payload?.conversations) ? payload.conversations : []
        if (list.length > 100) fail('chat/invalid', 'at most 100 conversations per call')
        let conversations = 0
        let messages = 0
        d.exec('BEGIN')
        try {
          for (const c of list) {
            if (typeof c?.id !== 'string' || !ID.test(c.id)) fail('chat/invalid', 'conversation id must be 32 hex')
            const items = Array.isArray(c.messages) ? c.messages.slice(0, 2000) : []
            const created = ms(c.created) || now()
            const updated = Math.max(ms(c.updated) || created, ...items.map((m) => ms(m?.created)))
            conversations += Number(d.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)')
              .run(c.id, clip(c.title, 120).trim() || 'Imported chat', created, updated).changes)
            for (const m of items) {
              if (typeof m?.id !== 'string' || !ID.test(m.id) || !['user', 'assistant'].includes(m.role)) continue
              const text = clip(m.body, 20000)
              if (!text.trim()) continue
              messages += Number(d.prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?)")
                .run(m.id, c.id, m.role, text, ms(m.created) || created, JSON.stringify({ imported: 'platform' })).changes)
            }
          }
          if (payload?.finish === true) {
            d.prepare("INSERT OR REPLACE INTO chat_state VALUES('legacy_import', ?)").run(JSON.stringify({ done: true, at: now() }))
          }
          d.exec('COMMIT')
        } catch (error) { d.exec('ROLLBACK'); throw error }
        return { conversations, messages, done: payload?.finish === true }
      },

    },
  }
  let linked
  const binding = async p => {
    const d = await database()
    const saved = d.prepare("SELECT value FROM chat_state WHERE key='native_personal_binding'").get()
    const existing = saved ? JSON.parse(saved.value) : await host.call('agents/personal-binding',{})
    const scope = p?.agent_id && p?.workspace_id ? {agent_id:p.agent_id,workspace_id:p.workspace_id} : existing
    if (!scope || !ID.test(scope.agent_id) || !ID.test(scope.workspace_id)) fail('chat/identity-required', 'Explicit personal agent and workspace mapping required')
    if (existing && (existing.agent_id !== scope.agent_id || existing.workspace_id !== scope.workspace_id)) fail('chat/identity-conflict', 'Personal agent mapping differs from its durable binding')
    if (!linked) {
      linked = (async () => {
        const conversations = d.prepare('SELECT * FROM conversations ORDER BY created,id').all().map(c => ({...c,messages:d.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created,id').all(c.id).map(m=>({...m,meta:JSON.parse(m.meta)}))}))
        const result = await host.call('agents/adopt-personal-chat',{...scope,id:scope.agent_id,conversations})
        d.prepare("INSERT OR REPLACE INTO chat_state VALUES('native_personal_binding',?)").run(JSON.stringify(scope))
        return result
      })().catch(e => {linked=undefined;throw e})
    }
    return {...await linked,id:scope.agent_id}
  }
  for (const name of ['conversations','create','messages','send','rename','remove']) {
    feature.endpoints[name] = async (p = {}) => {
      const scope = await binding(p)
      const payload = {...p,...scope}
      if (name === 'conversations') return host.call('agents/conversations',payload)
      if (name === 'create') return (await host.call('agents/conversation-create',payload)).conversation
      if (name === 'messages') return host.call('agents/messages',payload)
      if (name === 'send') {
        const profile = await host.call('personal/get',{})
        const {notes,refs} = await recall(p.text,profile)
        const context = composePrompt({text:'',profile,notes}).trim()
        const out = await host.call('agents/send',{...payload,context})
        return {user_message_id:out.message.id,reply:{...out.reply,meta:{...out.reply.meta,memory_refs:refs}}}
      }
      fail('chat/native-operation-required','Use canonical agent conversation management; retained legacy rows were not altered')
    }
  }
  const importLegacy = feature.endpoints.import
  feature.endpoints.import = async p => {const out=await importLegacy(p);linked=undefined;return out}
  return feature

}
