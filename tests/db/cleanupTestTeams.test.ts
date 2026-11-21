// Admin cleanup SQL (scripts/ops/cleanup-test-teams.template.sql): deletes exactly the two test
// teams, keeps the protected team byte-for-byte, and stops (undoing everything) on any mismatch.
// The database mirrors the shape of the cloud data on 2026-11-14.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, type Db, joinTeamAs } from './setup'
// @ts-expect-error plain ESM helper without types
import { APPROVED, buildCleanupSql } from '../../scripts/ops/build-cleanup-sql.mjs'

const ROOT = join(import.meta.dirname, '../..')
const TEMPLATE = readFileSync(join(ROOT, 'scripts/ops/cleanup-test-teams.template.sql'), 'utf8')
const VALUES_SQL = readFileSync(join(ROOT, 'scripts/ops/cleanup-test-teams-values.sql'), 'utf8')
const U = (n: number) => `51000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const MEMA = U(1), JR = U(2), IMA = U(3), KAKI = U(4)

async function mirror() {
  const db = await createDb()
  for (const u of [MEMA, JR, IMA, KAKI]) await addUser(db, u)
  const q = (u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<any>(sql, p)).rows)
  const reg = async (u: string, team: string, name: string) => (await q(u, `select public.register_player($1, $2, null, true) as r`, [team, name]))[0].r.player_id as string
  const ev = async (u: string, team: string, title: string) => (await q(u, `select public.create_event($1, $2, now() + interval '2 day') as id`, [team, title]))[0].id as string
  const ans = (u: string, e: string, p: string, s = 'attend') => q(u, `select public.set_attendance($1, $2, $3)`, [e, p, s])
  // protected team: 3 members, 3 children (1 cancelled), 4 guardian links, 2 events (1 deleted), 4 answers, 1 used invitation
  const [y] = await q(MEMA, `select id, share_token from public.create_team('サンプルFC', 'サンプル代表')`)
  await joinTeamAs(db, JR, y.share_token, 'サンプルJr')
  await joinTeamAs(db, IMA, y.share_token, 'imagimo')
  const y1 = await reg(MEMA, y.id, 'テスト太郎2'), y2 = await reg(JR, y.id, 'テストJr'), y3 = await reg(MEMA, y.id, 'テスト三郎')
  const [{ r: yi }] = await q(JR, `select public.create_guardian_invitation($1) as r`, [y2])
  await q(IMA, `select public.accept_guardian_invitation($1, 'imagimo')`, [yi.token])
  const e1 = await ev(MEMA, y.id, 'サンプル練習'), e2 = await ev(MEMA, y.id, '中止の練習')
  await ans(MEMA, e1, y1); await ans(JR, e1, y2, 'absent'); await ans(MEMA, e2, y1); await ans(MEMA, e2, y3)
  await q(MEMA, `select public.archive_player($1)`, [y3]); await q(MEMA, `select public.delete_event($1)`, [e2])
  // test team: imagimo owner + member-a; 4 children; 1 event; 4 answers; 1 invitation used by a deleted account
  const [t] = await q(IMA, `select id, share_token from public.create_team('テストチーム', 'imagimo')`)
  await joinTeamAs(db, MEMA, t.share_token, 'member-a')
  await joinTeamAs(db, KAKI, t.share_token, 'test-account')
  const t1 = await reg(MEMA, t.id, 'T1'), t2 = await reg(IMA, t.id, 'T2'), ts = await reg(IMA, t.id, 'T2テスト共有'), tu = await reg(IMA, t.id, 'テスト単独')
  const [{ r: ti }] = await q(IMA, `select public.create_guardian_invitation($1) as r`, [ts])
  await q(KAKI, `select public.accept_guardian_invitation($1, 'test-account')`, [ti.token])
  const te = await ev(IMA, t.id, 'テストイベント')
  await ans(MEMA, te, t1); await ans(IMA, te, t2, 'absent'); await ans(KAKI, te, ts); await ans(IMA, te, tu, 'undecided')
  // solo team
  const [s] = await q(IMA, `select id from public.create_team('【テスト】ひとりチーム', 'imagimo')`)
  await reg(IMA, s.id, 'テスト一人')
  // the deleted test account (like the test account): purge + Auth deletion
  await db.exec('set role service_role'); await db.query('select public.purge_account_data($1, $2)', [KAKI, KAKI]); await db.exec('reset role')
  await db.query('delete from auth.users where id = $1', [KAKI])
  return { db, keepId: y.id as string, a: t.id as string, b: s.id as string, e1, y2 }
}

const values = async (db: Db) => (await db.query<any>(VALUES_SQL)).rows[0]
const keepFp = async (db: Db, id: string) => (await db.query<{ h: string }>(`select md5(concat_ws('|',
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.teams x where x.id = $1),
  (select string_agg(to_jsonb(m)::text, ',' order by m.team_id, m.user_id) from public.team_members m where m.team_id = $1),
  (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.players p where p.team_id = $1),
  (select string_agg(to_jsonb(a)::text, ',' order by a.event_id, a.player_id) from public.attendance a where a.team_id = $1))) h`, [id])).rows[0]!.h
/** Every row of every app table + auth users, as one hash (to prove "nothing changed"). */
const wholeDb = async (db: Db) => (await db.query<{ h: string }>(`select md5(concat_ws('|',
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.teams x),
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.team_members x),
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.players x),
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.player_guardians x),
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.events x),
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.attendance x),
  (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.guardian_invitations x),
  (select string_agg(id::text, ',' order by id) from auth.users))) h`)).rows[0]!.h
const run = (db: Db, sql: string) => db.exec(sql).then(() => null, (e: Error) => e.message)

async function setup() {
  const m = await mirror()
  const approved = { ...APPROVED, keepFp: await keepFp(m.db, m.keepId) } // the cloud fingerprint differs from this mirror
  const build = async (mode = 'dry-run', over: Record<string, string> = {}) =>
    buildCleanupSql(TEMPLATE, { ...(await values(m.db)), ...over }, mode, approved)
  return { ...m, approved, build }
}

describe('cleanup of the two test teams', () => {
  it('the mirror has the approved shape (same counts as the cloud inventory)', async () => {
    const s = await setup()
    const n = (sql: string) => s.db.query<{ n: number }>(sql).then((r) => r.rows[0]!.n)
    expect(await n(`select count(*)::int n from auth.users`)).toBe(3)
    expect(await n(`select count(*)::int n from public.players p join public.teams t on t.id = p.team_id where t.name in ('テストチーム','【テスト】ひとりチーム')`)).toBe(5)
    const inv = (await s.db.query<any>(`select used_at is not null used, used_by from public.guardian_invitations i join public.teams t on t.id = i.team_id where t.name = 'テストチーム'`)).rows
    expect(inv).toEqual([{ used: true, used_by: null }])
  })

  it('check mode: read-only checks pass, no lock, no delete, nothing changed', async () => {
    const s = await setup()
    const before = await wholeDb(s.db)
    const sql = await s.build('check')
    expect(sql).toContain("if c_mode <> 'check' then")
    const err = await run(s.db, sql)
    expect(err).toMatch(/^CHECK_OK \(read only, nothing deleted\)/)
    expect(err).toContain('members=3 children=5 guardians=5 events=1 answers=4 invitations=1 transfers=0')
    expect(await wholeDb(s.db)).toBe(before)
    // and it still stops on a mismatch
    expect(await run(s.db, await s.build('check', { team_a_members: 'x' }))).toMatch(/members\/owner differ/)
  })

  it('dry-run: every check and the delete run, then everything is undone', async () => {
    const s = await setup()
    const before = await s.db.query('select 1').then(() => wholeDb(s.db))
    const err = await run(s.db, await s.build('dry-run'))
    expect(err).toMatch(/^DRY_RUN_OK/)
    expect(err).toContain('members=3 children=5 guardians=5 events=1 answers=4 invitations=1 transfers=0')
    expect(err).toContain('3/6/8/9/3/8/2/0 -> 1/3/3/4/2/4/1/0')
    expect(await wholeDb(s.db)).toBe(before)
  })

  it('commit: deletes exactly the two teams and their rows; protected team and auth users unchanged', async () => {
    const s = await setup()
    const fpBefore = await keepFp(s.db, s.keepId)
    const err = await run(s.db, await s.build('commit'))
    expect(err).toBeNull()
    const teams = (await s.db.query<any>('select name from public.teams order by name')).rows.map((r) => r.name)
    expect(teams).toEqual(['サンプルFC'])
    for (const tbl of ['team_members', 'players', 'player_guardians', 'events', 'attendance', 'guardian_invitations', 'team_owner_transfers']) {
      const n = (await s.db.query<{ n: number }>(`select count(*)::int n from public.${tbl} where team_id in ($1, $2)`, [s.a, s.b])).rows[0]!.n
      expect(n, tbl).toBe(0)
    }
    expect(await keepFp(s.db, s.keepId)).toBe(fpBefore)
    expect((await s.db.query<{ n: number }>('select count(*)::int n from auth.users')).rows[0]!.n).toBe(3)
    const g = (await s.db.query<{ n: number }>('select count(*)::int n from public.player_guardians')).rows[0]!.n
    expect(g).toBe(4)                                                                 // the protected team's 4 links
    // imagimo / member-a still use the protected team normally
    await asUser(s.db, IMA, () => s.db.query(`select public.set_attendance($1, $2, 'undecided')`, [s.e1, s.y2]))
  })

  it.each([
    ['team id', { team_a_id: '51000000-0000-4000-8000-0000000000ff' }, /target team id not found/],
    ['team name', { team_b_name: '【テスト】ひとりチーム（別）' }, /target team id not found|team name differs/],
    ['creation time', { team_a_created: '2020-01-01T00:00:00.000000Z' }, /creation time differs/],
    ['members / owner', { team_a_members: 'member-a=owner=000000000000;imagimo=member=000000000000' }, /members\/owner differ/],
    ['protected id', { keep_id: '51000000-0000-4000-8000-0000000000fe' }, /protected team not found/],
  ])('stops and changes nothing when the %s does not match', async (_l, over, msg) => {
    const s = await setup()
    const before = await wholeDb(s.db)
    const err = await run(s.db, await s.build('commit', over))
    expect(err).toMatch(msg)
    expect(await wholeDb(s.db)).toBe(before)
  })

  it('stops when the targets contain more than approved (a child added after the inventory)', async () => {
    const s = await setup()
    const sql = await s.build('commit')
    await asUser(s.db, IMA, () => s.db.query(`select public.register_player($1, '後から登録', null, true)`, [s.b]))
    const before = await wholeDb(s.db)
    expect(await run(s.db, sql)).toMatch(/target contents differ: members=3 children=6/)
    expect(await wholeDb(s.db)).toBe(before)
  })

  it('stops when the protected team changed (fingerprint) or its counts changed', async () => {
    const s = await setup()
    const sql = await s.build('commit')
    await asUser(s.db, JR, () => s.db.query(`select public.set_attendance($1, $2, 'attend')`, [s.e1, s.y2]))
    const before = await wholeDb(s.db)
    expect(await run(s.db, sql)).toMatch(/protected team fingerprint differs/)
    expect(await wholeDb(s.db)).toBe(before)
  })

  it('stops on an open hand-over request or a pending account deletion of a member', async () => {
    const s = await setup()
    const sql = await s.build('commit')
    await asUser(s.db, IMA, () => s.db.query('select public.request_owner_transfer($1, $2)', [s.a, MEMA]))
    expect(await run(s.db, sql)).toMatch(/target contents differ: .*transfers=1/)
    await asUser(s.db, IMA, () => s.db.query('select public.cancel_owner_transfer($1)', [s.a]))
    await s.db.query(`insert into private.account_deletions (user_id) values ($1)`, [MEMA])
    const before = await wholeDb(s.db)
    expect(await run(s.db, sql)).toMatch(/pending account deletion/)
    expect(await wholeDb(s.db)).toBe(before)
  })

  it('stops when the auth user count differs', async () => {
    const s = await setup()
    const sql = await s.build('commit')
    await addUser(s.db, U(9))
    expect(await run(s.db, sql)).toMatch(/auth users 4 \(expected 3\)/)
  })

  it('a failure in the middle of the delete undoes the whole statement', async () => {
    const s = await setup()
    await s.db.exec(`create function public._boom() returns trigger language plpgsql as $$ begin raise exception 'injected_failure'; end $$;
      create trigger _boom before delete on public.attendance for each row execute function public._boom();`)
    const before = await wholeDb(s.db)
    expect(await run(s.db, await s.build('commit'))).toMatch(/injected_failure/)
    expect(await wholeDb(s.db)).toBe(before)
  })

  it('the builder refuses bad input and leaves no placeholder', async () => {
    const s = await setup()
    await expect(s.build('delete')).rejects.toThrow(/mode/)
    await expect(s.build('commit', { team_a_id: 'not-a-uuid' })).rejects.toThrow(/uuid/)
    const sql = await s.build('dry-run')
    expect(sql).not.toMatch(/__[A-Z_]+__/)
    expect(sql).toContain("c_mode        constant text := 'dry-run'")
  })
})
