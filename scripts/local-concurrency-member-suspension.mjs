// D6-B1, real parallel PostgreSQL connections in the LOCAL Supabase container only.
// Creates/drops an isolated test database. No keys, URLs, project refs or production access.
// Auth SQL stub matches tests/db/setup.ts; all actual app migrations/RLS/RPCs are installed.
// Run: node scripts/local-concurrency-member-suspension.mjs (Colima + local Supabase running).
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const container = 'supabase_db_team-attendance'
const database = `d6b_verify_${Date.now()}`
assert.match(database, /^d6b_verify_[0-9]+$/)
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
 const o=randomUUID(),a=randomUUID(),b=randomUUID();
 for(const u of [o,a,b]) sql(`insert into auth.users values(${quote(u)}); insert into auth.sessions(id,user_id) values(${quote(u)},${quote(u)});`)
 const t=JSON.parse(rpc(o,`to_jsonb(public.create_team('D6-B1','Owner'))`));
 const token=JSON.parse(rpc(o,`public.get_join_link(${quote(t.id)})`)).token;
 for(const u of [a,b])rpc(u,`public.join_by_token(${quote(token)},'Member')`);
 const kid=JSON.parse(rpc(a,`public.register_player(${quote(t.id)},'Solo',null,true)`)).player_id;
 const self=JSON.parse(rpc(a,`public.register_self(${quote(t.id)})`)).player_id;
 const ev=rpc(o,`public.create_event(${quote(t.id)},'Practice',now())`);
 rpc(a,`public.set_attendance(${quote(ev)},${quote(kid)},'attend')`);
 const stop=`${auth(o)} select public.suspend_member(${quote(t.id)},${quote(a)});`;
 let writer,expected='team_access_suspended';
 if(kind==='answer')writer=`${auth(a)} select public.set_attendance(${quote(ev)},${quote(kid)},'absent');`;
 if(kind==='register-self-new')sql(`delete from public.players where id=${quote(self)};`);
 if(kind==='register-self'||kind==='register-self-new')writer=`${auth(a)} select public.register_self(${quote(t.id)});`;
 if(kind==='register-proxy')writer=`${auth(a)} select public.register_player(${quote(t.id)},'New',null,true);`;
 if(kind==='creator-invitation'){
  const inv=JSON.parse(rpc(a,`public.create_guardian_invitation(${quote(kid)})`));
  writer=`${auth(b)} select public.accept_guardian_invitation(${quote(inv.token)},'Family');`;expected='invitation_invalid';
 }
 if(kind==='invitation'){
  const p=JSON.parse(rpc(b,`public.register_player(${quote(t.id)},'Other',null,true)`)).player_id;
  const inv=JSON.parse(rpc(b,`public.create_guardian_invitation(${quote(p)})`));
  writer=`${auth(a)} select public.accept_guardian_invitation(${quote(inv.token)},'Member');`;
 }
 if(kind==='handover'){
  rpc(o,`public.request_owner_transfer(${quote(t.id)},${quote(a)})`);
  writer=`${auth(a)} select public.respond_owner_transfer(${quote(t.id)},true);`;
 }
 if(kind==='role')writer=`${auth(o)} select public.set_member_role(${quote(t.id)},${quote(a)},'admin');`;
 if(kind==='purge'){writer=`set role service_role; select public.purge_account_data(${quote(a)},${quote(a)});`;expected=null;}
 if(['answer','register-proxy'].includes(kind))expected='forbidden';
 return {o,a,b,t,kid,self,ev,token,stop,writer,expected};
}
function integrity(){
 assert.equal(sql('select count(*) from public.players p where not exists(select 1 from public.player_guardians g where g.player_id=p.id);'),'0');
 assert.equal(sql('select count(*) from public.player_guardians g where not exists(select 1 from public.team_members m where m.team_id=g.team_id and m.user_id=g.user_id);'),'0');
 assert.equal(sql('select count(*) from public.attendance a where not exists(select 1 from public.players p where p.id=a.player_id);'),'0');
 assert.equal(sql("select count(*) from public.team_members where suspended_at is not null and role<>'member';"),'0');
}
async function race(firstSql,secondSql,expected,label){
 const first=session('first'),second=session('second');
 try{
  first.send(firstSql);await first.ready();second.send(secondSql);await waitBlocked(second);
  assert.equal((await first.finish()).errors,'');const result=await second.finish();
  if(expected)assert.ok(result.errors.includes(expected),`${label}: wanted ${expected}: ${result.errors}`);else assert.equal(result.errors,'',label);
  assert.ok(!/deadlock|timeout/i.test(result.errors));integrity();console.log(`PASS ${label}: overlap proven, integrity OK`);
 }finally{first.stop();second.stop();}
}
sql(`create database ${database};`,'postgres');
try{
 const stub=readFileSync(new URL('../tests/db/setup.ts',import.meta.url),'utf8').match(/const SUPABASE_STUB = `([\s\S]*?)`/)[1].replace(/^create role .*;\n/gm,'');sql(stub);
 for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 for(const kind of ['answer','invitation','creator-invitation','register-self','register-self-new','register-proxy','handover','role','purge'])for(const stopFirst of [true,false]){
  const f=fixture(kind);
  const expected=stopFirst?f.expected:kind==='handover'?'forbidden':kind==='purge'?'member_not_found':null;
  await race(stopFirst?f.stop:f.writer,stopFirst?f.writer:f.stop,expected,`${kind}, ${stopFirst?'stop':'writer'} first`);
  const m=sql(`select role||':'||(suspended_at is not null)::text from public.team_members where team_id=${quote(f.t.id)} and user_id=${quote(f.a)};`);
  assert.equal(m,kind==='purge'?'':kind==='handover'&&!stopFirst?'owner:false':'member:true');
  if(kind!=='purge'){
   assert.equal(sql(`select count(*) from public.players where id=${quote(f.kid)};`),'1');
   assert.equal(sql(`select count(*) from public.players where team_id=${quote(f.t.id)} and self_user_id=${quote(f.a)};`),kind==='register-self-new'&&stopFirst?'0':'1');
  }
 }
 // Resume serializes against both joining and the normal self-leave route.
 for(const kind of ['join','leave']){
  const f=fixture('answer');sql(f.stop);
  if(kind==='leave')sql(`delete from public.players where id=${quote(f.kid)};`); // disposable fixture: no sole proxy
  const resume=`${auth(f.o)} select public.resume_member(${quote(f.t.id)},${quote(f.a)});`;
  const operation=kind==='join'?`${auth(f.a)} select public.join_by_token(${quote(f.token)},'Member');`:`${auth(f.a)} select public.leave_team(${quote(f.t.id)});`;
  await race(resume,operation,null,`resume first / ${kind}`);
 }
 // Reverse ordering: stopped caller holds its actual account lock, attempts the operation
 // while resume is queued, gets refused, and only then may resume commit.
 for(const kind of ['join','leave']){
  const f=fixture('answer');sql(f.stop);
  const first=session('stopped'),second=session('resume');
  try{
   first.send(`select pg_advisory_xact_lock(hashtextextended('membership:${f.a}',0));`);await first.ready();
   second.send(`${auth(f.o)} select public.resume_member(${quote(f.t.id)},${quote(f.a)});`);await waitBlocked(second);
   first.send(kind==='join'?`${auth(f.a)} select public.join_by_token(${quote(f.token)},'M');`:`${auth(f.a)} select public.leave_team(${quote(f.t.id)});`);
   const denied=await first.finish();assert.ok(denied.errors.includes('team_access_suspended'));assert.equal((await second.finish()).errors,'');integrity();
   console.log(`PASS stopped ${kind} first / resume: overlap proven, refusal then resume`);
  }finally{first.stop();second.stop();}
 }
 for(const cleanupFirst of [true,false]){
  const f=fixture('answer');sql(f.stop);const pv=JSON.parse(rpc(f.a,`public.suspended_leave_preview(${quote(f.t.id)})`));
  const cleanup=`${auth(f.a)} select public.leave_suspended_team(${quote(f.t.id)},${quote(pv.fingerprint)},'登録と出欠を削除して脱退する');`;
  const resume=`${auth(f.o)} select public.resume_member(${quote(f.t.id)},${quote(f.a)});`;
  await race(cleanupFirst?cleanup:resume,cleanupFirst?resume:cleanup,cleanupFirst?'member_not_found':'not_suspended',`resume/cleanup, ${cleanupFirst?'cleanup':'resume'} first`);
 }
 // Self cleanup vs an active proxy's answer or departure, in BOTH orders.
 for(const kind of ['answer','leave'])for(const cleanupFirst of [true,false]){
  const f=fixture('answer');const inv=JSON.parse(rpc(f.a,`public.create_guardian_invitation(${quote(f.self)})`));rpc(f.b,`public.accept_guardian_invitation(${quote(inv.token)},'Family')`);sql(f.stop);
  const pv=JSON.parse(rpc(f.a,`public.suspended_leave_preview(${quote(f.t.id)})`));
  const cleanup=`${auth(f.a)} select public.leave_suspended_team(${quote(f.t.id)},${quote(pv.fingerprint)},'登録と出欠を削除して脱退する');`;
  const writer=kind==='answer'?`${auth(f.b)} select public.set_attendance(${quote(f.ev)},${quote(f.self)},'absent');`:`${auth(f.b)} select public.leave_team(${quote(f.t.id)});`;
  await race(cleanupFirst?cleanup:writer,cleanupFirst?writer:cleanup,cleanupFirst?(kind==='answer'?'not_found':null):'leave_confirmation_stale',`cleanup/${kind}, ${cleanupFirst?'cleanup':'writer'} first`);
  assert.equal(sql(`select count(*) from public.team_members where team_id=${quote(f.t.id)} and user_id=${quote(f.a)};`),cleanupFirst?'0':'1');
 }
 // Rollback order (D6-B3): later migrations redefine D6-B1 functions, so never roll back D6-B1 alone.
 // Roll back every later migration newest-first, then D6-B1; re-apply D6-B1, then the later ones oldest-first.
 const D6B1='20261118100000_member_suspension.sql';
 const later=readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f>D6B1).sort();

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
 const down=(f)=>{
  const text=rollbackSql(f);
  if(!f.includes('disable_legacy_join'))return sql(text);
  let refusal='';try{sql(text);}catch(e){refusal=String(e.stderr);}
  assert.ok(refusal.includes('legacy_join_rollback_refused'),'D5 rollback must refuse without the explicit permission');
  legacyClosed();assert.match(text,/^begin;$/m);
  sql(text.replace(/^begin;$/m,`begin;\n${LEGACY_ALLOW}`));
  assert.equal(sql("select coalesce(current_setting('app.allow_legacy_join_reenable', true), '');"),'');
 };
 const up=(f)=>sql(readFileSync(new URL(`../supabase/migrations/${f}`,import.meta.url),'utf8'));
 const bodies=()=>sql("select md5(string_agg(oid::regprocedure::text||prosrc||coalesce(proacl::text,''),'|' order by oid::regprocedure::text)) from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace);");
 const d6b1Functions=()=>sql("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('suspend_member','resume_member','my_suspended_memberships','suspended_leave_preview','leave_suspended_team');");
 const suspendedColumn=()=>sql("select count(*) from information_schema.columns where table_schema='public' and table_name='team_members' and column_name='suspended_at';");
 // Data that must survive the chain (suspension columns themselves are D6-B1's and go with it).
 const data=()=>sql("select md5(coalesce((select string_agg(x,'|' order by x) from (select (to_jsonb(p))::text x from public.players p union all select (to_jsonb(a))::text from public.attendance a union all select (to_jsonb(g))::text from public.player_guardians g union all select (to_jsonb(m)-'suspended_at'-'access_revision')::text from public.team_members m) s),''));");
 const live=()=>Number(sql('select count(*) from public.team_members where suspended_at is not null;'));
 assert.ok(live()>0,'fixtures must leave a live suspension for the refusal check');
 // 1) A live suspension: the D6-B1 rollback must refuse and change nothing (later migrations restored after).
 const fullBefore=bodies();
 for(const f of [...later].reverse())down(f);
 let rejected=false,refusal='';try{down(D6B1);}catch(e){refusal=String(e.stderr);rejected=refusal.includes('suspended_members_remain');}
 assert.ok(rejected,`D6-B1 rollback must refuse a live suspension (got: ${refusal.slice(0,120)||'no error'})`);
 assert.equal(d6b1Functions(),'5');assert.equal(suspendedColumn(),'1');assert.ok(live()>0);
 for(const f of later)up(f);
 assert.equal(bodies(),fullBefore,'refused rollback must leave every function and ACL as before');
 if(later.some(f=>f.includes('disable_legacy_join')))legacyClosed();
 console.log('PASS rollback refuses live suspensions (later migrations rolled back first, then restored)');
 // 2) Resolve test fixtures via owner RPC only, then the full chain must restore functions, ACLs and data.
 const pairs=sql("select team_id||'|'||user_id from public.team_members where suspended_at is not null;").split('\n').filter(Boolean);
 for(const pair of pairs){const[t,u]=pair.split('|');const o=sql(`select user_id from public.team_members where team_id=${quote(t)} and role='owner';`);rpc(o,`public.resume_member(${quote(t)},${quote(u)})`);}
 assert.equal(live(),0);
 const before=bodies(),dataBefore=data();
 for(const f of [...later].reverse())down(f);
 down(D6B1);
 assert.equal(d6b1Functions(),'0','D6-B1 functions must be gone after its rollback');assert.equal(suspendedColumn(),'0');
 up(D6B1);for(const f of later)up(f);
 if(later.some(f=>f.includes('disable_legacy_join')))legacyClosed();
 assert.equal(d6b1Functions(),'5');assert.equal(suspendedColumn(),'1');
 assert.equal(bodies(),before,'function bodies and ACLs must be restored exactly');
 assert.equal(data(),dataBefore,'registrations, answers, links and memberships must be unchanged');
 console.log(`PASS rollback / reapply function bodies + ACLs + data (order: ${[...later].reverse().join(' -> ')}${later.length?' -> ':''}${D6B1}, then back)`);
}finally{sql(`drop database ${database} with (force);`,'postgres');console.log('Isolated D6-B1 verification database removed.');}
