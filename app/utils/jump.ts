// Shared links go through the relay page /j/ (pre-generated, so GitHub Pages answers 200
// and LINE can show a link preview). Team links and family-invite links use different keys.
const TOKEN = /^[A-Za-z0-9_-]{4,128}$/

/** Where the relay page should send the visitor, or null for an invalid link. */
export function resolveJump(query: Record<string, unknown>): string | null {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const t = one(query.t)
  const i = one(query.i)
  const hasT = typeof t === 'string' && TOKEN.test(t)
  const hasI = typeof i === 'string' && TOKEN.test(i)
  if (hasT === hasI) return null // none, or ambiguous
  return hasI ? `/invite/${i}` : `/t/${t}`
}

/**
 * Builds a link to share in LINE etc.
 * - trailing "/j/" avoids GitHub Pages' 301 (directory) redirect
 * - openExternalBrowser=1 makes LINE open Safari/Chrome (Google login is blocked in LINE's browser)
 */
export function shareUrl(kind: 'team' | 'invite', token: string, origin: string, baseURL: string): string {
  const base = baseURL.replace(/\/$/, '')
  const key = kind === 'team' ? 't' : 'i'
  return `${origin}${base}/j/?${key}=${encodeURIComponent(token)}&openExternalBrowser=1`
}
