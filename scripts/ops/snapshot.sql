-- Read-only snapshot: row count + md5 of every column of each table.
-- Only the columns ADDED by Phase 4-A (events/players) are excluded, so before/after can be compared.
-- supabase db query --linked -f scripts/ops/snapshot.sql
select t.tbl, t.n, t.hash from (
  select 'teams' tbl, count(*) n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id::text), '')) hash from public.teams x
  union all select 'team_members', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.team_id::text, x.user_id::text), '')) from public.team_members x
  union all select 'players', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'updated_at' - 'updated_by' - 'archived_by')::text, '|' order by x.id::text), '')) from public.players x
  union all select 'player_guardians', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.player_id::text, x.user_id::text), '')) from public.player_guardians x
  union all select 'events', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'updated_at' - 'updated_by' - 'deleted_at' - 'deleted_by')::text, '|' order by x.id::text), '')) from public.events x
  union all select 'attendance', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.event_id::text, x.player_id::text), '')) from public.attendance x
  union all select 'guardian_invitations', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id::text), '')) from public.guardian_invitations x
  union all select 'auth.users (count only)', count(*), '-' from auth.users
) t
