-- =============================================================
-- Lightweight health check for the daily GitHub Actions job.
-- * Callable with the publishable (anon) key. No service_role, no DB password.
-- * SECURITY INVOKER and reads no table rows: only checks that the schema exists
--   (to_regclass needs no table privileges) and returns the DB clock.
-- * Writes nothing.
-- =============================================================
create or replace function public.health_check()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'database', to_regclass('public.teams') is not null
            and to_regclass('public.attendance') is not null,
    'checkedAt', now()
  );
$$;

-- Least privilege: only the publishable (anon) key needs it. Supabase's default
-- privileges would also grant signed-in users, so revoke that explicitly.
revoke execute on function public.health_check() from public, authenticated;
grant execute on function public.health_check() to anon;
