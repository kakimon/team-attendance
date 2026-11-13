// Runs scripts/verify-cloud-phase4b.sql (the rollback-only cloud check) in PGlite:
// it must report 0 problems and leave every row exactly as it was.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { addUser, asUser, createDb } from './setup'

it('Phase 4-B cloud check passes and rolls everything back', async () => {
  const db = await createDb()
  const [O, G, M] = ['31000000-0000-4000-8000-00000000000a', '31000000-0000-4000-8000-00000000000b', '31000000-0000-4000-8000-00000000000c']
  for (const u of [O, G, M]) await addUser(db, u)
  const q = (u: string, sql: string, p: unknown[] = []) => asUser(db, u, async () => (await db.query<any>(sql, p)).rows)
  const [t] = await q(O, `select id, share_token from public.create_team('どこかのチーム', 'O')`)
  for (const u of [G, M]) await q(u, `select public.join_team($1, 'm')`, [t.share_token])
  const [{ id: ev }] = await q(O, `select public.create_event($1, '練習', now() + interval '1 day') as id`, [t.id])
  const kid = (await q(G, `select public.register_player($1, 'こども', null, true) as r`, [t.id]))[0].r.player_id
  await q(G, `select public.set_attendance($1, $2, 'attend')`, [ev, kid])
  const snap = async () => (await db.query<{ h: string }>(`select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.players x),
    (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.events x),
    (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.attendance x),
    (select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.guardian_invitations x),
    (select count(*) from auth.sessions)::text)) h`)).rows[0]!.h
  const before = await snap()
  const sql = readFileSync(join(import.meta.dirname, '../../scripts/verify-cloud-phase4b.sql'), 'utf8')
  const err = await db.exec(sql).then(() => null, (e: Error) => e.message)
  expect(err).toMatch(/^VERIFY_RESULT（全てロールバック済み） problems=0 /)
  expect(err).not.toContain('★')
  expect(await snap()).toBe(before)
  console.log(err)
})
