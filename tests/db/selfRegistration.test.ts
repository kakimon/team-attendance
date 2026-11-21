// Phase 5-B D3.5: registering yourself (adults answering for themselves), proxies, account deletion,
// applying to existing data and rollback. PGlite has ONE connection: concurrency is not proven here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261117230000_self_registration.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117230000_self_registration_down.sql'), 'utf8')
const U = (n: number) => `53500000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADULT = U(2), FAMILY = U(3), OTHER = U(4), OUT = U(5)

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = []) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)
}
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0]
const num = async (db: Db, sql: string, params: unknown[] = []) => Number(Object.values(await one(db, sql, params))[0])
const regSelf = (db: Db, u: string, team: string) => q(db, u, `select public.register_self($1) as r`, [team]).then((r) => r[0].r)
const invite = (db: Db, u: string, player: string) => q(db, u, `select public.create_guardian_invitation($1) as r`, [player]).then((r) => r[0].r)
const accept = (db: Db, u: string, token: string) => q(db, u, `select public.accept_guardian_invitation($1, '家族') as r`, [token]).then((r) => r[0].r)
const answer = (db: Db, u: string, ev: string, p: string, s = 'attend') => q(db, u, `select public.set_attendance($1, $2, $3)`, [ev, p, s])
const svc = async (db: Db, sql: string, params: unknown[] = []) => {
  await db.exec('set role service_role')
  try { return (await db.query<any>(sql, params)).rows } finally { await db.exec('reset role') }
}
const purge = (db: Db, u: string) => svc(db, `select public.purge_account_data($1, $2) as r`, [u, u]).then((r) => r[0].r)

/** A team (OWNER) with ADULT, FAMILY and OTHER as members; one upcoming event. */
async function setup(opts: { before?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : {})
  for (let i = 1; i <= 6; i++) await addUser(db, U(i))
  const [t] = await q(db, OWNER, `select id, share_token from public.create_team('社会人チーム', 'オーナー')`)
  for (const [u, name] of [[ADULT, '山田'], [FAMILY, '山田の家族'], [OTHER, '佐藤']] as const) {
    await joinTeamAs(db, u, t.share_token, name)
  }
  const [{ id: ev }] = await q(db, OWNER, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  return { db, t: t as { id: string; share_token: string }, ev: ev as string }
}

describe('registering yourself', () => {
  it('creates one self registration named after the display name; owner = the caller', async () => {
    const { db, t } = await setup()
    const r = await regSelf(db, ADULT, t.id)
    expect(r.status).toBe('created')
    expect(await one(db, `select name, is_self, self_user_id, created_by from public.players where id = $1`, [r.player_id]))
      .toEqual({ name: '山田', is_self: true, self_user_id: ADULT, created_by: ADULT })
    expect(await one(db, `select user_id, added_via from public.player_guardians where player_id = $1`, [r.player_id]))
      .toEqual({ user_id: ADULT, added_via: 'registrant' })
  })

  it('one per account and team: a second call returns the same registration', async () => {
    const { db, t } = await setup()
    const a = await regSelf(db, ADULT, t.id)
    expect(await regSelf(db, ADULT, t.id)).toEqual({ status: 'existing', player_id: a.player_id })
    expect(await num(db, `select count(*) from public.players where self_user_id = $1`, [ADULT])).toBe(1)
    // the database itself refuses a second one, whatever the path
    await expect(db.query(`insert into public.players (team_id, name, normalized_name, is_self, self_user_id) values ($1, 'x', 'x', true, $2)`, [t.id, ADULT]))
      .rejects.toThrow(/players_one_self_per_team/)
  })

  it('in another team the same account gets a separate self registration', async () => {
    const { db, t } = await setup()
    const [t2] = await q(db, OTHER, `select id, share_token from public.create_team('別チーム', 'S')`)
    await joinTeamAs(db, ADULT, t2.share_token, '山田B')
    const a = await regSelf(db, ADULT, t.id), b = await regSelf(db, ADULT, t2.id)
    expect(a.player_id).not.toBe(b.player_id)
    expect((await one(db, `select name from public.players where id = $1`, [b.player_id])).name).toBe('山田B')
  })

  it('the name is taken only once; later display-name changes are not synced', async () => {
    const { db, t } = await setup()
    const r = await regSelf(db, ADULT, t.id)
    await db.query(`update public.team_members set display_name = '山田（新）' where team_id = $1 and user_id = $2`, [t.id, ADULT])
    expect((await one(db, `select name from public.players where id = $1`, [r.player_id])).name).toBe('山田')
  })

  it('a cancelled self registration is restored (not duplicated) when registering again', async () => {
    const { db, t } = await setup()
    const r = await regSelf(db, ADULT, t.id)
    await q(db, ADULT, `select public.archive_player($1)`, [r.player_id])
    expect(await regSelf(db, ADULT, t.id)).toEqual({ status: 'restored', player_id: r.player_id })
    expect((await one(db, `select archived_at from public.players where id = $1`, [r.player_id])).archived_at).toBeNull()
  })

  it('non-members, logged-out callers and expired sessions are refused; there is no user id parameter', async () => {
    const { db, t } = await setup()
    await expect(regSelf(db, OUT, t.id)).rejects.toThrow(/forbidden/)
    await expect(q(db, null, `select public.register_self($1)`, [t.id])).rejects.toThrow(/permission denied/)
    await db.query('delete from auth.sessions where user_id = $1', [ADULT])
    await expect(regSelf(db, ADULT, t.id)).rejects.toThrow(/session_expired/)
    expect((await one(db, `select pg_get_function_identity_arguments('public.register_self'::regproc) a`)).a).toBe('p_team_id uuid')
  })

  it('browsers cannot write the columns directly; is_self and self_user_id must agree', async () => {
    const { db, t } = await setup()
    const r = await regSelf(db, ADULT, t.id)
    await expect(q(db, ADULT, `update public.players set self_user_id = $1 where id = $2`, [OTHER, r.player_id])).rejects.toThrow(/permission denied/)
    await expect(q(db, OTHER, `insert into public.players (team_id, name, normalized_name, is_self, self_user_id) values ($1, 'x', 'x', true, $2)`, [t.id, OTHER]))
      .rejects.toThrow(/permission denied/)
    await expect(db.query(`update public.players set is_self = false where id = $1`, [r.player_id])).rejects.toThrow(/players_self_owner/)
    await expect(db.query(`insert into public.players (team_id, name, normalized_name, is_self) values ($1, 'x', 'x', true)`, [t.id])).rejects.toThrow(/players_self_owner/)
  })

  it('U3 limits apply: 20 per person in a team, 500 per team', async () => {
    const { db, t } = await setup()
    await db.query(`with p as (insert into public.players (team_id, name, normalized_name, created_by) select $1, 'c' || g, 'c' || g, $2 from generate_series(1, 20) g returning id)
      insert into public.player_guardians (player_id, team_id, user_id, added_via) select id, $1, $2, 'registrant' from p`, [t.id, ADULT])
    await expect(regSelf(db, ADULT, t.id)).rejects.toThrow(/guardian_child_limit_exceeded/)
    const [t2] = await q(db, OTHER, `select id, share_token from public.create_team('満員', 'S')`)
    await db.query(`with u as (insert into auth.users (id) select gen_random_uuid() from generate_series(1, 50) returning id),
        m as (insert into public.team_members (team_id, user_id, role, display_name) select $1, id, 'member', 'x' from u returning user_id),
        p as (insert into public.players (team_id, name, normalized_name) select $1, 'c' || g, 'c' || g from generate_series(1, 500) g returning id),
        np as (select id, row_number() over () rn from p), nm as (select user_id, row_number() over () rn from m)
      insert into public.player_guardians (player_id, team_id, user_id, added_via) select np.id, $1, nm.user_id, 'registrant' from np join nm on nm.rn = (np.rn % 50) + 1`, [t2.id])
    await expect(regSelf(db, OTHER, t2.id)).rejects.toThrow(/team_child_limit_exceeded/)
  })
})

describe('proxies (family members answering for an adult)', () => {
  async function withProxy() {
    const s = await setup()
    const me = await regSelf(s.db, ADULT, s.t.id)
    const inv = await invite(s.db, ADULT, me.player_id)
    expect((await accept(s.db, FAMILY, inv.token)).status).toBe('accepted')
    return { ...s, self: me.player_id as string }
  }

  it('the owner can invite a proxy; the proxy can answer', async () => {
    const { db, ev, self } = await withProxy()
    await answer(db, FAMILY, ev, self, 'absent')
    expect((await one(db, `select status, updated_by from public.attendance where player_id = $1`, [self]))).toEqual({ status: 'absent', updated_by: FAMILY })
    await answer(db, ADULT, ev, self, 'attend')
    expect((await one(db, `select status from public.attendance where player_id = $1`, [self])).status).toBe('attend')
  })

  it('the proxy cannot rename, cancel or invite others for the self registration (owner only)', async () => {
    const { db, self } = await withProxy()
    await expect(q(db, FAMILY, `select public.update_player($1, '別の名前', null, true)`, [self])).rejects.toThrow(/forbidden/)
    await expect(q(db, FAMILY, `select public.archive_player($1)`, [self])).rejects.toThrow(/forbidden/)
    await expect(invite(db, FAMILY, self)).rejects.toThrow(/forbidden/)
    expect((await one(db, `select name, archived_at from public.players where id = $1`, [self]))).toEqual({ name: '山田', archived_at: null })
    // the owner can
    expect((await q(db, ADULT, `select public.update_player($1, '山田太郎', null, true) as r`, [self]))[0].r.status).toBe('updated')
  })

  it('people who are not linked cannot answer, edit or invite (unchanged rules)', async () => {
    const { db, ev, self } = await withProxy()
    await expect(answer(db, OTHER, ev, self)).rejects.toThrow(/forbidden/)
    await expect(q(db, OTHER, `select public.update_player($1, 'x', null, true)`, [self])).rejects.toThrow(/forbidden/)
    await expect(invite(db, OWNER, self)).rejects.toThrow(/forbidden/)       // even the team owner
  })
})

describe('account deletion', () => {
  it('the owner leaves: the self registration and its answers are deleted even with a proxy; the proxy keeps everything else', async () => {
    const { db, t, ev } = await setup()
    const me = await regSelf(db, ADULT, t.id)
    const inv = await invite(db, ADULT, me.player_id)
    await accept(db, FAMILY, inv.token)
    await answer(db, FAMILY, ev, me.player_id)
    const kid = (await q(db, FAMILY, `select public.register_player($1, '子ども', null, true) as r`, [t.id]))[0].r.player_id
    await answer(db, FAMILY, ev, kid)
    const r = await purge(db, ADULT)
    expect(r).toMatchObject({ status: 'purged', self_registrations_deleted: 1 })
    expect(await num(db, `select count(*) from public.players where id = $1`, [me.player_id])).toBe(0)
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [me.player_id])).toBe(0)
    expect(await num(db, `select count(*) from public.player_guardians where player_id = $1`, [me.player_id])).toBe(0)
    expect(await num(db, `select count(*) from public.guardian_invitations where player_id = $1`, [me.player_id])).toBe(0)
    // FAMILY's own child, membership and answer are untouched
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [kid])).toBe(1)
    expect(await num(db, `select count(*) from public.team_members where team_id = $1 and user_id = $2`, [t.id, FAMILY])).toBe(1)
    await db.query('delete from auth.users where id = $1', [ADULT])
    expect(await num(db, `select count(*) from public.players where self_user_id = $1 or created_by = $1 or updated_by = $1`, [ADULT])).toBe(0)
  })

  it('a proxy leaves: only the proxy link goes; the owner\'s self registration and answers stay', async () => {
    const { db, t, ev } = await setup()
    const me = await regSelf(db, ADULT, t.id)
    const inv = await invite(db, ADULT, me.player_id)
    await accept(db, FAMILY, inv.token)
    await answer(db, FAMILY, ev, me.player_id)
    expect((await purge(db, FAMILY)).self_registrations_deleted).toBe(0)
    expect(await one(db, `select is_self, self_user_id from public.players where id = $1`, [me.player_id])).toEqual({ is_self: true, self_user_id: ADULT })
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [me.player_id])).toBe(1)
    expect((await one(db, `select updated_by from public.attendance where player_id = $1`, [me.player_id])).updated_by).toBeNull()  // recorder id cleared
  })

  it('self registrations in every team are deleted; other people\'s children keep the existing rules', async () => {
    const { db, t } = await setup()
    const [t2] = await q(db, OTHER, `select id, share_token from public.create_team('別チーム', 'S')`)
    await joinTeamAs(db, ADULT, t2.share_token, 'y')
    await regSelf(db, ADULT, t.id); await regSelf(db, ADULT, t2.id)
    const shared = (await q(db, OTHER, `select public.register_player($1, '佐藤の子', null, true) as r`, [t.id]))[0].r.player_id
    await accept(db, ADULT, (await invite(db, OTHER, shared)).token)      // ADULT is also a co-guardian of a child
    expect((await purge(db, ADULT)).self_registrations_deleted).toBe(2)
    expect(await num(db, `select count(*) from public.players where id = $1`, [shared])).toBe(1)   // kept: OTHER still guards it
  })

  it('a self registration also goes if the Auth user is removed some other way (FK cascade, after the purge)', async () => {
    const { db, t } = await setup()
    const me = await regSelf(db, ADULT, t.id)
    await purge(db, ADULT)
    await db.query('delete from auth.users where id = $1', [ADULT])
    expect(await num(db, `select count(*) from public.players where id = $1`, [me.player_id])).toBe(0)
  })
})

describe('deletion preview matches the actual deletion', () => {
  const preview = (db: Db, u: string) => q(db, u, `select public.account_deletion_preview() as r`).then((r) => r[0].r)

  it('the own registration is listed for deletion even with a proxy (with its answers), never as kept', async () => {
    const { db, t, ev } = await setup()
    const me = await regSelf(db, ADULT, t.id)
    await accept(db, FAMILY, (await invite(db, ADULT, me.player_id)).token)
    await answer(db, FAMILY, ev, me.player_id)
    const pv = await preview(db, ADULT)
    expect(pv.children_to_delete).toEqual([{ player_id: me.player_id, name: '山田', team_name: '社会人チーム', answers: 1 }])
    expect(pv.children_kept_by_family).toEqual([])
  })

  it('counts match purge_account_data: own registrations + sole-guardian children deleted, shared children kept', async () => {
    const { db, t, ev } = await setup()
    const me = await regSelf(db, ADULT, t.id)
    await accept(db, FAMILY, (await invite(db, ADULT, me.player_id)).token)            // proxy on the self registration
    const solo = (await q(db, ADULT, `select public.register_player($1, '山田の子', null, true) as r`, [t.id]))[0].r.player_id
    await answer(db, ADULT, ev, solo)
    const shared = (await q(db, OTHER, `select public.register_player($1, '佐藤の子', null, true) as r`, [t.id]))[0].r.player_id
    await accept(db, ADULT, (await invite(db, OTHER, shared)).token)                   // ADULT co-guards a child
    const othersSelf = await regSelf(db, OTHER, t.id)
    await accept(db, ADULT, (await invite(db, OTHER, othersSelf.player_id)).token)     // ADULT is a proxy for OTHER
    const pv = await preview(db, ADULT)
    const toDelete = pv.children_to_delete.map((c: any) => c.player_id).sort()
    const kept = pv.children_kept_by_family.map((c: any) => c.player_id).sort()
    expect(toDelete).toEqual([me.player_id, solo].sort())
    expect(kept).toEqual([shared, othersSelf.player_id].sort())
    const r = await purge(db, ADULT)
    expect(r.self_registrations_deleted + r.children_deleted).toBe(toDelete.length)
    for (const id of toDelete) expect(await num(db, `select count(*) from public.players where id = $1`, [id])).toBe(0)
    for (const id of kept) expect(await num(db, `select count(*) from public.players where id = $1`, [id])).toBe(1)
  })

  it('a proxy\'s preview keeps the owner\'s self registration (only the link goes)', async () => {
    const { db, t } = await setup()
    const me = await regSelf(db, ADULT, t.id)
    await accept(db, FAMILY, (await invite(db, ADULT, me.player_id)).token)
    const pv = await preview(db, FAMILY)
    expect(pv.children_to_delete).toEqual([])
    expect(pv.children_kept_by_family.map((c: any) => c.player_id)).toEqual([me.player_id])
  })

  it('logged-out callers get nothing; the preview only describes the caller', async () => {
    const { db, t } = await setup()
    await regSelf(db, ADULT, t.id)
    await expect(q(db, null, `select public.account_deletion_preview()`)).rejects.toThrow(/permission denied/)
    expect((await preview(db, OTHER)).children_to_delete).toEqual([])
    expect((await one(db, `select pg_get_function_identity_arguments('public.account_deletion_preview'::regproc) a`)).a).toBe('')
  })
})

describe('children and family sharing are unchanged', () => {
  it('register_player creates ordinary registrations; guardians manage them as before', async () => {
    const { db, t, ev } = await setup()
    const kid = (await q(db, FAMILY, `select public.register_player($1, 'こども', '3年', true) as r`, [t.id]))[0].r.player_id
    expect(await one(db, `select is_self, self_user_id from public.players where id = $1`, [kid])).toEqual({ is_self: false, self_user_id: null })
    const inv = await invite(db, FAMILY, kid)
    await accept(db, ADULT, inv.token)
    await answer(db, ADULT, ev, kid)
    expect((await q(db, ADULT, `select public.update_player($1, 'こども2', '3年', true) as r`, [kid]))[0].r.status).toBe('updated')  // co-guardian may edit a child
    await q(db, ADULT, `select public.archive_player($1)`, [kid])
  })

  it('a person can have a self registration and children in the same team', async () => {
    const { db, t } = await setup()
    await regSelf(db, ADULT, t.id)
    await q(db, ADULT, `select public.register_player($1, '山田の子', null, true)`, [t.id])
    expect(await num(db, `select count(*) from public.player_guardians g join public.players p on p.id = g.player_id
      where g.user_id = $1 and p.team_id = $2`, [ADULT, t.id])).toBe(2)
  })

  it('KNOWN: an adult who registered themself earlier as an ordinary registration gets a second one (no automatic merge)', async () => {
    const { db, t } = await setup()
    await q(db, ADULT, `select public.register_player($1, '山田', null, true)`, [t.id])
    await regSelf(db, ADULT, t.id)
    expect(await num(db, `select count(*) from public.players where team_id = $1 and name = '山田'`, [t.id])).toBe(2)
  })
})

describe('applying to existing data and rolling back', () => {
  async function dataHash(db: Db) {
    return (await one(db, `select md5(concat_ws('|',
      (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
      (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m),
      (select string_agg((to_jsonb(p) - 'is_self' - 'self_user_id')::text, ',' order by id) from public.players p),
      (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g),
      (select string_agg(to_jsonb(e)::text, ',' order by id) from public.events e),
      (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
      (select string_agg(to_jsonb(i)::text, ',' order by id) from public.guardian_invitations i))) as h`)).h as string
  }
  async function schema(db: Db) {
    return (await db.query<{ k: string }>(`
      select 'tbl ' || n.nspname || '.' || c.relname || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(c.relacl::text, '') k
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'i')
      union all select 'col ' || attrelid::regclass || '.' || attname || ' nn=' || attnotnull from pg_attribute
        where attrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind = 'r')
          and attnum > 0 and not attisdropped
      union all select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
        where connamespace in ('public'::regnamespace, 'private'::regnamespace)
      union all select 'fn ' || p.oid::regprocedure || ' def=' || prosecdef || ' vol=' || provolatile::text || ' acl=' || coalesce(proacl::text, '') || ' ' || md5(prosrc)
        from pg_proc p where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      order by 1`)).rows.map((x) => x.k)
  }
  async function seeded() {
    const s = await setup({ before: true })
    const kid = (await q(s.db, FAMILY, `select public.register_player($1, 'こども', null, true) as r`, [s.t.id]))[0].r.player_id
    await answer(s.db, FAMILY, s.ev, kid)
    await invite(s.db, FAMILY, kid)
    return s
  }

  it('existing rows are unchanged and none becomes a self registration', async () => {
    const { db } = await seeded()
    const before = await dataHash(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(before)
    expect(await num(db, `select count(*) from public.players where is_self or self_user_id is not null`)).toBe(0)
  })

  it('rollback restores the previous schema exactly and keeps the rows; applying again works', async () => {
    const { db, t } = await seeded()
    const schemaBefore = await schema(db)
    await applyMigration(db, MIG)
    const me = await regSelf(db, ADULT, t.id)
    await db.exec(DOWN)
    expect(await schema(db)).toEqual(schemaBefore)
    expect(await num(db, `select count(*) from public.players where id = $1`, [me.player_id])).toBe(1)   // kept as an ordinary registration
    await applyMigration(db, MIG)
    expect(await num(db, `select count(*) from public.players where is_self`)).toBe(0)
  })

  it('applying twice is harmless; a failure while applying leaves nothing behind', async () => {
    const { db } = await seeded()
    const s0 = await schema(db)
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations', MIG), 'utf8')
    await expect(db.exec(`begin; ${sql}; select 1/0; commit;`)).rejects.toThrow()
    await db.exec('rollback').catch(() => {})
    expect(await schema(db)).toEqual(s0)
    await applyMigration(db, MIG)
    const s1 = await schema(db)
    await applyMigration(db, MIG)
    expect(await schema(db)).toEqual(s1)
  })
})
