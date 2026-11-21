// D6-B2: owner suspend / resume UI and the stopped member's limited cleanup UI (source checks),
// the request shapes of the data layer, and the demo repo.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_TEAM_ID, createMockRepo } from '../../app/repo/mockRepo'
import { createSupabaseRepo, type DbClient } from '../../app/repo/supabaseRepo'
import { ERROR_MESSAGE, LEAVE_CLEANUP_CONFIRM } from '../../app/utils/types'

const APP = join(import.meta.dirname, '../../app')
const read = (f: string) => readFileSync(join(APP, f), 'utf8')

describe('data layer: RPC names and arguments (as defined in the D6-B1 migration)', () => {
  it('sends exactly the documented arguments', async () => {
    const calls: { fn: string; args?: Record<string, unknown> }[] = []
    const db = {
      from: () => { throw new Error('not used') },
      rpc: (fn: string, args?: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: fn === 'my_suspended_memberships' ? [] : {}, error: null }) },
    } as unknown as DbClient
    const repo = createSupabaseRepo(db, () => 'me')
    await repo.suspendMember('t', 'u')
    await repo.resumeMember('t', 'u')
    await repo.mySuspendedMemberships()
    await repo.suspendedLeavePreview('t')
    await repo.leaveSuspendedTeam('t', 'fp', LEAVE_CLEANUP_CONFIRM)
    expect(calls).toEqual([
      { fn: 'suspend_member', args: { p_team_id: 't', p_user_id: 'u' } },
      { fn: 'resume_member', args: { p_team_id: 't', p_user_id: 'u' } },
      { fn: 'my_suspended_memberships', args: undefined },
      { fn: 'suspended_leave_preview', args: { p_team_id: 't' } },
      { fn: 'leave_suspended_team', args: { p_team_id: 't', p_fingerprint: 'fp', p_confirm: '登録と出欠を削除して脱退する' } },
    ])
  })

  it('new refusals have Japanese messages', () => {
    expect(ERROR_MESSAGE.member_data_confirmation_required).toContain('アクセス停止')
    expect(ERROR_MESSAGE.team_access_suspended).toContain('停止されています')
    expect(ERROR_MESSAGE.not_suspended).toContain('停止されていません')
  })
})

describe('demo repo', () => {
  it('stop keeps data and hides the team; resume returns as a plain member; cleanup needs the fresh fingerprint', async () => {
    let who = 'u-coach'
    const repo = createMockRepo(() => who, () => '')
    await expect(repo.removeMember(DEMO_TEAM_ID, 'u-sato')).rejects.toMatchObject({ code: 'sole_guardian_children' })
    expect(await repo.suspendMember(DEMO_TEAM_ID, 'u-sato')).toEqual({ status: 'suspended' })
    expect((await repo.listMembers(DEMO_TEAM_ID)).find((m) => m.user_id === 'u-sato')!.suspended_at).toBeTruthy()
    who = 'u-sato'
    expect(await repo.loadTeam(DEMO_TEAM_ID)).toBeNull()
    expect(await repo.myTeams()).toEqual([])
    expect((await repo.mySuspendedMemberships()).map((x) => x.team_id)).toEqual([DEMO_TEAM_ID])
    const pv = await repo.suspendedLeavePreview(DEMO_TEAM_ID)
    expect(pv.deletions.map((d) => d.name)).toEqual(['佐藤 はるき'])
    await repo.archivePlayer('p3').catch(() => null)                                    // refused while stopped (no access)
    who = 'u-coach'
    expect(await repo.resumeMember(DEMO_TEAM_ID, 'u-sato')).toEqual({ status: 'active' })
    who = 'u-sato'
    expect((await repo.loadTeam(DEMO_TEAM_ID))!.me.role).toBe('member')
    await expect(repo.suspendedLeavePreview(DEMO_TEAM_ID)).rejects.toMatchObject({ code: 'not_suspended' })
  })

  it('stopped member leaves with cleanup; shared registrations stay; re-join is refused', async () => {
    let who = 'u-coach'
    const repo = createMockRepo(() => who, () => '')
    await repo.suspendMember(DEMO_TEAM_ID, 'u-tanaka-f')
    who = 'u-tanaka-f'
    const pv = await repo.suspendedLeavePreview(DEMO_TEAM_ID)
    expect(pv.deletions.map((d) => d.player_id)).toEqual(['p2'])                        // さくら: only 田中 父
    expect(pv.links_removed_count).toBe(1)                                               // ゆうと: shared with 田中 母
    await expect(repo.leaveSuspendedTeam(DEMO_TEAM_ID, 'old', LEAVE_CLEANUP_CONFIRM)).rejects.toMatchObject({ code: 'leave_confirmation_stale' })
    expect(await repo.leaveSuspendedTeam(DEMO_TEAM_ID, pv.fingerprint, LEAVE_CLEANUP_CONFIRM)).toMatchObject({ status: 'left', proxy_registrations_deleted: 1 })
    expect(await repo.joinByToken('demojoin'.repeat(4), '田中').catch((e) => e.code)).toBe('blocked_from_team')
    who = 'u-tanaka-m'
    expect((await repo.loadTeam(DEMO_TEAM_ID))!.myPlayerIds).toEqual(['p1'])
  })
})

describe('screens (source checks)', () => {
  const mm = read('components/MemberManagement.vue')
  const panel = read('components/SuspendedLeavePanel.vue')

  it('owner: stop / resume with confirmation; data is not deleted; resume = plain member; active / stopped shown', () => {
    expect(mm).toContain('repo.suspendMember(teamId.value, m.user_id)')
    expect(mm).toContain('repo.resumeMember(teamId.value, m.user_id)')
    expect(mm).toContain('本人登録・代理登録・出欠は削除しません。')
    expect(mm).toContain('<b>一般のメンバー</b>')
    expect(mm).toContain('アクセス停止中')
    expect(mm).toContain('「除外」と「アクセス停止」の違い')
    expect(mm).toContain('if (busy.value) return')
    expect(mm).toMatch(/v-if="!m\.suspended_at"[^>]*\n?[^>]*openSuspend\(m\)/)
  })

  it('removal never forces deletion: a self registration or member_data_confirmation_required leads to suspension', () => {
    expect(mm).toContain("e.code === 'member_data_confirmation_required'")
    expect(mm).toContain('openSuspend(m, true)')
    expect(read('components/MemberImpactView.vue')).toContain('本人登録があるため、除外できません')
  })

  it('stopped member: limited panel, nothing selected at first, confirmation, stale -> re-check, back to the list', () => {
    expect(panel).toContain('const deleteSelected = ref(false)')
    expect(panel).toContain('deleteSelected.value = false')
    expect(panel).toContain('if (!pv.value || !deleteSelected.value) return')
    expect(panel).toContain('if (busy.value) return')
    expect(panel).toContain('repo.leaveSuspendedTeam(props.teamId, pv.value.fingerprint, LEAVE_CLEANUP_CONFIRM)')
    expect(panel).toContain('await loadPreview()')
    expect(panel).toContain(`query: { notice: 'suspended_left' }`)
    expect(panel).toContain('<CleanupDeletionList')                                    // same list as D6-A
    expect(panel).toContain('元に戻せません')
    expect(panel).not.toMatch(/loadTeam|listMembers|events|console\./)                  // no team data, no logs
  })

  it('a stopped team is never shown as a normal team; resumed -> normal screen', () => {
    expect(read('composables/useTeamPage.ts')).toContain("'suspended' : 'not_member'")
    expect(read('components/TeamShell.vue')).toContain("state.status === 'suspended'")
    expect(read('pages/suspended/[teamId].vue')).toContain('navigateTo(`/t/${teamId}`, { replace: true })')
    expect(read('pages/index.vue')).toContain('アクセスが停止されているチーム')
  })

  it('team deletion explains that stopped members are counted', () => {
    expect(read('components/TeamDeleteCard.vue')).toContain('アクセス停止中の人も含みます')
  })
})
