const idPattern = /^[0-9a-f]{32}$/;

export function studioDocumentHref(workspace, id) {
  if (!idPattern.test(workspace || '') || !idPattern.test(id || '')) return '';
  return '/space?' + new URLSearchParams({workspace, studio:id});
}

export function studioDocumentFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const workspace = params.get('workspace'), id = params.get('studio');
  return params.size === 2 && studioDocumentHref(workspace, id) ? {workspace,id} : null;
}

export function studioDocumentHrefInMessage(text, origin) {
  if (!origin || typeof text !== 'string' || !text.includes('studio=')) return '';
  for (const match of text.matchAll(/(?:^|\s)(https?:\/\/[^\s<>"']+|\/(?:space|artifacts)\?[^\s<>"']+)/gu)) {
    let url;
    try { url = new URL(match[1].replace(/[.,;!?)。，；！）]+$/u, ''), origin); } catch { continue; }
    if (url.origin !== origin || url.username || url.password || url.hash ||
        !['/space','/artifacts'].includes(url.pathname)) continue;
    const reference = studioDocumentFromSearch(url.search);
    if (reference) return studioDocumentHref(reference.workspace, reference.id);
  }
  return '';
}
