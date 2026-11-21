// Phase 5-C U5-B: the REAL app data layer (app/repo/supabaseRepo.ts) against the REAL migrations:
// team page by id (members only), join links (show / re-issue / stop / reopen), old addresses,
// join errors, and compatibility with self registration and family sharing.
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { canRegisterSelf } from '../../app/utils/participants'
import { errorMessage, type Repo } from '../../app/utils/types'
import { pgliteClient } from './pgliteClient'
import { addUser, createDb } from './setup'

const U = (n: number) => `55200000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADMIN = U(2), MEM = U(3), NEWBIE = U(4), OUT = U(5), MOM = U(6)

async function setup() {
  const db = await createDb()
  const repos: Record<string, Repo> = {}
  for (const u of [OWNER, ADMIN, MEM, NEWBIE, OUT, MOM]) {
    await addUser(db, u)
    repos[u] = createSupabaseRepo(pgliteClient(db, u), () => u)
  }
  const r = (u: string) => repos[u]!
  const t = await r(OWNER).createTeam('ひまわりクラブ', '代表')
  await r(OWNER).createEvent(t.id, { title: '練習', starts_at: new Date(Date.now() + 86400_000).toISOString(), location: null, note: null })
  const link = await r(OWNER).getJoinLink(t.id)
  for (const u of [ADMIN, MEM]) expect((await r(u).joinByToken(link.token!, 'x')).status).toBe('joined')
  await db.query(`update public.team_members set role = 'admin' where team_id = $1 and user_id = $2`, [t.id, ADMIN])
  return { db, r, t, token: link.token! }
}
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

describe('team page address /t/<team id>', () => {
  it('members load the team by id; a non-member gets nothing (no name, no events)', async () => {
    const { r, t } = await setup()
    expect((await r(MEM).loadTeam(t.id))!.team.name).toBe('ひまわりクラブ')
    expect(await r(OUT).loadTeam(t.id)).toBeNull()
    expect(await r(OUT).myTeams()).toEqual([])
  })

  it('old address /t/<share token>: members are told the team id, others nothing (not a way to join)', async () => {
    const { r, t } = await setup()
    expect(await r(MEM).resolveLegacyTeam(t.share_token)).toBe(t.id)
    expect(await r(OUT).resolveLegacyTeam(t.share_token)).toBeNull()
    expect(await r(OUT).resolveLegacyTeam('x'.repeat(32))).toBeNull()
    expect(await r(OUT).loadTeam(t.id)).toBeNull()                                 // still not a member
  })
})

describe('join link (参加用URL)', () => {
  it('owner and admin see it; a plain member and an outsider are refused', async () => {
    const { r, t, token } = await setup()
    expect(await r(OWNER).getJoinLink(t.id)).toEqual({ open: true, token })
    expect(await r(ADMIN).getJoinLink(t.id)).toEqual({ open: true, token })
    for (const u of [MEM, OUT]) {
      const e = await errOf(r(u).getJoinLink(t.id))
      expect(e.code, u).toBe('forbidden')
      expect(errorMessage(e)).toBe('この操作の権限がありません。')
      expect((await errOf(r(u).rotateJoinLink(t.id))).code).toBe('forbidden')
      expect((await errOf(r(u).setJoinOpen(t.id, false))).code).toBe('forbidden')
    }
    expect(token).not.toBe(t.share_token)                                         // separate from the old token
  })

  it('join flow: preview (name only) -> join -> team page; joining again is harmless', async () => {
    const { r, t, token } = await setup()
    expect(await r(NEWBIE).previewJoin(token)).toEqual({ team_id: t.id, name: 'ひまわりクラブ', is_member: false })
    expect(await r(NEWBIE).joinByToken(token, '新人')).toEqual({ status: 'joined', team_id: t.id })
    expect((await r(NEWBIE).loadTeam(t.id))!.me).toMatchObject({ role: 'member', display_name: '新人' })
    expect(await r(NEWBIE).previewJoin(token)).toMatchObject({ is_member: true })
    expect(await r(NEWBIE).joinByToken(token, '別名')).toEqual({ status: 'already_member', team_id: t.id })
    expect((await r(NEWBIE).loadTeam(t.id))!.me.display_name).toBe('新人')          // role / name unchanged
  })

  it('re-issue: the previous link stops at once; the new one works; members are not affected', async () => {
    const { r, t, token } = await setup()
    const next = await r(ADMIN).rotateJoinLink(t.id)
    expect(next.open).toBe(true)
    expect(next.token).not.toBe(token)
    expect(await r(NEWBIE).previewJoin(token)).toBeNull()
    expect(await r(NEWBIE).joinByToken(token, '新人')).toEqual({ status: 'invalid' })
    expect(await r(NEWBIE).loadTeam(t.id)).toBeNull()
    expect((await r(NEWBIE).joinByToken(next.token!, '新人')).status).toBe('joined')
    expect(await r(MEM).loadTeam(t.id)).not.toBeNull()
  })

  it('stop: nobody can join, members keep answering; reopen issues a NEW link', async () => {
    const { r, t, token } = await setup()
    expect(await r(OWNER).setJoinOpen(t.id, false)).toEqual({ open: false, token: null })
    expect(await r(OWNER).getJoinLink(t.id)).toEqual({ open: false, token: null })
    expect(await r(NEWBIE).previewJoin(token)).toBeNull()
    expect(await r(NEWBIE).joinByToken(token, '新人')).toEqual({ status: 'invalid' })
    const s = (await r(MEM).loadTeam(t.id))!
    const me = await r(MEM).registerSelf(t.id)
    await r(MEM).setAttendance(s.events[0]!.id, me.player_id, 'attend', null)       // still works while stopped
    const reopened = await r(OWNER).setJoinOpen(t.id, true)
    expect(reopened.open).toBe(true)
    expect(reopened.token).not.toBe(token)
    expect(await r(NEWBIE).previewJoin(token)).toBeNull()                         // the stopped link stays dead
    expect((await r(NEWBIE).joinByToken(reopened.token!, '新人')).status).toBe('joined')
  })

  it('a removed member is refused with a Japanese explanation (blocked_from_team)', async () => {
    const { db, r, t, token } = await setup()
    const pg = pgliteClient(db, OWNER)
    expect((await pg.rpc('remove_member', { p_team_id: t.id, p_user_id: MEM })).error).toBeNull()
    const e = await errOf(r(MEM).joinByToken(token, 'again'))
    expect(e.code).toBe('blocked_from_team')
    expect(errorMessage(e)).toContain('このチームには参加できません')
  })

  it('membership limit (50 teams) is explained in Japanese', async () => {
    const { db, r, token } = await setup()
    await db.query(`with t as (insert into public.teams (name, created_by) select 'bulk', $1 from generate_series(1, 50) returning id)
      insert into public.team_members (team_id, user_id, role, display_name) select id, $2, 'member', 'x' from t`, [OWNER, NEWBIE])
    const e = await errOf(r(NEWBIE).joinByToken(token, '新人'))
    expect(e.code).toBe('membership_limit_exceeded')
    expect(errorMessage(e)).toContain('50チーム')
  })

  it('too many tries with wrong links -> join_attempt_rate_limited, explained in Japanese', async () => {
    const { r } = await setup()
    for (let i = 0; i < 30; i++) expect((await r(OUT).joinByToken('z'.repeat(40) + i, 'x')).status).toBe('invalid')
    const e = await errOf(r(OUT).joinByToken('z'.repeat(41), 'x'))
    expect(e.code).toBe('join_attempt_rate_limited')
    expect(errorMessage(e)).toContain('一時的')
  })

  it('a new team has its join link at once (team creation screen)', async () => {
    const { r } = await setup()
    const t2 = await r(ADMIN).createTeam('新しいチーム', '代表2')
    const l = await r(ADMIN).getJoinLink(t2.id)
    expect(l.open).toBe(true)
    expect(l.token).toMatch(/^.{32,}$/)
  })
})

describe('compatibility', () => {
  it('self registration and family sharing work for someone who joined by the join link', async () => {
    const { r, t, token } = await setup()
    await r(NEWBIE).joinByToken(token, '田中（父）')
    expect(canRegisterSelf((await r(NEWBIE).loadTeam(t.id))!)).toBe(true)
    const kid = await r(NEWBIE).registerPlayer(t.id, '田中 ゆうと', null, false)
    const inv = await r(NEWBIE).createInvitation((kid as { player_id: string }).player_id)
    const acc = await r(MOM).acceptInvitation(inv.token, '田中（母）')                 // family link also makes MOM a member
    expect(acc).toMatchObject({ status: 'accepted', team_id: t.id })                 // the screen links to /t/<team_id>/answer
    expect((await r(MOM).loadTeam(t.id))!.myPlayerIds).toEqual([(kid as { player_id: string }).player_id])
  })

  it('the old DB join path: open before D5 (as the U5-B screens shipped), closed by D5; the screens never use it', async () => {
    const before = await createDb({ before: '20261118210000_disable_legacy_join.sql' })
    for (const u of [OWNER, OUT]) await addUser(before, u)
    const old = await createSupabaseRepo(pgliteClient(before, OWNER), () => OWNER).createTeam('旧経路', '代表')
    expect(await pgliteClient(before, OUT).rpc('join_team', { p_share_token: old.share_token, p_display_name: 'old' }))
      .toEqual({ data: old.id, error: null })                                  // before D5: it really worked
    const { db, r, t } = await setup()                                        // final schema (D5 applied)
    const after = await pgliteClient(db, OUT).rpc('join_team', { p_share_token: t.share_token, p_display_name: 'old' })
    expect(after.error?.message).toMatch(/permission denied for function join_team/)
    expect(await r(OUT).loadTeam(t.id)).toBeNull()                            // not a member
  })
})

