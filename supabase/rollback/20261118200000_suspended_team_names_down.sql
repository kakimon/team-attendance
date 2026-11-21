-- Rollback of D6-B3 (20261118200000_suspended_team_names.sql): restores my_suspended_memberships
-- exactly as D6-B1 (20261118100000_member_suspension.sql) defined it, with the same grants.
-- Roll this back BEFORE 20261118100000_member_suspension_down.sql (newest first).
begin;
drop function public.my_suspended_memberships();
-- No team names, schedules, other members, notes, comments or invitation credentials.
create function public.my_suspended_memberships()
returns table(team_id uuid,suspended_at timestamptz) language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_auth();
begin
 return query select m.team_id,m.suspended_at from public.team_members m where m.user_id=v_uid and m.suspended_at is not null order by m.team_id;
end;
$$;
revoke all on function public.my_suspended_memberships() from public,anon;
grant execute on function public.my_suspended_memberships() to authenticated;
commit;
