/** Only allow in-app absolute paths (blocks //evil.com and https://...). */
export function safeRedirect(v: unknown, fallback = '/'): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : fallback
}
