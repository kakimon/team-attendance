-- =============================================================
-- Rollback of 20261117233000_member_removal.sql (Phase 5-B U4).
-- Removes the U4 functions and the block list, and restores private.check_new_membership
-- verbatim from 20261117200000_usage_limits.sql. App data is not touched.
-- Lost on rollback: the block list (removed users can join again).
-- =============================================================
drop function if exists public.delete_team(uuid, text);
drop function if exists public.leave_preview(uuid);
drop function if exists public.leave_team(uuid);
drop function if exists public.blocked_members(uuid);
drop function if exists public.unblock_member(uuid, uuid);
drop function if exists public.removal_preview(uuid, uuid);
drop function if exists public.remove_member(uuid, uuid);
drop function if exists private.detach_member(uuid, uuid);
drop function if exists private.member_impact(uuid, uuid);

create or replace function private.check_new_membership(p_user uuid, p_team uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.xlock('membership:' || p_user::text);
  perform private.xlock('team-members:' || p_team::text);
  if (select count(*) from public.team_members where user_id = p_user) >= private.usage_limit('teams_joined') then
    raise exception 'membership_limit_exceeded' using errcode = '23514';
  end if;
  if (select count(*) from public.team_members where team_id = p_team) >= private.usage_limit('team_members') then
    raise exception 'team_member_limit_exceeded' using errcode = '23514';
  end if;
end;
$$;

drop table if exists private.team_member_blocks;
