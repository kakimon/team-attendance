-- =============================================================
-- Phase 5-B U1: free-plan owner quota and team creation rate
--
--   * An account can OWN at most 3 teams (joining teams as a member is not limited here).
--   * An account can create at most 5 teams in any 24 hours (successful creations; the
--     record is kept even if the team is deleted later, so delete -> create loops count).
--   * Accepting an owner hand-over is refused when it would make the new owner own 4 teams.
--
-- Concurrency: create_team and respond_owner_transfer take the same per-user transaction
-- lock before counting, so two requests of one user (two creations, or a creation and an
-- acceptance) are serialised and cannot both pass the check.
--
-- Data safety:
--   * No existing row of the app tables is changed. Accounts that already own more than 3
--     teams keep them; only new creations / acceptances are refused.
--   * One private table is added (user id + time only) and filled with the creations of the
--     last 24 hours that can still be attributed (teams.created_by is set), so the rate limit
--     also covers teams created just before this migration.
--   * Rollback: supabase/rollback/20261117000000_owner_quota_down.sql
-- =============================================================

-- -------------------------------------------------------------
-- 1. Limits (one place; a future paid plan only changes owner_quota)
-- -------------------------------------------------------------
create or replace function private.owner_quota(p_user uuid)
returns int language sql immutable set search_path = ''
as $$ select 3 $$;

create or replace function private.team_create_limit_24h()
returns int language sql immutable set search_path = ''
as $$ select 5 $$;

-- Per-user lock shared by everything that can make the user an owner.
create or replace function private.lock_owner_quota(p_user uuid)
returns void language sql volatile set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended('owner-quota:' || p_user::text, 0)) $$;

-- -------------------------------------------------------------
-- 2. Successful team creations (rate limit). Only the user id and the time.
--    Not linked to the team, so the record survives the team's deletion.
--    Removed with the account (FK cascade) and pruned after 7 days by create_team.
-- -------------------------------------------------------------
create table if not exists private.rate_events (
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('team_create')),
  created_at timestamptz not null default now()
);
create index if not exists rate_events_user_kind_time on private.rate_events (user_id, kind, created_at);
alter table private.rate_events enable row level security;
revoke all on private.rate_events from public, anon, authenticated;

insert into private.rate_events (user_id, kind, created_at)
select t.created_by, 'team_create', t.created_at
  from public.teams t
 where t.created_by is not null and t.created_at > now() - interval '24 hours'
   and not exists (select 1 from private.rate_events r
                    where r.user_id = t.created_by and r.kind = 'team_create' and r.created_at = t.created_at);

-- -------------------------------------------------------------
-- 3. create_team with the checks (same signature and result as before)
--    Errors: owner_quota_exceeded / team_create_rate_limited (errcode 23514).
--    For the rate limit, DETAIL carries the time from which creating is possible again.
-- -------------------------------------------------------------
create or replace function public.create_team(p_name text, p_display_name text)
returns public.teams
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team public.teams;
  v_owned int;
  v_recent int;
  v_next timestamptz;
begin
  perform private.lock_owner_quota(v_uid);

  select count(*) into v_owned from public.team_members where user_id = v_uid and role = 'owner';
  if v_owned >= private.owner_quota(v_uid) then
    raise exception 'owner_quota_exceeded' using errcode = '23514';
  end if;

  select count(*), min(created_at) + interval '24 hours' into v_recent, v_next
    from private.rate_events
   where user_id = v_uid and kind = 'team_create' and created_at > now() - interval '24 hours';
  if v_recent >= private.team_create_limit_24h() then
    raise exception 'team_create_rate_limited' using errcode = '23514', detail = v_next::text;
  end if;

  insert into public.teams (name, created_by) values (trim(p_name), v_uid)
  returning * into v_team;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team.id, v_uid, 'owner', trim(p_display_name));

  insert into private.rate_events (user_id, kind) values (v_uid, 'team_create');
  delete from private.rate_events
   where user_id = v_uid and kind = 'team_create' and created_at < now() - interval '7 days';
  return v_team;
end;
$$;

-- -------------------------------------------------------------
-- 4. Owner hand-over: the new owner may not exceed the quota.
--    Same behaviour as before otherwise. On owner_quota_exceeded the whole call is rolled
--    back, so the request stays open (until it expires) and can be accepted after the
--    recipient has freed a slot.
-- -------------------------------------------------------------
create or replace function public.respond_owner_transfer(p_team_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_t public.team_owner_transfers;
begin
  perform private.lock_owner_quota(v_uid);                         -- user lock first ...
  perform 1 from public.teams where id = p_team_id for update;     -- ... then the team (one hand-over at a time)
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
  if (select count(*) from public.team_members where user_id = v_uid and role = 'owner') >= private.owner_quota(v_uid) then
    raise exception 'owner_quota_exceeded' using errcode = '23514';
  end if;
  update public.team_members set role = 'member' where team_id = p_team_id and user_id = v_t.from_user; -- demote first
  update public.team_members set role = 'owner'  where team_id = p_team_id and user_id = v_uid;         -- then promote
  return jsonb_build_object('status', 'accepted');
end;
$$;

-- -------------------------------------------------------------
-- 5. Privileges: the helpers are internal (browsers cannot call them).
--    create_team / respond_owner_transfer keep their existing grants (create or replace).
-- -------------------------------------------------------------
revoke execute on function private.owner_quota(uuid) from public, anon, authenticated;
revoke execute on function private.team_create_limit_24h() from public, anon, authenticated;
revoke execute on function private.lock_owner_quota(uuid) from public, anon, authenticated;
