-- Rollback of Phase 5-B U4-Fix (20261117234500_member_lock_fix.sql).
-- Restores the seven functions exactly as the earlier migrations last defined them
-- (signatures and grants are unchanged by U4-Fix, so CREATE OR REPLACE keeps the grants).
--   set_attendance             <- 20261110000000_phase4a.sql
--   register_player            <- 20261117200000_usage_limits.sql
--   accept_guardian_invitation <- 20261117200000_usage_limits.sql
--   register_self, update_player, archive_player, create_guardian_invitation
--                              <- 20261117230000_self_registration.sql
begin;

create or replace function public.set_attendance(
  p_event_id uuid, p_player_id uuid, p_status text, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  if p_status not in ('attend', 'absent', 'undecided', 'unanswered') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select e.team_id into v_team_id
  from public.events e
  join public.players p on p.team_id = e.team_id
  where e.id = p_event_id and e.deleted_at is null
    and p.id = p_player_id and p.archived_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- The core rule: only this child's guardians can write.
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_status = 'unanswered' then
    delete from public.attendance where event_id = p_event_id and player_id = p_player_id;
  else
    insert into public.attendance (event_id, player_id, team_id, status, comment, updated_by, updated_at)
    values (p_event_id, p_player_id, v_team_id, p_status, nullif(trim(p_comment), ''), v_uid, now())
    on conflict (event_id, player_id) do update
      set status = excluded.status, comment = excluded.comment,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
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

create or replace function public.register_self(p_team_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_name text;
  v_player public.players;
begin
  select display_name into v_name from public.team_members where team_id = p_team_id and user_id = v_uid;
  if v_name is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.check_guardian_children(v_uid, p_team_id);         -- account lock + 20 per person (U3)
  perform private.xlock('team-children:' || p_team_id::text);
  select * into v_player from public.players where team_id = p_team_id and self_user_id = v_uid;
  if v_player.id is not null and v_player.archived_at is null then
    return jsonb_build_object('status', 'existing', 'player_id', v_player.id);
  end if;
  if (select count(*) from public.players where team_id = p_team_id and archived_at is null) >= private.usage_limit('team_children') then
    raise exception 'team_child_limit_exceeded' using errcode = '23514';
  end if;
  if v_player.id is not null then                                      -- cancelled before: restore it
    update public.players set archived_at = null, archived_by = null, updated_at = now(), updated_by = v_uid
     where id = v_player.id;
    return jsonb_build_object('status', 'restored', 'player_id', v_player.id);
  end if;
  insert into public.players (team_id, name, normalized_name, note, created_by, is_self, self_user_id)
  values (p_team_id, v_name, private.normalize_name(v_name), null, v_uid, true, v_uid)
  returning * into v_player;
  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_player.id, p_team_id, v_uid, 'registrant');
  return jsonb_build_object('status', 'created', 'player_id', v_player.id);
end;
$$;

create or replace function public.update_player(
  p_player_id uuid, p_name text, p_note text default null, p_confirm_similar boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
  v_similar jsonb;
begin
  select team_id into v_team_id from public.players where id = p_player_id and archived_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- A registration as a person (D3.5) is managed only by that person, not by proxies.
  if exists (select 1 from public.players where id = p_player_id and self_user_id is not null and self_user_id <> v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;

  -- Same warning as registration, excluding the child itself. Warning only.
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'note', s.note)), '[]'::jsonb)
    into v_similar
    from public.find_similar_players(v_team_id, p_name) s
   where s.id <> p_player_id;
  if jsonb_array_length(v_similar) > 0 and not p_confirm_similar then
    return jsonb_build_object('status', 'similar_found', 'similar', v_similar);
  end if;

  -- Guardians and attendance are untouched.
  update public.players
     set name = trim(p_name), normalized_name = private.normalize_name(p_name),
         note = nullif(trim(p_note), ''), updated_at = now(), updated_by = v_uid
   where id = p_player_id;
  return jsonb_build_object('status', 'updated');
end;
$$;

create or replace function public.archive_player(p_player_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
begin
  if not exists (select 1 from public.players where id = p_player_id and archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- A registration as a person (D3.5) is managed only by that person, not by proxies.
  if exists (select 1 from public.players where id = p_player_id and self_user_id is not null and self_user_id <> v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Logical cancel only. Guardians and attendance rows are kept, so it can be restored.
  update public.players set archived_at = now(), archived_by = v_uid where id = p_player_id;
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
  v_recent int;
  v_next timestamptz;
begin
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- A registration as a person (D3.5) is managed only by that person, not by proxies.
  if exists (select 1 from public.players where id = p_player_id and self_user_id is not null and self_user_id <> v_uid) then
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

commit;
