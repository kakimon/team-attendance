// DEMO ONLY (loaded only under `nuxt dev` + NUXT_PUBLIC_DEMO_MODE=true).
// In-memory data that mimics the server rules of the SQL RPCs.
import { isSimilarName } from '../utils/normalizeName'
import { DELETE_CONFIRM_TEXT, LEAVE_CLEANUP_CONFIRM, RepoError, type Player, type Repo, type Team } from '../utils/types'
import { createMockDb, MOCK_USERS } from './mockData'

export { DEMO_JOIN_TOKEN, DEMO_TEAM_ID, MOCK_USERS } from './mockData'

export function createMockRepo(uid: () => string, userName: () => string, loginAt: () => number = () => 0): Repo {
  const db = createMockDb()
  // Owner hand-over requests (one per team) and "data removed, Auth not yet" users.
  const transfers = new Map<string, { from: string; to: string; expires_at: number }>()
  const pendingDeletion = new Set<string>()
  const joinedAt = new Map<string, string>() // teamId:userId -> ISO, for members added during the demo
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
  const newToken = () => rid() + rid() + rid() + rid() + rid()        // >= 32 characters, like the server
  const canManage = (teamId: string) => isAdminOf(teamId)
  const isOwnerOf = (teamId: string) => member(teamId)?.role === 'owner'
  const blocks = new Map<string, { user_id: string; blocked_at: string }[]>() // teamId -> removed people
  /** Same as private.member_impact: what leaving / removal does to one person's registrations. */
  const impact = (teamId: string, userId: string) => {
    const inTeam = db.players.filter((p) => p.team_id === teamId)
    const linked = (pid: string) => guardiansOf(pid).some((g) => g.user_id === userId)
    const others = (pid: string) => guardiansOf(pid).some((g) => g.user_id !== userId)
    return {
      self_registrations: inTeam.filter((p) => p.self_user_id === userId)
        .map((p) => ({ player_id: p.id, name: p.name, answers: db.attendance.filter((a) => a.player_id === p.id).length })),
      links_removed: inTeam.filter((p) => p.self_user_id !== userId && linked(p.id) && others(p.id)).map((p) => ({ player_id: p.id, name: p.name })),
      sole_guardian_children: inTeam.filter((p) => p.self_user_id !== userId && linked(p.id) && !others(p.id))
        .map((p) => ({ player_id: p.id, name: p.name, cancelled: archivedPlayers.has(p.id) })),
    }
  }
  /** Same as private.detach_member (refuses while someone would be left without anybody to answer). */
  const detach = (teamId: string, userId: string) => {
    must(!impact(teamId, userId).sole_guardian_children.length, 'sole_guardian_children')
    const self = db.players.filter((p) => p.team_id === teamId && p.self_user_id === userId).map((p) => p.id)
    const invalidated = db.invitations.filter((i) => !self.includes(i.player_id) && !i.used && i.created_by === userId
      && db.players.some((p) => p.id === i.player_id && p.team_id === teamId))
    remove(db.invitations, (i) => invalidated.includes(i) || self.includes(i.player_id))
    remove(db.attendance, (a) => self.includes(a.player_id))
    remove(db.players, (p) => self.includes(p.id))
    const links = db.guardians.filter((g) => !self.includes(g.player_id) && g.user_id === userId
      && db.players.some((p) => p.id === g.player_id && p.team_id === teamId)).length
    remove(db.guardians, (g) => self.includes(g.player_id)
      || (g.user_id === userId && db.players.some((p) => p.id === g.player_id && p.team_id === teamId)))
    remove(db.members, (m) => m.team_id === teamId && m.user_id === userId)
    const x = transfers.get(teamId)
    if (x && (x.from === userId || x.to === userId)) transfers.delete(teamId)
    return { self_registrations_deleted: self.length, links_removed: links, invitations_deleted: invalidated.length }
  }
  // Access stopped by the owner (D6-B1): "teamId:userId" -> when. Such a membership counts as no access.
  const suspended = new Map<string, string>()
  const memberRow = (teamId: string, userId = uid()) => db.members.find((m) => m.team_id === teamId && m.user_id === userId)
  const member = (teamId: string) => (suspended.has(`${teamId}:${uid()}`) ? undefined : memberRow(teamId))
  const isGuardian = (playerId: string) => db.guardians.some((g) => g.player_id === playerId && g.user_id === uid())
  const usable = (i: { used: boolean; revoked_at?: number; expires_at: number }) => !i.used && !i.revoked_at && i.expires_at > Date.now()
  const must = (ok: unknown, code: ConstructorParameters<typeof RepoError>[0] = 'forbidden') => {
    if (!ok) throw new RepoError(code)
  }
  const clone = <T>(v: T): T => structuredClone(v)
  const cleanupState = (teamId: string) => {
    const affected = db.players.filter((p) => p.team_id === teamId && (p.self_user_id === uid() || isGuardian(p.id)))
    const deleting = affected.filter((p) => p.self_user_id === uid() || (!p.self_user_id && !p.is_self && guardiansOf(p.id).every((g) => g.user_id === uid())))
    const ids = deleting.map((p) => p.id)
    // DEMO ONLY comparison string; production uses the server's SHA-256, with server permissions.
    const fingerprint = JSON.stringify([uid(), teamId, member(teamId), joinedAt.get(`${teamId}:${uid()}`), affected,
      affected.map((p) => [p.id, archivedPlayers.has(p.id), guardiansOf(p.id)]),
      db.attendance.filter((a) => ids.includes(a.player_id)),
      db.invitations.filter((i) => ids.includes(i.player_id) || (i.created_by === uid() && !i.used && db.players.some((p) => p.id === i.player_id && p.team_id === teamId)))])
    return { fingerprint, deletions: deleting.map((p) => ({ player_id: p.id, name: p.name, is_self: p.self_user_id === uid(), cancelled: archivedPlayers.has(p.id), answers: db.attendance.filter((a) => a.player_id === p.id).length })) }
  }

  return {
    async myTeams() {
      return db.teams.flatMap((t) => {
        const m = member(t.id)
        return m ? [{ ...t, role: m.role }] : []
      })
    },
    async createTeam(name, displayName) {
      notPending()
      const t: Team = { id: crypto.randomUUID(), name, share_token: rid() + rid() }
      db.teams.push(t)
      db.joinTokens.set(t.id, newToken())
      db.members.push({ team_id: t.id, user_id: uid(), role: 'owner', display_name: displayName })
      joinedAt.set(`${t.id}:${uid()}`, new Date().toISOString())
      return t
    },
    async resolveLegacyTeam(shareToken) {
      const t = db.teams.find((x) => x.share_token === shareToken)
      return t && member(t.id) ? t.id : null                              // members only
    },
    async getJoinLink(teamId) {
      must(canManage(teamId))
      const token = db.joinTokens.get(teamId) ?? null
      return { open: token !== null, token }
    },
    async rotateJoinLink(teamId) {
      must(canManage(teamId))
      const token = newToken()
      db.joinTokens.set(teamId, token)
      return { open: true, token }
    },
    async setJoinOpen(teamId, open) {
      must(canManage(teamId))
      const token = open ? (db.joinTokens.get(teamId) ?? newToken()) : null
      db.joinTokens.set(teamId, token)
      return { open: token !== null, token }
    },
    async previewJoin(token) {
      const teamId = [...db.joinTokens.entries()].find(([, v]) => v && v === token)?.[0]
      const t = teamId ? db.teams.find((x) => x.id === teamId) : undefined
      return t ? { team_id: t.id, name: t.name, is_member: !!member(t.id) } : null
    },
    async joinByToken(token, displayName) {
      const teamId = [...db.joinTokens.entries()].find(([, v]) => v && v === token)?.[0]
      if (!teamId) return { status: 'invalid' }
      if (member(teamId)) return { status: 'already_member', team_id: teamId }
      notPending()
      must(!(blocks.get(teamId) ?? []).some((b) => b.user_id === uid()), 'blocked_from_team')
      db.members.push({ team_id: teamId, user_id: uid(), role: 'member', display_name: displayName })
      joinedAt.set(`${teamId}:${uid()}`, new Date().toISOString())
      return { status: 'joined', team_id: teamId }
    },
    async suspendMember(teamId, userId) {
      must(isOwnerOf(teamId))
      const m = memberRow(teamId, userId)
      must(m, 'member_not_found')
      must(m!.role !== 'owner' && userId !== uid(), 'cannot_remove_owner')
      if (!suspended.has(`${teamId}:${userId}`)) suspended.set(`${teamId}:${userId}`, new Date().toISOString())
      m!.role = 'member'
      for (const i of db.invitations) if (i.created_by === userId && !i.used && db.players.some((p) => p.id === i.player_id && p.team_id === teamId)) i.expires_at = 0
      const x = transfers.get(teamId)
      if (x && (x.from === userId || x.to === userId)) transfers.delete(teamId)
      return { status: 'suspended' }
    },
    async resumeMember(teamId, userId) {
      must(isOwnerOf(teamId))
      must(memberRow(teamId, userId), 'member_not_found')
      suspended.delete(`${teamId}:${userId}`)
      return { status: 'active' }
    },
    async mySuspendedMemberships() {
      return [...suspended.entries()].filter(([k]) => k.endsWith(`:${uid()}`))
        .map(([k, at]) => ({ team_id: k.slice(0, k.indexOf(':')), suspended_at: at, team_name: teamName(k.slice(0, k.indexOf(':'))) }))
    },
    async suspendedLeavePreview(teamId) {
      must(memberRow(teamId) && suspended.has(`${teamId}:${uid()}`), 'not_suspended')
      const state = cleanupState(teamId)
      const links = db.players.filter((p) => p.team_id === teamId && p.self_user_id !== uid() && isGuardian(p.id) && guardiansOf(p.id).some((g) => g.user_id !== uid())).length
      return { ...state, links_removed_count: links }
    },
    async leaveSuspendedTeam(teamId, fingerprint, confirm) {
      must(memberRow(teamId), 'not_member')
      must(suspended.has(`${teamId}:${uid()}`), 'not_suspended')
      must(confirm === LEAVE_CLEANUP_CONFIRM, 'confirm_required')
      const state = cleanupState(teamId)
      must(state.fingerprint === fingerprint, 'leave_confirmation_stale')
      const proxy = state.deletions.filter((p) => !p.is_self).map((p) => p.player_id)
      remove(db.invitations, (i) => proxy.includes(i.player_id))
      remove(db.attendance, (a) => proxy.includes(a.player_id))
      remove(db.guardians, (g) => proxy.includes(g.player_id))
      remove(db.players, (p) => proxy.includes(p.id))
      const list = blocks.get(teamId) ?? []
      if (!list.some((b) => b.user_id === uid())) list.push({ user_id: uid(), blocked_at: new Date().toISOString() })
      blocks.set(teamId, list)
      const r = detach(teamId, uid())
      suspended.delete(`${teamId}:${uid()}`)
      return { ...r, status: 'left', proxy_registrations_deleted: proxy.length, answers_deleted: state.deletions.reduce((n, p) => n + p.answers, 0) }
    },
    async listMembers(teamId) {
      must(member(teamId))
      return clone(db.members.filter((m) => m.team_id === teamId).map((m) => ({
        user_id: m.user_id, role: m.role, display_name: m.display_name, suspended_at: suspended.get(`${teamId}:${m.user_id}`) ?? null,
        joined_at: joinedAt.get(`${teamId}:${m.user_id}`) ?? new Date(Date.now() - 30 * 86_400_000).toISOString(),
      })))
    },
    async removalPreview(teamId, userId) {
      must(isOwnerOf(teamId))
      const m = db.members.find((x) => x.team_id === teamId && x.user_id === userId)
      must(m && m.role !== 'owner', 'member_not_found')
      return clone(impact(teamId, userId))
    },
    async removeMember(teamId, userId) {
      must(isOwnerOf(teamId))
      const m = db.members.find((x) => x.team_id === teamId && x.user_id === userId)
      must(m, 'member_not_found')
      must(m!.role !== 'owner' && userId !== uid(), 'cannot_remove_owner')
      must(!impact(teamId, userId).sole_guardian_children.length, 'sole_guardian_children')
      must(!db.players.some((p) => p.team_id === teamId && p.self_user_id === userId), 'member_data_confirmation_required') // D6-B1
      const r = detach(teamId, userId)
      suspended.delete(`${teamId}:${userId}`)
      const list = blocks.get(teamId) ?? []
      if (!list.some((b) => b.user_id === userId)) list.push({ user_id: userId, blocked_at: new Date().toISOString() })
      blocks.set(teamId, list)
      return { ...r, status: 'removed' }
    },
    async leavePreview(teamId) {
      const m = member(teamId)
      must(m, 'not_member')
      return clone({ ...impact(teamId, uid()), is_owner: m!.role === 'owner' })
    },
    async leaveTeam(teamId) {
      const m = member(teamId)
      must(m, 'not_member')
      must(m!.role !== 'owner', 'owner_cannot_leave')
      return { ...detach(teamId, uid()), status: 'left' }
    },
    async leaveCleanupPreview(teamId) {
      must(member(teamId), 'not_member')
      return clone({ ...impact(teamId, uid()), is_owner: isOwnerOf(teamId), cleanup: cleanupState(teamId) })
    },
    async leaveTeamWithCleanup(teamId, fingerprint, confirm) {
      must(member(teamId), 'not_member')
      must(!isOwnerOf(teamId), 'owner_cannot_leave')
      must(confirm === LEAVE_CLEANUP_CONFIRM, 'confirm_required')
      const state = cleanupState(teamId)
      const pv = impact(teamId, uid())
      must(state.fingerprint === fingerprint && pv.sole_guardian_children.length, 'leave_confirmation_stale')
      must(pv.sole_guardian_children.every((p) => state.deletions.some((d) => d.player_id === p.player_id)))
      const proxy = state.deletions.filter((p) => !p.is_self).map((p) => p.player_id)
      remove(db.invitations, (i) => proxy.includes(i.player_id))
      remove(db.attendance, (a) => proxy.includes(a.player_id))
      remove(db.guardians, (g) => proxy.includes(g.player_id))
      remove(db.players, (p) => proxy.includes(p.id))
      return { ...detach(teamId, uid()), status: 'left', proxy_registrations_deleted: proxy.length, answers_deleted: state.deletions.reduce((n, p) => n + p.answers, 0) }
    },
    async blockedMembers(teamId) {
      must(isOwnerOf(teamId))
      return clone(blocks.get(teamId) ?? [])
    },
    async unblockMember(teamId, userId) {
      must(isOwnerOf(teamId))
      const list = blocks.get(teamId) ?? []
      const had = list.some((b) => b.user_id === userId)
      blocks.set(teamId, list.filter((b) => b.user_id !== userId))
      return had
    },
    async deleteTeam(teamId, confirmName) {
      const t = db.teams.find((x) => x.id === teamId)
      must(t && isOwnerOf(teamId))
      must(!others(teamId).length, 'team_has_members')
      must(confirmName.trim() === t!.name, 'confirm_mismatch')
      const players = db.players.filter((p) => p.team_id === teamId).map((p) => p.id)
      remove(db.attendance, (a) => players.includes(a.player_id))
      remove(db.guardians, (g) => players.includes(g.player_id))
      remove(db.players, (p) => p.team_id === teamId)
      remove(db.events, (e) => e.team_id === teamId)
      remove(db.members, (m) => m.team_id === teamId)
      remove(db.teams, (x) => x.id === teamId)
      db.joinTokens.delete(teamId)
      blocks.delete(teamId)
      transfers.delete(teamId)
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
        selfSupported: true,
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
    async registerSelf(teamId) {
      const me = member(teamId)
      must(me)
      notPending()
      const found = db.players.find((p) => p.team_id === teamId && p.self_user_id === uid())
      if (found && !archivedPlayers.has(found.id)) return { status: 'existing', player_id: found.id }
      if (found) {
        archivedPlayers.delete(found.id)
        return { status: 'restored', player_id: found.id }
      }
      const p: Player = { id: rid(), team_id: teamId, name: me!.display_name, note: null, is_self: true, self_user_id: uid() }
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
      must(!p!.self_user_id || p!.self_user_id === uid())
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
      must(!livePlayer(playerId)!.self_user_id || livePlayer(playerId)!.self_user_id === uid())
      archivedPlayers.add(playerId)
    },
    async createInvitation(playerId) {
      must(isGuardian(playerId))
      must(!livePlayer(playerId)?.self_user_id || livePlayer(playerId)!.self_user_id === uid())
      must(livePlayer(playerId), 'not_found')
      const token = rid() + rid() + rid()
      const created_at = Date.now()
      const expires_at = created_at + 24 * 3600_000
      db.invitations.push({ id: rid(), token, player_id: playerId, created_by: uid(), created_at, expires_at, used: false })
      return { token, expires_at: new Date(expires_at).toISOString() }
    },
    async acceptInvitation(token, displayName) {
      notPending()
      const inv = db.invitations.find((i) => i.token === token)
      must(inv, 'invitation_invalid')
      const p = livePlayer(inv!.player_id)
      must(p, 'invitation_invalid')
      const t = db.teams.find((x) => x.id === p!.team_id)!
      must(!(blocks.get(t.id) ?? []).some((b) => b.user_id === uid()), 'blocked_from_team')
      const result = { player_id: p!.id, player_name: p!.name, team_id: t.id, share_token: t.share_token }
      // Already a guardian: normal result, and the invitation is NOT consumed.
      if (isGuardian(p!.id)) return { status: 'already_guardian', ...result }
      must(usable(inv!), 'invitation_invalid')
      // Same rules as the database: only a NEW member needs a (trimmed, 1-40 character) name.
      const isNew = !memberRow(t.id)
      const name = (displayName ?? '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
      if (isNew) {
        must(name, 'name_required')
        must(name.length <= 40, 'display_name_too_long')
      }
      inv!.used = true
      inv!.used_at = Date.now()
      if (isNew) db.members.push({ team_id: t.id, user_id: uid(), role: 'member', display_name: name })
      db.guardians.push({ player_id: p!.id, user_id: uid(), added_via: 'invitation' })
      return { status: 'accepted', ...result }
    },

    async previewInvitation(token) {
      const inv = db.invitations.find((i) => i.token === token)
      const p = inv && livePlayer(inv.player_id)
      if (!inv || !p) return { status: 'invalid' }
      const t = db.teams.find((x) => x.id === p.team_id)!
      if (suspended.has(`${t.id}:${uid()}`)) return { status: 'suspended' }
      if (isGuardian(p.id)) return { status: 'already_guardian', player_name: p.name, team_name: t.name, team_id: t.id }
      if (!usable(inv)) return { status: 'invalid' }
      const isMember = !!memberRow(t.id)
      return { status: 'valid', player_name: p.name, team_name: t.name, is_member: isMember, needs_display_name: !isMember,
        expires_at: new Date(inv.expires_at).toISOString() }
    },

    async serviceStats() {
      return { users: MOCK_USERS.length, teams: db.teams.length, answers: db.attendance.length, counted_at: new Date().toISOString() }
    },

    async listChildInvitations(playerId) {
      if (!isGuardian(playerId)) return []
      return db.invitations.filter((i) => i.player_id === playerId)
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        .map((i) => ({
          id: i.id ?? i.token.slice(0, 8), created_at: new Date(i.created_at ?? 0).toISOString(),
          expires_at: new Date(i.expires_at).toISOString(),
          used_at: i.used ? new Date(i.used_at ?? i.created_at ?? 0).toISOString() : null,
          revoked_at: i.revoked_at ? new Date(i.revoked_at).toISOString() : null,
        }))
    },

    async revokeInvitation(invitationId) {
      const inv = db.invitations.find((i) => i.id === invitationId)
      must(inv && isGuardian(inv.player_id))
      if (!inv!.used && !inv!.revoked_at) inv!.revoked_at = Date.now()
    },

    async onboardingFacts(teamId, myPlayerIds) {
      const me = member(teamId)
      return {
        memberCount: db.members.filter((m) => m.team_id === teamId).length,
        eventCount: db.events.filter((e) => e.team_id === teamId && !deletedEvents.has(e.id)).length,
        myAnswerCount: db.attendance.filter((a) => myPlayerIds.includes(a.player_id)).length,
        sharedPlayerIds: myPlayerIds.filter((id) => guardiansOf(id).length > 1),
        joinedAt: me ? (joinedAt.get(`${teamId}:${uid()}`) ?? new Date(Date.now() - 30 * 86_400_000).toISOString()) : null,
      }
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
