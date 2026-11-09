-- =============================================================
-- Phase 4-A: edit / logically delete events, edit / cancel children,
-- friendly "already a guardian" result for family invitations.
--
-- Data safety:
--   * Only ADDS nullable columns. No column, row or table is dropped.
--   * Nothing is physically deleted: events get deleted_at, players use the
--     existing archived_at. Attendance rows stay in the database, so both can be
--     restored later by clearing the timestamp.
--   * Policies are replaced (drop + create) only to add the "not deleted" filter.
-- =============================================================

-- -------------------------------------------------------------
-- Columns (all nullable; existing rows unaffected)
-- -------------------------------------------------------------
alter table public.events
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid references auth.users(id),
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id);

alter table public.players
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid references auth.users(id),
  add column if not exists archived_by uuid references auth.users(id);

-- -------------------------------------------------------------
-- RLS: hide deleted events / cancelled children (and their answers) from everyone
-- -------------------------------------------------------------
drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select to authenticated
  using (private.is_team_member(team_id) and deleted_at is null);

drop policy if exists players_select on public.players;
create policy players_select on public.players
  for select to authenticated
  using (private.is_team_member(team_id) and archived_at is null);

-- The sub-selects run with the caller's rights, so the two policies above apply too.
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated
  using (
    private.is_team_member(team_id)
    and exists (select 1 from public.events e where e.id = attendance.event_id and e.deleted_at is null)
    and exists (select 1 from public.players p where p.id = attendance.player_id and p.archived_at is null)
  );

-- -------------------------------------------------------------
-- Events: edit / logical delete (team owner or admin only)
-- -------------------------------------------------------------
create or replace function public.update_event(
  p_event_id uuid, p_title text, p_starts_at timestamptz,
  p_location text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  select team_id into v_team_id from public.events where id = p_event_id and deleted_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_team_admin(v_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Attendance rows are keyed by event id, so answers are kept as they are.
  update public.events
     set title = trim(p_title), starts_at = p_starts_at,
         location = nullif(trim(p_location), ''), note = nullif(trim(p_note), ''),
         updated_at = now(), updated_by = v_uid
   where id = p_event_id;
end;
$$;

create or replace function public.delete_event(p_event_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  select team_id into v_team_id from public.events where id = p_event_id and deleted_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_team_admin(v_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Logical delete only. Restore = set deleted_at back to null.
  update public.events set deleted_at = now(), deleted_by = v_uid where id = p_event_id;
end;
$$;

-- -------------------------------------------------------------
-- Children: edit / cancel registration (guardians of that child only)
-- -------------------------------------------------------------
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
  -- Logical cancel only. Guardians and attendance rows are kept, so it can be restored.
  update public.players set archived_at = now(), archived_by = v_uid where id = p_player_id;
end;
$$;

-- -------------------------------------------------------------
-- Existing RPCs: respect deleted events / cancelled children
-- (same signatures; existing EXECUTE grants are kept by CREATE OR REPLACE)
-- -------------------------------------------------------------
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

create or replace function public.event_attendance_summary(p_event_id uuid)
returns table (attend int, absent int, undecided int, unanswered int, total int)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_team_id uuid;
begin
  perform private.require_auth();
  select team_id into v_team_id from public.events where id = p_event_id and deleted_at is null;
  if v_team_id is null or not private.is_team_member(v_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select
      count(*) filter (where a.status = 'attend')::int,
      count(*) filter (where a.status = 'absent')::int,
      count(*) filter (where a.status = 'undecided')::int,
      count(*) filter (where a.status is null)::int,
      count(*)::int
    from public.players p
    left join public.attendance a on a.player_id = p.id and a.event_id = p_event_id
    where p.team_id = v_team_id and p.archived_at is null;
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

-- Returns {status: 'accepted' | 'already_guardian', player_id, player_name, team_id, share_token}.
-- 'already_guardian' is a normal result and does NOT consume the invitation, so the
-- intended family member can still use it afterwards.
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

-- -------------------------------------------------------------
-- Privileges for the NEW functions only (signed-in users; never anon).
-- Not a blanket revoke/grant, so health_check stays anon-only.
-- -------------------------------------------------------------
revoke execute on function public.update_event(uuid, text, timestamptz, text, text) from public, anon;
revoke execute on function public.delete_event(uuid) from public, anon;
revoke execute on function public.update_player(uuid, text, text, boolean) from public, anon;
revoke execute on function public.archive_player(uuid) from public, anon;
grant execute on function public.update_event(uuid, text, timestamptz, text, text) to authenticated;
grant execute on function public.delete_event(uuid) to authenticated;
grant execute on function public.update_player(uuid, text, text, boolean) to authenticated;
grant execute on function public.archive_player(uuid) to authenticated;
