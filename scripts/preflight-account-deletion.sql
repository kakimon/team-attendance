-- =============================================================
-- Read-only pre-flight check before applying the two Phase 4-B migrations
--   20261113000000_account_deletion.sql  ->  20261113100000_session_bound_reads.sql
--   supabase db query --linked -f scripts/preflight-account-deletion.sql   (after checking the ref)
-- Prints counts only (no names, e-mails or ids). Every "must be 0" row has to be 0.
-- =============================================================
select item, value, expected from (
  select 1 o, 'migration already applied' item,
         (to_regprocedure('public.purge_account_data(uuid,uuid,interval)') is not null)::int::text value, '0' expected
  union all select 1, 'session-bound reads applied (2nd migration)',
         (to_regprocedure('private.session_ok()') is not null)::int::text, 'info'
  union all select 2, 'teams without exactly one owner (must be 0)', count(*)::text, '0'
    from public.teams t where (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'owner') <> 1
  union all select 3, 'children without any guardian (must be 0)', count(*)::text, '0'
    from public.players p where not exists (select 1 from public.player_guardians g where g.player_id = p.id)
  union all select 4, 'rows pointing at a missing auth user (must be 0)', (
      (select count(*) from public.team_members m where not exists (select 1 from auth.users u where u.id = m.user_id))
    + (select count(*) from public.player_guardians g where not exists (select 1 from auth.users u where u.id = g.user_id)))::text, '0'
  union all select 5, 'auth users', count(*)::text, 'info' from auth.users
  union all select 6, 'auth users with a live session (others must log in again for RPCs after the change)',
    count(distinct s.user_id)::text, 'info' from auth.sessions s
  union all select 7, 'teams / members / children / events / answers / invitations', concat_ws(' / ',
    (select count(*) from public.teams), (select count(*) from public.team_members), (select count(*) from public.players),
    (select count(*) from public.events), (select count(*) from public.attendance), (select count(*) from public.guardian_invitations)), 'info'
  union all select 8, 'data fingerprint (compare before/after: the migration must not change it)', md5(concat_ws('|',
    (select string_agg(to_jsonb(t)::text, ',' order by id) from public.teams t),
    (select string_agg(to_jsonb(m)::text, ',' order by team_id, user_id) from public.team_members m),
    (select string_agg(to_jsonb(p)::text, ',' order by id) from public.players p),
    (select string_agg(to_jsonb(g)::text, ',' order by player_id, user_id) from public.player_guardians g),
    (select string_agg(to_jsonb(e)::text, ',' order by id) from public.events e),
    (select string_agg(to_jsonb(a)::text, ',' order by event_id, player_id) from public.attendance a),
    (select string_agg((to_jsonb(i) - 'token_hash')::text, ',' order by id) from public.guardian_invitations i))), 'info'
) x order by o;
