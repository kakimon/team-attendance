// Shared links go through the relay page /j/ (pre-generated, so GitHub Pages answers 200
// and LINE can show a link preview). Each kind of link uses its own key:
//   ?k=<join token>      join link of a team (Phase 5-C: separate token, can be re-issued / stopped)
//   ?i=<invite token>    family invitation
//   ?t=<share token>     OLD team link (before Phase 5-C). Forwarded to /t/<share token>, where only
//                        existing members are moved on to the team page; it never lets anyone join.
const TOKEN = /^[A-Za-z0-9_-]{4,128}$/

/** Where the relay page should send the visitor, or null for an invalid link. */
export function resolveJump(query: Record<string, unknown>): string | null {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  const found = (['k', 'i', 't'] as const).flatMap((key) => {
    const v = one(query[key])
    return typeof v === 'string' && TOKEN.test(v) ? [{ key, v }] : []
  })
  if (found.length !== 1) return null // none, or ambiguous
  const { key, v } = found[0]!
  return key === 'k' ? `/join/${v}` : key === 'i' ? `/invite/${v}` : `/t/${v}`
}

/**
 * Builds a link to share in LINE etc.
 * - trailing "/j/" avoids GitHub Pages' 301 (directory) redirect
 * - openExternalBrowser=1 makes LINE open Safari/Chrome (Google login is blocked in LINE's browser)
 * - 'team' (old share token) is kept only for links that already exist; new links are 'join'.
 */
export function shareUrl(kind: 'join' | 'invite' | 'team', token: string, origin: string, baseURL: string): string {
  const base = baseURL.replace(/\/$/, '')
  const key = kind === 'join' ? 'k' : kind === 'invite' ? 'i' : 't'
  return `${origin}${base}/j/?${key}=${encodeURIComponent(token)}&openExternalBrowser=1`
}

/** A team page address /t/<team id> (a UUID). Anything else under /t/ is an old share-token address. */
export const isTeamId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/**
 * Old team page address -> the same page under the team id: /t/<share token>/answer?x -> /t/<id>/answer.
 * Only for addresses that start with /t/<share token>; anything else stays unchanged.
 */
export function legacyTeamPath(path: string, shareToken: string, teamId: string): string {
  const prefix = `/t/${shareToken}`
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return path
  return `/t/${teamId}${path.slice(prefix.length)}`
}
