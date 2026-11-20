// Browser half of the DS-Bot plugin's legacy /v1 compatibility.
// When this page was served by the user's own DS-Bot (the plugin marks such
// pages with <meta name="openteamily-served-by" content="ds-bot">), legacy /v1
// calls of features that moved into DS-Bot are sent to that DS-Bot as
//   POST /b/api/openteamily {endpoint: '<feature>/v1', payload: {method, path, body, idempotency_key}}
// and the answer is turned back into an ordinary Response, so the page code is
// unchanged. Download links of moved routes are fetched the same way and saved.
// On pages served by the legacy platform this module does nothing.
export const MOUNT = '/b';
export const API_ROUTE = `${MOUNT}/api/openteamily`;

// Legacy route -> feature that serves it inside DS-Bot. Streams add rows as
// features move; a feature the DS-Bot does not have yet falls back to /v1.
export const MOVED = [
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/meetings(?:\/[0-9a-f]{32}(?:\/(?:remove|export))?)?$/, 'meetings'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/memory(?:\/[0-9a-f]{32}(?:\/(?:remove|export|dream(?:\/[0-9a-f]{32})?|versions(?:\/\d{1,8}(?:\/restore)?)?))?)?$/, 'memory'],
];

export function servedByDsBot(doc = globalThis.document) {
  return Boolean(doc && doc.querySelector && doc.querySelector('meta[name="openteamily-served-by"][content="ds-bot"]'));
}

// Map a same-origin URL to {feature, path} or null to leave it alone.
export function movedTarget(input, origin, table = MOVED) {
  let url;
  try { url = new URL(input, origin); } catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith('/v1/')) return null;
  const row = table.find(([pattern]) => pattern.test(url.pathname));
  return row ? { feature: row[1], path: url.pathname + url.search } : null;
}

export function envelope(target, method, headers, body) {
  const payload = { method: String(method || 'GET').toUpperCase(), path: target.path };
  const key = headers && (typeof headers.get === 'function' ? headers.get('Idempotency-Key') : (headers['Idempotency-Key'] || headers['idempotency-key']));
  if (key) payload.idempotency_key = key;
  if (typeof body === 'string' && body) payload.body = JSON.parse(body);
  return { endpoint: `${target.feature}/v1`, payload };
}

export function toResponse(value) {
  if (value.download) {
    const bytes = Uint8Array.from(atob(value.download.data), (c) => c.charCodeAt(0));
    return new Response(bytes, { status: value.status, headers: {
      'Content-Type': value.download.content_type,
      'Content-Disposition': `attachment; filename="${value.download.filename}"` } });
  }
  return new Response(JSON.stringify(value.body ?? {}), { status: value.status, headers: { 'Content-Type': 'application/json' } });
}

export function install(win = globalThis.window) {
  if (!win || win.__openteamilyDsBotShim || !servedByDsBot(win.document)) return null;
  const origin = win.location.origin;
  const original = win.fetch.bind(win);
  async function viaDsBot(target, method, headers, body) {
    const response = await original(API_ROUTE, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope(target, method, headers, body)),
    });
    const result = await response.json();
    if (result && result.ok) return toResponse(result.value);
    if (result && result.error && result.error.code === 'openteamily/not-found') return null;
    return new Response(JSON.stringify({ error: { code: 'unavailable', message: (result && result.error && result.error.message) || 'DS-Bot request failed' } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
  win.fetch = async (input, init = {}) => {
    const isRequest = typeof input !== 'string' && !(input instanceof URL);
    const target = movedTarget(isRequest ? input.url : String(input), origin);
    if (!target) return original(input, init);
    const method = init.method || (isRequest ? input.method : 'GET');
    const headers = init.headers || (isRequest ? input.headers : undefined);
    const body = init.body !== undefined ? init.body : (isRequest && method !== 'GET' ? await input.clone().text() : undefined);
    return (await viaDsBot(target, method, headers, body)) || original(input, init);
  };
  win.document.addEventListener('click', async (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    const target = anchor ? movedTarget(anchor.getAttribute('href'), origin) : null;
    if (!target) return;
    event.preventDefault();
    const response = await viaDsBot(target, 'GET');
    if (!response) { win.location.assign(anchor.href); return; }
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
    const link = win.document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name ? name[1] : 'download';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }, true);
  win.__openteamilyDsBotShim = { MOVED };
  return win.__openteamilyDsBotShim;
}

install();
