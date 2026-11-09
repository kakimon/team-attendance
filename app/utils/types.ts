export type Role = 'owner' | 'admin' | 'member'
/** 'unanswered' is never stored: it means "no answer row". */
export type AnswerStatus = 'attend' | 'absent' | 'undecided'
export type Status = AnswerStatus | 'unanswered'

export interface Team { id: string; name: string; share_token: string }
export interface Member { team_id: string; user_id: string; role: Role; display_name: string }
export interface Player { id: string; team_id: string; name: string; note: string | null }
export interface Guardian { player_id: string; user_id: string; added_via: 'registrant' | 'invitation' }
export interface TeamEvent {
  id: string; team_id: string; title: string; starts_at: string
  location: string | null; note: string | null
}
export interface Attendance {
  event_id: string; player_id: string; status: AnswerStatus; comment: string | null; updated_at: string
}
export interface Summary { attend: number; absent: number; undecided: number; unanswered: number; total: number }

export const STATUS_LABEL: Record<Status, string> = {
  attend: '出席', absent: '欠席', undecided: '未定', unanswered: '未回答',
}
export const STATUS_MARK: Record<Status, string> = {
  attend: '○', absent: '×', undecided: '△', unanswered: '−',
}
export const STATUS_CLASS: Record<Status, string> = {
  attend: 'text-success', absent: 'text-error', undecided: 'text-warning', unanswered: 'text-base-content/30',
}

/** Everything a team page needs, loaded in one go. */
export interface TeamSnapshot {
  team: Team
  me: Member
  players: Player[]
  events: TeamEvent[]
  attendance: Attendance[]
  myPlayerIds: string[]
}

export interface TeamPreview { id: string; name: string; is_member: boolean; role: Role | null }

export type SimilarPlayer = Pick<Player, 'id' | 'name' | 'note'>
export type RegisterResult =
  | { status: 'similar_found'; similar: SimilarPlayer[] }
  | { status: 'created'; player_id: string }
export type UpdatePlayerResult =
  | { status: 'similar_found'; similar: SimilarPlayer[] }
  | { status: 'updated' }
export type EventInput = { title: string; starts_at: string; location: string | null; note: string | null }
/** 'already_guardian' is a normal result (the invitation is not consumed). */
export interface AcceptResult {
  status: 'accepted' | 'already_guardian'
  player_id: string
  player_name: string
  team_id: string
  share_token: string
}

/** Data access. Writes always go through server-side checked RPCs. */
export interface Repo {
  myTeams(): Promise<(Team & { role: Role })[]>
  createTeam(name: string, displayName: string): Promise<Team>
  teamPreview(shareToken: string): Promise<TeamPreview | null>
  joinTeam(shareToken: string, displayName: string): Promise<string>
  loadTeam(teamId: string): Promise<TeamSnapshot | null>
  registerPlayer(teamId: string, name: string, note: string | null, confirmSimilar: boolean): Promise<RegisterResult>
  setAttendance(eventId: string, playerId: string, status: Status, comment: string | null): Promise<void>
  createEvent(teamId: string, ev: EventInput): Promise<void>
  /** Admin only. Answers are kept. */
  updateEvent(eventId: string, ev: EventInput): Promise<void>
  /** Admin only. Logical delete: hidden, answers kept in the DB. */
  deleteEvent(eventId: string): Promise<void>
  /** Guardians of the child only. */
  updatePlayer(playerId: string, name: string, note: string | null, confirmSimilar: boolean): Promise<UpdatePlayerResult>
  /** Guardians of the child only. Logical cancel (archived_at), history kept. */
  archivePlayer(playerId: string): Promise<void>
  createInvitation(playerId: string): Promise<{ token: string; expires_at: string }>
  acceptInvitation(token: string, displayName: string): Promise<AcceptResult>
}

export const ERROR_CODES = [
  'not_authenticated', 'forbidden', 'not_found', 'team_not_found', 'invitation_invalid',
  'already_guardian', 'too_many_active_invitations', 'name_required', 'invalid_status', 'invalid_role',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number] | 'unknown'

export class RepoError extends Error {
  constructor(public code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  not_authenticated: 'ログインが必要です。',
  forbidden: 'この操作の権限がありません。',
  not_found: '見つかりませんでした。',
  team_not_found: 'チームが見つかりません。共有URLを確認してください。',
  invitation_invalid: 'この招待リンクは使えません（期限切れ・使用済み・取り消し済み）。家族に新しいリンクを作ってもらってください。',
  already_guardian: 'すでにこのお子さんの保護者として登録されています。',
  too_many_active_invitations: '有効な招待リンクが多すぎます。しばらくしてからお試しください。',
  name_required: '名前を入力してください。',
  invalid_status: '出欠の値が正しくありません。',
  invalid_role: '権限の値が正しくありません。',
  unknown: 'エラーが発生しました。通信状況を確認して、もう一度お試しください。',
}

export function errorMessage(e: unknown): string {
  return e instanceof RepoError ? ERROR_MESSAGE[e.code] : ERROR_MESSAGE.unknown
}
