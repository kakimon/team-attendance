// public.service_stats(): the top page's usage numbers for logged-out visitors (anon key).
// Only three counts and the time; nothing about a person, a team or an answer; anon only; writes nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261126000000_service_stats.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261126000000_service_stats_down.sql'), 'utf8')
const U = (n: number) => `56300000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [A, B, C, D] = [1, 2, 3, 4].map(U)
const stats = (db: Db, uid: string | null = null) => asUser(db, uid, async () => (await db.query<{ s: any }>('select public.service_stats() s')).rows[0]!.s)

async function seeded(opts: { before?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : {})
  for (const u of [A, B, C, D]) await addUser(db, u)
  const t = (await asUser(db, A, () => db.query<any>(`select id, share_token from public.create_team('数字の確認', '代表')`))).rows[0]
  await asUser(db, C, () => db.query(`select public.create_team('二つ目', 'C')`))
  await joinTeamAs(db, B, t.share_token, 'B')
  const ev = (await asUser(db, A, () => db.query<any>(`select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id]))).rows[0].id
  const self = (await asUser(db, B, () => db.query<any>(`select public.register_self($1) as r`, [t.id]))).rows[0].r.player_id
  const kid = (await asUser(db, A, () => db.query<any>(`select public.register_player($1, 'こども', null, true) as r`, [t.id]))).rows[0].r.player_id
  await asUser(db, B, () => db.query(`select public.set_attendance($1, $2, 'attend')`, [ev, self]))
  await asUser(db, A, () => db.query(`select public.set_attendance($1, $2, 'absent')`, [ev, kid]))
  return { db, team: t.id as string, ev, kid }
}
const dataHash = async (db: Db) => (await db.query<{ h: string }>(`select md5(concat_ws('|',
  (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
  (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
  (select string_agg(id::text, ',' order by id) from auth.users))) h`)).rows[0]!.h

describe('service_stats', () => {
  it('anon gets exactly users / teams / answers / counted_at with the right counts', async () => {
    const { db } = await seeded()
    const s = await stats(db)
    expect(Object.keys(s).sort()).toEqual(['answers', 'counted_at', 'teams', 'users'])
    expect(s).toMatchObject({ users: 4, teams: 2, answers: 2 })
    expect(Date.parse(s.counted_at)).not.toBeNaN()
  })

  it('answers = recorded answers: changing one does not add, "unanswered" removes it', async () => {
    const { db, ev, kid } = await seeded()
    await asUser(db, A, () => db.query(`select public.set_attendance($1, $2, 'undecided')`, [ev, kid]))
    expect((await stats(db)).answers).toBe(2)
    await asUser(db, A, () => db.query(`select public.set_attendance($1, $2, 'unanswered')`, [ev, kid]))
    expect((await stats(db)).answers).toBe(1)
  })

  it('users leave the count once their account deletion has started', async () => {
    const { db } = await seeded()
    await db.query(`insert into private.account_deletions (user_id) values ($1)`, [D])
    expect((await stats(db)).users).toBe(3)
  })

  it('returns nothing about people, teams or answers (no ids, names, e-mails, statuses)', async () => {
    const { db, team } = await seeded()
    const text = JSON.stringify(await stats(db))
    for (const secret of [A, B, C, team, '数字の確認', 'こども', 'attend', 'absent']) expect(text).not.toContain(secret)
  })

  it('writes nothing; SECURITY DEFINER, STABLE, fixed search_path', async () => {
    const { db } = await seeded()
    const h = await dataHash(db)
    await stats(db); await stats(db)
    expect(await dataHash(db)).toBe(h)
    const f = (await db.query<any>(`select prosecdef sd, provolatile vol, proconfig cfg from pg_proc where oid = 'public.service_stats()'::regprocedure`)).rows[0]
    expect(f).toMatchObject({ sd: true, vol: 's' })
    expect(f.cfg.join()).toContain('search_path=""')
  })

  it('anon only: signed-in users, PUBLIC and service_role cannot execute it; tables stay closed to anon', async () => {
    const { db } = await seeded()
    await expect(stats(db, A)).rejects.toThrow(/permission denied/)
    const acl = (await db.query<any>(`select has_function_privilege('anon', 'public.service_stats()', 'execute') anon,
      has_function_privilege('authenticated', 'public.service_stats()', 'execute') auth,
      has_function_privilege('service_role', 'public.service_stats()', 'execute') svc,
      exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = 'public.service_stats()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') pub`)).rows[0]
    expect(acl).toEqual({ anon: true, auth: false, svc: false, pub: false })
    await expect(asUser(db, null, () => db.query('select * from public.attendance'))).rejects.toThrow(/permission denied/)
  })

  it('migration up / down / up on existing data: data unchanged, only this function added and removed', async () => {
    const { db } = await seeded({ before: true })
    const h = await dataHash(db)
    const fns = async () => (await db.query<{ s: string }>(`select oid::regprocedure::text s from pg_proc
      where pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`)).rows.map((r) => r.s)
    const before = await fns()
    await applyMigration(db, MIG)
    expect((await fns()).filter((f) => !before.includes(f))).toEqual(['service_stats()'])
    expect(await dataHash(db)).toBe(h)
    await db.exec(DOWN)
    expect(await fns()).toEqual(before)
    await applyMigration(db, MIG)
    expect((await stats(db)).teams).toBe(2)
  })
})
