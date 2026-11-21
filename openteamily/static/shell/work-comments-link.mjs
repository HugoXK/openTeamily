const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export function workCommentsFromHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const slug = params.get('work-comments');
  if ([...params].length !== 1 || !SLUG.test(slug || '')) return '';
  return slug;
}
