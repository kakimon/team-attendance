// Phase 5-B U3 (D3): usage limits on every write path, applied to existing data, rollback.
// Bulk rows are inserted directly (as the DB owner) to reach the boundaries quickly; every
// boundary step itself goes through the real RPCs as a signed-in user.
// PGlite has ONE connection: the lock-before-count design is checked in the SQL, but truly
// parallel behaviour is NOT proven here (later local-Supabase test).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db } from './setup'

const D5 = '20261118210000_disable_legacy_join.sql'   // old path closed from here on

const MIG = '20261117200000_usage_limits.sql'
const DOWN = readFileSync(join(import.meta.dirname, '../../supabase/rollback/20261117200000_usage_limits_down.sql'), 'utf8')
const U = (n: number) => `53700000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = U(1), B = U(2), C = U(3), D = U(4)

async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = []) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)
}
const one = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0]
const num = async (db: Db, sql: string, params: unknown[] = []) => Number(Object.values(await one(db, sql, params))[0])

/** beforeD5: the schema as it was until D5 (old share-token path still open), for the old-path checks. */
async function fresh(beforeD5 = false) {
  const db = await createDb(beforeD5 ? { before: D5 } : {})
  for (let i = 1; i <= 6; i++) await addUser(db, U(i))
  return db
}
const createTeam = (db: Db, u: string, name = 'T') =>
  q(db, u, `select id, share_token from public.create_team($1, 'n')`, [name]).then((r) => r[0] as { id: string; share_token: string })
const tokenOf = async (db: Db, team: string) => (await one(db, `select token from private.team_join_tokens where team_id = $1`, [team])).token as string
const joinRaw = (db: Db, u: string, token: string | null) => q(db, u, `select public.join_by_token($1, 'm') as r`, [token]).then((r) => r[0].r as { status: string; team_id?: string })
const joinNew = (db: Db, u: string, token: string) => joinRaw(db, u, token).then((r) => { if (r.status === 'invalid') throw new Error('join_link_invalid'); return r.team_id })
/** The OLD path itself (join_team). Only usable on a database before D5, where it really was open. */
const joinOld = (db: Db, u: string, share: string) => q(db, u, `select public.join_team($1, 'm') as id`, [share]).then((r) => r[0].id)
/** n extra accounts (no sessions needed: they are only rows) as members of a team. */
async function fillMembers(db: Db, team: string, n: number) {
  await db.query(`with u as (insert into auth.users (id) select gen_random_uuid() from generate_series(1, $2) returning id)
    insert into public.team_members (team_id, user_id, role, display_name) select $1, id, 'member', 'x' from u`, [team, n])
}
/** user `u` becomes a plain member of n new teams owned by someone else (direct rows). */
async function fillMemberships(db: Db, u: string, owner: string, n: number) {
  await db.query(`with t as (insert into public.teams (name, created_by) select 'bulk', $2 from generate_series(1, $3) returning id),
      o as (insert into public.team_members (team_id, user_id, role, display_name) select id, $2, 'owner', 'o' from t returning team_id)
    insert into public.team_members (team_id, user_id, role, display_name) select team_id, $1, 'member', 'm' from o`, [u, owner, n])
}
/** n active children in a team, each guarded by `guardian`. */
async function fillChildren(db: Db, team: string, guardian: string, n: number) {
  await db.query(`with p as (insert into public.players (team_id, name, normalized_name, created_by)
      select $1, 'c' || g, 'c' || g, $2 from generate_series(1, $3) g returning id)
    insert into public.player_guardians (player_id, team_id, user_id, added_via) select id, $1, $2, 'registrant' from p`, [team, guardian, n])
}
async function fillEvents(db: Db, team: string, n: number, hoursAgo: number, deleted = false) {
  await db.query(`insert into public.events (team_id, title, starts_at, created_by, created_at, deleted_at)
    select $1, 'e', now(), null, now() - make_interval(secs => $3), case when $4 then now() end from generate_series(1, $2)`, [team, n, hoursAgo * 3600, deleted])
}
const register = (db: Db, u: string, team: string, name: string) =>
  q(db, u, `select public.register_player($1, $2, null, true) as r`, [team, name]).then((r) => r[0].r)
const newEvent = (db: Db, u: string, team: string) => q(db, u, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [team])
const invite = (db: Db, u: string, child: string) => q(db, u, `select public.create_guardian_invitation($1) as r`, [child]).then((r) => r[0].r)
const accept = (db: Db, u: string, token: string) => q(db, u, `select public.accept_guardian_invitation($1, 'family') as r`, [token]).then((r) => r[0].r)
const attempts = (db: Db, u: string) => num(db, `select count(*) from private.rate_events where user_id = $1 and kind = 'join_attempt'`, [u])

describe('teams joined per account: 50 (owned teams count)', () => {
  it('49 -> joining the 50th works on the new and old path; the 51st is refused on every path [before D5]', async () => {
    const db = await fresh(true)
    const t1 = await createTeam(db, B, 'B1'), t2 = await createTeam(db, B, 'B2'), t3 = await createTeam(db, C, 'C1')
    await fillMemberships(db, A, D, 48)
    expect(await num(db, `select count(*) from public.team_members where user_id = $1`, [A])).toBe(48)
    await joinNew(db, A, await tokenOf(db, t1.id))                       // 49
    await joinOld(db, A, t2.share_token)                                  // 50
    await expect(joinNew(db, A, await tokenOf(db, t3.id))).rejects.toThrow(/membership_limit_exceeded/)
    await expect(joinOld(db, A, t3.share_token)).rejects.toThrow(/membership_limit_exceeded/)
    await expect(createTeam(db, A)).rejects.toThrow(/membership_limit_exceeded/)
    const [{ r: kid }] = await q(db, C, `select public.register_player($1, 'k', null, true) as r`, [t3.id])
    const inv = await invite(db, C, kid.player_id)
    await expect(accept(db, A, inv.token)).rejects.toThrow(/membership_limit_exceeded/)
    // leaving one team frees a slot
    await db.query(`delete from public.team_members where team_id = $1 and user_id = $2`, [t1.id, A])
    await joinNew(db, A, await tokenOf(db, t3.id))
  })

  it('already a member: joining again is not refused at the limit (no new membership) [before D5]', async () => {
    const db = await fresh(true)
    const t = await createTeam(db, B)
    await joinNew(db, A, await tokenOf(db, t.id))
    await fillMemberships(db, A, D, 49)
    expect(await joinNew(db, A, await tokenOf(db, t.id))).toBe(t.id)
    expect(await joinOld(db, A, t.share_token)).toBe(t.id)
  })

  it('an owner hand-over adds no membership and is not limited by it', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    await joinNew(db, A, await tokenOf(db, t.id))
    await fillMemberships(db, A, D, 49)                                   // A is in 50 teams
    await q(db, B, `select public.request_owner_transfer($1, $2)`, [t.id, A])
    const [{ r }] = await q(db, A, `select public.respond_owner_transfer($1, true) as r`, [t.id])
    expect(r.status).toBe('accepted')
  })
})

describe('members per team: 300', () => {
  it('299 -> the 300th joins; the 301st is refused (new path, old path, family invitation) [before D5]', async () => {
    const db = await fresh(true)
    const t = await createTeam(db, B)                                     // owner = 1
    await fillMembers(db, t.id, 298)                                      // 299
    await joinNew(db, A, await tokenOf(db, t.id))                         // 300
    expect(await num(db, `select count(*) from public.team_members where team_id = $1`, [t.id])).toBe(300)
    await expect(joinNew(db, C, await tokenOf(db, t.id))).rejects.toThrow(/team_member_limit_exceeded/)
    await expect(joinOld(db, C, t.share_token)).rejects.toThrow(/team_member_limit_exceeded/)
    const kid = await register(db, A, t.id, 'k')
    const inv = await invite(db, A, kid.player_id)
    await expect(accept(db, C, inv.token)).rejects.toThrow(/team_member_limit_exceeded/)
    // the invitation was not used up by the refused attempt
    expect((await one(db, `select used_at from public.guardian_invitations where id = $1`, [inv.id])).used_at).toBeNull()
    // an existing member (B) can still become a guardian through an invitation
    const inv2 = await invite(db, A, kid.player_id)
    expect((await accept(db, B, inv2.token)).status).toBe('accepted')
  })

  it('another team is not affected', async () => {
    const db = await fresh()
    const full = await createTeam(db, B, 'full'), other = await createTeam(db, C, 'other')
    await fillMembers(db, full.id, 299)
    await joinNew(db, A, await tokenOf(db, other.id))
  })
})

describe('children: 500 active per team, 20 active per guardian in a team', () => {
  it('team: 499 -> the 500th registers; the 501st is refused; a cancelled child frees a slot', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    await joinNew(db, A, await tokenOf(db, t.id))
    // 499 children spread over many guardians (direct rows), so the per-guardian limit is not hit
    await db.query(`with u as (insert into auth.users (id) select gen_random_uuid() from generate_series(1, 50) returning id),
        m as (insert into public.team_members (team_id, user_id, role, display_name) select $1, id, 'member', 'x' from u returning user_id),
        p as (insert into public.players (team_id, name, normalized_name, created_by)
              select $1, 'c' || g, 'c' || g, null from generate_series(1, 499) g returning id),
        np as (select id, row_number() over () rn from p), nm as (select user_id, row_number() over () rn from m)
      insert into public.player_guardians (player_id, team_id, user_id, added_via)
      select np.id, $1, nm.user_id, 'registrant' from np join nm on nm.rn = (np.rn % 50) + 1`, [t.id])
    expect((await register(db, A, t.id, 'ok')).status).toBe('created')   // 500
    await expect(register(db, A, t.id, 'over')).rejects.toThrow(/team_child_limit_exceeded/)
    const any = (await one(db, `select id from public.players where team_id = $1 and name = 'ok'`, [t.id])).id
    await q(db, A, `select public.archive_player($1)`, [any])
    expect((await register(db, A, t.id, 'again')).status).toBe('created')
  })

  it('guardian: 19 -> the 20th registers; the 21st is refused (also by invitation); others in the team are not affected', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    await joinNew(db, A, await tokenOf(db, t.id))
    await fillChildren(db, t.id, A, 19)
    expect((await register(db, A, t.id, '20人目')).status).toBe('created')
    await expect(register(db, A, t.id, '21人目')).rejects.toThrow(/guardian_child_limit_exceeded/)
    const kid = await register(db, B, t.id, 'B の子')                    // B is not limited by A
    const inv = await invite(db, B, kid.player_id)
    await expect(accept(db, A, inv.token)).rejects.toThrow(/guardian_child_limit_exceeded/)
    // cancelling one of A's children frees a slot
    const mine = (await one(db, `select p.id from public.players p join public.player_guardians g on g.player_id = p.id
      where g.user_id = $1 and p.team_id = $2 limit 1`, [A, t.id])).id
    await q(db, A, `select public.archive_player($1)`, [mine])
    expect((await accept(db, A, inv.token)).status).toBe('accepted')
  })

  it('the per-guardian limit is per team', async () => {
    const db = await fresh()
    const t1 = await createTeam(db, A, 'one'), t2 = await createTeam(db, A, 'two')
    await fillChildren(db, t1.id, A, 20)
    expect((await register(db, A, t2.id, 'other team')).status).toBe('created')
  })

  it('"similar name found" still returns without creating (no limit check on that answer)', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    await register(db, A, t.id, 'たろう')
    const r = (await q(db, A, `select public.register_player($1, 'たろう', null, false) as r`, [t.id]))[0].r
    expect(r.status).toBe('similar_found')
  })
})

describe('events: 2,000 active per team, 100 created per 24 hours', () => {
  it('active: 1,999 -> the 2,000th is created; the next is refused; deleted events do not count', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    await fillEvents(db, t.id, 1999, 48)
    await fillEvents(db, t.id, 50, 48, true)                              // deleted: not counted
    await newEvent(db, A, t.id)
    await expect(newEvent(db, A, t.id)).rejects.toThrow(/team_event_limit_exceeded/)
    await db.query(`update public.events set deleted_at = now() where id = (select id from public.events where team_id = $1 and deleted_at is null limit 1)`, [t.id])
    await newEvent(db, A, t.id)
  })

  it('rate: 99 in the last 24 h -> the 100th works; the 101st is refused; deleted ones still count; older ones do not', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    await fillEvents(db, t.id, 60, 23.9)
    await fillEvents(db, t.id, 39, 1, true)                               // deleted within the window: counted
    await fillEvents(db, t.id, 300, 24.01)                                // older: not counted
    await newEvent(db, A, t.id)
    const err = await newEvent(db, A, t.id).catch((e) => e as { message: string; detail?: string; code?: string })
    expect(err.message).toBe('event_create_rate_limited')
    expect(err.code).toBe('23514')
    expect(Date.parse(err.detail!)).toBeGreaterThan(Date.now())
  })

  it('the event limits are per team; members still cannot create events', async () => {
    const db = await fresh()
    const t = await createTeam(db, A, 'full'), other = await createTeam(db, A, 'other')
    await fillEvents(db, t.id, 100, 1)
    await newEvent(db, A, other.id)
    await joinNew(db, B, await tokenOf(db, other.id))
    await expect(newEvent(db, B, other.id)).rejects.toThrow(/forbidden/)
  })
})

describe('family invitations: 20 created per 24 h per account, 5 active per child', () => {
  it('19 in the window -> the 20th is created; the 21st is refused; another guardian is not affected', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    const kids = []
    for (let i = 0; i < 5; i++) kids.push((await register(db, A, t.id, `k${i}`)).player_id)
    // 19 past invitations (expired: they do not occupy the per-child limit)
    await db.query(`insert into public.guardian_invitations (team_id, player_id, token_hash, created_by, created_at, expires_at)
      select $1, $2, md5(random()::text) || g, $3, now() - interval '2 hours', now() - interval '1 hour' from generate_series(1, 19) g`, [t.id, kids[0], A])
    await invite(db, A, kids[1])                                          // 20th
    const err = await invite(db, A, kids[2]).catch((e) => e as { message: string; detail?: string })
    expect(err.message).toBe('invite_create_rate_limited')
    expect(Date.parse(err.detail!)).toBeGreaterThan(Date.now())
    await joinNew(db, B, await tokenOf(db, t.id))
    const bk = (await register(db, B, t.id, 'b')).player_id
    await invite(db, B, bk)
  })

  it('per child: 5 active invitations, the 6th is refused with the existing error; used ones free a slot', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    const kid = (await register(db, A, t.id, 'k')).player_id
    const invs = []
    for (let i = 0; i < 5; i++) invs.push(await invite(db, A, kid))
    await expect(invite(db, A, kid)).rejects.toThrow(/too_many_active_invitations/)
    expect((await accept(db, B, invs[0].token)).status).toBe('accepted')
    await invite(db, A, kid)
  })

  it('existing family flow is unchanged: accept, already_guardian, cancelled child', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    const kid = (await register(db, A, t.id, 'k')).player_id
    const inv = await invite(db, A, kid)
    expect((await accept(db, B, inv.token)).status).toBe('accepted')
    const inv2 = await invite(db, B, kid)                                 // invited family member invites again
    expect((await accept(db, B, inv2.token)).status).toBe('already_guardian')
    expect((await one(db, `select used_at from public.guardian_invitations where id = $1`, [inv2.id])).used_at).toBeNull()
    expect(await num(db, `select count(*) from public.player_guardians where player_id = $1`, [kid])).toBe(2)
  })
})

describe('join attempts: 30 per hour per account', () => {
  it('lookups by a non-member are counted (also with wrong tokens); the 31st is refused, also for a valid token [before D5]', async () => {
    const db = await fresh(true)
    const t = await createTeam(db, B)
    for (let i = 0; i < 30; i++) await q(db, A, `select * from public.preview_join($1)`, [`${'a'.repeat(63)}${i % 10}`])
    expect(await attempts(db, A)).toBe(30)
    await expect(q(db, A, `select * from public.preview_join($1)`, [await tokenOf(db, t.id)])).rejects.toThrow(/join_attempt_rate_limited/)
    await expect(joinNew(db, A, await tokenOf(db, t.id))).rejects.toThrow(/join_attempt_rate_limited/)
    await expect(joinOld(db, A, t.share_token)).rejects.toThrow(/join_attempt_rate_limited/)
    await expect(q(db, A, `select * from public.get_team_by_share_token($1)`, [t.share_token])).rejects.toThrow(/join_attempt_rate_limited/)
    // another account is not affected
    expect(await joinNew(db, C, await tokenOf(db, t.id))).toBe(t.id)
  })

  it('the old preview counts non-member lookups; members opening their own team are never counted [before D5]', async () => {
    const db = await fresh(true)
    const t = await createTeam(db, B)
    await q(db, A, `select * from public.get_team_by_share_token($1)`, ['nope'])
    await q(db, A, `select * from public.get_team_by_share_token($1)`, [t.share_token])
    expect(await attempts(db, A)).toBe(2)
    for (let i = 0; i < 40; i++) await q(db, B, `select * from public.get_team_by_share_token($1)`, [t.share_token])
    for (let i = 0; i < 40; i++) await q(db, B, `select * from public.preview_join($1)`, [await tokenOf(db, t.id)])
    expect(await attempts(db, B)).toBe(0)
  })

  it('a normal join (preview, then join) is counted once; the lock-out ends after an hour (no long lock-out)', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    const tok = await tokenOf(db, t.id)
    expect((await q(db, A, `select * from public.preview_join($1)`, [tok]))[0].name).toBe('T')
    await joinNew(db, A, tok)
    expect(await attempts(db, A)).toBe(1)                                    // the lookup only, not the join again
    await db.query(`insert into private.rate_events (user_id, kind, created_at) select $1, 'join_attempt', now() - interval '59 minutes' from generate_series(1, 29)`, [A])
    const other = await createTeam(db, C)
    await expect(joinNew(db, A, await tokenOf(db, other.id))).rejects.toThrow(/join_attempt_rate_limited/)
    await db.query(`update private.rate_events set created_at = now() - interval '61 minutes' where user_id = $1 and kind = 'join_attempt'`, [A])
    expect(await joinNew(db, A, await tokenOf(db, other.id))).toBe(other.id)
  })

  it('after D5: the old path is refused for members and non-members, and a refused call is not counted', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    for (const u of [A, B]) {                                                 // A: not a member, B: the owner
      await expect(joinOld(db, u, t.share_token)).rejects.toThrow(/permission denied for function join_team/)
      await expect(q(db, u, `select * from public.get_team_by_share_token($1)`, [t.share_token])).rejects.toThrow(/permission denied for function get_team_by_share_token/)
    }
    expect(await attempts(db, A)).toBe(0)
    expect(await num(db, 'select count(*) from public.team_members where team_id = $1', [t.id])).toBe(1)
  })

  it('KNOWN LIMITATION (old path only, until D5): join_team with a wrong token raises and is not counted [before D5]', async () => {
    const db = await fresh(true)
    for (let i = 0; i < 5; i++) await expect(joinOld(db, A, 'nope')).rejects.toThrow(/team_not_found/)
    expect(await attempts(db, A)).toBe(0)
  })


  it('records keep only user id, kind and time, and go with the account', async () => {
    const db = await fresh()
    await q(db, A, `select * from public.preview_join($1)`, ['c'.repeat(64)])
    const cols = (await db.query<{ c: string }>(`select column_name c from information_schema.columns
      where table_schema = 'private' and table_name = 'rate_events' order by 1`)).rows.map((r) => r.c)
    expect(cols).toEqual(['created_at', 'kind', 'user_id'])
    await db.exec('set role service_role')
    try { await db.query(`select public.purge_account_data($1, $2)`, [A, A]) } finally { await db.exec('reset role') }
    await db.query('delete from auth.users where id = $1', [A])
    expect(await attempts(db, A)).toBe(0)
  })
})

describe('join_by_token: wrong tokens are returned as "invalid" and recorded', () => {
  it('a direct join with a wrong token returns { status: invalid } and is recorded', async () => {
    const db = await fresh()
    expect(await joinRaw(db, A, 'e'.repeat(64))).toEqual({ status: 'invalid' })
    expect(await joinRaw(db, A, 'short')).toEqual({ status: 'invalid' })
    expect(await joinRaw(db, A, null)).toEqual({ status: 'invalid' })
    expect(await attempts(db, A)).toBe(3)
  })

  it('30 wrong direct tries -> the 31st call is refused (even with a valid token); another account is not affected', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    for (let i = 0; i < 30; i++) expect((await joinRaw(db, A, `${'f'.repeat(62)}${String(i).padStart(2, '0')}`)).status).toBe('invalid')
    expect(await attempts(db, A)).toBe(30)
    await expect(joinRaw(db, A, await tokenOf(db, t.id))).rejects.toThrow(/join_attempt_rate_limited/)
    expect(await attempts(db, A)).toBe(30)                                   // the refused call adds nothing
    expect((await joinRaw(db, C, await tokenOf(db, t.id))).status).toBe('joined')
  })

  it('after the hour has passed the account can try again and join', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    for (let i = 0; i < 30; i++) await joinRaw(db, A, 'g'.repeat(64))
    await expect(joinRaw(db, A, await tokenOf(db, t.id))).rejects.toThrow(/join_attempt_rate_limited/)
    await db.query(`update private.rate_events set created_at = now() - interval '61 minutes' where user_id = $1 and kind = 'join_attempt'`, [A])
    expect(await joinRaw(db, A, await tokenOf(db, t.id))).toEqual({ status: 'joined', team_id: t.id })
  })

  it('valid token: joined; again: already_member (not counted, role unchanged)', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    const tok = await tokenOf(db, t.id)
    expect(await joinRaw(db, A, tok)).toEqual({ status: 'joined', team_id: t.id })
    expect(await joinRaw(db, A, tok)).toEqual({ status: 'already_member', team_id: t.id })
    expect(await joinRaw(db, B, tok)).toEqual({ status: 'already_member', team_id: t.id })
    expect((await one(db, `select role from public.team_members where team_id = $1 and user_id = $2`, [t.id, B])).role).toBe('owner')
    expect(await attempts(db, A)).toBe(0)
    expect(await attempts(db, B)).toBe(0)
  })

  it('stopped / replaced tokens: the same "invalid" answer, recorded, nobody joins', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    const before = await tokenOf(db, t.id)
    await q(db, B, `select public.rotate_join_token($1)`, [t.id])
    expect(await joinRaw(db, A, before)).toEqual({ status: 'invalid' })
    const current = await tokenOf(db, t.id)
    await q(db, B, `select public.set_join_open($1, false)`, [t.id])
    expect(await joinRaw(db, A, current)).toEqual({ status: 'invalid' })
    expect(await attempts(db, A)).toBe(2)
    expect(await num(db, `select count(*) from public.team_members where team_id = $1 and user_id = $2`, [t.id, A])).toBe(0)
  })

  it('no information leaks: every invalid kind gives exactly the same answer; no team id, name or state', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    const other = await createTeam(db, C)
    const rotated = await tokenOf(db, other.id)
    await q(db, C, `select public.rotate_join_token($1)`, [other.id])
    const answers = [await joinRaw(db, A, 'h'.repeat(64)), await joinRaw(db, A, t.share_token), await joinRaw(db, A, t.id),
      await joinRaw(db, A, rotated)]
    for (const a of answers) expect(a).toEqual({ status: 'invalid' })
    // a member of team A cannot learn team B's token, and others cannot read any token
    await joinRaw(db, D, await tokenOf(db, t.id))
    await expect(q(db, D, `select public.get_join_link($1)`, [t.id])).rejects.toThrow(/forbidden/)
    await expect(q(db, D, `select public.get_join_link($1)`, [other.id])).rejects.toThrow(/forbidden/)
    await expect(q(db, D, `select * from private.team_join_tokens`)).rejects.toThrow(/permission denied/)
  })

  it('limits and unexpected errors are raised, never turned into "invalid"', async () => {
    const db = await fresh()
    const t = await createTeam(db, B)
    await fillMembers(db, t.id, 299)
    await expect(joinRaw(db, A, await tokenOf(db, t.id))).rejects.toThrow(/team_member_limit_exceeded/)
    expect(await attempts(db, A)).toBe(0)
    // an unexpected error (here: a broken name) surfaces as an error, not as "invalid"
    const t2 = await createTeam(db, C)
    await expect(q(db, A, `select public.join_by_token($1, $2)`, [await tokenOf(db, t2.id), 'x'.repeat(41)])).rejects.toThrow(/check constraint|team_members_display_name_check/)
  })

  it('logged-out and expired sessions are still refused', async () => {
    const db = await fresh()
    await expect(q(db, null, `select public.join_by_token($1, 'x')`, ['i'.repeat(64)])).rejects.toThrow(/permission denied/)
    await db.query('delete from auth.sessions where user_id = $1', [A])
    await expect(joinRaw(db, A, 'i'.repeat(64))).rejects.toThrow(/session_expired/)
  })
})

describe('authentication and design', () => {
  it('logged-out callers are refused on every changed RPC; helpers are internal', async () => {
    const db = await fresh()
    const t = await createTeam(db, A)
    for (const sql of [`select public.join_team('${t.share_token}', 'x')`, `select * from public.get_team_by_share_token('${t.share_token}')`,
      `select * from public.preview_join('${'a'.repeat(64)}')`, `select public.join_by_token('${'a'.repeat(64)}', 'x')`,
      `select public.create_team('x', 'y')`, `select public.register_player('${t.id}', 'x')`,
      `select public.create_event('${t.id}', 'x', now())`, `select public.accept_guardian_invitation('x', 'y')`]) {
      await expect(q(db, null, sql)).rejects.toThrow(/permission denied/)
    }
    for (const fn of [`private.usage_limit('team_members')`, `private.xlock('k')`, `private.check_join_attempts('${A}')`,
      `private.record_join_attempt('${A}')`, `private.check_new_membership('${A}', '${t.id}')`, `private.check_guardian_children('${A}', '${t.id}')`]) {
      await expect(q(db, A, `select ${fn}`)).rejects.toThrow(/permission denied/)
    }
  })

  it('SQL design: every limited path takes its locks before counting (account lock before team lock)', async () => {
    const db = await fresh()
    const old = await fresh(true)                                             // join_team: as it was until D5
    const src = async (fn: string) => (await one(fn === 'public.join_team(text,text)' ? old : db, `select prosrc s from pg_proc where oid = $1::regprocedure`, [fn])).s as string
    const mem = await src('private.check_new_membership(uuid,uuid)')
    expect(mem.indexOf("'membership:'")).toBeLessThan(mem.indexOf("'team-members:'"))
    expect(mem.indexOf("'team-members:'")).toBeLessThan(mem.indexOf('count(*)'))
    for (const fn of ['public.join_team(text,text)', 'public.join_by_token(text,text)']) {
      const s = await src(fn)
      expect(s.indexOf('check_new_membership')).toBeGreaterThan(-1)
      expect(s.indexOf('check_new_membership')).toBeLessThan(s.indexOf('insert into public.team_members'))
    }
    const reg = await src('public.register_player(uuid,text,text,boolean)')
    expect(reg.indexOf('check_guardian_children')).toBeLessThan(reg.indexOf("'team-children:'"))
    expect(reg.indexOf("'team-children:'")).toBeLessThan(reg.indexOf('insert into public.players'))
    const ev = await src('public.create_event(uuid,text,timestamp with time zone,text,text)')
    expect(ev.indexOf("'team-events:'")).toBeLessThan(ev.indexOf('count(*)'))
    const inv = await src('public.create_guardian_invitation(uuid)')
    expect(inv.indexOf("'invites:'")).toBeLessThan(inv.indexOf("'child-invites:'"))
    expect(inv.indexOf("'child-invites:'")).toBeLessThan(inv.indexOf('count(*)'))
    const ct = await src('public.create_team(text,text)')
    expect(ct.indexOf('lock_owner_quota')).toBeLessThan(ct.indexOf("'membership:'"))
  })
})

describe('applying to existing data, U1/U2 compatibility and rollback', () => {
  async function seededBefore() {
    const db = await createDb({ before: MIG })
    for (let i = 1; i <= 6; i++) await addUser(db, U(i))
    const t = await createTeam(db, A, '既存')
    await fillMembers(db, t.id, 305)                                      // already over 300
    await joinOld(db, B, t.share_token)
    const kid = (await q(db, B, `select public.register_player($1, 'k', '4年', true) as r`, [t.id]))[0].r.player_id
    const [{ id: ev }] = await q(db, A, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
    await q(db, B, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])
    await q(db, B, `select public.create_guardian_invitation($1)`, [kid])
    return { db, t }
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

  it('changes no app data; a team already over a limit keeps everyone, but nobody new can join', async () => {
    const { db, t } = await seededBefore()
    const before = await dataHash(db)
    await applyMigration(db, MIG)
    expect(await dataHash(db)).toBe(before)
    expect(await num(db, `select count(*) from public.team_members where team_id = $1`, [t.id])).toBe(307)
    await expect(joinOld(db, C, t.share_token)).rejects.toThrow(/team_member_limit_exceeded/)
    await expect(joinNew(db, C, await tokenOf(db, t.id))).rejects.toThrow(/team_member_limit_exceeded/)
    expect(await joinOld(db, B, t.share_token)).toBe(t.id)               // existing members unaffected
  })

  it('U1 (owner quota, creation rate) and U2 (rotation, stop) keep working', async () => {
    const db = await fresh()
    for (let i = 0; i < 3; i++) await createTeam(db, D, `D${i}`)
    await expect(createTeam(db, D)).rejects.toThrow(/owner_quota_exceeded/)
    const t = await createTeam(db, A)
    const old = await tokenOf(db, t.id)
    await q(db, A, `select public.rotate_join_token($1)`, [t.id])
    await expect(joinNew(db, B, old)).rejects.toThrow(/join_link_invalid/)
    await q(db, A, `select public.set_join_open($1, false)`, [t.id])
    expect(await q(db, B, `select * from public.preview_join($1)`, [old])).toEqual([])
  })

  it('rollback restores the previous schema exactly and keeps the data; applying again works', async () => {
    const { db, t } = await seededBefore()
    const schemaBefore = await schema(db)
    await applyMigration(db, MIG)
    await q(db, C, `select * from public.preview_join($1)`, ['d'.repeat(64)])   // a join-attempt record exists
    const dataAfter = await dataHash(db)
    await db.exec(DOWN)
    expect(await schema(db)).toEqual(schemaBefore)
    expect(await dataHash(db)).toBe(dataAfter)
    expect(await joinOld(db, C, t.share_token)).toBe(t.id)               // no limits after rollback
    await applyMigration(db, MIG)
    await expect(joinOld(db, D, t.share_token)).rejects.toThrow(/team_member_limit_exceeded/)
  })

  it('applying twice is harmless; a failure while applying leaves nothing behind', async () => {
    const { db } = await seededBefore()
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
