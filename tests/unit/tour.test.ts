// Phase 4-D stage 3: guide tour (steps, targets, start / save rules). Pure logic + device storage.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DANGER_WORDS, GUIDE_TARGETS, canRunTour, chooseReturnFocus, chooseTarget, isGuideTarget, onPage, pageLocation, tourLength, tourOffer, tourStep, validStep,
  type TourContext, type TourKind,
} from '../../app/utils/tour'
import { SNOOZE_MS, getTeamGuide, setTour, showGuidanceAgain, startTour, updateTeamGuide } from '../../app/utils/guideStore'

const ctx = (o: Partial<TourContext> = {}): TourContext =>
  ({ role: 'member', teamName: 'T', displayName: '田中', childCount: 1, eventCount: 2, ...o })
const all = (k: TourKind, c: TourContext) => Array.from({ length: tourLength(k) }, (_, i) => tourStep(k, i, c)!)

describe('parent tour: 7 steps', () => {
  it('order and screens', () => {
    const s = all('parent', ctx())
    expect(s.map((x) => x.title)).toEqual([
      'チームに参加しています', '［回答する人］タブ', '登録済みの回答する人', '出欠一覧で予定を確認',
      '出欠を回答する', '回答はあとから変更できます', '家族で共有する',
    ])
    expect(s.map((x) => x.page)).toEqual(['list', 'list', 'children', 'list', 'answer', 'answer', 'children'])
    expect(s[0]!.text).toContain('参加済み')
  })
  it('no child: points at 子どもを登録する, never at the answer buttons', () => {
    const s = all('parent', ctx({ childCount: 0 }))
    expect(s[2]!.target).toBe('children-add')
    expect(s[4]!.target).toBeNull()
    expect(s.some((x) => x.target === 'answer-first')).toBe(false)
  })
  it('children already registered: no link to register again (no double registration)', () => {
    const s = all('parent', ctx({ childCount: 2 }))
    expect(s.some((x) => x.target === 'children-add')).toBe(false)
    expect(s[2]!.text).toContain('2人')
  })
  it('no events: explanation only for the event / answer steps', () => {
    const s = all('parent', ctx({ eventCount: 0 }))
    expect(s[3]!.target).toBeNull()
    expect(s[4]!.target).toBeNull()
  })
  it('family sharing is explained only (no invitation is created)', () => {
    expect(all('parent', ctx())[6]!.target).toBeNull()
    expect(all('parent', ctx())[6]!.text).toContain('［招待リンクを作成］')
  })
  it('uses the real button / screen names', () => {
    const text = all('parent', ctx()).map((x) => x.title + x.text).join()
    for (const w of ['回答する人', '出欠一覧', '出欠入力', '出席', '欠席', '未定', '一覧表', '設定・家族招待']) expect(text).toContain(w)
  })
})

describe('admin tour: 8 steps', () => {
  it('order and screens', () => {
    const s = all('admin', ctx({ role: 'owner' }))
    expect(s.map((x) => x.title)).toEqual([
      'あなたはチームのオーナーです', 'チーム参加用URLの共有', '参加用URL（招待リンク）', '練習・試合の予定を追加',
      '出欠の集計', '一覧表で回答状況を確認', '回答する人の登録・変更は各自で', 'オーナー交代について',
    ])
    expect(s.map((x) => x.target)).toEqual([null, 'tab-admin', 'share-url', 'event-add', 'admin-summary', 'attendance-table', null, null])
    expect(s[5]!.page).toBe('table')
  })
  it('an admin (not owner) is told who does the hand-over', () => {
    const s = all('admin', ctx({ role: 'admin' }))
    expect(s[0]!.title).toBe('あなたはチームの管理者です')
    expect(s[7]!.text).toContain('オーナーが')
  })
  it('no events: summary and table are explanation only', () => {
    const s = all('admin', ctx({ role: 'owner', eventCount: 0 }))
    expect(s[4]!.target).toBeNull()
    expect(s[5]!).toMatchObject({ target: null, page: 'list' })
  })
  it('no screens that do not exist; hand-over is explained only, no move to the leave page', () => {
    const s = all('admin', ctx({ role: 'owner' }))
    expect(s[7]!.page).toBe('admin')
    expect(s[7]!.target).toBeNull()
    expect(s[7]!.text).toContain('管理者を増やしたり役割を変えたりする画面は、現在ありません')
    const pages = new Set(s.map((x) => x.page))
    for (const p of pages) expect(['list', 'table', 'answer', 'children', 'admin']).toContain(p)
  })
  it('the admin tour runs only for owners / admins', () => {
    expect(canRunTour('admin', 'member')).toBe(false)
    expect(canRunTour('admin', 'owner')).toBe(true)
    expect(canRunTour('parent', 'owner')).toBe(true) // an admin who is also a parent
  })
})

describe('steps, screens and targets', () => {
  it('step range is checked (broken saved values do nothing)', () => {
    expect(validStep('parent', 6)).toBe(true)
    expect(validStep('parent', 7)).toBe(false)
    expect(validStep('admin', 7)).toBe(true)
    expect(validStep('admin', -1)).toBe(false)
    expect(validStep('admin', 1.5)).toBe(false)
    expect(tourStep('parent', 99, ctx())).toBeNull()
  })
  it('screens: always inside the team; ?view=table only for the table', () => {
    expect(pageLocation('tok', 'table')).toEqual({ path: '/t/tok', query: { view: 'table' } })
    expect(onPage('tok', 'list', '/t/tok/', {})).toBe(true)
    expect(onPage('tok', 'table', '/t/tok', {})).toBe(false)
    expect(onPage('tok', 'table', '/t/tok', { view: 'table' })).toBe(true)
    expect(onPage('tok', 'answer', '/t/other/answer', {})).toBe(false)
    expect(onPage('tok', 'children', '/t/tok/children/new', {})).toBe(false) // a form page is never a tour screen
  })
  it('PC and phone copies: the visible one is chosen; hidden / disabled / dangerous never', () => {
    const hiddenBottom = { visible: false, disabled: false, text: 'うちの子' }
    const header = { visible: true, disabled: false, text: 'うちの子' }
    expect(chooseTarget([hiddenBottom, header])).toBe(1)
    expect(chooseTarget([header, hiddenBottom])).toBe(0)
    expect(chooseTarget([{ visible: true, disabled: true, text: 'x' }])).toBe(-1)
    expect(chooseTarget([{ visible: true, disabled: false, text: 'この登録を取り消す' }])).toBe(-1)
    expect(chooseTarget([{ visible: true, disabled: false, text: 'アカウントを削除（退会）' }])).toBe(-1)
    expect(chooseTarget([])).toBe(-1)
  })
  it('every step target is on the allow-list, and the allow-list has no dangerous operation', () => {
    for (const k of ['parent', 'admin'] as const) {
      for (const c of [ctx(), ctx({ childCount: 0, eventCount: 0, role: 'owner' })]) {
        for (const s of all(k, c)) if (s.target) expect(isGuideTarget(s.target)).toBe(true)
      }
    }
    expect(isGuideTarget('delete-account')).toBe(false)
    for (const name of Object.keys(GUIDE_TARGETS)) expect(name).not.toMatch(/delete|leave|archive|cancel|transfer|invite|logout/i)
  })
})

describe('focus when the guide closes (final QA)', () => {
  const c = (kind: 'origin' | 'last' | 'heading' | 'title', connected = true, inView = true) => ({ kind, connected, inView })
  it('back to where the person was on this screen (scroll restored with it)', () => {
    expect(chooseReturnFocus([c('origin'), c('last'), c('title')])).toBe(0)
    expect(chooseReturnFocus([c('origin', true, false), c('last')])).toBe(0)
  })
  it('the button that started it is gone: the element the guide pointed at, if on screen', () => {
    expect(chooseReturnFocus([c('origin', false), c('last'), c('title', true, false)])).toBe(1)
  })
  it('never an element off screen while the page stays scrolled (the old behaviour jumped to the title)', () => {
    expect(chooseReturnFocus([c('last', true, false), c('heading', true, true), c('title', true, false)])).toBe(1)
    expect(chooseReturnFocus([c('last', false), c('heading', true, false), c('title', true, false)])).toBe(2) // last resort
  })
  it('nothing usable: no focus change', () => {
    expect(chooseReturnFocus([])).toBe(-1)
    expect(chooseReturnFocus([c('title', false)])).toBe(-1)
  })
})

describe('data-guide markers in the app (static check)', () => {
  const files: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.vue')) files.push(p)
    }
  }
  walk('app')
  // GuideTour.vue only reads markers (selector); bound markers are listed literally (guide: '…' / 'answer-first').
  const marks = files.filter((f) => !f.endsWith('GuideTour.vue')).flatMap((f) => {
    const src = readFileSync(f, 'utf8')
    return [...src.matchAll(/(?<!:)data-guide="([^"]+)"|guide: '([^']+)'|\? '(answer-first)'/g)].map((m) => ({ f, name: m[1] ?? m[2] ?? m[3]!, at: m.index! , src }))
  })
  it('only allow-listed names are used', () => {
    expect(marks.length).toBeGreaterThanOrEqual(10)
    for (const m of marks) expect(isGuideTarget(m.name), `${m.f}: ${m.name}`).toBe(true)
  })
  it('no marker on dangerous screens / buttons', () => {
    const banned = ['ChildSettings.vue', 'delete.vue', 'OwnerTransferInbox.vue', 'AccountMenu.vue', 'ConfirmDialog.vue', '[playerId].vue', 'new.vue']
    for (const m of marks) expect(banned.some((b) => m.f.endsWith(b)), m.f).toBe(false)
    for (const m of marks) {
      const line = m.src.slice(m.src.lastIndexOf('\n', m.at) + 1, m.src.indexOf('\n', m.at))
      expect(line, m.f).not.toMatch(DANGER_WORDS)
      expect(line).not.toMatch(/@click/) // markers never add or change click handlers
    }
  })
  it('every allow-listed name is placed somewhere', () => {
    for (const name of Object.keys(GUIDE_TARGETS)) expect(marks.some((m) => m.name === name), name).toBe(true)
  })
})

describe('offer ("ガイドを見る / あとで"): never starts by itself', () => {
  const base = { kind: 'parent' as const, tour: undefined, otherRecordExists: false, showGuidance: true, running: false, now: 1000 }
  it('first-time users get the offer; existing users do not', () => {
    expect(tourOffer(base)).toBe(true)
    expect(tourOffer({ ...base, showGuidance: false })).toBe(false)
  })
  it('done / skipped: not offered again; running: no offer', () => {
    expect(tourOffer({ ...base, tour: { status: 'done', step: 6 } })).toBe(false)
    expect(tourOffer({ ...base, tour: { status: 'skipped', step: 2 } })).toBe(false)
    expect(tourOffer({ ...base, running: true })).toBe(false)
    expect(tourOffer({ ...base, tour: { status: 'active', step: 2 } })).toBe(false)
  })
  it('"あとで" hides it for 3 days, then it is offered again', () => {
    const t = { status: 'later', step: 3, snoozeUntil: 1000 + SNOOZE_MS }
    expect(tourOffer({ ...base, tour: t, now: 2000 })).toBe(false)
    expect(tourOffer({ ...base, tour: t, now: 1000 + SNOOZE_MS + 1 })).toBe(true)
  })
  it('a member who became admin (known here in the other role) is offered the admin guide', () => {
    expect(tourOffer({ ...base, kind: 'admin', showGuidance: false, otherRecordExists: true })).toBe(true)
    expect(tourOffer({ ...base, kind: 'admin', showGuidance: false, otherRecordExists: false })).toBe(false)
    expect(tourOffer({ ...base, kind: 'parent', showGuidance: false, otherRecordExists: true })).toBe(false)
  })
})

describe('tour state on the device', () => {
  let mem: Map<string, string>
  beforeEach(() => {
    mem = new Map()
    ;(globalThis as { window?: unknown }).window = { localStorage: {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size },
    } }
  })
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  it('start = step 0, per user × team × role; starting one sets the other aside', () => {
    startTour('u1', 'tA', 'parent')
    expect(getTeamGuide('u1', 'tA', 'parent').tour).toEqual({ status: 'active', step: 0 })
    expect(getTeamGuide('u1', 'tB', 'parent').tour).toBeUndefined()
    expect(getTeamGuide('u2', 'tA', 'parent').tour).toBeUndefined()
    startTour('u1', 'tA', 'admin')
    expect(getTeamGuide('u1', 'tA', 'parent').tour?.status).toBe('skipped')
    expect(getTeamGuide('u1', 'tA', 'admin').tour).toEqual({ status: 'active', step: 0 })
  })
  it('/help restart always begins at step 0 (also after done / skipped / later)', () => {
    for (const status of ['done', 'skipped', 'later', 'active'] as const) {
      setTour('u1', 'tA', 'parent', { status, step: 5 })
      startTour('u1', 'tA', 'parent')
      expect(getTeamGuide('u1', 'tA', 'parent').tour).toEqual({ status: 'active', step: 0 })
    }
  })
  it('broken saved tour values are dropped (safe display)', () => {
    for (const bad of [{ status: 'x', step: 1 }, { status: 'active', step: -1 }, { status: 'active', step: 'a' }, { status: 'active' }, 'str', [1]]) {
      mem.set('minna:guide:v1:u1:tA:parent', JSON.stringify({ tour: bad, v: 2 }))
      expect(getTeamGuide('u1', 'tA', 'parent').tour).toBeUndefined()
    }
  })
  it('only ids, status, step and times are stored (no names, e-mails, tokens, invitations)', () => {
    startTour('u1', 'tA', 'admin')
    setTour('u1', 'tA', 'admin', { status: 'later', step: 3, snoozeUntil: 123 })
    for (const [k, v] of mem) {
      expect(k).toMatch(/^minna:guide:v1:[\w-]+:[\w-]+:(admin|parent)$/)
      expect(Object.keys(JSON.parse(v)).sort()).toEqual(['tour', 'v'])
    }
  })
  it('"もう一度表示する" (stage 2) still works and offers the guide again, but keeps a running one', () => {
    setTour('u1', 'tA', 'parent', { status: 'skipped', step: 2 })
    setTour('u1', 'tB', 'parent', { status: 'active', step: 4 })
    showGuidanceAgain('u1')
    expect(getTeamGuide('u1', 'tA', 'parent').tour).toBeUndefined()
    expect(getTeamGuide('u1', 'tB', 'parent').tour).toEqual({ status: 'active', step: 4 })
  })
  it('records written now are not mistaken for old ones (an existing admin copying the URL gets no help)', () => {
    updateTeamGuide('u1', 'tA', 'admin', { sharedLink: true })
    expect(getTeamGuide('u1', 'tA', 'admin').introStarted).toBeUndefined()
  })
  it('storage unavailable: no error, nothing running', () => {
    ;(globalThis as { window?: unknown }).window = { get localStorage(): Storage { throw new Error('blocked') } }
    expect(() => startTour('u1', 'tA', 'parent')).not.toThrow()
    expect(getTeamGuide('u1', 'tA', 'parent').tour).toBeUndefined()
    delete (globalThis as { window?: unknown }).window
    expect(() => setTour('u1', 'tA', 'parent', { status: 'done', step: 6 })).not.toThrow()
  })
})

describe('GuideTour component (static check: closing leaves nothing behind)', () => {
  const src = readFileSync('app/components/GuideTour.vue', 'utf8')
  it('removes its listeners and the driver.js layer when the screen is left', () => {
    for (const ev of ['focusin', 'submit', 'keyup']) expect(src).toContain(`document.removeEventListener('${ev}'`)
    for (const ev of ['scroll', 'resize']) expect(src).toContain(`window.removeEventListener('${ev}'`)
    expect(src).toMatch(/onBeforeUnmount\(\(\) => \{\s*run\+\+\s*quietDestroy\(\)/)
  })
  it('a temporary tabindex is removed again; pauses are announced through a live region', () => {
    expect(src).toContain("el.removeAttribute('tabindex')")
    expect(src).toContain('aria-live="polite"')
  })
  it('never clicks or submits anything in the page', () => {
    expect(src).not.toMatch(/\.click\(\)|requestSubmit|\.submit\(\)|dispatchEvent/)
  })
})
