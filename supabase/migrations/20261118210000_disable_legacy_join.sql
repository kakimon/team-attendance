-- =============================================================
-- Phase 5 D5: the old join path (share_token) is closed in the database.
--
--   join_team(share_token, name)        -> always refused: 'legacy_join_disabled' (no new membership)
--   get_team_by_share_token(share_token) -> always refused: 'legacy_join_disabled' (no team name / role)
--
-- Two layers, so that a grant restored by mistake still opens nothing:
--   1. EXECUTE is revoked from PUBLIC, anon, authenticated and service_role.
--   2. The bodies themselves refuse and read no table (the error is the same for every token, valid or
--      not, member or not: nothing about a team can be learnt from it).
-- Kept as they are: resolve_legacy_team (old bookmarks of EXISTING members only), join_by_token,
-- preview_join, family invitations, join link re-issue / stop / reopen, teams.share_token (bookmarks),
-- RLS, data. Signatures and return types do not change.
--
-- Deployment order: the app published before Phase 5-C still calls both functions for its team pages.
-- Apply this only AFTER the new app (/t/<team id>, /join/<token>) is live.
-- Rollback: supabase/rollback/20261118210000_disable_legacy_join_down.sql (guarded; re-opens the old path)
-- =============================================================
begin;

create or replace function public.join_team(p_share_token text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_auth();
  -- D5: joining by the old share token is closed. Use the team's join link (join_by_token).
  raise exception 'legacy_join_disabled' using errcode = '42501';
end;
$$;

create or replace function public.get_team_by_share_token(p_share_token text)
returns table (id uuid, name text, is_member boolean, role text)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_auth();
  -- D5: nothing is told about a team from the old share token. Members move old bookmarks with
  -- resolve_legacy_team; newcomers use preview_join / join_by_token.
  raise exception 'legacy_join_disabled' using errcode = '42501';
end;
$$;

revoke all on function public.join_team(text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_team_by_share_token(text) from public, anon, authenticated, service_role;

commit;
