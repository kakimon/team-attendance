-- =============================================================
-- Phase 4-B: self-service account deletion + owner hand-over with approval
--
-- Flow (Edge Function "delete-account", official Admin API):
--   browser --JWT--> Edge Function
--     1. Auth server verifies the JWT; user id + session id come ONLY from it
--     2. public.purge_account_data(user, session)  [service_role, ONE transaction]
--          - removes the user's app data, anonymises recorder columns
--          - leaves a row in private.account_deletions ("data removed, Auth user not yet")
--     3. auth.admin.deleteUser(user)                [official API; cascades sessions]
--          - the private.account_deletions row goes away with the Auth user (FK cascade)
--   Step 2+3 cannot be one transaction. If step 3 fails, the user is left with NO app data
--   and cannot create/join anything (guard triggers below); calling the function again
--   (no fresh re-login needed in that state, only a live session) finishes the job.
--
-- Data safety:
--   * No existing row is changed. Only constraints, one table, triggers and functions are added.
--   * Children who have another guardian, and team events, are kept. Only the recorder
--     columns pointing at the leaving user are cleared.
-- =============================================================

-- Fail fast instead of queueing behind live traffic (ALTER TABLE takes short exclusive locks).
set lock_timeout = '5s';

-- -------------------------------------------------------------
-- 1. Foreign keys to auth.users: decided per column (not a blanket SET NULL)
-- -------------------------------------------------------------
--   teams.created_by, players.created_by : nullable, ON DELETE stays NO ACTION.
--       purge_account_data clears them. Deleting a user any other way (dashboard, raw SQL)
--       is refused while they still created a team/child -> no owner-less team, no orphan child.
--   events.created_by, attendance.updated_by : nullable, SET NULL (shared records stay)
--   events.updated_by/deleted_by, players.updated_by/archived_by : SET NULL (audit only)
--   guardian_invitations.created_by : CASCADE (an invitation is a credential)
--   guardian_invitations.used_by    : SET NULL (used_at stays set, so the link stays unusable)
--   team_members.user_id, player_guardians.user_id : CASCADE (unchanged), guarded by checks below
alter table public.teams      alter column created_by drop not null;
alter table public.players    alter column created_by drop not null;
alter table public.events     alter column created_by drop not null;
alter table public.attendance alter column updated_by drop not null;

do $$
declare r record; v_con text;
begin
  for r in select * from (values
    ('events', 'created_by', 'set null'),
    ('events', 'updated_by', 'set null'),
    ('events', 'deleted_by', 'set null'),
    ('attendance', 'updated_by', 'set null'),
    ('players', 'updated_by', 'set null'),
    ('players', 'archived_by', 'set null'),
    ('guardian_invitations', 'created_by', 'cascade'),
    ('guardian_invitations', 'used_by', 'set null')
  ) as v(t, c, act)
  loop
    -- constraint names are looked up, not assumed
    select con.conname into v_con
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f' and con.conrelid = format('public.%I', r.t)::regclass
       and con.confrelid = 'auth.users'::regclass and a.attname = r.c;
    if v_con is null then raise exception 'fk not found: %.%', r.t, r.c; end if;
    execute format('alter table public.%I drop constraint %I', r.t, v_con);
    execute format('alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete %s',
                   r.t, r.t || '_' || r.c || '_fkey', r.c, r.act);
  end loop;
end $$;

-- -------------------------------------------------------------
-- 2. Integrity: exactly one owner per team, at least one guardian per child
-- -------------------------------------------------------------
-- (a) at most one owner: unique index (holds under concurrency)
create unique index if not exists team_members_one_owner on public.team_members (team_id) where role = 'owner';

-- (b) at least one owner: checked at COMMIT, so "demote then promote" in one transaction passes
create or replace function private.ensure_team_owner()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.teams t where t.id = old.team_id)
     and not exists (select 1 from public.team_members m where m.team_id = old.team_id and m.role = 'owner') then
    raise exception 'team_without_owner' using errcode = '23514';
  end if;
  return null;
end;
$$;
drop trigger if exists team_members_keep_owner on public.team_members;
create constraint trigger team_members_keep_owner
  after update or delete on public.team_members
  deferrable initially deferred for each row execute function private.ensure_team_owner();

-- (c) every child keeps at least one guardian (checked at COMMIT)
create or replace function private.ensure_child_guardian()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.players p where p.id = old.player_id)
     and not exists (select 1 from public.player_guardians g where g.player_id = old.player_id) then
    raise exception 'child_without_guardian' using errcode = '23514';
  end if;
  return null;
end;
$$;
drop trigger if exists player_guardians_keep_one on public.player_guardians;
create constraint trigger player_guardians_keep_one
  after delete on public.player_guardians
  deferrable initially deferred for each row execute function private.ensure_child_guardian();

-- -------------------------------------------------------------
-- 3. Old tokens: every RPC now also requires the token's session to still exist.
--    After logout / account deletion the session row is gone, so an access token that
--    has not expired yet can no longer change anything.
-- -------------------------------------------------------------
create or replace function private.require_auth()
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare
  v uuid := auth.uid();
  v_sid text := auth.jwt() ->> 'session_id';
begin
  if v is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_sid is null or v_sid !~ '^[0-9a-fA-F-]{36}$' or not exists (
       select 1 from auth.sessions s where s.id = v_sid::uuid and s.user_id = v) then
    raise exception 'session_expired' using errcode = '28000';
  end if;
  return v;
end;
$$;

-- -------------------------------------------------------------
-- 4. Deletion state ("app data removed, Auth user not deleted yet")
--    Private schema: not reachable from the browser. The row disappears together with
--    the Auth user (FK cascade), so nothing about a deleted user is kept here.
-- -------------------------------------------------------------
create table if not exists private.account_deletions (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  purged_at     timestamptz not null default now(),
  attempts      int not null default 1,
  last_error    text,
  last_error_at timestamptz
);
alter table private.account_deletions enable row level security;
revoke all on private.account_deletions from public, anon, authenticated;

-- While in that state the user cannot create or join anything again
-- (otherwise the final Auth deletion could be blocked or remove new data unannounced).
create or replace function private.block_while_deleting()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v uuid := auth.uid();
begin
  if v is not null and exists (select 1 from private.account_deletions d where d.user_id = v) then
    raise exception 'account_deletion_pending' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists teams_block_while_deleting on public.teams;
create trigger teams_block_while_deleting before insert on public.teams
  for each row execute function private.block_while_deleting();
drop trigger if exists team_members_block_while_deleting on public.team_members;
create trigger team_members_block_while_deleting before insert on public.team_members
  for each row execute function private.block_while_deleting();
drop trigger if exists player_guardians_block_while_deleting on public.player_guardians;
create trigger player_guardians_block_while_deleting before insert on public.player_guardians
  for each row execute function private.block_while_deleting();

-- -------------------------------------------------------------
-- 5. Owner hand-over WITH APPROVAL
--    owner requests -> the chosen member accepts (or declines) -> roles swap atomically.
--    One open request per team (primary key). The old owner becomes a plain member.
-- -------------------------------------------------------------
create table if not exists public.team_owner_transfers (
  team_id    uuid primary key references public.teams(id) on delete cascade,
  from_user  uuid not null references auth.users(id) on delete cascade,
  to_user    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  check (from_user <> to_user)
);
alter table public.team_owner_transfers enable row level security;
revoke all on public.team_owner_transfers from public, anon, authenticated;
grant select on public.team_owner_transfers to authenticated;
create policy team_owner_transfers_select on public.team_owner_transfers
  for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());

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
  insert into public.team_owner_transfers (team_id, from_user, to_user)
  values (p_team_id, v_uid, p_to_user)
  on conflict (team_id) do update
    set from_user = excluded.from_user, to_user = excluded.to_user,
        created_at = now(), expires_at = now() + interval '7 days'
  returning expires_at into v_exp;
  return jsonb_build_object('status', 'requested', 'expires_at', v_exp);
end;
$$;

create or replace function public.cancel_owner_transfer(p_team_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  perform 1 from public.teams where id = p_team_id for update;
  delete from public.team_owner_transfers where team_id = p_team_id and from_user = v_uid;
  if not found then
    raise exception 'transfer_not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Returns 'accepted' | 'declined' | 'expired' | 'stale' (owner or recipient changed meanwhile).
create or replace function public.respond_owner_transfer(p_team_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_t public.team_owner_transfers;
begin
  perform 1 from public.teams where id = p_team_id for update;   -- one hand-over at a time
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
  update public.team_members set role = 'member' where team_id = p_team_id and user_id = v_t.from_user; -- demote first
  update public.team_members set role = 'owner'  where team_id = p_team_id and user_id = v_uid;         -- then promote
  return jsonb_build_object('status', 'accepted');
end;
$$;

-- Open requests that involve the caller (incoming: to accept; outgoing: waiting).
create or replace function public.my_owner_transfers()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  return jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', t.name,
        'from_name', fm.display_name, 'expires_at', x.expires_at) order by x.created_at)
      from public.team_owner_transfers x
      join public.teams t on t.id = x.team_id
      left join public.team_members fm on fm.team_id = x.team_id and fm.user_id = x.from_user
      where x.to_user = v_uid and x.expires_at > now()), '[]'),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', t.id, 'team_name', t.name,
        'to_user', x.to_user, 'to_name', tm.display_name, 'expires_at', x.expires_at) order by x.created_at)
      from public.team_owner_transfers x
      join public.teams t on t.id = x.team_id
      left join public.team_members tm on tm.team_id = x.team_id and tm.user_id = x.to_user
      where x.from_user = v_uid and x.expires_at > now()), '[]'));
end;
$$;

-- -------------------------------------------------------------
-- 6. Impact preview for the deletion screen (caller's own data only; no user id parameter)
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
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
        and not exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)), '[]'),
    'children_kept_by_family', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'team_name', t.name) order by t.name, p.name)
      from public.players p join public.teams t on t.id = p.team_id
      where p.archived_at is null
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id = v_uid)
        and exists (select 1 from public.player_guardians g where g.player_id = p.id and g.user_id <> v_uid)), '[]')
  );
end;
$$;

-- -------------------------------------------------------------
-- 7. Purge a user's app data in ONE transaction.
--    service_role only: called by the Edge Function with the user id and session id taken
--    from the verified JWT. Safe to call again (idempotent).
--    Returns status 'purged' (counts) or 'already_deleted'.
-- -------------------------------------------------------------
create or replace function public.purge_account_data(p_user uuid, p_session uuid,
  p_max_login_age interval default interval '10 minutes')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_pending boolean;
  n_teams int; n_children int; n_inv int; n_links int; n_members int;
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
   order by p.id for update;

  -- Teams where the user is the only member: closed (everything in them is the user's own).
  with d as (delete from public.teams t
              where exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = p_user and m.role = 'owner')
             returning 1) select count(*) into n_teams from d;
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
    'guardian_links_removed', n_links, 'memberships_removed', n_members);
end;
$$;

-- Records why the Auth deletion failed (service_role only; no personal data).
create or replace function public.note_account_deletion_failure(p_user uuid, p_error text)
returns void language sql security definer set search_path = ''
as $$
  update private.account_deletions
     set last_error = left(p_error, 200), last_error_at = now()
   where user_id = p_user;
$$;

-- -------------------------------------------------------------
-- 8. Privileges (explicit, per function)
-- -------------------------------------------------------------
revoke execute on function public.request_owner_transfer(uuid, uuid) from public, anon;
revoke execute on function public.cancel_owner_transfer(uuid) from public, anon;
revoke execute on function public.respond_owner_transfer(uuid, boolean) from public, anon;
revoke execute on function public.my_owner_transfers() from public, anon;
revoke execute on function public.account_deletion_preview() from public, anon;
grant execute on function public.request_owner_transfer(uuid, uuid) to authenticated;
grant execute on function public.cancel_owner_transfer(uuid) to authenticated;
grant execute on function public.respond_owner_transfer(uuid, boolean) to authenticated;
grant execute on function public.my_owner_transfers() to authenticated;
grant execute on function public.account_deletion_preview() to authenticated;

revoke execute on function public.purge_account_data(uuid, uuid, interval) from public, anon, authenticated;
revoke execute on function public.note_account_deletion_failure(uuid, text) from public, anon, authenticated;
grant execute on function public.purge_account_data(uuid, uuid, interval) to service_role;
grant execute on function public.note_account_deletion_failure(uuid, text) to service_role;

revoke execute on function private.ensure_team_owner() from public, anon, authenticated;
revoke execute on function private.ensure_child_guardian() from public, anon, authenticated;
revoke execute on function private.block_while_deleting() from public, anon, authenticated;

reset lock_timeout;
