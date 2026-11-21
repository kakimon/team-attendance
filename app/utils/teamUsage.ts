import type { Role } from './types'

// Current U1 rule: private.owner_quota() = 3. Checked against the migrations in
// tests/db/teamUsage.test.ts. This is not a per-user quota returned by an RPC.
export const OWNER_TEAM_LIMIT = 3

/** Only count current DB memberships; unknown/loading must never look like zero. */
export function ownedTeamCount(teams: readonly { role: Role }[] | null): number | null {
  return teams === null ? null : teams.filter((team) => team.role === 'owner').length
}
