-- D6-A: SELF-SERVICE confirmed cleanup and leave. No change to leave_team/remove_member.
-- Fingerprint is a comparison value, NOT an authorization token. Every permission and deletion
-- candidate is recomputed on the server. The membership (including joined_at) binds a preview to
-- this participation; a retry after success is not_member, with no further writes.
begin;

-- Purge locks its user's account before invitations/players and later anonymises old invitation
-- usage. Lock related accounts first, in UUID order, to avoid a player <-> invitation cycle with
-- a different guardian's purge. Recheck the set after the team lock: never acquire late accounts.
create or replace function private.leave_cleanup_lock_users(p_team uuid, p_user uuid)
returns uuid[] language sql stable security definer set search_path = ''
as $$
  with affected as (
    select p.id, p.self_user_id from public.players p where p.team_id = p_team and (p.self_user_id = p_user
      or exists(select 1 from public.player_guardians g where g.player_id=p.id and g.user_id=p_user))
  ), invitations as (
    select i.created_by, i.used_by from public.guardian_invitations i where i.team_id=p_team
      and (i.created_by=p_user or i.player_id in (select id from affected))
  ), users as (
    select p_user as id union select self_user_id from affected
    union select g.user_id from public.player_guardians g where g.player_id in (select id from affected)
    union select created_by from invitations union select used_by from invitations
  ) select array_agg(id order by id) from users where id is not null;
$$;

create or replace function private.leave_cleanup_state(p_team uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with affected as (
    select p.* from public.players p where p.team_id = p_team
      and (p.self_user_id = p_user or exists (
        select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = p_user))
  ), deleting as (
    select p.* from affected p where p.self_user_id = p_user
      or (p.self_user_id is null and not p.is_self and not exists (
        select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> p_user))
  ), state as (
    select jsonb_build_object(
      'team', p_team, 'user', p_user,
      'membership', (select to_jsonb(m) from public.team_members m where m.team_id = p_team and m.user_id = p_user),
      'players', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from affected p), '[]'),
      'guardians', coalesce((select jsonb_agg(to_jsonb(g) order by g.player_id, g.user_id)
        from public.player_guardians g where g.player_id in (select id from affected)), '[]'),
      'answers', coalesce((select jsonb_agg(to_jsonb(a) order by a.player_id, a.event_id)
        from public.attendance a where a.player_id in (select id from deleting)), '[]'),
      'invitations', coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.guardian_invitations i
        where i.player_id in (select id from deleting) or (i.team_id = p_team and i.created_by = p_user and i.used_at is null)), '[]')
    ) as value
  )
  select jsonb_build_object(
    'fingerprint', private.hash_token((select value::text from state)),
    'deletions', coalesce((select jsonb_agg(jsonb_build_object(
      'player_id', p.id, 'name', p.name, 'is_self', coalesce(p.self_user_id = p_user, false),
      'cancelled', p.archived_at is not null,
      'answers', (select count(*) from public.attendance a where a.player_id = p.id)
    ) order by p.id) from deleting p), '[]')
  );
$$;

create or replace function public.leave_cleanup_preview(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_preview jsonb;
begin
  v_preview := public.leave_preview(p_team_id);
  return v_preview || jsonb_build_object('cleanup', private.leave_cleanup_state(p_team_id, v_uid));
end;
$$;

create or replace function public.leave_team_with_cleanup(p_team_id uuid, p_fingerprint text, p_confirm text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth(); v_role text; v_state jsonb; v_impact jsonb;
  v_result jsonb; v_ids uuid[]; n_proxy int; n_answers int;
  v_lock_users uuid[]; v_lock_user uuid;
begin
  v_lock_users := private.leave_cleanup_lock_users(p_team_id, v_uid);
  foreach v_lock_user in array v_lock_users loop
    perform private.xlock('membership:' || v_lock_user::text);
  end loop;
  perform private.xlock('team-members:' || p_team_id::text);
  perform 1 from public.teams where id = p_team_id for update;
  select role into v_role from public.team_members where team_id = p_team_id and user_id = v_uid;
  if v_role is null then raise exception 'not_member' using errcode = 'P0002'; end if;
  if v_role = 'owner' then raise exception 'owner_cannot_leave' using errcode = '42501'; end if;
  if p_confirm is distinct from '登録と出欠を削除して脱退する' then
    raise exception 'confirm_required' using errcode = '22023';
  end if;
  if v_lock_users is distinct from private.leave_cleanup_lock_users(p_team_id, v_uid) then
    raise exception 'leave_confirmation_stale' using errcode = '23514';
  end if;

  -- Same invitation-before-player order as purge_account_data. Include historical invitations of
  -- possible deletion candidates, even if they were created by another (previous) guardian.
  perform 1 from public.guardian_invitations i where i.team_id = p_team_id and (
    i.created_by = v_uid or i.player_id in (
      select p.id from public.players p where p.team_id = p_team_id and (p.self_user_id = v_uid or (
        p.self_user_id is null and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
        and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)))))
    order by i.id for update;
  perform 1 from public.players p where p.team_id = p_team_id and (
    p.self_user_id = v_uid or exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid))
    order by p.id for update;

  -- A separate statement after waiting for locks reads the newly committed state (READ COMMITTED).
  v_impact := private.member_impact(p_team_id, v_uid);
  v_state := private.leave_cleanup_state(p_team_id, v_uid);
  if p_fingerprint is null or p_fingerprint is distinct from v_state ->> 'fingerprint'
     or jsonb_array_length(v_impact -> 'sole_guardian_children') = 0 then
    raise exception 'leave_confirmation_stale' using errcode = '23514';
  end if;
  -- A damaged/legacy link must never turn another person's self registration into our candidate.
  if exists (select 1 from public.players p where p.team_id = p_team_id
      and p.self_user_id is not null and p.self_user_id <> v_uid
      and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
      and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select array_agg((x ->> 'player_id')::uuid) into v_ids from jsonb_array_elements(v_state -> 'deletions') x;
  select count(*) into n_answers from public.attendance where player_id = any(v_ids);
  -- Only proxies here. Existing detach logic still handles self ownership and shared links.
  with d as (delete from public.players where id = any(v_ids) and team_id = p_team_id
      and self_user_id is null and not is_self returning 1)
    select count(*) into n_proxy from d;
  v_result := private.detach_member(p_team_id, v_uid);
  return v_result || jsonb_build_object('status', 'left', 'proxy_registrations_deleted', n_proxy, 'answers_deleted', n_answers);
end;
$$;

revoke all on function private.leave_cleanup_state(uuid, uuid) from public, anon, authenticated;
revoke all on function private.leave_cleanup_lock_users(uuid, uuid) from public, anon, authenticated;
revoke all on function public.leave_cleanup_preview(uuid) from public, anon;
revoke all on function public.leave_team_with_cleanup(uuid, text, text) from public, anon;
grant execute on function public.leave_cleanup_preview(uuid) to authenticated;
grant execute on function public.leave_team_with_cleanup(uuid, text, text) to authenticated;

-- set_attendance below adds the player row lock BEFORE touching attendance (including unanswered).
-- This prevents a proxy's UPDATE/DELETE of an existing answer from bypassing the cleanup snapshot.

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
  perform 1 from public.players where id = p_player_id for update;
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
