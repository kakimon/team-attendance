import { describe, expect, it } from 'vitest'
import { codeOf, createSupabaseRepo, type DbClient } from '../../app/repo/supabaseRepo'
import { ownedTeamCount } from '../../app/utils/teamUsage'
import { ERROR_MESSAGE, RepoError, errorMessage } from '../../app/utils/types'
import { ADMIN_TOPICS, FAQ, PARENT_TOPICS } from '../../app/utils/helpContent'

describe('usage guidance', () => {
  it('distinguishes an unknown count from an empty membership list; counts owners only', () => {
    expect(ownedTeamCount(null)).toBeNull()
    expect(ownedTeamCount([])).toBe(0)
    expect(ownedTeamCount([{ role: 'member' }, { role: 'owner' }, { role: 'admin' }, { role: 'owner' }])).toBe(2)
  })

  it.each([
    ['owner_quota_exceeded', '3件'], ['team_create_rate_limited', '24時間に5回'],
    ['membership_limit_exceeded', '50チーム'], ['team_member_limit_exceeded', '300人'],
    ['guardian_child_limit_exceeded', '20人'], ['team_child_limit_exceeded', '500人'],
    ['team_event_limit_exceeded', '2,000件'], ['event_create_rate_limited', '24時間に100回'],
    ['invite_create_rate_limited', '24時間に20回'], ['too_many_active_invitations', '5件'],
    ['blocked_from_team', '再参加が拒否'], ['sole_guardian_children', '現在の画面では解消できません'],
  ])('preserves DB code %s and provides a specific Japanese message', (code, words) => {
    const parsed = codeOf(`database: ${code}`)
    expect(parsed).toBe(code)
    expect(errorMessage(new RepoError(parsed))).toContain(words)
    expect(errorMessage(new RepoError(parsed))).not.toContain(code)
  })

  it.each(['team_event_limit_exceeded', 'event_create_rate_limited'])('maps the actual event RPC error %s through the data layer', async (code) => {
    const db = { rpc: async () => ({ data: null, error: { message: code } }) } as unknown as DbClient
    const repo = createSupabaseRepo(db, () => 'test-user')
    const e = await repo.createEvent('team', { title: '練習', starts_at: '2026-11-17T09:00:00Z', location: null, note: null }).catch((e) => e)
    expect(e.code).toBe(code)
    expect(errorMessage(e)).not.toBe(ERROR_MESSAGE.unknown)
  })

  it('guides existing flows and distinguishes successful sharing / transfer from sending a request', () => {
    expect(PARENT_TOPICS.map((t) => t.id)).toEqual(expect.arrayContaining(['join', 'self', 'child', 'answer', 'family']))
    expect(ADMIN_TOPICS.find((t) => t.id === 'create')?.note).toContain('作成・所有中のチーム数')
    const answer = (id: string) => FAQ.find((f) => f.id === id)!.a.join('\n')
    expect(answer('team-limits')).toContain('交代を依頼しただけでは戻りません')
    expect(answer('team-limits')).toContain('日付が変わった時点で一斉には戻らない')
    for (const id of ['leave-team', 'remove-member']) {
      expect(answer(id)).toContain('取り消し済みの登録には現在の画面で回答者を追加できない')
      expect(answer(id)).toContain('受け取')
    }
    expect(answer('remove-member')).toContain('参加用URL・家族招待のどちらからも')
    expect(answer('delete-team')).toContain('元に戻せません')
  })
})
