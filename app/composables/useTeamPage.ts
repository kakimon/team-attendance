import type { TeamSnapshot } from '~/utils/types'

/**
 * Loads a team page. The address is /t/<team id>: it is NOT a way to join, and the server shows the
 * team only to its members (RLS). Nothing about the team (not even its name) is shown otherwise.
 *
 * Old addresses /t/<share token> (bookmarks from before Phase 5-C): the server tells members which
 * team it is (resolve_legacy_team), and they are moved to /t/<team id> with the same sub page.
 * Non-members get no team information and no join form (joining uses the separate join link).
 */
export type TeamPageState = 'loading' | 'ok' | 'not_member' | 'suspended' | 'legacy_unknown' | 'error'

export function useTeamPage(key: () => string) {
  const repo = useRepo()
  const route = useRoute()
  const state = reactive({
    status: 'loading' as TeamPageState,
    error: '',
    snap: null as TeamSnapshot | null,
  })

  async function load() {
    state.error = ''
    if (!state.snap) state.status = 'loading'
    try {
      const k = key()
      if (!isTeamId(k)) {
        const id = await repo.resolveLegacyTeam(k)
        if (!id) {
          state.snap = null
          state.status = 'legacy_unknown'
          return
        }
        // Same sub page and query, new address; the old one is replaced in the history.
        await navigateTo({ path: legacyTeamPath(route.path, k, id), query: route.query, hash: route.hash }, { replace: true })
        return
      }
      state.snap = await repo.loadTeam(k)
      // No access: is it a team where my access was stopped (D6-B1)? Then only the limited cleanup is offered.
      if (!state.snap) {
        const stopped = await repo.mySuspendedMemberships().catch(() => [])
        state.status = stopped.some((x) => x.team_id === k) ? 'suspended' : 'not_member'
        return
      }
      state.status = 'ok'
    } catch (e) {
      state.error = errorMessage(e)
      if (!state.snap) state.status = 'error'
    }
  }

  return { state, load }
}
