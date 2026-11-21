import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { createDb, addUser, asUser, applyMigration, type Db } from './setup'

const MIG='20261118100000_member_suspension.sql'
const DOWN=readFileSync(new URL('../../supabase/rollback/20261118100000_member_suspension_down.sql',import.meta.url),'utf8')
const O='57000000-0000-4000-8000-000000000001', A='57000000-0000-4000-8000-000000000002', B='57000000-0000-4000-8000-000000000003', X='57000000-0000-4000-8000-000000000004'
const q=(db:Db,u:string|null,s:string,p:any[]=[],session:string|null=u)=>asUser(db,u,()=>db.query<any>(s,p),session).then(r=>r.rows)
const rpc=async(db:Db,u:string,s:string,p:any[]=[]) => (await q(db,u,`select to_jsonb(public.${s}) as r`,p))[0].r
async function fixture(){
 const db=await createDb(); for(const u of [O,A,B,X]) await addUser(db,u)
 const t=await rpc(db,O,"create_team('T','Owner')")
 const token=(await rpc(db,O,'get_join_link($1)',[t.id])).token
 for(const u of [A,B]) await rpc(db,u,"join_by_token($1,'Member')",[token])
 const self=(await rpc(db,A,'register_self($1)',[t.id])).player_id
 const kid=(await rpc(db,A,"register_player($1,'Solo',null,true)",[t.id])).player_id
 const shared=(await rpc(db,A,"register_player($1,'Shared',null,true)",[t.id])).player_id
 const inv=await rpc(db,A,'create_guardian_invitation($1)',[shared]); await rpc(db,B,"accept_guardian_invitation($1,'Family')",[inv.token])
 const pending=await rpc(db,A,'create_guardian_invitation($1)',[kid])
 const ev=await rpc(db,O,"create_event($1,'Practice',now())",[t.id])
 await rpc(db,A,"set_attendance($1,$2,'attend','private comment')",[ev,kid])
 const stop=()=>rpc(db,O,'suspend_member($1,$2)',[t.id,A])
 const preview=()=>rpc(db,A,'suspended_leave_preview($1)',[t.id])
 const leave=(hash:string)=>rpc(db,A,"leave_suspended_team($1,$2,'登録と出欠を削除して脱退する')",[t.id,hash])
 return {db,t,token,self,kid,shared,ev,pending,inv,stop,preview,leave}
}
const data=async(db:Db)=>(await db.query("select jsonb_build_object('players',(select jsonb_agg(p order by id) from public.players p),'answers',(select jsonb_agg(a order by player_id,event_id) from public.attendance a),'guardians',(select jsonb_agg(g order by player_id,user_id) from public.player_guardians g)) as d")).rows

describe('D6-B1 suspension',()=>{
 it('retains data, revokes invitations and handover, resumes as member; quotas retain membership',async()=>{
  const f=await fixture(); const {db,t}=f; try {
   await rpc(db,O,"set_member_role($1,$2,'admin')",[t.id,A]); await rpc(db,O,'request_owner_transfer($1,$2)',[t.id,A])
   const before=await data(db); await f.stop(); expect(await data(db)).toEqual(before)
   expect((await db.query('select role,suspended_at from public.team_members where team_id=$1 and user_id=$2',[t.id,A])).rows[0]).toMatchObject({role:'member',suspended_at:expect.anything()})
   expect((await db.query('select * from public.team_owner_transfers')).rows).toHaveLength(0)
   expect((await db.query('select revoked_at from public.guardian_invitations where player_id=$1 and used_at is null',[f.kid])).rows[0]?.revoked_at).toEqual(expect.anything())
   expect((await db.query('select * from public.team_members where team_id=$1',[t.id])).rows).toHaveLength(3)
   await rpc(db,O,'unblock_member($1,$2)',[t.id,A]); expect(await q(db,A,'select * from public.teams')).toEqual([])
   await rpc(db,O,'resume_member($1,$2)',[t.id,A]); expect(await data(db)).toEqual(before)
   expect((await db.query('select role,suspended_at from public.team_members where team_id=$1 and user_id=$2',[t.id,A])).rows[0]).toEqual({role:'member',suspended_at:null})
  }finally{await db.close()}
 })
 it('enforces owner-only actions and cannot stop owner, use forged session, or write tables',async()=>{
  const f=await fixture();const {db,t}=f;try{
   for(const u of [A,B,X]) for(const fn of ['suspend_member','resume_member']) await expect(rpc(db,u,`${fn}($1,$2)`,[t.id,A])).rejects.toThrow(/forbidden/)
   await expect(f.preview()).rejects.toThrow(/not_suspended/)
   await expect(rpc(db,O,'suspend_member($1,$2)',[t.id,O])).rejects.toThrow(/cannot_remove_owner/)
   await expect(q(db,O,'select public.suspend_member($1,$2)',[t.id,A],null)).rejects.toThrow(/session_expired/)
   await expect(q(db,A,'update public.team_members set suspended_at=null')).rejects.toThrow(/permission denied/)
   await f.stop(); await expect(rpc(db,O,'suspended_leave_preview($1)',[t.id])).rejects.toThrow(/not_suspended/)
  }finally{await db.close()}
 })
 it('denies every ordinary RLS read including self links and another device; active readers gain nothing',async()=>{
  const f=await fixture();const {db}=f;try{
   const tables=['teams','team_members','players','player_guardians','events','attendance','team_owner_transfers']
   const before=new Map();for(const table of tables) before.set(table,await q(db,B,`select to_jsonb(x)-'suspended_at'-'access_revision'-'role' as x from public.${table} x order by to_jsonb(x)::text`))
   await f.stop()
   expect(await q(db,A,'select id,player_id from public.guardian_invitations')).toEqual([])
   await expect(q(db,A,'select token_hash from public.guardian_invitations')).rejects.toThrow(/permission denied/)
   await db.query('insert into auth.sessions(id,user_id) values($1,$2)',['57000000-0000-4000-8000-000000000099',A])
   for(const table of tables){
    expect(await q(db,A,`select * from public.${table}`)).toEqual([])
    expect(await q(db,A,`select * from public.${table}`,[],'57000000-0000-4000-8000-000000000099')).toEqual([])
    const after=await q(db,B,`select to_jsonb(x)-'suspended_at'-'access_revision'-'role' as x from public.${table} x order by to_jsonb(x)::text`)
    expect(after).toEqual(before.get(table))
   }
   await rpc(db,B,"set_attendance($1,$2,'absent')",[f.ev,f.shared])
  }finally{await db.close()}
 })
 it('denies ordinary RPCs, old/new joins, early returns, invitations, roles and handover',async()=>{
  const f=await fixture();const {db,t}=f;try{
   await f.stop()
   const calls:[string,any[]][]=[
    ['get_team_by_share_token($1)',[t.share_token]],['resolve_legacy_team($1)',[t.share_token]],['preview_join($1)',[f.token]],
    ["join_team($1,'M')",[t.share_token]],["join_by_token($1,'M')",[f.token]],
    ["accept_guardian_invitation($1,'M')",[f.inv.token]],['create_guardian_invitation($1)',[f.shared]],
    ['revoke_guardian_invitation($1)',[f.pending.id]],['register_self($1)',[t.id]],["register_player($1,'New',null,true)",[t.id]],
    ["update_player($1,'X',null,true)",[f.kid]],['archive_player($1)',[f.kid]],["set_attendance($1,$2,'absent')",[f.ev,f.kid]],
    ["create_event($1,'New',now())",[t.id]],["update_event($1,'X',now(),null,null)",[f.ev]],['delete_event($1)',[f.ev]],
    ['get_join_link($1)',[t.id]],['rotate_join_token($1)',[t.id]],['set_join_open($1,true)',[t.id]],
    ["find_similar_players($1,'Solo')",[t.id]],['event_attendance_summary($1)',[f.ev]],
    ['leave_preview($1)',[t.id]],['leave_cleanup_preview($1)',[t.id]],['leave_team($1)',[t.id]],
    ["leave_team_with_cleanup($1,'forged','登録と出欠を削除して脱退する')",[t.id]],
    ['removal_preview($1,$2)',[t.id,B]],['remove_member($1,$2)',[t.id,B]],['blocked_members($1)',[t.id]],['unblock_member($1,$2)',[t.id,B]],
    ['request_owner_transfer($1,$2)',[t.id,B]],['cancel_owner_transfer($1)',[t.id]],['respond_owner_transfer($1,true)',[t.id]],["set_member_role($1,$2,'admin')",[t.id,B]],
    ["delete_team($1,'T')",[t.id]],
   ]
   for(const [s,p] of calls) await expect(rpc(db,A,s,p),s).rejects.toThrow(/suspended|forbidden|not_found|cannot_remove|permission denied|transfer_not_found/)
   await expect(rpc(db,O,"set_member_role($1,$2,'admin')",[t.id,A])).rejects.toThrow(/suspended/)
   await expect(rpc(db,O,'request_owner_transfer($1,$2)',[t.id,A])).rejects.toThrow(/suspended/)
   expect(await rpc(db,A,'my_owner_transfers()')).toEqual({incoming:[],outgoing:[]})
   const account=await rpc(db,A,'account_deletion_preview()'); expect(JSON.stringify(account)).not.toContain('Shared'); expect(account.teams_to_leave[0].team_name).toBeNull()
   await expect(rpc(db,X,"accept_guardian_invitation($1,'M')",[f.pending.token])).rejects.toThrow(/invitation_invalid/)
  }finally{await db.close()}
 })
 it('old removal cannot delete self registration or answers before or after suspension',async()=>{
  const f=await fixture();const {db,t}=f;try{
   const before=await data(db)
   await expect(rpc(db,O,'remove_member($1,$2)',[t.id,A])).rejects.toThrow(/confirmation_required|sole_guardian/)
   await f.stop();await expect(rpc(db,O,'remove_member($1,$2)',[t.id,A])).rejects.toThrow(/confirmation_required|sole_guardian/)
   expect(await data(db)).toEqual(before)
   // Removing only shared links is still non-destructive.
   await rpc(db,O,'remove_member($1,$2)',[t.id,B]); expect((await db.query('select id from public.players where id=$1',[f.shared])).rows).toHaveLength(1)
  }finally{await db.close()}
 })
 it('limited self cleanup deletes active/cancelled sole+own, preserves shared, blocks rejoin atomically',async()=>{
  const f=await fixture();const {db,t}=f;try{
   await rpc(db,A,'archive_player($1)',[f.kid]); await f.stop()
   // D6-B3: id, date and the CURRENT team name of the caller's own stopped membership; nothing else
   const mine=await q(db,A,'select * from public.my_suspended_memberships()')
   expect(mine).toEqual([{team_id:t.id,suspended_at:expect.anything(),team_name:'T'}])
   expect(Object.keys(mine[0]).sort()).toEqual(['suspended_at','team_id','team_name'])
   for(const u of [O,B,X])expect(await q(db,u,'select * from public.my_suspended_memberships()')).toEqual([])
   expect(await q(db,A,'select * from public.teams')).toEqual([])
   const pv=await f.preview(); expect(Object.keys(pv).sort()).toEqual(['deletions','fingerprint','links_removed_count']); expect(pv.deletions).toHaveLength(2)
   expect(pv.deletions.find((p:any)=>p.player_id===f.kid)).toMatchObject({cancelled:true,answers:1})
   expect(JSON.stringify(pv)).not.toMatch(/private comment|Shared|token|Owner/)
   await expect(rpc(db,O,"leave_suspended_team($1,$2,'登録と出欠を削除して脱退する')",[t.id,pv.fingerprint])).rejects.toThrow(/not_suspended/)
   await expect(f.leave('forged')).rejects.toThrow(/confirmation_stale/)
   await f.leave(pv.fingerprint)
   expect((await db.query('select id from public.players order by id')).rows).toEqual([{id:f.shared}])
   expect((await db.query('select * from public.attendance')).rows).toEqual([])
   expect((await db.query('select * from public.team_members where user_id=$1',[A])).rows).toEqual([])
   expect(await q(db,A,'select * from public.my_suspended_memberships()')).toEqual([])
   expect((await db.query('select * from auth.users where id=$1',[A])).rows).toHaveLength(1)
   await expect(rpc(db,A,"join_by_token($1,'M')",[f.token])).rejects.toThrow(/blocked_from_team/)
   await expect(f.leave(pv.fingerprint)).rejects.toThrow(/not_member/)
  }finally{await db.close()}
 })
 it.each(['answer','share-change','resume-stop'])('stale cleanup after %s leaves all data intact',async(kind)=>{
  const f=await fixture();const {db,t}=f;try{
   await rpc(db,B,"accept_guardian_invitation($1,'Family')",[(await rpc(db,A,'create_guardian_invitation($1)',[f.self])).token])
   await f.stop();const pv=await f.preview()
   if(kind==='answer')await rpc(db,B,"set_attendance($1,$2,'attend','changed')",[f.ev,f.self])
   if(kind==='share-change')await rpc(db,B,'leave_team($1)',[t.id])
   if(kind==='resume-stop'){await rpc(db,O,'resume_member($1,$2)',[t.id,A]);await f.stop()}
   const before=await data(db); await expect(f.leave(pv.fingerprint)).rejects.toThrow(/confirmation_stale/); expect(await data(db)).toEqual(before)
  }finally{await db.close()}
 })
 it('team deletion and owner purge still refuse suspended memberships; suspended user can purge',async()=>{
  const f=await fixture();const {db,t}=f;try{
   await rpc(db,B,'leave_team($1)',[t.id]);await f.stop()
   await expect(rpc(db,O,"delete_team($1,'T')",[t.id])).rejects.toThrow(/team_has_members/)
   await expect(db.query('select public.purge_account_data($1,$1)',[O])).rejects.toThrow(/owner_must_transfer/)
   await db.query('select public.purge_account_data($1,$1)',[A])
   expect((await db.query('select * from public.players')).rows).toHaveLength(0)
   await rpc(db,O,"delete_team($1,'T')",[t.id])
  }finally{await db.close()}
 })
 it.each(['none','shared','self-only'])('limited cleanup supports %s without sole proxies',async(kind)=>{
  const f=await fixture();const {db,t}=f;try{
   await db.query('delete from public.players where id=$1',[f.kid])
   if(kind!=='self-only')await db.query('delete from public.players where id=$1',[f.self])
   if(kind==='none')await db.query('delete from public.player_guardians where player_id=$1 and user_id=$2',[f.shared,A])
   if(kind==='self-only')await rpc(db,A,'archive_player($1)',[f.self])
   await f.stop();const pv=await f.preview()
   expect(pv.deletions).toHaveLength(kind==='self-only'?1:0)
   await expect(rpc(db,A,"leave_suspended_team($1,$2,'')",[t.id,pv.fingerprint])).rejects.toThrow(/confirm_required/)
   await f.leave(pv.fingerprint)
   expect((await db.query('select id from public.players')).rows).toEqual([{id:f.shared}])
  }finally{await db.close()}
 })
 it('rolls deletion back if block insertion fails; never touches another team',async()=>{
  const f=await fixture();const {db,t}=f;try{
   const other=await rpc(db,A,"create_team('Other','A')")
   await rpc(db,A,'register_self($1)',[other.id]);await f.stop();const pv=await f.preview();const before=await data(db)
   await db.exec("create function private.test_fail_block() returns trigger language plpgsql as $$begin raise exception 'injected_failure';end;$$; create trigger test_fail_block before insert on private.team_member_blocks for each row execute function private.test_fail_block();")
   await expect(f.leave(pv.fingerprint)).rejects.toThrow(/injected_failure/);expect(await data(db)).toEqual(before)
   expect((await db.query('select * from public.team_members where team_id=$1 and user_id=$2',[t.id,A])).rows).toHaveLength(1)
   expect(await q(db,A,'select id from public.teams')).toEqual([{id:other.id}])
   await db.exec('drop trigger test_fail_block on private.team_member_blocks; drop function private.test_fail_block();')
   await f.leave(pv.fingerprint)
   expect(await q(db,A,'select id from public.teams')).toEqual([{id:other.id}])
  }finally{await db.close()}
 })
 it('keeps privileged service APIs private and accounts usable outside the stopped team',async()=>{
  const f=await fixture();const {db,t}=f;try{
   await f.stop()
   for(const call of ['suspend_member($1,$2)','resume_member($1,$2)'])await expect(q(db,null,`select public.${call}`,[t.id,A])).rejects.toThrow(/permission denied/)
   await expect(q(db,A,'select private.assert_not_suspended($1,$2)',[t.id,A])).rejects.toThrow(/permission denied/)
   await expect(q(db,A,'select public.purge_account_data($1,$1)',[A])).rejects.toThrow(/permission denied/)
   await expect(q(db,A,"select public.note_account_deletion_failure($1,'x')",[A])).rejects.toThrow(/permission denied/)
   const other=await rpc(db,A,"create_team('Other','A')");expect(other.id).toBeTruthy()
   // Every authenticated public RPC is deliberately classified; additions require review.
   const names=(await db.query<{proname:string}>("select proname from pg_proc where pronamespace='public'::regnamespace and has_function_privilege('authenticated',oid,'execute') order by proname")).rows.map(x=>x.proname)
   expect(names).toEqual(`accept_guardian_invitation account_deletion_preview archive_player blocked_members cancel_owner_transfer create_event create_guardian_invitation create_team delete_event delete_team event_attendance_summary find_similar_players get_join_link join_by_token leave_cleanup_preview leave_preview leave_suspended_team leave_team leave_team_with_cleanup my_owner_transfers my_suspended_memberships preview_join register_player register_self removal_preview remove_member request_owner_transfer resolve_legacy_team respond_owner_transfer resume_member revoke_guardian_invitation rotate_join_token set_attendance set_join_open set_member_role suspend_member suspended_leave_preview unblock_member update_event update_player`.split(' '))
  }finally{await db.close()}
 })
 it('suspended memberships still exhaust the real team-size and joined-team limits',async()=>{
  const f=await fixture();const {db,t}=f;try{
   await f.stop()
   // Bulk fixtures use the database owner only; assertions exercise the real authenticated RPC.
   await db.query(`with users as (
    insert into auth.users(id) select gen_random_uuid() from generate_series(1,private.usage_limit('team_members')-3) returning id
   ) insert into public.team_members(team_id,user_id,display_name) select $1,id,'Filler' from users`,[t.id])
   await expect(rpc(db,X,"join_by_token($1,'X')",[f.token])).rejects.toThrow(/team_member_limit_exceeded/)
   await db.query(`with teams as (
    insert into public.teams(name,created_by) select 'Fixture',$1 from generate_series(1,private.usage_limit('teams_joined')-1) returning id
   ) insert into public.team_members(team_id,user_id,role,display_name)
    select id,$1,'owner','O' from teams union all select id,$2,'member','A' from teams`,[O,A])
   const other=await rpc(db,X,"create_team('New','X')")
   const otherLink=(await rpc(db,X,'get_join_link($1)',[other.id])).token   // D5: joining goes through the join link
   await expect(rpc(db,A,"join_by_token($1,'A')",[otherLink])).rejects.toThrow(/membership_limit_exceeded/)
  }finally{await db.close()}
 })
 it('rollback refuses live suspensions, restores functions and ACLs, reapplies',async()=>{
  const db=await createDb({before:MIG});try{
   const schema=async()=>(await db.query("select oid::regprocedure::text as f,prosrc,proacl::text from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace) order by 1")).rows
   const before=await schema();await applyMigration(db,MIG)
   for(const u of [O,A])await addUser(db,u)
   const t=await rpc(db,O,"create_team('T','O')");await rpc(db,A,"join_team($1,'A')",[t.share_token]);await rpc(db,O,'suspend_member($1,$2)',[t.id,A])
   await expect(db.exec(DOWN)).rejects.toThrow(/suspended_members_remain/);await db.exec('rollback')
   await rpc(db,O,'resume_member($1,$2)',[t.id,A]);await db.exec(DOWN);expect(await schema()).toEqual(before)
   await applyMigration(db,MIG);await rpc(db,O,'suspend_member($1,$2)',[t.id,A]);expect(await q(db,A,'select * from public.teams')).toEqual([])
  }finally{await db.close()}
 })
})
