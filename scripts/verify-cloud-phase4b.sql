-- =============================================================
-- Phase 4-B: permission / session checks on a cloud DB, ROLLED BACK by construction.
--   supabase db query --linked -f scripts/verify-cloud-phase4b.sql
-- * One DO block that always ends with RAISE EXCEPTION -> every change inside is undone.
-- * Uses existing accounts and their EXISTING sessions (never creates or deletes sessions/users).
-- * Prints only labels, counts and error codes (no names, e-mails, ids or tokens).
-- * Deletes nothing. Writes tried (attendance, a new event, a new child, an invitation) are rolled back.
-- Preconditions: a team with an owner, and a member who is the guardian of a live child.
-- =============================================================
do $$
declare
  team uuid; share text; o uuid; g uuid; kid uuid; ev uuid; newkid uuid; newev uuid;
  so uuid; sg uuid; fake uuid := gen_random_uuid();
  n int; c int; v jsonb; out text := ''; bad int := 0; t text; seen text;
  tbls text[] := array['teams','team_members','players','player_guardians','events','attendance','guardian_invitations','team_owner_transfers'];
begin
  -- ---------- catalog checks (as the CLI role)
  select count(*) into n from pg_policies where schemaname = 'public' and qual like '%session_ok()%';
  out := out || E'\n[schema] SELECT policies requiring a live session: ' || n || ' / ' || (select count(*) from pg_policies where schemaname = 'public');
  if n <> 8 then bad := bad + 1; end if;
  select count(*) into n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity;
  out := out || E'\n[schema] public tables without RLS: ' || n;
  if n <> 0 then bad := bad + 1; end if;
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'execute') and p.prosrc not like '%private.require_auth()%';
  out := out || E'\n[schema] browser-callable definer RPCs without the session check: ' || n;
  if n <> 0 then bad := bad + 1; end if;
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'health_check';
  out := out || E'\n[schema] functions callable without login, other than health_check: ' || n;
  if n <> 0 then bad := bad + 1; end if;
  if has_function_privilege('authenticated', 'public.purge_account_data(uuid,uuid,interval)', 'execute')
     or has_function_privilege('authenticated', 'public.note_account_deletion_failure(uuid,text)', 'execute') then
    bad := bad + 1; out := out || E'\n[schema] ★ deletion functions callable from the browser';
  else out := out || E'\n[schema] deletion functions callable from the browser: no'; end if;
  select string_agg(r.relname || '.' || a.attname || '=' || c.confdeltype::text, ' ' order by r.relname, a.attname) into seen
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_class r on r.oid = c.conrelid
   where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.connamespace in ('public'::regnamespace, 'private'::regnamespace);
  if seen <> 'account_deletions.user_id=c attendance.updated_by=n events.created_by=n events.deleted_by=n events.updated_by=n guardian_invitations.created_by=c guardian_invitations.used_by=n player_guardians.user_id=c players.archived_by=n players.created_by=a players.updated_by=n team_members.user_id=c team_owner_transfers.from_user=c team_owner_transfers.to_user=c teams.created_by=a' then
    bad := bad + 1; out := out || E'\n[schema] ★ foreign keys differ from the design';
  else out := out || E'\n[schema] foreign keys to auth.users match the design (15 incl. new tables)'; end if;

  -- ---------- pick existing accounts and their latest existing sessions (ids stay inside)
  select m.team_id, m.user_id into team, o from public.team_members m where m.role = 'owner' limit 1;
  select share_token into share from public.teams where id = team;
  select gd.user_id, p.id into g, kid from public.player_guardians gd join public.players p on p.id = gd.player_id
   where p.team_id = team and p.archived_at is null and gd.user_id <> o limit 1;
  select id into ev from public.events where team_id = team and deleted_at is null order by starts_at desc limit 1;
  select id into so from auth.sessions where user_id = o order by created_at desc limit 1;
  select id into sg from auth.sessions where user_id = g order by created_at desc limit 1;
  if team is null or o is null or g is null or kid is null or ev is null or so is null or sg is null then
    raise exception 'PRECONDITION_FAILED team=% owner=% guardian=% child=% event=% owner_session=% guardian_session=%',
      team is not null, o is not null, g is not null, kid is not null, ev is not null, so is not null, sg is not null;
  end if;

  -- ---------- 1. no login (anon): nothing readable
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  n := 0;
  foreach t in array tbls loop
    begin execute format('select count(*) from public.%I', t) into c; n := n + 1;   -- readable at all -> bad
    exception when insufficient_privilege then null; end;
  end loop;
  out := out || E'\n[anon] tables readable without login: ' || n || ' / 8';
  if n <> 0 then bad := bad + 1; end if;
  begin perform public.account_deletion_preview(); bad := bad + 1; out := out || E'\n[anon] ★ preview RPC allowed';
  exception when others then out := out || E'\n[anon] preview RPC: refused (' || sqlstate || ')'; end;

  -- ---------- 2. normal logged-in session: everything works as before
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', g::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated', 'session_id', sg)::text, true);
  seen := '';
  foreach t in array array['teams','team_members','players','player_guardians','events','attendance'] loop
    execute format('select count(*) from public.%I', t) into c;
    if c = 0 then seen := seen || t || ' '; end if;
  end loop;
  out := out || E'\n[guardian, live session] team data visible in 6 tables: ' || case when seen = '' then 'yes' else '★ empty: ' || seen end;
  if seen <> '' then bad := bad + 1; end if;
  perform public.set_attendance(ev, kid, 'undecided', null);
  v := public.account_deletion_preview();
  perform public.my_owner_transfers();
  perform public.get_team_by_share_token(share);
  newkid := (public.register_player(team, '検証用 こども', null, true) ->> 'player_id')::uuid;
  perform public.update_player(newkid, '検証用 こども2', '1年', true);
  perform public.create_guardian_invitation(newkid);
  perform public.archive_player(newkid);
  out := out || E'\n[guardian, live session] answer own child, preview, transfers, team link, register/edit/invite/cancel a new child: OK'
    || ' (preview: kept ' || jsonb_array_length(v->'children_kept_by_family') || ', deleted ' || jsonb_array_length(v->'children_to_delete')
    || ', reauth window ' || case when (v->>'reauth_seconds_left')::int > 0 then 'open' else 'closed' end || ')';
  begin perform public.update_event(ev, 'x', now()); bad := bad + 1; out := out || E'\n[guardian] ★ member could edit an event';
  exception when others then out := out || E'\n[guardian] member edits an event: refused (' || sqlerrm || ')'; end;

  perform set_config('request.jwt.claim.sub', o::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated', 'session_id', so)::text, true);
  newev := public.create_event(team, '検証用 予定', now() + interval '30 days');
  perform public.update_event(newev, '検証用 予定2', now() + interval '31 days');
  out := out || E'\n[owner, live session] create / edit an event: OK';
  begin perform public.set_attendance(ev, kid, 'absent', null); bad := bad + 1; out := out || E'\n[owner] ★ changed another family''s child';
  exception when others then out := out || E'\n[owner] change another family''s child: refused (' || sqlerrm || ')'; end;

  -- ---------- 3. token whose session does not exist (= logged out): nothing readable, nothing writable
  foreach seen in array array['missing', 'none', 'other'] loop
    perform set_config('request.jwt.claim.sub', g::text, true);
    perform set_config('request.jwt.claims', case seen
      when 'missing' then json_build_object('sub', g, 'role', 'authenticated', 'session_id', fake)::text
      when 'none'    then json_build_object('sub', g, 'role', 'authenticated')::text
      else                json_build_object('sub', g, 'role', 'authenticated', 'session_id', so)::text end, true);
    n := 0;
    foreach t in array tbls loop
      -- guardian_invitations: the browser may read only some columns, so count(id)
      execute format('select count(%s) from public.%I', case when t = 'guardian_invitations' then 'id' else '*' end, t) into c;
      n := n + c;
    end loop;
    out := out || E'\n[guardian, session ' || seen || '] rows visible in 8 tables: ' || n;
    if n <> 0 then bad := bad + 1; end if;
    begin perform public.set_attendance(ev, kid, 'attend', null); bad := bad + 1; out := out || ' ★ write allowed';
    exception when others then out := out || ', write: refused (' || sqlerrm || ')'; end;
    begin perform public.account_deletion_preview(); bad := bad + 1; out := out || ' ★ read RPC allowed';
    exception when others then out := out || ', read RPC: refused (' || sqlerrm || ')'; end;
  end loop;

  -- always roll back
  raise exception 'VERIFY_RESULT（全てロールバック済み） problems=% %', bad, out;
end
$$;
