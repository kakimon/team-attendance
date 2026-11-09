// Runs scripts/verify-cloud-server-deny.sql (the script used against the cloud dev DB)
// in PGlite: it must report only denials/expected successes and leave no data behind.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { addUser, asUser, createDb } from './setup'

it('cloud verification script passes and rolls everything back', async () => {
  const db = await createDb()
  const [A, B, C] = ['20000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000c']
  for (const u of [A, B, C]) await addUser(db, u)
  const team = await asUser(db, A, async () => (await db.query<{ id: string; share_token: string }>(
    `select id, share_token from public.create_team('テストFC', 'テスト監督')`)).rows[0]!)
  await asUser(db, A, () => db.query(`select public.create_event($1, '練習', now() + interval '1 day')`, [team.id]))
  await asUser(db, A, () => db.query(`select public.register_player($1, 'テスト　太郎')`, [team.id]))
  await asUser(db, B, () => db.query(`select public.join_team($1, 'test2')`, [team.share_token]))
  const count = async () => (await db.query<{ n: string }>(
    `select (select count(*) from public.players) + (select count(*) from public.guardian_invitations)
      + (select count(*) from public.attendance) + (select count(*) from public.player_guardians) as n`)).rows[0]!.n
  const before = await count()

  const sql = readFileSync(join(import.meta.dirname, '../../scripts/verify-cloud-server-deny.sql'), 'utf8')
  const err = await db.exec(sql).then(() => null, (e: Error) => e.message)
  expect(err).toMatch(/^VERIFY_RESULT/)
  expect(err).not.toContain('★')
  expect(err!.match(/拒否/g)!.length).toBe(10)
  expect(await count()).toBe(before) // nothing persisted
  console.log(err)
})
