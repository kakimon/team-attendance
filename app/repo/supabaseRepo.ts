// Real data access via Supabase. Reads = table SELECT (filtered by RLS).
// Writes = RPC only (SECURITY DEFINER functions with explicit checks).
import {
  ERROR_CODES, RepoError,
  type AcceptResult, type Attendance, type Member, type Player, type Repo, type Role, type Team, type TeamEvent,
} from '../utils/types'

type DbError = { message: string } | null
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

function codeOf(message: string) {
  return ERROR_CODES.find((c) => message === c || message.includes(c)) ?? 'unknown'
}
function unwrap<T>(r: Res): T {
  if (r.error) throw new RepoError(codeOf(r.error.message), r.error.message)
  return r.data as T
}

/** Show events from this long ago (so "today" stays visible). */
const PAST_MS = 24 * 3600_000

export function createSupabaseRepo(db: DbClient, uid: () => string): Repo {
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

    async teamPreview(shareToken) {
      const rows = unwrap<any[]>(await db.rpc('get_team_by_share_token', { p_share_token: shareToken }))
      return rows[0] ?? null
    },

    async joinTeam(shareToken, displayName) {
      return unwrap<string>(await db.rpc('join_team', { p_share_token: shareToken, p_display_name: displayName }))
    },

    async loadTeam(teamId) {
      const since = new Date(Date.now() - PAST_MS).toISOString()
      const [teams, me, players, events, guardians] = await Promise.all([
        db.from('teams').select('id,name,share_token').eq('id', teamId),
        db.from('team_members').select('team_id,user_id,role,display_name').eq('team_id', teamId).eq('user_id', uid()),
        db.from('players').select('id,team_id,name,note').eq('team_id', teamId).is('archived_at', null).order('created_at'),
        db.from('events').select('id,team_id,title,starts_at,location,note').eq('team_id', teamId).gte('starts_at', since).order('starts_at'),
        db.from('player_guardians').select('player_id').eq('team_id', teamId).eq('user_id', uid()),
      ])
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
      }
    },

    async registerPlayer(teamId, name, note, confirmSimilar) {
      return unwrap(await db.rpc('register_player', {
        p_team_id: teamId, p_name: name, p_note: note, p_confirm_similar: confirmSimilar,
      }))
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
  }
}
