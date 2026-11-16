/* Shared FlyBot management shell. Enhances chrome only; does not invent
   data, hide functional notes, or replace page APIs or form IDs. */
function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function currentPath() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  return path;
}

function markNavigation() {
  const here = currentPath();
  for (const link of document.querySelectorAll('nav a[href]')) {
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('/')) continue;
    const target = href.split('?')[0].replace(/\/+$/, '') || '/';
    if (target === here) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function minutes(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function resolveTheme(values, now = new Date(), media) {
  const appearance = values && values.appearance ? values.appearance : 'system';
  if (appearance === 'light' || appearance === 'dark') return appearance;
  if (appearance === 'auto' && values && values.appearance_schedule === 'custom') {
    const start = minutes(values.appearance_start);
    const end = minutes(values.appearance_end);
    if (start != null && end != null && start !== end) {
      const current = now.getHours() * 60 + now.getMinutes();
      const inRange = start < end ? current >= start && current < end : current >= start || current < end;
      return inRange ? 'dark' : 'light';
    }
  }
  const query = media || (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
  return query && query.matches ? 'dark' : 'light';
}

export function applyResolvedTheme(doc, values, now, media) {
  const theme = resolveTheme(values, now, media);
  doc.documentElement.dataset.themeResolved = theme;
  if (doc.body) doc.body.dataset.themeResolved = theme;
  return theme;
}

function looksLoading(text) {
  return /加载|载入|正在|请稍候|等待/.test(text || '');
}

function decorateStatus(node) {
  if (!node) return;
  const text = (node.textContent || '').trim();
  if (!text) {
    node.removeAttribute('data-kind');
    document.body.removeAttribute('aria-busy');
    return;
  }
  if (!node.getAttribute('data-kind') && looksLoading(text)) {
    node.setAttribute('data-kind', 'loading');
  }
  if (node.getAttribute('data-kind') === 'loading' || looksLoading(text)) {
    document.body.setAttribute('aria-busy', 'true');
  } else {
    document.body.removeAttribute('aria-busy');
  }
}

async function loadAppearance() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 3000) : null;
  try {
    const response = await fetch('/v1/settings', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie) },
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) return null;
    const body = await response.json();
    return (body && body.settings && body.settings.values) || null;
  } catch (error) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}


function signedInPanel(doc) {
  return doc.getElementById('settings-panel') || doc.getElementById('main-panel');
}

function closeAccountMenu(doc) {
  const menu = doc.getElementById('account-menu');
  const button = doc.getElementById('account-menu-button');
  if (menu) menu.setAttribute('hidden', '');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function syncAccountSlot(doc) {
  const slot = doc.querySelector('.account-slot');
  const panel = signedInPanel(doc);
  if (!slot) return;
  const visible = Boolean(panel && !panel.hasAttribute('hidden'));
  if (visible) slot.removeAttribute('hidden');
  else {
    slot.setAttribute('hidden', '');
    closeAccountMenu(doc);
  }
  const who = doc.getElementById('whoami');
  const name = who ? (who.textContent || '').trim() : '';
  const identity = doc.getElementById('account-identity');
  if (identity) identity.textContent = name;
  const button = doc.getElementById('account-menu-button');
  if (button) {
    const letters = name.replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, '');
    button.textContent = letters ? letters.slice(0, 2).toUpperCase() : '账户';
  }
}

function bindAccountMenu(doc) {
  const button = doc.getElementById('account-menu-button');
  const menu = doc.getElementById('account-menu');
  if (!button || !menu || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', event => {
    event.stopPropagation();
    const open = menu.hasAttribute('hidden');
    if (open) {
      menu.removeAttribute('hidden');
      button.setAttribute('aria-expanded', 'true');
    } else {
      closeAccountMenu(doc);
    }
  });
  doc.addEventListener('click', event => {
    const slot = doc.querySelector('.account-slot');
    if (!slot || slot.hasAttribute('hidden')) return;
    if (slot.contains(event.target)) return;
    closeAccountMenu(doc);
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAccountMenu(doc);
  });
  const panel = signedInPanel(doc);
  const who = doc.getElementById('whoami');
  if (typeof MutationObserver === 'function') {
    const sync = () => syncAccountSlot(doc);
    if (panel) new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    if (who) new MutationObserver(sync).observe(who, { childList: true, characterData: true, subtree: true });
  }
  syncAccountSlot(doc);
}

function enhanceChrome() {
  document.body.classList.add('app');
  if (!document.querySelector('.skip-link')) {
    const skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#main';
    skip.textContent = '跳到主要内容';
    document.body.insertBefore(skip, document.body.firstChild);
  }
  for (const nav of document.querySelectorAll('nav')) {
    if (!nav.getAttribute('aria-label')) nav.setAttribute('aria-label', '管理导航');
  }
  markNavigation();
  decorateStatus(document.getElementById('status'));
  bindAccountMenu(document);
}

function valuesFromDom(doc) {
  const appearance = (doc.body && doc.body.dataset.theme) || 'system';
  const values = { appearance };
  if (appearance === 'auto') {
    values.appearance_schedule = (doc.body && doc.body.dataset.schedule) || 'sunset_sunrise';
    const form = doc.getElementById('settings-form');
    if (form && form.elements) {
      if (form.elements.appearance_start) values.appearance_start = form.elements.appearance_start.value;
      if (form.elements.appearance_end) values.appearance_end = form.elements.appearance_end.value;
    }
  }
  return values;
}

export function startShell(doc = document, options = {}) {
  const target = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const run = async () => {
    enhanceChrome();
    const values = options.values !== undefined ? options.values : await loadAppearance();
    applyResolvedTheme(doc, values || { appearance: 'system' }, options.now, options.media);
    if (doc.body && typeof MutationObserver === 'function') {
      new MutationObserver(() => {
        if (doc.body && (doc.body.dataset.theme || doc.body.dataset.schedule)) {
          applyResolvedTheme(doc, valuesFromDom(doc), options.now, options.media);
        }
      }).observe(doc.body, { attributes: true, attributeFilter: ['data-theme', 'data-schedule'] });
    }
    const status = doc.getElementById('status');
    if (status && typeof MutationObserver === 'function') {
      new MutationObserver(() => decorateStatus(status)).observe(status, {
        childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-kind'],
      });
    }
  };
  if (doc.readyState === 'loading' && target) target.addEventListener('DOMContentLoaded', run);
  else run();
}

if (typeof document !== 'undefined') startShell();
