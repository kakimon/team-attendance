// Applying 20261113000000_account_deletion to a database that already has data,
// failing atomically, and rolling back with supabase/rollback/*_down.sql.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db } from './setup'

// Phase 4-B adds two migrations, applied in this order (and rolled back in reverse).
const MIG = '20261113000000_account_deletion.sql'
const MIG2 = '20261113100000_session_bound_reads.sql'
const RB = (f: string) => readFileSync(join(import.meta.dirname, '../../supabase/rollback', f), 'utf8')
const DOWN = RB('20261113100000_session_bound_reads_down.sql') + '\n' + RB('20261113000000_account_deletion_down.sql')
const applyBoth = async (db: Db) => { await applyMigration(db, MIG); await applyMigration(db, MIG2) }
const PREFLIGHT = readFileSync(join(import.meta.dirname, '../../scripts/preflight-account-deletion.sql'), 'utf8')
const U = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const q = (db: Db, u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<any>(sql, p)).rows)

/** A pre-migration database with every kind of row the app can create. */
async function seeded() {
  const db = await createDb({ before: MIG })
  for (let i = 1; i <= 5; i++) await addUser(db, U(i))
  const [t] = await q(db, U(1), `select id, share_token from public.create_team('既存チーム', '代表')`)
  for (const i of [2, 3, 4]) await q(db, U(i), `select public.join_team($1, 'm')`, [t.share_token])
  await q(db, U(1), `select public.set_member_role($1, $2, 'admin')`, [t.id, U(2)])
  const [{ id: e1 }] = await q(db, U(1), `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const [{ id: e2 }] = await q(db, U(2), `select public.create_event($1, '試合', now() + interval '2 day') as id`, [t.id])
  const reg = async (u: string, n: string) => (await q(db, u, `select public.register_player($1, $2, '4年', true) as r`, [t.id, n]))[0].r.player_id
  const k1 = await reg(U(3), 'きょうだい'), k2 = await reg(U(4), 'ひとり'), k3 = await reg(U(4), '取り消す子')
  const [{ r: inv }] = await q(db, U(3), `select public.create_guardian_invitation($1) as r`, [k1])
  await q(db, U(4), `select public.accept_guardian_invitation($1, 'm')`, [inv.token])
  await q(db, U(3), `select public.create_guardian_invitation($1)`, [k1])                  // unused
  await q(db, U(3), `select public.set_attendance($1, $2, 'attend', 'コメント')`, [e1, k1])
  await q(db, U(4), `select public.set_attendance($1, $2, 'absent')`, [e1, k2])
  await q(db, U(1), `select public.update_event($1, '練習（変更）', now() + interval '3 day')`, [e1])
  await q(db, U(2), `select public.delete_event($1)`, [e2])
  await q(db, U(4), `select public.archive_player($1)`, [k3])
  await q(db, U(5), `select public.create_team('ひとりチーム', 'S')`)
  return db
}

async function dataHash(db: Db) {
  return (await db.query<{ h: string }>(`select md5(concat_ws('|',
    (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
    (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m),
    (select string_agg(to_jsonb(p)::text, ',' order by id) from public.players p),
    (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g),
    (select string_agg(to_jsonb(e)::text, ',' order by id) from public.events e),
    (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
    (select string_agg(to_jsonb(i)::text, ',' order by id) from public.guardian_invitations i))) as h`)).rows[0]!.h
}

/** Everything about the schema that the migration touches. */
async function schema(db: Db) {
  const r = await db.query<{ k: string }>(`
    select 'tbl ' || n.nspname || '.' || c.relname || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(c.relacl::text, '') k
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'i')
    union all select 'col ' || attrelid::regclass || '.' || attname || ' nn=' || attnotnull from pg_attribute
      where attrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind = 'r')
        and attnum > 0 and not attisdropped
    union all select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
      where connamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'trg ' || tgrelid::regclass || ' ' || tgname from pg_trigger where not tgisinternal
    union all select 'fn ' || p.oid::regprocedure || ' def=' || prosecdef || ' vol=' || provolatile::text || ' acl=' || coalesce(proacl::text, '') || ' ' || md5(prosrc)
      from pg_proc p where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select 'pol ' || polrelid::regclass || ' ' || polname from pg_policy
    order by 1`)
  return r.rows.map((x) => x.k)
}

describe('applying the migration to existing data', () => {
  it('changes no data, keeps one owner per team, and the old rows work with the new functions', async () => {
    const db = await seeded()
    const before = await dataHash(db)
    const pre = (await db.query<any>(PREFLIGHT)).rows
    expect(pre.filter((r) => r.expected === '0').map((r) => r.value)).toEqual(['0', '0', '0', '0'])
    await applyBoth(db)
    expect(await dataHash(db)).toBe(before)
    expect((await db.query<any>(PREFLIGHT)).rows[0].value).toBe('1')                      // now reports "applied"
    const owners = await db.query<any>(`select team_id, count(*)::int n from public.team_members where role = 'owner' group by 1`)
    expect(owners.rows.every((r) => r.n === 1)).toBe(true)
    const pv = (await q(db, U(4), 'select public.account_deletion_preview() as r'))[0].r
    expect(pv.children_kept_by_family.map((c: any) => c.name)).toEqual(['きょうだい'])
    expect(pv.children_to_delete.map((c: any) => c.name)).toEqual(['ひとり'])          // the cancelled child is not listed...
    const r = await (async () => { await db.exec('set role service_role'); try { return (await db.query<any>('select public.purge_account_data($1, $2) r', [U(4), U(4)])).rows[0].r } finally { await db.exec('reset role') } })()
    expect(r.children_deleted).toBe(2)                                                    // ...but is deleted too (no data left behind)
  })

  it('a migration that hits bad existing data fails as a whole and changes nothing', async () => {
    const db = await seeded()
    const [{ team_id }] = (await db.query<any>(`select team_id from public.team_members where role = 'owner' limit 1`)).rows
    await db.query(`update public.team_members set role = 'owner' where team_id = $1 and role = 'admin'`, [team_id]) // 2 owners
    const s0 = await schema(db), d0 = await dataHash(db)
    expect((await db.query<any>(PREFLIGHT)).rows.find((r) => r.item.startsWith('teams without'))!.value).toBe('1') // pre-flight catches it
    await expect(applyMigration(db, MIG)).rejects.toThrow(/team_members_one_owner|duplicate|could not create unique index/)
    expect(await schema(db)).toEqual(s0)
    expect(await dataHash(db)).toBe(d0)
  })
})

describe('rollback (supabase/rollback)', () => {
  it('restores the previous schema exactly and keeps the data; the migration can be applied again', async () => {
    const db = await seeded()
    const s0 = await schema(db), d0 = await dataHash(db)
    await applyBoth(db)
    expect(await schema(db)).not.toEqual(s0)
    await db.exec(DOWN)
    expect(await schema(db)).toEqual(s0)
    expect(await dataHash(db)).toBe(d0)
    await applyBoth(db)                                                                     // re-apply works
  })

  it('after real deletions: recorder columns stay nullable, everything else is restored, old RPCs work', async () => {
    const db = await seeded()
    await applyBoth(db)
    await db.exec('set role service_role')
    await db.query('select public.purge_account_data($1, $2)', [U(1), U(1)]).catch(() => {}) // owner: refused (members)
    await db.query('select public.purge_account_data($1, $2)', [U(3), U(3)])
    await db.exec('reset role')
    await db.query('delete from auth.users where id = $1', [U(3)])
    await db.exec(DOWN)
    const nn = (await db.query<any>(`select attname, attnotnull from pg_attribute where attrelid = 'public.attendance'::regclass and attname = 'updated_by'`)).rows[0]
    expect(nn.attnotnull).toBe(false)                                                       // NULLs exist -> kept nullable
    expect((await db.query<any>(`select attnotnull from pg_attribute where attrelid = 'public.teams'::regclass and attname = 'created_by'`)).rows[0].attnotnull).toBe(true)
    await q(db, U(4), `select public.create_team('ロールバック後', 'x')`)
  })
})

describe('behaviour before / after the migrations (logged-out token)', () => {
  it('before: a logged-out token still reads and writes; after: it reads nothing and cannot write', async () => {
    const db = await seeded()
    const logout = (u: string) => db.query('delete from auth.sessions where id = $1', [u])
    await logout(U(3))
    expect((await q(db, U(3), 'select count(*)::int n from public.players'))[0].n).toBeGreaterThan(0) // the gap
    await q(db, U(3), `select public.create_team('ログアウト後', 'x')`)                                   // the gap
    await applyBoth(db)
    expect((await q(db, U(3), 'select count(*)::int n from public.players'))[0].n).toBe(0)
    await expect(q(db, U(3), `select public.create_team('x', 'x')`)).rejects.toThrow(/session_expired/)
    expect((await q(db, U(4), 'select count(*)::int n from public.players'))[0].n).toBeGreaterThan(0) // logged-in user: unchanged
  })
})
