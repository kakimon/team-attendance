// DEMO ONLY (loaded only under `nuxt dev` + NUXT_PUBLIC_DEMO_MODE=true).
// In-memory data that mimics the server rules of the SQL RPCs.
import { isSimilarName } from '../utils/normalizeName'
import { DELETE_CONFIRM_TEXT, RepoError, type Player, type Repo, type Team } from '../utils/types'
import { createMockDb } from './mockData'

export { MOCK_USERS } from './mockData'

export function createMockRepo(uid: () => string, userName: () => string, loginAt: () => number = () => 0): Repo {
  const db = createMockDb()
  // Owner hand-over requests (one per team) and "data removed, Auth not yet" users.
  const transfers = new Map<string, { from: string; to: string; expires_at: number }>()
  const pendingDeletion = new Set<string>()
  const notPending = () => must(!pendingDeletion.has(uid()), 'account_deletion_pending')
  const teamName = (id: string) => db.teams.find((t) => t.id === id)?.name ?? ''
  const nameIn = (teamId: string, userId: string) =>
    db.members.find((m) => m.team_id === teamId && m.user_id === userId)?.display_name ?? null
  const others = (teamId: string) => db.members.filter((m) => m.team_id === teamId && m.user_id !== uid())
  const guardiansOf = (playerId: string) => db.guardians.filter((g) => g.player_id === playerId)
  const reauthLeft = () => Math.max(0, Math.floor((loginAt() + 10 * 60_000 - Date.now()) / 1000))
  const remove = <T>(arr: T[], pred: (x: T) => boolean) => {
    for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) arr.splice(i, 1)
  }
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
      notPending()
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
      notPending()
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
      notPending()
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

    async deletionPreview() {
      const me = uid()
      const mine = db.members.filter((m) => m.user_id === me)
      const myChildren = db.players.filter((p) => guardiansOf(p.id).some((g) => g.user_id === me) && !archivedPlayers.has(p.id))
      const live = (id: string) => transfers.get(id) && transfers.get(id)!.expires_at > Date.now() ? transfers.get(id)! : null
      return clone({
        deletion_pending: pendingDeletion.has(me),
        reauth_seconds_left: reauthLeft(),
        teams_to_hand_over: mine.filter((m) => m.role === 'owner' && others(m.team_id).length).map((m) => {
          const x = live(m.team_id)
          return {
            team_id: m.team_id, team_name: teamName(m.team_id),
            candidates: others(m.team_id).map((o) => ({ user_id: o.user_id, display_name: o.display_name, role: o.role })),
            pending: x ? { to_user: x.to, to_name: nameIn(m.team_id, x.to), expires_at: new Date(x.expires_at).toISOString() } : null,
          }
        }),
        teams_to_close: mine.filter((m) => m.role === 'owner' && !others(m.team_id).length)
          .map((m) => ({ team_id: m.team_id, team_name: teamName(m.team_id) })),
        teams_to_leave: mine.filter((m) => m.role !== 'owner').map((m) => ({ team_id: m.team_id, team_name: teamName(m.team_id), role: m.role })),
        children_to_delete: myChildren.filter((p) => guardiansOf(p.id).length === 1).map((p) => ({
          player_id: p.id, name: p.name, team_name: teamName(p.team_id),
          answers: db.attendance.filter((a) => a.player_id === p.id).length,
        })),
        children_kept_by_family: myChildren.filter((p) => guardiansOf(p.id).length > 1)
          .map((p) => ({ player_id: p.id, name: p.name, team_name: teamName(p.team_id) })),
      })
    },
    async myOwnerTransfers() {
      const now = Date.now()
      const list = [...transfers.entries()].filter(([, x]) => x.expires_at > now)
      return {
        incoming: list.filter(([, x]) => x.to === uid()).map(([team_id, x]) => ({
          team_id, team_name: teamName(team_id), from_name: nameIn(team_id, x.from), expires_at: new Date(x.expires_at).toISOString(),
        })),
        outgoing: list.filter(([, x]) => x.from === uid()).map(([team_id, x]) => ({
          team_id, team_name: teamName(team_id), to_user: x.to, to_name: nameIn(team_id, x.to), expires_at: new Date(x.expires_at).toISOString(),
        })),
      }
    },
    async requestOwnerTransfer(teamId, toUser) {
      must(member(teamId)?.role === 'owner')
      must(toUser !== uid() && nameIn(teamId, toUser) !== null, 'invalid_new_owner')
      transfers.set(teamId, { from: uid(), to: toUser, expires_at: Date.now() + 7 * 24 * 3600_000 })
    },
    async cancelOwnerTransfer(teamId) {
      must(transfers.get(teamId)?.from === uid(), 'transfer_not_found')
      transfers.delete(teamId)
    },
    async respondOwnerTransfer(teamId, accept) {
      const x = transfers.get(teamId)
      must(x?.to === uid(), 'transfer_not_found')
      transfers.delete(teamId)
      if (x!.expires_at <= Date.now()) return 'expired'
      if (!accept) return 'declined'
      const from = db.members.find((m) => m.team_id === teamId && m.user_id === x!.from && m.role === 'owner')
      const to = member(teamId)
      if (!from || !to) return 'stale'
      from.role = 'member'
      to.role = 'owner'
      return 'accepted'
    },
    async deleteAccount(confirm) {
      const me = uid()
      must(confirm === DELETE_CONFIRM_TEXT, 'confirm_required')
      const pending = pendingDeletion.has(me)
      must(pending || reauthLeft() > 0, 'reauth_required')
      must(!db.members.some((m) => m.user_id === me && m.role === 'owner' && others(m.team_id).length), 'owner_must_transfer')
      const solo = db.members.filter((m) => m.user_id === me && m.role === 'owner').map((m) => m.team_id)
      remove(db.teams, (t) => solo.includes(t.id))
      remove(db.players, (p) => solo.includes(p.team_id)
        || (guardiansOf(p.id).some((g) => g.user_id === me) && guardiansOf(p.id).length === 1))
      remove(db.attendance, (a) => !db.players.some((p) => p.id === a.player_id))
      remove(db.guardians, (g) => g.user_id === me || !db.players.some((p) => p.id === g.player_id))
      remove(db.members, (m) => m.user_id === me || solo.includes(m.team_id))
      for (const [t, x] of transfers) if (x.from === me || x.to === me) transfers.delete(t)
      // Demo switch to see the retry screen: localStorage 'demo:failAuthDelete' = '1' fails once.
      if (!pending && localStorage.getItem('demo:failAuthDelete') === '1') {
        localStorage.removeItem('demo:failAuthDelete')
        pendingDeletion.add(me)
        throw new RepoError('auth_delete_failed')
      }
      pendingDeletion.delete(me)
    },
  }
}
