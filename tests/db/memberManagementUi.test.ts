// Phase 5-C U5-C: member management through the REAL app data layer (app/repo/supabaseRepo.ts)
// against the REAL migrations (U4 / D3.5 / U4-Fix / U4-Fix2): list, removal (with preview), block list,
// leaving (with preview), team deletion, owner hand-over, and the permission checks of the server.
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { errorMessage, type Repo } from '../../app/utils/types'
import { pgliteClient } from './pgliteClient'
import { addUser, createDb } from './setup'

const U = (n: number) => `55300000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADMIN = U(2), MEM = U(3), FAM = U(4), SOLO = U(5), OUT = U(6)

async function setup() {
  const db = await createDb()
  const repos: Record<string, Repo> = {}
  for (const u of [OWNER, ADMIN, MEM, FAM, SOLO, OUT]) {
    await addUser(db, u)
    repos[u] = createSupabaseRepo(pgliteClient(db, u), () => u)
  }
  const r = (u: string) => repos[u]!
  const t = await r(OWNER).createTeam('ひまわりクラブ', '代表')
  await r(OWNER).createEvent(t.id, { title: '練習', starts_at: new Date(Date.now() + 86400_000).toISOString(), location: null, note: null })
  const token = (await r(OWNER).getJoinLink(t.id)).token!
  for (const [u, n] of [[ADMIN, '管理者A'], [MEM, '山田'], [FAM, '山田（家族）'], [SOLO, '佐藤']] as const) await r(u).joinByToken(token, n)
  await db.query(`update public.team_members set role = 'admin' where team_id = $1 and user_id = $2`, [t.id, ADMIN])
  // MEM: own self registration (FAM may answer for it) + a child shared with FAM; SOLO: a child only SOLO answers for
  const me = await r(MEM).registerSelf(t.id)
  await r(FAM).acceptInvitation((await r(MEM).createInvitation(me.player_id)).token, '山田（家族）')
  const kid = (await r(MEM).registerPlayer(t.id, '山田 たろう', null, true)) as { player_id: string }
  await r(FAM).acceptInvitation((await r(MEM).createInvitation(kid.player_id)).token, '山田（家族）')
  const ev = (await r(MEM).loadTeam(t.id))!.events[0]!.id
  await r(MEM).setAttendance(ev, me.player_id, 'attend', null)
  const solo = (await r(SOLO).registerPlayer(t.id, '佐藤 はな', null, true)) as { player_id: string }
  return { db, r, t, token, me: me.player_id, kid: kid.player_id, solo: solo.player_id }
}
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

describe('member list and permissions', () => {
  it('members see everyone with roles; an outsider sees nobody', async () => {
    const { r, t } = await setup()
    const list = await r(MEM).listMembers(t.id)
    expect(list.map((m) => [m.display_name, m.role])).toEqual([
      ['代表', 'owner'], ['管理者A', 'admin'], ['山田', 'member'], ['山田（家族）', 'member'], ['佐藤', 'member'],
    ])
    expect(await r(OUT).listMembers(t.id)).toEqual([])
  })

  it('only the owner may preview / remove / see the block list / unblock / delete', async () => {
    const { r, t } = await setup()
    for (const u of [ADMIN, MEM, OUT]) {
      for (const p of [r(u).removalPreview(t.id, FAM), r(u).removeMember(t.id, FAM), r(u).blockedMembers(t.id), r(u).unblockMember(t.id, FAM), r(u).deleteTeam(t.id, 'ひまわりクラブ')]) {
        const e = await errOf(p)
        expect(e?.code, u).toBe('forbidden')
        expect(errorMessage(e)).toBe('この操作の権限がありません。')
      }
    }
    expect((await errOf(r(OWNER).removeMember(t.id, OWNER))).code).toBe('cannot_remove_owner')
    expect((await errOf(r(OWNER).removalPreview(t.id, OUT))).code).toBe('member_not_found')
    expect(await r(FAM).loadTeam(t.id)).not.toBeNull()                                  // nothing happened
  })
})

describe('removal (owner)', () => {
  it('preview lists self and shared registrations; executing legacy removal is separately refused', async () => {
    const { r, t, me, kid } = await setup()
    const pv = await r(OWNER).removalPreview(t.id, MEM)
    expect(pv.self_registrations).toEqual([{ player_id: me, name: '山田', answers: 1 }])
    expect(pv.links_removed).toEqual([{ player_id: kid, name: '山田 たろう' }])
    expect(pv.sole_guardian_children).toEqual([])
  })

  it('old removal refuses deleting a self registration; membership, answers and family links remain', async () => {
    const { r, t, me, kid } = await setup()
    await expect(r(OWNER).removeMember(t.id, MEM)).rejects.toThrow(/member_data_confirmation_required/)
    const mine = (await r(MEM).loadTeam(t.id))!
    const fam = (await r(FAM).loadTeam(t.id))!
    expect(mine.players.some((p) => p.id === me)).toBe(true)
    expect(fam.myPlayerIds.sort()).toEqual([me,kid].sort())
    expect(await r(OWNER).blockedMembers(t.id)).toEqual([])
  })

  it('a proxy of someone else\'s self registration: only the link goes, the registration stays', async () => {
    const { r, t, me } = await setup()
    const pv = await r(OWNER).removalPreview(t.id, FAM)
    expect(pv.links_removed.map((x) => x.player_id)).toContain(me)
    expect(pv.self_registrations).toEqual([])
    await r(OWNER).removeMember(t.id, FAM)
    expect((await r(MEM).loadTeam(t.id))!.players.some((p) => p.id === me)).toBe(true)
  })

  it('someone who is the only one to answer for a registration: refused, explained, nothing changed', async () => {
    const { r, t, solo } = await setup()
    expect((await r(OWNER).removalPreview(t.id, SOLO)).sole_guardian_children).toEqual([{ player_id: solo, name: '佐藤 はな', cancelled: false }])
    const e = await errOf(r(OWNER).removeMember(t.id, SOLO))
    expect(e.code).toBe('sole_guardian_children')
    expect(errorMessage(e)).toContain('別の回答者を追加してください')
    expect(await r(SOLO).loadTeam(t.id)).not.toBeNull()
    // the resolution offered on screen: invite another person to answer -> then removal works
    await r(MEM).acceptInvitation((await r(SOLO).createInvitation(solo)).token, '山田')
    expect((await r(OWNER).removalPreview(t.id, SOLO)).sole_guardian_children).toEqual([])
    expect((await r(OWNER).removeMember(t.id, SOLO)).status).toBe('removed')
  })

  it('cancelling the registration does NOT resolve it (the screen says so)', async () => {
    const { r, t, solo } = await setup()
    await r(SOLO).archivePlayer(solo)
    expect((await r(SOLO).leavePreview(t.id)).sole_guardian_children).toEqual([{ player_id: solo, name: '佐藤 はな', cancelled: true }])
    expect((await errOf(r(SOLO).leaveTeam(t.id))).code).toBe('sole_guardian_children')
  })
})

describe('leaving (member)', () => {
  it('preview and leave: self registration deleted, shared child stays; not blocked; can join again', async () => {
    const { r, t, token, kid } = await setup()
    const pv = await r(MEM).leavePreview(t.id)
    expect(pv).toMatchObject({ is_owner: false, sole_guardian_children: [] })
    expect(pv.self_registrations).toHaveLength(1)
    expect((await r(MEM).leaveTeam(t.id))).toMatchObject({ status: 'left', self_registrations_deleted: 1 })
    expect(await r(MEM).myTeams()).toEqual([])
    expect((await r(FAM).loadTeam(t.id))!.myPlayerIds).toEqual([kid])
    expect(await r(OWNER).blockedMembers(t.id)).toEqual([])
    expect((await r(MEM).joinByToken(token, '山田')).status).toBe('joined')
  })

  it('the owner cannot leave (explained); after a hand-over the old owner can', async () => {
    const { r, t } = await setup()
    expect((await r(OWNER).leavePreview(t.id)).is_owner).toBe(true)
    const e = await errOf(r(OWNER).leaveTeam(t.id))
    expect(e.code).toBe('owner_cannot_leave')
    expect(errorMessage(e)).toContain('オーナーを交代')
    await r(OWNER).requestOwnerTransfer(t.id, ADMIN)
    expect((await r(OWNER).myOwnerTransfers()).outgoing).toEqual([expect.objectContaining({ team_id: t.id, to_user: ADMIN, to_name: '管理者A' })])
    expect(await r(ADMIN).respondOwnerTransfer(t.id, true)).toBe('accepted')
    expect((await r(OWNER).leaveTeam(t.id)).status).toBe('left')
  })

  it('a non-member is told so', async () => {
    const { r, t } = await setup()
    expect((await errOf(r(OUT).leaveTeam(t.id))).code).toBe('not_member')
  })
})

describe('deleting a team (owner)', () => {
  it('refused while others are members; wrong name refused; then deleted and the owner slot comes back', async () => {
    const { db, r, t } = await setup()
    const e = await errOf(r(OWNER).deleteTeam(t.id, 'ひまわりクラブ'))
    expect(e.code).toBe('team_has_members')
    expect(errorMessage(e)).toContain('ほかのメンバーがいるチームは削除できません')
    const solo = await r(SOLO).createTeam('ひとりチーム', '佐藤')
    expect((await errOf(r(SOLO).deleteTeam(solo.id, 'ちがう名前'))).code).toBe('confirm_mismatch')
    for (const n of ['2', '3']) await r(SOLO).createTeam(`チーム${n}`, '佐藤')
    expect((await errOf(r(SOLO).createTeam('4つ目', '佐藤'))).code).toBe('owner_quota_exceeded')
    await r(SOLO).deleteTeam(solo.id, ' ひとりチーム ')
    expect(await r(SOLO).loadTeam(solo.id)).toBeNull()
    expect((await r(SOLO).createTeam('4つ目', '佐藤')).name).toBe('4つ目')         // slot came back
    const [{ n }] = (await db.query<{ n: number }>(`select count(*)::int n from private.rate_events where user_id = $1 and kind = 'team_create'`, [SOLO])).rows
    expect(n).toBe(4)                                                                   // 24h records are kept
    expect((await errOf(r(SOLO).createTeam('5つ目', '佐藤'))).code).toBe('owner_quota_exceeded')
  })
})
