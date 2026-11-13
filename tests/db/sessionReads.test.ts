// Reads (RLS SELECT + data-returning RPCs) require a live login session (20261113100000).
// A token whose session was logged out / deleted reads nothing, even before it expires.
import { describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, type Db } from './setup'

const U = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const O = U(1), P = U(2), P2 = U(3)
const TABLES = ['teams', 'team_members', 'players', 'player_guardians', 'events', 'attendance', 'guardian_invitations', 'team_owner_transfers']
const q = (db: Db, u: string, sql: string, p: unknown[] = [], session: string | null = u) =>
  asUser(db, u, async () => (await db.query<any>(sql, p)).rows, session)

async function scenario() {
  const db = await createDb()
  for (const u of [O, P, P2]) await addUser(db, u)
  const [t] = await q(db, O, `select id, share_token from public.create_team('チーム', '代表')`)
  for (const u of [P, P2]) await q(db, u, `select public.join_team($1, 'm')`, [t.share_token])
  const [{ id: ev }] = await q(db, O, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const kid = (await q(db, P, `select public.register_player($1, 'こども', null, true) as r`, [t.id]))[0].r.player_id
  await q(db, P, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])
  await q(db, P, `select public.create_guardian_invitation($1)`, [kid])
  await q(db, O, `select public.request_owner_transfer($1, $2)`, [t.id, P])
  return { db, t, ev, kid }
}
/** Rows visible per table for P (P is involved in every table). */
const visible = async (db: Db, session: string | null) => {
  const out: Record<string, number> = {}
  for (const tb of TABLES) out[tb] = (await q(db, P, `select count(*)::int n from public.${tb}`, [], session))[0].n
  return out
}
const READ_RPCS = (s: Awaited<ReturnType<typeof scenario>>) => [
  ['select public.get_team_by_share_token($1)', [s.t.share_token]],
  [`select public.find_similar_players($1, 'こども')`, [s.t.id]],
  ['select public.event_attendance_summary($1)', [s.ev]],
  ['select public.account_deletion_preview()', []],
  ['select public.my_owner_transfers()', []],
] as const

describe('logged-in users read as before', () => {
  it('sees every kind of row and every read RPC works', async () => {
    const s = await scenario()
    const v = await visible(s.db, P)
    for (const tb of TABLES) expect(v[tb], tb).toBeGreaterThan(0)
    for (const [sql, p] of READ_RPCS(s)) await q(s.db, P, sql, [...p])
  })
})

describe('a token whose session is gone reads nothing', () => {
  it('after logout: 0 rows from every table, read RPCs refused; a new login reads again', async () => {
    const s = await scenario()
    await s.db.query('delete from auth.sessions where id = $1', [P])       // logout on that device
    expect(Object.values(await visible(s.db, P)).every((n) => n === 0)).toBe(true)
    for (const [sql, p] of READ_RPCS(s)) await expect(q(s.db, P, sql, [...p])).rejects.toThrow(/session_expired/)
    await expect(q(s.db, P, `select public.set_attendance($1, $2, 'absent')`, [s.ev, s.kid])).rejects.toThrow(/session_expired/)
    const fresh = (await s.db.query<{ id: string }>('insert into auth.sessions (id, user_id) values (gen_random_uuid(), $1) returning id', [P])).rows[0]!.id
    expect((await visible(s.db, fresh)).players).toBe(1)
  })

  it('no session_id, a malformed one, or someone else\'s session: 0 rows', async () => {
    const s = await scenario()
    for (const bad of [null, 'not-a-uuid', O]) {
      expect(Object.values(await visible(s.db, bad)).every((n) => n === 0), String(bad)).toBe(true)
    }
  })

  it('other users are not affected by someone\'s logout', async () => {
    const s = await scenario()
    await s.db.query('delete from auth.sessions where id = $1', [P])
    expect((await q(s.db, P2, 'select count(*)::int n from public.players'))[0].n).toBe(1)
  })
})

describe('every read path is covered (catches a future table or RPC that forgets it)', () => {
  it('all SELECT policies require the session; all browser-callable definer RPCs call require_auth', async () => {
    const db = await createDb()
    const pol = (await db.query<any>(`select tablename, qual from pg_policies where schemaname = 'public'`)).rows
    expect(pol.map((p) => p.tablename).sort()).toEqual([...TABLES].sort())
    for (const p of pol) expect(p.qual, p.tablename).toContain('session_ok()')
    const views = (await db.query<any>(`select table_name from information_schema.views where table_schema in ('public', 'private')`)).rows
    expect(views).toEqual([])
    const fns = (await db.query<any>(`select p.proname, p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')`)).rows
    expect(fns.length).toBeGreaterThan(15)
    for (const f of fns) expect(f.prosrc, f.proname).toContain('private.require_auth()')
    const anonFns = (await db.query<any>(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
      and has_function_privilege('anon', p.oid, 'execute')`)).rows.map((r) => r.proname)
    expect(anonFns).toEqual(['health_check'])
  })

  it('the session check runs once per query (InitPlan), not per row', async () => {
    const s = await scenario()
    const plan = (await q(s.db, P, 'explain select * from public.players')).map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).toMatch(/InitPlan/)
  })
})
