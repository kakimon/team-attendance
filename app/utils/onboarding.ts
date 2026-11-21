// First-use help after login: "つぎにやること" card and the setup checklist.
// Pure functions (no I/O) so every case can be tested. Never used for authorisation:
// what a user may do is always decided by the server (RLS / RPC).
import type { Role, TeamSnapshot } from './types'

export type GuideRole = 'parent' | 'admin'
export const guideRoleOf = (r: Role): GuideRole => (r === 'member' ? 'parent' : 'admin')

/** Read-only facts about the team that the snapshot does not carry. */
export interface OnboardingFacts {
  memberCount: number
  /** Live (not deleted) events of the team, any date. */
  eventCount: number
  /** Answers recorded for my children (any event still visible). */
  myAnswerCount: number
  /** My children that another guardian manages with me (family sharing in place). */
  sharedPlayerIds: string[]
  /** When I joined this team (ISO). */
  joinedAt: string | null
}

/**
 * DB evidence that this person has already used the team in this role (works on any device).
 * Parent (= member who answers): has someone to answer for (themself, a child, ... registered or shared
 * with them) or has answered. Admin: the team has an
 * event or other members. Such people are treated as existing users: no automatic help.
 */
export function hasUsedTeam(role: GuideRole, f: OnboardingFacts, myChildCount: number): boolean {
  return role === 'parent' ? myChildCount > 0 || f.myAnswerCount > 0 : f.eventCount > 0 || f.memberCount > 1
}

/** What this device remembers about the first-use help of one user × team × role. */
export interface IntroState { introStarted?: boolean; introDone?: boolean }
export type GuidanceReason = 'unknown' | 'seen' | 'opted-in' | 'in-progress' | 'used' | 'first-time'

/**
 * Show the first-use help automatically?
 *  1. facts not loaded (loading / error)  -> no (never guess)
 *  2. already finished or closed here      -> no ("seen")
 *  3. turned on again from /help           -> yes
 *  4. started on this device, not finished -> yes (keeps going while the person makes progress)
 *  5. DB shows the team was already used   -> no (existing user, any device)
 *  6. otherwise                            -> yes, first time (no matter how long ago they joined)
 */
export function guidanceDecision(o: { facts: OnboardingFacts | null; role: GuideRole; myChildCount: number; intro: IntroState; optedIn: boolean }): { show: boolean; reason: GuidanceReason } {
  if (!o.facts) return { show: false, reason: 'unknown' }
  if (o.intro.introDone) return { show: false, reason: 'seen' }
  if (o.optedIn) return { show: true, reason: 'opted-in' }
  if (o.intro.introStarted) return { show: true, reason: 'in-progress' }
  if (hasUsedTeam(o.role, o.facts, o.myChildCount)) return { show: false, reason: 'used' }
  return { show: true, reason: 'first-time' }
}

/** Start of "today" in the viewer's time zone. */
export function startOfToday(now = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Today-or-later events, and how many (event × my child) pairs are still unanswered. */
export function upcomingStatus(s: TeamSnapshot, todayStart: number) {
  const events = s.events.filter((e) => Date.parse(e.starts_at) >= todayStart)
  const mine = s.players.filter((p) => s.myPlayerIds.includes(p.id)).map((p) => p.id)
  let unanswered = 0
  for (const e of events) {
    for (const p of mine) if (!s.attendance.some((a) => a.event_id === e.id && a.player_id === p)) unanswered++
  }
  return { upcomingEvents: events.length, unanswered }
}

export type NextStep =
  | { kind: 'child' }
  | { kind: 'answer'; count: number }
  | { kind: 'invite' }
  | { kind: 'event' }

export interface NextStepInput {
  role: Role
  myChildCount: number
  upcomingEvents: number
  unanswered: number
  /** null while unknown (still loading / failed): never guess. */
  memberCount: number | null
  /** New member, or the user turned the help back on. */
  showGuidance: boolean
}

/** At most one step, in priority order; null = show nothing. */
export function nextStep(i: NextStepInput): NextStep | null {
  if (guideRoleOf(i.role) === 'parent') {
    // Same as before Phase 4-D: a member with nobody to answer for is always invited to register
    // (themself or a family member; wording in OnboardingPanel).
    if (i.myChildCount === 0) return { kind: 'child' }
    if (!i.showGuidance) return null
    return i.unanswered > 0 ? { kind: 'answer', count: i.unanswered } : null
  }
  // Owner / admin: never pushed to register a child (an admin is not always a parent).
  if (!i.showGuidance || i.memberCount === null) return null
  if (i.memberCount <= 1) return { kind: 'invite' }
  if (i.upcomingEvents === 0) return { kind: 'event' }
  if (i.myChildCount > 0 && i.unanswered > 0) return { kind: 'answer', count: i.unanswered }
  return null
}

export interface ChecklistItem { id: string; label: string; done: boolean; to: string | null; action: string | null }
/**
 * Things only this device can know (no DB trace). Convenience only.
 * viewedTable: the 一覧表 (attendance table) was actually shown with at least one event.
 * (The old `viewedSummary` was also set by merely opening 管理, so it is ignored.)
 */
export interface DeviceFlags { sharedLink?: boolean; viewedTable?: boolean }

export function checklist(role: GuideRole, f: OnboardingFacts, myChildCount: number, flags: DeviceFlags, token: string): ChecklistItem[] {
  if (role === 'parent') {
    return [
      { id: 'join', label: 'チームに参加する', done: true, to: null, action: null },
      { id: 'child', label: '回答する人を登録する（自分・家族など、または家族の招待を受け取る）', done: myChildCount > 0, to: `/t/${token}/children`, action: '登録する' },
      { id: 'answer', label: '出欠を 1 件以上回答する', done: f.myAnswerCount > 0, to: `/t/${token}/answer`, action: '回答する' },
    ]
  }
  return [
    { id: 'create', label: 'チームを作成する', done: true, to: null, action: null },
    { id: 'share', label: '招待リンクを共有する', done: f.memberCount > 1 || !!flags.sharedLink, to: `/t/${token}/admin`, action: 'リンクを開く' },
    { id: 'event', label: '予定を 1 件以上登録する', done: f.eventCount > 0, to: `/t/${token}/admin`, action: '登録する' },
    { id: 'check', label: '出欠状況を確認する（一覧表）', done: !!flags.viewedTable, to: `/t/${token}?view=table`, action: '一覧表を見る' },
  ]
}
