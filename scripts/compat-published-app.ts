// Compatibility check: the CURRENTLY PUBLISHED app's data layer against a LOCAL Supabase in each
// rollout stage (before the Phase 4-B migrations / after them / after the Edge Function).
// It imports app/repo/supabaseRepo.ts from the public repository checkout (read-only).
//
//   deno run -A --sloppy-imports --no-lock --no-config scripts/compat-published-app.ts \
//     <local.env from `supabase status -o env`> <public repo dir> <state.json> seed|check <label>
//
// seed  : create users and data with the published code (stage before the migrations)
// check : use the published code on that existing data + new data, print PASS/FAIL
// Local stack only (refuses any non-local API URL). Users are throwaway *@example.test.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.109.0'

const [envFile, pubDir, stateFile, mode, label = ''] = Deno.args
const env = Object.fromEntries(Deno.readTextFileSync(envFile).split('\n')
  .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2]]))
const API = env.API_URL
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API ?? '')) throw new Error('refusing: not a local stack')
const { createSupabaseRepo } = await import(`${pubDir}/app/repo/supabaseRepo.ts`)

const admin = createClient(API, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
type U = { id: string; email: string; password: string }
type Live = U & { client: SupabaseClient; repo: any }
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${label}] ${name}${ok || !detail ? '' : `  -> ${detail}`}`)
}
async function signIn(u: U): Promise<Live> {
  const client = createClient(API, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await client.auth.signInWithPassword({ email: u.email, password: u.password })
  if (error) throw error
  return { ...u, client, repo: createSupabaseRepo(client, () => u.id) }
}
async function newUser(tag: string): Promise<U> {
  const email = `compat-${tag.toLowerCase().replace(/[^a-z0-9]+/g, "")}-${Date.now().toString(36)}@example.test`
  const password = crypto.randomUUID()
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  return { id: data.user!.id, email, password }
}
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString()

if (mode === 'seed') {
  const users = { owner: await newUser('owner'), parent: await newUser('parent'), family: await newUser('family') }
  const [o, p, f] = await Promise.all([signIn(users.owner), signIn(users.parent), signIn(users.family)])
  const team = await o.repo.createTeam('公開版の互換チーム', '代表')
  await p.repo.joinTeam(team.share_token, '保護者')
  await o.repo.createEvent(team.id, { title: '既存の練習', starts_at: day(2), location: null, note: null })
  const snap = await o.repo.loadTeam(team.id)
  const reg = await p.repo.registerPlayer(team.id, '既存 たろう', '3年', true)
  await p.repo.setAttendance(snap.events[0].id, reg.player_id, 'attend', '既存の回答')
  const inv = await p.repo.createInvitation(reg.player_id)
  await f.repo.acceptInvitation(inv.token, '家族')
  Deno.writeTextFileSync(stateFile, JSON.stringify({ users, team, player: reg.player_id, event: snap.events[0].id }))
  console.log(`seeded with the published code: team, 3 users, 1 event, 1 child (2 guardians), 1 answer`)
  Deno.exit(0)
}

// ---- check
const st = JSON.parse(Deno.readTextFileSync(stateFile))
const [o, p, f] = await Promise.all([signIn(st.users.owner), signIn(st.users.parent), signIn(st.users.family)])
const teams = await p.repo.myTeams()
check('login + team list (existing data)', teams.some((t: any) => t.id === st.team.id))
const snap = await p.repo.loadTeam(st.team.id)
check('team page: existing event, child and answer are shown',
  !!snap && snap.events.some((e: any) => e.id === st.event) && snap.players.some((x: any) => x.id === st.player)
  && snap.attendance.some((a: any) => a.player_id === st.player) && snap.myPlayerIds.includes(st.player))
await p.repo.setAttendance(st.event, st.player, 'absent', '変更')
await f.repo.setAttendance(st.event, st.player, 'undecided', null)
check('attendance: both guardians can change the existing answer', (await o.repo.loadTeam(st.team.id)).attendance
  .some((a: any) => a.player_id === st.player && a.status === 'undecided'))
let refused = ''
try { await o.repo.setAttendance(st.event, st.player, 'attend', null) } catch (e) { refused = String(e) }
check('another family (owner) still cannot change the child', /forbidden/.test(refused), refused)
await o.repo.createEvent(st.team.id, { title: `新しい予定 ${label}`, starts_at: day(5), location: '公園', note: null })
const ev2 = (await o.repo.loadTeam(st.team.id)).events.find((e: any) => e.title === `新しい予定 ${label}`)
await o.repo.updateEvent(ev2.id, { title: `変更 ${label}`, starts_at: day(6), location: null, note: 'メモ' })
check('owner: create / edit an event', !!ev2)
const nu = await signIn(await newUser(`new-${label}`))
const preview = await nu.repo.teamPreview(st.team.share_token)
await nu.repo.joinTeam(st.team.share_token, '新メンバー')
const kid = await nu.repo.registerPlayer(st.team.id, `新しい子 ${label}`, null, true)
await nu.repo.setAttendance(ev2.id, kid.player_id, 'attend', null)
check('new member: preview, join, register a child, answer', preview?.name === '公開版の互換チーム' && kid.status === 'created')
const upd = await nu.repo.updatePlayer(kid.player_id, `改名 ${label}`, '1年', true)
await nu.repo.archivePlayer(kid.player_id)
await o.repo.deleteEvent(ev2.id)
check('edit / cancel a child, delete an event', upd.status === 'updated'
  && !(await o.repo.loadTeam(st.team.id)).events.some((e: any) => e.id === ev2.id))
const inv = await p.repo.createInvitation(st.player)
const extra = await signIn(await newUser(`fam-${label}`))
const acc = await extra.repo.acceptInvitation(inv.token, '家族2')
check('family invitation: create and accept', acc.status === 'accepted')
// Logout, then keep using the OLD access token (what a stolen / leftover token would do).
const { data: sess } = await extra.client.auth.getSession()
const oldToken = sess.session!.access_token
await extra.client.auth.signOut({ scope: 'local' })
const oldClient = createClient(API, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${oldToken}` } } })
const oldRepo = createSupabaseRepo(oldClient, () => extra.id)
let after: unknown
try { after = await oldRepo.loadTeam(st.team.id) } catch (e) { after = String(e) }
console.log(`info  [${label}] logged-out token, published app's loadTeam: ${after === null ? 'null (nothing visible)' : 'TEAM VISIBLE'}`)

const fn = await fetch(`${API}/functions/v1/delete-account`, { method: 'OPTIONS', headers: { Origin: 'https://kakimon.github.io' } })
console.log(`info  [${label}] delete-account endpoint: HTTP ${fn.status}`)
console.log(failed ? `${failed} FAILED` : `ALL PASSED [${label}]`)
Deno.exit(failed ? 1 : 0)
