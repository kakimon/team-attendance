// scripts/deletion-target-check.sql (read-only cloud check) must report the target's footprint
// and the server preview, show the protected team only as counts, and change nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { addUser, asUser, createDb, joinTeamAs } from './setup'

it('reports the deletion preview for the test account and leaves everything unchanged', async () => {
  const db = await createDb()
  const [K, I, Y] = ['41000000-0000-4000-8000-00000000000a', '41000000-0000-4000-8000-00000000000b', '41000000-0000-4000-8000-00000000000c']
  for (const u of [K, I, Y]) await addUser(db, u)
  const q = (u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<any>(sql, p)).rows)
  const [t] = await q(K, `select id, share_token from public.create_team('テストチーム', 'test-account')`)
  await joinTeamAs(db, I, t.share_token, 'imagimo')
  const shared = (await q(I, `select public.register_player($1, 'T2テスト共有', null, true) as r`, [t.id]))[0].r.player_id
  const [{ r: inv }] = await q(I, `select public.create_guardian_invitation($1) as r`, [shared])
  await q(K, `select public.accept_guardian_invitation($1, 'test-account')`, [inv.token])
  await q(K, `select public.register_player($1, 'T3', null, true)`, [t.id])
  const [y] = await q(Y, `select id, share_token from public.create_team('サンプルFC', 'owner')`)
  await q(Y, `select public.register_player($1, 'サンプルの子', null, true)`, [y.id])
  const fp = async () => (await db.query<{ h: string }>(`select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.team_members x),
    (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.player_guardians x),
    (select count(*) from auth.users)::text)) h`)).rows[0]!.h
  const before = await fp()
  const sql = readFileSync(join(import.meta.dirname, '../../scripts/deletion-target-check.sql'), 'utf8')
  const err = await db.exec(sql).then(() => null, (e: Error) => e.message)
  expect(err).toMatch(/^CHECK_RESULT/)
  expect(err).toContain('rows inside サンプルFC referencing it (must be 0): 0')
  expect(err).toContain('teams_to_hand_over: (テストチーム)')
  expect(err).toContain('children_to_delete: T3 (テストチーム, answers 0)')
  expect(err).toContain('children_kept_by_family: T2テスト共有 (テストチーム)')
  expect(err).not.toContain('サンプルの子')                       // protected team: counts only
  expect(err).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)            // no uuids
  expect(await fp()).toBe(before)
})
