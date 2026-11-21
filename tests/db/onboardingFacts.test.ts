// Read-only facts for the first-use help, through the real repo and the real RLS (PGlite).
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { pgliteClient } from './pgliteClient'
import { addUser, asUser, createDb, joinTeamAs } from './setup'

const U = (n: number) => `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), MOM = U(2), DAD = U(3), OTHER = U(4), OUT = U(5)

async function scenario() {
  const db = await createDb()
  for (const u of [OWNER, MOM, DAD, OTHER, OUT]) await addUser(db, u)
  const q = (u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<any>(sql, p)).rows)
  const [t] = await q(OWNER, `select id, share_token from public.create_team('チーム', '代表')`)
  for (const u of [MOM, OTHER]) await joinTeamAs(db, u, t.share_token, 'm')
  const kid = (await q(MOM, `select public.register_player($1, 'こども', null, true) as r`, [t.id]))[0].r.player_id
  const solo = (await q(MOM, `select public.register_player($1, 'ひとり', null, true) as r`, [t.id]))[0].r.player_id
  const [{ r: inv }] = await q(MOM, `select public.create_guardian_invitation($1) as r`, [kid])
  await q(DAD, `select public.accept_guardian_invitation($1, 'パパ')`, [inv.token])
  const [{ id: e1 }] = await q(OWNER, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const [{ id: e2 }] = await q(OWNER, `select public.create_event($1, '消す予定', now() + interval '2 day') as id`, [t.id])
  await q(OWNER, `select public.delete_event($1)`, [e2])
  await q(MOM, `select public.set_attendance($1, $2, 'attend')`, [e1, kid])
  // another team must not leak into the counts
  const [t2] = await q(OUT, `select id from public.create_team('別チーム', 'x')`)
  await q(OUT, `select public.create_event($1, '別', now() + interval '1 day')`, [t2.id])
  const repo = (u: string) => createSupabaseRepo(pgliteClient(db, u), () => u)
  return { db, t, kid, solo, repo }
}

describe('onboardingFacts', () => {
  it('counts members, live events, my answers; reports my join time', async () => {
    const s = await scenario()
    const f = await s.repo(MOM).onboardingFacts(s.t.id, [s.kid, s.solo])
    expect(f.memberCount).toBe(4)        // owner, mom, other, dad (joined via invitation)
    expect(f.eventCount).toBe(1)         // the deleted event is not counted
    expect(f.myAnswerCount).toBe(1)
    expect(Date.now() - Date.parse(f.joinedAt!)).toBeLessThan(60_000)
  })

  it('family sharing is seen by both guardians, only for the shared child', async () => {
    const s = await scenario()
    expect((await s.repo(MOM).onboardingFacts(s.t.id, [s.kid, s.solo])).sharedPlayerIds).toEqual([s.kid])   // invitation used
    expect((await s.repo(DAD).onboardingFacts(s.t.id, [s.kid])).sharedPlayerIds).toEqual([s.kid])            // joined by invitation
  })

  it('an admin who is not a parent: no answers, no shared children', async () => {
    const s = await scenario()
    const f = await s.repo(OWNER).onboardingFacts(s.t.id, [])
    expect(f).toMatchObject({ memberCount: 4, eventCount: 1, myAnswerCount: 0, sharedPlayerIds: [] })
  })

  it('outsiders learn nothing about the team (RLS), without errors', async () => {
    const s = await scenario()
    const f = await s.repo(OUT).onboardingFacts(s.t.id, [])
    expect(f).toMatchObject({ memberCount: 0, eventCount: 0, myAnswerCount: 0, sharedPlayerIds: [], joinedAt: null })
  })

  it('is read-only: nothing changes in the database', async () => {
    const s = await scenario()
    const h = async () => (await s.db.query<{ h: string }>(`select md5(concat_ws('|',
      (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.team_members x),
      (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.attendance x),
      (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.player_guardians x))) h`)).rows[0]!.h
    const before = await h()
    await s.repo(MOM).onboardingFacts(s.t.id, [s.kid, s.solo])
    await s.repo(OWNER).onboardingFacts(s.t.id, [])
    expect(await h()).toBe(before)
  })
})
