-- =============================================================
-- Public usage numbers for the top page (logged-out visitors, publishable / anon key).
--
-- public.service_stats() returns ONLY three counts and the time they were taken:
--   users   = Auth accounts, minus accounts whose deletion has started (private.account_deletions)
--   teams   = teams (public.teams)
--   answers = attendance answers currently recorded (public.attendance: one row per person and event;
--             changing an answer updates that row, "unanswered" removes it). A true running total of
--             every answer ever sent is not stored anywhere, so it cannot be computed.
-- Never returns ids, names, e-mails, team or answer contents. Reads only counts (SECURITY DEFINER so it can
-- count through RLS; search_path fixed). Writes nothing. No table, column, RLS or data change.
-- EXECUTE: anon only (like health_check). Signed-in users and service_role do not need it.
-- Rollback: supabase/rollback/20261126000000_service_stats_down.sql
-- =============================================================
begin;

create function public.service_stats()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'users', (select count(*) from auth.users u
               where not exists (select 1 from private.account_deletions d where d.user_id = u.id)),
    'teams', (select count(*) from public.teams),
    'answers', (select count(*) from public.attendance),
    'counted_at', now()
  );
$$;

revoke all on function public.service_stats() from public, authenticated, service_role;
grant execute on function public.service_stats() to anon;

commit;
