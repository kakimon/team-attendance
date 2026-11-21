// Phase 4-D stage 2: "つぎにやること", checklist and device-only storage (pure logic).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checklist, guidanceDecision, guideRoleOf, hasUsedTeam, nextStep, startOfToday, upcomingStatus, type OnboardingFacts } from '../../app/utils/onboarding'
import {
  SNOOZE_MS, dismissFamilyHint, familyHintDismissed, getTeamGuide, guideRevision, isHidden, isOptedIn, normaliseTeamGuide, showGuidanceAgain, updateTeamGuide,
} from '../../app/utils/guideStore'
import type { TeamSnapshot } from '../../app/utils/types'

const DAY = 86_400_000
const now = new Date('2026-11-15T12:00:00+09:00')
const today = startOfToday(now)
const iso = (ms: number) => new Date(ms).toISOString()
function snap(o: { role?: 'owner' | 'admin' | 'member'; mine?: string[]; events?: number[]; answered?: [number, string][] } = {}): TeamSnapshot {
  const events = (o.events ?? []).map((t, i) => ({ id: `e${i}`, team_id: 't', title: `予定${i}`, starts_at: iso(t), location: null, note: null }))
  const mine = o.mine ?? []
  return {
    team: { id: 't', name: 'T', share_token: 'tok' },
    me: { team_id: 't', user_id: 'u', role: o.role ?? 'member', display_name: 'me' },
    players: [...mine, 'other'].map((id) => ({ id, team_id: 't', name: id, note: null })),
    events, myPlayerIds: mine,
    attendance: (o.answered ?? []).map(([e, p]) => ({ event_id: `e${e}`, player_id: p, status: 'attend' as const, comment: null, updated_at: iso(today) })),
  }
}
const step = (s: TeamSnapshot, extra: { memberCount?: number | null; showGuidance?: boolean } = {}) => {
  const u = upcomingStatus(s, today)
  return nextStep({ role: s.me.role, myChildCount: s.myPlayerIds.length, upcomingEvents: u.upcomingEvents, unanswered: u.unanswered,
    memberCount: extra.memberCount === undefined ? 3 : extra.memberCount, showGuidance: extra.showGuidance ?? true })
}

describe('つぎにやること (parent)', () => {
  it('no child -> register (shown even to long-standing members, as before Phase 4-D)', () => {
    expect(step(snap({ events: [today + DAY] }), { showGuidance: false })).toEqual({ kind: 'child' })
  })
  it('future event unanswered -> answer, counted per child', () => {
    expect(step(snap({ mine: ['a', 'b'], events: [today + DAY] }))).toEqual({ kind: 'answer', count: 2 })
    expect(step(snap({ mine: ['a', 'b'], events: [today + DAY], answered: [[0, 'a']] }))).toEqual({ kind: 'answer', count: 1 })
  })
  it("today's event (earlier today) still counts", () => {
    expect(step(snap({ mine: ['a'], events: [today + 9 * 3600_000] }))).toEqual({ kind: 'answer', count: 1 })
  })
  it('past events only / everything answered / no events -> nothing', () => {
    expect(step(snap({ mine: ['a'], events: [today - 3600_000] }))).toBeNull()
    expect(step(snap({ mine: ['a'], events: [today + DAY], answered: [[0, 'a']] }))).toBeNull()
    expect(step(snap({ mine: ['a'] }))).toBeNull()
  })
  it('long-standing members get no new card (only the existing "register" prompt)', () => {
    expect(step(snap({ mine: ['a'], events: [today + DAY] }), { showGuidance: false })).toBeNull()
  })
})

describe('つぎにやること (owner / admin)', () => {
  it('alone in the team -> invite first, then events', () => {
    expect(step(snap({ role: 'owner' }), { memberCount: 1 })).toEqual({ kind: 'invite' })
    expect(step(snap({ role: 'owner' }), { memberCount: 2 })).toEqual({ kind: 'event' })
    expect(step(snap({ role: 'admin', events: [today - DAY] }), { memberCount: 2 })).toEqual({ kind: 'event' }) // past only
  })
  it('an admin who is not a parent is never asked to register a child', () => {
    expect(step(snap({ role: 'owner', events: [today + DAY] }), { memberCount: 5 })).toBeNull()
  })
  it('an admin who is also a parent gets the answer step after setup', () => {
    expect(step(snap({ role: 'owner', mine: ['a'], events: [today + DAY] }), { memberCount: 5 })).toEqual({ kind: 'answer', count: 1 })
  })
  it('while loading or after an error (member count unknown) nothing is guessed', () => {
    expect(step(snap({ role: 'owner' }), { memberCount: null })).toBeNull()
  })
  it('long-standing admins get nothing automatically', () => {
    expect(step(snap({ role: 'owner' }), { memberCount: 1, showGuidance: false })).toBeNull()
  })
})

describe('first-use help: shown to people who have not used the team yet (no 14-day cut-off)', () => {
  const F = (o: Partial<OnboardingFacts> = {}): OnboardingFacts =>
    ({ memberCount: 1, eventCount: 0, myAnswerCount: 0, sharedPlayerIds: [], joinedAt: null, ...o })
  const d = (o: Partial<Parameters<typeof guidanceDecision>[0]> = {}) =>
    guidanceDecision({ facts: F(), role: 'parent', myChildCount: 0, intro: {}, optedIn: false, ...o })
  it('roles', () => {
    expect(guideRoleOf('owner')).toBe('admin')
    expect(guideRoleOf('admin')).toBe('admin')
    expect(guideRoleOf('member')).toBe('parent')
  })
  it('first time, even when the person joined long ago (> 14 days) but never used the team', () => {
    expect(d({ facts: F({ joinedAt: iso(now.getTime() - 60 * DAY), memberCount: 8, eventCount: 5 }) })).toEqual({ show: true, reason: 'first-time' })
    expect(d({ role: 'admin', facts: F({ joinedAt: iso(now.getTime() - 60 * DAY) }) })).toEqual({ show: true, reason: 'first-time' })
  })
  it('existing users (DB shows use) never get it automatically, on any device', () => {
    expect(d({ myChildCount: 1 })).toEqual({ show: false, reason: 'used' })
    expect(d({ facts: F({ myAnswerCount: 1 }) })).toEqual({ show: false, reason: 'used' })
    expect(d({ role: 'admin', facts: F({ eventCount: 1 }) })).toEqual({ show: false, reason: 'used' })
    expect(d({ role: 'admin', facts: F({ memberCount: 2 }) })).toEqual({ show: false, reason: 'used' })
    expect(hasUsedTeam('admin', F(), 3)).toBe(false) // an admin's own children do not count as admin use
  })
  it('started here: keeps going while the person makes progress', () => {
    expect(d({ myChildCount: 1, intro: { introStarted: true } })).toEqual({ show: true, reason: 'in-progress' })
  })
  it('finished or closed ("seen"): not repeated, even if still unused', () => {
    expect(d({ intro: { introStarted: true, introDone: true } })).toEqual({ show: false, reason: 'seen' })
    expect(d({ intro: { introDone: true }, optedIn: true })).toEqual({ show: false, reason: 'seen' })
  })
  it('turned on again from /help: shown even to existing users', () => {
    expect(d({ myChildCount: 2, optedIn: true })).toEqual({ show: true, reason: 'opted-in' })
  })
  it('facts not loaded (loading / error / other team): nothing is guessed', () => {
    expect(d({ facts: null })).toEqual({ show: false, reason: 'unknown' })
    expect(d({ facts: null, optedIn: true, intro: { introStarted: true } }).show).toBe(false)
  })
  it('new device / cleared storage = decided by the DB again (existing stays hidden, new is shown)', () => {
    expect(d({ intro: normaliseTeamGuide(null), myChildCount: 1 }).show).toBe(false)
    expect(d({ intro: normaliseTeamGuide(null) }).show).toBe(true)
  })
})

describe('checklist (decided by data; only 2 admin steps are device-only)', () => {
  const f = (o: Partial<OnboardingFacts> = {}): OnboardingFacts =>
    ({ memberCount: 1, eventCount: 0, myAnswerCount: 0, sharedPlayerIds: [], joinedAt: null, ...o })
  const done = (items: { done: boolean }[]) => `${items.filter((i) => i.done).length}/${items.length}`
  it('parent 1/3 -> 3/3 (joining is always done: being in the team means joined, so 0/3 cannot occur)', () => {
    expect(done(checklist('parent', f(), 0, {}, 'tok'))).toBe('1/3')
    expect(done(checklist('parent', f(), 1, {}, 'tok'))).toBe('2/3')     // registered, or became guardian by invitation
    expect(done(checklist('parent', f({ myAnswerCount: 1 }), 1, {}, 'tok'))).toBe('3/3')
  })
  it('admin 1/4 -> 4/4 (creating is always done for an owner/admin, so 0/4 cannot occur)', () => {
    expect(done(checklist('admin', f(), 0, {}, 'tok'))).toBe('1/4')
    expect(done(checklist('admin', f({ memberCount: 2 }), 0, {}, 'tok'))).toBe('2/4')        // someone joined = link shared
    expect(done(checklist('admin', f({ eventCount: 1 }), 0, { sharedLink: true }, 'tok'))).toBe('3/4')
    expect(done(checklist('admin', f({ memberCount: 3, eventCount: 2 }), 0, { viewedTable: true }, 'tok'))).toBe('4/4')
  })
  it('"出欠状況を確認する" needs the 一覧表 itself; the old 管理-page flag no longer counts', () => {
    const facts = f({ memberCount: 3, eventCount: 2 })
    const check = (flags: object) => checklist('admin', facts, 0, flags, 'tok').find((i) => i.id === 'check')!
    expect(check({}).done).toBe(false)
    expect(check(normaliseTeamGuide({ viewedSummary: true })).done).toBe(false)
    expect(check({ viewedTable: true }).done).toBe(true)
    expect(check({}).to).toBe('/t/tok?view=table')
  })
  it('items cannot be ticked by hand: no item depends on anything but data and app actions', () => {
    for (const i of [...checklist('parent', f(), 0, {}, 't'), ...checklist('admin', f(), 0, {}, 't')]) {
      expect(i).not.toHaveProperty('toggle')
      if (!i.done) expect(i.to).toMatch(/^\/t\/t[/?]/)
    }
  })
})

describe('device storage', () => {
  let mem: Map<string, string>
  beforeEach(() => {
    mem = new Map()
    ;(globalThis as { window?: unknown }).window = { localStorage: {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size },
    } }
  })
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  it('separated by user, team and role; keys hold ids only', () => {
    updateTeamGuide('u1', 'tA', 'admin', { sharedLink: true })
    expect(getTeamGuide('u1', 'tA', 'admin').sharedLink).toBe(true)
    expect(getTeamGuide('u1', 'tA', 'parent').sharedLink).toBeUndefined() // role changed (e.g. hand-over)
    expect(getTeamGuide('u1', 'tB', 'admin').sharedLink).toBeUndefined()  // other team
    expect(getTeamGuide('u2', 'tA', 'admin').sharedLink).toBeUndefined()  // other user on the same device
    for (const k of mem.keys()) expect(k).toMatch(/^minna:guide:v1:[\w-]+:[\w-]+(:(admin|parent))?$/)
  })
  it('"あとで" lasts across logins until it expires; "閉じる" until shown again', () => {
    const t0 = Date.now()
    updateTeamGuide('u1', 'tA', 'parent', { card: { snoozeUntil: t0 + SNOOZE_MS } })
    expect(isHidden(getTeamGuide('u1', 'tA', 'parent').card, t0 + 1000)).toBe(true)
    expect(isHidden(getTeamGuide('u1', 'tA', 'parent').card, t0 + SNOOZE_MS + 1)).toBe(false)
    updateTeamGuide('u1', 'tA', 'parent', { list: { dismissed: true } })
    expect(isHidden(getTeamGuide('u1', 'tA', 'parent').list)).toBe(true)
  })
  it('"もう一度表示" (from /help) clears only this user and turns guidance on', () => {
    updateTeamGuide('u1', 'tA', 'parent', { list: { dismissed: true }, sharedLink: true })
    updateTeamGuide('u2', 'tA', 'parent', { list: { dismissed: true } })
    dismissFamilyHint('u1')
    showGuidanceAgain('u1')
    expect(isHidden(getTeamGuide('u1', 'tA', 'parent').list)).toBe(false)
    expect(getTeamGuide('u1', 'tA', 'parent').sharedLink).toBe(true)    // progress is kept
    expect(isHidden(getTeamGuide('u2', 'tA', 'parent').list)).toBe(true)
    expect(isOptedIn('u1')).toBe(true)
    expect(isOptedIn('u2')).toBe(false)
    expect(familyHintDismissed('u1')).toBe(false)
  })
  it('cleared or broken storage = nothing saved, no crash', () => {
    expect(getTeamGuide('u1', 'tA', 'admin')).toEqual({})
    mem.set('minna:guide:v1:u1:tA:admin', '{broken')
    expect(getTeamGuide('u1', 'tA', 'admin')).toEqual({})
    ;(globalThis as { window?: unknown }).window = { get localStorage(): Storage { throw new Error('blocked') } }
    expect(() => updateTeamGuide('u1', 'tA', 'admin', { sharedLink: true })).not.toThrow()
    expect(isOptedIn('u1')).toBe(false)
  })
  it('records from before this change: viewedSummary / listExpanded ignored, shown-before = started', () => {
    mem.set('minna:guide:v1:u1:tA:admin', JSON.stringify({ viewedSummary: true, listExpanded: true, sharedLink: true }))
    expect(getTeamGuide('u1', 'tA', 'admin')).toEqual({ sharedLink: true, introStarted: true })
    mem.set('minna:guide:v1:u1:tB:parent', JSON.stringify({ card: { snoozeUntil: 5, junk: 1 }, list: 'x' }))
    expect(getTeamGuide('u1', 'tB', 'parent')).toEqual({ card: { snoozeUntil: 5 }, introStarted: true })
    for (const bad of ['[]', '"x"', '42', 'null']) {
      mem.set('minna:guide:v1:u1:tC:parent', bad)
      expect(getTeamGuide('u1', 'tC', 'parent')).toEqual({})
    }
  })
  it('"seen" is per user × team × role; /help clears it for this user only', () => {
    updateTeamGuide('u1', 'tA', 'parent', { introStarted: true, introDone: true })
    expect(getTeamGuide('u1', 'tA', 'admin').introDone).toBeUndefined()   // role change -> decided again
    expect(getTeamGuide('u1', 'tB', 'parent').introDone).toBeUndefined()  // other team
    updateTeamGuide('u2', 'tA', 'parent', { introDone: true })
    showGuidanceAgain('u1')
    expect(getTeamGuide('u1', 'tA', 'parent')).toEqual({ introStarted: true })
    expect(getTeamGuide('u2', 'tA', 'parent').introDone).toBe(true)
  })
  it('every write bumps the revision, so the panel re-reads it (一覧表 shown on the same page)', () => {
    const r = guideRevision.value
    updateTeamGuide('u1', 'tA', 'admin', { viewedTable: true })
    expect(guideRevision.value).toBe(r + 1)
  })
  it('stored values hold no names / e-mails / tokens: only booleans and times', () => {
    updateTeamGuide('u1', 'tA', 'admin', { sharedLink: true, viewedTable: true, introStarted: true, card: { snoozeUntil: 1 } })
    for (const v of mem.values()) expect(v).not.toMatch(/@|token|name/i)
  })
  it('no window (server-side rendering / static generation): no error', () => {
    delete (globalThis as { window?: unknown }).window
    expect(getTeamGuide('u1', 'tA', 'admin')).toEqual({})
    expect(() => showGuidanceAgain('u1')).not.toThrow()
  })
})
