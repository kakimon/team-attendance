-- =============================================================
-- ADMIN ONLY: delete two test teams and everything that belongs only to them.
-- Generated from scripts/ops/cleanup-test-teams.template.sql by scripts/ops/build-cleanup-sql.mjs
-- (the generated file pins the real ids; keep it out of the public repository).
--
-- MODE: __MODE__
--   check   : READ ONLY. Runs the checks before the deletion (identity, contents, links, protected
--             team, auth users) without locks and without DELETE, then raises CHECK_OK.
--   dry-run : runs every check, the DELETE and every post-check, then raises DRY_RUN_OK
--             -> Postgres undoes everything. Nothing can be kept in this mode.
--   commit  : the deletion is kept only if every check before and after it passed.
--
-- Atomicity: the whole job is ONE statement (a DO block). A statement is all-or-nothing in
-- Postgres, so any failed check (RAISE) undoes the DELETE too — in psql, `supabase db query`
-- and the Supabase SQL Editor alike, whatever the client does with transactions.
-- Deferred integrity triggers are forced to run inside the block (SET CONSTRAINTS ALL IMMEDIATE).
-- Output: labels and counts only (no ids, e-mails or tokens).
-- =============================================================
do $cleanup$
declare
  c_mode        constant text := '__MODE__';
  -- target teams (pinned): id, exact name, exact creation time, members as display=role=account-fingerprint
  c_a           constant uuid := '__TEAM_A_ID__';
  c_a_name      constant text := '__TEAM_A_NAME__';
  c_a_created   constant timestamptz := '__TEAM_A_CREATED__';
  c_a_members   constant text := '__TEAM_A_MEMBERS__';
  c_b           constant uuid := '__TEAM_B_ID__';
  c_b_name      constant text := '__TEAM_B_NAME__';
  c_b_created   constant timestamptz := '__TEAM_B_CREATED__';
  c_b_members   constant text := '__TEAM_B_MEMBERS__';
  -- protected team (pinned): must be byte-for-byte unchanged
  c_keep        constant uuid := '__KEEP_ID__';
  c_keep_name   constant text := '__KEEP_NAME__';
  c_keep_fp     constant text := '__KEEP_FP__';
  c_keep_counts constant text := '__KEEP_COUNTS__';   -- teams/members/children/answers/events/guardian links/invitations
  -- what the two target teams must contain in total (from the approved inventory)
  c_expect      constant text := '__EXPECT__';
  c_auth_users  constant int  := __AUTH_USERS__;

  ids uuid[] := array[c_a, c_b];
  r record; v text; n int; before_tot text; after_tot text; want_after text;
  summary text := '';
begin
  perform set_config('lock_timeout', '5s', true);
  if c_mode not in ('check', 'dry-run', 'commit') then raise exception 'STOP: unknown mode %', c_mode; end if;
  if c_a = c_keep or c_b = c_keep or c_a = c_b then raise exception 'STOP: target and protected ids overlap'; end if;
  -- lock the three teams so nothing changes underneath (fixed order); not in read-only check mode
  if c_mode <> 'check' then
    perform 1 from public.teams where id in (c_a, c_b, c_keep) order by id for update;
  end if;

  -- 1. each target team is exactly the approved one
  for r in select * from (values (c_a, c_a_name, c_a_created, c_a_members), (c_b, c_b_name, c_b_created, c_b_members))
             as x(id, name, created, members) loop
    select t.name into v from public.teams t where t.id = r.id;
    if not found then raise exception 'STOP: target team id not found (%)', r.name; end if;
    if v is distinct from r.name then raise exception 'STOP: team name differs for %', r.name; end if;
    if (select t.created_at from public.teams t where t.id = r.id) is distinct from r.created then
      raise exception 'STOP: creation time differs for %', r.name; end if;
    select string_agg(m.display_name || '=' || m.role || '=' || left(md5(m.user_id::text), 12), ';' order by m.display_name, m.role)
      into v from public.team_members m where m.team_id = r.id;
    if v is distinct from r.members then raise exception 'STOP: members/owner differ for %', r.name; end if;
  end loop;

  -- 2. contents of the targets match the approved inventory
  select format('members=%s children=%s guardians=%s events=%s answers=%s invitations=%s transfers=%s',
      (select count(*) from public.team_members where team_id = any(ids)),
      (select count(*) from public.players where team_id = any(ids)),
      (select count(*) from public.player_guardians where team_id = any(ids)),
      (select count(*) from public.events where team_id = any(ids)),
      (select count(*) from public.attendance where team_id = any(ids)),
      (select count(*) from public.guardian_invitations where team_id = any(ids)),
      (select count(*) from public.team_owner_transfers where team_id = any(ids))) into v;
  if v is distinct from c_expect then raise exception 'STOP: target contents differ: % (expected %)', v, c_expect; end if;
  summary := summary || E'\n[targets] ' || v;

  -- 3. nothing unexpected is tied to the targets
  select (select count(*) from public.attendance a join public.players p on p.id = a.player_id where p.team_id = any(ids) and not a.team_id = any(ids))
       + (select count(*) from public.attendance a join public.events e on e.id = a.event_id where e.team_id = any(ids) and not a.team_id = any(ids))
       + (select count(*) from public.player_guardians g join public.players p on p.id = g.player_id where p.team_id = any(ids) and not g.team_id = any(ids))
       + (select count(*) from public.guardian_invitations i join public.players p on p.id = i.player_id where p.team_id = any(ids) and not i.team_id = any(ids))
       + (select count(*) from public.attendance a join public.players p on p.id = a.player_id where a.team_id = any(ids) and not p.team_id = any(ids))
    into n;
  if n <> 0 then raise exception 'STOP: % rows link the targets with other teams', n; end if;
  select count(*) into n from private.account_deletions d
   where d.user_id in (select user_id from public.team_members where team_id = any(ids));
  if n <> 0 then raise exception 'STOP: a member of the targets has a pending account deletion'; end if;
  select count(*) into n from public.team_owner_transfers where team_id = any(ids);
  if n <> 0 then raise exception 'STOP: open owner hand-over request in the targets'; end if;

  -- 4. protected team is exactly as approved
  select t.name into v from public.teams t where t.id = c_keep;
  if not found or v is distinct from c_keep_name then raise exception 'STOP: protected team not found / renamed'; end if;
  select concat_ws('/', 1, (select count(*) from public.team_members where team_id = c_keep), (select count(*) from public.players where team_id = c_keep),
      (select count(*) from public.attendance where team_id = c_keep), (select count(*) from public.events where team_id = c_keep),
      (select count(*) from public.player_guardians where team_id = c_keep), (select count(*) from public.guardian_invitations where team_id = c_keep)) into v;
  if v is distinct from c_keep_counts then raise exception 'STOP: protected team counts differ: % (expected %)', v, c_keep_counts; end if;
  select md5(concat_ws('|',
      (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.teams x where x.id = c_keep),
      (select string_agg(to_jsonb(m)::text, ',' order by m.team_id, m.user_id) from public.team_members m where m.team_id = c_keep),
      (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.players p where p.team_id = c_keep),
      (select string_agg(to_jsonb(a)::text, ',' order by a.event_id, a.player_id) from public.attendance a where a.team_id = c_keep))) into v;
  if v is distinct from c_keep_fp then raise exception 'STOP: protected team fingerprint differs'; end if;
  select count(*) into n from auth.users;
  if n <> c_auth_users then raise exception 'STOP: auth users % (expected %)', n, c_auth_users; end if;

  if c_mode = 'check' then
    raise exception 'CHECK_OK (read only, nothing deleted)%', summary || E'\n[protected] ' || c_keep_name || ' ' || c_keep_counts
      || E' fingerprint matches\n[auth users] ' || c_auth_users;
  end if;

  -- whole-database totals before (teams/members/children/guardians/events/answers/invitations/transfers)
  select concat_ws('/', (select count(*) from public.teams), (select count(*) from public.team_members), (select count(*) from public.players),
      (select count(*) from public.player_guardians), (select count(*) from public.events), (select count(*) from public.attendance),
      (select count(*) from public.guardian_invitations), (select count(*) from public.team_owner_transfers)) into before_tot;

  -- 5. delete (everything else follows by ON DELETE CASCADE)
  delete from public.teams where id = any(ids);
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'STOP: deleted % teams (expected 2)', n; end if;
  execute 'set constraints all immediate';   -- run the owner / guardian integrity triggers now

  -- 6. after: targets fully gone, totals dropped by exactly the expected amounts, protected team unchanged
  select (select count(*) from public.team_members where team_id = any(ids)) + (select count(*) from public.players where team_id = any(ids))
       + (select count(*) from public.player_guardians where team_id = any(ids)) + (select count(*) from public.events where team_id = any(ids))
       + (select count(*) from public.attendance where team_id = any(ids)) + (select count(*) from public.guardian_invitations where team_id = any(ids))
       + (select count(*) from public.team_owner_transfers where team_id = any(ids)) into n;
  if n <> 0 then raise exception 'STOP: % rows of the targets remain', n; end if;
  select concat_ws('/', (select count(*) from public.teams), (select count(*) from public.team_members), (select count(*) from public.players),
      (select count(*) from public.player_guardians), (select count(*) from public.events), (select count(*) from public.attendance),
      (select count(*) from public.guardian_invitations), (select count(*) from public.team_owner_transfers)) into after_tot;
  select concat_ws('/', split_part(before_tot, '/', 1)::int - 2,
      split_part(before_tot, '/', 2)::int - substring(c_expect from 'members=(\d+)')::int,
      split_part(before_tot, '/', 3)::int - substring(c_expect from 'children=(\d+)')::int,
      split_part(before_tot, '/', 4)::int - substring(c_expect from 'guardians=(\d+)')::int,
      split_part(before_tot, '/', 5)::int - substring(c_expect from 'events=(\d+)')::int,
      split_part(before_tot, '/', 6)::int - substring(c_expect from 'answers=(\d+)')::int,
      split_part(before_tot, '/', 7)::int - substring(c_expect from 'invitations=(\d+)')::int,
      split_part(before_tot, '/', 8)::int - substring(c_expect from 'transfers=(\d+)')::int) into want_after;
  if after_tot is distinct from want_after then raise exception 'STOP: totals after % (expected %)', after_tot, want_after; end if;
  summary := summary || E'\n[database] teams/members/children/guardians/events/answers/invitations/transfers: ' || before_tot || ' -> ' || after_tot;

  select concat_ws('/', 1, (select count(*) from public.team_members where team_id = c_keep), (select count(*) from public.players where team_id = c_keep),
      (select count(*) from public.attendance where team_id = c_keep), (select count(*) from public.events where team_id = c_keep),
      (select count(*) from public.player_guardians where team_id = c_keep), (select count(*) from public.guardian_invitations where team_id = c_keep)) into v;
  if v is distinct from c_keep_counts then raise exception 'STOP: protected team counts changed: %', v; end if;
  select md5(concat_ws('|',
      (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.teams x where x.id = c_keep),
      (select string_agg(to_jsonb(m)::text, ',' order by m.team_id, m.user_id) from public.team_members m where m.team_id = c_keep),
      (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.players p where p.team_id = c_keep),
      (select string_agg(to_jsonb(a)::text, ',' order by a.event_id, a.player_id) from public.attendance a where a.team_id = c_keep))) into v;
  if v is distinct from c_keep_fp then raise exception 'STOP: protected team fingerprint changed'; end if;
  summary := summary || E'\n[protected] ' || c_keep_name || ' ' || c_keep_counts || ' fingerprint unchanged';

  select count(*) into n from auth.users;
  if n <> c_auth_users then raise exception 'STOP: auth users changed to %', n; end if;
  select (select count(*) from public.teams t where (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'owner') <> 1)
       + (select count(*) from public.players p where not exists (select 1 from public.player_guardians g where g.player_id = p.id))
       + (select count(*) from public.team_members x where not exists (select 1 from public.teams t where t.id = x.team_id))
       + (select count(*) from public.attendance x where not exists (select 1 from public.players p where p.id = x.player_id))
       + (select count(*) from public.player_guardians x where not exists (select 1 from public.players p where p.id = x.player_id))
    into n;
  if n <> 0 then raise exception 'STOP: % integrity problems after deletion', n; end if;
  summary := summary || E'\n[auth users] ' || c_auth_users || ' unchanged; integrity problems 0';

  if c_mode = 'dry-run' then
    raise exception 'DRY_RUN_OK (everything undone)%', summary;
  end if;
  raise notice 'CLEANUP_COMMITTED%', summary;
end
$cleanup$;
