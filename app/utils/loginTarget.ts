/** What kind of invitation brought the visitor here (from the already-sanitised ?redirect). */
export type InviteKind = 'team' | 'family' | null

export function inviteKindOf(redirect: string): InviteKind {
  if (/^\/(join|t)\/[^/?#]+/.test(redirect)) return 'team'
  if (/^\/invite\/[^/?#]+/.test(redirect)) return 'family'
  return null
}

/**
 * Where to go after Google login. An invitation (or any page the visitor was sent away from)
 * always wins; "create a team" only applies when there is none.
 */
export function loginTarget(redirect: string, intent: 'create' | null = null): string {
  if (redirect) return redirect
  if (intent === 'create') return '/teams/new'
  return '/'
}
