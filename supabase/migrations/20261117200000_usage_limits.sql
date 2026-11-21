-- =============================================================
-- Phase 5-B U3 (D3): usage limits (abuse protection)
--
--   per account : teams joined (incl. owned) 50 · family invitations created 20 / 24 h
--                 · join attempts 30 / hour
--   per team    : members 300 · children (active) 500 · events (active) 2,000
--                 · events created 100 / 24 h
--   per guardian: children (active) in one team 20
--   per child   : active family invitations 5 (existed already; now also safe under concurrency)
--
-- Every write path that adds a membership, a child, a guardian link, an event or an invitation
-- is covered: join_team (old path, kept until D5), join_by_token, accept_guardian_invitation,
-- create_team, register_player, create_event, create_guardian_invitation.
-- Owner hand-over and role changes add no membership and are not limited here.
--
-- Counting
--   * Successful creations are counted from the rows themselves (events.created_at,
--     guardian_invitations.created_at). Events and invitations are never hard-deleted by the
--     app (events: deleted_at; invitations: used/revoked), so deleting does not reset a window.
--   * Join attempts are recorded in private.rate_events (kind 'join_attempt', user id + time):
--     every successful new membership, and every lookup of a team by a non-member through
--     preview_join / get_team_by_share_token (whether the token is valid or not).
--     A call that ends in an error is rolled back as a whole, so join_by_token RETURNS
--     { status: 'invalid' } for a wrong token (recorded). The old join_team keeps its contract
--     (raises team_not_found), so its wrong-token calls are not recorded until D5 removes it.
--   * All windows use now() (the database's transaction time).
--
-- Concurrency: per-account and per-team transaction locks (pg_advisory_xact_lock) are taken
-- BEFORE counting, always in the order account -> team -> child, so parallel requests cannot
-- pass the same check twice.
--
-- Existing data is not changed. Teams / accounts already above a limit keep everything;
-- only new additions are refused.
-- Rollback: supabase/rollback/20261117200000_usage_limits_down.sql
-- =============================================================

-- -------------------------------------------------------------
-- 1. Limits in one place
-- -------------------------------------------------------------
create or replace function private.usage_limit(p_name text)
returns int language sql immutable set search_path = ''
as $$
  select case p_name
    when 'teams_joined'         then 50
    when 'team_members'         then 300
    when 'team_children'        then 500
    when 'guardian_children'    then 20
    when 'team_events'          then 2000
    when 'events_created_24h'   then 100
    when 'invites_created_24h'  then 20
    when 'child_active_invites' then 5
    when 'join_attempts_1h'     then 30
  end
$$;

create or replace function private.xlock(p_key text)
returns void language sql volatile set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended(p_key, 0)) $$;

-- -------------------------------------------------------------
-- 2. Join attempts (user id + time only, in the U1 table; pruned after 1 day)
-- -------------------------------------------------------------
alter table private.rate_events drop constraint if exists rate_events_kind_check;
alter table private.rate_events add constraint rate_events_kind_check check (kind in ('team_create', 'join_attempt'));

-- Raises join_attempt_rate_limited (DETAIL = when it is possible again) at 30 per hour.
create or replace function private.check_join_attempts(p_user uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare v_n int; v_next timestamptz;
begin
  select count(*), min(created_at) + interval '1 hour' into v_n, v_next
    from private.rate_events
   where user_id = p_user and kind = 'join_attempt' and created_at > now() - interval '1 hour';
  if v_n >= private.usage_limit('join_attempts_1h') then
    raise exception 'join_attempt_rate_limited' using errcode = '23514', detail = v_next::text;
  end if;
end;
$$;

create or replace function private.record_join_attempt(p_user uuid)
returns void language sql volatile security definer set search_path = ''
as $$
  insert into private.rate_events (user_id, kind) values (p_user, 'join_attempt');
  delete from private.rate_events where user_id = p_user and kind = 'join_attempt' and created_at < now() - interval '1 day';
$$;

-- Before adding p_user to p_team (not yet a member): account and team locks, then the limits.
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

-- Before p_user becomes guardian of one more active child in p_team.
create or replace function private.check_guardian_children(p_user uuid, p_team uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.xlock('membership:' || p_user::text);
  if (select count(*) from public.player_guardians g join public.players p on p.id = g.player_id
       where g.user_id = p_user and g.team_id = p_team and p.archived_at is null) >= private.usage_limit('guardian_children') then
    raise exception 'guardian_child_limit_exceeded' using errcode = '23514';
  end if;
end;
$$;

-- -------------------------------------------------------------
-- 3. Joining (old path kept until D5, new path from U2)
-- -------------------------------------------------------------
create or replace function public.join_team(p_share_token text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  perform private.check_join_attempts(v_uid);
  select id into v_team_id from public.teams where share_token = p_share_token;
  if v_team_id is null then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.team_members where team_id = v_team_id and user_id = v_uid) then
    return v_team_id;                                                   -- already a member: unchanged
  end if;
  perform private.check_new_membership(v_uid, v_team_id);
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;  -- never changes an existing role
  perform private.record_join_attempt(v_uid);
  return v_team_id;
end;
$$;

-- Old preview (team page / join prompt of the published app). Members are never counted.
create or replace function public.get_team_by_share_token(p_share_token text)
returns table (id uuid, name text, is_member boolean, role text)
language plpgsql volatile security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  if not exists (select 1 from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = v_uid
                  where t.share_token = p_share_token) then
    perform private.check_join_attempts(v_uid);
    perform private.record_join_attempt(v_uid);
  end if;
  return query
    select t.id, t.name, (m.user_id is not null), m.role
    from public.teams t
    left join public.team_members m on m.team_id = t.id and m.user_id = v_uid
    where t.share_token = p_share_token;
end;
$$;

create or replace function public.preview_join(p_token text)
returns table (team_id uuid, name text, is_member boolean)
language plpgsql volatile security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  if not exists (select 1 from private.team_join_tokens j join public.team_members m on m.team_id = j.team_id and m.user_id = v_uid
                  where p_token is not null and j.token = p_token) then
    perform private.check_join_attempts(v_uid);                     -- unknown token or not a member: counted
    perform private.record_join_attempt(v_uid);
  end if;
  if p_token is null or char_length(p_token) < 32 then return; end if;
  return query
    select t.id, t.name, exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = v_uid)
      from private.team_join_tokens j join public.teams t on t.id = j.team_id
     where j.token = p_token;
end;
$$;

-- New path. Result (jsonb) instead of uuid:
--   { status: 'joined',         team_id }   new membership
--   { status: 'already_member', team_id }   unchanged (role is never changed)
--   { status: 'invalid' }                   unknown, replaced or stopped token. Returned (not raised)
--                                           so that the try is RECORDED as a join attempt. The answer is
--                                           the same for every kind of invalid token (nothing leaks).
-- Still raised (and therefore not recorded): not_authenticated / session_expired,
-- join_attempt_rate_limited, membership_limit_exceeded, team_member_limit_exceeded,
-- account_deletion_pending, and any unexpected database error (never turned into 'invalid').
-- A successful join is NOT recorded here: the join screen calls preview_join first, which already
-- counts the lookup (avoids counting one join twice). Wrong tokens are counted here.
drop function if exists public.join_by_token(text, text);
create function public.join_by_token(p_token text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_team uuid;
begin
  perform private.check_join_attempts(v_uid);
  if p_token is not null and char_length(p_token) >= 32 then
    select team_id into v_team from private.team_join_tokens where token = p_token;
  end if;
  if v_team is null then
    perform private.record_join_attempt(v_uid);
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (select 1 from public.team_members where team_id = v_team and user_id = v_uid) then
    return jsonb_build_object('status', 'already_member', 'team_id', v_team);
  end if;
  perform private.check_new_membership(v_uid, v_team);               -- account + team locks, limits
  perform 1 from public.teams where id = v_team for share;            -- waits for a concurrent rotation
  if not exists (select 1 from private.team_join_tokens where team_id = v_team and token = p_token) then
    perform private.record_join_attempt(v_uid);                       -- replaced or stopped meanwhile
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;
  return jsonb_build_object('status', 'joined', 'team_id', v_team);
end;
$$;
revoke execute on function public.join_by_token(text, text) from public, anon;
grant execute on function public.join_by_token(text, text) to authenticated;

-- -------------------------------------------------------------
-- 4. Creating a team also adds a membership (owner)
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
  perform private.xlock('membership:' || v_uid::text);

  select count(*) into v_owned from public.team_members where user_id = v_uid and role = 'owner';
  if v_owned >= private.owner_quota(v_uid) then
    raise exception 'owner_quota_exceeded' using errcode = '23514';
  end if;
  if (select count(*) from public.team_members where user_id = v_uid) >= private.usage_limit('teams_joined') then
    raise exception 'membership_limit_exceeded' using errcode = '23514';
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
-- 5. Children
-- -------------------------------------------------------------
create or replace function public.register_player(
  p_team_id uuid, p_name text, p_note text default null, p_confirm_similar boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_similar jsonb;
  v_player_id uuid;
begin
  if not private.is_team_member(p_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'note', s.note)), '[]'::jsonb)
    into v_similar
    from public.find_similar_players(p_team_id, p_name) s;

  if jsonb_array_length(v_similar) > 0 and not p_confirm_similar then
    return jsonb_build_object('status', 'similar_found', 'similar', v_similar);
  end if;

  perform private.check_guardian_children(v_uid, p_team_id);         -- account lock + 20 per guardian
  perform private.xlock('team-children:' || p_team_id::text);
  if (select count(*) from public.players where team_id = p_team_id and archived_at is null) >= private.usage_limit('team_children') then
    raise exception 'team_child_limit_exceeded' using errcode = '23514';
  end if;

  insert into public.players (team_id, name, normalized_name, note, created_by)
  values (p_team_id, trim(p_name), private.normalize_name(p_name), nullif(trim(p_note), ''), v_uid)
  returning id into v_player_id;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_player_id, p_team_id, v_uid, 'registrant');

  return jsonb_build_object('status', 'created', 'player_id', v_player_id, 'similar', v_similar);
end;
$$;

-- -------------------------------------------------------------
-- 6. Events
-- -------------------------------------------------------------
create or replace function public.create_event(
  p_team_id uuid, p_title text, p_starts_at timestamptz,
  p_location text default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_id uuid;
  v_recent int;
  v_next timestamptz;
begin
  if not private.is_team_admin(p_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.xlock('team-events:' || p_team_id::text);
  if (select count(*) from public.events where team_id = p_team_id and deleted_at is null) >= private.usage_limit('team_events') then
    raise exception 'team_event_limit_exceeded' using errcode = '23514';
  end if;
  select count(*), min(created_at) + interval '24 hours' into v_recent, v_next
    from public.events where team_id = p_team_id and created_at > now() - interval '24 hours';   -- deleted ones count too
  if v_recent >= private.usage_limit('events_created_24h') then
    raise exception 'event_create_rate_limited' using errcode = '23514', detail = v_next::text;
  end if;
  insert into public.events (team_id, title, starts_at, location, note, created_by)
  values (p_team_id, trim(p_title), p_starts_at, nullif(trim(p_location), ''), nullif(trim(p_note), ''), v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

-- -------------------------------------------------------------
-- 7. Family invitations
-- -------------------------------------------------------------
create or replace function public.create_guardian_invitation(p_player_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
  v_token text := private.random_token();
  v_expires timestamptz := now() + interval '24 hours';
  v_id uuid;
  v_recent int;
  v_next timestamptz;
begin
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select team_id into v_team_id from public.players where id = p_player_id and archived_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';  -- cancelled child: no new family members
  end if;

  perform private.xlock('invites:' || v_uid::text);
  perform private.xlock('child-invites:' || p_player_id::text);
  select count(*), min(created_at) + interval '24 hours' into v_recent, v_next
    from public.guardian_invitations where created_by = v_uid and created_at > now() - interval '24 hours';
  if v_recent >= private.usage_limit('invites_created_24h') then
    raise exception 'invite_create_rate_limited' using errcode = '23514', detail = v_next::text;
  end if;

  if (select count(*) from public.guardian_invitations
      where player_id = p_player_id and used_at is null and revoked_at is null
        and expires_at > now()) >= private.usage_limit('child_active_invites') then
    raise exception 'too_many_active_invitations' using errcode = '54000';
  end if;

  insert into public.guardian_invitations (team_id, player_id, token_hash, created_by, expires_at)
  values (v_team_id, p_player_id, private.hash_token(v_token), v_uid, v_expires)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

-- Accepting: a new membership (if not yet a member) and one more child for this guardian.
create or replace function public.accept_guardian_invitation(p_token text, p_display_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_inv public.guardian_invitations;
  v_player public.players;
  v_share text;
begin
  select * into v_inv from public.guardian_invitations
  where token_hash = private.hash_token(p_token);
  if v_inv.id is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  select * into v_player from public.players where id = v_inv.player_id and archived_at is null;
  if v_player.id is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';  -- child was cancelled
  end if;
  select share_token into v_share from public.teams where id = v_inv.team_id;

  if exists (select 1 from public.player_guardians
             where player_id = v_inv.player_id and user_id = v_uid) then
    return jsonb_build_object('status', 'already_guardian', 'player_id', v_player.id,
      'player_name', v_player.name, 'team_id', v_inv.team_id, 'share_token', v_share);
  end if;

  if not exists (select 1 from public.team_members where team_id = v_inv.team_id and user_id = v_uid) then
    perform private.check_new_membership(v_uid, v_inv.team_id);
  end if;
  perform private.check_guardian_children(v_uid, v_inv.team_id);

  update public.guardian_invitations
     set used_at = now(), used_by = v_uid
   where id = v_inv.id and used_at is null and revoked_at is null and expires_at > now()
  returning * into v_inv;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_inv.team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_inv.player_id, v_inv.team_id, v_uid, 'invitation');

  return jsonb_build_object('status', 'accepted', 'player_id', v_player.id,
    'player_name', v_player.name, 'team_id', v_inv.team_id, 'share_token', v_share);
end;
$$;

-- -------------------------------------------------------------
-- 8. Privileges: helpers are internal. Replaced public functions keep their grants.
-- -------------------------------------------------------------
revoke execute on function private.usage_limit(text) from public, anon, authenticated;
revoke execute on function private.xlock(text) from public, anon, authenticated;
revoke execute on function private.check_join_attempts(uuid) from public, anon, authenticated;
revoke execute on function private.record_join_attempt(uuid) from public, anon, authenticated;
revoke execute on function private.check_new_membership(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.check_guardian_children(uuid, uuid) from public, anon, authenticated;
