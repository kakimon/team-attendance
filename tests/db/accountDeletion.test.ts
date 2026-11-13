// Self-service account deletion + owner hand-over with approval (migration 20261113000000).
// The Edge Function steps are emulated: purge_account_data as service_role, then the Auth
// user row is deleted (what auth.admin.deleteUser does in the database).
import { describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, type Db } from './setup'

const U = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const O = U(1), P1 = U(2), P2 = U(3), P3 = U(4), S = U(5), X = U(6)

/** Query as a browser user. `session` = the token's session_id (default: the user's first login). */
async function q<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = [], session: string | null = uid) {
  return asUser(db, uid, async () => (await db.query<T>(sql, params)).rows, session)
}
async function svc<T = any>(db: Db, sql: string, params: unknown[] = []) {
  await db.exec('set role service_role')
  try { return (await db.query<T>(sql, params)).rows } finally { await db.exec('reset role') }
}
const purge = (db: Db, user: string, session: string | null = user) =>
  svc(db, 'select public.purge_account_data($1, $2) as r', [user, session]).then((r) => r[0].r)
const deleteAuthUser = (db: Db, user: string) => db.query('delete from auth.users where id = $1', [user])
/** A new Google login = a new auth.sessions row. */
const login = async (db: Db, user: string) =>
  (await db.query<{ id: string }>('insert into auth.sessions (id, user_id) values (gen_random_uuid(), $1) returning id', [user])).rows[0]!.id
const loginAgo = (db: Db, session: string, ago: string) =>
  db.query(`update auth.sessions set created_at = now() - $2::interval where id = $1`, [session, ago])
const preview = async (db: Db, u: string, session: string = u) =>
  (await q(db, u, 'select public.account_deletion_preview() as r', [], session))[0].r
const role = async (db: Db, team: string, u: string) =>
  (await db.query<{ role: string }>('select role from public.team_members where team_id = $1 and user_id = $2', [team, u])).rows[0]?.role
const owners = async (db: Db, team: string) =>
  (await db.query<{ user_id: string }>(`select user_id from public.team_members where team_id = $1 and role = 'owner'`, [team])).rows.map((r) => r.user_id)

/** Rows that do NOT belong to the given children/teams, as a stable fingerprint. */
async function othersHash(db: Db, excludePlayers: string[], excludeTeams: string[] = []) {
  const r = await db.query<{ h: string }>(`select md5(
    coalesce((select string_agg(p.id::text || p.name || coalesce(p.note,''), '|' order by p.id) from public.players p where not (p.id = any($1)) and not (p.team_id = any($2))), '') ||
    coalesce((select string_agg(a.event_id::text || a.player_id::text || a.status || coalesce(a.comment,''), '|' order by a.event_id, a.player_id) from public.attendance a where not (a.player_id = any($1)) and not (a.team_id = any($2))), '') ||
    coalesce((select string_agg(e.id::text || e.title, '|' order by e.id) from public.events e where not (e.team_id = any($2))), '')
  ) as h`, [excludePlayers, excludeTeams])
  return r.rows[0]!.h
}

/**
 * チームA: O (owner), P1, P2, P3 (members)
 *   K1 shared by P1 + P2 (invited), K2 only P2, K3 only P3; P1 has one unused invitation
 * ひとりチーム: S alone, with S's child
 */
async function scenario() {
  const db = await createDb()
  for (const u of [O, P1, P2, P3, S, X]) await addUser(db, u)
  const [t1] = await q(db, O, `select id, share_token from public.create_team('チームA', '代表')`)
  const [{ id: e1 }] = await q(db, O, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t1.id])
  for (const [u, n] of [[P1, 'P1'], [P2, 'P2'], [P3, 'P3']]) await q(db, u, `select public.join_team($1, $2)`, [t1.share_token, n])
  const reg = async (u: string, team: string, name: string) =>
    (await q(db, u, `select public.register_player($1, $2, null, true) as r`, [team, name]))[0].r.player_id as string
  const k1 = await reg(P1, t1.id, '共有 たろう')
  const k2 = await reg(P2, t1.id, 'ひとり じろう')
  const k3 = await reg(P3, t1.id, 'ひとり さぶろう')
  const [{ r: used }] = await q(db, P1, `select public.create_guardian_invitation($1) as r`, [k1])
  await q(db, P2, `select public.accept_guardian_invitation($1, 'x')`, [used.token])
  const [{ r: pending }] = await q(db, P1, `select public.create_guardian_invitation($1) as r`, [k1])
  await q(db, P1, `select public.set_attendance($1, $2, 'attend', 'P1が入力')`, [e1, k1])
  await q(db, P2, `select public.set_attendance($1, $2, 'absent')`, [e1, k2])
  await q(db, P3, `select public.set_attendance($1, $2, 'undecided')`, [e1, k3])
  await q(db, O, `select public.update_event($1, '練習（変更）', now() + interval '2 day')`, [e1])
  const [t2] = await q(db, S, `select id, share_token from public.create_team('ひとりチーム', 'S')`)
  const [{ id: e2 }] = await q(db, S, `select public.create_event($1, 'S練習', now() + interval '1 day') as id`, [t2.id])
  const ks = await reg(S, t2.id, 'S の子')
  await q(db, S, `select public.set_attendance($1, $2, 'attend')`, [e2, ks])
  return { db, t1, t2, e1, e2, k1, k2, k3, ks, pendingToken: pending.token as string }
}

describe('1. per-FK handling (not a blanket SET NULL)', () => {
  it('matches the design table', async () => {
    const db = await createDb()
    const rows = (await db.query<{ k: string }>(`
      select c.conrelid::regclass::text || '.' || a.attname || ':' || c.confdeltype::text || ':' || case when a.attnotnull then 'notnull' else 'null' end as k
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.connamespace in ('public'::regnamespace, 'private'::regnamespace)
      order by 1`)).rows.map((r) => r.k)
    expect(rows).toEqual([
      'attendance.updated_by:n:null',              // SET NULL
      'events.created_by:n:null',
      'events.deleted_by:n:null',
      'events.updated_by:n:null',
      'guardian_invitations.created_by:c:notnull', // CASCADE
      'guardian_invitations.used_by:n:null',
      'player_guardians.user_id:c:notnull',        // CASCADE (unchanged, guarded)
      'players.archived_by:n:null',
      'players.created_by:a:null',                 // NO ACTION kept (purge clears it)
      'players.updated_by:n:null',
      'private.account_deletions.user_id:c:notnull', // deletion state goes with the Auth user
      'team_members.user_id:c:notnull',            // CASCADE (unchanged, guarded)
      'team_owner_transfers.from_user:c:notnull',
      'team_owner_transfers.to_user:c:notnull',
      'teams.created_by:a:null',                   // NO ACTION kept (purge clears it)
    ])
  })
})

describe('2. impact preview (own data only, simple)', () => {
  it('shows what will happen for each kind of user', async () => {
    const s = await scenario()
    const p1 = await preview(s.db, P1)
    expect(p1.children_to_delete).toEqual([])
    expect(p1.children_kept_by_family.map((c: any) => c.name)).toEqual(['共有 たろう'])
    expect(p1.teams_to_leave).toEqual([{ team_id: s.t1.id, team_name: 'チームA', role: 'member' }])
    expect(p1.deletion_pending).toBe(false)
    expect(p1.reauth_seconds_left).toBeGreaterThan(500)
    const p3 = await preview(s.db, P3)
    expect(p3.children_to_delete).toEqual([{ player_id: s.k3, name: 'ひとり さぶろう', team_name: 'チームA', answers: 1 }])
    const o = await preview(s.db, O)
    expect(o.teams_to_hand_over[0].candidates.map((c: any) => c.display_name)).toEqual(['P1', 'P2', 'P3'])
    expect(o.teams_to_hand_over[0].pending).toBeNull()
    expect((await preview(s.db, S)).teams_to_close.map((t: any) => t.team_name)).toEqual(['ひとりチーム'])
  })

  it('tells the screen when the last login is too old', async () => {
    const s = await scenario()
    await loginAgo(s.db, P3, '11 minutes')
    expect((await preview(s.db, P3)).reauth_seconds_left).toBe(0)
    const fresh = await login(s.db, P3)
    expect((await preview(s.db, P3, fresh)).reauth_seconds_left).toBeGreaterThan(500)
  })
})

describe('3. other families keep their data', () => {
  it('shared child: only the leaving guardian is removed; child, answers and the other guardian stay', async () => {
    const s = await scenario()
    const before = await othersHash(s.db, [])
    expect((await purge(s.db, P1)).status).toBe('purged')
    await deleteAuthUser(s.db, P1)
    expect(await othersHash(s.db, [])).toBe(before)
    const g = await s.db.query<any>('select user_id from public.player_guardians where player_id = $1', [s.k1])
    expect(g.rows.map((r) => r.user_id)).toEqual([P2])
    const a = await s.db.query<any>('select status, updated_by from public.attendance where player_id = $1', [s.k1])
    expect(a.rows).toEqual([{ status: 'attend', updated_by: null }]) // answer kept, recorder cleared
    await q(s.db, P2, `select public.set_attendance($1, $2, 'undecided')`, [s.e1, s.k1]) // P2 still manages K1
    await expect(q(s.db, X, `select public.accept_guardian_invitation($1, 'x')`, [s.pendingToken])).rejects.toThrow(/invitation_invalid/)
  })

  it('sole child: the child and its answers are deleted, nobody else is touched', async () => {
    const s = await scenario()
    const before = await othersHash(s.db, [s.k3])
    expect(await purge(s.db, P3)).toMatchObject({ status: 'purged', children_deleted: 1, teams_closed: 0 })
    await deleteAuthUser(s.db, P3)
    expect(await othersHash(s.db, [s.k3])).toBe(before)
    expect((await s.db.query('select 1 from public.players where id = $1', [s.k3])).rows).toEqual([])
    expect((await s.db.query('select 1 from public.attendance where player_id = $1', [s.k3])).rows).toEqual([])
  })

  it('recorder columns are anonymised by the purge itself (before the Auth deletion)', async () => {
    const s = await scenario()
    // P2 accepted P1's invitation: used_by = P2; O created and updated the event
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [s.t1.id, P1])
    await q(s.db, P1, 'select public.respond_owner_transfer($1, true)', [s.t1.id])
    await purge(s.db, O)
    await purge(s.db, P2)
    const refs = (await s.db.query<{ n: number }>(`select (
        (select count(*) from public.teams where created_by in ($1, $2)) + (select count(*) from public.players where $1 in (created_by, updated_by, archived_by) or $2 in (created_by, updated_by, archived_by))
      + (select count(*) from public.events where $1 in (created_by, updated_by, deleted_by) or $2 in (created_by, updated_by, deleted_by))
      + (select count(*) from public.attendance where updated_by in ($1, $2)) + (select count(*) from public.guardian_invitations where $1 in (created_by, used_by) or $2 in (created_by, used_by))
      + (select count(*) from public.team_members where user_id in ($1, $2)) + (select count(*) from public.player_guardians where user_id in ($1, $2)))::int as n`, [O, P2])).rows[0]!.n
    expect(refs).toBe(0)
    expect((await s.db.query('select title from public.events where id = $1', [s.e1])).rows).toEqual([{ title: '練習（変更）' }])
  })
})

describe('4. owner hand-over needs the new owner\'s approval', () => {
  it('request -> accept: roles swap, the old owner becomes a member, then the old owner can leave', async () => {
    const s = await scenario()
    await expect(purge(s.db, O)).rejects.toThrow(/owner_must_transfer/)
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [s.t1.id, P2])
    expect(await owners(s.db, s.t1.id)).toEqual([O])                         // nothing moves before approval
    await expect(purge(s.db, O)).rejects.toThrow(/owner_must_transfer/)      // still refused while waiting
    expect((await preview(s.db, O)).teams_to_hand_over[0].pending).toMatchObject({ to_user: P2, to_name: 'P2' })
    const mine = (await q(s.db, P2, 'select public.my_owner_transfers() as r'))[0].r
    expect(mine.incoming).toMatchObject([{ team_id: s.t1.id, team_name: 'チームA', from_name: '代表' }])
    expect((await q(s.db, P2, 'select public.respond_owner_transfer($1, true) as r', [s.t1.id]))[0].r).toEqual({ status: 'accepted' })
    expect(await owners(s.db, s.t1.id)).toEqual([P2])
    expect(await role(s.db, s.t1.id, O)).toBe('member')
    expect((await purge(s.db, O)).status).toBe('purged')
    await deleteAuthUser(s.db, O)
    expect(await owners(s.db, s.t1.id)).toEqual([P2])
  })

  it('decline, cancel, expiry and a changed request leave the owner unchanged', async () => {
    const s = await scenario()
    const t = s.t1.id
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, P1])
    expect((await q(s.db, P1, 'select public.respond_owner_transfer($1, false) as r', [t]))[0].r).toEqual({ status: 'declined' })
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, P1])
    await q(s.db, O, 'select public.cancel_owner_transfer($1)', [t])
    await expect(q(s.db, P1, 'select public.respond_owner_transfer($1, true)', [t])).rejects.toThrow(/transfer_not_found/)
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, P1])
    await s.db.query(`update public.team_owner_transfers set expires_at = now() - interval '1 second' where team_id = $1`, [t])
    expect((await q(s.db, P1, 'select public.respond_owner_transfer($1, true) as r', [t]))[0].r).toEqual({ status: 'expired' })
    // the owner switches the request to P3: P1 can no longer accept
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, P1])
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, P3])
    await expect(q(s.db, P1, 'select public.respond_owner_transfer($1, true)', [t])).rejects.toThrow(/transfer_not_found/)
    expect(await owners(s.db, t)).toEqual([O])
  })

  it('only the owner can request, only the chosen member can answer, only members can be chosen', async () => {
    const s = await scenario()
    const t = s.t1.id
    await expect(q(s.db, P1, 'select public.request_owner_transfer($1, $2)', [t, P1])).rejects.toThrow(/forbidden/)
    await expect(q(s.db, P1, 'select public.request_owner_transfer($1, $2)', [t, P2])).rejects.toThrow(/forbidden/)
    await expect(q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, X])).rejects.toThrow(/invalid_new_owner/)
    await expect(q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, O])).rejects.toThrow(/invalid_new_owner/)
    await expect(q(s.db, S, 'select public.request_owner_transfer($1, $2)', [t, S])).rejects.toThrow(/forbidden/)
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [t, P2])
    await expect(q(s.db, P3, 'select public.respond_owner_transfer($1, true)', [t])).rejects.toThrow(/transfer_not_found/)
    await expect(q(s.db, O, 'select public.respond_owner_transfer($1, true)', [t])).rejects.toThrow(/transfer_not_found/)
    await expect(q(s.db, P2, 'select public.cancel_owner_transfer($1)', [t])).rejects.toThrow(/transfer_not_found/)
    // requests are visible only to the two people involved
    expect(await q(s.db, P3, 'select team_id from public.team_owner_transfers')).toEqual([])
    expect(await q(s.db, P2, 'select team_id from public.team_owner_transfers')).toHaveLength(1)
    await expect(q(s.db, P2, `update public.team_owner_transfers set to_user = $1`, [P3])).rejects.toThrow(/permission denied/)
    await expect(q(s.db, P3, `insert into public.team_owner_transfers (team_id, from_user, to_user) values ($1, $2, $3)`, [t, O, P3])).rejects.toThrow(/permission denied/)
  })

  it('a stale request (recipient left / owner changed) does not create a second owner', async () => {
    const s = await scenario()
    await q(s.db, O, 'select public.request_owner_transfer($1, $2)', [s.t1.id, P2])
    // the owner changed meanwhile (direct swap to P1 in one transaction)
    await s.db.exec('begin')
    await s.db.query(`update public.team_members set role = 'member' where team_id = $1 and user_id = $2`, [s.t1.id, O])
    await s.db.query(`update public.team_members set role = 'owner' where team_id = $1 and user_id = $2`, [s.t1.id, P1])
    await s.db.exec('commit')
    expect((await q(s.db, P2, 'select public.respond_owner_transfer($1, true) as r', [s.t1.id]))[0].r).toEqual({ status: 'stale' })
    expect(await owners(s.db, s.t1.id)).toEqual([P1])
  })

  it('the last member of a team: the team is closed with the account; nothing else changes', async () => {
    const s = await scenario()
    const before = await othersHash(s.db, [], [s.t2.id])
    expect(await purge(s.db, S)).toMatchObject({ teams_closed: 1, children_deleted: 0 })
    await deleteAuthUser(s.db, S)
    expect((await s.db.query('select 1 from public.teams where id = $1', [s.t2.id])).rows).toEqual([])
    expect(await othersHash(s.db, [], [s.t2.id])).toBe(before)
  })
})

describe('5. identity, re-authentication and old tokens', () => {
  it('first run needs a live, recent login of the same user; a new login fixes it', async () => {
    const s = await scenario()
    await expect(purge(s.db, P3, null)).rejects.toThrow(/reauth_required/)
    await expect(purge(s.db, P3, P2)).rejects.toThrow(/reauth_required/)          // someone else's session
    await loginAgo(s.db, P3, '1 hour')
    await expect(purge(s.db, P3)).rejects.toThrow(/reauth_required/)              // logged in too long ago
    await s.db.query('delete from auth.sessions where id = $1', [P3])
    await expect(purge(s.db, P3)).rejects.toThrow(/reauth_required/)              // logged out / revoked
    const fresh = await login(s.db, P3)                                          // Google login again
    expect(fresh).not.toBe(P3)
    expect((await purge(s.db, P3, fresh)).status).toBe('purged')
  })

  it('browsers cannot run the purge or note failures; nobody can act for another user', async () => {
    const s = await scenario()
    await expect(q(s.db, P3, 'select public.purge_account_data($1, $2)', [P3, P3])).rejects.toThrow(/permission denied/)
    await expect(q(s.db, P3, 'select public.purge_account_data($1, $2)', [P2, P2])).rejects.toThrow(/permission denied/)
    await expect(q(s.db, P3, 'select public.note_account_deletion_failure($1, $2)', [P3, 'x'])).rejects.toThrow(/permission denied/)
    await expect(q(s.db, null, 'select public.account_deletion_preview()')).rejects.toThrow(/permission denied/)
    await expect(q(s.db, null, 'select public.my_owner_transfers()')).rejects.toThrow(/permission denied/)
    await expect(q(s.db, P3, 'select * from private.account_deletions')).rejects.toThrow(/permission denied/)
    const params = (await s.db.query<any>(`select p.proname, pg_get_function_identity_arguments(p.oid) a,
        has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anon', p.oid, 'execute') anon
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
      ('account_deletion_preview','request_owner_transfer','cancel_owner_transfer','respond_owner_transfer','my_owner_transfers',
       'purge_account_data','note_account_deletion_failure') order by 1`)).rows
    expect(params).toEqual([ // browser functions have no "which user is me" parameter; service ones are not callable
      { proname: 'account_deletion_preview', a: '', auth: true, anon: false },
      { proname: 'cancel_owner_transfer', a: 'p_team_id uuid', auth: true, anon: false },
      { proname: 'my_owner_transfers', a: '', auth: true, anon: false },
      { proname: 'note_account_deletion_failure', a: 'p_user uuid, p_error text', auth: false, anon: false },
      { proname: 'purge_account_data', a: 'p_user uuid, p_session uuid, p_max_login_age interval', auth: false, anon: false },
      { proname: 'request_owner_transfer', a: 'p_team_id uuid, p_to_user uuid', auth: true, anon: false },
      { proname: 'respond_owner_transfer', a: 'p_team_id uuid, p_accept boolean', auth: true, anon: false },
    ])
  })

  it('a token whose session is gone (logout, deletion) cannot call any RPC', async () => {
    const s = await scenario()
    await s.db.query('delete from auth.sessions where id = $1', [P1])           // P1 logged out on that device
    await expect(q(s.db, P1, `select public.set_attendance($1, $2, 'absent')`, [s.e1, s.k1])).rejects.toThrow(/session_expired/)
    await expect(q(s.db, P1, `select public.create_team('x', 'x')`)).rejects.toThrow(/session_expired/)
    await expect(q(s.db, P1, 'select public.account_deletion_preview()')).rejects.toThrow(/session_expired/)
    await expect(q(s.db, P1, `select public.set_attendance($1, $2, 'absent')`, [s.e1, s.k1], null)).rejects.toThrow(/session_expired/) // no session_id
    await expect(q(s.db, P1, `select public.set_attendance($1, $2, 'absent')`, [s.e1, s.k1], P2)).rejects.toThrow(/session_expired/)   // someone else's
    const again = await login(s.db, P1)
    await q(s.db, P1, `select public.set_attendance($1, $2, 'absent')`, [s.e1, s.k1], again)
  })

  it('after deletion an old token sees nothing and cannot create or join anything', async () => {
    const s = await scenario()
    await purge(s.db, P3)
    await deleteAuthUser(s.db, P3)
    expect(await q(s.db, P3, 'select id from public.teams')).toEqual([])
    expect(await q(s.db, P3, 'select id from public.players')).toEqual([])
    for (const sql of [`select public.create_team('x', 'x')`, `select public.join_team('${s.t1.share_token}', 'x')`,
      `select public.set_attendance('${s.e1}', '${s.k1}', 'attend')`, 'select public.my_owner_transfers()']) {
      await expect(q(s.db, P3, sql)).rejects.toThrow(/session_expired/)
    }
  })
})

describe('6. integrity guards also stop deletions that bypass the purge', () => {
  it('a team can never have two owners or none', async () => {
    const s = await scenario()
    await expect(s.db.query(`update public.team_members set role = 'owner' where team_id = $1 and user_id = $2`, [s.t1.id, P1]))
      .rejects.toThrow(/team_members_one_owner|duplicate key/)
    await expect(s.db.query(`delete from public.team_members where team_id = $1 and role = 'owner'`, [s.t1.id]))
      .rejects.toThrow(/team_without_owner/)
  })

  it('deleting an Auth user directly (dashboard / raw SQL) is refused until the purge ran', async () => {
    const s = await scenario()
    await expect(deleteAuthUser(s.db, P3)).rejects.toThrow(/foreign key|violates/) // registrant of K3
    await s.db.query('update public.players set created_by = null where id = $1', [s.k3])
    await expect(deleteAuthUser(s.db, P3)).rejects.toThrow(/child_without_guardian/) // would orphan K3
    await expect(deleteAuthUser(s.db, O)).rejects.toThrow(/foreign key|violates|team_without_owner/)
  })
})

describe('7. failures: nothing half-done in the DB; a failed Auth deletion can always be retried', () => {
  it('a failure inside the purge rolls everything back', async () => {
    const s = await scenario()
    const snap = async () => (await s.db.query<{ h: string }>(`select md5(
      (select count(*) from public.players)::text || (select count(*) from public.attendance)::text ||
      (select count(*) from public.player_guardians)::text || (select count(*) from public.team_members)::text ||
      (select count(*) from public.guardian_invitations)::text || (select count(*) from private.account_deletions)::text) as h`)).rows[0]!.h
    const before = await snap()
    await s.db.exec(`create function public._boom() returns trigger language plpgsql as $$ begin raise exception 'injected_failure'; end $$;
      create trigger _boom before delete on public.team_members for each row execute function public._boom();`)
    await expect(purge(s.db, P3)).rejects.toThrow(/injected_failure/) // fails after children were deleted
    expect(await snap()).toBe(before)                                  // ...but nothing was kept
  })

  it('Auth deletion failed: user is "pending" — no data, cannot create/join/accept, can retry', async () => {
    const s = await scenario()
    expect((await purge(s.db, P3)).status).toBe('purged')
    // (Auth deletion failed here.) The failure is noted without personal data.
    await svc(s.db, 'select public.note_account_deletion_failure($1, $2)', [P3, '500 unexpected_failure'])
    const st = (await s.db.query<any>('select attempts, last_error from private.account_deletions where user_id = $1', [P3])).rows
    expect(st).toEqual([{ attempts: 1, last_error: '500 unexpected_failure' }])
    // the user can still log in and see the state, but nothing else
    expect((await preview(s.db, P3)).deletion_pending).toBe(true)
    expect(await q(s.db, P3, 'select id from public.teams')).toEqual([])
    await expect(q(s.db, P3, `select public.create_team('x', 'x')`)).rejects.toThrow(/account_deletion_pending/)
    await expect(q(s.db, P3, `select public.join_team($1, 'x')`, [s.t1.share_token])).rejects.toThrow(/account_deletion_pending/)
    const [{ r: inv }] = await q(s.db, P2, `select public.create_guardian_invitation($1) as r`, [s.k2])
    await expect(q(s.db, P3, `select public.accept_guardian_invitation($1, 'x')`, [inv.token])).rejects.toThrow(/account_deletion_pending/)
    // retry hours later with the same (old) session: allowed, because the data is already gone
    await loginAgo(s.db, P3, '5 hours')
    expect(await purge(s.db, P3)).toMatchObject({ status: 'purged', retry: true, children_deleted: 0, memberships_removed: 0 })
    // ...after a logout the retry needs a login (any age is fine), never the operator
    await s.db.query('delete from auth.sessions where user_id = $1', [P3])
    await expect(purge(s.db, P3)).rejects.toThrow(/reauth_required/)
    const back = await login(s.db, P3)
    await loginAgo(s.db, back, '2 days')
    expect((await purge(s.db, P3, back)).status).toBe('purged')
    await deleteAuthUser(s.db, P3)                                     // Auth deletion succeeds now
    expect((await s.db.query('select 1 from private.account_deletions where user_id = $1', [P3])).rows).toEqual([]) // state row gone too
    expect(await purge(s.db, P3, back)).toEqual({ status: 'already_deleted' })                                       // late double click
  })

  it('other users are not blocked by someone else\'s pending deletion', async () => {
    const s = await scenario()
    await purge(s.db, P3)
    await q(s.db, P1, `select public.create_team('P1のチーム', 'P1')`)
    await q(s.db, X, `select public.join_team($1, 'X')`, [s.t1.share_token])
    expect((await preview(s.db, P1)).deletion_pending).toBe(false)
  })

  it('method A (purge + Auth delete in one transaction) would roll back together (comparison only)', async () => {
    const s = await scenario()
    await s.db.exec(`create function auth._boom() returns trigger language plpgsql as $$ begin raise exception 'auth_delete_failed'; end $$;
      create trigger _boom before delete on auth.users for each row execute function auth._boom();`)
    await s.db.exec('begin')
    try {
      await s.db.exec('set local role service_role')
      await s.db.query('select public.purge_account_data($1, $2)', [P3, P3])
      await s.db.exec('reset role')
      await expect(deleteAuthUser(s.db, P3)).rejects.toThrow(/auth_delete_failed/)
    } finally { await s.db.exec('rollback') }
    expect((await s.db.query('select 1 from public.players where id = $1', [s.k3])).rows).toHaveLength(1)
  })
})

describe('8. app repo (supabaseRepo) against the real functions', async () => {
  const { createSupabaseRepo } = await import('../../app/repo/supabaseRepo')
  const { pgliteClient } = await import('./pgliteClient')
  const { RepoError } = await import('../../app/utils/types')

  it('hand-over through the repo, and the delete call sends only the confirmation', async () => {
    const s = await scenario()
    const sent: unknown[] = []
    const repoOf = (u: string, code: string | null = null) => createSupabaseRepo(pgliteClient(s.db, u), () => u,
      async (fn, body) => { sent.push({ fn, body }); return { error: code ? { code } : null } })
    const o = repoOf(O), p2 = repoOf(P2)
    expect((await o.deletionPreview()).teams_to_hand_over).toHaveLength(1)
    await o.requestOwnerTransfer(s.t1.id, P2)
    expect((await p2.myOwnerTransfers()).incoming.map((x) => x.team_name)).toEqual(['チームA'])
    expect(await p2.respondOwnerTransfer(s.t1.id, true)).toBe('accepted')
    expect((await o.deletionPreview()).teams_to_hand_over).toEqual([])
    await expect(o.cancelOwnerTransfer(s.t1.id)).rejects.toMatchObject({ code: 'transfer_not_found' })
    await o.deleteAccount('退会する')
    expect(sent).toEqual([{ fn: 'delete-account', body: { confirm: '退会する' } }]) // no user id
    await expect(repoOf(P3, 'auth_delete_failed').deleteAccount('退会する')).rejects.toBeInstanceOf(RepoError)
    await expect(repoOf(P3, 'auth_delete_failed').deleteAccount('退会する')).rejects.toMatchObject({ code: 'auth_delete_failed' })
    await expect(repoOf(P3, 'something_new').deleteAccount('退会する')).rejects.toMatchObject({ code: 'unknown' })
  })
})

describe('9. error codes are matched as whole words', async () => {
  const { codeOf } = await import('../../app/repo/supabaseRepo')
  it('does not confuse codes that contain each other', () => {
    expect(codeOf('transfer_not_found')).toBe('transfer_not_found')
    expect(codeOf('team_not_found')).toBe('team_not_found')
    expect(codeOf('not_found')).toBe('not_found')
    expect(codeOf('ERROR: account_deletion_pending (42501)')).toBe('account_deletion_pending')
    expect(codeOf('something else')).toBe('unknown')
  })
})
