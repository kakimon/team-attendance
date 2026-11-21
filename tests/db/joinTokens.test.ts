// Phase 5-B U2 (D2): join tokens separate from the team page address.
// PGlite has ONE connection: requests run one after another. The row-lock design for
// rotation vs. joining is checked in the SQL, but truly parallel behaviour is NOT proven here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261117100000_join_tokens.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117100000_join_tokens_down.sql'), 'utf8')
const U = (n: number) => `52700000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADMIN = U(2), MEMBER = U(3), STRANGER = U(4), OTHER_OWNER = U(5), NEWCOMER = U(6)

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = [], session: string | null = uid) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows, session)
}
const link = (db: Db, u: string, team: string) => q(db, u, `select public.get_join_link($1) as r`, [team]).then((r) => r[0].r as { open: boolean; token: string | null })
// U3 changed join_by_token to return { status, team_id } (invalid tokens are returned so they can be
// recorded); this helper keeps the U2 expectations: an invalid token is a failure named join_link_invalid.
const joinBy = (db: Db, u: string, token: string | null) => q(db, u, `select public.join_by_token($1, 'あたらしい人') as r`, [token])
  .then((r) => { if (r[0].r.status === 'invalid') throw new Error('join_link_invalid'); return r[0].r.team_id as string })
const isMember = async (db: Db, u: string, team: string) =>
  (await db.query(`select 1 from public.team_members where team_id = $1 and user_id = $2`, [team, u])).rows.length === 1
const roleOf = async (db: Db, u: string, team: string) =>
  (await db.query<{ role: string }>(`select role from public.team_members where team_id = $1 and user_id = $2`, [team, u])).rows[0]?.role

/** Fingerprint of every app table (the migration must not change any row). */
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
async function schema(db: Db) {
  const r = await db.query<{ k: string }>(`
    select 'tbl ' || n.nspname || '.' || c.relname || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(c.relacl::text, '') k
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'i')
    union all select 'col ' || attrelid::regclass || '.' || attname || ' nn=' || attnotnull || ' acl=' || coalesce(attacl::text, '') from pg_attribute
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

/** Team with an owner, an admin and a member; another team owned by someone else. */
async function setup(opts: { before?: boolean; beforeD5?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : opts.beforeD5 ? { before: '20261118210000_disable_legacy_join.sql' } : {})
  for (let i = 1; i <= 6; i++) await addUser(db, U(i))
  const [t] = await q(db, OWNER, `select id, share_token from public.create_team('チームA', '代表')`)
  for (const u of [ADMIN, MEMBER]) await joinTeamAs(db, u, t.share_token, 'm')
  await q(db, OWNER, `select public.set_member_role($1, $2, 'admin')`, [t.id, ADMIN])
  const [t2] = await q(db, OTHER_OWNER, `select id, share_token from public.create_team('チームB', 'B')`)
  return { db, t: t as { id: string; share_token: string }, t2: t2 as { id: string; share_token: string } }
}

describe('applying to existing data', () => {
  it('every existing team gets a NEW random token (not the share_token); no app row changes', async () => {
    const { db, t, t2 } = await setup({ before: true })
    const before = await dataHash(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(before)
    const rows = (await db.query<{ team_id: string; token: string; share_token: string }>(
      `select j.team_id, j.token, t.share_token from private.team_join_tokens j join public.teams t on t.id = j.team_id`)).rows
    expect(rows.map((r) => r.team_id).sort()).toEqual([t.id, t2.id].sort())
    for (const r of rows) {
      expect(r.token).not.toBe(r.share_token)
      expect(r.token).toMatch(/^[0-9a-f]{64}$/)                 // two random UUIDs, hex
    }
    expect(new Set(rows.map((r) => r.token)).size).toBe(rows.length)
  })

  it('existing members keep their membership and role', async () => {
    const { db, t } = await setup({ before: true })
    await applyMigration(db, MIG)
    expect(await roleOf(db, OWNER, t.id)).toBe('owner')
    expect(await roleOf(db, ADMIN, t.id)).toBe('admin')
    expect(await roleOf(db, MEMBER, t.id)).toBe('member')
  })
})

describe('who can see and manage the join token', () => {
  it('owner and admin can read it; a member, an outsider and the owner of another team cannot', async () => {
    const { db, t } = await setup()
    expect((await link(db, OWNER, t.id)).token).toMatch(/^[0-9a-f]{64}$/)
    expect((await link(db, ADMIN, t.id)).token).toBe((await link(db, OWNER, t.id)).token)
    for (const u of [MEMBER, STRANGER, OTHER_OWNER]) await expect(link(db, u, t.id)).rejects.toThrow(/forbidden/)
  })

  it('no browser role can read the token table directly; the public teams table does not contain it', async () => {
    const { db, t } = await setup()
    for (const u of [OWNER, MEMBER]) await expect(q(db, u, `select token from private.team_join_tokens`)).rejects.toThrow(/permission denied/)
    await expect(q(db, null, `select token from private.team_join_tokens`)).rejects.toThrow(/permission denied/)
    const cols = (await q(db, MEMBER, `select * from public.teams where id = $1`, [t.id]))[0]
    expect(Object.keys(cols).sort()).toEqual(['created_at', 'created_by', 'id', 'name', 'share_token'])
  })

  it('a member, an outsider and the owner of another team cannot rotate, stop or reopen', async () => {
    const { db, t } = await setup()
    const before = (await link(db, OWNER, t.id)).token
    for (const u of [MEMBER, STRANGER, OTHER_OWNER]) {
      await expect(q(db, u, `select public.rotate_join_token($1)`, [t.id])).rejects.toThrow(/forbidden/)
      await expect(q(db, u, `select public.set_join_open($1, false)`, [t.id])).rejects.toThrow(/forbidden/)
      await expect(q(db, u, `select public.set_join_open($1, true)`, [t.id])).rejects.toThrow(/forbidden/)
    }
    expect((await link(db, OWNER, t.id)).token).toBe(before)
  })

  it('logged-out and expired-session callers are refused everywhere', async () => {
    const { db, t } = await setup()
    const token = (await link(db, OWNER, t.id)).token
    for (const sql of [`select public.get_join_link('${t.id}')`, `select public.rotate_join_token('${t.id}')`,
      `select public.set_join_open('${t.id}', false)`, `select * from public.preview_join('${token}')`,
      `select public.join_by_token('${token}', 'x')`, `select public.resolve_legacy_team('${t.share_token}')`]) {
      await expect(q(db, null, sql)).rejects.toThrow(/permission denied/)
    }
    await db.query('delete from auth.sessions where user_id = $1', [NEWCOMER])
    await expect(joinBy(db, NEWCOMER, token)).rejects.toThrow(/session_expired/)
    expect(await isMember(db, NEWCOMER, t.id)).toBe(false)
  })
})

describe('joining with the token', () => {
  it('preview shows the team name only for a valid token; joining makes a member', async () => {
    const { db, t } = await setup()
    const token = (await link(db, OWNER, t.id)).token!
    expect(await q(db, NEWCOMER, `select * from public.preview_join($1)`, [token])).toEqual([{ team_id: t.id, name: 'チームA', is_member: false }])
    expect(await q(db, NEWCOMER, `select * from public.preview_join($1)`, ['f'.repeat(64)])).toEqual([])
    expect(await q(db, NEWCOMER, `select * from public.preview_join($1)`, [t.share_token])).toEqual([])  // old value is not a join token
    expect(await joinBy(db, NEWCOMER, token)).toBe(t.id)
    expect(await roleOf(db, NEWCOMER, t.id)).toBe('member')
  })

  it('the team page address (share_token) and the team id cannot be used as a join token', async () => {
    const { db, t } = await setup()
    await expect(joinBy(db, NEWCOMER, t.share_token)).rejects.toThrow(/join_link_invalid/)
    await expect(joinBy(db, NEWCOMER, t.id)).rejects.toThrow(/join_link_invalid/)
    await expect(joinBy(db, NEWCOMER, null)).rejects.toThrow(/join_link_invalid/)
    expect(await isMember(db, NEWCOMER, t.id)).toBe(false)
  })

  it('joining again never changes an existing role', async () => {
    const { db, t } = await setup()
    const token = (await link(db, OWNER, t.id)).token!
    for (const u of [OWNER, ADMIN, MEMBER]) await joinBy(db, u, token)
    expect(await roleOf(db, OWNER, t.id)).toBe('owner')
    expect(await roleOf(db, ADMIN, t.id)).toBe('admin')
    expect(await roleOf(db, MEMBER, t.id)).toBe('member')
  })

  it('a token of team A never joins team B', async () => {
    const { db, t, t2 } = await setup()
    const tokenA = (await link(db, OWNER, t.id)).token!
    expect(await joinBy(db, NEWCOMER, tokenA)).toBe(t.id)
    expect(await isMember(db, NEWCOMER, t2.id)).toBe(false)
  })
})

describe('rotation and stopping', () => {
  it('after rotation the previous token is invalid at once, the new one works, members stay', async () => {
    const { db, t } = await setup()
    const old = (await link(db, OWNER, t.id)).token!
    const [{ r }] = await q(db, ADMIN, `select public.rotate_join_token($1) as r`, [t.id])   // admins may rotate too
    expect(r.token).not.toBe(old)
    expect(r.token).toMatch(/^[0-9a-f]{64}$/)
    await expect(joinBy(db, NEWCOMER, old)).rejects.toThrow(/join_link_invalid/)
    expect(await q(db, NEWCOMER, `select * from public.preview_join($1)`, [old])).toEqual([])
    expect(await joinBy(db, NEWCOMER, r.token)).toBe(t.id)
    for (const u of [OWNER, ADMIN, MEMBER]) expect(await isMember(db, u, t.id)).toBe(true)
  })

  it('stopped: no token joins; reopening issues a NEW token (the stopped one never comes back)', async () => {
    const { db, t } = await setup()
    const before = (await link(db, OWNER, t.id)).token!
    const [{ r: stopped }] = await q(db, OWNER, `select public.set_join_open($1, false) as r`, [t.id])
    expect(stopped).toEqual({ open: false, token: null })
    expect(await link(db, ADMIN, t.id)).toEqual({ open: false, token: null })
    await expect(joinBy(db, NEWCOMER, before)).rejects.toThrow(/join_link_invalid/)
    const [{ r: reopened }] = await q(db, OWNER, `select public.set_join_open($1, true) as r`, [t.id])
    expect(reopened.open).toBe(true)
    expect(reopened.token).not.toBe(before)
    await expect(joinBy(db, NEWCOMER, before)).rejects.toThrow(/join_link_invalid/)
    expect(await joinBy(db, NEWCOMER, reopened.token)).toBe(t.id)
  })

  it('reopening when already open keeps the current token; stopping twice is harmless', async () => {
    const { db, t } = await setup()
    const cur = (await link(db, OWNER, t.id)).token
    expect((await q(db, OWNER, `select public.set_join_open($1, true) as r`, [t.id]))[0].r.token).toBe(cur)
    await q(db, OWNER, `select public.set_join_open($1, false)`, [t.id])
    await q(db, OWNER, `select public.set_join_open($1, false)`, [t.id])
    expect(await link(db, OWNER, t.id)).toEqual({ open: false, token: null })
  })

  it('stopping or rotating does not change anyone\'s membership, children or answers', async () => {
    const { db, t } = await setup()
    const [{ id: ev }] = await q(db, OWNER, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
    const [{ r }] = await q(db, MEMBER, `select public.register_player($1, 'こども', null, true) as r`, [t.id])
    await q(db, MEMBER, `select public.set_attendance($1, $2, 'attend')`, [ev, r.player_id])
    const before = await dataHash(db)
    await q(db, OWNER, `select public.rotate_join_token($1)`, [t.id])
    await q(db, OWNER, `select public.set_join_open($1, false)`, [t.id])
    await q(db, OWNER, `select public.set_join_open($1, true)`, [t.id])
    expect(await dataHash(db)).toBe(before)
  })

  it('SQL design: rotate/stop lock the team row before the role check; join re-checks the token after locking the row', async () => {
    const { db } = await setup()
    const src = async (fn: string) => (await db.query<{ s: string }>(`select prosrc s from pg_proc where oid = $1::regprocedure`, [fn])).rows[0]!.s
    for (const fn of ['public.rotate_join_token(uuid)', 'public.set_join_open(uuid,boolean)']) {
      const s = await src(fn)
      expect(s.indexOf('for update')).toBeGreaterThan(-1)
      expect(s.indexOf('for update')).toBeLessThan(s.indexOf('can_manage_join'))
    }
    const j = await src('public.join_by_token(text,text)')
    const lock = j.indexOf('for share')
    expect(lock).toBeGreaterThan(-1)
    expect(j.indexOf('token = p_token', lock)).toBeGreaterThan(lock)          // looked up again after the lock
    expect(j.indexOf('insert into public.team_members')).toBeGreaterThan(lock)
  })
})

describe('new teams, old bookmarks, U1 and the old join path', () => {
  it('a newly created team gets its own token automatically; U1 limits still apply', async () => {
    const db = await createDb()
    await addUser(db, NEWCOMER)
    const teams = []
    for (let i = 0; i < 3; i++) teams.push((await q(db, NEWCOMER, `select id from public.create_team($1, 'n')`, [`T${i}`]))[0].id)
    for (const id of teams) expect((await link(db, NEWCOMER, id)).token).toMatch(/^[0-9a-f]{64}$/)
    await expect(q(db, NEWCOMER, `select public.create_team('T4', 'n')`)).rejects.toThrow(/owner_quota_exceeded/)
  })

  it('resolve_legacy_team: members get the team id from the old address; others get nothing', async () => {
    const { db, t } = await setup()
    expect((await q(db, MEMBER, `select public.resolve_legacy_team($1) as id`, [t.share_token]))[0].id).toBe(t.id)
    expect((await q(db, STRANGER, `select public.resolve_legacy_team($1) as id`, [t.share_token]))[0].id).toBeNull()
    expect(await isMember(db, STRANGER, t.id)).toBe(false)
  })

  it('KNOWN U2 RISK (until D5): the old path join_team(share_token) still works, even when the new token is stopped [before D5]', async () => {
    const { db, t } = await setup({ beforeD5: true })
    await q(db, OWNER, `select public.set_join_open($1, false)`, [t.id])
    await q(db, STRANGER, `select public.join_team($1, 'old link')`, [t.share_token])
    expect(await isMember(db, STRANGER, t.id)).toBe(true)                    // documented: removed in D5
  })

  it('D5 closes that risk: the old share token joins nobody, whether the join link is open or stopped', async () => {
    const { db, t } = await setup()
    for (const open of [true, false]) {
      await q(db, OWNER, `select public.set_join_open($1, $2)`, [t.id, open])
      await expect(q(db, STRANGER, `select public.join_team($1, 'old link')`, [t.share_token])).rejects.toThrow(/permission denied for function join_team/)
      expect(await isMember(db, STRANGER, t.id)).toBe(false)
    }
    expect((await q(db, MEMBER, `select public.resolve_legacy_team($1) as id`, [t.share_token]))[0].id).toBe(t.id)   // bookmarks still move
  })

  it('deleting a team removes its token; account deletion still completes', async () => {
    const { db, t2 } = await setup()
    await db.exec('set role service_role')
    try {
      const [{ r }] = (await db.query<any>(`select public.purge_account_data($1, $2) as r`, [OTHER_OWNER, OTHER_OWNER])).rows
      expect(r.status).toBe('purged')
    } finally { await db.exec('reset role') }
    expect((await db.query(`select 1 from private.team_join_tokens where team_id = $1`, [t2.id])).rows).toHaveLength(0)
  })
})

describe('rollback', () => {
  it('restores the previous schema exactly and keeps the data; can be applied again', async () => {
    const { db } = await setup({ before: true })
    const schemaBefore = await schema(db)
    await applyMigration(db, MIG)
    await q(db, NEWCOMER, `select public.create_team('移行後', 'n')`)
    const dataAfter = await dataHash(db)
    await db.exec(DOWN)
    expect(await schema(db)).toEqual(schemaBefore)
    expect(await dataHash(db)).toBe(dataAfter)
    await applyMigration(db, MIG)
    expect(Number((await db.query<{ n: string }>(`select count(*) n from private.team_join_tokens`)).rows[0]!.n))
      .toBe(Number((await db.query<{ n: string }>(`select count(*) n from public.teams`)).rows[0]!.n))
  })

  it('after rollback the U1 limits are still in place', async () => {
    const { db } = await setup()
    await db.exec(DOWN)
    await addUser(db, '52700000-0000-4000-8000-000000000099')
    const u = '52700000-0000-4000-8000-000000000099'
    for (let i = 0; i < 3; i++) await q(db, u, `select public.create_team($1, 'n')`, [`R${i}`])
    await expect(q(db, u, `select public.create_team('R4', 'n')`)).rejects.toThrow(/owner_quota_exceeded/)
  })

  it('applying twice is harmless (no duplicate tokens, same schema)', async () => {
    const { db } = await setup({ before: true })      // DB up to U2 only: later migrations replace U2 functions
    await applyMigration(db, MIG)
    const s1 = await schema(db)
    const before = (await db.query(`select team_id, token from private.team_join_tokens order by team_id`)).rows
    await applyMigration(db, MIG)
    expect(await schema(db)).toEqual(s1)
    expect((await db.query(`select team_id, token from private.team_join_tokens order by team_id`)).rows).toEqual(before)
  })

  it('a failure while applying leaves nothing behind', async () => {
    const { db } = await setup({ before: true })
    const schemaBefore = await schema(db)
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations', MIG), 'utf8')
    await expect(db.exec(`begin; ${sql}; select 1/0; commit;`)).rejects.toThrow()
    await db.exec('rollback').catch(() => {})
    expect(await schema(db)).toEqual(schemaBefore)
  })
})
