// DEMO ONLY (loaded only under `nuxt dev` + NUXT_PUBLIC_DEMO_MODE=true).
// In-memory data that mimics the server rules of the SQL RPCs.
import { isSimilarName } from '../utils/normalizeName'
import { RepoError, type Player, type Repo, type Team } from '../utils/types'
import { createMockDb } from './mockData'

export { MOCK_USERS } from './mockData'

export function createMockRepo(uid: () => string, userName: () => string): Repo {
  const db = createMockDb()
  // Logical delete / cancel, like deleted_at / archived_at in the DB (data is kept).
  const deletedEvents = new Set<string>()
  const archivedPlayers = new Set<string>()
  const liveEvent = (id: string) => db.events.find((e) => e.id === id && !deletedEvents.has(id))
  const livePlayer = (id: string) => db.players.find((p) => p.id === id && !archivedPlayers.has(id))
  const isAdminOf = (teamId: string) => ['owner', 'admin'].includes(member(teamId)?.role ?? '')
  const rid = () => Math.random().toString(36).slice(2, 10)
  const member = (teamId: string) => db.members.find((m) => m.team_id === teamId && m.user_id === uid())
  const isGuardian = (playerId: string) => db.guardians.some((g) => g.player_id === playerId && g.user_id === uid())
  const must = (ok: unknown, code: ConstructorParameters<typeof RepoError>[0] = 'forbidden') => {
    if (!ok) throw new RepoError(code)
  }
  const clone = <T>(v: T): T => structuredClone(v)

  return {
    async myTeams() {
      return db.teams.flatMap((t) => {
        const m = member(t.id)
        return m ? [{ ...t, role: m.role }] : []
      })
    },
    async createTeam(name, displayName) {
      const t: Team = { id: rid(), name, share_token: rid() + rid() }
      db.teams.push(t)
      db.members.push({ team_id: t.id, user_id: uid(), role: 'owner', display_name: displayName })
      return t
    },
    async teamPreview(token) {
      const t = db.teams.find((x) => x.share_token === token)
      if (!t) return null
      const m = member(t.id)
      return { id: t.id, name: t.name, is_member: !!m, role: m?.role ?? null }
    },
    async joinTeam(token, displayName) {
      const t = db.teams.find((x) => x.share_token === token)
      must(t, 'team_not_found')
      if (!member(t!.id)) db.members.push({ team_id: t!.id, user_id: uid(), role: 'member', display_name: displayName })
      return t!.id
    },
    async loadTeam(teamId) {
      const team = db.teams.find((t) => t.id === teamId)
      const me = member(teamId)
      if (!team || !me) return null
      const players = db.players.filter((p) => p.team_id === teamId && !archivedPlayers.has(p.id))
      const events = db.events.filter((e) => e.team_id === teamId && !deletedEvents.has(e.id))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      return clone({
        team, me, players, events,
        attendance: db.attendance.filter((a) => events.some((e) => e.id === a.event_id) && players.some((p) => p.id === a.player_id)),
        myPlayerIds: players.filter((p) => isGuardian(p.id)).map((p) => p.id),
      })
    },
    async registerPlayer(teamId, name, note, confirmSimilar) {
      must(member(teamId))
      must(name.trim(), 'name_required')
      const similar = db.players.filter((p) => p.team_id === teamId && !archivedPlayers.has(p.id) && isSimilarName(p.name, name))
        .map(({ id, name, note }) => ({ id, name, note }))
      if (similar.length && !confirmSimilar) return { status: 'similar_found', similar }
      const p: Player = { id: rid(), team_id: teamId, name: name.trim(), note: note?.trim() || null }
      db.players.push(p)
      db.guardians.push({ player_id: p.id, user_id: uid(), added_via: 'registrant' })
      return { status: 'created', player_id: p.id }
    },
    async setAttendance(eventId, playerId, status, comment) {
      must(liveEvent(eventId) && livePlayer(playerId), 'not_found')
      must(isGuardian(playerId))
      const i = db.attendance.findIndex((x) => x.event_id === eventId && x.player_id === playerId)
      if (i >= 0) db.attendance.splice(i, 1)
      if (status !== 'unanswered') {
        db.attendance.push({ event_id: eventId, player_id: playerId, status, comment, updated_at: new Date().toISOString() })
      }
    },
    async createEvent(teamId, ev) {
      const m = member(teamId)
      must(m && (m.role === 'owner' || m.role === 'admin'))
      db.events.push({ ...ev, id: rid(), team_id: teamId })
    },
    async updateEvent(eventId, ev) {
      const e = liveEvent(eventId)
      must(e, 'not_found')
      must(isAdminOf(e!.team_id))
      Object.assign(e!, ev) // answers are keyed by event id and stay as they are
    },
    async deleteEvent(eventId) {
      const e = liveEvent(eventId)
      must(e, 'not_found')
      must(isAdminOf(e!.team_id))
      deletedEvents.add(eventId)
    },
    async updatePlayer(playerId, name, note, confirmSimilar) {
      const p = livePlayer(playerId)
      must(p, 'not_found')
      must(isGuardian(playerId))
      must(name.trim(), 'name_required')
      const similar = db.players
        .filter((x) => x.team_id === p!.team_id && x.id !== playerId && !archivedPlayers.has(x.id) && isSimilarName(x.name, name))
        .map(({ id, name, note }) => ({ id, name, note }))
      if (similar.length && !confirmSimilar) return { status: 'similar_found', similar }
      p!.name = name.trim()
      p!.note = note?.trim() || null
      return { status: 'updated' }
    },
    async archivePlayer(playerId) {
      must(livePlayer(playerId), 'not_found')
      must(isGuardian(playerId))
      archivedPlayers.add(playerId)
    },
    async createInvitation(playerId) {
      must(isGuardian(playerId))
      must(livePlayer(playerId), 'not_found')
      const token = rid() + rid() + rid()
      const expires_at = Date.now() + 24 * 3600_000
      db.invitations.push({ token, player_id: playerId, expires_at, used: false })
      return { token, expires_at: new Date(expires_at).toISOString() }
    },
    async acceptInvitation(token, displayName) {
      const inv = db.invitations.find((i) => i.token === token)
      must(inv, 'invitation_invalid')
      const p = livePlayer(inv!.player_id)
      must(p, 'invitation_invalid')
      const t = db.teams.find((x) => x.id === p!.team_id)!
      const result = { player_id: p!.id, player_name: p!.name, team_id: t.id, share_token: t.share_token }
      // Already a guardian: normal result, and the invitation is NOT consumed.
      if (isGuardian(p!.id)) return { status: 'already_guardian', ...result }
      must(!inv!.used && inv!.expires_at > Date.now(), 'invitation_invalid')
      inv!.used = true
      if (!member(t.id)) db.members.push({ team_id: t.id, user_id: uid(), role: 'member', display_name: displayName || userName() })
      db.guardians.push({ player_id: p!.id, user_id: uid(), added_via: 'invitation' })
      return { status: 'accepted', ...result }
    },
  }
}
