export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export async function waitForRuntime(read, {delay = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 48} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(attempt < 4 ? 1000 : 3000);
    const reply = await read().catch(() => null);
    if (reply?.status === 401) return 'signed-out';
    const state = reply?.body?.state;
    if (reply?.status === 200 && ['ready', 'unmanaged', 'unavailable', 'setup'].includes(state)) return state;
  }
  return 'timeout';
}
