// Minimal stand-in for Supabase's auth schema + roles, so the real migration
// can run inside PGlite (in-process Postgres) with no network or Docker.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now());
grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid() to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
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

/** Adds a user with one login session whose id equals the user id (the default token session). */
export async function addUser(db: Db, id: string) {
  await db.query('insert into auth.users (id) values ($1)', [id])
  await db.query('insert into auth.sessions (id, user_id) values ($1, $1)', [id])
}

/**
 * Run a callback as an authenticated browser user (or anon when uid is null).
 * The token carries `sub` and `session_id` like a Supabase access token
 * (session defaults to the user's default session from addUser).
 */
export async function asUser<T>(db: Db, uid: string | null, fn: () => Promise<T>, session: string | null = uid): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  const claims = uid ? JSON.stringify({ sub: uid, role: 'authenticated', ...(session ? { session_id: session } : {}) }) : ''
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`, [uid ?? '', claims])
  try {
    return await fn()
  } finally {
    await db.exec(`reset role`)
    await db.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)`)
  }
}

/** The database has the D5 migration (old share-token join path closed). */
export async function legacyJoinClosed(db: Db): Promise<boolean> {
  return (await db.query<{ x: boolean }>(
    `select exists (select 1 from pg_proc where oid = to_regprocedure('public.join_team(text,text)') and prosrc like '%legacy_join_disabled%') x`)).rows[0]!.x
}

/**
 * Test helper: `uid` joins the team that has `shareToken`, the way the database under test allows.
 *  - before D5: the old path, public.join_team(share_token) (as it really worked at that point)
 *  - from D5 on: the team's join link, exactly like the app: an active owner/admin reads it with
 *    get_join_link, then `uid` calls join_by_token (every permission / limit / block check applies).
 * Returns the team id; refusals throw like the real RPCs ('join_link_invalid' for an unusable link).
 */
export async function joinTeamAs(db: Db, uid: string, shareToken: string, displayName: string): Promise<string> {
  if (!(await legacyJoinClosed(db))) {
    return asUser(db, uid, async () => (await db.query<{ id: string }>('select public.join_team($1, $2) as id', [shareToken, displayName])).rows[0]!.id)
  }
  const team = (await db.query<{ id: string }>('select id from public.teams where share_token = $1', [shareToken])).rows[0]
  if (!team) throw new Error('team_not_found')
  const hasSuspension = (await db.query<{ x: boolean }>(`select exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'team_members' and column_name = 'suspended_at') x`)).rows[0]!.x
  const manager = (await db.query<{ user_id: string }>(`select user_id from public.team_members where team_id = $1
    and role in ('owner', 'admin') ${hasSuspension ? 'and suspended_at is null' : ''} order by role = 'owner' desc, joined_at limit 1`, [team.id])).rows[0]
  if (!manager) throw new Error('no owner/admin to read the join link')
  const link = await asUser(db, manager.user_id, async () =>
    (await db.query<{ r: { token: string | null } }>('select public.get_join_link($1) as r', [team.id])).rows[0]!.r)
  if (!link.token) throw new Error('join_link_invalid')
  const r = await asUser(db, uid, async () =>
    (await db.query<{ r: { status: string; team_id?: string } }>('select public.join_by_token($1, $2) as r', [link.token, displayName])).rows[0]!.r)
  if (r.status === 'invalid' || !r.team_id) throw new Error('join_link_invalid')
  return r.team_id
}
