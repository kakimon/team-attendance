-- =============================================================
-- Phase 6: READ-ONLY usage inventory of the production database (counts and dates only).
--
--   supabase db query --linked -f scripts/ops/usage-inventory.sql
--
-- Safety
--   * One DO block. Its first statement switches the transaction to READ ONLY, so any write would fail.
--   * It ends with RAISE EXCEPTION carrying the report: the transaction is always rolled back as well.
--     (Same proven pattern as scripts/verify-cloud-phase4b.sql; the CLI prints the message and exits non-zero.)
--   * Success = the last line is exactly "USAGE_REPORT_COMPLETE sections=7/7" (all sections 0-6 counted):
--       grep -qx 'USAGE_REPORT_COMPLETE sections=7/7' <saved output>
--     "USAGE_REPORT_INCOMPLETE unavailable=N" = ran to the end but N items were n/a / no permission (not a success).
--     No marker at all = an unexpected error stopped it (not a success). The exit code is 1 in every case.
--   * Prints ONLY counts, dates (day precision) and migration versions. Never e-mails, names, user ids,
--     team names, tokens or invitation links. Teams are numbered #1, #2, ... by creation time.
--   * Works on the current production schema (Phase 4-B, migrations up to 20261113100000) and on any later
--     schema of this app: every section runs through EXECUTE and reports "n/a" for an object that does not
--     exist and "no permission" for one the caller may not read (it never stops the report).
--   * No locks are taken explicitly; plain SELECTs only.
-- Only for this app's own Supabase project: check the linked project ref before running (not for any other project).
-- =============================================================
do $$
declare
  r text := '';
  v text;
  v_unavailable int := 0;   -- items that could not be counted (missing object / no permission)
begin
  set transaction read only;   -- from here on, any write in this transaction is refused by PostgreSQL

  r := r || E'\n== 0. schema state';
  begin execute $q$select count(*)::text from supabase_migrations.schema_migrations$q$ into v;
    r := r || E'\nmigrations applied: ' || v;
    execute $q$select coalesce(string_agg(version, ' ' order by version), '-') from supabase_migrations.schema_migrations$q$ into v;
    r := r || E'\nmigration versions: ' || v;
  exception when undefined_table then v_unavailable := v_unavailable + 1; r := r || E'\nmigrations: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nmigrations: no permission (use: supabase migration list --linked)'; end;
  begin execute $q$select case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'players' and column_name = 'is_self') then 'yes' else 'no' end$q$ into v;
    r := r || E'\nself-registration columns present (D3.5): ' || v;
  end;

  r := r || E'\n== 1. Auth';
  begin
    execute $q$select format('users: %s | created last 30d: %s | last 90d: %s',
        count(*), count(*) filter (where created_at > now() - interval '30 days'), count(*) filter (where created_at > now() - interval '90 days'))
      from auth.users$q$ into v;
    r := r || E'\n' || v;
    execute $q$select format('signed in last 30d: %s | last 90d: %s | never: %s | latest sign-in (day, UTC): %s',
        count(*) filter (where last_sign_in_at > now() - interval '30 days'), count(*) filter (where last_sign_in_at > now() - interval '90 days'),
        count(*) filter (where last_sign_in_at is null), coalesce(to_char(max(last_sign_in_at), 'YYYY-MM-DD'), '-'))
      from auth.users$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nauth.users: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nauth.users: no permission (use the Dashboard: Authentication > Users, count only)'; end;
  begin
    execute $q$select format('sessions: %s | updated last 30d: %s', count(*), count(*) filter (where updated_at > now() - interval '30 days')) from auth.sessions$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nauth.sessions: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nauth.sessions: no permission'; end;
  begin
    execute $q$select coalesce(string_agg(provider || ': ' || n, ' | ' order by provider), 'none') from (select provider, count(*) n from auth.identities group by provider) x$q$ into v;
    r := r || E'\nidentities by provider: ' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nauth.identities: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nauth.identities: no permission'; end;

  r := r || E'\n== 2. teams (numbered by creation time; no names)';
  begin
    execute $q$select format('teams: %s | created last 30d: %s | last 90d: %s', count(*),
        count(*) filter (where created_at > now() - interval '30 days'), count(*) filter (where created_at > now() - interval '90 days')) from public.teams$q$ into v;
    r := r || E'\n' || v;
    execute $q$select coalesce(string_agg(line, E'\n' order by rn), '(no teams)') from (
        select row_number() over (order by t.created_at, t.id) rn,
          format('#%s created %s | test-team name prefix: %s | members %s (owner %s, admin %s, member %s) | registrations %s (cancelled %s) | events %s | answers %s | last answer %s',
            row_number() over (order by t.created_at, t.id), to_char(t.created_at, 'YYYY-MM-DD'),
            case when t.name like '【テスト】%' then 'yes' else 'no' end,
            (select count(*) from public.team_members m where m.team_id = t.id),
            (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'owner'),
            (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'admin'),
            (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'member'),
            (select count(*) from public.players p where p.team_id = t.id),
            (select count(*) from public.players p where p.team_id = t.id and p.archived_at is not null),
            (select count(*) from public.events e where e.team_id = t.id),
            (select count(*) from public.attendance a where a.team_id = t.id),
            coalesce((select to_char(max(a.updated_at), 'YYYY-MM-DD') from public.attendance a where a.team_id = t.id), '-')) line
        from public.teams t) x$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nteams: n/a (' || sqlerrm || ')';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nteams: no permission'; end;

  r := r || E'\n== 3. registrations';
  begin
    -- is_self is read through to_jsonb, so this also works before D3.5 (then every registration is a proxy one)
    execute $q$select format('registrations: %s (active %s, cancelled %s) | self (as a person): %s | proxy: %s',
        count(*), count(*) filter (where archived_at is null), count(*) filter (where archived_at is not null),
        count(*) filter (where to_jsonb(p) ->> 'is_self' = 'true'), count(*) filter (where coalesce(to_jsonb(p) ->> 'is_self', 'false') <> 'true'))
      from public.players p$q$ into v;
    r := r || E'\n' || v;
    execute $q$select format('guardian links: %s | registrations with 2+ guardians (shared): %s | registrations without any guardian: %s',
        (select count(*) from public.player_guardians),
        (select count(*) from (select player_id from public.player_guardians group by player_id having count(*) > 1) s),
        (select count(*) from public.players p where not exists (select 1 from public.player_guardians g where g.player_id = p.id)))$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nregistrations: n/a (' || sqlerrm || ')';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nregistrations: no permission'; end;

  r := r || E'\n== 4. events and answers';
  begin
    execute $q$select format('events: %s (deleted %s, upcoming %s) | created last 30d: %s | last 90d: %s',
        count(*), count(*) filter (where deleted_at is not null), count(*) filter (where deleted_at is null and starts_at > now()),
        count(*) filter (where created_at > now() - interval '30 days'), count(*) filter (where created_at > now() - interval '90 days')) from public.events$q$ into v;
    r := r || E'\n' || v;
    execute $q$select format('answers: %s (attend %s, absent %s, undecided %s) | updated last 30d: %s | last 90d: %s | latest (day, UTC): %s',
        count(*), count(*) filter (where status = 'attend'), count(*) filter (where status = 'absent'), count(*) filter (where status = 'undecided'),
        count(*) filter (where updated_at > now() - interval '30 days'), count(*) filter (where updated_at > now() - interval '90 days'),
        coalesce(to_char(max(updated_at), 'YYYY-MM-DD'), '-')) from public.attendance$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nevents/answers: n/a (' || sqlerrm || ')';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nevents/answers: no permission'; end;

  r := r || E'\n== 5. activity in the last 30 / 90 days';
  begin
    execute $q$select format('joined a team: %s / %s | registered someone: %s / %s',
        (select count(*) from public.team_members where joined_at > now() - interval '30 days'), (select count(*) from public.team_members where joined_at > now() - interval '90 days'),
        (select count(*) from public.players where created_at > now() - interval '30 days'), (select count(*) from public.players where created_at > now() - interval '90 days'))$q$ into v;
    r := r || E'\n' || v;
    execute $q$select format('distinct accounts that answered: %s / %s', count(distinct updated_by) filter (where updated_at > now() - interval '30 days'),
        count(distinct updated_by) filter (where updated_at > now() - interval '90 days')) from public.attendance$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nactivity: n/a (' || sqlerrm || ')';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nactivity: no permission'; end;

  r := r || E'\n== 6. open procedures';
  begin
    execute $q$select format('family invitations: %s | unused and valid: %s | unused, expired: %s | used: %s | revoked: %s',
        count(*), count(*) filter (where used_at is null and revoked_at is null and expires_at > now()),
        count(*) filter (where used_at is null and revoked_at is null and expires_at <= now()),
        count(*) filter (where used_at is not null), count(*) filter (where revoked_at is not null)) from public.guardian_invitations$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\ninvitations: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\ninvitations: no permission'; end;
  begin
    execute $q$select format('owner hand-over requests: %s | still valid: %s', count(*), count(*) filter (where expires_at > now())) from public.team_owner_transfers$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\nowner hand-over requests: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\nowner hand-over requests: no permission'; end;
  begin
    execute $q$select format('account deletions left half-way (data removed, Auth user remains): %s | with a recorded error: %s',
        count(*), count(*) filter (where last_error is not null)) from private.account_deletions$q$ into v;
    r := r || E'\n' || v;
  exception when undefined_table or undefined_column then v_unavailable := v_unavailable + 1; r := r || E'\naccount deletions: n/a';
            when insufficient_privilege then v_unavailable := v_unavailable + 1; r := r || E'\naccount deletions: no permission'; end;

  -- end marker: the ONLY sign of success. It is built here, after every section, so an unexpected error anywhere
  -- above (which aborts the block) can never produce it; any "n/a" / "no permission" turns it into INCOMPLETE.
  r := r || E'\n' || case when v_unavailable = 0 then format('USAGE_REPORT_COMPLETE sections=%s/7', 7)
                            else format('USAGE_REPORT_INCOMPLETE unavailable=%s', v_unavailable) end;
  raise exception 'USAGE_REPORT（読み取り専用・ロールバック済み）%', r;
end
$$;
