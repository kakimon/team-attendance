// D6-B3: my_suspended_memberships returns the CURRENT team name, only to the stopped member, only for
// their own stopped memberships. Nothing else is returned and ordinary reads stay closed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { pgliteClient } from './pgliteClient'
import { addUser, applyMigration, asUser, createDb, type Db } from './setup'

const MIG = '20261118200000_suspended_team_names.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261118200000_suspended_team_names_down.sql'), 'utf8')
const U = (n: number) => `55500000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), MEM = U(2), OTHER = U(3), OUT = U(4), MEM2 = U(5)
const q = (db: Db, u: string | null, s: string, p: unknown[] = []) => asUser(db, u, () => db.query<any>(s, p)).then((r) => r.rows)
const rpc = async (db: Db, u: string, s: string, p: unknown[] = []) => (await q(db, u, `select to_jsonb(public.${s}) as r`, p))[0].r
const mine = (db: Db, u: string) => q(db, u, 'select * from public.my_suspended_memberships()')

async function setup(opts: { before?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : {})
  for (const u of [OWNER, MEM, OTHER, OUT, MEM2]) await addUser(db, u)
  const t = await rpc(db, OWNER, "create_team('ひまわり','O')")
  const token = (await rpc(db, OWNER, 'get_join_link($1)', [t.id])).token
  for (const u of [MEM, OTHER, MEM2]) await rpc(db, u, "join_by_token($1,'M')", [token])
  const t2 = await rpc(db, OTHER, "create_team('別チーム','X')")
  await rpc(db, MEM, "join_by_token($1,'M')", [(await rpc(db, OTHER, 'get_join_link($1)', [t2.id])).token])
  return { db, t, t2 }
}

describe('team names for stopped memberships', () => {
  it('the stopped member gets id, date and the current team name only; ordinary reads stay closed', async () => {
    const { db, t } = await setup()
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM])
    const rows = await mine(db, MEM)
    expect(rows).toEqual([{ team_id: t.id, suspended_at: expect.anything(), team_name: 'ひまわり' }])
    expect(Object.keys(rows[0]).sort()).toEqual(['suspended_at', 'team_id', 'team_name'])
    expect(await q(db, MEM, 'select * from public.teams where id = $1', [t.id])).toEqual([])
    expect(await q(db, MEM, 'select * from public.team_members where team_id = $1', [t.id])).toEqual([])
    await db.query('update public.teams set name = $1 where id = $2', ['ひまわり（新）', t.id])  // the latest name, no history
    expect((await mine(db, MEM))[0].team_name).toBe('ひまわり（新）')
  })

  it('other people, active members, non-members and the owner get nothing; only one\'s own stopped rows', async () => {
    const { db, t, t2 } = await setup()
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM])
    await rpc(db, OTHER, 'suspend_member($1,$2)', [t2.id, MEM])
    for (const u of [OWNER, OTHER, OUT, MEM2]) expect(await mine(db, u), u).toEqual([])
    expect((await mine(db, MEM)).map((r: any) => r.team_name).sort()).toEqual(['ひまわり', '別チーム'])
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM2])
    expect((await mine(db, MEM2)).map((r: any) => r.team_id)).toEqual([t.id])         // not MEM's other team
  })

  it('after resume, after the own cleanup and after removal: nothing', async () => {
    const { db, t } = await setup()
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM])
    await rpc(db, OWNER, 'resume_member($1,$2)', [t.id, MEM])
    expect(await mine(db, MEM)).toEqual([])
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM])
    const pv = await rpc(db, MEM, 'suspended_leave_preview($1)', [t.id])
    await rpc(db, MEM, "leave_suspended_team($1,$2,'登録と出欠を削除して脱退する')", [t.id, pv.fingerprint])
    expect(await mine(db, MEM)).toEqual([])
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM2])
    await rpc(db, OWNER, 'remove_member($1,$2)', [t.id, MEM2])                         // no self registration: removable
    expect(await mine(db, MEM2)).toEqual([])
  })

  it('privileges: authenticated only (anon refused), security definer, fixed search_path, requires a live session', async () => {
    const { db } = await setup()
    const f = (await db.query<any>(`select prosecdef, proconfig::text cfg, has_function_privilege('anon', oid, 'execute') anon,
      has_function_privilege('authenticated', oid, 'execute') auth, prosrc from pg_proc where oid = 'public.my_suspended_memberships()'::regprocedure`)).rows[0]
    expect(f).toMatchObject({ prosecdef: true, anon: false, auth: true })
    expect(f.cfg).toContain('search_path=')
    expect(f.prosrc).toContain('private.require_auth()')
    await db.query('delete from auth.sessions where user_id = $1', [MEM])
    await expect(mine(db, MEM)).rejects.toThrow(/session_expired/)
  })

  it('the app data layer passes the name through; on an older DB (before this migration) the name is missing, nothing breaks', async () => {
    const now = await setup()
    await rpc(now.db, OWNER, 'suspend_member($1,$2)', [now.t.id, MEM])
    expect(await createSupabaseRepo(pgliteClient(now.db, MEM), () => MEM).mySuspendedMemberships())
      .toEqual([{ team_id: now.t.id, suspended_at: expect.any(String), team_name: 'ひまわり' }])
    const old = await setup({ before: true })
    await rpc(old.db, OWNER, 'suspend_member($1,$2)', [old.t.id, MEM])
    const rows = await createSupabaseRepo(pgliteClient(old.db, MEM), () => MEM).mySuspendedMemberships()
    expect(rows).toEqual([{ team_id: old.t.id, suspended_at: expect.any(String) }])
    expect(rows[0]!.team_name ?? null).toBeNull()
  })
})

describe('migration and rollback', () => {
  const fn = async (db: Db) => (await db.query<any>(`select pg_get_functiondef(oid) d, proacl::text acl from pg_proc where oid = 'public.my_suspended_memberships()'::regprocedure`)).rows[0]
  it('rollback restores the D6-B1 definition and grants exactly; data unchanged; re-apply works; failure is atomic', async () => {
    const { db, t } = await setup({ before: true })
    await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, MEM])
    const before = await fn(db)
    const data = JSON.stringify(await db.query('select * from public.team_members order by team_id, user_id').then((r) => r.rows))
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations', MIG), 'utf8')
    await expect(db.exec(`${sql.replace(/\bcommit;\s*$/, '')} select 1/0; commit;`)).rejects.toThrow()
    await db.exec('rollback').catch(() => {})
    expect(await fn(db)).toEqual(before)
    await applyMigration(db, MIG)
    expect((await mine(db, MEM))[0].team_name).toBe('ひまわり')
    await db.exec(DOWN)
    expect(await fn(db)).toEqual(before)
    expect(await mine(db, MEM)).toEqual([{ team_id: t.id, suspended_at: expect.anything() }])
    expect(JSON.stringify(await db.query('select * from public.team_members order by team_id, user_id').then((r) => r.rows))).toBe(data)
    await applyMigration(db, MIG)
    expect((await mine(db, MEM))[0].team_name).toBe('ひまわり')
  })
})
