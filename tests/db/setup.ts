// Minimal stand-in for Supabase's auth schema + roles, so the real migration
// can run inside PGlite (in-process Postgres) with no network or Docker.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key);
grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
`

const MIGRATIONS = join(import.meta.dirname, '../../supabase/migrations')
export const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()

/** Fresh DB with the Supabase stub and migrations applied (optionally only those before `before`). */
export async function createDb(opts: { before?: string } = {}) {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles().filter((f) => !opts.before || f < opts.before)) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
  }
  return db
}

export async function applyMigration(db: PGlite, file: string) {
  await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
}

export type Db = Awaited<ReturnType<typeof createDb>>

export async function addUser(db: Db, id: string) {
  await db.query('insert into auth.users (id) values ($1)', [id])
}

/** Run a callback as an authenticated browser user (or anon when uid is null). */
export async function asUser<T>(db: Db, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec(`reset role`)
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}
