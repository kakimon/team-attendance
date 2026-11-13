// Pages that work without login.
// '/j' = relay page for shared links (it forwards to a protected page, which then asks for login).
// '/account/deleted' = shown right after the account was deleted (already signed out).
// The legal pages declare themselves public with definePageMeta({ public: true }),
// so a build without them has no reference to them here.
const PUBLIC = new Set(['/', '/auth/callback', '/j', '/account/deleted'])

export function isPublicPath(path: string): boolean {
  return PUBLIC.has(path.replace(/\/+$/, '') || '/')
}
