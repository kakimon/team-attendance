// Phase 5-C U5-C: member management screens (source checks), the data layer's request shapes,
// and the demo repo (same rules as the server).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_TEAM_ID, createMockRepo } from '../../app/repo/mockRepo'
import { createSupabaseRepo, type DbClient } from '../../app/repo/supabaseRepo'
import { ERROR_MESSAGE } from '../../app/utils/types'

const APP = join(import.meta.dirname, '../../app')
const read = (f: string) => readFileSync(join(APP, f), 'utf8')

describe('data layer: RPC names and arguments (as defined in the U4 migration)', () => {
  it('sends exactly the documented arguments', async () => {
    const calls: { fn: string; args?: Record<string, unknown> }[] = []
    const db = {
      from: () => { throw new Error('not used') },
      rpc: (fn: string, args?: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: fn === 'blocked_members' ? [] : {}, error: null }) },
    } as unknown as DbClient
    const repo = createSupabaseRepo(db, () => 'me')
    await repo.removalPreview('t', 'u')
    await repo.removeMember('t', 'u')
    await repo.leavePreview('t')
    await repo.leaveTeam('t')
    await repo.blockedMembers('t')
    await repo.unblockMember('t', 'u')
    await repo.deleteTeam('t', 'チーム')
    expect(calls).toEqual([
      { fn: 'removal_preview', args: { p_team_id: 't', p_user_id: 'u' } },
      { fn: 'remove_member', args: { p_team_id: 't', p_user_id: 'u' } },
      { fn: 'leave_preview', args: { p_team_id: 't' } },
      { fn: 'leave_team', args: { p_team_id: 't' } },
      { fn: 'blocked_members', args: { p_team_id: 't' } },
      { fn: 'unblock_member', args: { p_team_id: 't', p_user_id: 'u' } },
      { fn: 'delete_team', args: { p_team_id: 't', p_confirm_name: 'チーム' } },
    ])
  })

  it('every refusal of these RPCs has a Japanese message that says what to do', () => {
    for (const c of ['sole_guardian_children', 'cannot_remove_owner', 'member_not_found', 'owner_cannot_leave', 'not_member', 'team_has_members', 'confirm_mismatch'] as const) {
      expect(ERROR_MESSAGE[c], c).toMatch(/[ぁ-ん]/)
    }
    expect(ERROR_MESSAGE.sole_guardian_children).toContain('別の回答者を追加')
    expect(ERROR_MESSAGE.owner_cannot_leave).toContain('オーナーを交代')
  })
})

describe('demo repo', () => {
  it('owner removes (blocked), member leaves (not blocked), owner cannot leave, team deletion rules', async () => {
    let who = 'u-coach'
    const repo = createMockRepo(() => who, () => '')
    await expect(repo.removeMember(DEMO_TEAM_ID, 'u-coach')).rejects.toMatchObject({ code: 'cannot_remove_owner' })
    // u-sato is the only one answering for 佐藤 はるき -> refused
    expect((await repo.removalPreview(DEMO_TEAM_ID, 'u-sato')).sole_guardian_children.map((c) => c.name)).toEqual(['佐藤 はるき'])
    await expect(repo.removeMember(DEMO_TEAM_ID, 'u-sato')).rejects.toMatchObject({ code: 'sole_guardian_children' })
    // 田中 母 shares ゆうと with 田中 父 -> removable; blocked afterwards
    expect((await repo.removeMember(DEMO_TEAM_ID, 'u-tanaka-m')).status).toBe('removed')
    expect((await repo.blockedMembers(DEMO_TEAM_ID)).map((b) => b.user_id)).toEqual(['u-tanaka-m'])
    await expect(repo.leaveTeam(DEMO_TEAM_ID)).rejects.toMatchObject({ code: 'owner_cannot_leave' })
    await expect(repo.deleteTeam(DEMO_TEAM_ID, 'ひまわりジュニア（デモ）')).rejects.toMatchObject({ code: 'team_has_members' })
    who = 'u-tanaka-f'
    await expect(repo.removeMember(DEMO_TEAM_ID, 'u-sato')).rejects.toMatchObject({ code: 'forbidden' })
    expect((await repo.leavePreview(DEMO_TEAM_ID)).sole_guardian_children.map((c) => c.name)).toEqual(['田中 ゆうと', '田中 さくら'])
  })
})

describe('screens (source checks)', () => {
  const mm = read('components/MemberManagement.vue')
  const del = read('components/TeamDeleteCard.vue')
  const leave = read('components/LeaveTeamPanel.vue')
  const admin = read('pages/t/[token]/admin.vue')

  it('管理: member list for owner and admin; removal / block list / hand-over only for the owner', () => {
    expect(admin).toContain('<MemberManagement')
    expect(admin).toContain('v-if="!isAdminRole(snap)"')                      // members never reach this screen
    expect(mm).toContain(`v-if="isOwner && m.role !== 'owner'"`)               // no remove button for the owner row / non-owners
    expect(mm).toContain('v-if="isOwner && members"')
    expect(mm).toContain('repo.requestOwnerTransfer(teamId.value, pick.value)')
    expect(mm).toContain('repo.cancelOwnerTransfer(teamId.value)')
  })

  it('removal: preview first; confirm disabled while someone would be left without anybody to answer', () => {
    expect(mm).toContain('repo.removalPreview(teamId.value, m.user_id)')
    expect(mm).toContain(':confirm-disabled="!impact || impact.sole_guardian_children.length > 0"')
    expect(mm).toContain('if (busy.value) return')
    expect(read('components/ui/ConfirmDialog.vue')).toContain(':disabled="busy || confirmDisabled"')
  })

  it('impact view: self registration deleted even with proxies; shared ones stay; real resolutions only', () => {
    const v = read('components/MemberImpactView.vue')
    expect(v).toContain('本人登録は、代わりに回答できる家族などがいても削除されます')
    expect(v).toContain('［設定・家族招待］の［招待リンクを作成］')
    expect(v).toContain('登録を取り消しても、取り消し済みの登録として残るため、この状態は解消しません')
    expect(v).not.toMatch(/削除してください|運営者/)
  })

  it('leaving: preview, owner explanation, confirm, double-submit guard, back to the team list', () => {
    expect(leave).toContain('repo.leavePreview(s.team.id)')
    expect(leave).toContain('v-else-if="pv!.is_owner"')
    expect(leave).toContain('if (busy.value) return')
    expect(leave).toContain(`navigateTo({ path: '/', query: { notice: 'left' } }, { replace: true })`)
    expect(read('pages/t/[token]/children/index.vue')).toContain(`v-if="snap.me.role !== 'owner'"`)
  })

  it('team deletion: owner only, type the name, explains the slot and the 24-hour count', () => {
    expect(admin).toContain(`<TeamDeleteCard v-if="snap.me.role === 'owner'"`)
    expect(del).toContain('typed.value.trim() === props.snap.team.name')
    expect(del).toContain('if (busy.value) return')
    expect(del).toContain('24時間以内にチームを作成した回数は、削除しても減りません')
    expect(del).toContain(`navigateTo({ path: '/', query: { notice: 'team_deleted' } }, { replace: true })`)
  })
})
