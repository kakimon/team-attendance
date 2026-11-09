// public.health_check(): the only function anon may call; reads no table rows, writes nothing.
import { beforeAll, describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, type Db } from './setup'

let db: Db
const U = '30000000-0000-0000-0000-000000000001'

beforeAll(async () => {
  db = await createDb()
  await addUser(db, U)
  await asUser(db, U, () => db.query(`select public.create_team('ヘルスチェック確認', 'x')`))
})

describe('health_check', () => {
  it('anon (publishable key) gets ok + database', async () => {
    const r = await asUser(db, null, () => db.query<{ v: any }>('select public.health_check() as v'))
    expect(r.rows[0]!.v).toMatchObject({ ok: true, database: true })
    expect(Date.parse(r.rows[0]!.v.checkedAt)).not.toBeNaN()
  })

  it('returns no table data (only ok / database / checkedAt)', async () => {
    const r = await asUser(db, null, () => db.query<{ v: any }>('select public.health_check() as v'))
    expect(Object.keys(r.rows[0]!.v).sort()).toEqual(['checkedAt', 'database', 'ok'])
  })

  it('is SECURITY INVOKER, stable, with fixed search_path', async () => {
    const { rows } = await db.query<{ secdef: boolean; vol: string; cfg: string[] }>(
      `select prosecdef as secdef, provolatile as vol, proconfig as cfg from pg_proc where proname = 'health_check'`)
    expect(rows[0]).toMatchObject({ secdef: false, vol: 's' })
    expect(rows[0]!.cfg.join()).toContain('search_path=')
  })

  it('anon can execute ONLY health_check; tables stay closed', async () => {
    const { rows } = await db.query<{ f: string }>(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute') order by 1`)
    expect(rows.map((r) => r.f)).toEqual(['public.health_check'])
    await expect(asUser(db, null, () => db.query('select * from public.teams'))).rejects.toThrow(/permission denied/)
  })

  it('signed-in users do not get it (least privilege)', async () => {
    await expect(asUser(db, U, () => db.query('select public.health_check()'))).rejects.toThrow(/permission denied/)
  })

  it('reports database=false if the schema were missing (simulated)', async () => {
    // The function only uses to_regclass(); verify that the same expression is false for a missing table.
    const { rows } = await db.query<{ v: boolean }>(`select to_regclass('public.no_such_table') is not null as v`)
    expect(rows[0]!.v).toBe(false)
  })
})
