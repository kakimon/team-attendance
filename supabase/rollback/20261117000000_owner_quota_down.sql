-- =============================================================
-- Rollback of 20261117000000_owner_quota.sql (Phase 5-B U1).
-- Restores create_team (as in 20261107000000_init.sql) and respond_owner_transfer
-- (as in 20261113000000_account_deletion.sql) verbatim, then removes what U1 added.
-- App data is not touched. Lost on rollback: the creation records (user id + time) used
-- for the 24-hour limit.
-- =============================================================

create or replace function public.create_team(p_name text, p_display_name text)
returns public.teams
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team public.teams;
begin
  insert into public.teams (name, created_by) values (trim(p_name), v_uid)
  returning * into v_team;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team.id, v_uid, 'owner', trim(p_display_name));
  return v_team;
end;
$$;

create or replace function public.respond_owner_transfer(p_team_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_t public.team_owner_transfers;
begin
  perform 1 from public.teams where id = p_team_id for update;   -- one hand-over at a time
  select * into v_t from public.team_owner_transfers where team_id = p_team_id and to_user = v_uid;
  if v_t.team_id is null then
    raise exception 'transfer_not_found' using errcode = 'P0002';
  end if;
  delete from public.team_owner_transfers where team_id = p_team_id;
  if v_t.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if not coalesce(p_accept, false) then
    return jsonb_build_object('status', 'declined');
  end if;
  if not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_t.from_user and role = 'owner')
     or not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_uid) then
    return jsonb_build_object('status', 'stale');
  end if;
  update public.team_members set role = 'member' where team_id = p_team_id and user_id = v_t.from_user; -- demote first
  update public.team_members set role = 'owner'  where team_id = p_team_id and user_id = v_uid;         -- then promote
  return jsonb_build_object('status', 'accepted');
end;
$$;

drop function if exists private.lock_owner_quota(uuid);
drop function if exists private.team_create_limit_24h();
drop function if exists private.owner_quota(uuid);
drop table if exists private.rate_events;
