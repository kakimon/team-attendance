-- Read-only logical backup of the app data as one JSON document — for the LATEST schema
-- (a known latest state: 17 migrations up to 20261118210000, 18 with 20261124000000, or 19 with 20261126000000). No Docker needed.
--   supabase db query --linked --agent no --output-format json -f scripts/ops/backup_tables_latest.sql > <backup-dir>/tables.json
-- On the Phase 4-B schema this file fails (the Phase 5 tables do not exist yet): use scripts/ops/backup_tables.sql there.
-- private.rate_events (attempt counters) is intentionally left out: it is not needed to restore the app.
-- One SELECT = one snapshot. The output contains names, join tokens and invitation token hashes:
-- keep it OUTSIDE any repository (mode 600). Auth users are NOT included; only their number is recorded.
select jsonb_build_object(
  'format', 3,
  'kind', 'latest',
  'taken_at', now(),
  'migrations', (select coalesce(jsonb_agg(version::text order by version), '[]') from supabase_migrations.schema_migrations),
  'auth_users_count', (select count(*) from auth.users),
  'counts', jsonb_build_object(
    'teams', (select count(*) from public.teams),
    'team_members', (select count(*) from public.team_members),
    'players', (select count(*) from public.players),
    'player_guardians', (select count(*) from public.player_guardians),
    'events', (select count(*) from public.events),
    'attendance', (select count(*) from public.attendance),
    'guardian_invitations', (select count(*) from public.guardian_invitations),
    'team_owner_transfers', (select count(*) from public.team_owner_transfers),
    'account_deletions', (select count(*) from private.account_deletions),
    'team_join_tokens', (select count(*) from private.team_join_tokens),
    'team_member_blocks', (select count(*) from private.team_member_blocks)),
  'teams',                (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.teams x),
  'team_members',         (select coalesce(jsonb_agg(to_jsonb(x) order by x.team_id, x.user_id), '[]') from public.team_members x),
  'players',              (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.players x),
  'player_guardians',     (select coalesce(jsonb_agg(to_jsonb(x) order by x.player_id, x.user_id), '[]') from public.player_guardians x),
  'events',               (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.events x),
  'attendance',           (select coalesce(jsonb_agg(to_jsonb(x) order by x.event_id, x.player_id), '[]') from public.attendance x),
  'guardian_invitations', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.guardian_invitations x),
  'team_owner_transfers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.team_id), '[]') from public.team_owner_transfers x),
  'account_deletions',    (select coalesce(jsonb_agg(to_jsonb(x) order by x.user_id), '[]') from private.account_deletions x),
  'team_join_tokens',     (select coalesce(jsonb_agg(to_jsonb(x) order by x.team_id), '[]') from private.team_join_tokens x),
  'team_member_blocks',   (select coalesce(jsonb_agg(to_jsonb(x) order by x.team_id, x.user_id), '[]') from private.team_member_blocks x)
) as backup;
