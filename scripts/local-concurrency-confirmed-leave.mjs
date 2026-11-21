// D6-A, real parallel PostgreSQL connections in the LOCAL Supabase container only.
// Creates/drops an isolated test database. No keys, URLs, project refs or production access.
// Auth SQL stub matches tests/db/setup.ts; all actual app migrations/RLS/RPCs are installed.
// Run: node scripts/local-concurrency-confirmed-leave.mjs (Colima + local Supabase running).
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const container = 'supabase_db_team-attendance'
const database = `d6a_verify_${Date.now()}`
assert.match(database, /^d6a_verify_[0-9]+$/)
const args = (db = database) => ['--context', 'colima', 'exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', db, '-Atq', '-v', 'ON_ERROR_STOP=1']
const sql = (s, db = database) => execFileSync('docker', args(db), { input: s, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`
const auth = (id) => `set role authenticated; set request.jwt.claim.sub=${quote(id)}; set request.jwt.claims=${quote(JSON.stringify({ sub: id, session_id: id }))};`
const rpc = (id, q) => sql(`${auth(id)} select ${q};`)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
let sequence = 0
function session(label) {
  const name = `d6_${++sequence}_${label}`
  const p = spawn('docker', args(), { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = '', ended = false
  p.stdout.on('data', (v) => { output += v })
  p.stderr.on('data', (v) => { errors += v })
  p.stdin.on('error', () => {}) // ON_ERROR_STOP may exit before the final commit is written
  p.on('exit', () => { ended = true })
  const send = (s) => p.stdin.write(s + '\n')
  send(`set application_name=${quote(name)}; set statement_timeout='8s'; set lock_timeout='6s'; begin;`)
  return { name, send, get output() { return output }, get errors() { return errors },
    async ready() {
      send('\\echo D6_READY')
      for (let i = 0; i < 160 && !output.includes('D6_READY'); i++) {
        if (ended) throw new Error(errors)
        await pause(25)
      }
      assert.ok(output.includes('D6_READY'), `${name}: ready timeout ${errors}`)
    },
    async finish() {
      if (!ended) send('commit;\n\\q')
      for (let i = 0; i < 400 && !ended; i++) await pause(25)
      if (!ended) { p.kill(); throw new Error(`${name}: process timeout`) }
      return { output, errors }
    },
    stop() { if (!ended) { p.stdin.end('rollback;\n\\q\n'); p.kill() } },
  }
}
async function waitBlocked(s) {
  for (let i = 0; i < 100; i++) {
    if (sql(`select count(*) from pg_stat_activity where application_name=${quote(s.name)} and wait_event_type='Lock';`) === '1') return
    if (s.errors) throw new Error(s.errors)
    await pause(25)
  }
  throw new Error(`${s.name}: did not wait on a lock`)
}

function fixture(kind) {
  const o = randomUUID(), a = randomUUID(), b = randomUUID()
  for (const id of [o, a, b]) sql(`insert into auth.users values (${quote(id)}); insert into auth.sessions(id,user_id) values(${quote(id)},${quote(id)});`)
  const team = JSON.parse(rpc(o, `to_jsonb(public.create_team('D6', 'Owner'))`)).id
  const token = JSON.parse(rpc(o, `public.get_join_link(${quote(team)})`)).token
  for (const id of [a, b]) rpc(id, `public.join_by_token(${quote(token)},'Member')`)
  const kid = JSON.parse(rpc(a, `public.register_player(${quote(team)},'Sole',null,true)`)).player_id
  const ev = rpc(o, `public.create_event(${quote(team)},'Event',now())`)
  let writer, expected, shared
  if (kind === 'invitation') {
    const invitation = JSON.parse(rpc(a, `public.create_guardian_invitation(${quote(kid)})`)).token
    writer = `${auth(b)} select public.accept_guardian_invitation(${quote(invitation)},'Family');`
    expected = 'invitation_invalid'
  } else if (kind === 'answer') {
    const self = JSON.parse(rpc(a, `public.register_self(${quote(team)})`)).player_id
    const invitation = JSON.parse(rpc(a, `public.create_guardian_invitation(${quote(self)})`)).token
    rpc(b, `public.accept_guardian_invitation(${quote(invitation)},'Family')`)
    rpc(b, `public.set_attendance(${quote(ev)},${quote(self)},'attend','before')`)
    writer = `${auth(b)} select public.set_attendance(${quote(ev)},${quote(self)},'absent','after');`
    expected = 'not_found'
  } else if (kind === 'registration') {
    writer = `${auth(a)} select public.update_player(${quote(kid)},'Changed',null,true);`
    expected = 'not_found'
  } else {
    if (kind === 'purge') {
      // Historical invitation used by B for a registration that A now manages alone.
      const old = JSON.parse(rpc(a, `public.create_guardian_invitation(${quote(kid)})`)).token
      rpc(b, `public.accept_guardian_invitation(${quote(old)},'Family')`)
      rpc(b, `public.leave_team(${quote(team)})`)
      rpc(b, `public.join_by_token(${quote(token)},'Member')`)
    }
    shared = JSON.parse(rpc(a, `public.register_player(${quote(team)},'Shared',null,true)`)).player_id
    const invitation = JSON.parse(rpc(a, `public.create_guardian_invitation(${quote(shared)})`)).token
    rpc(b, `public.accept_guardian_invitation(${quote(invitation)},'Family')`)
    writer = kind === 'leave' ? `${auth(b)} select public.leave_team(${quote(team)});`
      : `set role service_role; select public.purge_account_data(${quote(b)},${quote(b)});`
    expected = kind === 'leave' ? 'sole_guardian_children' : null
  }
  const hash = JSON.parse(rpc(a, `public.leave_cleanup_preview(${quote(team)})`)).cleanup.fingerprint
  const cleanup = `${auth(a)} select public.leave_team_with_cleanup(${quote(team)},${quote(hash)},'登録と出欠を削除して脱退する');`
  return { a, b, team, kid, shared, writer, cleanup, expected }
}
function integrity(f, removed) {
  assert.equal(sql(`select count(*) from public.players p where not exists(select 1 from public.player_guardians g where g.player_id=p.id);`), '0', 'no orphan registrations')
  assert.equal(sql(`select count(*) from public.player_guardians g where not exists(select 1 from public.team_members m where m.team_id=g.team_id and m.user_id=g.user_id);`), '0', 'all guardians are team members')
  assert.equal(sql(`select count(*) from public.attendance a where not exists(select 1 from public.players p where p.id=a.player_id);`), '0', 'no orphan answers')
  assert.equal(sql(`select count(*) from public.team_members where team_id=${quote(f.team)} and user_id=${quote(f.a)};`), removed ? '0' : '1')
  assert.equal(sql(`select count(*) from public.players where id=${quote(f.kid)};`), removed ? '0' : '1')
  assert.equal(sql(`select count(*) from auth.users where id=${quote(f.a)};`), '1', 'account kept')
  assert.equal(sql(`select count(*) from public.events where team_id=${quote(f.team)};`), '1', 'events kept')
}

sql(`create database ${database};`, 'postgres')
try {
  const stub = readFileSync(new URL('../tests/db/setup.ts', import.meta.url), 'utf8').match(/const SUPABASE_STUB = `([\s\S]*?)`/)[1]
    .replace(/^create role .*;\n/gm, '') // roles exist cluster-wide in local Supabase
  sql(stub)
  for (const file of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort()) {
    sql(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'))
  }
  for (const kind of ['invitation', 'answer', 'registration', 'leave', 'purge']) {
    for (const cleanupFirst of [false, true]) {
      const f = fixture(kind)
      const first = session('first'), second = session('second')
      try {
        first.send(cleanupFirst ? f.cleanup : f.writer)
        await first.ready()
        second.send(cleanupFirst ? f.writer : f.cleanup)
        await waitBlocked(second) // prove actual overlap; do not rely on an arbitrary sleep
        const one = await first.finish()
        assert.equal(one.errors, '')
        const two = await second.finish()
        const expected = cleanupFirst ? f.expected : 'leave_confirmation_stale'
        if (expected) assert.ok(two.errors.includes(expected), `${kind}: expected ${expected}; got ${two.errors}`)
        else assert.equal(two.errors, '')
        assert.ok(!/deadlock|lock timeout|statement timeout/i.test(two.errors))
        integrity(f, cleanupFirst)
        console.log(`PASS ${kind}: ${cleanupFirst ? 'cleanup first' : 'writer first'}; lock wait observed; state consistent`)
      } finally { first.stop(); second.stop() }
    }
  }
  // Adversarial interleave: purge holds the shared player, pauses before anonymising an OLD
  // invitation on the sole player. Cleanup must wait on the account, without taking that invite.
  {
    const f = fixture('purge')
    sql(`create function public.d6_gate() returns trigger language plpgsql as $$begin
      if old.user_id=${quote(f.b)}::uuid then perform pg_advisory_xact_lock(665501); end if; return old; end;$$;
      create trigger d6_gate after delete on public.player_guardians for each row execute function public.d6_gate();`)
    const gate = session('gate'), purge = session('purge'), cleanup = session('cleanup')
    try {
      gate.send('select pg_advisory_xact_lock(665501);'); await gate.ready()
      purge.send(f.writer); await waitBlocked(purge)
      cleanup.send(f.cleanup); await waitBlocked(cleanup)
      assert.equal(sql(`select wait_event from pg_stat_activity where application_name=${quote(cleanup.name)};`), 'advisory', 'cleanup waits before invitation/player locks')
      await gate.finish()
      assert.equal((await purge.finish()).errors, '')
      const result = await cleanup.finish()
      assert.ok(result.errors.includes('leave_confirmation_stale'))
      assert.ok(!/deadlock|timeout/i.test(result.errors))
      integrity(f, false)
      console.log('PASS adversarial purge: shared player / historical invitation lock inversion avoided')
    } finally {
      gate.stop(); purge.stop(); cleanup.stop()
      sql('drop trigger d6_gate on public.player_guardians; drop function public.d6_gate();')
    }
  }
  const bodies = () => sql(`select md5(string_agg(oid::regprocedure::text || prosrc || coalesce(proacl::text,''),'|' order by oid::regprocedure::text)) from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace);`)
  const before = bodies()
  // Later migrations (D6-B1 etc.) redefine D6-A functions. Rolling back D6-A alone would leave them
  // stale and re-applying it would overwrite their definitions. Safe order: roll back every later
  // migration newest-first, then D6-A; re-apply D6-A, then the later ones oldest-first.
  const D6A = '20261118000000_confirmed_leave.sql'
  const later = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql') && f > D6A).sort()

  // D5's rollback re-opens the old share-token join path and refuses unless explicitly allowed. Here, in
  // this isolated database only, it is allowed TRANSACTION-LOCALLY: `set local` right after the file's own
  // `begin;`, so nothing is left after its commit (each sql() call is also its own connection). Before that,
  // the refusal without the permission is checked every time.
  const LEGACY_ALLOW = "set local app.allow_legacy_join_reenable = 'yes-reopen-old-join-path';"
  const legacyClosed = () => {
    assert.equal(sql("select has_function_privilege('authenticated','public.join_team(text,text)','execute')::text || has_function_privilege('authenticated','public.get_team_by_share_token(text)','execute')::text;"), 'falsefalse')
    assert.equal(sql("select count(*) from pg_proc where proname in ('join_team','get_team_by_share_token') and prosrc like '%legacy_join_disabled%';"), '2')
  }
  const rollbackSql = (f) => readFileSync(new URL(`../supabase/rollback/${f.replace(/\.sql$/, '_down.sql')}`, import.meta.url), 'utf8')
  const down = (f) => {
    const text = rollbackSql(f)
    if (!f.includes('disable_legacy_join')) return sql(text)
    let refusal = ''
    try { sql(text) } catch (e) { refusal = String(e.stderr) }
    assert.ok(refusal.includes('legacy_join_rollback_refused'), 'D5 rollback must refuse without the explicit permission')
    legacyClosed()
    assert.match(text, /^begin;$/m)
    sql(text.replace(/^begin;$/m, `begin;\n${LEGACY_ALLOW}`))
    assert.equal(sql("select coalesce(current_setting('app.allow_legacy_join_reenable', true), '');"), '')   // nothing left behind
  }
  const up = (f) => sql(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
  for (const f of [...later].reverse()) down(f)
  down(D6A)
  assert.equal(sql("select count(*) from pg_proc where proname='leave_team_with_cleanup';"), '0')
  up(D6A)
  for (const f of later) up(f)
  assert.equal(bodies(), before)
  if (later.some((f) => f.includes('disable_legacy_join'))) legacyClosed()   // the old path is closed again
  console.log(`PASS local PostgreSQL rollback / reapply (order: ${[...later].reverse().join(' -> ')}${later.length ? ' -> ' : ''}${D6A}, then back)`)
} finally {
  sql(`drop database ${database} with (force);`, 'postgres')
  console.log('Isolated D6-A verification database removed.')
}
