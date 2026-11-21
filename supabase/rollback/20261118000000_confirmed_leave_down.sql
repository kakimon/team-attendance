-- D6-A rollback: restores the exact U4-Fix set_attendance body. Deleted data cannot be restored.
begin;
drop function if exists public.leave_team_with_cleanup(uuid, text, text);
drop function if exists public.leave_cleanup_preview(uuid);
drop function if exists private.leave_cleanup_state(uuid, uuid);
drop function if exists private.leave_cleanup_lock_users(uuid, uuid);

create or replace function public.set_attendance(
  p_event_id uuid, p_player_id uuid, p_status text, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  -- U4-Fix: account lock before any check (serialises with remove_member / leave_team).
  perform private.xlock('membership:' || v_uid::text);
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

commit;
