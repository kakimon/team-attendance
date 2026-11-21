-- =============================================================
-- Rollback of 20261117100000_join_tokens.sql (Phase 5-B U2).
-- Removes the join-token RPCs, the trigger and the private token table. App tables are not
-- touched. Lost on rollback: the join tokens (rotations / stops). The old path
-- join_team(share_token) was never changed, so joining through old links keeps working.
-- =============================================================
drop function if exists public.resolve_legacy_team(text);
drop function if exists public.join_by_token(text, text);
drop function if exists public.preview_join(text);
drop function if exists public.set_join_open(uuid, boolean);
drop function if exists public.rotate_join_token(uuid);
drop function if exists public.get_join_link(uuid);
drop trigger if exists teams_add_join_token on public.teams;
drop function if exists private.add_join_token();
drop function if exists private.can_manage_join(uuid, uuid);
drop table if exists private.team_join_tokens;
