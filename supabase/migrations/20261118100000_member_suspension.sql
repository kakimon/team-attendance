-- D6-B1: access suspension is independent from deletion. No background jobs.
-- Suspended memberships/guardian links count toward existing quotas and prevent team deletion.
begin;
alter table public.team_members add column suspended_at timestamptz;
-- NULL revision is accepted for legacy JSON restores; transitions normalize it to 1.
alter table public.team_members add column access_revision bigint default 0;
alter table public.team_members add constraint suspended_member_role check (suspended_at is null or role = 'member');

create function private.assert_not_suspended(p_team uuid, p_user uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
 if exists(select 1 from public.team_members where team_id=p_team and user_id=p_user and suspended_at is not null) then
  raise exception 'team_access_suspended' using errcode='42501';
 end if;
end;
$$;
revoke all on function private.assert_not_suspended(uuid,uuid) from public,anon,authenticated;
create or replace function private.is_team_member(p_team_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid() and suspended_at is null
  );
$$;

create or replace function private.is_team_admin(p_team_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid() and suspended_at is null and role in ('owner', 'admin')
  );
$$;

create or replace function private.is_guardian(p_player_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.player_guardians g
    join public.team_members m on m.team_id = g.team_id and m.user_id = g.user_id and m.suspended_at is null
    where g.player_id = p_player_id and g.user_id = auth.uid()
  );
$$;

create or replace function private.can_manage_join(p_team_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.team_members
                  where team_id = p_team_id and user_id = p_user and suspended_at is null and role in ('owner', 'admin'));
$$;

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
  perform private.xlock('membership:' || v_uid::text);
  perform private.xlock('team-members:' || v_team_id::text);
  perform private.assert_not_suspended(v_team_id, v_uid);
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

create or replace function public.join_by_token(p_token text, p_display_name text)
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
  perform private.xlock('membership:' || v_uid::text);
  perform private.xlock('team-members:' || v_team::text);
  perform private.assert_not_suspended(v_team, v_uid);
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

create or replace function public.get_team_by_share_token(p_share_token text)
returns table (id uuid, name text, is_member boolean, role text)
language plpgsql volatile security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  perform private.assert_not_suspended((select t.id from public.teams t where t.share_token=p_share_token), v_uid);
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
  perform private.assert_not_suspended((select j.team_id from private.team_join_tokens j where j.token=p_token), v_uid);
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

create or replace function public.resolve_legacy_team(p_share_token text)
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  perform private.assert_not_suspended((select t.id from public.teams t where t.share_token=p_share_token), v_uid);
  return (select t.id from public.teams t
           join public.team_members m on m.team_id = t.id and m.user_id = v_uid
          where t.share_token = p_share_token);
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
  v_team uuid;
begin
  -- U4-Fix: locks first (account -> team members -> team row), then every check reads the
  -- state after any removal / leave that was running has committed.
  perform private.xlock('membership:' || v_uid::text);
  select team_id into v_team from public.guardian_invitations
  where token_hash = private.hash_token(p_token);
  if v_team is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;
  perform private.xlock('team-members:' || v_team::text);
  perform 1 from public.teams where id = v_team for key share;

  perform private.assert_not_suspended(v_team, v_uid);
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
  -- U4-Fix: account lock before the membership check.
  perform private.xlock('membership:' || v_uid::text);
  perform private.assert_not_suspended(p_team_id, v_uid);
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

create or replace function public.leave_team(p_team_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_role text; v_result jsonb;
begin
  perform private.xlock('membership:' || v_uid::text);
  perform private.xlock('team-members:' || p_team_id::text);
  perform 1 from public.teams where id = p_team_id for update;
  perform private.assert_not_suspended(p_team_id, v_uid);
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
  perform private.assert_not_suspended(p_team_id, v_uid);
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

create or replace function public.leave_preview(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_role text;
begin
  perform private.assert_not_suspended(p_team_id, v_uid);
  select role into v_role from public.team_members where team_id = p_team_id and user_id = v_uid;
  if v_role is null then
    raise exception 'not_member' using errcode = 'P0002';
  end if;
  return private.member_impact(p_team_id, v_uid) || jsonb_build_object('is_owner', v_role = 'owner');
end;
$$;

create or replace function public.set_member_role(p_team_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
begin
  perform private.xlock('membership:' || p_user_id::text);
  perform private.xlock('team-members:' || p_team_id::text);
  perform 1 from public.teams where id=p_team_id for update;
  if p_role not in ('admin', 'member') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if not exists (select 1 from public.team_members
                 where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.assert_not_suspended(p_team_id,p_user_id);
  update public.team_members set role = p_role
  where team_id = p_team_id and user_id = p_user_id and role <> 'owner';
  if not found then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.request_owner_transfer(p_team_id uuid, p_to_user uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_exp timestamptz;
begin
  perform 1 from public.teams where id = p_team_id for update;   -- serialize with accept / purge
  if not exists (select 1 from public.team_members where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_to_user is null or p_to_user = v_uid
     or not exists (select 1 from public.team_members where team_id = p_team_id and user_id = p_to_user) then
    raise exception 'invalid_new_owner' using errcode = '22023';
  end if;
  perform private.assert_not_suspended(p_team_id,p_to_user);
  insert into public.team_owner_transfers (team_id, from_user, to_user)
  values (p_team_id, v_uid, p_to_user)
  on conflict (team_id) do update
    set from_user = excluded.from_user, to_user = excluded.to_user,
        created_at = now(), expires_at = now() + interval '7 days'
  returning expires_at into v_exp;
  return jsonb_build_object('status', 'requested', 'expires_at', v_exp);
end;
$$;

create or replace function public.respond_owner_transfer(p_team_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_t public.team_owner_transfers;
begin
  perform private.lock_owner_quota(v_uid);                         -- user lock first ...
  perform 1 from public.teams where id = p_team_id for update;     -- ... then the team (one hand-over at a time)
  perform private.assert_not_suspended(p_team_id, v_uid);
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
  if jsonb_array_length(private.member_impact(p_team_id,p_user_id)->'sole_guardian_children') > 0 then
    raise exception 'sole_guardian_children' using errcode='23514';
  end if;
  perform 1 from public.players where team_id=p_team_id and (self_user_id=p_user_id or exists(select 1 from public.player_guardians g where g.player_id=players.id and g.user_id=p_user_id)) order by id for update;
  if exists(select 1 from public.players where team_id=p_team_id and self_user_id=p_user_id) then
    raise exception 'member_data_confirmation_required' using errcode='23514';
  end if;
  v_result := private.detach_member(p_team_id, p_user_id);
  insert into private.team_member_blocks (team_id, user_id) values (p_team_id, p_user_id)
  on conflict (team_id, user_id) do nothing;
  return v_result || jsonb_build_object('status', 'removed');
end;
$$;

create or replace function public.account_deletion_preview()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_login timestamptz;
begin
  select s.created_at into v_login from auth.sessions s
   where s.id = (auth.jwt() ->> 'session_id')::uuid and s.user_id = v_uid;
  return jsonb_build_object(
    'deletion_pending', exists (select 1 from private.account_deletions d where d.user_id = v_uid),
    -- seconds left in which the last Google login counts as "recent" (0 = log in again)
    'reauth_seconds_left', greatest(0, floor(extract(epoch from (v_login + interval '10 minutes' - now()))))::int,
    'teams_to_hand_over', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', t.name,
        'candidates', (select coalesce(jsonb_agg(jsonb_build_object('user_id', o.user_id, 'display_name', o.display_name, 'role', o.role)
                         order by case o.role when 'admin' then 0 else 1 end, o.display_name), '[]')
                       from public.team_members o where o.team_id = t.id and o.user_id <> v_uid and o.suspended_at is null),
        'pending', (select jsonb_build_object('to_user', x.to_user, 'to_name', tm.display_name, 'expires_at', x.expires_at)
                    from public.team_owner_transfers x
                    left join public.team_members tm on tm.team_id = x.team_id and tm.user_id = x.to_user
                    where x.team_id = t.id and x.from_user = v_uid and x.expires_at > now()))
        order by t.name)
      from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = v_uid and m.role = 'owner'
      where exists (select 1 from public.team_members o where o.team_id = t.id and o.user_id <> v_uid)), '[]'),
    'teams_to_close', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', t.name) order by t.name)
      from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = v_uid and m.role = 'owner'
      where not exists (select 1 from public.team_members o where o.team_id = t.id and o.user_id <> v_uid)), '[]'),
    'teams_to_leave', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', case when m.suspended_at is null then t.name else null end, 'role', m.role) order by t.name)
      from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = v_uid and m.role <> 'owner'), '[]'),
    'children_to_delete', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'team_name', case when private.is_team_member(t.id) then t.name else null end,
        'answers', (select count(*) from public.attendance a where a.player_id = p.id)) order by t.name, p.name)
      from public.players p join public.teams t on t.id = p.team_id
      where p.archived_at is null
        and (p.self_user_id = v_uid                                    -- own registration: deleted even with a proxy (D3.5)
             or (exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
                 and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)))), '[]'),
    'children_kept_by_family', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'team_name', t.name) order by t.name, p.name)
      from public.players p join public.teams t on t.id = p.team_id
      where p.archived_at is null and private.is_team_member(t.id)
        and p.self_user_id is distinct from v_uid                       -- own registration is never kept (D3.5)
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)), '[]')
  );
end;
$$;
-- The self-link and transfer-participant exceptions must not bypass suspension.
alter policy player_guardians_select on public.player_guardians using
 ((select private.session_ok()) and private.is_team_member(team_id) and (user_id=auth.uid() or private.is_team_admin(team_id)));
alter policy team_owner_transfers_select on public.team_owner_transfers using
 ((select private.session_ok()) and private.is_team_member(team_id) and (from_user=auth.uid() or to_user=auth.uid()));

-- Owner actions retain memberships, registrations, answers and guardian links.
create function public.suspend_member(p_team_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.require_auth(); v_role text;
begin
 perform private.xlock('membership:'||p_user_id::text);
 perform private.xlock('team-members:'||p_team_id::text);
 perform 1 from public.teams where id=p_team_id for update;
 if not exists(select 1 from public.team_members where team_id=p_team_id and user_id=v_uid and role='owner') then
  raise exception 'forbidden' using errcode='42501';
 end if;
 select role into v_role from public.team_members where team_id=p_team_id and user_id=p_user_id;
 if v_role is null then raise exception 'member_not_found' using errcode='P0002'; end if;
 if v_role='owner' or p_user_id=v_uid then raise exception 'cannot_remove_owner' using errcode='42501'; end if;
 update public.team_members set suspended_at=clock_timestamp(),role='member',access_revision=coalesce(access_revision,0)+1
 where team_id=p_team_id and user_id=p_user_id and suspended_at is null;
 -- Revoke rather than delete credential history; no registration / answer is removed.
 update public.guardian_invitations set revoked_at=coalesce(revoked_at,clock_timestamp())
 where team_id=p_team_id and created_by=p_user_id and used_at is null;
 delete from public.team_owner_transfers where team_id=p_team_id and (from_user=p_user_id or to_user=p_user_id);
 return jsonb_build_object('status','suspended');
end;
$$;
create function public.resume_member(p_team_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.require_auth();
begin
 perform private.xlock('membership:'||p_user_id::text);
 perform private.xlock('team-members:'||p_team_id::text);
 perform 1 from public.teams where id=p_team_id for update;
 if not exists(select 1 from public.team_members where team_id=p_team_id and user_id=v_uid and role='owner') then
  raise exception 'forbidden' using errcode='42501';
 end if;
 if not exists(select 1 from public.team_members where team_id=p_team_id and user_id=p_user_id) then
  raise exception 'member_not_found' using errcode='P0002';
 end if;
 update public.team_members set suspended_at=null,role='member',access_revision=coalesce(access_revision,0)+1
 where team_id=p_team_id and user_id=p_user_id and suspended_at is not null;
 return jsonb_build_object('status','active');
end;
$$;
-- No team names, schedules, other members, notes, comments or invitation credentials.
create function public.my_suspended_memberships()
returns table(team_id uuid,suspended_at timestamptz) language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_auth();
begin
 return query select m.team_id,m.suspended_at from public.team_members m where m.user_id=v_uid and m.suspended_at is not null order by m.team_id;
end;
$$;
create function public.suspended_leave_preview(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_auth();
begin
 if not exists(select 1 from public.team_members where team_id=p_team_id and user_id=v_uid and suspended_at is not null) then
  raise exception 'not_suspended' using errcode='42501';
 end if;
 return private.leave_cleanup_state(p_team_id,v_uid) || jsonb_build_object('links_removed_count',
  (select count(*) from public.player_guardians g join public.players p on p.id=g.player_id
   where g.team_id=p_team_id and g.user_id=v_uid and p.self_user_id is distinct from v_uid
    and exists(select 1 from public.player_guardians o where o.player_id=p.id and o.user_id<>v_uid)));
end;
$$;
create or replace function public.leave_suspended_team(p_team_id uuid, p_fingerprint text, p_confirm text)
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
  if not exists(select 1 from public.team_members where team_id=p_team_id and user_id=v_uid and suspended_at is not null) then
    raise exception 'not_suspended' using errcode='42501';
  end if;
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
  if p_fingerprint is null or p_fingerprint is distinct from v_state ->> 'fingerprint' then
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
  insert into private.team_member_blocks(team_id,user_id) values(p_team_id,v_uid) on conflict do nothing;
  v_result := private.detach_member(p_team_id, v_uid);
  return v_result || jsonb_build_object('status', 'left', 'proxy_registrations_deleted', n_proxy, 'answers_deleted', n_answers);
end;
$$;
revoke all on function public.suspend_member(uuid,uuid) from public,anon;
grant execute on function public.suspend_member(uuid,uuid) to authenticated;
revoke all on function public.resume_member(uuid,uuid) from public,anon;
grant execute on function public.resume_member(uuid,uuid) to authenticated;
revoke all on function public.my_suspended_memberships() from public,anon;
grant execute on function public.my_suspended_memberships() to authenticated;
revoke all on function public.suspended_leave_preview(uuid) from public,anon;
grant execute on function public.suspended_leave_preview(uuid) to authenticated;
revoke all on function public.leave_suspended_team(uuid,text,text) from public,anon;
grant execute on function public.leave_suspended_team(uuid,text,text) to authenticated;

commit;
