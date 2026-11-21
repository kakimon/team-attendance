// 操作ガイドツアー（Phase 4-D 第 3 段階）：ステップの定義と、表示内容の決定（純粋関数）。
// ツアーは画面を案内するだけ：ボタンを押さない・保存しない・リンクや招待を作らない。
// 何を表示するかは、いまの画面のデータ（スナップショット）から毎回決める（保存値は信用しない）。
import type { Role, TeamSnapshot } from './types'
import { guideRoleOf, type GuideRole } from './onboarding'

export type TourKind = GuideRole // 'parent' | 'admin'
/** Screens the tour visits (always inside /t/<token>). */
export type TourPage = 'list' | 'table' | 'answer' | 'children' | 'admin'

/**
 * Elements a step may highlight (`data-guide="…"`). Allow-list: anything else is never highlighted.
 * `interactive`: the person may use it while highlighted (navigation only). Everything else is shown
 * but not clickable during the step, so nothing is saved by accident.
 * Never add: delete / leave / cancel registration / hand-over / create-invitation buttons.
 */
export const GUIDE_TARGETS = {
  'tab-children': { interactive: true },   // 回答する人 tab (bottom bar on phones, header on PC)
  'tab-admin': { interactive: true },      // 管理 tab
  'event-strip': { interactive: false },   // 出欠一覧: the row of event dates
  'attendance-table': { interactive: false }, // 出欠一覧: 一覧表
  'children-add': { interactive: true },   // 回答する人: 自分を登録する / 家族などを登録する (links to the forms)
  'children-list': { interactive: false }, // 回答する人: registered people
  'answer-first': { interactive: false },  // 出欠入力: buttons of the first child × first event
  'share-url': { interactive: false },     // 管理: 参加用URL
  'event-add': { interactive: false },     // 管理: 予定を追加 (the form; never filled by the tour)
  'admin-summary': { interactive: false }, // 管理: 予定と出欠集計
} as const
export type GuideTarget = keyof typeof GUIDE_TARGETS
export const isGuideTarget = (x: unknown): x is GuideTarget => typeof x === 'string' && Object.hasOwn(GUIDE_TARGETS, x)
/** Words of operations a tour must never point at (checked again on the live element). */
export const DANGER_WORDS = /削除|退会|取り消|取消|引き継|引継|招待リンクを作成|ログアウト|オーナーを交代/

export interface TourContext {
  role: Role
  teamName: string
  displayName: string
  childCount: number
  eventCount: number
}
export const tourContext = (s: TeamSnapshot): TourContext => ({
  role: s.me.role, teamName: s.team.name, displayName: s.me.display_name,
  childCount: s.myPlayerIds.length, eventCount: s.events.length,
})

/** What one step shows right now. target null = explanation only (centred, nothing highlighted). */
export interface TourView { page: TourPage; title: string; text: string; target: GuideTarget | null }
type StepDef = (c: TourContext) => TourView

const PARENT: StepDef[] = [
  (c) => ({
    page: 'list', target: null, title: 'チームに参加しています',
    text: `「${c.teamName}」に参加済みです。チーム内では「${c.displayName}」と表示されます。参加は、参加用URLを開いて表示名を入れるだけです。`,
  }),
  () => ({
    page: 'list', target: 'tab-children', title: '［回答する人］タブ',
    text: '出欠を回答する人（あなた自身や、お子さんなど）は、［回答する人］で登録・確認します。',
  }),
  (c) => (c.childCount === 0
    ? { page: 'children', target: 'children-add', title: '回答する人を登録する',
        text: 'あなた自身が参加するなら［自分を登録する］、お子さんなどの代わりに回答するなら［家族などを登録する］を押します。家族がすでに登録している場合は、登録せずに家族から招待を受け取ってください。' }
    : { page: 'children', target: 'children-list', title: '登録済みの回答する人',
        text: `回答する人は登録済みです（${c.childCount}人）。同じ人をもう一度登録する必要はありません。` }),
  (c) => (c.eventCount > 0
    ? { page: 'list', target: 'event-strip', title: '出欠一覧で予定を確認',
        text: '［出欠一覧］で予定を選ぶと、みんなの出欠が見られます。［一覧表］では全部の予定をまとめて確認できます。' }
    : { page: 'list', target: null, title: '出欠一覧で予定を確認',
        text: '予定はまだありません。管理者が予定を追加すると、［出欠一覧］に表示されます。' }),
  (c) => (c.childCount > 0 && c.eventCount > 0
    ? { page: 'answer', target: 'answer-first', title: '出欠を回答する',
        text: '［出欠入力］で、予定ごとに「出席」「欠席」「未定」のどれかを押します。押すとすぐに保存されます（ガイドの表示中は押せません）。' }
    : { page: 'answer', target: null, title: '出欠を回答する',
        text: c.childCount === 0
          ? '回答する人を登録すると、［出欠入力］で予定ごとに「出席」「欠席」「未定」を選べるようになります。'
          : '予定が追加されると、［出欠入力］で予定ごとに「出席」「欠席」「未定」を選べます。押すとすぐに保存されます。' }),
  () => ({
    page: 'answer', target: null, title: '回答はあとから変更できます',
    text: '別のボタンを押すと回答が変わります。選択中のボタンをもう一度押すと「未回答」に戻ります。「ひとこと」も書けます。',
  }),
  (c) => ({
    page: 'children', target: null, title: '家族で共有する',
    text: (c.childCount === 0 ? '回答する人を登録したあと、' : '')
      + '［回答する人］で人を選び、［設定・家族招待］の画面で［招待リンクを作成］を押して、家族だけに送ります。家族が同じ人を別に登録する必要はありません。（ガイドではリンクを作りません）',
  }),
]

const ADMIN: StepDef[] = [
  (c) => ({
    page: 'list', target: null, title: c.role === 'owner' ? 'あなたはチームのオーナーです' : 'あなたはチームの管理者です',
    text: (c.role === 'owner' ? 'チームを作った人がオーナー（管理者）になります。' : '')
      + '管理者は、メンバーの招待と予定の管理を担当します。管理者が保護者でなくても使えます。',
  }),
  () => ({
    page: 'list', target: 'tab-admin', title: 'チーム参加用URLの共有',
    text: 'チームに参加してもらうためのURLは［管理］タブにあります。LINE グループなどに貼って共有します。',
  }),
  () => ({
    page: 'admin', target: 'share-url', title: '参加用URL（招待リンク）',
    text: '［URLをコピー］で写して送ります。開いた人は表示名を入れてメンバーとして参加します。［URLを再発行］［受付を停止］もここにあります。（ガイドの表示中は押せません）',
  }),
  () => ({
    page: 'admin', target: 'event-add', title: '練習・試合の予定を追加',
    text: '「予定を追加」でタイトルと日付を入れて［追加する］を押します。ガイドは入力や追加をしません。',
  }),
  (c) => (c.eventCount > 0
    ? { page: 'admin', target: 'admin-summary', title: '出欠の集計', text: '「予定と出欠集計」で、予定ごとの出席・欠席・未定・未回答の人数が見られます。' }
    : { page: 'admin', target: null, title: '出欠の集計', text: '予定を追加すると、［管理］の「予定と出欠集計」に予定ごとの人数が表示されます。' }),
  (c) => (c.eventCount > 0
    ? { page: 'table', target: 'attendance-table', title: '一覧表で回答状況を確認', text: '［出欠一覧］の［一覧表］で、全員・全予定の回答状況をまとめて確認できます。' }
    : { page: 'list', target: null, title: '一覧表で回答状況を確認', text: '予定を追加すると、［出欠一覧］の［一覧表］で全員の回答状況をまとめて確認できます。' }),
  () => ({
    page: 'children', target: null, title: '回答する人の登録・変更は各自で',
    text: '回答する人（本人・お子さんなど）の登録と出欠の入力・変更は、各メンバーが［回答する人］［出欠入力］で行います。管理者でも、ほかの人が登録した人の名前や出欠は変更できません。',
  }),
  (c) => ({
    page: 'admin', target: null, title: 'オーナー交代について',
    text: (c.role === 'owner'
      ? 'オーナーの交代には相手の承認が必要です。依頼のしかたは［使い方］の「オーナー交代について」をご覧ください。'
      : 'オーナーの交代は、オーナーが相手の承認を得て行います（［使い方］の「オーナー交代について」）。')
      + '管理者を増やしたり役割を変えたりする画面は、現在ありません。',
  }),
]

const DEFS: Record<TourKind, StepDef[]> = { parent: PARENT, admin: ADMIN }
export const tourLength = (k: TourKind) => DEFS[k].length
export const validStep = (k: TourKind, i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < tourLength(k)
export function tourStep(k: TourKind, i: number, c: TourContext): TourView | null {
  return validStep(k, i) ? DEFS[k][i]!(c) : null
}
/** The admin tour is only for owners / admins (re-checked against the current role every time). */
export const canRunTour = (k: TourKind, role: Role) => k === 'parent' || guideRoleOf(role) === 'admin'

/** Where a page lives. */
export function pageLocation(token: string, p: TourPage): { path: string; query: Record<string, string> } {
  const base = `/t/${token}`
  switch (p) {
    case 'list': return { path: base, query: {} }
    case 'table': return { path: base, query: { view: 'table' } }
    case 'answer': return { path: `${base}/answer`, query: {} }
    case 'children': return { path: `${base}/children`, query: {} }
    case 'admin': return { path: `${base}/admin`, query: {} }
  }
}
/** Is the person on the step's screen? (trailing slash tolerated; 'table' also needs ?view=table) */
export function onPage(token: string, p: TourPage, path: string, query: Record<string, unknown>): boolean {
  const want = pageLocation(token, p)
  if (path.replace(/\/+$/, '') !== want.path) return false
  return p !== 'table' || query.view === 'table'
}

/** One candidate element, measured by the page (kept DOM-free so it can be tested). */
export interface TargetCandidate { visible: boolean; disabled: boolean; text: string }
/**
 * Pick the element to highlight among those with the same data-guide (e.g. the bottom tab on phones
 * and the header tab on PC): the first visible, enabled one whose text is not a dangerous operation.
 * -1 = none (the step becomes explanation only).
 */
export function chooseTarget(cands: TargetCandidate[]): number {
  return cands.findIndex((c) => c.visible && !c.disabled && !DANGER_WORDS.test(c.text))
}

/**
 * Offer the guide ("ガイドを見る / あとで") on the 出欠一覧? Never starts it.
 * - not while a guide is running, nor after it was finished / skipped (until /help)
 * - "あとで" -> offered again once the 3 days are over (continues from the saved step)
 * - for people the first-use help is for (same rule as stage 2: not for existing users),
 *   or an admin whose role changed on this device (this device knew them in the other role)
 */
export function tourOffer(o: {
  kind: TourKind
  tour: { status: string; step: number; snoozeUntil?: number } | undefined
  otherRecordExists: boolean
  showGuidance: boolean
  running: boolean
  now?: number
}): boolean {
  if (o.running) return false
  const t = o.tour
  if (t && t.status !== 'later') return false
  if (t?.status === 'later' && typeof t.snoozeUntil === 'number' && t.snoozeUntil > (o.now ?? Date.now())) return false
  return o.showGuidance || (o.kind === 'admin' && o.otherRecordExists)
}

/**
 * Where focus goes when the guide closes. Candidates in priority order:
 *  origin  = what had focus when the guide was shown on this screen (scroll is restored with it)
 *  last    = the element the guide was pointing at
 *  heading = a heading of this screen that is in view
 *  title   = the page title (always available; last resort)
 * Never something off screen while the page stays where it is (a later Tab would jump away).
 */
export interface FocusCandidate { kind: 'origin' | 'last' | 'heading' | 'title'; connected: boolean; inView: boolean }
export function chooseReturnFocus(c: FocusCandidate[]): number {
  const ok = (x: FocusCandidate) => x.connected && (x.kind === 'origin' || x.kind === 'title' || x.inView)
  for (const kind of ['origin', 'last', 'heading', 'title'] as const) {
    const i = c.findIndex((x) => x.kind === kind && ok(x))
    if (i >= 0) return i
  }
  return -1
}
