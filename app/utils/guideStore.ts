// Per-device convenience state for the first-use help (dismissed / later / device-only progress).
// Keys contain only ids (user id, team id) and a role word: never e-mails or names.
// Browser only; every access is guarded so a blocked / cleared storage just means "nothing saved".
import { ref } from 'vue'
import type { DeviceFlags, GuideRole, IntroState } from './onboarding'

const PREFIX = 'minna:guide:v1'
const FORMAT = 2 // value format inside the v1 keys (2 = stage 3: no legacy inference)
/** Bumped on every write, so components showing the guide re-read it (e.g. 一覧表 viewed on the same page). */
export const guideRevision = ref(0)
export const SNOOZE_MS = 3 * 86_400_000

/** "閉じる" = dismissed until shown again from /help; "あとで" = hidden for SNOOZE_MS. */
export interface Hide { dismissed?: boolean; snoozeUntil?: number }
/**
 * Guide tour of this user × team × role (the record's role is the tour kind: parent / admin).
 * active = running (step = current step); later = "あとで" (offered again after snoozeUntil,
 * resumes at step); skipped = "スキップ" / "終了" (never resumed automatically); done = finished.
 * Starting again from /help always begins at step 0.
 */
export type TourStatus = 'active' | 'later' | 'skipped' | 'done'
export interface TourState { status: TourStatus; step: number; snoozeUntil?: number }
export interface TeamGuideState extends DeviceFlags, IntroState {
  card?: Hide
  list?: Hide
  tour?: TourState
}
const TOUR_STATUSES: TourStatus[] = ['active', 'later', 'skipped', 'done']
function normaliseTour(t: unknown): TourState | undefined {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return undefined
  const o = t as Record<string, unknown>
  if (!TOUR_STATUSES.includes(o.status as TourStatus) || !Number.isInteger(o.step) || (o.step as number) < 0 || (o.step as number) > 50) return undefined
  return { status: o.status as TourStatus, step: o.step as number, ...(typeof o.snoozeUntil === 'number' ? { snoozeUntil: o.snoozeUntil } : {}) }
}

/**
 * Compatibility with records written before 2026-11-15 (stage 2, 14-day rule):
 * - a record that already has help state means the help was shown here -> treat as started
 * - `viewedSummary` (set by merely opening 管理) and `listExpanded` are ignored
 */
export function normaliseTeamGuide(raw: Record<string, unknown> | null): TeamGuideState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const s: TeamGuideState = {}
  if (raw.sharedLink === true) s.sharedLink = true
  if (raw.viewedTable === true) s.viewedTable = true
  if (raw.introDone === true) s.introDone = true
  // Records written from now on carry v: 2; only older ones get the legacy inference.
  const legacySeen = raw.v !== FORMAT && ['card', 'list', 'sharedLink', 'viewedSummary', 'listExpanded'].some((k) => k in raw)
  if (raw.introStarted === true || (legacySeen && raw.introStarted === undefined && !s.introDone)) s.introStarted = true
  const tour = normaliseTour(raw.tour)
  if (tour) s.tour = tour
  for (const k of ['card', 'list'] as const) {
    const h = raw[k] as Hide | undefined
    if (h && typeof h === 'object') {
      s[k] = { ...(h.dismissed === true ? { dismissed: true } : {}), ...(typeof h.snoozeUntil === 'number' ? { snoozeUntil: h.snoozeUntil } : {}) }
    }
  }
  return s
}

const teamKey = (userId: string, teamId: string, role: GuideRole) => `${PREFIX}:${userId}:${teamId}:${role}`
const userKey = (userId: string, name: 'optin' | 'family-hint') => `${PREFIX}:${userId}:${name}`

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}
function readJson<T>(key: string): T | null {
  try { const v = storage()?.getItem(key); return v ? (JSON.parse(v) as T) : null } catch { return null }
}
function writeJson(key: string, v: unknown) {
  try { storage()?.setItem(key, JSON.stringify(v)) } catch { /* storage unavailable: ignore */ }
}

export function getTeamGuide(userId: string, teamId: string, role: GuideRole): TeamGuideState {
  return normaliseTeamGuide(readJson<Record<string, unknown>>(teamKey(userId, teamId, role)))
}
export function updateTeamGuide(userId: string, teamId: string, role: GuideRole, patch: Partial<TeamGuideState>) {
  writeJson(teamKey(userId, teamId, role), { ...getTeamGuide(userId, teamId, role), ...patch, v: FORMAT })
  guideRevision.value++
}
export function isHidden(h: Hide | undefined, now = Date.now()): boolean {
  return !!h?.dismissed || (typeof h?.snoozeUntil === 'number' && h.snoozeUntil > now)
}

/** The user asked (from /help) to see the first-use help again (also for teams already in use). */
export function isOptedIn(userId: string): boolean {
  return readJson<boolean>(userKey(userId, 'optin')) === true
}
export function familyHintDismissed(userId: string): boolean {
  return readJson<boolean>(userKey(userId, 'family-hint')) === true
}
export function dismissFamilyHint(userId: string) {
  writeJson(userKey(userId, 'family-hint'), true)
}

/** "案内をもう一度表示": opt in and clear every dismissal / later / "seen" of THIS user only (progress kept). */
export function showGuidanceAgain(userId: string) {
  const s = storage()
  if (!s) return
  try {
    const mine = `${PREFIX}:${userId}:`
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(mine)) keys.push(k) }
    for (const k of keys) {
      if (k.endsWith(':family-hint')) { s.removeItem(k); continue }
      if (k.endsWith(':optin')) continue
      const v = normaliseTeamGuide(readJson<Record<string, unknown>>(k))
      delete v.card
      delete v.list
      delete v.introDone
      if (v.tour && v.tour.status !== 'active') delete v.tour // offer the guide again
      writeJson(k, { ...v, v: FORMAT })
    }
    writeJson(userKey(userId, 'optin'), true)
  } catch { /* ignore */ }
}

/** Start a tour from step 0 (from the offer card or /help). Another running tour of this team is set aside. */
export function startTour(userId: string, teamId: string, kind: GuideRole) {
  const other: GuideRole = kind === 'parent' ? 'admin' : 'parent'
  const o = getTeamGuide(userId, teamId, other)
  if (o.tour?.status === 'active') updateTeamGuide(userId, teamId, other, { tour: { ...o.tour, status: 'skipped' } })
  updateTeamGuide(userId, teamId, kind, { tour: { status: 'active', step: 0 } })
}
export function setTour(userId: string, teamId: string, kind: GuideRole, tour: TourState) {
  updateTeamGuide(userId, teamId, kind, { tour })
}
