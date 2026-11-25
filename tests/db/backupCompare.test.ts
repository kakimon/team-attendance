// scripts/ops/compare-backups.mjs on real databases: Phase 4-B data -> backup_tables.sql -> the 11 migrations
// -> backup_tables_latest.sql -> compare. Every existing row must be kept (SAME); a changed, added or removed row,
// or an added column / table that is not in its initial state, must be reported (DIFF).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, joinTeamAs, migrationFiles, type Db } from './setup'
// @ts-expect-error plain ESM script without type declarations
import { parseBackup } from '../../scripts/ops/build-restore-sql.mjs'
// @ts-expect-error plain ESM script without type declarations
import { ADDED_COLUMNS, compareBackups, PHASE4B_COLUMNS } from '../../scripts/ops/compare-backups.mjs'

const ops = (f: string) => readFileSync(join(import.meta.dirname, '../../scripts/ops', f), 'utf8')
const PHASE4B_END = '20261117000000' // first migration after Phase 4-B
const FN_ONLY = '20261124000000'      // function-only migration (family invitations): latest 17 -> 18
const U = (n: number) => `62000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [OW, AD, GU, SE, GONE, OUT] = [1, 2, 3, 4, 5, 6].map(U)

/** PGlite has no Supabase CLI: record the applied migrations like supabase_migrations.schema_migrations. */
async function record(db: Db, before?: string) {
  await db.exec(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, name text)`)
  const applied = new Set((await db.query<{ v: string }>(`select version v from supabase_migrations.schema_migrations`)).rows.map((r) => r.v))
  const latest = (await db.query<{ x: boolean }>(`select to_regclass('private.team_join_tokens') is not null x`)).rows[0]!.x
  for (const f of migrationFiles().filter((f) => (latest || f < PHASE4B_END) && (!before || f < before))) {
    if (!applied.has(f.slice(0, 14))) await db.query(`insert into supabase_migrations.schema_migrations values ($1, $2)`, [f.slice(0, 14), f.slice(15, -4)])
  }
}
const backupOf = async (db: Db, file: string) => parseBackup((await db.query<{ backup: any }>(ops(file))).rows[0]!.backup)
const r1 = async <T = any>(db: Db, u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<{ r: T }>(sql, p)).rows[0]!.r)

/** Fictitious Phase 4-B data touching all 9 tables (two teams, archived / deleted rows, a hand-over, a deletion record). */
async function seed4b(db: Db) {
  for (const u of [OW, AD, GU, SE, GONE, OUT]) await addUser(db, u)
  const t1 = (await asUser(db, OW, () => db.query<any>(`select id, share_token from public.create_team('比較テストA', '代表')`))).rows[0]
  const t2 = (await asUser(db, SE, () => db.query<any>(`select id, share_token from public.create_team('比較テストB', '別代表')`))).rows[0]
  await joinTeamAs(db, AD, t1.share_token, '管理者')
  await joinTeamAs(db, GU, t1.share_token, '保護者')
  await asUser(db, OW, () => db.query(`select public.set_member_role($1, $2, 'admin')`, [t1.id, AD]))
  const kid = await r1(db, GU, `select public.register_player($1, 'テスト はなこ', '2年') as r`, [t1.id])
  const kid2 = await r1(db, GU, `select public.register_player($1, 'テスト じろう', null) as r`, [t1.id])
  await asUser(db, GU, () => db.query(`select public.archive_player($1)`, [kid2.player_id]))
  const ev = await r1(db, OW, `select public.create_event($1, '練習', '2030-04-01T09:00:00Z', '公民館') as r`, [t1.id])
  const ev2 = await r1(db, OW, `select public.create_event($1, '中止の予定', '2030-04-08T09:00:00Z', null) as r`, [t1.id])
  await asUser(db, OW, () => db.query(`select public.delete_event($1)`, [ev2]))
  await asUser(db, GU, () => db.query(`select public.set_attendance($1, $2, 'attend', 'よろしく')`, [ev, kid.player_id]))
  const inv = await r1(db, GU, `select public.create_guardian_invitation($1) as r`, [kid.player_id])
  await asUser(db, AD, () => db.query(`select public.accept_guardian_invitation($1, '管理者')`, [inv.token]))
  const inv2 = await r1(db, GU, `select public.create_guardian_invitation($1) as r`, [kid.player_id])
  await asUser(db, GU, () => db.query(`select public.revoke_guardian_invitation($1)`, [inv2.id]))
  await asUser(db, OW, () => db.query(`select public.request_owner_transfer($1, $2)`, [t1.id, AD]))
  await db.query(`insert into private.account_deletions (user_id, attempts, last_error, last_error_at) values ($1, 2, 'test', now())`, [GONE])
  return { t1: t1.id as string, t2: t2.id as string, kid: kid.player_id as string, ev: ev as string }
}

/**
 * 4-B database with data, its backup, then the 11 Phase 6 migrations applied (recorded like `supabase db push`):
 * the production state (latest, 17). `all` also applies the later function-only migration (latest, 18).
 */
async function migrated(all = false) {
  const db = await createDb({ before: PHASE4B_END })
  await record(db)
  const s = await seed4b(db)
  const before = await backupOf(db, 'backup_tables.sql')
  const pending = migrationFiles().filter((f) => f >= PHASE4B_END && f < FN_ONLY)
  expect(pending).toHaveLength(11)
  for (const f of pending) await applyMigration(db, f)
  await record(db, FN_ONLY)
  if (all) {
    for (const f of migrationFiles().filter((f) => f >= FN_ONLY)) await applyMigration(db, f)
    await record(db)
  }
  return { db, s, before }
}
const lineOf = (r: { lines: string[] }, prefix: string) => r.lines.find((l) => l.startsWith(prefix)) ?? ''

describe('compare-backups.mjs: Phase 4-B -> 11 migrations -> latest', () => {
  it('SAME: every existing row of the 9 tables is kept; added columns and tables are in their initial state', async () => {
    const { db, before } = await migrated()
    for (const t of Object.keys(PHASE4B_COLUMNS)) expect(before[t].length, t).toBeGreaterThan(0)   // all 9 tables have rows
    const after = await backupOf(db, 'backup_tables_latest.sql')
    expect(after.kind).toBe('latest')
    expect(after.migrations).toEqual(migrationFiles().filter((f) => f < FN_ONLY).map((f) => f.slice(0, 14)))   // 17, by ID and order
    // the initial values come from the database, not from the script: confirm them directly
    const tm = (await db.query<any>(`select suspended_at, access_revision from public.team_members`)).rows
    expect(tm.length).toBeGreaterThan(0)
    expect(tm.every((r) => r.suspended_at === null && Number(r.access_revision) === 0)).toBe(true)   // 0, not NULL
    const pl = (await db.query<any>(`select is_self, self_user_id from public.players`)).rows
    expect(pl.every((r) => r.is_self === false && r.self_user_id === null)).toBe(true)
    expect(after.team_join_tokens).toHaveLength(2)
    expect(after.team_member_blocks).toHaveLength(0)

    const r = compareBackups(before, after)
    expect(r.errors).toEqual([])
    expect(r.same).toBe(true)
    for (const t of Object.keys(PHASE4B_COLUMNS)) expect(lineOf(r, t + ' ')).toMatch(/added 0 \| removed 0 \| changed 0$/)
    expect(lineOf(r, 'initial team_members.access_revision')).toMatch(/= 0: (\d+)\/\1$/)
    expect(lineOf(r, 'initial team_join_tokens')).toMatch(/2 row\(s\) for 2 team\(s\).*yes/)
    // nothing personal is printed: no names, ids or tokens in any line
    const text = r.lines.join('\n')
    for (const v of ['比較テスト', 'テスト はなこ', '公民館', 'よろしく', OW, AD, after.team_join_tokens[0].token]) expect(text).not.toContain(v)
  })

  it('DIFF: one changed value is detected (table and column named, value not shown)', async () => {
    const { db, s, before } = await migrated()
    await db.query(`update public.attendance set comment = '変更' where event_id = $1 and player_id = $2`, [s.ev, s.kid])
    const r = compareBackups(before, await backupOf(db, 'backup_tables_latest.sql'))
    expect(r.same).toBe(false)
    expect(lineOf(r, 'attendance ')).toMatch(/changed 1 \(columns: comment\)/)
    expect(r.lines.join('\n')).not.toContain('変更')
  })

  it('DIFF: an added row and a removed row are detected', async () => {
    const { db, s, before } = await migrated()
    await r1(db, OW, `select public.create_event($1, '追加', '2030-05-01T09:00:00Z', null) as r`, [s.t1])
    await db.query(`delete from public.team_owner_transfers where team_id = $1`, [s.t1])
    const r = compareBackups(before, await backupOf(db, 'backup_tables_latest.sql'))
    expect(r.same).toBe(false)
    expect(lineOf(r, 'events ')).toMatch(/added 1 \| removed 0 \| changed 0/)
    expect(lineOf(r, 'team_owner_transfers ')).toMatch(/added 0 \| removed 1 \| changed 0/)
  })

  it('DIFF: added columns / tables not in their initial state (a stop, a NULL revision, a block, a missing token)', async () => {
    const { db, s, before } = await migrated()
    await db.query(`update public.team_members set access_revision = null where user_id = $1`, [GU])
    await db.query(`insert into private.team_member_blocks (team_id, user_id) values ($1, $2)`, [s.t1, OUT])
    await db.query(`delete from private.team_join_tokens where team_id = $1`, [s.t2])
    const r = compareBackups(before, await backupOf(db, 'backup_tables_latest.sql'))
    expect(r.same).toBe(false)
    for (const t of Object.keys(PHASE4B_COLUMNS)) expect(lineOf(r, t + ' ')).toMatch(/added 0 \| removed 0 \| changed 0$/)   // the 4-B part is intact
    expect(lineOf(r, 'initial team_members.access_revision')).toMatch(/1 differ/)
    expect(lineOf(r, 'initial team_member_blocks')).toMatch(/1 row/)
    expect(lineOf(r, 'initial team_join_tokens')).toMatch(/NO$/)
  })

  it('refuses files that cannot be compared: wrong kinds, a column missing or unexpected, duplicate keys', async () => {
    const { db, before } = await migrated()
    const after = await backupOf(db, 'backup_tables_latest.sql')
    expect(compareBackups(after, before).errors.join()).toMatch(/after must be a latest backup when before is latest/)
    const noCol = structuredClone(after); delete noCol.events[0].note
    expect(compareBackups(before, noCol).errors.join()).toMatch(/after events: column note is missing/)
    const noAdded = structuredClone(after); delete noAdded.team_members[0].access_revision
    expect(compareBackups(before, noAdded).errors.join()).toMatch(/added column access_revision is missing/)
    const extra = structuredClone(after); extra.teams[0].surprise = 1
    expect(compareBackups(before, extra).errors.join()).toMatch(/after teams: unexpected column surprise/)
    const dup = structuredClone(after); dup.players.push(structuredClone(dup.players[0])); dup.counts.players++
    expect(compareBackups(before, dup).errors.join()).toMatch(/after players: duplicate primary key/)
    // a 4-B "after" may not carry the added columns
    const b4 = structuredClone(before); b4.team_members[0].access_revision = 0
    expect(compareBackups(before, b4).errors.join()).toMatch(/after team_members: unexpected column access_revision/)
  })

  it('the column lists match the migrations exactly (4-B tables and the columns the 11 migrations add)', async () => {
    const cols = async (db: Db, schema: string, t: string) => (await db.query<{ c: string }>(
      `select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`, [schema, t])).rows.map((r) => r.c)
    const b4 = await createDb({ before: PHASE4B_END })
    const latest = await createDb()
    for (const t of Object.keys(PHASE4B_COLUMNS)) {
      const schema = t === 'account_deletions' ? 'private' : 'public'
      expect(await cols(b4, schema, t), t).toEqual(PHASE4B_COLUMNS[t])
      expect(await cols(latest, schema, t), t).toEqual([...PHASE4B_COLUMNS[t], ...(ADDED_COLUMNS[t] ?? [])])
    }
  })
})

describe('compare-backups.mjs: latest 17 -> latest 18 (the function-only family-invitation migration)', () => {
  /** Production state (17) with data, its latest backup, then 20261124000000 applied (18). */
  async function around() {
    const { db, s, before: b4 } = await migrated()
    const before = await backupOf(db, 'backup_tables_latest.sql')
    for (const f of migrationFiles().filter((f) => f >= FN_ONLY)) await applyMigration(db, f)
    await record(db)
    return { db, s, b4, before }
  }

  it('SAME: all 11 tables, every column, unchanged; the difference is only the function-only migration', async () => {
    const { db, before } = await around()
    const after = await backupOf(db, 'backup_tables_latest.sql')
    expect(after.migrations).toEqual([...before.migrations, FN_ONLY])
    const r = compareBackups(before, after)
    expect(r.errors).toEqual([])
    expect(r.same).toBe(true)
    for (const t of [...Object.keys(PHASE4B_COLUMNS), 'team_join_tokens', 'team_member_blocks']) expect(lineOf(r, t + ' '), t).toMatch(/added 0 \| removed 0 \| changed 0$/)
    expect(lineOf(r, 'migrations ')).toMatch(/17 -> 18 \(latest; function-only: 20261124000000\)/)
    expect(r.lines.join('\n')).not.toContain(after.team_join_tokens[0].token)
  })

  it('DIFF: a data change in any table is still reported (including the latest-only tables and added columns)', async () => {
    const { db, s, before } = await around()
    await db.query(`update public.team_members set access_revision = 5 where user_id = $1`, [GU])
    await db.query(`update private.team_join_tokens set token = repeat('z', 40) where team_id = $1`, [s.t2])
    const r = compareBackups(before, await backupOf(db, 'backup_tables_latest.sql'))
    expect(r.errors).toEqual([])
    expect(r.same).toBe(false)
    expect(lineOf(r, 'team_members ')).toMatch(/changed 1 \(columns: access_revision\)/)
    expect(lineOf(r, 'team_join_tokens ')).toMatch(/changed 1 \(columns: token\)/)
    expect(r.lines.join('\n')).not.toContain('z'.repeat(40))
  })

  it('refused (not compared): reversed order, an unknown or missing migration, a reordered list, a 4-B after', async () => {
    const { db, b4, before } = await around()
    const after = await backupOf(db, 'backup_tables_latest.sql')
    expect(compareBackups(after, before).errors.join()).toMatch(/not before plus function-only migrations/)          // 18 -> 17
    const unknown = { ...after, migrations: [...after.migrations, '20991231000000'] }
    expect(compareBackups(before, unknown).errors.join()).toMatch(/after: 19 migrations, not a known latest state/)
    const gap = { ...after, migrations: after.migrations.filter((v: string) => v !== '20261118210000') }
    expect(compareBackups(before, gap).errors.join()).toMatch(/after: 17 migrations, not a known latest state/)     // 17 by count, wrong IDs
    const reordered = { ...after, migrations: [...after.migrations.slice(0, -2), FN_ONLY, after.migrations.at(-2)] }
    expect(compareBackups(before, reordered).errors.join()).toMatch(/not a known latest state/)
    expect(compareBackups(before, b4).errors.join()).toMatch(/after must be a latest backup when before is latest/)
    // 4-B -> 18 is still compared the 4-B way (the 4-B part kept, added columns / tables in their initial state)
    expect(compareBackups(b4, after).errors).toEqual([])
  })
})
