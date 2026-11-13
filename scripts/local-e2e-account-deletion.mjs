// End-to-end check of self-service account deletion against the LOCAL Supabase stack only
// (real Postgres, Auth and Edge runtime in Docker). Never point this at a cloud project.
//
//   supabase start
//   supabase status -o env > /tmp/local.env      # local dev keys, not secrets of any project
//   node scripts/local-e2e-account-deletion.mjs /tmp/local.env
//
// Creates throwaway users (*@example.test) and data in the local DB; prints only PASS/FAIL lines.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createClient } = require('@supabase/supabase-js')
// Realtime is not used here; Node 20 has no WebSocket, so give supabase-js a dummy one.
globalThis.WebSocket ??= class {}

const env = Object.fromEntries(readFileSync(process.argv[2], 'utf8').split('\n')
  .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const API = env.API_URL
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API ?? '')) throw new Error('refusing: API_URL is not a local stack')
const ANON = env.ANON_KEY
const SERVICE = env.SERVICE_ROLE_KEY
const DB_CONTAINER = 'supabase_db_team-attendance'
const FN = `${API}/functions/v1/delete-account`

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`)
}
const sql = (q) => execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim()
const admin = createClient(API, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const run = Date.now().toString(36)
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())

/** A user with a password login (stand-in for Google; both create an auth.sessions row). */
async function newUser(tag) {
  const email = `${tag}-${run}@example.test`
  const password = `pw-${run}-${Math.random().toString(36).slice(2)}`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const u = { id: data.user.id, email, password }
  await login(u)
  return u
}
async function login(u) {
  const c = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password })
  if (error) throw error
  u.client = c
  u.token = data.session.access_token
  u.refresh = data.session.refresh_token
  u.session = claims(u.token).session_id
  return u
}
/** Same parsing as app/plugins/data.client.ts. */
async function invokeAs(u, body, headers = {}) {
  const { data, error } = await u.client.functions.invoke('delete-account', { body, headers })
  if (!error) return { ok: true, data }
  const res = error.context
  const code = res instanceof Response ? await res.json().then((j) => j?.code ?? 'unknown', () => 'unknown') : 'unknown'
  return { ok: false, status: res?.status, code }
}
const rpc = async (u, fn, args = {}) => {
  const { data, error } = await u.client.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}
const authExists = (id) => sql(`select count(*) from auth.users where id = '${id}'`) === '1'
const ownersOf = (team) => sql(`select string_agg(user_id::text, ',') from public.team_members where team_id = '${team}' and role = 'owner'`)

// ---------- scenario: owner A, members B and C; B's child shared with C; B's own child; A's child
const A = await newUser('owner'), B = await newUser('parent-b'), C = await newUser('parent-c')
const team = await rpc(A, 'create_team', { p_name: `E2E ${run}`, p_display_name: 'A' })
for (const [u, n] of [[B, 'B'], [C, 'C']]) await rpc(u, 'join_team', { p_share_token: team.share_token, p_display_name: n })
const ev = await rpc(A, 'create_event', { p_team_id: team.id, p_title: '練習', p_starts_at: new Date(Date.now() + 864e5).toISOString() })
const shared = (await rpc(B, 'register_player', { p_team_id: team.id, p_name: '共有 たろう', p_note: null, p_confirm_similar: true })).player_id
const onlyB = (await rpc(B, 'register_player', { p_team_id: team.id, p_name: 'Bだけ じろう', p_note: null, p_confirm_similar: true })).player_id
const childA = (await rpc(A, 'register_player', { p_team_id: team.id, p_name: 'Aの子', p_note: null, p_confirm_similar: true })).player_id
const inv = await rpc(B, 'create_guardian_invitation', { p_player_id: shared })
await rpc(C, 'accept_guardian_invitation', { p_token: inv.token, p_display_name: 'C' })
await rpc(B, 'set_attendance', { p_event_id: ev, p_player_id: shared, p_status: 'attend', p_comment: null })
await rpc(B, 'set_attendance', { p_event_id: ev, p_player_id: onlyB, p_status: 'absent', p_comment: null })
await rpc(A, 'set_attendance', { p_event_id: ev, p_player_id: childA, p_status: 'attend', p_comment: null })
const othersBefore = sql(`select md5(string_agg(player_id::text || status, ',' order by player_id)) from public.attendance where player_id <> '${onlyB}'`)

console.log('--- logout: the old access token can neither read nor write (before it expires)')
{
  const L = await newUser('logout')
  const lt = await rpc(L, 'create_team', { p_name: `logout ${run}`, p_display_name: 'L' })
  await rpc(L, 'register_player', { p_team_id: lt.id, p_name: 'ログアウト確認', p_note: null, p_confirm_similar: true })
  const tokenBefore = L.token
  const asToken = (t) => createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } })
  const before = await asToken(tokenBefore).from('players').select('id')
  check('logged in: sees own child', before.data?.length === 1, JSON.stringify(before))
  await L.client.auth.signOut({ scope: 'local' })                                   // this device logs out
  const old = asToken(tokenBefore)
  check('token not expired yet', claims(tokenBefore).exp * 1000 > Date.now())
  const seen = []
  for (const tb of ['teams', 'team_members', 'players', 'player_guardians', 'events', 'attendance', 'guardian_invitations', 'team_owner_transfers']) {
    // guardian_invitations: the browser may read only some columns (never token_hash), so no '*'
    const r = await old.from(tb).select(tb === 'guardian_invitations' ? 'id,player_id,expires_at' : '*')
    if (r.error || r.data.length) seen.push(`${tb}:${r.error ? r.error.message : r.data.length}`)
  }
  check('after logout: 0 rows from all 8 tables', seen.length === 0, seen.join(' '))
  const pv = await old.rpc('account_deletion_preview')
  check('after logout: read RPC refused (session_expired)', /session_expired/.test(pv.error?.message ?? ''), JSON.stringify(pv.error))
  const w = await old.rpc('create_team', { p_name: 'x', p_display_name: 'x' })
  check('after logout: write RPC refused (session_expired)', /session_expired/.test(w.error?.message ?? ''))
  const fr = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${tokenBefore}` }, body: '{"confirm":"退会する"}' })
  check('after logout: delete-account refused, user kept', [401, 409].includes(fr.status) && authExists(L.id), String(fr.status))
  await login(L)
  check('logging in again: reads work again', (await rpc(L, 'account_deletion_preview')).teams_to_close.length === 1)

  // A token whose payload was edited (sub of someone else) keeps the old signature -> invalid.
  const [h, , sig] = L.token.split('.')
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims(L.token), sub: A.id })).toString('base64url')}.${sig}`
  const ff = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${forged}` }, body: '{"confirm":"退会する"}' })
  check('forged token (other user id) -> 401, nobody deleted', ff.status === 401 && authExists(A.id) && authExists(L.id), String(ff.status))
  const fr2 = await asToken(forged).from('players').select('id')
  check('forged token is also refused by the REST API', !!fr2.error || fr2.data.length === 0)
  // Expired token: only constructible when the local stack signs with the shared HS256 secret.
  const header = JSON.parse(Buffer.from(h, 'base64url').toString())
  if (header.alg === 'HS256' && env.JWT_SECRET) {
    const { createHmac } = await import('node:crypto')
    const body = Buffer.from(JSON.stringify({ ...claims(L.token), exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')
    const expired = `${h}.${body}.${createHmac('sha256', env.JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`
    const fe = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${expired}` }, body: '{"confirm":"退会する"}' })
    check('expired token (validly signed) -> 401, user kept', fe.status === 401 && authExists(L.id), String(fe.status))
  } else {
    console.log(`info  expired-token check skipped (local tokens use ${header.alg}); covered by the Auth server + Deno unit test`)
  }
}

console.log('--- identity / request validation')
let r = await invokeAs(B, { confirm: '退会する', user_id: A.id })
check('body with another user id is refused (400 unexpected_field)', !r.ok && r.code === 'unexpected_field', JSON.stringify(r))
check('...and A still exists', authExists(A.id))
r = await invokeAs(B, { confirm: 'はい' })
check('wrong confirmation text refused', !r.ok && r.code === 'confirm_required', JSON.stringify(r))
let res = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: '{"confirm":"退会する"}' })
check('no token -> 401', res.status === 401, String(res.status))
res = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` }, body: '{"confirm":"退会する"}' })
check('anon key as token -> 401', res.status === 401, String(res.status))
// The local gateway (Kong) answers preflight itself and rewrites Access-Control-Allow-Origin to '*',
// so the function's CORS headers are covered by its Deno unit tests; here we check the server-side refusal.
res = await fetch(FN, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', Authorization: `Bearer ${B.token}` }, body: '{"confirm":"退会する"}' })
check('POST from an unknown site is refused by the function (403), nothing deleted',
  res.status === 403 && (await res.json()).code === 'origin_not_allowed' && authExists(B.id))
res = await fetch(FN, { method: 'POST', headers: { Origin: 'https://kakimon.github.io.evil.example', 'Content-Type': 'application/json', Authorization: `Bearer ${B.token}` }, body: '{"confirm":"退会する"}' })
check('look-alike origin refused (403)', res.status === 403)

console.log('--- re-authentication')
sql(`update auth.sessions set created_at = now() - interval '20 minutes' where id = '${B.session}'`)
r = await invokeAs(B, { confirm: '退会する' })
check('login 20 min ago -> 409 reauth_required, nothing deleted', !r.ok && r.code === 'reauth_required' && authExists(B.id)
  && sql(`select count(*) from public.players where id = '${onlyB}'`) === '1', JSON.stringify(r))
const oldB = { ...B }
await login(B)
check('a new login creates a NEW session (different session_id)', B.session !== oldB.session)
const pv = await rpc(B, 'account_deletion_preview')
check('preview: fresh login counted, shared child kept, own child deleted',
  pv.reauth_seconds_left > 500 && pv.children_kept_by_family.length === 1 && pv.children_to_delete.length === 1)

console.log('--- delete B (member, one shared + one own child)')
r = await invokeAs(B, { confirm: '退会する' })
check('B deleted (200)', r.ok && r.data?.status === 'deleted', JSON.stringify(r))
check('Auth user B is gone', !authExists(B.id))
check('shared child kept, C is its guardian', sql(`select string_agg(user_id::text, ',') from public.player_guardians where player_id = '${shared}'`) === C.id)
check("B's own child + answers deleted", sql(`select count(*) from public.players where id = '${onlyB}'`) === '0'
  && sql(`select count(*) from public.attendance where player_id = '${onlyB}'`) === '0')
check('other families\' answers unchanged', sql(`select md5(string_agg(player_id::text || status, ',' order by player_id)) from public.attendance where player_id <> '${onlyB}'`) === othersBefore)
check('recorder columns anonymised (no reference to B left)', sql(`select
  (select count(*) from public.attendance where updated_by = '${B.id}') + (select count(*) from public.players where created_by = '${B.id}')
  + (select count(*) from public.guardian_invitations where created_by = '${B.id}' or used_by = '${B.id}')`) === '0')
check('deletion-state row removed with the Auth user', sql(`select count(*) from private.account_deletions where user_id = '${B.id}'`) === '0')
await rpc(C, 'set_attendance', { p_event_id: ev, p_player_id: shared, p_status: 'undecided', p_comment: null })
check('C still manages the shared child', true)

// Every uuid/text/json column in public, private and auth: where does the deleted user still appear?
const leftoverRefs = (id, email) => sql(`select coalesce(string_agg(t || '=' || n, ' ' order by t), '') from (
  select c.table_schema || '.' || c.table_name || '.' || c.column_name as t,
    (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I where %I::text like %L or %I::text like %L',
      c.table_schema, c.table_name, c.column_name, '%${id}%', c.column_name, '%${email}%'), false, true, '')))[1]::text::int as n
  from information_schema.columns c
  join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
  where c.table_schema in ('public', 'private', 'auth') and c.data_type in ('uuid', 'text', 'character varying', 'json', 'jsonb')) x
  where n > 0`)
const leftB = leftoverRefs(B.id, B.email)
check('no reference to B left in public/private schemas', !/(^| )(public|private)\./.test(leftB), leftB)
console.log(`info  left in Supabase Auth's own tables (managed by Supabase): ${leftB || 'none'}`)

console.log('--- old tokens of B')
for (const [name, u] of [['the token used for deletion', B], ['the older session token', oldB]]) {
  let msg = ''
  try { await rpc(u, 'set_attendance', { p_event_id: ev, p_player_id: shared, p_status: 'absent', p_comment: null }) } catch (e) { msg = e.message }
  check(`${name}: RPC refused (session_expired)`, msg.includes('session_expired'), msg)
  try { await rpc(u, 'create_team', { p_name: 'x', p_display_name: 'x' }); msg = '' } catch (e) { msg = e.message }
  check(`${name}: cannot create a team`, msg.includes('session_expired'), msg)
  const { data } = await u.client.from('players').select('id')
  check(`${name}: sees no data`, Array.isArray(data) && data.length === 0, JSON.stringify(data))
}
const { error: refreshErr } = await B.client.auth.refreshSession({ refresh_token: B.refresh })
check('refresh token no longer works', !!refreshErr)

console.log('--- race: both guardians of one child leave at the same moment')
let orphan = 0
for (let i = 0; i < 6; i++) {
  const G1 = await newUser(`g1-${i}`), G2 = await newUser(`g2-${i}`), Own = await newUser(`o-${i}`)
  const t = await rpc(Own, 'create_team', { p_name: `shared ${run} ${i}`, p_display_name: 'O' })
  for (const u of [G1, G2]) await rpc(u, 'join_team', { p_share_token: t.share_token, p_display_name: 'g' })
  const kid = (await rpc(G1, 'register_player', { p_team_id: t.id, p_name: `共有 ${i}`, p_note: null, p_confirm_similar: true })).player_id
  const iv = await rpc(G1, 'create_guardian_invitation', { p_player_id: kid })
  await rpc(G2, 'accept_guardian_invitation', { p_token: iv.token, p_display_name: 'g' })
  const both = await Promise.all([invokeAs(G1, { confirm: '退会する' }), invokeAs(G2, { confirm: '退会する' })])
  if (!both.every((x) => x.ok)) console.log('      (round', i, both.map((x) => x.ok ? 'ok' : x.code).join(','), ')')
  orphan += Number(sql(`select count(*) from public.players p where p.id = '${kid}' and not exists (select 1 from public.player_guardians g where g.player_id = p.id)`))
}
check('6 rounds: no child is ever left without a guardian (child deleted with the last guardian)', orphan === 0, `orphans=${orphan}`)

console.log('--- race: a sole guardian leaves while someone accepts their invitation')
let bad = 0, deadlocks = 0
for (let i = 0; i < 6; i++) {
  const G = await newUser(`inv-g-${i}`), N = await newUser(`inv-n-${i}`), Own = await newUser(`inv-o-${i}`)
  const t = await rpc(Own, 'create_team', { p_name: `inv ${run} ${i}`, p_display_name: 'O' })
  await rpc(G, 'join_team', { p_share_token: t.share_token, p_display_name: 'g' })
  const kid = (await rpc(G, 'register_player', { p_team_id: t.id, p_name: `招待 ${i}`, p_note: null, p_confirm_similar: true })).player_id
  const iv = await rpc(G, 'create_guardian_invitation', { p_player_id: kid })
  const [del, acc] = await Promise.allSettled([invokeAs(G, { confirm: '退会する' }),
    rpc(N, 'accept_guardian_invitation', { p_token: iv.token, p_display_name: 'n' })])
  if (JSON.stringify([del, acc]).includes('deadlock')) deadlocks++
  const kidExists = sql(`select count(*) from public.players where id = '${kid}'`) === '1'
  const guardians = Number(sql(`select count(*) from public.player_guardians where player_id = '${kid}'`))
  // valid outcomes: accepted first -> child kept with N only; deleted first -> child gone and acceptance refused
  if (kidExists ? guardians !== 1 : acc.status === 'fulfilled') bad++
}
check('6 rounds: child either kept with the new guardian or deleted; never orphaned, no deadlock', bad === 0 && deadlocks === 0, `bad=${bad} deadlocks=${deadlocks}`)

console.log('--- owner hand-over with approval')
r = await invokeAs(A, { confirm: '退会する' })
check('owner with members -> 409 owner_must_transfer', !r.ok && r.code === 'owner_must_transfer' && authExists(A.id), JSON.stringify(r))
await rpc(A, 'request_owner_transfer', { p_team_id: team.id, p_to_user: C.id })
check('request alone does not change the owner', ownersOf(team.id) === A.id)
r = await invokeAs(A, { confirm: '退会する' })
check('still refused while waiting for approval', !r.ok && r.code === 'owner_must_transfer')
// double click on "accept": two parallel calls
const both = await Promise.allSettled([1, 2].map(() => rpc(C, 'respond_owner_transfer', { p_team_id: team.id, p_accept: true })))
const accepted = both.filter((x) => x.status === 'fulfilled' && x.value.status === 'accepted').length
check('parallel double accept: exactly one accepted, one transfer_not_found', accepted === 1
  && both.some((x) => x.status === 'rejected' && String(x.reason).includes('transfer_not_found')), JSON.stringify(both.map((x) => x.status)))
check('C is the only owner; A is a member', ownersOf(team.id) === C.id
  && sql(`select role from public.team_members where team_id = '${team.id}' and user_id = '${A.id}'`) === 'member')
r = await invokeAs(A, { confirm: '退会する' })
check('former owner can now delete (200)', r.ok, JSON.stringify(r))
check('team and its events stay with C', sql(`select count(*) from public.events where id = '${ev}'`) === '1' && ownersOf(team.id) === C.id)

console.log('--- Auth deletion failure, safe state, retry')
const D = await newUser('parent-d')
const soloTeam = await rpc(D, 'create_team', { p_name: `D solo ${run}`, p_display_name: 'D' })
await rpc(D, 'register_player', { p_team_id: soloTeam.id, p_name: 'Dの子', p_note: null, p_confirm_similar: true })
// Local-only fault injection: make the Auth deletion of D fail inside the database.
sql(`create or replace function public._e2e_block_delete() returns trigger language plpgsql as $$
  begin if old.id = '${D.id}' then raise exception 'e2e_injected_auth_failure'; end if; return old; end $$;
  create trigger _e2e_block_delete before delete on auth.users for each row execute function public._e2e_block_delete();`)
try {
  r = await invokeAs(D, { confirm: '退会する' })
  check('Auth deletion fails -> 503 auth_delete_failed', !r.ok && r.status === 503 && r.code === 'auth_delete_failed', JSON.stringify(r))
  check('safe state: no app data, Auth user still there, state row with the error noted',
    authExists(D.id) && sql(`select count(*) from public.teams where id = '${soloTeam.id}'`) === '0'
    && sql(`select count(*) from public.team_members where user_id = '${D.id}'`) === '0'
    && /^1\|5\d\d/.test(sql(`select attempts || '|' || coalesce(last_error, '') from private.account_deletions where user_id = '${D.id}'`)))
  let msg = ''
  try { await rpc(D, 'create_team', { p_name: 'again', p_display_name: 'D' }) } catch (e) { msg = e.message }
  check('pending user cannot create a team', msg.includes('account_deletion_pending'), msg)
  try { await rpc(D, 'join_team', { p_share_token: team.share_token, p_display_name: 'D' }); msg = '' } catch (e) { msg = e.message }
  check('pending user cannot join a team', msg.includes('account_deletion_pending'), msg)
  check('preview says deletion is pending', (await rpc(D, 'account_deletion_preview')).deletion_pending === true)
  r = await invokeAs(D, { confirm: '退会する' })
  check('retry while Auth still failing -> 503 again, still safe', !r.ok && r.code === 'auth_delete_failed' && authExists(D.id)
    && sql(`select attempts from private.account_deletions where user_id = '${D.id}'`) === '2', JSON.stringify(r))
} finally {
  sql(`drop trigger if exists _e2e_block_delete on auth.users; drop function if exists public._e2e_block_delete();`)
}
sql(`update auth.sessions set created_at = now() - interval '3 hours' where id = '${D.session}'`)
r = await invokeAs(D, { confirm: '退会する' })
check('retry hours later (old login is fine once data is gone) -> deleted', r.ok && !authExists(D.id), JSON.stringify(r))
check('state row gone', sql(`select count(*) from private.account_deletions where user_id = '${D.id}'`) === '0')

console.log('--- double click on delete')
const E = await newUser('parent-e')
await rpc(E, 'create_team', { p_name: `E solo ${run}`, p_display_name: 'E' })
const two = await Promise.all([1, 2].map(() => invokeAs(E, { confirm: '退会する' })))
check('two parallel deletes: no 5xx, user deleted once', two.every((x) => x.ok || x.status === 401) && two.some((x) => x.ok) && !authExists(E.id),
  JSON.stringify(two.map((x) => x.ok ? 'ok' : `${x.status} ${x.code}`)))

console.log('--- concurrency: hand-over vs re-request vs delete (real Postgres)')
let oneOwner = true, rounds = 0
for (let i = 0; i < 8; i++) {
  const F = await newUser(`own-${i}`), G = await newUser(`g-${i}`), H = await newUser(`h-${i}`)
  const t = await rpc(F, 'create_team', { p_name: `race ${run} ${i}`, p_display_name: 'F' })
  for (const u of [G, H]) await rpc(u, 'join_team', { p_share_token: t.share_token, p_display_name: 'm' })
  await rpc(F, 'request_owner_transfer', { p_team_id: t.id, p_to_user: G.id })
  await Promise.allSettled([
    rpc(G, 'respond_owner_transfer', { p_team_id: t.id, p_accept: true }),
    rpc(F, 'request_owner_transfer', { p_team_id: t.id, p_to_user: H.id }),
    invokeAs(F, { confirm: '退会する' }),
    rpc(H, 'respond_owner_transfer', { p_team_id: t.id, p_accept: true }),
  ])
  const n = Number(sql(`select count(*) from public.team_members where team_id = '${t.id}' and role = 'owner'`))
  const teamGone = sql(`select count(*) from public.teams where id = '${t.id}'`) === '0'
  if (!(n === 1 || teamGone)) oneOwner = false
  rounds++
}
check(`${rounds} racing rounds: every team has exactly one owner`, oneOwner)
let raceErr = ''
const Y = await newUser('y')
await rpc(Y, 'join_team', { p_share_token: team.share_token, p_display_name: 'Y' })
try {
  sql(`begin; update public.team_members set role = 'owner' where team_id = '${team.id}' and user_id = '${Y.id}'; commit;`)
} catch (e) { raceErr = String(e.stderr ?? e.message) }
check('a second owner is refused by the database', /team_members_one_owner|duplicate key/.test(raceErr), raceErr.slice(0, 120))

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
