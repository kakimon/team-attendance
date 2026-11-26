// Operations safety: snapshot comparability and the Phase 4-A rollback SQL.
// + backup (backup_tables*.sql) and the method-A restore (restore_app_data.template.sql via build-restore-sql.mjs).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, joinTeamAs, migrationFiles, type Db } from './setup'
// @ts-expect-error plain ESM script without type declarations
import { acceptedStates, buildRestoreSql, checkBackup, functionOnlyExtension, isAcceptedState, migrationLists, parseBackup } from '../../scripts/ops/build-restore-sql.mjs'

const ops = (f: string) => readFileSync(join(import.meta.dirname, '../../scripts/ops', f), 'utf8')
const A = '60000000-0000-0000-0000-00000000000a'
const B = '60000000-0000-0000-0000-00000000000b'
const C = '60000000-0000-0000-0000-00000000000c'

async function seed(db: Db) {
  for (const u of [A, B, C]) await addUser(db, u)
  const [team] = (await asUser(db, A, () => db.query<any>(`select id, share_token from public.create_team('運用テスト', '代表')`))).rows
  await asUser(db, A, () => db.query(`select public.create_event($1, '練習', '2030-03-01T09:00:00Z', '公民館')`, [team.id]))
  await joinTeamAs(db, B, team.share_token, 'B')
  const [{ r }] = (await asUser(db, B, () => db.query<any>(`select public.register_player($1, 'テスト たろう', '3年') as r`, [team.id]))).rows
  const [ev] = (await db.query<any>(`select id from public.events`)).rows
  await asUser(db, B, () => db.query(`select public.set_attendance($1, $2, 'attend', 'よろしく')`, [ev.id, r.player_id]))
  const [{ inv }] = (await asUser(db, B, () => db.query<any>(`select public.create_guardian_invitation($1) as inv`, [r.player_id]))).rows
  return { team, ev: ev.id as string, kid: r.player_id as string, token: inv.token as string }
}
const snapshot = async (db: Db) => (await db.query<{ tbl: string; n: number; hash: string }>(ops('snapshot.sql'))).rows

describe('snapshot (scripts/ops/snapshot.sql)', () => {
  it('is unchanged by applying the Phase 4-A migration (data untouched)', async () => {
    const db = await createDb({ before: '20261110000000' })
    await seed(db)
    const before = await snapshot(db)
    await applyMigration(db, '20261110000000_phase4a.sql')
    expect(await snapshot(db)).toEqual(before)
  })

  it('detects a real data change', async () => {
    const db = await createDb()
    const s = await seed(db)
    const before = await snapshot(db)
    await asUser(db, B, () => db.query(`select public.set_attendance($1, $2, 'absent')`, [s.ev, s.kid]))
    const after = await snapshot(db)
    expect(after.find((r) => r.tbl === 'attendance')!.hash).not.toBe(before.find((r) => r.tbl === 'attendance')!.hash)
  })

  it('the snapshot detects a changed owner of a self registration (the D3.5 columns are verified)', async () => {
    const db = await createDb()
    const s = await seed(db)
    await joinTeamAs(db, C, s.team.share_token, 'C')
    const [{ r: me }] = (await asUser(db, C, () => db.query<any>(`select public.register_self($1) as r`, [s.team.id]))).rows
    const before = await snapshot(db)
    await db.query(`update public.players set self_user_id = $1 where id = $2`, [B, me.player_id])
    const after = await snapshot(db)
    const row = (rows: typeof before, t: string) => rows.find((r) => r.tbl === t)!
    expect(row(after, 'players.self_registration').hash).not.toBe(row(before, 'players.self_registration').hash)
    expect(row(after, 'players').hash).toBe(row(before, 'players').hash)      // the change is caught by its own row
  })
})

describe('rollback (scripts/ops/rollback_phase4a.sql)', () => {
  it('restores pre-4-A behaviour without losing data', async () => {
    const db = await createDb()
    const s = await seed(db)
    await asUser(db, A, () => db.query(`select public.update_event($1, '練習（変更）', '2030-03-02T09:00:00Z')`, [s.ev]))
    const before = await snapshot(db)
    await db.exec(ops('rollback_phase4a.sql'))

    const fns = (await db.query<{ f: string }>(
      `select proname as f from pg_proc where proname in ('update_event','delete_event','update_player','archive_player')`)).rows
    expect(fns).toEqual([])
    const pol = (await db.query<{ t: string; q: string }>(
      `select tablename as t, qual as q from pg_policies where tablename in ('events','players','attendance') order by 1`)).rows
    expect(pol.map((p) => p.q)).toEqual(['private.is_team_member(team_id)', 'private.is_team_member(team_id)', 'private.is_team_member(team_id)'])
    // old invitation behaviour: an existing guardian gets an error again
    await expect(asUser(db, B, () => db.query(`select public.accept_guardian_invitation($1, 'x')`, [s.token]))).rejects.toThrow(/already_guardian/)
    // normal operations and permission checks still work
    await asUser(db, B, () => db.query(`select public.set_attendance($1, $2, 'undecided')`, [s.ev, s.kid]))
    await expect(asUser(db, C, () => db.query(`select public.set_attendance($1, $2, 'absent')`, [s.ev, s.kid]))).rejects.toThrow(/forbidden|not_found/)
    const anon = (await db.query<{ f: string }>(
      `select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'execute')`)).rows
    expect(anon.map((r) => r.f).sort()).toEqual(['health_check', 'service_stats'])
    // data kept (only the attendance status changed by the call above)
    const after = await snapshot(db)
    for (const t of ['teams', 'team_members', 'players', 'player_guardians', 'events', 'guardian_invitations']) {
      expect(after.find((r) => r.tbl === t)).toEqual(before.find((r) => r.tbl === t))
    }
  })
})

// =====================================================================================
// Backup (backup_tables.sql = Phase 4-B, backup_tables_latest.sql = latest) and the method-A restore
// =====================================================================================
const PHASE4B_END = '20261117000000' // first migration after Phase 4-B
const FN_ONLY = '20261124000000'      // first function-only migration (family invitations): latest 17 -> 18
const FN_ONLY2 = '20261126000000'     // second function-only migration (top-page usage numbers): latest 18 -> 19
const V = (f: string) => f.slice(0, 14)
const TEMPLATE = ops('restore_app_data.template.sql')
const U = (n: number) => `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [OW, AD, SE, DA, MO, BL, SU, XD, OUT] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(U)

/** PGlite has no Supabase CLI: record the applied migrations like supabase_migrations.schema_migrations. */
async function opsDb(before?: string) {
  const db = await createDb(before ? { before } : {})
  await db.exec(`create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text)`)
  await recordMigrations(db, before)
  return db
}
async function recordMigrations(db: Db, before?: string) {
  const applied = (await db.query<{ n: number }>(`select count(*)::int n from supabase_migrations.schema_migrations`)).rows[0]!.n
  const isLatest = (await db.query<{ x: boolean }>(`select to_regclass('private.team_join_tokens') is not null x`)).rows[0]!.x
  const files = migrationFiles().filter((f) => (isLatest || f < PHASE4B_END) && (!before || f < before))
  for (const f of files.slice(applied)) await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`, [f.slice(0, 14), f.slice(15, -4)])
}
const q1 = async <T = any>(db: Db, sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0] as T
const as = <T = any>(db: Db, u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<{ r: T }>(sql, p)).rows[0]!.r)
const errOf = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message)

/** Every column of every restorable table (and the permission surface), for exact before/after comparison. */
async function fingerprint(db: Db) {
  const latest = (await q1<{ x: boolean }>(db, `select to_regclass('private.team_join_tokens') is not null x`)).x
  const t: [string, string][] = [['public.teams', 'id'], ['public.team_members', 'team_id, user_id'], ['public.players', 'id'],
    ['public.player_guardians', 'player_id, user_id'], ['public.events', 'id'], ['public.attendance', 'event_id, player_id'],
    ['public.guardian_invitations', 'id'], ['public.team_owner_transfers', 'team_id'], ['private.account_deletions', 'user_id'],
    ...(latest ? [['private.team_join_tokens', 'team_id'], ['private.team_member_blocks', 'team_id, user_id']] as [string, string][] : [])]
  const out: Record<string, string> = {}
  for (const [tbl, pk] of t) {
    out[tbl] = (await q1<{ h: string }>(db, `select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by ${pk.split(',').map((c) => `x.${c.trim()}::text`).join(', ')}), '')) h from ${tbl} x`)).h
  }
  out.acl = (await q1<{ h: string }>(db, `select md5(string_agg(p.oid::regprocedure::text || coalesce(p.proacl::text, '-'), '|' order by p.oid::regprocedure::text)) h
    from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)`)).h
  out.tables = (await q1<{ h: string }>(db, `select md5(string_agg(c.oid::regclass::text || coalesce(c.relacl::text, '-') || c.relrowsecurity, '|' order by c.oid::regclass::text)) h
    from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'r'`)).h
  out.policies = (await q1<{ h: string }>(db, `select md5(string_agg(tablename || policyname || coalesce(qual, '') || coalesce(with_check, ''), '|' order by tablename, policyname)) h from pg_policies`)).h
  return out
}
const backupOf = async (db: Db, file = 'backup_tables_latest.sql') => parseBackup((await q1<{ backup: any }>(db, ops(file))).backup)
const sqlFor = (b: unknown, mode: 'plan' | 'commit' = 'plan', o: { scope?: string; expect?: number } = {}) =>
  buildRestoreSql(TEMPLATE, b, { mode, scope: o.scope ?? 'missing-teams', expectMissingTeams: o.expect ?? null })
/** The SQL without the builder's own checks, to prove the SQL refuses bad input by itself. */
const rawSql = (b: unknown, mode = 'plan', expect = -1, scope = 'missing-teams') => TEMPLATE.split('__MODE__').join(mode).split('__SCOPE__').join(scope)
  .split('__EXPECT_MISSING_TEAMS__').join(String(expect)).split('__BACKUP__').join(`$bk_t$${JSON.stringify(b)}$bk_t$::jsonb`)
const plan = async (db: Db, b: unknown, scope = 'missing-teams') => (await errOf(db.exec(sqlFor(b, 'plan', { scope })))) ?? 'NO ERROR'
const commit = (db: Db, b: unknown, expect: number, scope = 'missing-teams') => db.exec(sqlFor(b, 'commit', { scope, expect }))
const wholeTeams = (report: string) => Number(/whole teams to restore: (\d+)/.exec(report)?.[1])
/** Data loss: every team (and everything under it) and every deletion record disappear. Auth stays. */
async function loseEverything(db: Db) {
  await db.exec(`delete from public.teams; delete from private.account_deletions`)
}

/** Latest schema, fictional: roles, self + proxy, family sharing, answers, invitations, rotated and stopped join links,
 *  a removed (blocked) member, a suspended member, an open owner hand-over, a half-way account deletion. */
async function seedLatest(db: Db) {
  for (const u of [OW, AD, SE, DA, MO, BL, SU, XD, OUT]) await addUser(db, u)
  const t = await q1<{ id: string; share_token: string }>(db, 'select 1') && (await asUser(db, OW, () => db.query<any>(`select id, share_token from public.create_team('復元クラブ', '代表')`))).rows[0]
  const T = t.id as string
  await as(db, OW, `select public.create_event($1, '練習', '2030-04-01T09:00:00Z', '校庭', null) as r`, [T])
  await as(db, OW, `select public.create_event($1, '中止', '2030-04-02T09:00:00Z', null, null) as r`, [T])
  const evs = (await db.query<{ id: string; title: string }>(`select id, title from public.events where team_id = $1`, [T])).rows
  const E1 = evs.find((e) => e.title === '練習')!.id, E2 = evs.find((e) => e.title === '中止')!.id
  for (const [u, n] of [[AD, '副代表'], [SE, '山田'], [DA, '田中父'], [BL, '外す人'], [SU, '停止する人']]) await joinTeamAs(db, u!, t.share_token, n!)
  await as(db, OW, `select public.set_member_role($1, $2, 'admin') as r`, [T, AD])
  await as(db, OW, `select public.delete_event($1) as r`, [E2])
  const self = await as(db, SE, `select public.register_self($1) as r`, [T])
  const kid = await as(db, DA, `select public.register_player($1, '田中 ゆうと', '4年', true) as r`, [T])
  const kid2 = await as(db, DA, `select public.register_player($1, '田中 はな', null, true) as r`, [T])
  const inv = await as(db, DA, `select public.create_guardian_invitation($1) as r`, [kid.player_id])
  await as(db, MO, `select public.accept_guardian_invitation($1, '田中母') as r`, [inv.token])
  await as(db, DA, `select public.create_guardian_invitation($1) as r`, [kid2.player_id])                // unused, valid
  await as(db, SE, `select public.set_attendance($1, $2, 'attend', '行きます') as r`, [E1, self.player_id])
  await as(db, MO, `select public.set_attendance($1, $2, 'absent', null) as r`, [E1, kid.player_id])
  const sus = await as(db, SU, `select public.register_self($1) as r`, [T])
  await as(db, SU, `select public.set_attendance($1, $2, 'attend', null) as r`, [E1, sus.player_id])
  await as(db, OW, `select public.remove_member($1, $2) as r`, [T, BL])
  await as(db, OW, `select public.suspend_member($1, $2) as r`, [T, SU])
  await as(db, OW, `select public.request_owner_transfer($1, $2) as r`, [T, AD])
  const first = (await as(db, OW, `select public.get_join_link($1) as r`, [T])).token as string
  const rotated = (await as(db, OW, `select public.rotate_join_token($1) as r`, [T])).token as string
  const t2 = (await asUser(db, MO, () => db.query<any>(`select id from public.create_team('受付停止', '母')`))).rows[0].id as string
  await as(db, MO, `select public.set_join_open($1, false) as r`, [t2])
  await db.query(`insert into private.account_deletions (user_id, attempts, last_error, last_error_at) values ($1, 2, 'auth_delete_failed', now())`, [XD])
  return { T, T2: t2, E1, first, rotated, self: self.player_id as string, kid: kid.player_id as string, sus: sus.player_id as string }
}

describe('backup files', () => {
  it('Phase 4-B file: format 3, kind phase4b, 9 tables incl. owner hand-overs and deletion records, counts, 6 migrations', async () => {
    const db = await opsDb(PHASE4B_END)
    const s = await seed(db)
    await asUser(db, A, () => db.query(`select public.request_owner_transfer($1, $2)`, [s.team.id, B]))
    await db.query(`insert into private.account_deletions (user_id) values ($1)`, [C])
    const b = await backupOf(db, 'backup_tables.sql')
    expect(checkBackup(b)).toEqual({ kind: 'phase4b', counts: { teams: 1, team_members: 2, players: 1, player_guardians: 1, events: 1, attendance: 1,
      guardian_invitations: 1, team_owner_transfers: 1, account_deletions: 1 } })
    expect(b.migrations).toHaveLength(6)
    expect(b.auth_users_count).toBe(3)
    expect(Object.keys(b)).not.toContain('team_join_tokens')
    expect(await errOf(db.query(ops('backup_tables_latest.sql')))).toMatch(/team_join_tokens.*does not exist/)   // wrong file fails loudly
  })

  it('latest file: kind latest, 11 tables (join tokens, re-join blocks), no attempt counters', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    const { kind, counts } = checkBackup(b)
    expect(kind).toBe('latest')
    expect(Object.keys(counts)).toHaveLength(11)
    expect(counts).toMatchObject({ teams: 2, team_join_tokens: 2, team_member_blocks: 1, team_owner_transfers: 1, account_deletions: 1 })
    expect(b.migrations).toEqual(migrationFiles().map(V))                                    // 18, by ID and order
    expect(Object.keys(b)).not.toContain('rate_events')
    expect(b.players.find((p: any) => p.is_self)).toBeTruthy()
    expect(b.team_members.find((m: any) => m.suspended_at)).toBeTruthy()
    expect(parseBackup(JSON.stringify({ rows: [{ backup: JSON.stringify(b) }] }))).toEqual(b)   // CLI output forms
    expect(parseBackup(JSON.stringify([{ backup: b }]))).toEqual(b)
  })

  it('the restore knows exactly the Phase 4-B and the latest migration lists (update the template with every new migration)', () => {
    const lists = [...TEMPLATE.matchAll(/c_(?:4b|latest)\s+text\[\] := array\[([^\]]+)\]/g)].map((m) => m[1]!.match(/\d{14}/g))
    expect(lists[1]).toEqual(migrationFiles().map((f) => f.slice(0, 14)))
    expect(lists[0]).toEqual(migrationFiles().filter((f) => f < PHASE4B_END).map((f) => f.slice(0, 14)))
    // function-only tail: exactly the family-invitation migration (it changes no table, column or data)
    expect(migrationLists(TEMPLATE).functionOnly).toEqual([FN_ONLY, FN_ONLY2])
  })

  it('known states by ID and order (never by count): 4-B = 6; latest = 17, 18 or 19; anything else is refused', () => {
    const lists = migrationLists(TEMPLATE)
    const all = migrationFiles().map(V)
    const l17 = all.filter((v) => v < FN_ONLY)
    const l18 = all.filter((v) => v < FN_ONLY2)
    expect(acceptedStates(lists, 'latest')).toEqual([all, l18, l17])
    expect(isAcceptedState(lists, 'latest', all)).toBe(true)
    expect(isAcceptedState(lists, 'latest', l17)).toBe(true)
    expect(isAcceptedState(lists, 'phase4b', all.filter((v) => v < PHASE4B_END))).toBe(true)
    const swapped = [...l17.slice(0, -2), l17.at(-1)!, l17.at(-2)!]
    for (const bad of [[...all, '20991231000000'], [...l17, '20991231000000'], all.filter((v) => v !== '20261118210000'), swapped, all.slice(0, 16), [], undefined]) {
      expect(isAcceptedState(lists, 'latest', bad as any), JSON.stringify(bad?.length)).toBe(false)
    }
    expect(functionOnlyExtension(lists, l17, all)).toEqual([FN_ONLY, FN_ONLY2])
    expect(functionOnlyExtension(lists, l18, all)).toEqual([FN_ONLY2])
    expect(functionOnlyExtension(lists, all, all)).toEqual([])
    expect(functionOnlyExtension(lists, all, l17)).toBeNull()                                   // never backwards
    expect(functionOnlyExtension(lists, l17.slice(0, 16), all)).toBeNull()                      // a schema migration in between
    expect(() => acceptedStates({ ...lists, functionOnly: ['20261118210000'] }, 'latest')).toThrow(/not the tail/)
  })
})

describe('method A restore — latest schema', () => {
  it('data loss: plan changes nothing; commit restores every row exactly (tokens, stops, blocks, suspension, self/proxy, hand-over, deletion record)', async () => {
    const db = await opsDb()
    const s = await seedLatest(db)
    const b = await backupOf(db)
    const before = await fingerprint(db)
    await loseEverything(db)
    const lost = await fingerprint(db)
    const report = await plan(db, b)
    expect(report).toMatch(/^RESTORE_PLAN/)
    expect(report).toMatch(/whole teams to restore: 2/)
    expect(report).toMatch(/team_join_tokens: backup 2 \| present 0 \(differs 0\) \| restore 2 \| left out 0/)
    expect(report).toMatch(/post-checks: ok/)
    expect(report).not.toContain(s.rotated)                                  // no tokens / ids / names in the report
    expect(report).not.toContain(OW)
    expect(report).not.toContain('復元クラブ')
    expect(await fingerprint(db)).toEqual(lost)                              // plan rolled back
    await commit(db, b, wholeTeams(report))
    expect(await fingerprint(db)).toEqual(before)                           // every column of every table, ACLs, policies

    // behaviour through the real RPCs
    const preview = (tok: string) => asUser(db, OUT, async () => (await db.query<any>(`select * from public.preview_join($1)`, [tok])).rows)
    expect(await preview(s.first)).toEqual([])                                                                     // rotated-away link dead
    expect(await preview(s.rotated)).toEqual([expect.objectContaining({ team_id: s.T, is_member: false })])
    expect((await as(db, MO, `select public.get_join_link($1) as r`, [s.T2]))).toEqual({ open: false, token: null }) // stop kept
    expect(await errOf(as(db, BL, `select public.join_by_token($1, 'again') as r`, [s.rotated]))).toMatch(/blocked_from_team/)
    expect(await errOf(as(db, SU, `select public.set_attendance($1, $2, 'absent', null) as r`, [s.E1, s.sus]))).toMatch(/team_access_suspended|forbidden/)
    expect(await errOf(asUser(db, XD, () => db.query(`select public.create_team('x', 'x')`)))).toMatch(/account_deletion_pending/)
    expect((await as(db, AD, `select public.my_owner_transfers() as r`))).toBeTruthy()
    expect((await q1(db, `select is_self, self_user_id from public.players where id = $1`, [s.self]))).toEqual({ is_self: true, self_user_id: SE })
    await as(db, MO, `select public.set_attendance($1, $2, 'attend', null) as r`, [s.E1, s.kid])                   // family sharing works
    expect((await asUser(db, OUT, () => db.query(`select * from public.teams`))).rows).toEqual([])                // RLS
    expect(await errOf(asUser(db, OUT, () => db.query(`select public.join_team($1, 'x')`, ['x'.repeat(32)])))).toMatch(/permission denied/)
  })

  it('running it twice: the second commit stops (count changed) or, told 0, changes nothing', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await loseEverything(db)
    await commit(db, b, 2)
    const after = await fingerprint(db)
    expect(await errOf(commit(db, b, 2))).toMatch(/restore_aborted: 0 whole team\(s\) would be restored but 2 were expected/)
    await commit(db, b, 0)
    expect(await fingerprint(db)).toEqual(after)
    expect(await plan(db, b)).toMatch(/teams: backup 2 \| present 2 \(differs 0\) \| restore 0/)
  })

  it('stops without any change when ONE Auth user referenced by the backup is gone (method A never creates Auth users)', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await loseEverything(db)
    await db.query(`delete from auth.users where id = $1`, [SE])
    const lost = await fingerprint(db)
    expect(await plan(db, b)).toMatch(/restore_aborted: 1 Auth user\(s\) referenced by the backup no longer exist/)
    expect(await errOf(commit(db, b, 2))).toMatch(/restore_aborted: 1 Auth user/)
    expect(await fingerprint(db)).toEqual(lost)
  })

  it('existing teams: changes made after the backup are never reverted (rotated link, resumed member, unblock, removal)', async () => {
    const db = await opsDb()
    const s = await seedLatest(db)
    const b = await backupOf(db)
    const newTok = (await as(db, OW, `select public.rotate_join_token($1) as r`, [s.T])).token
    await as(db, OW, `select public.resume_member($1, $2) as r`, [s.T, SU])
    await as(db, OW, `select public.unblock_member($1, $2) as r`, [s.T, BL])
    await as(db, OW, `select public.remove_member($1, $2) as r`, [s.T, AD])           // removed after the backup
    const now = await fingerprint(db)
    const report = await plan(db, b)
    expect(report).toMatch(/whole teams to restore: 0/)
    expect(report).toMatch(/not restored, changed after the backup inside existing teams\? memberships=1 .*rejoin_blocks=1/)
    expect(report).toMatch(/team_join_tokens: backup 2 \| present 2 \(differs 1\) \| restore 0/)
    await commit(db, b, 0)                                                            // default scope: nothing to do
    expect(await fingerprint(db)).toEqual(now)
    expect((await as(db, OW, `select public.get_join_link($1) as r`, [s.T])).token).toBe(newTok)
    expect(await errOf(commit(db, b, 0, 'all'))).toMatch(/restore_aborted: inside teams that still exist .*memberships=1.*rejoin_blocks=1.*by hand/)
    expect(await fingerprint(db)).toEqual(now)
  })

  it('scope all: lost answers and events inside an existing team come back; existing rows are not overwritten', async () => {
    const db = await opsDb()
    const s = await seedLatest(db)
    const b = await backupOf(db)
    const before = await fingerprint(db)
    await db.exec(`delete from public.attendance`)                                     // e.g. a broken update wiped the answers
    await db.query(`update public.events set title = '誤更新' where id = $1`, [s.E1])     // and one row was changed by mistake
    const p = await plan(db, b, 'all')
    expect(p).toMatch(/attendance: backup 3 \| present 0 \(differs 0\) \| restore 3/)
    expect(p).toMatch(/events: backup 2 \| present 2 \(differs 1\) \| restore 0/)      // the wrong update is only counted
    expect(await plan(db, b)).toMatch(/attendance: backup 3 \| present 0 \(differs 0\) \| restore 0 \| left out 3/)
    await commit(db, b, 0, 'all')
    const after = await fingerprint(db)
    expect(after['public.attendance']).toBe(before['public.attendance'])
    expect(after['public.events']).not.toBe(before['public.events'])                    // not overwritten
    expect((await q1(db, `select title from public.events where id = $1`, [s.E1]))).toEqual({ title: '誤更新' })
  })

  it('never revives data of a user whose account deletion started after the backup', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await loseEverything(db)
    await db.query(`insert into private.account_deletions (user_id) values ($1)`, [DA])  // DA started deleting the account
    expect(await plan(db, b)).toMatch(/restore_aborted: \d+ row\(s\) would revive data of a user whose account deletion is in progress/)
  })

  it('a 4-B style or tampered backup is refused by the builder AND by the SQL itself; nothing changes', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await loseEverything(db)
    const lost = await fingerprint(db)
    const cases: [string, any, RegExp][] = [
      ['old format', { ...b, format: 1 }, /unsupported backup format/],
      ['truncated', { ...b, attendance: b.attendance.slice(1) }, /attendance has 2 rows but the backup recorded 3/],
      ['extra key', { ...b, rate_events: [] }, /unexpected key/],
      ['kind', { ...b, kind: 'phase4b' }, /unexpected key|migration list does not match/],
      ['migrations', { ...b, migrations: b.migrations.slice(0, 6) }, /migration list does not match/],
      ['duplicate', { ...b, teams: [...b.teams, b.teams[0]], counts: { ...b.counts, teams: 3 } }, /same key twice/],
      ['missing column', { ...b, players: b.players.map(({ is_self: _, ...r }: any) => r) }, /lacks columns of the latest schema/],
    ]
    for (const [name, bad, re] of cases) {
      expect(await errOf(db.exec(rawSql(bad))), name).toMatch(re)
      if (!/duplicate|missing column|migrations/.test(name)) expect(() => checkBackup(bad), name).toThrow()
    }
    expect(() => buildRestoreSql(TEMPLATE, b, { mode: 'commit' })).toThrow(/expect-missing-teams/)
    expect(await errOf(db.exec(rawSql(b, 'commit', -1)))).toMatch(/commit needs --expect-missing-teams/)
    expect(await fingerprint(db)).toEqual(lost)
  })

  it('a failure half-way (a bad row in a later table) rolls everything back', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await loseEverything(db)
    const lost = await fingerprint(db)
    const bad = { ...b, attendance: b.attendance.map((a: any, i: number) => (i === 0 ? { ...a, status: 'maybe' } : a)) }
    expect(await errOf(commit(db, bad, 2))).toMatch(/attendance_status_check|check constraint/)
    const bad2 = { ...b, players: b.players.map((p: any) => (p.is_self ? { ...p, self_user_id: null } : p)) }
    expect(await errOf(commit(db, bad2, 2))).toMatch(/players_self_owner/)
    expect(await fingerprint(db)).toEqual(lost)                                         // teams inserted first are gone again
  })

  it('post-checks: a broken security state is reported by plan and stops commit', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await loseEverything(db)
    await db.exec(`grant select on private.team_join_tokens to authenticated`)
    expect(await plan(db, b)).toMatch(/post-checks: private_tables_open=1/)
    expect(await errOf(commit(db, b, 2))).toMatch(/restore_aborted: post-check failed, nothing was changed: private_tables_open=1/)
    expect((await q1<{ n: number }>(db, `select count(*)::int n from public.teams`)).n).toBe(0)
  })

  it('refuses a database whose state is neither 4-B nor latest, or whose structure disagrees with its history', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await db.query(`delete from supabase_migrations.schema_migrations where version = '20261118210000'`)
    expect(await plan(db, b)).toMatch(/neither Phase 4-B .*known latest state \(17 to 19 migrations, by ID and order\): 18 applied/)   // a gap, not a state
    const old = await opsDb(PHASE4B_END)
    await old.query(`insert into supabase_migrations.schema_migrations (version) select unnest(array['20261117000000','20261117100000','20261117200000','20261117230000','20261117233000','20261117234500','20261117235500','20261118000000','20261118100000','20261118200000','20261118210000'])`)
    expect(await plan(old, b)).toMatch(/structure does not match its migration history/)
  })
})

describe('method A restore — Phase 4-B schema and 4-B backup into the latest schema', () => {
  async function seed4b() {
    const db = await opsDb(PHASE4B_END)
    await addUser(db, XD)
    const s = await seed(db)
    await asUser(db, A, () => db.query(`select public.request_owner_transfer($1, $2)`, [s.team.id, B]))
    await db.query(`insert into private.account_deletions (user_id) values ($1)`, [XD])
    return { db, s }
  }

  it('4-B backup -> loss -> restore on the 4-B schema: identical', async () => {
    const { db } = await seed4b()
    const b = await backupOf(db, 'backup_tables.sql')
    const before = await fingerprint(db)
    await loseEverything(db)
    const p = await plan(db, b)
    expect(p).toMatch(/target: phase4b \(6 migrations\) \| backup: phase4b/)
    await commit(db, b, wholeTeams(p))
    expect(await fingerprint(db)).toEqual(before)
  })

  it('a latest backup is refused by a 4-B database', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const { db: old } = await seed4b()
    expect(await plan(old, await backupOf(db))).toMatch(/latest-schema backup cannot be restored into a Phase 4-B database/)
  })

  it('4-B backup restored after the 11 migrations: same rows; the new columns take their defaults; restored teams get a NEW join token', async () => {
    const { db, s } = await seed4b()
    const b = await backupOf(db, 'backup_tables.sql')
    for (const f of migrationFiles().filter((f) => f >= PHASE4B_END)) await applyMigration(db, f)
    await recordMigrations(db)
    const before = await fingerprint(db)
    const tokBefore = (await q1<{ token: string }>(db, `select token from private.team_join_tokens where team_id = $1`, [s.team.id])).token
    await loseEverything(db)
    const p = await plan(db, b)
    expect(p).toMatch(/target: latest \(19 migrations\) \| backup: phase4b \(6 migrations\)/)
    expect(p).toMatch(/new join tokens .*: 1/)
    await commit(db, b, 1)
    const after = await fingerprint(db)
    for (const k of Object.keys(before)) if (k !== 'private.team_join_tokens') expect(after[k], k).toBe(before[k])
    const tokAfter = (await q1<{ token: string }>(db, `select token from private.team_join_tokens where team_id = $1`, [s.team.id])).token
    expect(tokAfter).toMatch(/^.{32,}$/)
    expect(tokAfter).not.toBe(tokBefore)                                               // the 4-B backup had no token
    expect((await q1(db, `select distinct is_self, self_user_id from public.players`))).toEqual({ is_self: false, self_user_id: null })
    expect((await q1(db, `select distinct suspended_at, access_revision::text as rev from public.team_members`))).toEqual({ suspended_at: null, rev: '0' })
    expect(await errOf(joinTeamAs(db, C, s.team.share_token, 'C'))).toBeNull()        // the new link works
  })
})

describe('method A restore — latest 17 and 19 (two function-only migrations in between)', () => {
  const lost17 = async () => {
    const db = await opsDb(FN_ONLY)                                                            // 17 migrations
    const s = await seedLatest(db)
    return { db, s, b: await backupOf(db) }
  }

  it('17 -> 17: backup, loss, restore: identical; the backup records the 17 migrations by ID and order', async () => {
    const { db, b } = await lost17()
    expect(b.migrations).toEqual(migrationFiles().filter((f) => f < FN_ONLY).map(V))
    expect(await q1(db, `select to_regprocedure('public.preview_guardian_invitation(text)') is null x`)).toEqual({ x: true })
    const before = await fingerprint(db)
    await loseEverything(db)
    const p = await plan(db, b)
    expect(p).toMatch(/target: latest \(17 migrations\) \| backup: latest \(17 migrations\)/)
    await commit(db, b, wholeTeams(p))
    expect(await fingerprint(db)).toEqual(before)
  })

  it('19 -> 19: identical (covered for every latest test above, the default database has 19)', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    const before = await fingerprint(db)
    await loseEverything(db)
    const p = await plan(db, b)
    expect(p).toMatch(/target: latest \(19 migrations\) \| backup: latest \(19 migrations\)/)
    await commit(db, b, wholeTeams(p))
    expect(await fingerprint(db)).toEqual(before)
  })

  it('17 backup -> 19 database (only function-only migrations in between): every row of every table comes back exactly', async () => {
    const { db, b } = await lost17()
    for (const f of migrationFiles().filter((f) => f >= FN_ONLY)) await applyMigration(db, f)
    await recordMigrations(db)
    const before = await fingerprint(db)                                                       // 18, with the data
    await loseEverything(db)
    const p = await plan(db, b)
    expect(p).toMatch(/target: latest \(19 migrations\) \| backup: latest \(17 migrations\)/)
    expect(p).toMatch(/post-checks: ok/)
    await commit(db, b, wholeTeams(p))
    expect(await fingerprint(db)).toEqual(before)
  })

  it('19 backup -> 17 database is refused (a backup from a later schema); nothing changes', async () => {
    const db18 = await opsDb()
    await seedLatest(db18)
    const b18 = await backupOf(db18)
    const { db } = await lost17()
    await loseEverything(db)
    const lost = await fingerprint(db)
    expect(await plan(db, b18)).toMatch(/restore_aborted: the backup was taken on a later schema \(19 migrations\) than this database \(17\)/)
    expect(await errOf(commit(db, b18, 2))).toMatch(/later schema/)
    expect(await fingerprint(db)).toEqual(lost)
  })

  it('unknown / missing / reordered migrations: refused in the database history AND in the backup; nothing changes', async () => {
    const { db, b } = await lost17()
    await loseEverything(db)
    const lost = await fingerprint(db)
    const backups: [string, any][] = [
      ['unknown extra', { ...b, migrations: [...b.migrations, '20991231000000'] }],
      ['gap', { ...b, migrations: b.migrations.filter((v: string) => v !== '20261118100000') }],
      ['reordered', { ...b, migrations: [...b.migrations.slice(0, -2), b.migrations.at(-1), b.migrations.at(-2)] }],
      ['18 by count, wrong ID', { ...b, migrations: [...b.migrations, '20261124000001'] }],
    ]
    for (const [name, bad] of backups) expect(await errOf(db.exec(rawSql(bad))), name).toMatch(/migration list does not match its kind/)
    await db.query(`insert into supabase_migrations.schema_migrations (version) values ('20991231000000')`)
    expect(await plan(db, b)).toMatch(/neither Phase 4-B .*: 18 applied/)                    // 18 rows, but not the 18 IDs
    await db.query(`delete from supabase_migrations.schema_migrations where version = '20991231000000'`)
    expect(await fingerprint(db)).toEqual(lost)
  })

  it('structure must match the history: a recorded function-only migration without its function, or the reverse, is refused', async () => {
    const db = await opsDb()
    await seedLatest(db)
    const b = await backupOf(db)
    await db.exec(`drop function public.service_stats()`)                                     // 19 recorded, its function gone
    expect(await plan(db, b)).toMatch(/structure does not match its migration history \(latest\)/)
    await applyMigration(db, '20261126000000_service_stats.sql')
    await db.exec(`drop function public.preview_guardian_invitation(text)`)                   // 18th migration's function gone
    expect(await plan(db, b)).toMatch(/structure does not match its migration history \(latest\)/)
    const { db: d17, b: b17 } = await lost17()
    await applyMigration(d17, '20261124000000_family_invite_accept.sql')                     // applied but not recorded
    expect(await plan(d17, b17)).toMatch(/structure does not match its migration history \(latest\)/)
  })
})
