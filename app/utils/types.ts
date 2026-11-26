import type { OnboardingFacts } from './onboarding'

export type Role = 'owner' | 'admin' | 'member'
/** 'unanswered' is never stored: it means "no answer row". */
export type AnswerStatus = 'attend' | 'absent' | 'undecided'
export type Status = AnswerStatus | 'unanswered'

export interface Team { id: string; name: string; share_token: string }
export interface Member { team_id: string; user_id: string; role: Role; display_name: string }
/**
 * Someone whose attendance is answered: a child or family member registered by a guardian (proxy),
 * or the user themself (self registration, Phase 5-B D3.5: is_self / self_user_id set by the server).
 * The two self fields are missing on a database without D3.5 (treated as proxy registrations).
 */
export interface Player { id: string; team_id: string; name: string; note: string | null; is_self?: boolean; self_user_id?: string | null }
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
  /** The database supports self registration (register_self / players.is_self). False on an older DB. */
  selfSupported: boolean
}


/** Join link of a team (owners / admins only). token null = joining stopped. */
export interface JoinLink { open: boolean; token: string | null }
/** What a join link points to (nothing for an unknown, replaced or stopped link). */
export interface JoinPreview { team_id: string; name: string; is_member: boolean }
export type JoinResult = { status: 'joined' | 'already_member'; team_id: string } | { status: 'invalid' }

/** A member as listed for the team (team_members, visible to members of the team). */
/** suspended_at: access stopped by the owner (D6-B1); null / missing = active (also on an older DB). */
export interface TeamMember { user_id: string; role: Role; display_name: string; joined_at: string; suspended_at?: string | null }
/**
 * A team where MY access is stopped. Only the team's current name is given (D6-B3; missing on an older
 * DB), never schedules, members or tokens.
 */
export interface SuspendedMembership { team_id: string; suspended_at: string; team_name?: string | null }
/** What leaving a stopped team deletes (same cleanup state as D6-A) + how many shared ones stay. */
export type SuspendedLeavePreview = LeaveCleanup & { links_removed_count: number }
export type SuspendedLeaveResult = DetachResult & { status: 'left'; proxy_registrations_deleted: number; answers_deleted: number }
/**
 * What removing / leaving would do to one person's registrations in one team (private.member_impact):
 *  self_registrations: their own registration (本人登録) -> deleted with its answers, even with proxies
 *  links_removed: registrations someone else also answers for -> stay; only this person's link goes
 *  sole_guardian_children: registrations only this person answers for (incl. cancelled ones) -> the
 *    operation is refused (sole_guardian_children) until another person can answer for them
 */
export interface MemberImpact {
  self_registrations: { player_id: string; name: string; answers: number }[]
  links_removed: { player_id: string; name: string }[]
  sole_guardian_children: { player_id: string; name: string; cancelled: boolean }[]
}
export type LeavePreview = MemberImpact & { is_owner: boolean }
export interface LeaveCleanup {
  fingerprint: string
  deletions: { player_id: string; name: string; is_self: boolean; cancelled: boolean; answers: number }[]
}
export type LeaveCleanupPreview = LeavePreview & { cleanup: LeaveCleanup }
export const LEAVE_CLEANUP_CONFIRM = '登録と出欠を削除して脱退する'
export interface DetachResult { self_registrations_deleted: number; links_removed: number; invitations_deleted: number }
export interface BlockedMember { user_id: string; blocked_at: string }

export type SimilarPlayer = Pick<Player, 'id' | 'name' | 'note'>
export type RegisterResult =
  | { status: 'similar_found'; similar: SimilarPlayer[] }
  | { status: 'created'; player_id: string }
/** register_self: 'existing' = already registered (nothing created), 'restored' = a cancelled one came back. */
export interface RegisterSelfResult { status: 'created' | 'existing' | 'restored'; player_id: string }
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

/**
 * What a family invitation link would do for the signed-in person (read only, nothing consumed).
 * 'invalid' never says why (unknown, used, revoked, expired, cancelled registration).
 */
export type InvitationPreview =
  | { status: 'invalid' }
  | { status: 'suspended' }
  | { status: 'already_guardian'; player_name: string; team_name: string; team_id: string }
  | { status: 'valid'; player_name: string; team_name: string; is_member: boolean; needs_display_name: boolean; expires_at: string }

/**
 * Public usage numbers for the top page (public.service_stats, anon only, counts only).
 * answers = answers currently recorded (one per person and event); not a running total of every answer sent.
 */
export interface ServiceStats { users: number; teams: number; answers: number; counted_at: string }

/** A family invitation of one registration, as its guardians see it (never the token). */
export interface ChildInvitation {
  id: string
  created_at: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

/** What deleting the account would do (computed by the server for the caller only). */
export interface DeletionPreview {
  /** App data already removed, Auth deletion not finished (retry needed). */
  deletion_pending: boolean
  /** Seconds the last Google login still counts as recent (0 = log in again). */
  reauth_seconds_left: number
  teams_to_hand_over: {
    team_id: string; team_name: string
    candidates: { user_id: string; display_name: string; role: Role }[]
    pending: { to_user: string; to_name: string | null; expires_at: string } | null
  }[]
  teams_to_close: { team_id: string; team_name: string }[]
  teams_to_leave: { team_id: string; team_name: string; role: Role }[]
  children_to_delete: { player_id: string; name: string; team_name: string; answers: number }[]
  children_kept_by_family: { player_id: string; name: string; team_name: string }[]
}
export interface OwnerTransfers {
  incoming: { team_id: string; team_name: string; from_name: string | null; expires_at: string }[]
  outgoing: { team_id: string; team_name: string; to_user: string; to_name: string | null; expires_at: string }[]
}
export type TransferResponse = 'accepted' | 'declined' | 'expired' | 'stale'
export const DELETE_CONFIRM_TEXT = '退会する'

/** Data access. Writes always go through server-side checked RPCs. */
export interface Repo {
  myTeams(): Promise<(Team & { role: Role })[]>
  createTeam(name: string, displayName: string): Promise<Team>
  /** Old page address /t/<share_token>: the team id, for members only (never a way to join). */
  resolveLegacyTeam(shareToken: string): Promise<string | null>
  /** Owners / admins. */
  getJoinLink(teamId: string): Promise<JoinLink>
  /** Owners / admins: a new join link; the previous one stops working at once. */
  rotateJoinLink(teamId: string): Promise<JoinLink>
  /** Owners / admins: stop (the link stops working) or reopen (with a NEW link). */
  setJoinOpen(teamId: string, open: boolean): Promise<JoinLink>
  previewJoin(token: string): Promise<JoinPreview | null>
  /** Everyone in the team (members of the team only). */
  listMembers(teamId: string): Promise<TeamMember[]>
  /** Owner only. */
  removalPreview(teamId: string, userId: string): Promise<MemberImpact>
  /** Owner only. The person is removed and blocked from joining again. */
  removeMember(teamId: string, userId: string): Promise<DetachResult & { status: 'removed' }>
  leavePreview(teamId: string): Promise<LeavePreview>
  leaveCleanupPreview(teamId: string): Promise<LeaveCleanupPreview>
  /** Owner only: stop a member's access. Nothing is deleted (registrations, answers, links stay). */
  suspendMember(teamId: string, userId: string): Promise<{ status: 'suspended' }>
  /** Owner only: give the access back (as a plain member). */
  resumeMember(teamId: string, userId: string): Promise<{ status: 'active' }>
  /** Teams where my access is stopped (ids and dates only). */
  mySuspendedMemberships(): Promise<SuspendedMembership[]>
  /** Only for a stopped member, about their own registrations in that team. */
  suspendedLeavePreview(teamId: string): Promise<SuspendedLeavePreview>
  /** Only for a stopped member: deletes own / sole registrations with answers and leaves (no re-join). */
  leaveSuspendedTeam(teamId: string, fingerprint: string, confirm: string): Promise<SuspendedLeaveResult>
  leaveTeamWithCleanup(teamId: string, fingerprint: string, confirm: string): Promise<DetachResult & { status: 'left'; proxy_registrations_deleted: number; answers_deleted: number }>
  /** The caller leaves (not the owner). No block: they can join again with a join link. */
  leaveTeam(teamId: string): Promise<DetachResult & { status: 'left' }>
  /** Owner only: removed people who may not join again (ids and dates only). */
  blockedMembers(teamId: string): Promise<BlockedMember[]>
  /** Owner only. true = was blocked. */
  unblockMember(teamId: string, userId: string): Promise<boolean>
  /** Owner only, only when nobody else is a member; confirmName must be the team name. */
  deleteTeam(teamId: string, confirmName: string): Promise<void>
  joinByToken(token: string, displayName: string): Promise<JoinResult>
  loadTeam(teamId: string): Promise<TeamSnapshot | null>
  registerPlayer(teamId: string, name: string, note: string | null, confirmSimilar: boolean): Promise<RegisterResult>
  /** Registers the caller as an answering person (name = team display name). The server decides who. */
  registerSelf(teamId: string): Promise<RegisterSelfResult>
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
  /** Read only. null = this database has no preview yet (older schema): the page shows the old form. */
  previewInvitation(token: string): Promise<InvitationPreview | null>
  /** Logged-out top page: three public counts. null = this database has no service_stats yet. */
  serviceStats(): Promise<ServiceStats | null>
  /** Guardians of the registration only (RLS). Newest first. */
  listChildInvitations(playerId: string): Promise<ChildInvitation[]>
  /** Guardians only. Used / revoked invitations are left as they are (no error). */
  revokeInvitation(invitationId: string): Promise<void>
  deletionPreview(): Promise<DeletionPreview>
  myOwnerTransfers(): Promise<OwnerTransfers>
  /** Owner asks a member to take over; nothing changes until that member accepts. */
  requestOwnerTransfer(teamId: string, toUser: string): Promise<void>
  cancelOwnerTransfer(teamId: string): Promise<void>
  respondOwnerTransfer(teamId: string, accept: boolean): Promise<TransferResponse>
  /** Deletes the signed-in account (server identifies the user from the token). */
  deleteAccount(confirm: string): Promise<void>
  /** Read-only facts for the first-use help (existing tables, existing RLS; no writes). */
  onboardingFacts(teamId: string, myPlayerIds: string[]): Promise<OnboardingFacts>
}

export const ERROR_CODES = [
  'not_authenticated', 'forbidden', 'not_found', 'team_not_found', 'invitation_invalid',
  'already_guardian', 'too_many_active_invitations', 'name_required', 'invalid_status', 'invalid_role',
  'session_expired', 'owner_must_transfer', 'reauth_required', 'account_deletion_pending', 'transfer_not_found',
  'invalid_new_owner', 'auth_delete_failed', 'purge_failed', 'confirm_required',
  'feature_unavailable', 'guardian_child_limit_exceeded', 'team_child_limit_exceeded', 'invite_create_rate_limited',
  'team_event_limit_exceeded', 'event_create_rate_limited',
  'join_link_invalid', 'join_attempt_rate_limited', 'membership_limit_exceeded', 'team_member_limit_exceeded',
  'blocked_from_team', 'owner_quota_exceeded', 'team_create_rate_limited',
  'sole_guardian_children', 'cannot_remove_owner', 'member_not_found', 'owner_cannot_leave', 'not_member',
  'team_has_members', 'confirm_mismatch',
  'leave_confirmation_stale', 'member_data_confirmation_required', 'team_access_suspended', 'not_suspended',
  'display_name_too_long',
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
  already_guardian: 'すでにこの人の出欠を回答できるように登録されています。',
  too_many_active_invitations: 'この人の有効な家族招待リンクが上限（5件）に達しています。送信済みのリンクを受け取ってもらうか、有効期限（作成から24時間）が過ぎてからお試しください。',
  name_required: '名前を入力してください。',
  display_name_too_long: '名前は40文字以内で入力してください。',
  invalid_status: '出欠の値が正しくありません。',
  invalid_role: '権限の値が正しくありません。',
  session_expired: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  owner_must_transfer: 'オーナーのチームがあります。先にほかのメンバーへ引き継いでください。',
  reauth_required: '本人確認のため、もう一度 Google でログインしてください。',
  account_deletion_pending: '退会の手続きが途中です。「アカウント」から退会を完了してください。',
  transfer_not_found: 'この引き継ぎの依頼は、すでに取り消されたか、期限が切れています。',
  invalid_new_owner: '引き継ぎ先に選べないメンバーです。',
  auth_delete_failed: 'データの削除は完了しましたが、アカウントの削除が完了していません。もう一度お試しください。',
  purge_failed: '退会の処理に失敗しました（データは変更されていません）。もう一度お試しください。',
  confirm_required: '確認の文字を入力してください。',
  feature_unavailable: 'この機能は、まだこの環境では使えません。しばらくしてからお試しください。',
  guardian_child_limit_exceeded: 'このチームであなたが回答できる人数は20人までです（本人・家族などの合計）。不要な登録は［設定・家族招待］で取り消せますが、共有している家族も回答できなくなります。',
  team_child_limit_exceeded: 'このチームの回答する人が上限（500人）に達しています。管理者と相談し、回答できるメンバーに不要な登録を整理してもらってください。',
  invite_create_rate_limited: 'あなたが家族招待リンクを作れる回数は、全チーム合計で直近24時間に20回までです。使用済みのリンクも数えます。時間をおいてからお試しください。',
  team_event_limit_exceeded: 'このチームの予定が上限（過去の予定を含め2,000件）に達しています。［管理］で不要な予定を削除してからお試しください。',
  event_create_rate_limited: 'このチームで予定を作れる回数は、直近24時間に100回までです。予定を削除しても作成回数は減りません。時間をおいてからお試しください。',
  join_link_invalid: 'この参加用URLは使えません。再発行されたか、参加の受付が停止されています。チームの管理者に新しい参加用URLを確認してください。',
  join_attempt_rate_limited: '短い時間に参加の操作が続いたため、一時的に受け付けを止めています。1時間ほどおいてからお試しください。',
  membership_limit_exceeded: '参加できるチーム数の上限（所有チームを含め50チーム）に達しています。使っていないチームの［回答する人］から脱退の手続きができます。オーナーは先に交代が必要です。',
  team_member_limit_exceeded: 'このチームのメンバーが上限（300人）に達しています。チームのオーナーに、使っていないメンバーの整理を相談してください。',
  blocked_from_team: 'このチームには参加できません。再参加が拒否されているため、参加用URL・家族招待のどちらも使えません。チームのオーナーに確認してください。',
  owner_quota_exceeded: '所有できるチーム数の上限（3件）に達しています。チームの［管理］で削除するか、別のメンバーがオーナー交代を引き受けると所有枠が戻ります。',
  team_create_rate_limited: 'チームを作れる回数は、直近24時間に5回までです。削除しても作成回数は減りません。時間をおいてからお試しください。',
  sole_guardian_children: 'この人だけが出欠を回答できる登録があるため、操作できません。取り消していない登録は［設定・家族招待］から招待を受け取ってもらい、別の回答者を追加してください。登録を取り消しても解消しません。取り消し済みの場合は、現在の画面では解消できません。',
  cannot_remove_owner: 'オーナーはチームから除外できません。',
  member_not_found: 'このメンバーは、すでにチームにいません。画面を更新してください。',
  owner_cannot_leave: 'オーナーはチームから脱退できません。先にオーナーを交代するか、ほかにメンバーがいなければチームを削除してください。',
  not_member: 'このチームのメンバーではありません（すでに脱退している可能性があります）。',
  team_has_members: 'ほかのメンバーがいるチームは削除できません。先にメンバーに脱退してもらうか、除外してください。',
  confirm_mismatch: '入力したチーム名が一致しません。チーム名をそのまま入力してください。',
  leave_confirmation_stale: '確認後に登録・共有・出欠などの内容が変わりました。何も削除していません。最新の内容を確認し、もう一度選択してください。',
  member_data_confirmation_required: 'このメンバーには本人登録があるため、除外できません。代わりに「アクセス停止」を使ってください（登録は本人が確認して整理できます）。',
  team_access_suspended: 'このチームへのアクセスは、オーナーによって停止されています。',
  not_suspended: 'このチームへのアクセスは停止されていません（解除された可能性があります）。チーム一覧から開き直してください。',
  unknown: 'エラーが発生しました。通信状況を確認して、もう一度お試しください。',
}

export function errorMessage(e: unknown): string {
  return e instanceof RepoError ? ERROR_MESSAGE[e.code] : ERROR_MESSAGE.unknown
}
