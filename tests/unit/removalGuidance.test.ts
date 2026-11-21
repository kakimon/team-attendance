// D6-B3 fix: a member with a self registration is always guided to access suspension (never told that
// adding a responder would make removal possible). Removal of members without one is unchanged.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_TEAM_ID, createMockRepo } from '../../app/repo/mockRepo'
import { removalRoute } from '../../app/utils/memberActions'
import type { MemberImpact } from '../../app/utils/types'

const APP = join(import.meta.dirname, '../../app')
const read = (f: string) => readFileSync(join(APP, f), 'utf8')
const impact = (o: Partial<MemberImpact> = {}): MemberImpact => ({ self_registrations: [], links_removed: [], sole_guardian_children: [], ...o })
const SELF = [{ player_id: 's', name: '本人', answers: 1 }]
const SOLE = [{ player_id: 'k', name: 'こども', cancelled: false }]

describe('removal route', () => {
  it('self registration -> suspension, with or without registrations only this person answers for', () => {
    expect(removalRoute(impact({ self_registrations: SELF }))).toBe('suspend')
    expect(removalRoute(impact({ self_registrations: SELF, sole_guardian_children: SOLE }))).toBe('suspend')
    expect(removalRoute(impact({ self_registrations: SELF, sole_guardian_children: [{ ...SOLE[0]!, cancelled: true }] }))).toBe('suspend')
  })
  it('no self registration: sole registrations block removal; otherwise removal stays available', () => {
    expect(removalRoute(impact({ sole_guardian_children: SOLE }))).toBe('blocked')
    expect(removalRoute(impact({ links_removed: [{ player_id: 'x', name: '共有' }] }))).toBe('remove')
    expect(removalRoute(impact())).toBe('remove')
  })
})

describe('screens', () => {
  it('the removal dialog switches to the suspension dialog whenever there is a self registration', () => {
    const mm = read('components/MemberManagement.vue')
    expect(mm).toContain("if (removalRoute(result) === 'suspend') {")
    expect(mm).toContain('openSuspend(m, true)')
    expect(mm).toContain("e.code === 'member_data_confirmation_required'")
    expect(mm).not.toContain('result.self_registrations.length && !result.sole_guardian_children.length')
  })
  it('the "add a responder and removal becomes possible" text is never shown when a self registration exists', () => {
    const v = read('components/MemberImpactView.vue')
    const i = v.indexOf('除外できるようになります')
    expect(i).toBeGreaterThan(0)
    expect(v.slice(v.lastIndexOf('<p', i), i)).toContain('v-else-if="!impact.self_registrations.length"')
  })
})

describe('demo repo: existing removal / suspension unchanged', () => {
  it('a member without a self registration can still be removed; with one, removal is refused and suspension works', async () => {
    let who = 'u-tanaka-f'
    const repo = createMockRepo(() => who, () => '')
    await repo.registerSelf(DEMO_TEAM_ID)                                                // 田中 父: self + sole child さくら
    who = 'u-coach'
    const pv = await repo.removalPreview(DEMO_TEAM_ID, 'u-tanaka-f')
    expect(removalRoute(pv)).toBe('suspend')
    await expect(repo.removeMember(DEMO_TEAM_ID, 'u-tanaka-f')).rejects.toMatchObject({ code: expect.stringMatching(/sole_guardian_children|member_data_confirmation_required/) })
    expect((await repo.suspendMember(DEMO_TEAM_ID, 'u-tanaka-f')).status).toBe('suspended')
    expect((await repo.resumeMember(DEMO_TEAM_ID, 'u-tanaka-f')).status).toBe('active')
    expect(removalRoute(await repo.removalPreview(DEMO_TEAM_ID, 'u-tanaka-m'))).toBe('remove')   // shares ゆうと only
    expect((await repo.removeMember(DEMO_TEAM_ID, 'u-tanaka-m')).status).toBe('removed')
  })
})
