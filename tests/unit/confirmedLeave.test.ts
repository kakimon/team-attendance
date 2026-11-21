import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMockRepo, DEMO_TEAM_ID } from '../../app/repo/mockRepo'
import { LEAVE_CLEANUP_CONFIRM } from '../../app/utils/types'

describe('D6-A demo and UI contract', () => {
  it('requires confirmation, detects changed/cancelled data, then leaves with the same deletion counts', async () => {
    let who = 'u-sato'
    const r = createMockRepo(() => who, () => 'demo')
    const pv = await r.leaveCleanupPreview(DEMO_TEAM_ID)
    expect(pv.cleanup.deletions).toEqual([{ player_id: 'p3', name: '佐藤 はるき', is_self: false, cancelled: false, answers: 1 }])
    await expect(r.leaveTeamWithCleanup(DEMO_TEAM_ID, pv.cleanup.fingerprint, '')).rejects.toMatchObject({ code: 'confirm_required' })
    await r.archivePlayer('p3')
    await expect(r.leaveTeamWithCleanup(DEMO_TEAM_ID, pv.cleanup.fingerprint, LEAVE_CLEANUP_CONFIRM)).rejects.toMatchObject({ code: 'leave_confirmation_stale' })
    const fresh = await r.leaveCleanupPreview(DEMO_TEAM_ID)
    expect(fresh.cleanup.deletions[0]!.cancelled).toBe(true)
    who = 'u-coach'
    await expect(r.removeMember(DEMO_TEAM_ID, 'u-sato')).rejects.toMatchObject({ code: 'sole_guardian_children' })
    who = 'u-sato'
    expect(await r.leaveTeamWithCleanup(DEMO_TEAM_ID, fresh.cleanup.fingerprint, LEAVE_CLEANUP_CONFIRM)).toMatchObject({ status: 'left', proxy_registrations_deleted: 1, answers_deleted: 1 })
    await expect(r.leaveTeamWithCleanup(DEMO_TEAM_ID, fresh.cleanup.fingerprint, LEAVE_CLEANUP_CONFIRM)).rejects.toMatchObject({ code: 'not_member' })
    who = 'u-coach'
    expect((await r.loadTeam(DEMO_TEAM_ID))!.players.some((p) => p.id === 'p3')).toBe(false)
    expect(await r.blockedMembers(DEMO_TEAM_ID)).toEqual([])
  })

  it('deletes only the sole proxy and own self; keeps the shared proxy with the family', async () => {
    let who = 'u-tanaka-f'
    const r = createMockRepo(() => who, () => 'demo')
    await r.registerSelf(DEMO_TEAM_ID)
    const pv = await r.leaveCleanupPreview(DEMO_TEAM_ID)
    expect(pv.cleanup.deletions.some((p) => p.player_id === 'p1')).toBe(false)
    expect(pv.cleanup.deletions.some((p) => p.is_self)).toBe(true)
    expect(await r.leaveTeamWithCleanup(DEMO_TEAM_ID, pv.cleanup.fingerprint, LEAVE_CLEANUP_CONFIRM)).toMatchObject({ proxy_registrations_deleted: 1, self_registrations_deleted: 1 })
    who = 'u-tanaka-m'
    const snap = (await r.loadTeam(DEMO_TEAM_ID))!
    expect(snap.myPlayerIds).toContain('p1')
    expect(snap.players.some((p) => p.id === 'p2')).toBe(false)
    expect(snap.attendance.some((a) => a.player_id === 'p1')).toBe(true)
  })

  it('defaults to no deletion, requires fresh preview after errors, and preserves the ordinary leave path', () => {
    const src = readFileSync(new URL('../../app/components/LeaveTeamPanel.vue', import.meta.url), 'utf8')
    expect(src).toContain('const deleteSelected = ref(false)')
    expect(src).toContain('deleteSelected.value = false')
    expect(src).toContain('if (needsCleanup && (!cleanup.value || !deleteSelected.value)) return')
    expect(src).toContain('else await repo.leaveTeam(s.team.id)')
    expect(src).toContain('await loadPreview(s)')
    expect(src).toContain('request !== previewRequest')
    expect(src).toContain('出欠 {{ p.answers }} 件')
    expect(src).toContain('元に戻せません')
  })
})
