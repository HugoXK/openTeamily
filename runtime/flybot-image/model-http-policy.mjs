import { request as httpRequest } from 'node:http'
// Capability for the authenticated task transport, not a general HTTP/SDK opt-in.
export const MODEL_HTTP_FORMAT = 'openteamily.exact-http-task.v1'
export const MODEL_HTTP_HEADER = 'X-Openteamily-Model-HTTP'
const denied = [
  [[0,0,0,0],8], [[10,0,0,0],8], [[100,64,0,0],10], [[127,0,0,0],8],
  [[169,254,0,0],16], [[172,16,0,0],12], [[192,0,0,0],24], [[192,0,2,0],24],
  [[192,88,99,0],24], [[192,168,0,0],16], [[198,18,0,0],15],
  [[198,51,100,0],24], [[203,0,113,0],24], [[224,0,0,0],4], [[240,0,0,0],4],
]
const integer = parts => parts.reduce((n, p) => n * 256 + p, 0)
export function publicHttpBase(value) {
  if (typeof value !== 'string' || value.length > 512) return false
  const m = /^http:\/\/([0-9.]+):([1-9][0-9]{0,4})(\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+)$/.exec(value)
  if (!m || m[0] !== value || Number(m[2]) > 65535) return false
  const parts = m[1].split('.')
  if (parts.length !== 4 || !parts.every(p => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)) return false
  const number = integer(parts.map(Number))
  if (denied.some(([ip, bits]) => Math.floor(number / 2 ** (32-bits)) === Math.floor(integer(ip) / 2 ** (32-bits)))) return false
  return !m[3].split('/').some(p => p === '.' || p === '..')
}
export function validHttpGrant(base, grant) {
  return publicHttpBase(base) && grant !== null && typeof grant === 'object' && !Array.isArray(grant)
    && JSON.stringify(Object.keys(grant).sort()) === '["base_url","format"]'
    && grant.format === MODEL_HTTP_FORMAT && grant.base_url === base
}
// Existing local/private HTTP development remains separate from the public lane.
function localHttp(url) {
  if (url.hostname === 'localhost' || url.hostname === '[::1]') return true
  if (/^\[(?:fc|fd|fe[89ab])[0-9a-f:]+\]$/i.test(url.hostname)) return true
  const p = url.hostname.split('.').map(Number)
  return p.length === 4 && (p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254))
}
export function validateModelEndpoint(base, grant) {
  if (typeof base !== 'string' || base.length > 512 || /[\x00-\x20\\]/.test(base)) throw new Error('Model endpoint rejected')
  let url
  try { url = new URL(base) } catch { throw new Error('Model endpoint rejected') }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(base)) throw new Error('Model endpoint rejected')
  if (grant !== undefined) {
    if (!validHttpGrant(base, grant)) throw new Error('HTTP model task grant rejected')
    return true
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && localHttp(url))) return false
  throw new Error('Model endpoint requires an operator-issued HTTP task grant')
}

// Unlike global fetch, node:http does not consult an inherited environment proxy
// or a global Undici dispatcher. No redirect machinery or reusable cookie jar.
// The injected requester exists solely for loopback-only wire tests.
export function fetchHttpTask(base, grant, init, requester = httpRequest) {
  if (!validHttpGrant(base, grant) || init.method !== 'POST' || init.redirect !== 'error') {
    return Promise.reject(new Error('HTTP model task transport rejected'))
  }
  const target = base + '/chat/completions'
  const url = new URL(target)
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('HTTP model task request failed'))
    let req
    try {
      req = requester({hostname:url.hostname, port:url.port || 80,
        path:url.pathname, method:'POST', headers:init.headers, agent:false,
        family:4, signal:init.signal}, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy(); reject(new Error('Model redirect rejected')); return
        }
        const chunks=[]; let length=0
        response.on('error', fail)
        response.on('data', chunk => {
          length += chunk.length
          if (length > 65536) { response.destroy(); fail(); return }
          chunks.push(chunk)
        })
        response.on('end', () => resolve({ok:response.statusCode >= 200 && response.statusCode < 300,
          status:response.statusCode, redirected:false, url:target,
          json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}))
      })
      req.on('error', fail)
      req.end(init.body)
    } catch { req?.destroy(); fail() }
  })
}
