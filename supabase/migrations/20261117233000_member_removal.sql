-- =============================================================
-- Phase 5-B U4 (D4): removing a member, leaving a team, refusing re-joins, deleting a team
--
--   remove_member(team, user)   owner only; never the owner; adds the user to the team's block list
--   leave_team(team)            the caller; owners cannot leave (hand over or delete the team first)
--   unblock_member(team, user)  owner only
--   blocked_members(team)       owner only: user id + date (no names are stored)
--   leave_preview(team) / removal_preview(team, user): what the operation will do
--   delete_team(team, name)     owner only, only when nobody else is a member
--
-- What happens to the registrations of the person who goes (this team only):
--   * their own self registration (self_user_id = them): deleted with its answers, proxy links and
--     invitations, even when a proxy is linked
--   * other registrations they answer for, with another guardian: only their link is removed
--   * a registration (e.g. a child) for which they are the ONLY guardian: the whole operation is
--     REFUSED (sole_guardian_children) until the deletion policy for children is decided
--   * their unused family invitations and hand-over requests in this team are deleted
--   Recorder columns (created_by etc.) are left as they are (only account deletion clears them).
-- Everything is one transaction: any failure rolls the whole operation back.
--
-- Re-joining: blocked users are refused in private.check_new_membership, which every path that
-- adds a membership uses (old join_team, join_by_token, accepting a family invitation).
--
-- Locks (same order as U1/U3): account (membership:<user>) -> team members (team-members:<team>)
-- -> team row FOR UPDATE -> the affected players rows FOR UPDATE in id order.
--
-- Additive: one private table and new functions; check_new_membership gains the block check.
-- Rollback: supabase/rollback/20261117233000_member_removal_down.sql
-- =============================================================

-- -------------------------------------------------------------
-- 1. Block list (ids and time only; goes with the team or the account)
-- -------------------------------------------------------------
create table if not exists private.team_member_blocks (
  team_id    uuid not null references public.teams(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
alter table private.team_member_blocks enable row level security;
revoke all on private.team_member_blocks from public, anon, authenticated;

-- -------------------------------------------------------------
-- 2. Every new membership checks the block list first (U3 helper + block check)
-- -------------------------------------------------------------
create or replace function private.check_new_membership(p_user uuid, p_team uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.xlock('membership:' || p_user::text);
  perform private.xlock('team-members:' || p_team::text);
  if exists (select 1 from private.team_member_blocks where team_id = p_team and user_id = p_user) then
    raise exception 'blocked_from_team' using errcode = '42501';
  end if;
  if (select count(*) from public.team_members where user_id = p_user) >= private.usage_limit('teams_joined') then
    raise exception 'membership_limit_exceeded' using errcode = '23514';
  end if;
  if (select count(*) from public.team_members where team_id = p_team) >= private.usage_limit('team_members') then
    raise exception 'team_member_limit_exceeded' using errcode = '23514';
  end if;
end;
$$;

-- -------------------------------------------------------------
-- 3. Impact of a person leaving a team (read only; used by the previews and the operations)
-- -------------------------------------------------------------
create or replace function private.member_impact(p_team uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'self_registrations', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name,
        'answers', (select count(*) from public.attendance a where a.player_id = p.id)) order by p.name)
      from public.players p where p.team_id = p_team and p.self_user_id = p_user), '[]'),
    'links_removed', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name) order by p.name)
      from public.players p
      where p.team_id = p_team and p.self_user_id is distinct from p_user
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = p_user)
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> p_user)), '[]'),
    'sole_guardian_children', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'cancelled', p.archived_at is not null) order by p.name)
      from public.players p
      where p.team_id = p_team and p.self_user_id is distinct from p_user
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = p_user)
        and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> p_user)), '[]'));
$$;

-- Takes the locks, then removes p_user from p_team. Caller has checked the permissions.
create or replace function private.detach_member(p_team uuid, p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare v_impact jsonb; n_self int; n_links int; n_inv int;
begin
  perform 1 from public.players p
   where p.team_id = p_team
     and (p.self_user_id = p_user
          or exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = p_user))
   order by p.id for update;
  v_impact := private.member_impact(p_team, p_user);
  if jsonb_array_length(v_impact -> 'sole_guardian_children') > 0 then
    raise exception 'sole_guardian_children' using errcode = '23514', detail = (v_impact -> 'sole_guardian_children')::text;
  end if;
  with d as (delete from public.players where team_id = p_team and self_user_id = p_user returning 1)
  select count(*) into n_self from d;                                   -- answers, links, invitations cascade
  with d as (delete from public.guardian_invitations where team_id = p_team and created_by = p_user and used_at is null returning 1)
  select count(*) into n_inv from d;
  with d as (delete from public.player_guardians where team_id = p_team and user_id = p_user returning 1)
  select count(*) into n_links from d;
  delete from public.team_owner_transfers where team_id = p_team and (from_user = p_user or to_user = p_user);
  delete from public.team_members where team_id = p_team and user_id = p_user;
  return jsonb_build_object('self_registrations_deleted', n_self, 'links_removed', n_links, 'invitations_deleted', n_inv);
end;
$$;

-- -------------------------------------------------------------
-- 4. Owner: remove a member (and block re-joining)
-- -------------------------------------------------------------
create or replace function public.remove_member(p_team_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_role text; v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  perform private.xlock('membership:' || p_user_id::text);
  perform private.xlock('team-members:' || p_team_id::text);
  perform 1 from public.teams where id = p_team_id for update;
  if not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select role into v_role from public.team_members where team_id = p_team_id and user_id = p_user_id;
  if v_role is null then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if v_role = 'owner' or p_user_id = v_uid then
    raise exception 'cannot_remove_owner' using errcode = '42501';
  end if;
  v_result := private.detach_member(p_team_id, p_user_id);
  insert into private.team_member_blocks (team_id, user_id) values (p_team_id, p_user_id)
  on conflict (team_id, user_id) do nothing;
  return v_result || jsonb_build_object('status', 'removed');
end;
$$;

create or replace function public.removal_preview(p_team_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  if not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.team_members where team_id = p_team_id and user_id = p_user_id and role <> 'owner') then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  return private.member_impact(p_team_id, p_user_id);
end;
$$;

create or replace function public.unblock_member(p_team_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_n int;
begin
  if not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with d as (delete from private.team_member_blocks where team_id = p_team_id and user_id = p_user_id returning 1)
  select count(*) into v_n from d;
  return v_n > 0;
end;
$$;

create or replace function public.blocked_members(p_team_id uuid)
returns table (user_id uuid, blocked_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  if not exists (select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = v_uid and m.role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select b.user_id, b.created_at from private.team_member_blocks b where b.team_id = p_team_id order by b.created_at;
end;
$$;

-- -------------------------------------------------------------
-- 5. Member: leave a team (no block)
-- -------------------------------------------------------------
create or replace function public.leave_team(p_team_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_role text; v_result jsonb;
begin
  perform private.xlock('membership:' || v_uid::text);
  perform private.xlock('team-members:' || p_team_id::text);
  perform 1 from public.teams where id = p_team_id for update;
  select role into v_role from public.team_members where team_id = p_team_id and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member' using errcode = 'P0002';
  end if;
  if v_role = 'owner' then
    raise exception 'owner_cannot_leave' using errcode = '42501';
  end if;
  v_result := private.detach_member(p_team_id, v_uid);
  return v_result || jsonb_build_object('status', 'left');
end;
$$;

create or replace function public.leave_preview(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_role text;
begin
  select role into v_role from public.team_members where team_id = p_team_id and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member' using errcode = 'P0002';
  end if;
  return private.member_impact(p_team_id, v_uid) || jsonb_build_object('is_owner', v_role = 'owner');
end;
$$;

-- -------------------------------------------------------------
-- 6. Owner: delete a team in which nobody else is a member (frees the owner slot at once;
--    the 24-hour creation records are kept)
-- -------------------------------------------------------------
create or replace function public.delete_team(p_team_id uuid, p_confirm_name text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_name text;
begin
  perform private.lock_owner_quota(v_uid);
  perform private.xlock('membership:' || v_uid::text);
  perform private.xlock('team-members:' || p_team_id::text);
  select name into v_name from public.teams where id = p_team_id for update;
  if v_name is null
     or not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.team_members where team_id = p_team_id and user_id <> v_uid) then
    raise exception 'team_has_members' using errcode = '23514';
  end if;
  if p_confirm_name is null or trim(p_confirm_name) <> v_name then
    raise exception 'confirm_mismatch' using errcode = '22023';
  end if;
  delete from public.teams where id = p_team_id;                      -- everything in the team cascades
  return jsonb_build_object('status', 'deleted');
end;
$$;

-- -------------------------------------------------------------
-- 7. Privileges
-- -------------------------------------------------------------
revoke execute on function private.member_impact(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.detach_member(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
revoke execute on function public.removal_preview(uuid, uuid) from public, anon;
revoke execute on function public.unblock_member(uuid, uuid) from public, anon;
revoke execute on function public.blocked_members(uuid) from public, anon;
revoke execute on function public.leave_team(uuid) from public, anon;
revoke execute on function public.leave_preview(uuid) from public, anon;
revoke execute on function public.delete_team(uuid, text) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.removal_preview(uuid, uuid) to authenticated;
grant execute on function public.unblock_member(uuid, uuid) to authenticated;
grant execute on function public.blocked_members(uuid) to authenticated;
grant execute on function public.leave_team(uuid) to authenticated;
grant execute on function public.leave_preview(uuid) to authenticated;
grant execute on function public.delete_team(uuid, text) to authenticated;
