// Private chat with the personal agent, executed as native DS-Bot turns in the
// user's own DS-Bot (moved from conversations.py / personal.py / agent_memory.py).
// Each conversation is its own native DS-Bot session ('plugin:<id>').
import { openDatabase, newId, fail } from '../../src/store.js'
import { rank, noteBlock } from './recall.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created, id);
`
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
  let queue = Promise.resolve()
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }

  async function recall(text, profile) {
    if (profile?.recall === 'off') return { notes: '', refs: [] }
    let pages = []
    try { pages = await host.call('memory/pages', {}) } catch (error) { if (error?.code !== 'openteamily/not-found') throw error }
    const hits = rank(text, Array.isArray(pages) ? pages : [])
    return { notes: noteBlock(hits, text), refs: hits.map(({ page, score }) => ({ id: page.id, revision: page.revision ?? 1, title: page.title ?? '', score: Number(score.toFixed(3)) })) }
  }

  return {
    pages: ['chat'],
    endpoints: {
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
      async send(payload) {
        const convo = await conversation(payload?.conversation_id)
        const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
        if (!text || text.length > 20000) fail('chat/invalid', 'text must be 1–20000 characters')
        const services = await host.runtime()
        if (typeof services.chatTurn !== 'function') fail('chat/runtime-unavailable', 'DS-Bot chat is not available in this runtime')
        const d = await database()
        const userRow = { id: newId(), created: now() }
        d.prepare("INSERT INTO messages VALUES(?,?,'user',?,?,'{}')").run(userRow.id, convo.id, text, userRow.created)
        let profile = null
        try { profile = await host.call('personal/get', {}) } catch { profile = null }
        const { notes, refs } = await recall(text, profile)
        const prompt = composePrompt({ text, profile, notes })
        const turn = await serial(() => services.chatTurn('plugin:' + convo.id, prompt, 'otp:' + userRow.id))
        const reply = { id: newId(), created: now() }
        const meta = { engine: 'ds-bot', session_id: turn.sessionId ?? null, turn_id: turn.turnId ?? null, memory_refs: refs }
        d.prepare("INSERT INTO messages VALUES(?,?,'assistant',?,?,?)").run(reply.id, convo.id, String(turn.text ?? ''), reply.created, JSON.stringify(meta))
        d.prepare('UPDATE conversations SET updated=? WHERE id=?').run(reply.created, convo.id)
        return { user_message_id: userRow.id, reply: { id: reply.id, text: String(turn.text ?? ''), created: reply.created, meta } }
      },
    },
  }
}
