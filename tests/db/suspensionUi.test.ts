// D6-B2: access suspension and the stopped member's own cleanup, through the REAL app data layer
// (app/repo/supabaseRepo.ts) against the REAL migrations (D6-A / D6-B1). The DB decides every permission.
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { LEAVE_CLEANUP_CONFIRM, errorMessage, type Repo } from '../../app/utils/types'
import { pgliteClient } from './pgliteClient'
import { addUser, createDb } from './setup'

const U = (n: number) => `55400000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADMIN = U(2), MEM = U(3), FAM = U(4), OUT = U(5)

async function setup(before?: string) {
  const db = await createDb(before ? { before } : {})
  const repos: Record<string, Repo> = {}
  for (const u of [OWNER, ADMIN, MEM, FAM, OUT]) {
    await addUser(db, u)
    repos[u] = createSupabaseRepo(pgliteClient(db, u), () => u)
  }
  const r = (u: string) => repos[u]!
  const t = await r(OWNER).createTeam('ひまわりクラブ', '代表')
  await r(OWNER).createEvent(t.id, { title: '練習', starts_at: new Date(Date.now() + 86400_000).toISOString(), location: null, note: null })
  const token = (await r(OWNER).getJoinLink(t.id)).token!
  for (const [u, n] of [[ADMIN, '管理者A'], [MEM, '山田'], [FAM, '山田（家族）']] as const) await r(u).joinByToken(token, n)
  await db.query(`update public.team_members set role = 'admin' where team_id = $1 and user_id = $2`, [t.id, ADMIN])
  return { db, r, t }
}
/** MEM: own self registration with an answer, a child shared with FAM, and a child only MEM answers for. */
async function withRegistrations(r: (u: string) => Repo, teamId: string) {
  const me = await r(MEM).registerSelf(teamId)
  const ev = (await r(MEM).loadTeam(teamId))!.events[0]!.id
  await r(MEM).setAttendance(ev, me.player_id, 'attend', null)
  const shared = (await r(MEM).registerPlayer(teamId, '山田 たろう', null, true)) as { player_id: string }
  await r(FAM).acceptInvitation((await r(MEM).createInvitation(shared.player_id)).token, '山田（家族）')
  const sole = (await r(MEM).registerPlayer(teamId, '山田 はな', null, true)) as { player_id: string }
  return { me: me.player_id, shared: shared.player_id, sole: sole.player_id, ev }
}
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

describe('owner: suspend / resume', () => {
  it('only the owner can stop or resume; admin, member and outsider are refused in Japanese', async () => {
    const { r, t } = await setup()
    for (const u of [ADMIN, MEM, OUT]) {
      for (const p of [r(u).suspendMember(t.id, FAM), r(u).resumeMember(t.id, FAM)]) {
        const e = await errOf(p)
        expect(e?.code, u).toBe('forbidden')
        expect(errorMessage(e)).toBe('この操作の権限がありません。')
      }
    }
    expect((await errOf(r(OWNER).suspendMember(t.id, OWNER))).code).toBe('cannot_remove_owner')
  })

  it('stopping keeps every registration and answer; the list shows active / stopped; resume = plain member', async () => {
    const { r, t } = await setup()
    const reg = await withRegistrations(r, t.id)
    expect(await r(OWNER).suspendMember(t.id, ADMIN)).toEqual({ status: 'suspended' })
    expect(await r(OWNER).suspendMember(t.id, MEM)).toEqual({ status: 'suspended' })
    const list = await r(OWNER).listMembers(t.id)
    const by = (u: string) => list.find((m) => m.user_id === u)!
    expect(by(MEM).suspended_at).toBeTruthy()
    expect(by(ADMIN)).toMatchObject({ role: 'member' })                               // stopped people are plain members
    expect(by(FAM).suspended_at ?? null).toBeNull()
    const owner = (await r(OWNER).loadTeam(t.id))!
    for (const id of [reg.me, reg.shared, reg.sole]) expect(owner.players.some((p) => p.id === id), id).toBe(true)
    expect(owner.attendance.some((a) => a.player_id === reg.me)).toBe(true)
    expect(await r(OWNER).resumeMember(t.id, ADMIN)).toEqual({ status: 'active' })
    expect((await r(ADMIN).loadTeam(t.id))!.me.role).toBe('member')                  // back as a plain member
    expect(await r(ADMIN).getJoinLink(t.id).catch((e) => e.code)).toBe('forbidden')   // no admin rights any more
  })

  it('a member with only a self registration: removal refused with the suspension guidance', async () => {
    const { r, t } = await setup()
    await r(FAM).registerSelf(t.id)
    const e = await errOf(r(OWNER).removeMember(t.id, FAM))
    expect(e.code).toBe('member_data_confirmation_required')
    expect(errorMessage(e)).toContain('アクセス停止')
    expect((await r(OWNER).suspendMember(t.id, FAM)).status).toBe('suspended')
  })

  it('team deletion still counts stopped members', async () => {
    const { r } = await setup()
    const solo = await r(MEM).createTeam('ふたり', '山田')
    await r(FAM).joinByToken((await r(MEM).getJoinLink(solo.id)).token!, '家族')
    await r(MEM).suspendMember(solo.id, FAM)
    expect((await r(MEM).listMembers(solo.id))).toHaveLength(2)                      // the screen says "2 人（停止中を含む）"
    const e = await errOf(r(MEM).deleteTeam(solo.id, 'ふたり'))
    expect(e.code).toBe('team_has_members')
  })
})

describe('the stopped member', () => {
  it('sees no team page, no team list entry; only id, date and current name of their own stopped teams', async () => {
    const { r, t } = await setup()
    await withRegistrations(r, t.id)
    await r(OWNER).suspendMember(t.id, MEM)
    expect(await r(MEM).loadTeam(t.id)).toBeNull()
    expect(await r(MEM).myTeams()).toEqual([])
    const stopped = await r(MEM).mySuspendedMemberships()
    // D6-B3: the current team name of their own stopped membership, nothing else
    expect(stopped).toEqual([{ team_id: t.id, suspended_at: expect.any(String), team_name: 'ひまわりクラブ' }])
    expect(Object.keys(stopped[0]!).sort()).toEqual(['suspended_at', 'team_id', 'team_name'])
    expect(JSON.stringify(stopped)).not.toMatch(/管理者A|山田（家族）|代表|練習|token/)
    for (const u of [OWNER, ADMIN, FAM, OUT]) expect(await r(u).mySuspendedMemberships(), u).toEqual([])
    expect(await r(MEM).listMembers(t.id)).toEqual([])                                   // reads stay closed
    expect((await errOf(r(MEM).leavePreview(t.id))).code).toBe('team_access_suspended')
    expect(errorMessage(await errOf(r(MEM).leavePreview(t.id)))).toContain('停止されています')
  })

  it('preview lists only own / sole registrations with counts; shared stays; then leaves and cannot re-join', async () => {
    const { r, t } = await setup()
    const reg = await withRegistrations(r, t.id)
    await r(OWNER).suspendMember(t.id, MEM)
    const pv = await r(MEM).suspendedLeavePreview(t.id)
    expect(pv.deletions.map((d) => [d.player_id, d.is_self, d.answers]).sort()).toEqual([[reg.me, true, 1], [reg.sole, false, 0]].sort())
    expect(pv.links_removed_count).toBe(1)
    expect(JSON.stringify(pv)).not.toMatch(/token|invitation|ひまわり|山田（家族）/)
    expect((await errOf(r(MEM).leaveSuspendedTeam(t.id, pv.fingerprint, ''))).code).toBe('confirm_required')
    const done = await r(MEM).leaveSuspendedTeam(t.id, pv.fingerprint, LEAVE_CLEANUP_CONFIRM)
    expect(done).toMatchObject({ status: 'left', self_registrations_deleted: 1, proxy_registrations_deleted: 1 })
    expect((await r(FAM).loadTeam(t.id))!.myPlayerIds).toEqual([reg.shared])          // family keeps the shared child
    expect(await r(MEM).mySuspendedMemberships()).toEqual([])
    expect((await errOf(r(MEM).leaveSuspendedTeam(t.id, pv.fingerprint, LEAVE_CLEANUP_CONFIRM))).code).toBe('not_member')  // retry: nothing more
    const token = (await r(OWNER).getJoinLink(t.id)).token!
    expect((await errOf(r(MEM).joinByToken(token, '山田'))).code).toBe('blocked_from_team')
    const other = await r(MEM).createTeam('べつのチーム', '山田')                     // account and other teams stay usable
    expect(other.name).toBe('べつのチーム')
  })

  it('a change after the preview -> leave_confirmation_stale, nothing deleted; a fresh preview works', async () => {
    const { r, t } = await setup()
    const reg = await withRegistrations(r, t.id)
    await r(OWNER).suspendMember(t.id, MEM)
    const pv = await r(MEM).suspendedLeavePreview(t.id)
    await r(FAM).setAttendance(reg.ev, reg.shared, 'absent', null)                      // family answers meanwhile
    await r(FAM).leaveTeam(t.id).catch(() => null)                                      // the shared child becomes sole
    const e = await errOf(r(MEM).leaveSuspendedTeam(t.id, pv.fingerprint, LEAVE_CLEANUP_CONFIRM))
    expect(e.code).toBe('leave_confirmation_stale')
    expect(errorMessage(e)).toContain('何も削除していません')
    expect((await r(OWNER).loadTeam(t.id))!.players.some((p) => p.id === reg.me)).toBe(true)
    const fresh = await r(MEM).suspendedLeavePreview(t.id)
    expect((await r(MEM).leaveSuspendedTeam(t.id, fresh.fingerprint, LEAVE_CLEANUP_CONFIRM)).status).toBe('left')
  })

  it('after resume the team page works again, and the limited cleanup is refused (not_suspended)', async () => {
    const { r, t } = await setup()
    await r(OWNER).suspendMember(t.id, MEM)
    await r(OWNER).resumeMember(t.id, MEM)
    expect((await r(MEM).loadTeam(t.id))!.me).toMatchObject({ role: 'member' })
    expect((await errOf(r(MEM).suspendedLeavePreview(t.id))).code).toBe('not_suspended')
    expect(await r(MEM).mySuspendedMemberships()).toEqual([])
  })

  it('an active member cannot use the stopped-member cleanup', async () => {
    const { r, t } = await setup()
    expect((await errOf(r(FAM).suspendedLeavePreview(t.id))).code).toBe('not_suspended')
    expect((await errOf(r(FAM).leaveSuspendedTeam(t.id, 'x', LEAVE_CLEANUP_CONFIRM))).code).toBe('not_suspended')
  })
})

describe('older database (before D6-B1)', () => {
  it('member list works without the column; there are no stopped teams; suspension reports feature_unavailable', async () => {
    const { r, t } = await setup('20261118100000_member_suspension.sql')
    expect((await r(OWNER).listMembers(t.id)).every((m) => !m.suspended_at)).toBe(true)
    expect(await r(MEM).mySuspendedMemberships()).toEqual([])
    expect((await errOf(r(OWNER).suspendMember(t.id, MEM))).code).toBe('feature_unavailable')
  })
})
