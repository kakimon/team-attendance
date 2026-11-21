// Phase 5-B U4 (D4): removing members, leaving, the block list, deleting a team.
// PGlite has ONE connection: the lock order is checked in the SQL; truly parallel behaviour is not
// proven here (later local-Supabase test).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db, joinTeamAs } from './setup'

const MIG = '20261117233000_member_removal.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117233000_member_removal_down.sql'), 'utf8')
const U = (n: number) => `54400000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), ADMIN = U(2), MEM = U(3), FAM = U(4), OTHER = U(5), OUT = U(6)

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = []) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)
}
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0]
const num = async (db: Db, sql: string, params: unknown[] = []) => Number(Object.values(await one(db, sql, params))[0])
const isMember = async (db: Db, team: string, u: string) => (await num(db, `select count(*) from public.team_members where team_id = $1 and user_id = $2`, [team, u])) === 1
const remove = (db: Db, by: string, team: string, u: string) => q(db, by, `select public.remove_member($1, $2) as r`, [team, u]).then((r) => r[0].r)
const leave = (db: Db, u: string, team: string) => q(db, u, `select public.leave_team($1) as r`, [team]).then((r) => r[0].r)
const tokenOf = async (db: Db, team: string) => (await one(db, `select token from private.team_join_tokens where team_id = $1`, [team])).token as string
const joinNew = (db: Db, u: string, token: string) => q(db, u, `select public.join_by_token($1, 'm') as r`, [token]).then((r) => r[0].r)
const joinOld = (db: Db, u: string, share: string) => joinTeamAs(db, u, share, 'm')
const regSelf = (db: Db, u: string, team: string) => q(db, u, `select public.register_self($1) as r`, [team]).then((r) => r[0].r.player_id as string)
const regChild = (db: Db, u: string, team: string, name: string) => q(db, u, `select public.register_player($1, $2, null, true) as r`, [team, name]).then((r) => r[0].r.player_id as string)
const invite = (db: Db, u: string, player: string) => q(db, u, `select public.create_guardian_invitation($1) as r`, [player]).then((r) => r[0].r)
const accept = (db: Db, u: string, token: string) => q(db, u, `select public.accept_guardian_invitation($1, '家族') as r`, [token]).then((r) => r[0].r)
const answer = (db: Db, u: string, ev: string, p: string) => q(db, u, `select public.set_attendance($1, $2, 'attend')`, [ev, p])

/** Team T (OWNER; ADMIN as admin; MEM, FAM, OTHER as members), one event; another team T2 where MEM is also a member. */
async function setup(opts: { before?: boolean; beforeD5?: boolean } = {}) {
  const db = await createDb(opts.before ? { before: MIG } : opts.beforeD5 ? { before: '20261118210000_disable_legacy_join.sql' } : {})
  for (let i = 1; i <= 6; i++) await addUser(db, U(i))
  const [t] = await q(db, OWNER, `select id, share_token from public.create_team('チームT', 'オーナー')`)
  for (const u of [ADMIN, MEM, FAM, OTHER]) await joinOld(db, u, t.share_token)
  await q(db, OWNER, `select public.set_member_role($1, $2, 'admin')`, [t.id, ADMIN])
  const [{ id: ev }] = await q(db, OWNER, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const [t2] = await q(db, OTHER, `select id, share_token from public.create_team('チーム2', 'O2')`)
  await joinOld(db, MEM, t2.share_token)
  const [{ id: ev2 }] = await q(db, OTHER, `select public.create_event($1, '別練習', now() + interval '1 day') as id`, [t2.id])
  return { db, t: t as { id: string; share_token: string }, t2: t2 as { id: string; share_token: string }, ev: ev as string, ev2: ev2 as string }
}

describe('removing a member (owner only)', () => {
  it('the owner removes a member: membership gone, reads and writes refused at once, the user is blocked', async () => {
    const { db, t, ev } = await setup()
    const r = await remove(db, OWNER, t.id, MEM)
    expect(r).toMatchObject({ status: 'removed', self_registrations_deleted: 0 })
    expect(await isMember(db, t.id, MEM)).toBe(false)
    // the same token / session that was valid before now sees and changes nothing in that team
    expect(await q(db, MEM, `select * from public.teams where id = $1`, [t.id])).toEqual([])
    expect(await q(db, MEM, `select * from public.events where team_id = $1`, [t.id])).toEqual([])
    await expect(q(db, MEM, `select public.register_self($1)`, [t.id])).rejects.toThrow(/forbidden/)
    expect((await q(db, OWNER, `select * from public.blocked_members($1)`, [t.id])).map((b: any) => b.user_id)).toEqual([MEM])
  })

  it('a second session of the removed user (another device) is refused too', async () => {
    const { db, t } = await setup()
    await db.query(`insert into auth.sessions (id, user_id) values ($1, $2)`, [U(77), MEM])
    await remove(db, OWNER, t.id, MEM)
    const other = await asUser(db, MEM, async () => (await db.query(`select * from public.team_members where team_id = $1`, [t.id])).rows, U(77))
    expect(other).toEqual([])
  })

  it('admins and plain members cannot remove; nobody can remove the owner; outsiders get forbidden', async () => {
    const { db, t } = await setup()
    await expect(remove(db, ADMIN, t.id, MEM)).rejects.toThrow(/forbidden/)
    await expect(remove(db, MEM, t.id, FAM)).rejects.toThrow(/forbidden/)
    await expect(remove(db, OUT, t.id, MEM)).rejects.toThrow(/forbidden/)
    await expect(remove(db, OWNER, t.id, OWNER)).rejects.toThrow(/cannot_remove_owner/)
    await expect(remove(db, OWNER, t.id, OUT)).rejects.toThrow(/member_not_found/)
    for (const u of [ADMIN, MEM, FAM]) expect(await isMember(db, t.id, u)).toBe(true)
  })

  it('the owner can remove an admin; existing roles of the others do not change', async () => {
    const { db, t } = await setup()
    await remove(db, OWNER, t.id, ADMIN)
    expect(await isMember(db, t.id, ADMIN)).toBe(false)
    expect((await one(db, `select role from public.team_members where team_id = $1 and user_id = $2`, [t.id, OWNER])).role).toBe('owner')
  })

  it('logged-out callers are refused on every U4 function', async () => {
    const { db, t } = await setup()
    for (const sql of [`select public.remove_member('${t.id}', '${MEM}')`, `select public.leave_team('${t.id}')`,
      `select public.unblock_member('${t.id}', '${MEM}')`, `select * from public.blocked_members('${t.id}')`,
      `select public.leave_preview('${t.id}')`, `select public.removal_preview('${t.id}', '${MEM}')`,
      `select public.delete_team('${t.id}', 'x')`]) {
      await expect(q(db, null, sql)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('re-joining after removal', () => {
  it('before D5 the old link also refused a removed member (blocked_from_team) [before D5]', async () => {
    const { db, t } = await setup({ beforeD5: true })
    await remove(db, OWNER, t.id, MEM)
    await expect(q(db, MEM, `select public.join_team($1, 'm')`, [t.share_token])).rejects.toThrow(/blocked_from_team/)
  })

  it('refused through the new link, the old link and a family invitation; allowed again after unblocking', async () => {
    const { db, t } = await setup()
    const kid = await regChild(db, FAM, t.id, 'ふぁむの子')
    await remove(db, OWNER, t.id, MEM)
    await expect(joinNew(db, MEM, await tokenOf(db, t.id))).rejects.toThrow(/blocked_from_team/)
    // D5: the old share-token link is closed for everyone (checked before D5 in the next test)
    await expect(q(db, MEM, `select public.join_team($1, 'm')`, [t.share_token])).rejects.toThrow(/permission denied for function join_team/)
    const inv = await invite(db, FAM, kid)
    await expect(accept(db, MEM, inv.token)).rejects.toThrow(/blocked_from_team/)
    expect((await one(db, `select used_at from public.guardian_invitations where id = $1`, [inv.id])).used_at).toBeNull()
    // rotating the link does not lift the block
    await q(db, OWNER, `select public.rotate_join_token($1)`, [t.id])
    await expect(joinNew(db, MEM, await tokenOf(db, t.id))).rejects.toThrow(/blocked_from_team/)
    // only the owner can unblock
    await expect(q(db, ADMIN, `select public.unblock_member($1, $2)`, [t.id, MEM])).rejects.toThrow(/forbidden/)
    expect((await q(db, OWNER, `select public.unblock_member($1, $2) as ok`, [t.id, MEM]))[0].ok).toBe(true)
    expect(await joinNew(db, MEM, await tokenOf(db, t.id))).toEqual({ status: 'joined', team_id: t.id })
  })

  it('the block list keeps only team id, user id and time; only the owner can read it', async () => {
    const { db, t } = await setup()
    await remove(db, OWNER, t.id, MEM)
    const cols = (await db.query<{ c: string }>(`select column_name c from information_schema.columns
      where table_schema = 'private' and table_name = 'team_member_blocks' order by 1`)).rows.map((r) => r.c)
    expect(cols).toEqual(['created_at', 'team_id', 'user_id'])
    await expect(q(db, ADMIN, `select * from public.blocked_members($1)`, [t.id])).rejects.toThrow(/forbidden/)
    await expect(q(db, OWNER, `select * from private.team_member_blocks`)).rejects.toThrow(/permission denied/)
  })

  it('a member who left by themself is not blocked and can join again', async () => {
    const { db, t } = await setup()
    await leave(db, FAM, t.id)
    expect(await joinNew(db, FAM, await tokenOf(db, t.id))).toEqual({ status: 'joined', team_id: t.id })
  })
})

describe('leaving a team', () => {
  it('a member leaves; other teams are untouched', async () => {
    const { db, t, t2, ev2 } = await setup()
    const mine2 = await regSelf(db, MEM, t2.id)
    await answer(db, MEM, ev2, mine2)
    await regSelf(db, MEM, t.id)
    expect((await leave(db, MEM, t.id)).status).toBe('left')
    expect(await isMember(db, t.id, MEM)).toBe(false)
    expect(await isMember(db, t2.id, MEM)).toBe(true)
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [mine2])).toBe(1)
  })

  it('the owner cannot leave; a non-member gets not_member', async () => {
    const { db, t } = await setup()
    await expect(leave(db, OWNER, t.id)).rejects.toThrow(/owner_cannot_leave/)
    await expect(leave(db, OUT, t.id)).rejects.toThrow(/not_member/)
  })
})

describe('registrations of the person who goes', () => {
  it('own self registration: deleted with answers, proxy links and invitations, even with a proxy', async () => {
    const { db, t, ev } = await setup()
    const me = await regSelf(db, MEM, t.id)
    await accept(db, FAM, (await invite(db, MEM, me)).token)            // FAM answers for MEM
    await answer(db, FAM, ev, me)
    const pending = await invite(db, MEM, me)                            // an unused invitation
    const pv = (await q(db, MEM, `select public.leave_preview($1) as r`, [t.id]))[0].r
    expect(pv.self_registrations).toEqual([{ player_id: me, name: 'm', answers: 1 }])
    expect(pv.sole_guardian_children).toEqual([])
    const r = await leave(db, MEM, t.id)
    expect(r.self_registrations_deleted).toBe(1)
    for (const tbl of ['players', 'attendance', 'player_guardians', 'guardian_invitations']) {
      const col = tbl === 'players' ? 'id' : 'player_id'
      expect(await num(db, `select count(*) from public.${tbl} where ${col} = $1`, [me])).toBe(0)
    }
    expect(await num(db, `select count(*) from public.guardian_invitations where id = $1`, [pending.id])).toBe(0)
    expect(await isMember(db, t.id, FAM)).toBe(true)                    // the proxy stays in the team
  })

  it('other people\'s self registrations and shared children: only the link of the person who goes is removed', async () => {
    const { db, t, ev } = await setup()
    const others = await regSelf(db, OTHER, t.id)
    await accept(db, MEM, (await invite(db, OTHER, others)).token)      // MEM is a proxy for OTHER
    const shared = await regChild(db, FAM, t.id, '共有の子')
    await accept(db, MEM, (await invite(db, FAM, shared)).token)         // MEM co-guards FAM's child
    await answer(db, MEM, ev, shared)
    const pv = (await q(db, OWNER, `select public.removal_preview($1, $2) as r`, [t.id, MEM]))[0].r
    expect(pv.links_removed.map((x: any) => x.player_id).sort()).toEqual([others, shared].sort())
    const r = await remove(db, OWNER, t.id, MEM)
    expect(r).toMatchObject({ self_registrations_deleted: 0, links_removed: 2 })
    expect(await one(db, `select is_self, self_user_id from public.players where id = $1`, [others])).toEqual({ is_self: true, self_user_id: OTHER })
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [shared])).toBe(1)
    await answer(db, FAM, ev, shared)                                    // the co-guardian keeps answering
    expect(await num(db, `select count(*) from public.player_guardians where player_id = $1`, [shared])).toBe(1)
  })

  it('a child with the person as the ONLY guardian: leaving and removal are refused, nothing changes', async () => {
    const { db, t, ev } = await setup()
    const solo = await regChild(db, MEM, t.id, 'ひとりの子')
    await answer(db, MEM, ev, solo)
    const before = await num(db, `select count(*) from public.team_members where team_id = $1`, [t.id])
    await expect(leave(db, MEM, t.id)).rejects.toThrow(/sole_guardian_children/)
    await expect(remove(db, OWNER, t.id, MEM)).rejects.toThrow(/sole_guardian_children/)
    expect(await num(db, `select count(*) from public.team_members where team_id = $1`, [t.id])).toBe(before)
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [solo])).toBe(1)
    expect(await num(db, `select count(*) from private.team_member_blocks`)).toBe(0)
    // a cancelled child still counts (it would be left without a guardian)
    await q(db, MEM, `select public.archive_player($1)`, [solo])
    await expect(leave(db, MEM, t.id)).rejects.toThrow(/sole_guardian_children/)
  })

  it('a failure in the middle rolls everything back (membership, registrations, block)', async () => {
    const { db, t, ev } = await setup()
    const me = await regChild(db, FAM, t.id, 'Shared')
    await accept(db, MEM, (await invite(db, FAM, me)).token)
    await answer(db, MEM, ev, me)
    await db.exec(`create function private.fail_block() returns trigger language plpgsql as $$ begin raise exception 'injected_failure'; end $$;
      create trigger fail_block before insert on private.team_member_blocks for each row execute function private.fail_block();`)
    await expect(remove(db, OWNER, t.id, MEM)).rejects.toThrow(/injected_failure/)
    expect(await isMember(db, t.id, MEM)).toBe(true)
    expect(await num(db, `select count(*) from public.attendance where player_id = $1`, [me])).toBe(1)
    expect(await num(db, `select count(*) from private.team_member_blocks`)).toBe(0)
    expect(await num(db, `select count(*) from public.player_guardians where player_id=$1 and user_id=$2`, [me,MEM])).toBe(1)
  })
})

describe('deleting a team', () => {
  it('only the owner, only when nobody else is a member, with the exact name; the owner slot comes back', async () => {
    const db = await createDb()
    for (let i = 1; i <= 6; i++) await addUser(db, U(i))
    const teams = []
    for (let i = 0; i < 3; i++) teams.push((await q(db, OWNER, `select id, share_token from public.create_team($1, 'o')`, [`T${i}`]))[0])
    await expect(q(db, OWNER, `select public.create_team('T3', 'o')`)).rejects.toThrow(/owner_quota_exceeded/)
    await joinOld(db, MEM, teams[0].share_token)
    await expect(q(db, OWNER, `select public.delete_team($1, 'T0')`, [teams[0].id])).rejects.toThrow(/team_has_members/)
    await expect(q(db, MEM, `select public.delete_team($1, 'T1')`, [teams[1].id])).rejects.toThrow(/forbidden/)
    await expect(q(db, OWNER, `select public.delete_team($1, 'T')`, [teams[1].id])).rejects.toThrow(/confirm_mismatch/)
    const [{ id: ev }] = await q(db, OWNER, `select public.create_event($1, 'e', now()) as id`, [teams[1].id])
    const me = await regSelf(db, OWNER, teams[1].id)
    await answer(db, OWNER, ev, me)
    expect((await q(db, OWNER, `select public.delete_team($1, ' T1 ') as r`, [teams[1].id]))[0].r.status).toBe('deleted')
    for (const tbl of ['teams', 'team_members', 'players', 'events']) {
      const col = tbl === 'teams' ? 'id' : 'team_id'
      expect(await num(db, `select count(*) from public.${tbl} where ${col} = $1`, [teams[1].id])).toBe(0)
    }
    expect(await num(db, `select count(*) from public.attendance where team_id = $1`, [teams[1].id])).toBe(0)
    expect(await num(db, `select count(*) from private.team_join_tokens where team_id = $1`, [teams[1].id])).toBe(0)
    // slot back; the 24-hour creation records are kept (3 creations so far)
    expect(await num(db, `select count(*) from private.rate_events where user_id = $1 and kind = 'team_create'`, [OWNER])).toBe(3)
    await q(db, OWNER, `select public.create_team('T3', 'o')`)
    // the other teams are untouched
    expect(await num(db, `select count(*) from public.teams where id = any($1)`, [[teams[0].id, teams[2].id]])).toBe(2)
  })
})

describe('design, existing data and rollback', () => {
  it('SQL design: account lock -> team lock -> team row -> players rows, before any change', async () => {
    const { db } = await setup()
    const src = async (fn: string) => (await one(db, `select prosrc s from pg_proc where oid = $1::regprocedure`, [fn])).s as string
    for (const fn of ['public.remove_member(uuid,uuid)', 'public.leave_team(uuid)']) {
      const s = await src(fn)
      const a = s.indexOf("'membership:'"), b = s.indexOf("'team-members:'"), c = s.indexOf('for update'), d = s.indexOf('detach_member')
      expect(a).toBeGreaterThan(-1)
      expect(a < b && b < c && c < d).toBe(true)
    }
    const det = await src('private.detach_member(uuid,uuid)')
    expect(det.indexOf('for update')).toBeLessThan(det.indexOf('delete from'))
    const chk = await src('private.check_new_membership(uuid,uuid)')
    expect(chk.indexOf('team_member_blocks')).toBeGreaterThan(chk.indexOf("'team-members:'"))
  })

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
  async function schema(db: Db) {
    return (await db.query<{ k: string }>(`
      select 'tbl ' || n.nspname || '.' || c.relname || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(c.relacl::text, '') k
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'i')
      union all select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
        where connamespace in ('public'::regnamespace, 'private'::regnamespace)
      union all select 'fn ' || p.oid::regprocedure || ' def=' || prosecdef || ' vol=' || provolatile::text || ' acl=' || coalesce(proacl::text, '') || ' ' || md5(prosrc)
        from pg_proc p where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      order by 1`)).rows.map((x) => x.k)
  }

  it('applying to existing data changes no row', async () => {
    const { db, t, ev } = await setup({ before: true })
    const me = await regSelf(db, MEM, t.id)
    await answer(db, MEM, ev, me)
    const before = await dataHash(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(before)
  })

  it('rollback restores the previous schema exactly; removed users can join again; applying again works', async () => {
    const { db, t } = await setup({ before: true })
    const schemaBefore = await schema(db)
    await applyMigration(db, MIG)
    await remove(db, OWNER, t.id, MEM)
    const after = await dataHash(db)
    await db.exec(DOWN)
    expect(await schema(db)).toEqual(schemaBefore)
    expect(await dataHash(db)).toBe(after)
    expect(await joinOld(db, MEM, t.share_token)).toBe(t.id)               // no block list any more
    await applyMigration(db, MIG)
    expect((await remove(db, OWNER, t.id, MEM)).status).toBe('removed')
  })

  it('applying twice is harmless; a failure while applying leaves nothing behind', async () => {
    const { db } = await setup({ before: true })
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

  it('account deletion still works after removal / leaving (block rows go with the account)', async () => {
    const { db, t } = await setup()
    await remove(db, OWNER, t.id, MEM)
    await db.exec('set role service_role')
    try { expect((await db.query<any>(`select public.purge_account_data($1, $2) as r`, [MEM, MEM])).rows[0].r.status).toBe('purged') }
    finally { await db.exec('reset role') }
    await db.query('delete from auth.users where id = $1', [MEM])
    expect(await num(db, `select count(*) from private.team_member_blocks where user_id = $1`, [MEM])).toBe(0)
  })
})
