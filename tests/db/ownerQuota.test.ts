// Phase 5-B U1: owner quota (3 owned teams), creation rate (5 per 24 hours), quota on
// owner hand-over, applying the migration to existing data and rolling it back.
// PGlite has ONE connection: these tests run requests one after another. They check the
// limits and that both entry points take the same per-user lock (SQL design), but they do
// NOT prove safety under truly parallel connections (that is a later local-Supabase test).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261117000000_owner_quota.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117000000_owner_quota_down.sql'), 'utf8')
const U = (n: number) => `51700000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = [], session: string | null = uid) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows, session)
}
const create = (db: Db, u: string, name = 'チーム') =>
  q(db, u, `select id, share_token from public.create_team($1, '代表')`, [name]).then((r) => r[0] as { id: string; share_token: string })
const owned = async (db: Db, u: string) =>
  Number((await db.query<{ n: string }>(`select count(*) n from public.team_members where user_id = $1 and role = 'owner'`, [u])).rows[0]!.n)
const recent = async (db: Db, u: string) =>
  Number((await db.query<{ n: string }>(
    `select count(*) n from private.rate_events where user_id = $1 and kind = 'team_create' and created_at > now() - interval '24 hours'`, [u])).rows[0]!.n)
/** Deleting a team directly (there is no delete-team feature yet in U1); cascades like a real deletion. */
const dropTeam = (db: Db, id: string) => db.query('delete from public.teams where id = $1', [id])
/** Pretend creations happened at given times (hours ago). */
const pastCreations = async (db: Db, u: string, hoursAgo: number[]) => {
  for (const h of hoursAgo) {
    await db.query(`insert into private.rate_events (user_id, kind, created_at) values ($1, 'team_create', now() - make_interval(secs => $2))`, [u, h * 3600])
  }
}

async function freshDb(users = 6) {
  const db = await createDb()
  for (let i = 1; i <= users; i++) await addUser(db, U(i))
  return db
}

/** Rows of the app tables (fingerprint) — the migration must not change any of them. */
async function dataHash(db: Db) {
  return (await db.query<{ h: string }>(`select md5(concat_ws('|',
    (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
    (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m),
    (select string_agg(to_jsonb(p)::text, ',' order by id) from public.players p),
    (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g),
    (select string_agg(to_jsonb(e)::text, ',' order by id) from public.events e),
    (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
    (select string_agg(to_jsonb(i)::text, ',' order by id) from public.guardian_invitations i),
    (select string_agg(to_jsonb(x)::text, ',' order by team_id) from public.team_owner_transfers x))) as h`)).rows[0]!.h
}
/** Tables, columns, constraints, triggers and functions (with their source and grants). */
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
    order by 1`)
  return r.rows.map((x) => x.k)
}

/** A database BEFORE the migration with teams, members, children, answers, invitations, a hand-over request,
 *  and one account that already owns 4 teams (over the new quota). */
async function seededBefore() {
  const db = await createDb({ before: MIG })
  for (let i = 1; i <= 6; i++) await addUser(db, U(i))
  const t = await create(db, U(1), '既存チーム')
  for (const i of [2, 3]) await joinTeamAs(db, U(i), t.share_token, 'm')
  const [{ id: e1 }] = await q(db, U(1), `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const [{ r }] = await q(db, U(2), `select public.register_player($1, 'こども', '4年', true) as r`, [t.id])
  await q(db, U(2), `select public.set_attendance($1, $2, 'attend', 'ok')`, [e1, r.player_id])
  await q(db, U(2), `select public.create_guardian_invitation($1)`, [r.player_id])
  await q(db, U(1), `select public.request_owner_transfer($1, $2)`, [t.id, U(3)])
  for (let i = 0; i < 4; i++) await create(db, U(4), `多いチーム${i}`)   // over-quota account
  return { db, t }
}

describe('owner quota: 3 owned teams', () => {
  it('0 -> 1 -> 2 -> 3 teams can be created; the 4th is refused with owner_quota_exceeded', async () => {
    const db = await freshDb()
    expect(await owned(db, U(1))).toBe(0)
    for (let i = 1; i <= 3; i++) {
      await create(db, U(1), `T${i}`)
      expect(await owned(db, U(1))).toBe(i)
    }
    await expect(create(db, U(1), 'T4')).rejects.toThrow(/owner_quota_exceeded/)
    expect(await owned(db, U(1))).toBe(3)
    expect(Number((await db.query<{ n: string }>(`select count(*) n from public.teams where created_by = $1`, [U(1)])).rows[0]!.n)).toBe(3)
  })

  it('the error has its own code so the screen can tell it apart (23514 + message)', async () => {
    const db = await freshDb()
    for (let i = 0; i < 3; i++) await create(db, U(1))
    const err = await create(db, U(1)).catch((e) => e as { code?: string; message: string })
    expect(err.code).toBe('23514')
    expect(err.message).toBe('owner_quota_exceeded')
  })

  it('membership in other teams does not use the owner quota', async () => {
    const db = await freshDb()
    for (let i = 2; i <= 5; i++) {
      const t = await create(db, U(i), `他人のチーム${i}`)
      await joinTeamAs(db, U(1), t.share_token, 'm')
    }
    for (let i = 0; i < 3; i++) await create(db, U(1))
    expect(await owned(db, U(1))).toBe(3)
  })

  it('deleting an owned team frees the slot; the creation record stays (counts for 24 hours)', async () => {
    const db = await freshDb()
    const ts = [await create(db, U(1)), await create(db, U(1)), await create(db, U(1))]
    await dropTeam(db, ts[0]!.id)
    expect(await owned(db, U(1))).toBe(2)
    expect(await recent(db, U(1))).toBe(3)              // kept after the deletion
    await create(db, U(1), '作り直し')
    expect(await owned(db, U(1))).toBe(3)
    expect(await recent(db, U(1))).toBe(4)
  })
})

describe('creation rate: 5 successful creations in 24 hours', () => {
  it('delete -> create loops stop at the 6th creation, even with free owner slots', async () => {
    const db = await freshDb()
    for (let i = 0; i < 5; i++) {
      const t = await create(db, U(1), `L${i}`)
      await dropTeam(db, t.id)
    }
    expect(await owned(db, U(1))).toBe(0)
    const err = await create(db, U(1), 'L5').catch((e) => e as { code?: string; message: string; detail?: string })
    expect(err.message).toBe('team_create_rate_limited')
    expect(err.code).toBe('23514')
    expect(Date.parse(err.detail!)).toBeGreaterThan(Date.now())  // when creating is possible again
  })

  it('boundary: 4 creations in the window -> the 5th is allowed; 5 in the window -> refused', async () => {
    const db = await freshDb()
    await pastCreations(db, U(1), [23.9, 20, 10, 1])
    await create(db, U(1), '5件目')
    await expect(create(db, U(1), '6件目')).rejects.toThrow(/team_create_rate_limited/)
  })

  it('boundary: a creation exactly 24 hours ago (or older) no longer counts; one just inside does', async () => {
    const inside = await freshDb()
    await pastCreations(inside, U(1), [23.99, 23.99, 23.99, 23.99, 23.99])
    await expect(create(inside, U(1))).rejects.toThrow(/team_create_rate_limited/)

    const edge = await freshDb()
    await pastCreations(edge, U(1), [24, 24, 24, 24, 24])
    await expect(create(edge, U(1))).resolves.toBeTruthy()

    const old = await freshDb()
    await pastCreations(old, U(1), [30, 48, 25, 100, 24.01])
    await create(old, U(1))
  })

  it('the time in DETAIL is the oldest creation in the window + 24 hours', async () => {
    const db = await freshDb()
    await pastCreations(db, U(1), [10, 9, 8, 7, 6])
    const err = await create(db, U(1)).catch((e) => e as { detail?: string })
    const nextIn = (Date.parse(err.detail!) - Date.now()) / 3600_000
    expect(nextIn).toBeGreaterThan(13.9)
    expect(nextIn).toBeLessThan(14.1)
  })

  it('a refused creation is not recorded; records older than 7 days are pruned on the next creation', async () => {
    const db = await freshDb()
    await pastCreations(db, U(1), [200, 300])            // 8+ days ago
    for (let i = 0; i < 3; i++) await create(db, U(1))
    await expect(create(db, U(1))).rejects.toThrow(/owner_quota_exceeded/)
    const all = Number((await db.query<{ n: string }>(`select count(*) n from private.rate_events where user_id = $1`, [U(1)])).rows[0]!.n)
    expect(all).toBe(3)
  })

  it('limits are per account', async () => {
    const db = await freshDb()
    await pastCreations(db, U(1), [1, 1, 1, 1, 1])
    await expect(create(db, U(1))).rejects.toThrow(/team_create_rate_limited/)
    await create(db, U(2))
  })
})

describe('owner hand-over and the quota', () => {
  async function handOverSetup() {
    const db = await freshDb()
    const t = await create(db, U(1), '譲るチーム')
    await joinTeamAs(db, U(2), t.share_token, 'm')
    await q(db, U(1), `select public.request_owner_transfer($1, $2)`, [t.id, U(2)])
    return { db, t }
  }

  it('a recipient who owns 2 teams can accept and then owns 3', async () => {
    const { db, t } = await handOverSetup()
    await create(db, U(2)); await create(db, U(2))
    const [{ r }] = await q(db, U(2), `select public.respond_owner_transfer($1, true) as r`, [t.id])
    expect(r.status).toBe('accepted')
    expect(await owned(db, U(2))).toBe(3)
    expect(await owned(db, U(1))).toBe(0)
  })

  it('a recipient who owns 3 teams cannot accept; nothing changes and the request stays open', async () => {
    const { db, t } = await handOverSetup()
    const mine = [await create(db, U(2)), await create(db, U(2)), await create(db, U(2))]
    await expect(q(db, U(2), `select public.respond_owner_transfer($1, true)`, [t.id])).rejects.toThrow(/owner_quota_exceeded/)
    expect((await db.query(`select role from public.team_members where team_id = $1 and user_id = $2`, [t.id, U(1)])).rows[0]).toEqual({ role: 'owner' })
    expect((await db.query(`select 1 from public.team_owner_transfers where team_id = $1`, [t.id])).rows).toHaveLength(1)
    // after freeing a slot the same request can be accepted
    await dropTeam(db, mine[0]!.id)
    const [{ r }] = await q(db, U(2), `select public.respond_owner_transfer($1, true) as r`, [t.id])
    expect(r.status).toBe('accepted')
    expect(await owned(db, U(2))).toBe(3)
  })

  it('declining is still possible at the quota (only accepting adds a team)', async () => {
    const { db, t } = await handOverSetup()
    for (let i = 0; i < 3; i++) await create(db, U(2))
    const [{ r }] = await q(db, U(2), `select public.respond_owner_transfer($1, false) as r`, [t.id])
    expect(r.status).toBe('declined')
  })

  it('accepting does not count as a creation (rate limit untouched); the former owner frees a slot', async () => {
    const { db, t } = await handOverSetup()
    const before = await recent(db, U(2))
    await q(db, U(2), `select public.respond_owner_transfer($1, true)`, [t.id])
    expect(await recent(db, U(2))).toBe(before)
    for (let i = 0; i < 3; i++) await create(db, U(1))   // U1 owned 1 before, 0 after the hand-over
    expect(await owned(db, U(1))).toBe(3)
  })
})

describe('authentication and privileges', () => {
  it('logged-out (anon) and expired-session callers cannot create teams', async () => {
    const db = await freshDb()
    await expect(q(db, null, `select public.create_team('x', 'y')`)).rejects.toThrow(/permission denied/)
    await db.query('delete from auth.sessions where user_id = $1', [U(1)])       // logged out everywhere
    await expect(create(db, U(1))).rejects.toThrow(/session_expired/)
    expect(Number((await db.query<{ n: string }>(`select count(*) n from public.teams`)).rows[0]!.n)).toBe(0)
  })

  it('the owner is always the caller from the token (no user id parameter exists)', async () => {
    const db = await freshDb()
    const args = (await db.query<{ a: string }>(
      `select pg_get_function_identity_arguments('public.create_team'::regproc) a`)).rows[0]!.a
    expect(args).toBe('p_name text, p_display_name text')
    const t = await create(db, U(3))
    expect((await db.query(`select user_id, role from public.team_members where team_id = $1`, [t.id])).rows).toEqual([{ user_id: U(3), role: 'owner' }])
  })

  it('browsers cannot read the creation records or call the internal helpers', async () => {
    const db = await freshDb()
    await create(db, U(1))
    await expect(q(db, U(1), `select * from private.rate_events`)).rejects.toThrow(/permission denied/)
    for (const fn of [`private.owner_quota('${U(1)}')`, 'private.team_create_limit_24h()', `private.lock_owner_quota('${U(1)}')`]) {
      await expect(q(db, U(1), `select ${fn}`)).rejects.toThrow(/permission denied/)
      await expect(q(db, null, `select ${fn}`)).rejects.toThrow(/permission denied/)
    }
  })

  it('SQL design: both entry points take the same per-user lock before counting (concurrency guard)', async () => {
    const db = await freshDb()
    const src = async (fn: string) => (await db.query<{ s: string }>(`select prosrc s from pg_proc where oid = $1::regprocedure`, [fn])).rows[0]!.s
    const create_ = await src('public.create_team(text,text)')
    const accept = await src('public.respond_owner_transfer(uuid,boolean)')
    const lock = await src('private.lock_owner_quota(uuid)')
    expect(lock).toMatch(/pg_advisory_xact_lock\(hashtextextended\('owner-quota:'/)
    // the lock comes before the count in both functions; in the hand-over it also comes before the team row lock
    expect(create_.indexOf('lock_owner_quota')).toBeGreaterThan(-1)
    expect(create_.indexOf('lock_owner_quota')).toBeLessThan(create_.indexOf('count(*)'))
    expect(accept.indexOf('lock_owner_quota')).toBeLessThan(accept.indexOf('for update'))
    expect(accept.indexOf('lock_owner_quota')).toBeLessThan(accept.indexOf('count(*)'))
  })
})

describe('account deletion still works with the new records', () => {
  it('purge + Auth deletion completes; the creation records go with the account', async () => {
    const db = await freshDb()
    await create(db, U(1))
    await db.exec('set role service_role')
    try {
      const [{ r }] = (await db.query<any>(`select public.purge_account_data($1, $2) as r`, [U(1), U(1)])).rows
      expect(r.status).toBe('purged')
    } finally { await db.exec('reset role') }
    await db.query('delete from auth.users where id = $1', [U(1)])
    expect((await db.query(`select 1 from private.rate_events where user_id = $1`, [U(1)])).rows).toHaveLength(0)
  })
})

describe('applying to existing data and rolling back', () => {
  it('changes no app data; an account already over the quota keeps its teams but cannot create more', async () => {
    const { db } = await seededBefore()
    const before = await dataHash(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(before)
    expect(await owned(db, U(4))).toBe(4)                      // nothing deleted
    await expect(create(db, U(4))).rejects.toThrow(/owner_quota_exceeded/)
    // the existing hand-over request still works through the new function
    const t = (await db.query<{ id: string }>(`select team_id id from public.team_owner_transfers`)).rows[0]!
    const [{ r }] = await q(db, U(3), `select public.respond_owner_transfer($1, true) as r`, [t.id])
    expect(r.status).toBe('accepted')
  })

  it('creations of the last 24 hours before the migration are counted (backfill)', async () => {
    const { db } = await seededBefore()
    await applyMigration(db, MIG)
    expect(await recent(db, U(4))).toBe(4)
    expect(await recent(db, U(1))).toBe(1)
  })

  it('applying twice is harmless (no duplicate records, same schema)', async () => {
    const { db } = await seededBefore()
    await applyMigration(db, MIG)
    const s1 = await schema(db)
    const n1 = (await db.query(`select * from private.rate_events`)).rows.length
    await applyMigration(db, MIG)
    expect(await schema(db)).toEqual(s1)
    expect((await db.query(`select * from private.rate_events`)).rows.length).toBe(n1)
  })

  it('rollback restores the previous schema exactly and keeps the data; the migration can be applied again', async () => {
    const { db } = await seededBefore()
    const schemaBefore = await schema(db)
    await applyMigration(db, MIG)
    await create(db, U(5), '移行後のチーム')                 // data created after the migration stays
    const dataAfter = await dataHash(db)
    await db.exec(DOWN)
    expect(await schema(db)).toEqual(schemaBefore)
    expect(await dataHash(db)).toBe(dataAfter)
    for (let i = 0; i < 4; i++) await create(db, U(6), `制限なし${i}`)   // old behaviour: no quota
    await applyMigration(db, MIG)
    await expect(create(db, U(6))).rejects.toThrow(/owner_quota_exceeded/)
  })

  it('a failure while applying leaves nothing behind (single transaction)', async () => {
    const { db } = await seededBefore()
    const schemaBefore = await schema(db)
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations', MIG), 'utf8')
    await expect(db.exec(`begin; ${sql}; select 1/0; commit;`)).rejects.toThrow()
    await db.exec('rollback').catch(() => {})
    expect(await schema(db)).toEqual(schemaBefore)
  })
})
