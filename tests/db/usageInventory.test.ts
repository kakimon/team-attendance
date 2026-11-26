// scripts/ops/usage-inventory.sql: read-only, counts only, and a success marker that appears ONLY when
// every section 0-6 was counted (Phase 4-B and the latest schema; real migrations in PGlite).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, migrationFiles, type Db } from './setup'

const SQL = readFileSync(join(import.meta.dirname, '../../scripts/ops/usage-inventory.sql'), 'utf8')
const OK = 'USAGE_REPORT_COMPLETE sections=7/7'
const U1 = '62000000-0000-4000-8000-000000000001', U2 = '62000000-0000-4000-8000-000000000002'

/** The parts of Supabase's schemas the report reads and the PGlite stub lacks. */
async function db(before?: string) {
  const d = await createDb(before ? { before } : {})
  await d.exec(`alter table auth.users add column email text, add column created_at timestamptz default now(), add column last_sign_in_at timestamptz;
    alter table auth.sessions add column updated_at timestamptz default now();
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), provider text);
    create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key);`)
  for (const f of migrationFiles().filter((f) => !before || f < before)) await d.query(`insert into supabase_migrations.schema_migrations values ($1)`, [f.slice(0, 14)])
  for (const u of [U1, U2]) {
    await addUser(d, u)
    await d.query(`update auth.users set email = $2, last_sign_in_at = now() where id = $1`, [u, `secret-${u.slice(-1)}@example.test`])
    await d.query(`insert into auth.identities (user_id, provider) values ($1, 'google')`, [u])
  }
  const [t] = (await asUser(d, U1, () => d.query<any>(`select id, share_token from public.create_team('秘密のチーム', '秘密の代表')`))).rows
  return { d, t }
}
const run = (d: Db) => d.exec(SQL).then(() => 'NO ERROR', (e: Error) => e.message)
const hash = async (d: Db) => (await d.query<{ h: string }>(`select md5(coalesce(string_agg(to_jsonb(x)::text, '|'), '')) h from public.teams x`)).rows[0]!.h

describe('usage-inventory.sql', () => {
  // latest 17 / 18 / 19 = before and after the two function-only migrations (the count is printed as is)
  for (const [label, before] of [['Phase 4-B', '20261117000000'], ['latest 17', '20261124000000'], ['latest 18', '20261126000000'], ['latest 19', undefined]] as const) {
    it(`${label}: all sections counted -> ends with the success marker; nothing changed; no names, e-mails, ids or tokens`, async () => {
      const { d, t } = await db(before)
      const h = await hash(d)
      const out = await run(d)
      expect(out.startsWith('USAGE_REPORT（読み取り専用・ロールバック済み）')).toBe(true)
      expect(out.split('\n').at(-1)).toBe(OK)
      for (const s of ['== 0.', '== 1.', '== 2.', '== 3.', '== 4.', '== 5.', '== 6.']) expect(out).toContain(s)
      const applied = migrationFiles().filter((f) => !before || f < before)
      expect(out).toContain(`migrations applied: ${applied.length}`)
      expect(out).toContain(`migration versions: ${applied.map((f) => f.slice(0, 14)).join(' ')}`)
      expect(applied.length).toBe({ 'Phase 4-B': 6, 'latest 17': 17, 'latest 18': 18, 'latest 19': 19 }[label])
      for (const secret of [U1, U2, U1.slice(0, 8), t.id, t.share_token, 'secret-', '@', '秘密']) expect(out).not.toContain(secret)
      expect(out).toContain('registrations 0 (cancelled 0)')
      expect(await hash(d)).toBe(h)
    })
  }

  it('an item that cannot be counted -> INCOMPLETE marker, never the success marker', async () => {
    const { d } = await db('20261117000000')
    await d.exec(`drop table auth.identities`)
    const out = await run(d)
    expect(out).toContain('auth.identities: n/a')
    expect(out.split('\n').at(-1)).toBe('USAGE_REPORT_INCOMPLETE unavailable=1')
    expect(out).not.toContain(OK)
  })

  it('an unexpected error stops everything: no report, no marker (cannot be mistaken for success)', async () => {
    const { d, t } = await db('20261117000000')
    await asUser(d, U1, () => d.query(`select public.create_event($1, '練習', '2030-01-01T00:00:00Z')`, [t.id]))
    await d.exec(`create function public.boom() returns boolean language plpgsql as $$ begin raise exception 'unexpected failure'; end $$;
      alter table public.events rename to events_real;
      create view public.events as select * from public.events_real where public.boom();`)
    const out = await run(d)
    expect(out).toMatch(/unexpected failure/)
    expect(out).not.toContain('USAGE_REPORT')
  })

  it('the transaction is read-only: a write in the same block is refused', async () => {
    const { d } = await db()
    const probe = SQL.replace("r := r || E'\\n== 1. Auth';", "insert into public.teams (name, created_by) values ('x', '" + U1 + "'); r := r || E'\\n== 1. Auth';")
    expect(probe).not.toBe(SQL)
    expect(await d.exec(probe).then(() => 'NO ERROR', (e: Error) => e.message)).toMatch(/read-only transaction/)
  })
})
