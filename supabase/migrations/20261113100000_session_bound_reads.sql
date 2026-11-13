-- =============================================================
-- Phase 4-B (2/2): reads also require a live login session
--
-- Before: an access token stayed usable for READS until it expired (up to 1 hour) even after
-- logout or account deletion, because RLS policies only looked at auth.uid().
-- After: every SELECT policy also requires that the token's session_id is a row of
-- auth.sessions belonging to the same user. (Writes already require it via
-- private.require_auth() since 20261113000000.)
--
-- Read paths covered (inventory 2026-11-13; there are no views):
--   * RLS SELECT policies (8): teams, team_members, players, player_guardians, events,
--     attendance, guardian_invitations, team_owner_transfers  -> this file
--   * SECURITY DEFINER RPCs that return data (get_team_by_share_token, find_similar_players,
--     event_attendance_summary, account_deletion_preview, my_owner_transfers, and the write
--     RPCs' return values) -> all start with private.require_auth() (session checked)
--   * health_check(): anon only, returns no personal data
--
-- Performance: the check is written as `(select private.session_ok())`, so Postgres runs it
-- once per query (InitPlan), not once per row. One primary-key lookup on auth.sessions.
-- Data: unchanged. Only policies are altered and one function is added.
-- =============================================================
set lock_timeout = '5s';

create or replace function private.session_ok()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select exists (
      select 1 from auth.sessions s
       where s.id = (auth.jwt() ->> 'session_id')::uuid and s.user_id = auth.uid())
     where (auth.jwt() ->> 'session_id') ~ '^[0-9a-fA-F-]{36}$'), false);
$$;
revoke execute on function private.session_ok() from public, anon;
grant execute on function private.session_ok() to authenticated;

alter policy teams_select on public.teams
  using ((select private.session_ok()) and private.is_team_member(id));

alter policy team_members_select on public.team_members
  using ((select private.session_ok()) and private.is_team_member(team_id));

alter policy players_select on public.players
  using ((select private.session_ok()) and private.is_team_member(team_id) and archived_at is null);

alter policy player_guardians_select on public.player_guardians
  using ((select private.session_ok()) and (user_id = auth.uid() or private.is_team_admin(team_id)));

alter policy events_select on public.events
  using ((select private.session_ok()) and private.is_team_member(team_id) and deleted_at is null);

alter policy attendance_select on public.attendance
  using ((select private.session_ok()) and private.is_team_member(team_id)
    and exists (select 1 from public.events e where e.id = attendance.event_id and e.deleted_at is null)
    and exists (select 1 from public.players p where p.id = attendance.player_id and p.archived_at is null));

alter policy guardian_invitations_select on public.guardian_invitations
  using ((select private.session_ok()) and private.is_guardian(player_id));

alter policy team_owner_transfers_select on public.team_owner_transfers
  using ((select private.session_ok()) and (from_user = auth.uid() or to_user = auth.uid()));

reset lock_timeout;
