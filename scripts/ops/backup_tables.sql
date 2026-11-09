-- Read-only logical backup of all app tables as one JSON document (no Docker needed).
--   supabase db query --linked --output-format json -f scripts/ops/backup_tables.sql > <backup-dir>/tables.json
-- The output contains display names and children's names: keep it OUTSIDE any repository.
select jsonb_build_object(
  'taken_at', now(),
  'teams',                (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.teams x),
  'team_members',         (select coalesce(jsonb_agg(to_jsonb(x) order by x.team_id, x.user_id), '[]') from public.team_members x),
  'players',              (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.players x),
  'player_guardians',     (select coalesce(jsonb_agg(to_jsonb(x) order by x.player_id, x.user_id), '[]') from public.player_guardians x),
  'events',               (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.events x),
  'attendance',           (select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id, x.player_id), '[]') from public.attendance x),
  'guardian_invitations', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.guardian_invitations x)
) as backup;
