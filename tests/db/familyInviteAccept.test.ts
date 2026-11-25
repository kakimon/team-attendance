// Phase 6 family invitations: accept_guardian_invitation no longer re-inserts existing members,
// a NEW member's display name is checked, and preview_guardian_invitation (read only) tells the page
// what to ask. Also: revoking, other people's invitations, and the up / down / up migration.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261124000000_family_invite_accept.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261124000000_family_invite_accept_down.sql'), 'utf8')
const U = (n: number) => `56100000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), MEM = U(2), NEW = U(3), OTHER = U(4), OUT = U(5), NEW2 = U(6)

const q = <T = any>(db: Db, u: string | null, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<T>(sql, p)).rows)
const one = async (db: Db, u: string | null, sql: string, p: unknown[] = []) => (await q(db, u, sql, p))[0]
/** Read as the database owner (checks only). */
const row = async (db: Db, sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0]
const accept = (db: Db, u: string, token: string, name: string | null) => one(db, u, 'select public.accept_guardian_invitation($1, $2) as r', [token, name]).then((r) => r.r)
const preview = (db: Db, u: string | null, token: string | null) => one(db, u, 'select public.preview_guardian_invitation($1) as r', [token]).then((r) => r.r)
const invite = (db: Db, u: string, kid: string) => one(db, u, 'select public.create_guardian_invitation($1) as r', [kid]).then((r) => r.r as { id: string; token: string })

/** Team (OWNER; MEM member with a self registration), OWNER's proxy child, an event, two answers, OTHER's team. */
async function setup(opts: { before?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : {})
  for (let i = 1; i <= 6; i++) await addUser(db, U(i))
  const t = await one(db, OWNER, `select id, share_token from public.create_team('テストチーム', 'T1')`)
  await joinTeamAs(db, MEM, t.share_token, 'テスト2')
  const self = (await one(db, MEM, 'select public.register_self($1) as r', [t.id])).r.player_id as string
  const kid = (await one(db, OWNER, `select public.register_player($1, 'テスト こどもB', null, true) as r`, [t.id])).r.player_id as string
  const ev = (await one(db, OWNER, `select public.create_event($1, 'テスト練習', now() + interval '1 day') as id`, [t.id])).id as string
  await q(db, MEM, `select public.set_attendance($1, $2, 'undecided')`, [ev, self])
  await q(db, OWNER, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])
  const o = await one(db, OTHER, `select id from public.create_team('別チーム', 'O')`)
  const okid = (await one(db, OTHER, `select public.register_player($1, '別の子', null, true) as r`, [o.id])).r.player_id as string
  return { db, team: t.id as string, share: t.share_token as string, self, kid, ev, other: o.id as string, okid }
}
const member = (db: Db, team: string, u: string) =>
  db.query<any>(`select to_jsonb(m) j from public.team_members m where team_id = $1 and user_id = $2`, [team, u]).then((r) => r.rows[0]?.j ?? null)
/** Every row of every app table except the ones the case is allowed to change. */
const rest = (db: Db, except: { inv?: string; guardian?: [string, string]; member?: [string, string] } = {}) =>
  db.query<{ h: string }>(`select md5(concat_ws('|',
    (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m
      where ($3::uuid is null or not (team_id = $3 and user_id = $4))),
    (select string_agg(to_jsonb(p)::text, ',' order by id) from public.players p),
    (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g
      where ($1::uuid is null or not (player_id = $1 and user_id = $2))),
    (select string_agg(to_jsonb(e)::text, ',' order by id) from public.events e),
    (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
    (select string_agg(to_jsonb(i)::text, ',' order by id) from public.guardian_invitations i where ($5::uuid is null or id <> $5)))) h`,
  [except.guardian?.[0] ?? null, except.guardian?.[1] ?? null, except.member?.[0] ?? null, except.member?.[1] ?? null, except.inv ?? null])
    .then((r) => r.rows[0]!.h)
/** Who may execute a function (PUBLIC = the pseudo-role, via the ACL; the others via has_function_privilege). */
const roleExec = (db: Db, fn: string) => db.query<any>(`select
    exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') pub,
    has_function_privilege('anon', $1::regprocedure, 'execute') anon,
    has_function_privilege('authenticated', $1::regprocedure, 'execute') authenticated,
    has_function_privilege('service_role', $1::regprocedure, 'execute') service_role`, [fn]).then((r) => r.rows[0])
const aclOf = (db: Db, fn: string) => db.query<any>(`select coalesce(proacl::text, '-') a from pg_proc where oid = $1::regprocedure`, [fn]).then((r) => r.rows[0].a)
const guardiansOf = (db: Db, kid: string) =>
  db.query<any>(`select user_id, added_via from public.player_guardians where player_id = $1 order by created_at, user_id`, [kid]).then((r) => r.rows)

describe('accept_guardian_invitation (Phase 6)', () => {
  it('1/2/12: an existing member with a self registration accepts: guardian added, invitation used, the member row and everything else unchanged', async () => {
    const { db, team, kid } = await setup()
    const inv = await invite(db, OWNER, kid)
    const before = await member(db, team, MEM)
    const restBefore = await rest(db, { inv: inv.id, guardian: [kid, MEM] })
    for (const name of ['', '   ', '　', 'x'.repeat(41), null]) {   // the name is ignored for members
      const r = await accept(db, MEM, inv.token, name)
      expect(r.status).toBe(name === '' ? 'accepted' : 'already_guardian')
    }
    expect(await member(db, team, MEM)).toEqual(before)
    expect(await guardiansOf(db, kid)).toEqual([{ user_id: OWNER, added_via: 'registrant' }, { user_id: MEM, added_via: 'invitation' }])
    expect(await row(db, 'select used_by, revoked_at from public.guardian_invitations where id = $1', [inv.id])).toEqual({ used_by: MEM, revoked_at: null })
    expect(await rest(db, { inv: inv.id, guardian: [kid, MEM] })).toBe(restBefore)
    // the member now answers for both (self first); the self registration is untouched
    const mine = await q(db, MEM, `select player_id from public.player_guardians where user_id = $1 order by created_at`, [MEM])
    expect(mine.length).toBe(2)
  })

  it('3: a new member joins with a trimmed name (spaces and full-width spaces)', async () => {
    const { db, team, kid } = await setup()
    const inv = await invite(db, OWNER, kid)
    expect((await accept(db, NEW, inv.token, '　 田中 花子 　')).status).toBe('accepted')
    expect(await member(db, team, NEW)).toMatchObject({ role: 'member', display_name: '田中 花子', suspended_at: null })
  })

  it('4: a new member with an empty / blank / 41-character name is refused before anything is written', async () => {
    const { db, team, kid } = await setup()
    const inv = await invite(db, OWNER, kid)
    const h = await rest(db)
    for (const [name, err] of [['', /name_required/], ['   ', /name_required/], ['　\t', /name_required/], [null, /name_required/],
      ['あ'.repeat(41), /display_name_too_long/]] as const) {
      await expect(accept(db, NEW, inv.token, name)).rejects.toThrow(err)
    }
    expect(await rest(db)).toBe(h)
    expect(await member(db, team, NEW)).toBeNull()
    expect((await accept(db, NEW, inv.token, 'あ'.repeat(40))).status).toBe('accepted')       // 40 is fine
  })

  it('5: used / expired / revoked / unknown / cancelled-child invitations: invitation_invalid (before any name question), nothing written', async () => {
    const { db, kid, team } = await setup()
    const used = await invite(db, OWNER, kid); await accept(db, NEW, used.token, 'N')
    const expired = await invite(db, OWNER, kid)
    await db.query(`update public.guardian_invitations set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1`, [expired.id])
    const revoked = await invite(db, OWNER, kid); await q(db, OWNER, 'select public.revoke_guardian_invitation($1)', [revoked.id])
    const h = await rest(db)
    for (const tok of [used.token, expired.token, revoked.token, 'f'.repeat(64), 'short']) {
      for (const u of [NEW2, MEM]) {
        await expect(accept(db, u, tok, '')).rejects.toThrow(/invitation_invalid/)
        expect(await preview(db, u, tok)).toEqual({ status: 'invalid' })
      }
    }
    expect(await rest(db)).toBe(h)
    // cancelled child
    const k2 = (await one(db, OWNER, `select public.register_player($1, '取り消す子', null, true) as r`, [team])).r.player_id
    const i2 = await invite(db, OWNER, k2)
    await q(db, OWNER, 'select public.archive_player($1)', [k2])
    const h2 = await rest(db)
    await expect(accept(db, NEW2, i2.token, 'N')).rejects.toThrow(/invitation_invalid/)
    expect(await preview(db, NEW2, i2.token)).toEqual({ status: 'invalid' })
    expect(await member(db, team, NEW2)).toBeNull()
    expect(await rest(db)).toBe(h2)
  })

  it('6: a suspended member and a removed (blocked) person are refused; nothing written', async () => {
    const { db, team, kid } = await setup()
    const inv = await invite(db, OWNER, kid)
    await q(db, OWNER, 'select public.suspend_member($1, $2)', [team, MEM])
    let h = await rest(db)
    await expect(accept(db, MEM, inv.token, 'x')).rejects.toThrow(/team_access_suspended/)
    expect(await preview(db, MEM, inv.token)).toEqual({ status: 'suspended' })
    expect(await rest(db)).toBe(h)
    await joinTeamAs(db, NEW, (await row(db, 'select share_token from public.teams where id = $1', [team])).share_token, 'N')
    await q(db, OWNER, 'select public.remove_member($1, $2)', [team, NEW])
    h = await rest(db)
    await expect(accept(db, NEW, inv.token, 'N')).rejects.toThrow(/blocked_from_team/)
    expect(await rest(db)).toBe(h)
  })

  it('7: accepting twice: the same person gets already_guardian (not consumed again); a second person is refused', async () => {
    const { db, kid } = await setup()
    const inv = await invite(db, OWNER, kid)
    expect((await accept(db, NEW, inv.token, 'N')).status).toBe('accepted')
    expect((await accept(db, NEW, inv.token, 'N')).status).toBe('already_guardian')
    expect(await preview(db, NEW, inv.token)).toMatchObject({ status: 'already_guardian' })
    await expect(accept(db, NEW2, inv.token, 'M')).rejects.toThrow(/invitation_invalid/)
    expect(await guardiansOf(db, kid)).toHaveLength(2)
  })

  it('8/9/10: revoke by a guardian -> accept refused; non-guardians, other teams and anon cannot revoke', async () => {
    const { db, kid, okid } = await setup()
    const inv = await invite(db, OWNER, kid)
    const oinv = await invite(db, OTHER, okid)
    const h = await rest(db)
    await expect(q(db, MEM, 'select public.revoke_guardian_invitation($1)', [inv.id])).rejects.toThrow(/forbidden/)       // member, not guardian
    await expect(q(db, OTHER, 'select public.revoke_guardian_invitation($1)', [inv.id])).rejects.toThrow(/forbidden/)     // other team
    await expect(q(db, OWNER, 'select public.revoke_guardian_invitation($1)', [oinv.id])).rejects.toThrow(/forbidden/)    // other team's invite
    await expect(q(db, null, 'select public.revoke_guardian_invitation($1)', [inv.id])).rejects.toThrow(/permission denied/)
    expect(await rest(db)).toBe(h)
    await q(db, OWNER, 'select public.revoke_guardian_invitation($1)', [inv.id])
    expect((await row(db, 'select revoked_at from public.guardian_invitations where id = $1', [inv.id])).revoked_at).not.toBeNull()
    await expect(accept(db, MEM, inv.token, '')).rejects.toThrow(/invitation_invalid/)
    expect(await preview(db, MEM, inv.token)).toEqual({ status: 'invalid' })
    // the guardian can read state columns of their child's invitations, never token_hash
    const rows = await q(db, OWNER, 'select id, created_at, expires_at, used_at, revoked_at from public.guardian_invitations where player_id = $1', [kid])
    expect(rows).toHaveLength(1)
    await expect(q(db, OWNER, 'select token_hash from public.guardian_invitations')).rejects.toThrow(/permission denied/)
    expect(await q(db, MEM, 'select id from public.guardian_invitations where player_id = $1', [kid])).toEqual([])         // RLS: guardians only
  })

  it('accept and revoke in either order stay consistent (sequential; real concurrency is checked on Postgres separately)', async () => {
    const { db, kid } = await setup()
    const a = await invite(db, OWNER, kid)
    await accept(db, NEW, a.token, 'N')
    await q(db, OWNER, 'select public.revoke_guardian_invitation($1)', [a.id])          // used first: revoke changes nothing
    expect(await row(db, 'select used_by, revoked_at from public.guardian_invitations where id = $1', [a.id])).toEqual({ used_by: NEW, revoked_at: null })
    const b = await invite(db, OWNER, kid)
    await q(db, OWNER, 'select public.revoke_guardian_invitation($1)', [b.id])          // revoked first: accept refused
    await expect(accept(db, NEW2, b.token, 'M')).rejects.toThrow(/invitation_invalid/)
    expect(await row(db, 'select used_by from public.guardian_invitations where id = $1', [b.id])).toEqual({ used_by: null })
  })
})

describe('preview_guardian_invitation', () => {
  it('returns only what the page needs, never the token / ids of people; consumes and writes nothing', async () => {
    const { db, kid, team } = await setup()
    const inv = await invite(db, OWNER, kid)
    const h = await rest(db)
    const pm = await preview(db, MEM, inv.token)
    expect(Object.keys(pm).sort()).toEqual(['expires_at', 'is_member', 'needs_display_name', 'player_name', 'status', 'team_name'])
    expect(pm).toMatchObject({ status: 'valid', player_name: 'テスト こどもB', team_name: 'テストチーム', is_member: true, needs_display_name: false })
    expect(await preview(db, NEW, inv.token)).toMatchObject({ status: 'valid', is_member: false, needs_display_name: true })
    const text = JSON.stringify([pm, await preview(db, NEW, inv.token)])
    for (const secret of [inv.token, inv.id, OWNER, MEM, NEW, kid, team]) expect(text).not.toContain(secret)
    expect(await rest(db)).toBe(h)
    expect((await accept(db, MEM, inv.token, '')).status).toBe('accepted')              // still usable after previews
  })

  it('anon cannot call it; it is authenticated-only like the other RPCs, and session-bound', async () => {
    const { db, kid } = await setup()
    const inv = await invite(db, OWNER, kid)
    await expect(preview(db, null, inv.token)).rejects.toThrow(/permission denied/)
    const acl = await row(db, `select has_function_privilege('anon', 'public.preview_guardian_invitation(text)', 'execute') anon,
      has_function_privilege('authenticated', 'public.preview_guardian_invitation(text)', 'execute') auth,
      (select prosecdef from pg_proc where oid = 'public.preview_guardian_invitation(text)'::regprocedure) secdef,
      (select provolatile from pg_proc where oid = 'public.preview_guardian_invitation(text)'::regprocedure) vol`)
    expect(acl).toEqual({ anon: false, auth: true, secdef: true, vol: 's' })
    // preview (new): exactly the owner and authenticated may execute; PUBLIC, anon and service_role may not
    const grantees = await db.query<{ g: string }>(`select coalesce(r.rolname, 'PUBLIC') g from pg_proc p,
      aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee
      where p.oid = 'public.preview_guardian_invitation(text)'::regprocedure and a.privilege_type = 'EXECUTE' order by 1`)
    expect(grantees.rows.map((r) => r.g)).toEqual(['authenticated', 'postgres'])
    expect(await roleExec(db, 'public.preview_guardian_invitation(text)')).toEqual({ pub: false, anon: false, authenticated: true, service_role: false })
    await expect(asUser(db, MEM, () => db.query('select public.preview_guardian_invitation($1)', [inv.token]), U(99))).rejects.toThrow(/session_expired/)
  })
})

describe('migration up / down / up', () => {
  it('applies on existing data without changing it, rolls back to the previous functions, and re-applies', async () => {
    const { db, kid } = await setup({ before: true })
    await invite(db, OWNER, kid)
    const fns = async () => (await db.query<any>(`select oid::regprocedure::text s, md5(prosrc) h, proacl::text a from pg_proc
      where pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`)).rows
    const before = await fns(); const data = await rest(db)
    await applyMigration(db, MIG)
    expect(await rest(db)).toBe(data)
    const changed = (await fns()).filter((f) => !before.some((b) => b.s === f.s && b.h === f.h && b.a === f.a)).map((f) => f.s)
    expect(changed.sort()).toEqual(['accept_guardian_invitation(text,text)', 'preview_guardian_invitation(text)'])
    // the existing function's ACL is the same before and after (only its body changed)
    const acc = (rows: any[]) => rows.find((f) => f.s === 'accept_guardian_invitation(text,text)')!.a
    expect(acc(await fns())).toBe(acc(before))
    await db.exec(DOWN)
    expect(await fns()).toEqual(before)
    expect(await rest(db)).toBe(data)
    await applyMigration(db, MIG)
    expect((await fns()).length).toBe(before.length + 1)
  })

  it('accept_guardian_invitation: whatever its ACL was, the migration (and the rollback) leave it exactly as it was', async () => {
    const ACC = 'public.accept_guardian_invitation(text,text)'
    const { db } = await setup({ before: true })
    // also with an extra grant the environment may have (e.g. Supabase default privileges give service_role EXECUTE)
    for (const extra of [null, 'grant execute on function public.accept_guardian_invitation(text, text) to service_role']) {
      if (extra) await db.exec(extra)
      const acl = await aclOf(db, ACC), roles = await roleExec(db, ACC)
      expect(roles).toMatchObject({ pub: false, anon: false, authenticated: true })        // the invariant either way
      await applyMigration(db, MIG)
      expect(await aclOf(db, ACC)).toBe(acl)
      expect(await roleExec(db, ACC)).toEqual(roles)
      await db.exec(DOWN)
      expect(await aclOf(db, ACC)).toBe(acl)
      expect(await roleExec(db, ACC)).toEqual(roles)
    }
  })

  it('before the migration (old database): an existing member with an empty name hits the old constraint error', async () => {
    const { db, kid } = await setup({ before: true })
    const inv = await invite(db, OWNER, kid)
    await expect(accept(db, MEM, inv.token, '')).rejects.toThrow(/display_name_check/)
    await expect(preview(db, MEM, inv.token)).rejects.toThrow(/does not exist/)
  })
})
