-- =============================================================
-- Phase 5-B D3.5: registering yourself (adults answering for themselves)
--
--   players.is_self      true for a registration that represents a user themself
--   players.self_user_id the user it represents (who OWNS it). is_self <=> self_user_id set.
--   One per account and team (unique, cancelled ones included: registering again restores it).
--
-- Who may do what (ownership is decided by self_user_id = the caller, never by is_self alone):
--   * register_self(team_id): the caller only (no user id parameter), must be a member.
--   * answering: the owner and invited proxies (unchanged: any linked guardian).
--   * edit name/note, cancel, invite a proxy: the owner only (proxies are refused).
--   * Browsers cannot write to players at all; only register_self sets these two columns.
--
-- Account deletion (purge_account_data): the user's own registrations are deleted in every team
-- WITH their answers, even when a proxy is linked (the proxy loses that link). Other people's
-- registrations and children keep the existing rules.
--
-- Existing rows: is_self = false, self_user_id = null (nothing becomes a self registration).
-- Rollback: supabase/rollback/20261117230000_self_registration_down.sql
-- =============================================================

alter table public.players add column if not exists is_self boolean not null default false;
alter table public.players add column if not exists self_user_id uuid references auth.users(id) on delete cascade;
alter table public.players drop constraint if exists players_self_owner;
alter table public.players add constraint players_self_owner check (is_self = (self_user_id is not null));
create unique index if not exists players_one_self_per_team on public.players (team_id, self_user_id) where self_user_id is not null;

-- -------------------------------------------------------------
-- register_self: { status: 'created' | 'existing' | 'restored', player_id }
--   name = the caller's display name in the team (only at creation; never synced later).
--   U3 limits apply to created / restored registrations.
-- -------------------------------------------------------------
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
revoke execute on function public.register_self(uuid) from public, anon;
grant execute on function public.register_self(uuid) to authenticated;

-- -------------------------------------------------------------
-- Owner-only management of a self registration (same signatures; grants kept)
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

-- -------------------------------------------------------------
-- Account deletion (same signature; service_role only, grants kept)
-- -------------------------------------------------------------
create or replace function public.purge_account_data(p_user uuid, p_session uuid,
  p_max_login_age interval default interval '10 minutes')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_pending boolean;
  n_teams int; n_children int; n_inv int; n_links int; n_members int; n_self int;
begin
  if p_user is null then raise exception 'user_required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('purge:' || p_user::text, 0));  -- no double run

  if not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('status', 'already_deleted');
  end if;
  v_pending := exists (select 1 from private.account_deletions where user_id = p_user);

  -- Re-authentication: the session must still exist and belong to the user. For the FIRST
  -- run it must also be a recent login. A retry after the data is already gone only needs a
  -- live session, so a failed Auth deletion can always be retried without extra friction.
  if p_session is null or not exists (
       select 1 from auth.sessions s where s.id = p_session and s.user_id = p_user
         and (v_pending or s.created_at > now() - p_max_login_age)) then
    raise exception 'reauth_required' using errcode = '28000';
  end if;

  -- Lock the user's owned teams, then: an owner of a team with other members must hand it over.
  perform 1 from public.teams t join public.team_members m on m.team_id = t.id
   where m.user_id = p_user and m.role = 'owner' order by t.id for update of t;
  if exists (select 1 from public.team_members m where m.user_id = p_user and m.role = 'owner'
               and exists (select 1 from public.team_members o where o.team_id = m.team_id and o.user_id <> p_user)) then
    raise exception 'owner_must_transfer' using errcode = '23514';
  end if;

  -- Lock the user's invitations first: accepting an invitation locks the invitation and then the
  -- child, so taking the same order here avoids a deadlock with someone accepting right now.
  -- If that acceptance commits first, the new guardian is seen below and the child is kept.
  perform 1 from public.guardian_invitations where created_by = p_user order by id for update;
  -- Lock the user's children (fixed order: no deadlock between two purges). Two guardians of
  -- one child leaving at the same moment are serialised here, so the second one sees that the
  -- first is gone and deletes the child instead of leaving it without any guardian.
  perform 1 from public.players p
   where exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = p_user)
      or p.self_user_id = p_user                                      -- own registrations (D3.5)
   order by p.id for update;

  -- Teams where the user is the only member: closed (everything in them is the user's own).
  with d as (delete from public.teams t
              where exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = p_user and m.role = 'owner')
             returning 1) select count(*) into n_teams from d;
  -- The user's own registrations as a person (D3.5), in every team: deleted with their answers,
  -- even when a proxy (family member) is linked. The proxy loses only that link.
  with d as (delete from public.players where self_user_id = p_user returning 1) select count(*) into n_self from d;
  -- Children for whom the user is the ONLY guardian (incl. cancelled ones): deleted with their answers.
  with d as (delete from public.players p
              where exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = p_user)
                and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> p_user)
             returning 1) select count(*) into n_children from d;
  -- Invitations the user created (unused ones are credentials; used ones are only history).
  with d as (delete from public.guardian_invitations where created_by = p_user returning 1)
  select count(*) into n_inv from d;
  -- Open owner hand-over requests from/to the user.
  delete from public.team_owner_transfers where from_user = p_user or to_user = p_user;
  -- Guardian links (children with other guardians stay with them) and memberships.
  with d as (delete from public.player_guardians where user_id = p_user returning 1) select count(*) into n_links from d;
  with d as (delete from public.team_members where user_id = p_user returning 1) select count(*) into n_members from d;
  -- Anonymise recorder columns now (not only when the Auth user is deleted).
  update public.teams set created_by = null where created_by = p_user;
  update public.players set created_by = null where created_by = p_user;
  update public.players set updated_by = null where updated_by = p_user;
  update public.players set archived_by = null where archived_by = p_user;
  update public.events set created_by = null where created_by = p_user;
  update public.events set updated_by = null where updated_by = p_user;
  update public.events set deleted_by = null where deleted_by = p_user;
  update public.attendance set updated_by = null where updated_by = p_user;
  update public.guardian_invitations set used_by = null where used_by = p_user;

  insert into private.account_deletions (user_id) values (p_user)
  on conflict (user_id) do update set attempts = private.account_deletions.attempts + 1;

  return jsonb_build_object('status', 'purged', 'retry', v_pending, 'teams_closed', n_teams,
    'children_deleted', n_children, 'invitations_deleted', n_inv,
    'guardian_links_removed', n_links, 'memberships_removed', n_members, 'self_registrations_deleted', n_self);
end;
$$;

-- -------------------------------------------------------------
-- Deletion preview: same result as purge_account_data for own registrations
--   children_to_delete: + the caller's own registrations (even with a proxy), with their answer count
--   children_kept_by_family: never contains the caller's own registration
-- (same signature, same keys and shape as before: the existing deletion screen is unchanged)
-- -------------------------------------------------------------
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
                       from public.team_members o where o.team_id = t.id and o.user_id <> v_uid),
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
      select jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', t.name, 'role', m.role) order by t.name)
      from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = v_uid and m.role <> 'owner'), '[]'),
    'children_to_delete', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'team_name', t.name,
        'answers', (select count(*) from public.attendance a where a.player_id = p.id)) order by t.name, p.name)
      from public.players p join public.teams t on t.id = p.team_id
      where p.archived_at is null
        and (p.self_user_id = v_uid                                    -- own registration: deleted even with a proxy (D3.5)
             or (exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
                 and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)))), '[]'),
    'children_kept_by_family', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'team_name', t.name) order by t.name, p.name)
      from public.players p join public.teams t on t.id = p.team_id
      where p.archived_at is null
        and p.self_user_id is distinct from v_uid                       -- own registration is never kept (D3.5)
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)), '[]')
  );
end;
$$;
