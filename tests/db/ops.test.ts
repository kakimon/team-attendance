// Operations safety for applying Phase 4-A to the cloud DB:
// snapshot comparability, JSON backup -> restore, and the rollback SQL.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, applyMigration, asUser, createDb, type Db } from './setup'

const ops = (f: string) => readFileSync(join(import.meta.dirname, '../../scripts/ops', f), 'utf8')
const A = '60000000-0000-0000-0000-00000000000a'
const B = '60000000-0000-0000-0000-00000000000b'
const C = '60000000-0000-0000-0000-00000000000c'

async function seed(db: Db) {
  for (const u of [A, B, C]) await addUser(db, u)
  const [team] = (await asUser(db, A, () => db.query<any>(`select id, share_token from public.create_team('運用テスト', '代表')`))).rows
  await asUser(db, A, () => db.query(`select public.create_event($1, '練習', '2030-03-01T09:00:00Z', '公民館')`, [team.id]))
  await asUser(db, B, () => db.query(`select public.join_team($1, 'B')`, [team.share_token]))
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
})

describe('backup (scripts/ops/backup_tables.sql) and restore', () => {
  it('a pre-4-A JSON backup restores into a 4-A database with identical hashes', async () => {
    const src = await createDb({ before: '20261110000000' })
    await seed(src)
    const [{ backup }] = (await src.query<{ backup: any }>(ops('backup_tables.sql'))).rows
    const expected = await snapshot(src)

    const dst = await createDb() // all migrations incl. 4-A, empty tables
    for (const u of [A, B, C]) await addUser(dst, u) // auth users exist in the real project
    for (const t of ['teams', 'team_members', 'players', 'player_guardians', 'events', 'attendance', 'guardian_invitations']) {
      await dst.query(
        `insert into public.${t} select * from jsonb_populate_recordset(null::public.${t}, $1::jsonb) on conflict do nothing`,
        [JSON.stringify(backup[t])])
    }
    expect(await snapshot(dst)).toEqual(expected)
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
    expect(anon.map((r) => r.f)).toEqual(['health_check'])
    // data kept (only the attendance status changed by the call above)
    const after = await snapshot(db)
    for (const t of ['teams', 'team_members', 'players', 'player_guardians', 'events', 'guardian_invitations']) {
      expect(after.find((r) => r.tbl === t)).toEqual(before.find((r) => r.tbl === t))
    }
  })
})
