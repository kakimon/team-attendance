-- =============================================================
-- ROLLBACK for 20261110000000_phase4a (run ONLY if Phase 4-A must be undone).
-- Restores the pre-4-A policies and RPC definitions, removes the 4 new RPCs.
-- Data: nothing is deleted. The added columns are kept (harmless, nullable).
--   Rows logically deleted/cancelled during 4-A become visible again, because
--   the old policies do not filter on deleted_at / archived_at for events.
--   (players.archived_at was already respected by the old RPCs and the app.)
--
--   supabase db query --linked -f scripts/ops/rollback_phase4a.sql
--   supabase migration repair --status reverted 20261110000000 --linked
-- =============================================================
begin;

drop function if exists public.update_event(uuid, text, timestamptz, text, text);
drop function if exists public.delete_event(uuid);
drop function if exists public.update_player(uuid, text, text, boolean);
drop function if exists public.archive_player(uuid);

drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select to authenticated using (private.is_team_member(team_id));
drop policy if exists players_select on public.players;
create policy players_select on public.players
  for select to authenticated using (private.is_team_member(team_id));
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated using (private.is_team_member(team_id));

-- Pre-4-A definitions (copied verbatim from 20261107000000_init.sql).
-- CREATE OR REPLACE keeps the existing EXECUTE grants.

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
  where e.id = p_event_id and p.id = p_player_id and p.archived_at is null;
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
  select team_id into v_team_id from public.events where id = p_event_id;
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
  select team_id into v_team_id from public.players where id = p_player_id;

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
begin
  select * into v_inv from public.guardian_invitations
  where token_hash = private.hash_token(p_token);
  if v_inv.id is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.player_guardians
             where player_id = v_inv.player_id and user_id = v_uid) then
    raise exception 'already_guardian' using errcode = '23505';
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

  return jsonb_build_object('player_id', v_inv.player_id, 'team_id', v_inv.team_id);
end;
$$;

commit;
