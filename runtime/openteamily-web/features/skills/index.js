// Skills live in the user's own DS-Bot as native capabilities attached to the
// Main Bot (moved from skill_installs.py / skill_execution.py). Instruction-only.
import { fail } from '../../src/store.js'

const NAME = /^[a-z0-9][a-z0-9-]{1,47}$/
const PREFIX = 'ot-user-skill-'

export default function skills(host) {
  const ready = async () => {
    const services = await host.runtime()
    if (typeof services.mainBot !== 'function') fail('skills/runtime-unavailable', 'DS-Bot skills are not available in this runtime')
    const botId = await services.mainBot()
    return { rt: services.rt, botId }
  }
  return {
    pages: ['skills'],
    endpoints: {
      async list() {
        const { rt, botId } = await ready()
        const attached = [...(rt.botOf(botId)?.capabilities ?? [])].filter((name) => typeof name === 'string')
        return { items: attached.filter((name) => name.startsWith('ot-')).sort().map((name) => ({ name, source: name.startsWith(PREFIX) ? 'user' : 'openteamily' })) }
      },
      async save(payload) {
        const slug = String(payload?.name ?? '')
        if (!NAME.test(slug)) fail('skills/invalid', 'name: 2–48 lowercase letters, digits or dashes')
        const content = typeof payload?.content === 'string' ? payload.content : ''
        if (!content.trim() || content.length > 20000) fail('skills/invalid', 'content must be 1–20000 characters')
        const description = String(payload?.description ?? slug).slice(0, 200)
        const { rt, botId } = await ready()
        const name = PREFIX + slug
        await rt.capabilitySave({ name, kind: 'skill', description, content }, { ui: true })
        if (!(rt.botOf(botId)?.capabilities ?? []).includes(name)) await rt.changeCapabilityAttachment('attach', { name }, botId)
        return { name, attached: true }
      },
      async remove(payload) {
        const slug = String(payload?.name ?? '')
        if (!NAME.test(slug)) fail('skills/invalid', 'invalid name')
        const { rt, botId } = await ready()
        await rt.changeCapabilityAttachment('detach', { name: PREFIX + slug }, botId).catch(() => {})
        return { removed: true }
      },
    },
  }
}
