// Phase 5-B U4-Fix2: events, revoking invitations and account deletion take the user's locks first.
// PGlite has ONE connection, so the real parallel behaviour is verified on a local Supabase
// (separate connections). Here: the locks are really taken, they come before every check in the SQL,
// behaviour is otherwise unchanged, and the migration and its rollback are safe.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261117235500_member_lock_fix2.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117235500_member_lock_fix2_down.sql'), 'utf8')
const U = (n: number) => `54600000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADMIN = U(2), MEM = U(3), FAM = U(4), OUT = U(5)
const MEMBER_FNS = ['create_event', 'update_event', 'delete_event', 'revoke_guardian_invitation']
const FIXED = [...MEMBER_FNS, 'purge_account_data']

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = []) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)
}
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0]
const num = async (db: Db, sql: string, params: unknown[] = []) => Number(Object.values(await one(db, sql, params))[0])
const joinOld = (db: Db, u: string, share: string) => joinTeamAs(db, u, share, 'm')
const regChild = (db: Db, u: string, team: string, name: string) => q(db, u, `select public.register_player($1, $2, null, true) as r`, [team, name]).then((r) => r[0].r.player_id as string)
const invite = (db: Db, u: string, player: string) => q(db, u, `select public.create_guardian_invitation($1) as r`, [player]).then((r) => r[0].r)
const accept = (db: Db, u: string, token: string) => q(db, u, `select public.accept_guardian_invitation($1, '家族') as r`, [token]).then((r) => r[0].r)
const remove = (db: Db, by: string, team: string, u: string) => q(db, by, `select public.remove_member($1, $2) as r`, [team, u]).then((r) => r[0].r)
const newEvent = (db: Db, u: string, team: string, title = '練習') => q(db, u, `select public.create_event($1, $2, now() + interval '1 day') as id`, [team, title]).then((r) => r[0].id as string)
async function purge(db: Db, u: string) {
  await db.exec('set role service_role')
  try { return (await db.query<any>(`select public.purge_account_data($1, $2) as r`, [u, u])).rows[0].r }
  finally { await db.exec('reset role') }
}

/** Team T (OWNER; ADMIN as admin; MEM, FAM members), one event by ADMIN, FAM's child shared with MEM. */
async function setup(opts: { before?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : {})
  for (let i = 1; i <= 5; i++) await addUser(db, U(i))
  const [t] = await q(db, OWNER, `select id, share_token from public.create_team('チームT', 'オーナー')`)
  for (const u of [ADMIN, MEM, FAM]) await joinOld(db, u, t.share_token)
  await q(db, OWNER, `select public.set_member_role($1, $2, 'admin')`, [t.id, ADMIN])
  const ev = await newEvent(db, ADMIN, t.id)
  const kid = await regChild(db, FAM, t.id, 'こども')
  await accept(db, MEM, (await invite(db, FAM, kid)).token)
  return { db, t: t as { id: string; share_token: string }, ev, kid }
}

/** Is the transaction-scoped advisory lock `key` held right now (this session)? */
async function holds(db: Db, key: string) {
  return (await num(db, `
    select count(*) from pg_locks l, (select hashtextextended($1, 0) k) h
     where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
       and l.classid::bigint = ((h.k >> 32) & 4294967295) and l.objid::bigint = (h.k & 4294967295)`, [key])) > 0
}
/** Runs `fn` inside an open transaction, returns which of `keys` are held afterwards, then rolls back. */
async function locksAfter(db: Db, fn: () => Promise<unknown>, keys: string[]) {
  await db.exec('begin')
  try {
    await fn()
    const held: Record<string, boolean> = {}
    for (const k of keys) held[k] = await holds(db, k)
    return held
  } finally {
    await db.exec('rollback')
  }
}
const src = async (db: Db, fn: string) => (await one(db, `select prosrc from pg_proc where oid = $1::regproc`, [`public.${fn}`])).prosrc as string

describe('U4-Fix2: the user\'s locks come first', () => {
  it('in the four member functions the account lock precedes every role / guardian check and every read', async () => {
    const { db } = await setup()
    for (const fn of MEMBER_FNS) {
      const s = await src(db, fn)
      const lock = s.search(/private\.xlock\('membership:' \|\| (v_uid|auth\.uid\(\))::text\)/)
      expect(lock, fn).toBeGreaterThan(0)
      for (const re of [/private\.is_team_admin\(/, /private\.is_guardian\(/, /from public\.events/, /from public\.guardian_invitations/, /insert into public\.events/, /update public\.events/, /update public\.guardian_invitations/]) {
        const at = s.search(re)
        if (at >= 0) expect(at, `${fn}: ${re}`).toBeGreaterThan(lock)
      }
    }
  })

  it('purge_account_data: purge lock -> owner-quota lock -> account lock, all before reading or locking any row', async () => {
    const { db } = await setup()
    const s = await src(db, 'purge_account_data')
    const a = s.indexOf(`'purge:' || p_user`), b = s.indexOf('private.lock_owner_quota(p_user)'), c = s.indexOf(`private.xlock('membership:' || p_user::text)`)
    const firstRead = Math.min(...['from auth.users', 'from private.account_deletions', 'from auth.sessions', 'for update'].map((x) => s.indexOf(x)).filter((i) => i >= 0))
    expect(a).toBeGreaterThan(0)
    expect([a < b, b < c, c < firstRead]).toEqual([true, true, true])
  })

  it('the locks are really held by each operation (successful calls, inside the transaction)', async () => {
    const { db, t, ev, kid } = await setup()
    const m = (u: string) => 'membership:' + u
    expect(await locksAfter(db, () => newEvent(db, ADMIN, t.id, '追加'), [m(ADMIN)])).toEqual({ [m(ADMIN)]: true })
    expect(await locksAfter(db, () => q(db, ADMIN, `select public.update_event($1, '変更', now() + interval '2 days')`, [ev]), [m(ADMIN)])).toEqual({ [m(ADMIN)]: true })
    expect(await locksAfter(db, () => q(db, ADMIN, `select public.delete_event($1)`, [ev]), [m(ADMIN)])).toEqual({ [m(ADMIN)]: true })
    const inv = await invite(db, FAM, kid)
    expect(await locksAfter(db, () => q(db, MEM, `select public.revoke_guardian_invitation($1)`, [inv.id]), [m(MEM)])).toEqual({ [m(MEM)]: true })
    expect(await locksAfter(db, () => purge(db, OUT), ['owner-quota:' + OUT, m(OUT), 'purge:' + OUT]))
      .toEqual({ ['owner-quota:' + OUT]: true, [m(OUT)]: true, ['purge:' + OUT]: true })
  })
})

describe('U4-Fix2: behaviour unchanged', () => {
  it('admins create, change and delete events; plain members and outsiders are refused', async () => {
    const { db, t, ev } = await setup()
    const e2 = await newEvent(db, OWNER, t.id, 'オーナーの予定')
    await q(db, ADMIN, `select public.update_event($1, '変更後', now() + interval '2 days', '体育館', 'メモ')`, [e2])
    expect((await one(db, `select title, location, note, updated_by from public.events where id = $1`, [e2]))).toMatchObject({ title: '変更後', location: '体育館', note: 'メモ', updated_by: ADMIN })
    await q(db, ADMIN, `select public.delete_event($1)`, [e2])
    expect((await one(db, `select deleted_by from public.events where id = $1`, [e2])).deleted_by).toBe(ADMIN)
    await expect(newEvent(db, MEM, t.id)).rejects.toThrow(/forbidden/)
    await expect(newEvent(db, OUT, t.id)).rejects.toThrow(/forbidden/)
    await expect(q(db, MEM, `select public.update_event($1, 'x', now())`, [ev])).rejects.toThrow(/forbidden/)
    await expect(q(db, OUT, `select public.delete_event($1)`, [ev])).rejects.toThrow(/forbidden/)
    await expect(q(db, ADMIN, `select public.delete_event($1)`, [e2])).rejects.toThrow(/not_found/)     // already deleted
    await expect(q(db, ADMIN, `select public.update_event($1, 'x', now())`, [U(99)])).rejects.toThrow(/not_found/)
  })

  it('event limits still apply (team_events) after the account lock', async () => {
    const { db, t } = await setup()
    await db.query(`insert into public.events (team_id, title, starts_at, created_by, created_at)
      select $1, 'bulk', now(), $2, now() - interval '2 days' from generate_series(1, 1999)`, [t.id, ADMIN])
    await expect(newEvent(db, ADMIN, t.id)).rejects.toThrow(/team_event_limit_exceeded/)
  })

  it('guardians revoke invitations (also one made by the co-guardian); others are refused; used ones stay used', async () => {
    const { db, kid } = await setup()
    const i1 = await invite(db, FAM, kid)
    await q(db, MEM, `select public.revoke_guardian_invitation($1)`, [i1.id])
    expect((await one(db, `select revoked_at from public.guardian_invitations where id = $1`, [i1.id])).revoked_at).not.toBeNull()
    const i2 = await invite(db, FAM, kid)
    await expect(q(db, OUT, `select public.revoke_guardian_invitation($1)`, [i2.id])).rejects.toThrow(/forbidden/)
    await expect(q(db, ADMIN, `select public.revoke_guardian_invitation($1)`, [i2.id])).rejects.toThrow(/forbidden/)
    await expect(q(db, MEM, `select public.revoke_guardian_invitation($1)`, [U(98)])).rejects.toThrow(/forbidden/)
    await accept(db, OUT, i2.token)
    await q(db, FAM, `select public.revoke_guardian_invitation($1)`, [i2.id])                    // no effect on a used one
    expect((await one(db, `select revoked_at, used_by from public.guardian_invitations where id = $1`, [i2.id]))).toMatchObject({ revoked_at: null, used_by: OUT })
  })

  it('after removal the removed admin / member is refused for events and revoking', async () => {
    const { db, t, ev, kid } = await setup()
    const inv = await invite(db, FAM, kid)
    await remove(db, OWNER, t.id, ADMIN)
    await remove(db, OWNER, t.id, MEM)
    await expect(newEvent(db, ADMIN, t.id)).rejects.toThrow(/forbidden/)
    await expect(q(db, ADMIN, `select public.update_event($1, 'x', now())`, [ev])).rejects.toThrow(/forbidden/)
    await expect(q(db, ADMIN, `select public.delete_event($1)`, [ev])).rejects.toThrow(/forbidden/)
    await expect(q(db, MEM, `select public.revoke_guardian_invitation($1)`, [inv.id])).rejects.toThrow(/forbidden/)
    expect((await one(db, `select deleted_at, title from public.events where id = $1`, [ev]))).toMatchObject({ deleted_at: null, title: '練習' })
    expect((await one(db, `select revoked_at from public.guardian_invitations where id = $1`, [inv.id])).revoked_at).toBeNull()
  })

  it('account deletion: same result shape and effects; afterwards the user is refused / pending', async () => {
    const { db, t, ev, kid } = await setup()
    await q(db, MEM, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])
    const r = await purge(db, MEM)
    expect(r).toMatchObject({ status: 'purged', retry: false, teams_closed: 0, children_deleted: 0, guardian_links_removed: 1, memberships_removed: 1, self_registrations_deleted: 0 })
    expect(Object.keys(r).sort()).toEqual(['children_deleted', 'guardian_links_removed', 'invitations_deleted', 'memberships_removed', 'retry', 'self_registrations_deleted', 'status', 'teams_closed'])
    expect(await num(db, `select count(*) from public.player_guardians where player_id = $1 and user_id = $2`, [kid, FAM])).toBe(1)   // child stays with FAM
    expect(await num(db, `select count(*) from public.attendance where player_id = $1 and updated_by is null`, [kid])).toBe(1)      // answer kept, anonymised
    await expect(q(db, MEM, `select public.create_team('新', 'x')`)).rejects.toThrow(/account_deletion_pending/)
    await expect(joinOld(db, MEM, t.share_token)).rejects.toThrow(/account_deletion_pending/)
    await expect(q(db, MEM, `select public.register_self($1)`, [t.id])).rejects.toThrow(/forbidden/)
    expect((await purge(db, MEM)).retry).toBe(true)                                                   // retry still allowed
    await db.query('delete from auth.users where id = $1', [MEM])
    expect((await purge(db, MEM)).status).toBe('already_deleted')
  })

  it('account deletion refusals are unchanged (owner with members, stale login)', async () => {
    const { db } = await setup()
    await expect(purge(db, OWNER)).rejects.toThrow(/owner_must_transfer/)
    await db.query(`update auth.sessions set created_at = now() - interval '1 hour' where user_id = $1`, [FAM])
    await expect(purge(db, FAM)).rejects.toThrow(/reauth_required/)
  })

  it('signatures, return types, security definer, search_path and grants are unchanged', async () => {
    const before = await setup({ before: true })
    const after = await setup()
    const sig = (db: Db) => db.query<{ k: string }>(`
      select p.oid::regprocedure || ' ret=' || pg_get_function_result(p.oid) || ' def=' || prosecdef || ' vol=' || provolatile::text || ' cfg=' || coalesce(proconfig::text, '') || ' acl=' || coalesce(proacl::text, '') k
        from pg_proc p where pronamespace = 'public'::regnamespace and proname = any($1) order by 1`, [FIXED]).then((r) => r.rows.map((x) => x.k))
    expect(await sig(after.db)).toEqual(await sig(before.db))
    for (const fn of MEMBER_FNS) {
      expect((await one(after.db, `select has_function_privilege('anon', $1::regproc, 'execute') x`, [`public.${fn}`])).x, fn).toBe(false)
      expect((await one(after.db, `select has_function_privilege('authenticated', $1::regproc, 'execute') x`, [`public.${fn}`])).x, fn).toBe(true)
      expect((await src(after.db, fn)).includes('private.require_auth()'), fn).toBe(true)
    }
    for (const role of ['anon', 'authenticated'])
      expect((await one(after.db, `select has_function_privilege($1, 'public.purge_account_data(uuid, uuid, interval)', 'execute') x`, [role])).x, role).toBe(false)
  })
})

describe('U4-Fix2: migration and rollback', () => {
  async function fns(db: Db) {
    return (await db.query<{ k: string }>(`
      select p.oid::regprocedure || ' def=' || prosecdef || ' vol=' || provolatile::text || ' acl=' || coalesce(proacl::text, '') || ' ' || md5(prosrc) k
        from pg_proc p where pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`)).rows.map((x) => x.k)
  }
  async function dataHash(db: Db) {
    return (await one(db, `select md5(concat_ws('|',
      (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
      (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m),
      (select string_agg(to_jsonb(p)::text, ',' order by id) from public.players p),
      (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g),
      (select string_agg(to_jsonb(e)::text, ',' order by id) from public.events e),
      (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
      (select string_agg(to_jsonb(i)::text, ',' order by id) from public.guardian_invitations i))) as h`)).h as string
  }

  it('applying to existing data changes no row; only the five function bodies change', async () => {
    const { db, ev, kid } = await setup({ before: true })
    await q(db, MEM, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])
    const data = await dataHash(db), f0 = await fns(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(data)
    const f1 = await fns(db)
    const changed = f1.filter((k) => !f0.includes(k)).map((k) => k.split('(')[0]!.replace(/^public\./, ''))
    expect(changed.sort()).toEqual([...FIXED].sort())
    expect(f1.length).toBe(f0.length)
  })

  it('rollback restores the previous functions exactly; data is kept; applying again works', async () => {
    const { db, t, ev } = await setup({ before: true })
    const f0 = await fns(db)
    await applyMigration(db, MIG)
    await q(db, ADMIN, `select public.update_event($1, '変更', now() + interval '2 days')`, [ev])
    const data = await dataHash(db)
    await db.exec(DOWN)
    expect(await fns(db)).toEqual(f0)
    expect(await dataHash(db)).toBe(data)
    await newEvent(db, ADMIN, t.id, 'ロールバック後')                          // still works after rollback
    await applyMigration(db, MIG)
    const m = 'membership:' + ADMIN
    expect(await locksAfter(db, () => newEvent(db, ADMIN, t.id, '再適用後'), [m])).toEqual({ [m]: true })
  })

  it('applying twice is harmless; a failure while applying leaves nothing behind', async () => {
    const { db } = await setup({ before: true })
    const f0 = await fns(db)
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations', MIG), 'utf8')
    await expect(db.exec(`begin; ${sql}; select 1/0; commit;`)).rejects.toThrow()
    await db.exec('rollback').catch(() => {})
    expect(await fns(db)).toEqual(f0)
    await applyMigration(db, MIG)
    const f1 = await fns(db)
    await applyMigration(db, MIG)
    expect(await fns(db)).toEqual(f1)
  })
})
