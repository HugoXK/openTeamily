const CODE = /^[A-Za-z0-9_-]{24}$/;

export function meetingCodeFromHash(hash) {
  const code = new URLSearchParams(hash?.slice(1)).get('meeting');
  return typeof code === 'string' && CODE.test(code) ? code : '';
}

export function meetingHref(code) {
  return typeof code === 'string' && CODE.test(code) ? '/chat#meeting=' + code : '';
}

export function parseMeetingCode(value, origin) {
  const input = value.trim();
  if (CODE.test(input)) return input;
  try {
    const url = new URL(input, origin);
    return url.origin === origin && /^\/chat\/?$/.test(url.pathname) ? meetingCodeFromHash(url.hash) : '';
  } catch { return ''; }
}
