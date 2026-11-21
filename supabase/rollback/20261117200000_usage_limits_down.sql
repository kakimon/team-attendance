-- =============================================================
-- Rollback of 20261117200000_usage_limits.sql (Phase 5-B U3).
-- Restores every function U3 replaced, verbatim from its previous migration:
--   join_team (init), get_team_by_share_token (phase1), preview_join / join_by_token (U2),
--   create_team (U1), register_player / create_event (init),
--   create_guardian_invitation / accept_guardian_invitation (phase4a);
-- then removes the join-attempt records and the helpers. App data is not touched.
-- Lost on rollback: the join-attempt records (user id + time).
-- =============================================================

create or replace function public.join_team(p_share_token text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  select id into v_team_id from public.teams where share_token = p_share_token;
  if v_team_id is null then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;  -- never changes an existing role
  return v_team_id;
end;
$$;

create or replace function public.get_team_by_share_token(p_share_token text)
returns table (id uuid, name text, is_member boolean, role text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_auth();
  return query
    select t.id, t.name, (m.user_id is not null), m.role
    from public.teams t
    left join public.team_members m on m.team_id = t.id and m.user_id = auth.uid()
    where t.share_token = p_share_token;
end;
$$;

create or replace function public.preview_join(p_token text)
returns table (team_id uuid, name text, is_member boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  if p_token is null or char_length(p_token) < 32 then return; end if;
  return query
    select t.id, t.name, exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = v_uid)
      from private.team_join_tokens j join public.teams t on t.id = j.team_id
     where j.token = p_token;
end;
$$;

drop function if exists public.join_by_token(text, text);  -- U3 returns jsonb; restore the U2 version (uuid)
create or replace function public.join_by_token(p_token text, p_display_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_team uuid;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'join_link_invalid' using errcode = 'P0002';
  end if;
  select team_id into v_team from private.team_join_tokens where token = p_token;
  if v_team is null then
    raise exception 'join_link_invalid' using errcode = 'P0002';
  end if;
  perform 1 from public.teams where id = v_team for share;            -- waits for a concurrent rotation
  if not exists (select 1 from private.team_join_tokens where team_id = v_team and token = p_token) then
    raise exception 'join_link_invalid' using errcode = 'P0002';      -- replaced or stopped meanwhile
  end if;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;
  return v_team;
end;
$$;

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

  insert into public.players (team_id, name, normalized_name, note, created_by)
  values (p_team_id, trim(p_name), private.normalize_name(p_name), nullif(trim(p_note), ''), v_uid)
  returning id into v_player_id;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_player_id, p_team_id, v_uid, 'registrant');

  return jsonb_build_object('status', 'created', 'player_id', v_player_id, 'similar', v_similar);
end;
$$;

create or replace function public.create_event(
  p_team_id uuid, p_title text, p_starts_at timestamptz,
  p_location text default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_id uuid;
begin
  if not private.is_team_admin(p_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.events (team_id, title, starts_at, location, note, created_by)
  values (p_team_id, trim(p_title), p_starts_at, nullif(trim(p_location), ''), nullif(trim(p_note), ''), v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

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
begin
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select team_id into v_team_id from public.players where id = p_player_id and archived_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';  -- cancelled child: no new family members
  end if;

  if (select count(*) from public.guardian_invitations
      where player_id = p_player_id and used_at is null and revoked_at is null
        and expires_at > now()) >= 5 then
    raise exception 'too_many_active_invitations' using errcode = '54000';
  end if;

  insert into public.guardian_invitations (team_id, player_id, token_hash, created_by, expires_at)
  values (v_team_id, p_player_id, private.hash_token(v_token), v_uid, v_expires)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

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

revoke execute on function public.join_by_token(text, text) from public, anon;
grant execute on function public.join_by_token(text, text) to authenticated;

delete from private.rate_events where kind = 'join_attempt';
alter table private.rate_events drop constraint if exists rate_events_kind_check;
alter table private.rate_events add constraint rate_events_kind_check check (kind in ('team_create'));

drop function if exists private.check_guardian_children(uuid, uuid);
drop function if exists private.check_new_membership(uuid, uuid);
drop function if exists private.record_join_attempt(uuid);
drop function if exists private.check_join_attempts(uuid);
drop function if exists private.xlock(text);
drop function if exists private.usage_limit(text);
