// Phase 5 D5: the old share-token path (join_team / get_team_by_share_token) is closed in the database.
// Two layers: EXECUTE revoked for everyone, and bodies that refuse even if a grant comes back by mistake.
// resolve_legacy_team (members' bookmarks), join_by_token, preview_join and family invitations keep working.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, joinTeamAs, type Db } from './setup'

const MIG = '20261118210000_disable_legacy_join.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261118210000_disable_legacy_join_down.sql'), 'utf8')
const ALLOW = "set app.allow_legacy_join_reenable = 'yes-reopen-old-join-path'"
const U = (n: number) => `55600000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), MEM = U(2), OUT = U(3), STOP = U(4), GONE = U(5), FAM = U(6)
const q = (db: Db, u: string | null, s: string, p: unknown[] = []) => asUser(db, u, () => db.query<any>(s, p)).then((r) => r.rows)
const rpc = async (db: Db, u: string, s: string, p: unknown[] = []) => (await q(db, u, `select to_jsonb(public.${s}) as r`, p))[0].r
const OLD = [
  ['join_team', "select public.join_team($1, 'x')"],
  ['get_team_by_share_token', 'select * from public.get_team_by_share_token($1)'],
] as const
const members = async (db: Db, t: string) => (await db.query<any>('select user_id from public.team_members where team_id = $1 order by user_id', [t])).rows.map((r) => r.user_id)
const attempts = async (db: Db, u: string) => Number((await db.query<any>(`select count(*) n from private.rate_events where user_id = $1 and kind = 'join_attempt'`, [u])).rows[0].n)
async function schema(db: Db) {
  return (await db.query<{ k: string }>(`select p.oid::regprocedure || ' ' || prosecdef || ' ' || provolatile::text || ' ' || coalesce(proacl::text, '') || ' ' || md5(prosrc) k
    from pg_proc p where pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`)).rows.map((r) => r.k)
}
async function dataHash(db: Db) {
  return (await db.query<any>(`select md5(concat_ws('|',
    (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
    (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m),
    (select string_agg(to_jsonb(p)::text, ',' order by id) from public.players p),
    (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g),
    (select string_agg(to_jsonb(j)::text, ',' order by team_id) from private.team_join_tokens j))) h`)).rows[0].h as string
}

/** Team with owner, a member with a child, a stopped member and a removed person; FAM is a family member elsewhere. */
async function setup(opts: { beforeD5?: boolean } = {}) {
  const db = await createDb(opts.beforeD5 ? { before: MIG } : {})
  for (const u of [OWNER, MEM, OUT, STOP, GONE, FAM]) await addUser(db, u)
  const t = await rpc(db, OWNER, "create_team('ひまわり','O')")
  for (const u of [MEM, STOP, GONE]) await joinTeamAs(db, u, t.share_token, 'm')
  const kid = (await rpc(db, MEM, "register_player($1,'こども',null,true)", [t.id])).player_id
  await rpc(db, OWNER, 'suspend_member($1,$2)', [t.id, STOP])
  await rpc(db, OWNER, 'remove_member($1,$2)', [t.id, GONE])
  return { db, t, kid }
}

describe('the old path is closed', () => {
  it('nobody may execute the two old functions: anon, members, the owner, outsiders, stopped and removed people', async () => {
    const { db, t } = await setup()
    for (const u of [null, OWNER, MEM, OUT, STOP, GONE]) {
      for (const [fn, sql] of OLD) await expect(q(db, u, sql, [t.share_token]), `${fn} as ${u}`).rejects.toThrow(new RegExp(`permission denied for function ${fn}`))
    }
    for (const [fn] of OLD) {
      const acl = (await db.query<any>(`select proacl::text a, has_function_privilege('anon', oid, 'execute') anon, has_function_privilege('authenticated', oid, 'execute') auth,
        has_function_privilege('service_role', oid, 'execute') svc from pg_proc where proname = $1`, [fn])).rows[0]
      expect(acl, fn).toMatchObject({ anon: false, auth: false, svc: false })
      expect(acl.a).not.toMatch(/(anon|authenticated|service_role)=/)
      expect(acl.a).not.toMatch(/(^|[{,])=X/)                                   // no PUBLIC grant
    }
    expect(await members(db, t.id)).toEqual([MEM, OWNER, STOP].sort())
  })

  it('a grant restored by mistake still opens nothing: same refusal for valid / invalid tokens, no join, no name, not counted', async () => {
    const { db, t } = await setup()
    await db.exec('grant execute on function public.join_team(text, text) to authenticated; grant execute on function public.get_team_by_share_token(text) to authenticated')
    const before = await dataHash(db)
    for (const token of [t.share_token, 'x'.repeat(32), 'nope']) {
      for (const u of [OUT, MEM, OWNER, GONE, STOP]) {
        for (const [fn, sql] of OLD) await expect(q(db, u, sql, [token]), `${fn} ${u}`).rejects.toThrow(/legacy_join_disabled/)
      }
    }
    expect(await dataHash(db)).toBe(before)
    expect(await attempts(db, OUT)).toBe(0)
    await expect(q(db, null, OLD[0][1], [t.share_token])).rejects.toThrow(/permission denied/)   // anon: still no grant
    const src = (await db.query<any>(`select string_agg(prosrc, ' ') s from pg_proc where proname in ('join_team','get_team_by_share_token')`)).rows[0].s as string
    expect(src).not.toMatch(/from public\.|insert into|team_members|teams t/)                  // the bodies read nothing
  })

  it('the old share token is not a join token: join_by_token / preview_join treat it as unknown', async () => {
    const { db, t } = await setup()
    expect(await rpc(db, OUT, "join_by_token($1,'x')", [t.share_token])).toEqual({ status: 'invalid' })
    expect(await q(db, OUT, 'select * from public.preview_join($1)', [t.share_token])).toEqual([])
    expect(await members(db, t.id)).not.toContain(OUT)
  })
})

describe('what is kept', () => {
  it('old bookmarks: an active member is told the team id; outsiders, stopped and removed people get nothing', async () => {
    const { db, t } = await setup()
    expect((await q(db, MEM, 'select public.resolve_legacy_team($1) id', [t.share_token]))[0].id).toBe(t.id)
    expect((await q(db, OWNER, 'select public.resolve_legacy_team($1) id', [t.share_token]))[0].id).toBe(t.id)
    for (const u of [OUT, GONE]) expect((await q(db, u, 'select public.resolve_legacy_team($1) id', [t.share_token]))[0].id, u).toBeNull()
    await expect(q(db, STOP, 'select public.resolve_legacy_team($1) id', [t.share_token])).rejects.toThrow(/team_access_suspended/)
    await expect(q(db, null, 'select public.resolve_legacy_team($1) id', [t.share_token])).rejects.toThrow(/permission denied/)
  })

  it('the join link: join, re-issue (old link dead), stop / reopen; stopped and removed people stay out', async () => {
    const { db, t } = await setup()
    const link = (await rpc(db, OWNER, 'get_join_link($1)', [t.id])).token
    expect((await q(db, OUT, 'select * from public.preview_join($1)', [link]))[0]).toMatchObject({ team_id: t.id, is_member: false })
    expect(await rpc(db, OUT, "join_by_token($1,'新人')", [link])).toEqual({ status: 'joined', team_id: t.id })
    const next = (await rpc(db, OWNER, 'rotate_join_token($1)', [t.id])).token
    expect(await rpc(db, FAM, "join_by_token($1,'x')", [link])).toEqual({ status: 'invalid' })
    await rpc(db, OWNER, 'set_join_open($1,false)', [t.id])
    expect(await rpc(db, FAM, "join_by_token($1,'x')", [next])).toEqual({ status: 'invalid' })
    const reopened = (await rpc(db, OWNER, 'set_join_open($1,true)', [t.id])).token
    await expect(rpc(db, GONE, "join_by_token($1,'x')", [reopened])).rejects.toThrow(/blocked_from_team/)
    await expect(rpc(db, STOP, "join_by_token($1,'x')", [reopened])).rejects.toThrow(/team_access_suspended/)
    expect(await rpc(db, FAM, "join_by_token($1,'x')", [reopened])).toEqual({ status: 'joined', team_id: t.id })
  })

  it('family invitations and the team-size limit work as before', async () => {
    const { db, t, kid } = await setup()
    const inv = await rpc(db, MEM, 'create_guardian_invitation($1)', [kid])
    expect(await rpc(db, FAM, "accept_guardian_invitation($1,'家族')", [inv.token])).toMatchObject({ status: 'accepted', team_id: t.id })
    await db.query(`with u as (insert into auth.users (id) select gen_random_uuid() from generate_series(1, 300 - (select count(*)::int from public.team_members where team_id = $1)) returning id)
      insert into public.team_members (team_id, user_id, role, display_name) select $1, id, 'member', 'x' from u`, [t.id])
    const link = (await rpc(db, OWNER, 'get_join_link($1)', [t.id])).token
    await expect(rpc(db, OUT, "join_by_token($1,'x')", [link])).rejects.toThrow(/team_member_limit_exceeded/)
  })
})

describe('migration and rollback', () => {
  it('applying changes no data; only the two functions change (bodies and grants)', async () => {
    const { db, t } = await setup({ beforeD5: true })
    expect((await q(db, OUT, "select public.join_team($1,'x') id", [t.share_token]))[0].id).toBe(t.id)   // open before D5
    const s0 = await schema(db), d0 = await dataHash(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(d0)
    const changed = (await schema(db)).filter((k) => !s0.includes(k)).map((k) => k.split('(')[0])
    expect(changed.sort()).toEqual(['get_team_by_share_token', 'join_team'])
  })

  it('the rollback is refused without the explicit setting, and the old path stays closed after the refusal', async () => {
    const { db, t } = await setup()
    const s1 = await schema(db)
    await expect(db.exec(DOWN)).rejects.toThrow(/legacy_join_rollback_refused/)
    await db.exec('rollback').catch(() => {})
    expect(await schema(db)).toEqual(s1)
    for (const [fn, sql] of OLD) await expect(q(db, OUT, sql, [t.share_token]), fn).rejects.toThrow(/permission denied/)
    expect(await members(db, t.id)).not.toContain(OUT)
    await db.exec("set app.allow_legacy_join_reenable = 'yes'")                         // a vague "yes" is not enough
    await expect(db.exec(DOWN)).rejects.toThrow(/legacy_join_rollback_refused/)
    await db.exec('rollback').catch(() => {})
    await db.exec('reset app.allow_legacy_join_reenable')
    expect(await schema(db)).toEqual(s1)
  })

  it('with the explicit setting it restores the pre-D5 functions and grants exactly; re-applying closes it again', async () => {
    const before = await setup({ beforeD5: true })
    const s0 = await schema(before.db)
    const { db, t } = await setup()
    const d1 = await dataHash(db)
    await db.exec(ALLOW)
    await db.exec(DOWN)
    await db.exec('reset app.allow_legacy_join_reenable')
    const restored = (await schema(db)).filter((k) => /^(join_team|get_team_by_share_token)\(/.test(k))
    expect(restored).toEqual(s0.filter((k) => /^(join_team|get_team_by_share_token)\(/.test(k)))
    expect(await dataHash(db)).toBe(d1)
    expect((await q(db, OUT, "select public.join_team($1,'x') id", [t.share_token]))[0].id).toBe(t.id)  // DANGER shown: re-opened
    await applyMigration(db, MIG)
    await expect(q(db, FAM, "select public.join_team($1,'x')", [t.share_token])).rejects.toThrow(/permission denied/)
  })

  it('a failure while applying leaves nothing behind; applying twice is harmless', async () => {
    const { db } = await setup({ beforeD5: true })
    const s0 = await schema(db)
    const sql = readFileSync(join(import.meta.dirname, '../../supabase/migrations', MIG), 'utf8')
    await expect(db.exec(`${sql.replace(/\bcommit;\s*$/, '')} select 1/0; commit;`)).rejects.toThrow()
    await db.exec('rollback').catch(() => {})
    expect(await schema(db)).toEqual(s0)
    await applyMigration(db, MIG)
    const s1 = await schema(db)
    await applyMigration(db, MIG)
    expect(await schema(db)).toEqual(s1)
  })
})
