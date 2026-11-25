// Real data access via Supabase. Reads = table SELECT (filtered by RLS).
// Writes = RPC only (SECURITY DEFINER functions with explicit checks).
import {
  ERROR_CODES, RepoError,
  type AcceptResult, type BlockedMember, type ChildInvitation, type InvitationPreview, type DetachResult, type JoinLink, type JoinPreview, type JoinResult,
  type LeavePreview, type LeaveCleanupPreview, type SuspendedLeavePreview, type SuspendedLeaveResult, type SuspendedMembership, type MemberImpact, type RegisterSelfResult, type TeamMember, type Attendance, type DeletionPreview, type Member, type OwnerTransfers, type Player, type Repo,
  type Role, type Team, type TeamEvent, type TransferResponse,
} from '../utils/types'

type DbError = { message: string; code?: string } | null
type Res = { data: any; error: DbError }

/** The subset of supabase-js we use (lets tests plug in a PGlite-backed fake). */
export interface DbQuery extends PromiseLike<Res> {
  select(cols: string): DbQuery
  eq(col: string, v: unknown): DbQuery
  is(col: string, v: null): DbQuery
  gte(col: string, v: unknown): DbQuery
  in(col: string, v: unknown[]): DbQuery
  order(col: string, o?: { ascending?: boolean }): DbQuery
}
export interface DbClient {
  from(table: string): DbQuery
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Res>
}

/** Error code in a DB/function message, matched as a whole word ('transfer_not_found' is not 'not_found'). */
export function codeOf(message: string) {
  return ERROR_CODES.find((c) => new RegExp(`(^|[^a-z_])${c}($|[^a-z_])`).test(message)) ?? 'unknown'
}
function unwrap<T>(r: Res): T {
  if (r.error) throw new RepoError(codeOf(r.error.message), r.error.message)
  return r.data as T
}

/** The database has no self-registration columns (Phase 5-B D3.5 not applied there yet). */
const missingSelfColumns = (m: string) => /(is_self|self_user_id)/.test(m) && /(does not exist|could not find|schema cache)/i.test(m)
/** The RPC does not exist on this database (PostgREST: "Could not find the function ..."). */
const missingFunction = (fn: string, m: string) => m.includes(fn) && /(could not find|not found|does not exist)/i.test(m)

/** Show events from this long ago (so "today" stays visible). */
const PAST_MS = 24 * 3600_000

/** Calls an Edge Function; `error.code` is the function's error code (or 'unknown'). */
export type InvokeFn = (fn: string, body: Record<string, unknown>) => Promise<{ error: { code: string } | null }>

export function createSupabaseRepo(db: DbClient, uid: () => string, invoke?: InvokeFn): Repo {
  return {
    async myTeams() {
      const mine = unwrap<{ team_id: string; role: Role }[]>(
        await db.from('team_members').select('team_id,role').eq('user_id', uid()))
      if (!mine.length) return []
      const teams = unwrap<Team[]>(await db.from('teams').select('id,name,share_token').order('created_at'))
      return teams.flatMap((t) => {
        const m = mine.find((x) => x.team_id === t.id)
        return m ? [{ ...t, role: m.role }] : []
      })
    },

    async createTeam(name, displayName) {
      const t = unwrap<Team>(await db.rpc('create_team', { p_name: name, p_display_name: displayName }))
      return { id: t.id, name: t.name, share_token: t.share_token }
    },

    async resolveLegacyTeam(shareToken) {
      const r = await db.rpc('resolve_legacy_team', { p_share_token: shareToken })
      if (r.error && missingFunction('resolve_legacy_team', r.error.message)) throw new RepoError('feature_unavailable', r.error.message)
      return unwrap<string | null>(r) ?? null
    },

    async getJoinLink(teamId) {
      const r = await db.rpc('get_join_link', { p_team_id: teamId })
      if (r.error && missingFunction('get_join_link', r.error.message)) throw new RepoError('feature_unavailable', r.error.message)
      return unwrap<JoinLink>(r)
    },

    async rotateJoinLink(teamId) {
      return unwrap<JoinLink>(await db.rpc('rotate_join_token', { p_team_id: teamId }))
    },

    async setJoinOpen(teamId, open) {
      return unwrap<JoinLink>(await db.rpc('set_join_open', { p_team_id: teamId, p_open: open }))
    },

    async previewJoin(token) {
      const r = await db.rpc('preview_join', { p_token: token })
      if (r.error && missingFunction('preview_join', r.error.message)) throw new RepoError('feature_unavailable', r.error.message)
      return unwrap<JoinPreview[]>(r)[0] ?? null
    },

    async joinByToken(token, displayName) {
      return unwrap<JoinResult>(await db.rpc('join_by_token', { p_token: token, p_display_name: displayName }))
    },

    async listMembers(teamId) {
      const withCols = (cols: string) => db.from('team_members').select(cols).eq('team_id', teamId).order('joined_at')
      const r = await withCols('user_id,role,display_name,joined_at,suspended_at')
      // Older database without access suspension (D6-B1): everybody is active.
      if (r.error && /suspended_at/.test(r.error.message)) return unwrap<TeamMember[]>(await withCols('user_id,role,display_name,joined_at'))
      return unwrap<TeamMember[]>(r)
    },

    async suspendMember(teamId, userId) {
      const r = await db.rpc('suspend_member', { p_team_id: teamId, p_user_id: userId })
      if (r.error && missingFunction('suspend_member', r.error.message)) throw new RepoError('feature_unavailable')
      return unwrap<{ status: 'suspended' }>(r)
    },

    async resumeMember(teamId, userId) {
      const r = await db.rpc('resume_member', { p_team_id: teamId, p_user_id: userId })
      if (r.error && missingFunction('resume_member', r.error.message)) throw new RepoError('feature_unavailable')
      return unwrap<{ status: 'active' }>(r)
    },

    async mySuspendedMemberships() {
      const r = await db.rpc('my_suspended_memberships')
      if (r.error && missingFunction('my_suspended_memberships', r.error.message)) return []   // older DB: nothing can be stopped
      return unwrap<SuspendedMembership[]>(r)
    },

    async suspendedLeavePreview(teamId) {
      const r = await db.rpc('suspended_leave_preview', { p_team_id: teamId })
      if (r.error && missingFunction('suspended_leave_preview', r.error.message)) throw new RepoError('feature_unavailable')
      return unwrap<SuspendedLeavePreview>(r)
    },

    async leaveSuspendedTeam(teamId, fingerprint, confirm) {
      const r = await db.rpc('leave_suspended_team', { p_team_id: teamId, p_fingerprint: fingerprint, p_confirm: confirm })
      if (r.error && missingFunction('leave_suspended_team', r.error.message)) throw new RepoError('feature_unavailable')
      return unwrap<SuspendedLeaveResult>(r)
    },

    async removalPreview(teamId, userId) {
      return unwrap<MemberImpact>(await db.rpc('removal_preview', { p_team_id: teamId, p_user_id: userId }))
    },

    async removeMember(teamId, userId) {
      return unwrap<DetachResult & { status: 'removed' }>(await db.rpc('remove_member', { p_team_id: teamId, p_user_id: userId }))
    },

    async leavePreview(teamId) {
      return unwrap<LeavePreview>(await db.rpc('leave_preview', { p_team_id: teamId }))
    },

    async leaveTeam(teamId) {
      return unwrap<DetachResult & { status: 'left' }>(await db.rpc('leave_team', { p_team_id: teamId }))
    },

    async leaveCleanupPreview(teamId) {
      const r = await db.rpc('leave_cleanup_preview', { p_team_id: teamId })
      if (r.error && missingFunction('leave_cleanup_preview', r.error.message)) throw new RepoError('feature_unavailable')
      return unwrap<LeaveCleanupPreview>(r)
    },

    async leaveTeamWithCleanup(teamId, fingerprint, confirm) {
      const r = await db.rpc('leave_team_with_cleanup', { p_team_id: teamId, p_fingerprint: fingerprint, p_confirm: confirm })
      if (r.error && missingFunction('leave_team_with_cleanup', r.error.message)) throw new RepoError('feature_unavailable')
      return unwrap<DetachResult & { status: 'left'; proxy_registrations_deleted: number; answers_deleted: number }>(r)
    },

    async blockedMembers(teamId) {
      return unwrap<BlockedMember[]>(await db.rpc('blocked_members', { p_team_id: teamId }))
    },

    async unblockMember(teamId, userId) {
      return unwrap<boolean>(await db.rpc('unblock_member', { p_team_id: teamId, p_user_id: userId }))
    },

    async deleteTeam(teamId, confirmName) {
      unwrap(await db.rpc('delete_team', { p_team_id: teamId, p_confirm_name: confirmName }))
    },

    async loadTeam(teamId) {
      const since = new Date(Date.now() - PAST_MS).toISOString()
      const playersWith = (cols: string) =>
        db.from('players').select(cols).eq('team_id', teamId).is('archived_at', null).order('created_at')
      const [teams, me, playersNew, events, guardians] = await Promise.all([
        db.from('teams').select('id,name,share_token').eq('id', teamId),
        db.from('team_members').select('team_id,user_id,role,display_name').eq('team_id', teamId).eq('user_id', uid()),
        playersWith('id,team_id,name,note,is_self,self_user_id'),
        db.from('events').select('id,team_id,title,starts_at,location,note').eq('team_id', teamId).gte('starts_at', since).order('starts_at'),
        db.from('player_guardians').select('player_id').eq('team_id', teamId).eq('user_id', uid()),
      ])
      // Older database without self registration: read the old columns and report it as unsupported.
      const selfSupported = !(playersNew.error && missingSelfColumns(playersNew.error.message))
      const players = selfSupported ? playersNew : await playersWith('id,team_id,name,note')
      const team = unwrap<Team[]>(teams)[0]
      const member = unwrap<Member[]>(me)[0]
      if (!team || !member) return null // not a member: RLS hides everything
      const evs = unwrap<TeamEvent[]>(events)
      const attendance = evs.length
        ? unwrap<Attendance[]>(await db.from('attendance')
          .select('event_id,player_id,status,comment,updated_at')
          .eq('team_id', teamId).in('event_id', evs.map((e) => e.id)))
        : []
      return {
        team,
        me: member,
        players: unwrap<Player[]>(players),
        events: evs,
        attendance,
        myPlayerIds: unwrap<{ player_id: string }[]>(guardians).map((g) => g.player_id),
        selfSupported,
      }
    },

    async registerPlayer(teamId, name, note, confirmSimilar) {
      return unwrap(await db.rpc('register_player', {
        p_team_id: teamId, p_name: name, p_note: note, p_confirm_similar: confirmSimilar,
      }))
    },

    async registerSelf(teamId) {
      // Only the team id is sent: who is registered (and the name) is decided by the server.
      const r = await db.rpc('register_self', { p_team_id: teamId })
      if (r.error && missingFunction('register_self', r.error.message)) throw new RepoError('feature_unavailable', r.error.message)
      return unwrap<RegisterSelfResult>(r)
    },

    async setAttendance(eventId, playerId, status, comment) {
      unwrap(await db.rpc('set_attendance', {
        p_event_id: eventId, p_player_id: playerId, p_status: status, p_comment: comment,
      }))
    },

    async createEvent(teamId, ev) {
      unwrap(await db.rpc('create_event', {
        p_team_id: teamId, p_title: ev.title, p_starts_at: ev.starts_at, p_location: ev.location, p_note: ev.note,
      }))
    },

    async updateEvent(eventId, ev) {
      unwrap(await db.rpc('update_event', {
        p_event_id: eventId, p_title: ev.title, p_starts_at: ev.starts_at, p_location: ev.location, p_note: ev.note,
      }))
    },

    async deleteEvent(eventId) {
      unwrap(await db.rpc('delete_event', { p_event_id: eventId }))
    },

    async updatePlayer(playerId, name, note, confirmSimilar) {
      return unwrap(await db.rpc('update_player', {
        p_player_id: playerId, p_name: name, p_note: note, p_confirm_similar: confirmSimilar,
      }))
    },

    async archivePlayer(playerId) {
      unwrap(await db.rpc('archive_player', { p_player_id: playerId }))
    },

    async createInvitation(playerId) {
      return unwrap(await db.rpc('create_guardian_invitation', { p_player_id: playerId }))
    },

    async acceptInvitation(token, displayName) {
      return unwrap<AcceptResult>(
        await db.rpc('accept_guardian_invitation', { p_token: token, p_display_name: displayName }))
    },

    async previewInvitation(token) {
      const r = await db.rpc('preview_guardian_invitation', { p_token: token })
      // Only a missing function means "older database"; auth / network / other errors are thrown as usual.
      if (r.error && (r.error.code === 'PGRST202' || missingFunction('preview_guardian_invitation', r.error.message))) return null
      return unwrap<InvitationPreview>(r)
    },

    async listChildInvitations(playerId) {
      // Only the state columns (token_hash is not readable by the app at all).
      return unwrap<ChildInvitation[]>(await db.from('guardian_invitations')
        .select('id,created_at,expires_at,used_at,revoked_at').eq('player_id', playerId).order('created_at', { ascending: false }))
    },

    async revokeInvitation(invitationId) {
      unwrap(await db.rpc('revoke_guardian_invitation', { p_invitation_id: invitationId }))
    },

    async deletionPreview() {
      return unwrap<DeletionPreview>(await db.rpc('account_deletion_preview'))
    },

    async myOwnerTransfers() {
      return unwrap<OwnerTransfers>(await db.rpc('my_owner_transfers'))
    },

    async requestOwnerTransfer(teamId, toUser) {
      unwrap(await db.rpc('request_owner_transfer', { p_team_id: teamId, p_to_user: toUser }))
    },

    async cancelOwnerTransfer(teamId) {
      unwrap(await db.rpc('cancel_owner_transfer', { p_team_id: teamId }))
    },

    async respondOwnerTransfer(teamId, accept) {
      return unwrap<{ status: TransferResponse }>(
        await db.rpc('respond_owner_transfer', { p_team_id: teamId, p_accept: accept })).status
    },

    async onboardingFacts(teamId, myPlayerIds) {
      const me = uid()
      const [members, events, answers, links, invitations] = await Promise.all([
        db.from('team_members').select('user_id,joined_at').eq('team_id', teamId),
        db.from('events').select('id').eq('team_id', teamId),
        myPlayerIds.length
          ? db.from('attendance').select('player_id').eq('team_id', teamId).in('player_id', myPlayerIds)
          : Promise.resolve({ data: [], error: null }),
        db.from('player_guardians').select('player_id,added_via').eq('team_id', teamId).eq('user_id', me),
        myPlayerIds.length
          ? db.from('guardian_invitations').select('player_id,used_at').eq('team_id', teamId).in('player_id', myPlayerIds)
          : Promise.resolve({ data: [], error: null }),
      ])
      const m = unwrap<{ user_id: string; joined_at: string }[]>(members)
      const shared = new Set<string>()
      // Shared = I joined this child through a family invitation, or one of its invitations was used.
      for (const l of unwrap<{ player_id: string; added_via: string }[]>(links)) if (l.added_via === 'invitation') shared.add(l.player_id)
      for (const i of unwrap<{ player_id: string; used_at: string | null }[]>(invitations)) if (i.used_at) shared.add(i.player_id)
      return {
        memberCount: m.length,
        eventCount: unwrap<unknown[]>(events).length,
        myAnswerCount: unwrap<unknown[]>(answers).length,
        sharedPlayerIds: [...shared].filter((id) => myPlayerIds.includes(id)),
        joinedAt: m.find((x) => x.user_id === me)?.joined_at ?? null,
      }
    },

    async deleteAccount(confirm) {
      if (!invoke) throw new RepoError('unknown', 'functions are not configured')
      // No user id is sent: the function identifies the user from the access token.
      const { error } = await invoke('delete-account', { confirm })
      if (error) throw new RepoError(codeOf(error.code), error.code)
    },
  }
}
