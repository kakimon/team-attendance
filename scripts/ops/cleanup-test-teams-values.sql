-- Read-only: the identity values that build-cleanup-sql.mjs pins into the cleanup SQL.
--   supabase db query --linked -f scripts/ops/cleanup-test-teams-values.sql -o json > <private file>
-- The output CONTAINS TEAM IDS: write it to a private file, do not paste it anywhere public.
-- Fails (no row / error) unless each name matches exactly one team.
-- Team / display names below are FICTIONAL samples (the published copy never carries real names). Before running
-- against a real project, replace them with the real values recorded in the internal runbook (docs/internal/ops/).
with a as (select * from public.teams where name = 'テストチーム'),
     b as (select * from public.teams where name = '【テスト】ひとりチーム'),
     k as (select * from public.teams where name = 'サンプルFC'),
     chk as (select (select count(*) from a) na, (select count(*) from b) nb, (select count(*) from k) nk)
select
  (select id from a)::text as team_a_id, (select name from a) as team_a_name,
  to_char((select created_at from a) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as team_a_created,
  (select string_agg(m.display_name || '=' || m.role || '=' || left(md5(m.user_id::text), 12), ';' order by m.display_name, m.role)
     from public.team_members m where m.team_id = (select id from a)) as team_a_members,
  (select id from b)::text as team_b_id, (select name from b) as team_b_name,
  to_char((select created_at from b) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as team_b_created,
  (select string_agg(m.display_name || '=' || m.role || '=' || left(md5(m.user_id::text), 12), ';' order by m.display_name, m.role)
     from public.team_members m where m.team_id = (select id from b)) as team_b_members,
  (select id from k)::text as keep_id, (select name from k) as keep_name
from chk where na = 1 and nb = 1 and nk = 1;
