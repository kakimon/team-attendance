// Phase 5-B U4-Fix: member-scoped writes take the caller's account lock before any check.
// PGlite has ONE connection, so the real parallel behaviour is verified on a local Supabase
// (separate connections). Here: the lock is really taken, it comes before every membership /
// guardian / owner check in the SQL, behaviour is otherwise unchanged, and the migration and its
// rollback are safe.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261117234500_member_lock_fix.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117234500_member_lock_fix_down.sql'), 'utf8')
const U = (n: number) => `54500000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), MEM = U(2), FAM = U(3), OUT = U(4)

const FIXED = [
  'set_attendance', 'register_player', 'accept_guardian_invitation', 'register_self',
  'update_player', 'archive_player', 'create_guardian_invitation',
]

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = []) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)
}
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0]
const num = async (db: Db, sql: string, params: unknown[] = []) => Number(Object.values(await one(db, sql, params))[0])
const isMember = async (db: Db, team: string, u: string) => (await num(db, `select count(*) from public.team_members where team_id = $1 and user_id = $2`, [team, u])) === 1
const remove = (db: Db, by: string, team: string, u: string) => q(db, by, `select public.remove_member($1, $2) as r`, [team, u]).then((r) => r[0].r)
const joinOld = (db: Db, u: string, share: string) => joinTeamAs(db, u, share, 'm')
const regSelf = (db: Db, u: string, team: string) => q(db, u, `select public.register_self($1) as r`, [team]).then((r) => r[0].r)
const regChild = (db: Db, u: string, team: string, name: string) => q(db, u, `select public.register_player($1, $2, null, true) as r`, [team, name]).then((r) => r[0].r.player_id as string)
const invite = (db: Db, u: string, player: string) => q(db, u, `select public.create_guardian_invitation($1) as r`, [player]).then((r) => r[0].r)
const accept = (db: Db, u: string, token: string) => q(db, u, `select public.accept_guardian_invitation($1, '家族') as r`, [token]).then((r) => r[0].r)
const answer = (db: Db, u: string, ev: string, p: string, s = 'attend') => q(db, u, `select public.set_attendance($1, $2, $3)`, [ev, p, s])

/** Team T (OWNER; MEM and FAM members), one event, a child of FAM shared with MEM. */
async function setup(opts: { before?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : {})
  for (let i = 1; i <= 4; i++) await addUser(db, U(i))
  const [t] = await q(db, OWNER, `select id, share_token from public.create_team('チームT', 'オーナー')`)
  for (const u of [MEM, FAM]) await joinOld(db, u, t.share_token)
  const [{ id: ev }] = await q(db, OWNER, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const kid = await regChild(db, FAM, t.id, 'こども')
  await accept(db, MEM, (await invite(db, FAM, kid)).token)
  return { db, t: t as { id: string; share_token: string }, ev: ev as string, kid }
}

/** Is the transaction-scoped advisory lock 'membership:<uid>' held right now (same session)? */
async function holdsAccountLock(db: Db, uid: string) {
  return (await num(db, `
    select count(*) from pg_locks l, (select hashtextextended('membership:' || $1::text, 0) k) h
     where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
       and l.classid::bigint = ((h.k >> 32) & 4294967295) and l.objid::bigint = (h.k & 4294967295)`, [uid])) > 0
}
/** Runs `sql` as `uid` inside an open transaction and reports whether the account lock is held afterwards. */
async function lockAfter(db: Db, uid: string, sql: string, params: unknown[] = []) {
  await db.exec('begin')
  try {
    await asUser(db, uid, async () => { await db.query(sql, params) })
    return await holdsAccountLock(db, uid)
  } finally {
    await db.exec('rollback')
  }
}

describe('U4-Fix: the account lock comes first', () => {
  it('in every fixed function the membership lock precedes every membership / guardian / owner check', async () => {
    const { db } = await setup()
    for (const fn of FIXED) {
      const src: string = (await one(db, `select prosrc from pg_proc where oid = $1::regproc`, [`public.${fn}`])).prosrc
      const lock = src.indexOf(`private.xlock('membership:' || v_uid::text)`)
      expect(lock, fn).toBeGreaterThan(0)
      const checks = [/private\.is_guardian\(/, /private\.is_team_member\(/, /from public\.team_members/, /from public\.player_guardians/,
        /self_user_id is not null and self_user_id <> v_uid/, /from public\.players/, /from public\.events/]
      for (const re of checks) {
        const at = src.search(re)
        if (at >= 0) expect(at, `${fn}: ${re}`).toBeGreaterThan(lock)
      }
    }
  })

  it('accepting an invitation locks account -> team members -> team row before reading or using the invitation', async () => {
    const { db } = await setup()
    const src: string = (await one(db, `select prosrc from pg_proc where oid = 'public.accept_guardian_invitation'::regproc`)).prosrc
    const a = src.indexOf(`xlock('membership:'`), b = src.indexOf(`xlock('team-members:'`), c = src.indexOf('for key share')
    const d = src.indexOf('select * into v_inv'), e = src.indexOf('update public.guardian_invitations')
    expect(a).toBeGreaterThan(0)
    expect([a < b, b < c, c < d, d < e]).toEqual([true, true, true, true])
  })

  it('the lock is really held by each operation (successful calls, inside the transaction)', async () => {
    const { db, t, ev, kid } = await setup()
    expect(await lockAfter(db, MEM, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])).toBe(true)
    expect(await lockAfter(db, MEM, `select public.register_player($1, 'べつのこ', null, true)`, [t.id])).toBe(true)
    expect(await lockAfter(db, MEM, `select public.register_self($1)`, [t.id])).toBe(true)
    expect(await lockAfter(db, MEM, `select public.update_player($1, 'こども', null, true)`, [kid])).toBe(true)
    expect(await lockAfter(db, MEM, `select public.archive_player($1)`, [kid])).toBe(true)
    expect(await lockAfter(db, MEM, `select public.create_guardian_invitation($1)`, [kid])).toBe(true)
    const inv = await invite(db, FAM, kid)
    expect(await lockAfter(db, OUT, `select public.accept_guardian_invitation($1, 'x')`, [inv.token])).toBe(true)
    expect(await holdsAccountLock(db, MEM)).toBe(false)                 // released at the end of each transaction
  })
})

describe('U4-Fix: behaviour unchanged', () => {
  it('normal use: answer, register, rename, cancel, invite, accept (new member and existing member)', async () => {
    const { db, t, ev, kid } = await setup()
    await answer(db, MEM, ev, kid)
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [kid])).toBe(1)
    await answer(db, MEM, ev, kid, 'unanswered')
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [kid])).toBe(0)
    expect((await regSelf(db, MEM, t.id)).status).toBe('created')
    expect((await regSelf(db, MEM, t.id)).status).toBe('existing')
    const c2 = await regChild(db, MEM, t.id, 'じろう')
    expect((await q(db, MEM, `select public.update_player($1, 'じろうくん', null, true) as r`, [c2]))[0].r.status).toBe('updated')
    await q(db, MEM, `select public.archive_player($1)`, [c2])
    expect((await one(db, `select archived_at from public.players where id = $1`, [c2])).archived_at).not.toBeNull()
    const inv = await invite(db, MEM, kid)
    expect((await accept(db, OUT, inv.token)).status).toBe('accepted')        // new member
    expect(await isMember(db, t.id, OUT)).toBe(true)
    const c3 = await regChild(db, FAM, t.id, 'さぶろう')
    expect((await accept(db, OUT, (await invite(db, FAM, c3)).token)).status).toBe('accepted')  // existing member
    expect((await accept(db, OUT, (await invite(db, FAM, c3)).token)).status).toBe('already_guardian')
  })

  it('refusals keep their error codes (invalid token, cancelled child, outsider, proxy on a self registration)', async () => {
    const { db, t, ev, kid } = await setup()
    await expect(accept(db, OUT, 'no-such-token')).rejects.toThrow(/invitation_invalid/)
    await expect(answer(db, OUT, ev, kid)).rejects.toThrow(/forbidden/)
    await expect(q(db, OUT, `select public.register_player($1, 'x', null, true)`, [t.id])).rejects.toThrow(/forbidden/)
    await expect(regSelf(db, OUT, t.id)).rejects.toThrow(/forbidden/)
    await expect(invite(db, OUT, kid)).rejects.toThrow(/forbidden/)
    await expect(q(db, OUT, `select public.update_player($1, 'x', null, true)`, [kid])).rejects.toThrow(/forbidden/)
    await expect(q(db, OUT, `select public.archive_player($1)`, [kid])).rejects.toThrow(/forbidden/)
    await expect(answer(db, MEM, ev, kid, 'maybe')).rejects.toThrow(/invalid_status/)
    const me = (await regSelf(db, FAM, t.id)).player_id
    await accept(db, MEM, (await invite(db, FAM, me)).token)                 // MEM becomes a proxy of FAM's own registration
    await expect(q(db, MEM, `select public.update_player($1, 'x', null, true)`, [me])).rejects.toThrow(/forbidden/)
    await expect(invite(db, MEM, me)).rejects.toThrow(/forbidden/)
    const inv = await invite(db, FAM, kid)
    await q(db, FAM, `select public.archive_player($1)`, [kid])
    await expect(accept(db, OUT, inv.token)).rejects.toThrow(/invitation_invalid/)
  })

  it('after removal the removed member can no longer answer, register, rename, cancel, invite or accept', async () => {
    const { db, t, ev, kid } = await setup()
    const c2 = await regChild(db, FAM, t.id, 'じろう')
    const inv = await invite(db, FAM, c2)
    await remove(db, OWNER, t.id, MEM)
    await expect(answer(db, MEM, ev, kid)).rejects.toThrow(/forbidden/)
    await expect(regSelf(db, MEM, t.id)).rejects.toThrow(/forbidden/)
    await expect(q(db, MEM, `select public.register_player($1, 'x', null, true)`, [t.id])).rejects.toThrow(/forbidden/)
    await expect(q(db, MEM, `select public.update_player($1, 'x', null, true)`, [kid])).rejects.toThrow(/forbidden/)
    await expect(q(db, MEM, `select public.archive_player($1)`, [kid])).rejects.toThrow(/forbidden/)
    await expect(invite(db, MEM, kid)).rejects.toThrow(/forbidden/)
    await expect(accept(db, MEM, inv.token)).rejects.toThrow(/blocked_from_team/)
    expect(await isMember(db, t.id, MEM)).toBe(false)
    expect(await num(db, `select count(*) from public.player_guardians where team_id = $1 and user_id = $2`, [t.id, MEM])).toBe(0)
    expect(await num(db, `select count(*) from public.guardian_invitations where id = $1 and used_at is null`, [inv.id])).toBe(1)  // still usable by others
  })

  it('signatures, security definer, search_path and grants are unchanged; anon still cannot call them', async () => {
    const before = await setup({ before: true })
    const after = await setup()
    const sig = (db: Db) => db.query<{ k: string }>(`
      select p.oid::regprocedure || ' def=' || prosecdef || ' vol=' || provolatile::text || ' cfg=' || coalesce(proconfig::text, '') || ' acl=' || coalesce(proacl::text, '') k
        from pg_proc p where pronamespace = 'public'::regnamespace and proname = any($1) order by 1`, [FIXED]).then((r) => r.rows.map((x) => x.k))
    expect(await sig(after.db)).toEqual(await sig(before.db))
    for (const fn of FIXED) {
      expect(await num(after.db, `select count(*) from pg_proc where oid = $1::regproc and prosrc like '%private.require_auth()%'`, [`public.${fn}`]), fn).toBe(1)
      expect((await one(after.db, `select has_function_privilege('anon', $1::regproc, 'execute') x`, [`public.${fn}`])).x, fn).toBe(false)
      expect((await one(after.db, `select has_function_privilege('authenticated', $1::regproc, 'execute') x`, [`public.${fn}`])).x, fn).toBe(true)
    }
  })
})

describe('U4-Fix: migration and rollback', () => {
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
      (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
      (select string_agg(to_jsonb(i)::text, ',' order by id) from public.guardian_invitations i))) as h`)).h as string
  }

  it('applying to existing data changes no row; only the seven function bodies change', async () => {
    const { db, ev, kid } = await setup({ before: true })
    await answer(db, MEM, ev, kid)
    const data = await dataHash(db), f0 = await fns(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(data)
    const f1 = await fns(db)
    const changed = f1.filter((k) => !f0.includes(k)).map((k) => k.split('(')[0])
    expect(changed.map((k) => k.replace(/^public\./, '')).sort()).toEqual([...FIXED].sort())
    expect(f1.length).toBe(f0.length)
  })

  it('rollback restores the previous functions exactly; data is kept; applying again works', async () => {
    const { db, t, ev, kid } = await setup({ before: true })
    const f0 = await fns(db)
    await applyMigration(db, MIG)
    await answer(db, MEM, ev, kid)
    const data = await dataHash(db)
    await db.exec(DOWN)
    expect(await fns(db)).toEqual(f0)
    expect(await dataHash(db)).toBe(data)
    await answer(db, MEM, ev, kid, 'absent')                              // still works after rollback
    await applyMigration(db, MIG)
    expect(await lockAfter(db, MEM, `select public.register_self($1)`, [t.id])).toBe(true)
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
