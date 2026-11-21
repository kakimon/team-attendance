-- =============================================================
-- Phase 5-B U4-Fix2: last races found by the local concurrency test (after U4-Fix)
--
--   * remove_member vs create_event / update_event / delete_event by the removed admin, and
--     vs revoke_guardian_invitation by the removed member: the role / guardian check ran before
--     any lock, so the write could still take effect after the removal had committed
--     (create_event even waited for the removal's team-row lock and then inserted).
--   * purge_account_data vs the same user's own operations (register_self, register_player,
--     create_team, ...): the purge took none of the user's locks, so a registration or a team that
--     committed in the middle of the purge either made the purge fail at commit
--     (child_without_guardian / team_without_owner) or survived it, so that the Auth deletion
--     failed once and had to be retried.
--
-- Fix (same pattern as U4-Fix): the four member functions take the caller's account lock
-- (membership:<caller>) FIRST; purge_account_data takes the user's owner-quota lock and account
-- lock right after its own 'purge:' lock, before reading anything.
--
-- Lock order (shared by every function): purge:<user> (purge only) -> owner-quota:<user>
-- -> membership:<user> -> team-members / team-children / team-events / invites:<...>
-- -> team rows -> invitation rows -> player rows.
-- Nothing else changes: same bodies otherwise, same signatures, return types and grants; the
-- meaning of account deletion (what is deleted / kept) is unchanged.
-- Rollback: supabase/rollback/20261117235500_member_lock_fix2_down.sql
-- =============================================================

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
  -- U4-Fix2: account lock before the role check (serialises with remove_member / purge_account_data).
  perform private.xlock('membership:' || v_uid::text);
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
  -- U4-Fix2: account lock before the role check (serialises with remove_member / purge_account_data).
  perform private.xlock('membership:' || v_uid::text);
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
  -- U4-Fix2: account lock before the role check (serialises with remove_member / purge_account_data).
  perform private.xlock('membership:' || v_uid::text);
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

create or replace function public.revoke_guardian_invitation(p_invitation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_player_id uuid;
begin
  perform private.require_auth();
  -- U4-Fix2: account lock before the guardian check (serialises with remove_member / purge_account_data).
  perform private.xlock('membership:' || auth.uid()::text);
  select player_id into v_player_id from public.guardian_invitations where id = p_invitation_id;
  if v_player_id is null or not private.is_guardian(v_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.guardian_invitations set revoked_at = now()
  where id = p_invitation_id and used_at is null and revoked_at is null;
end;
$$;

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
  -- U4-Fix2: the user's own locks, in the shared order (owner quota -> account), before reading
  -- anything. The user's own operations that are running finish first (and are then purged with the
  -- rest); those that start now wait and, after this commits, find no membership / are refused by
  -- the account_deletion_pending triggers.
  perform private.lock_owner_quota(p_user);
  perform private.xlock('membership:' || p_user::text);

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
