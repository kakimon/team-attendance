import type { TeamPreview, TeamSnapshot } from '~/utils/types'

/**
 * Loads a team by its shared URL token.
 * Non-members see only the team name and a "join" button (role = member).
 */
export function useTeamPage(token: () => string) {
  const repo = useRepo()
  const state = reactive({
    loading: true,
    error: '',
    preview: null as TeamPreview | null,
    snap: null as TeamSnapshot | null,
  })

  async function load() {
    state.loading = true
    state.error = ''
    try {
      state.preview = await repo.teamPreview(token())
      state.snap = state.preview?.is_member ? await repo.loadTeam(state.preview.id) : null
    } catch (e) {
      state.error = errorMessage(e)
    } finally {
      state.loading = false
    }
  }

  async function join(displayName: string) {
    try {
      await repo.joinTeam(token(), displayName)
      await load()
    } catch (e) {
      state.error = errorMessage(e)
    }
  }

  return { state, load, join }
}
