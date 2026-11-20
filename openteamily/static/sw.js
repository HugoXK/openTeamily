/* Minimal install credential for /space.
   This worker exists so the browser may offer "install": it claims its clients
   and passes every request straight to the network. It deliberately precaches
   nothing — a cached shell page would outlive a deployment and show a stale
   build — and answers only a failed page navigation with the offline notice. */
const OFFLINE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>离线 · OpenTeamily</title></head><body>'
  + '<main style="font:16px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:32rem;padding:0 1.5rem">'
  + '<h1 style="font-size:1.25rem">现在连不上这台 OpenTeamily</h1>'
  + '<p>这个窗口里没有缓存页面，所以断网时看不到内容。网络恢复后刷新即可。</p>'
  + '<p>自托管实例停在那里就真的停了：请检查管理端进程是否还在运行。</p>'
  + '</main></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => new Response(OFFLINE, {
      status: 503,
      headers: {'Content-Type': 'text/html; charset=utf-8'},
    })));
  }
});
