// Observe DSH's existing session events and agent/assistant-stream frames.
// This module only reads events and writes the agent-runs trace store. It does
// not change model selection, tools, permissions, subagents or the runtime.
import { normalizeEvent, normalizeStreamFrame } from '../../lib/agent-runtime/contract.js'

const MAX_TURN = 1e9

function agentIdentity(rt, sessionId) {
  const botId = rt?.chatOwners?.get?.(sessionId) ?? rt?.botOf?.(sessionId)?.id
  const bot = botId ? rt?.botOf?.(botId) : rt?.botOf?.(sessionId)
  const link = bot?.openteamily
  if (!link?.workspace_id || !link?.agent_id) return null
  return {
    workspace_id: link.workspace_id,
    agent_id: link.agent_id,
    bot_id: bot.id ?? botId ?? null,
  }
}

const turnFrom = (data) => Number.isSafeInteger(data?.turn) && data.turn >= 0 && data.turn <= MAX_TURN
  ? data.turn : null

export function attachRunObserver({ host, store, log = () => {} }) {
  const activeTurns = new Map()
  const disposers = []
  let disposed = false

  function write(run, events) {
    const appended = []
    for (const event of events) {
      try {
        store.appendEvents(run.run_id, [event])
        appended.push(event.type)
      } catch (error) {
        if (error?.status === 409) {
          // A duplicate/replayed event must not stop the observer.
          continue
        }
        log(`agent-runs observer could not append ${event.type}: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    return appended
  }

  function append(sessionId, turn, raw, stream = false) {
    if (disposed || typeof sessionId !== 'string' || !sessionId) return
    const rt = currentRt
    if (!rt) return
    const meta = agentIdentity(rt, sessionId)
    if (!meta) return
    const ensured = store.ensureRun({
      workspace_id: meta.workspace_id,
      agent_id: meta.agent_id,
      session_id: sessionId,
      turn_id: String(turn),
      source: 'dsh',
      at: raw?.time ?? raw?.at ?? 0,
    })
    const sequence = store.nextSequence(ensured.run.run_id)
    const events = stream
      ? normalizeStreamFrame(ensured.run.run_id, raw, sequence)
      : normalizeEvent(ensured.run.run_id, raw, sequence)
    for (const event of events) {
      write(ensured.run, [event])
    }
  }

  function eventTurn(sessionId, event) {
    const turn = turnFrom(event?.data)
    if (turn !== null) {
      activeTurns.set(sessionId, turn)
      return turn
    }
    return activeTurns.get(sessionId) ?? null
  }

  let currentRt = null
  const ready = host.runtime({ timeoutMs: 120_000 }).then(({ rt, ctx }) => {
    if (disposed) return
    currentRt = rt
    const on = (name, handler) => {
      if (typeof ctx?.on !== 'function') return
      const dispose = ctx.on(name, handler)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        const turn = eventTurn(sessionId, event)
        if (turn === null) return
        append(sessionId, turn, event)
        if (event?.type === 'turn/end') activeTurns.delete(sessionId)
      } catch (error) {
        log(`agent-runs observer ignored a session event: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    })
    on('agent/assistant-stream', (payload) => {
      try {
        const sessionId = payload?.agent?.session?.id
        const frame = payload?.frame
        const turn = turnFrom(frame) ?? activeTurns.get(sessionId) ?? null
        if (turn === null) return
        activeTurns.set(sessionId, turn)
        append(sessionId, turn, payload, true)
      } catch (error) {
        log(`agent-runs observer ignored a stream frame: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    })
    return { rt, ctx }
  }).catch((error) => {
    log(`agent-runs observer not attached: ${String(error?.code ?? error?.message ?? error).slice(0, 120)}`)
    return null
  })

  function dispose() {
    disposed = true
    for (const disposer of disposers.splice(0)) {
      try { disposer() } catch {}
    }
  }

  return { ready, dispose }
}
