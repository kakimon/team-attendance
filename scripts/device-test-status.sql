-- =============================================================
-- Read-only status for the Phase 4-B device tests (cloud).
--   supabase db query --linked -f scripts/device-test-status.sql
-- Reports only teams whose name starts with 【テスト】 (the dedicated test teams),
-- plus whole-database integrity counts. No user names, e-mails, ids or tokens are printed.
-- =============================================================
select section, item, value from (
  select 1 o, 'test team: ' || t.name as section, 'members (owner/admin/member)' as item,
         concat_ws('/', count(*) filter (where m.role = 'owner'), count(*) filter (where m.role = 'admin'),
                   count(*) filter (where m.role = 'member')) as value
    from public.teams t join public.team_members m on m.team_id = t.id
   where t.name like '【テスト】%' group by t.name
  union all
  select 2, 'test team: ' || t.name, 'children (live / cancelled)',
         concat_ws(' / ', count(*) filter (where p.archived_at is null), count(*) filter (where p.archived_at is not null))
    from public.teams t join public.players p on p.team_id = t.id
   where t.name like '【テスト】%' group by t.name
  union all
  select 3, 'test team: ' || t.name, 'children by number of guardians (0 / 1 / 2+)',
         concat_ws(' / ', count(*) filter (where g = 0), count(*) filter (where g = 1), count(*) filter (where g >= 2))
    from public.teams t join (select p.team_id, (select count(*) from public.player_guardians x where x.player_id = p.id) g
                                from public.players p) c on c.team_id = t.id
   where t.name like '【テスト】%' group by t.name
  union all
  select 4, 'test team: ' || t.name, 'answers / events / open hand-over requests',
         concat_ws(' / ', (select count(*) from public.attendance a where a.team_id = t.id),
                   (select count(*) from public.events e where e.team_id = t.id and e.deleted_at is null),
                   (select count(*) from public.team_owner_transfers x where x.team_id = t.id))
    from public.teams t where t.name like '【テスト】%'
  union all
  select 5, 'whole database', 'auth users / login sessions / pending account deletions',
         concat_ws(' / ', (select count(*) from auth.users), (select count(*) from auth.sessions), (select count(*) from private.account_deletions))
  union all
  select 6, 'whole database', 'teams without exactly one owner (must be 0)', count(*)::text
    from public.teams t where (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'owner') <> 1
  union all
  select 7, 'whole database', 'children without any guardian (must be 0)', count(*)::text
    from public.players p where not exists (select 1 from public.player_guardians g where g.player_id = p.id)
  union all
  select 8, 'whole database', 'rows pointing at a missing auth user (must be 0)', (
      (select count(*) from public.team_members m where not exists (select 1 from auth.users u where u.id = m.user_id))
    + (select count(*) from public.player_guardians g where not exists (select 1 from auth.users u where u.id = g.user_id)))::text
  union all
  select 9, 'whole database', 'non-test teams / their members / children / answers (must not change)', concat_ws(' / ',
    (select count(*) from public.teams where name not like '【テスト】%'),
    (select count(*) from public.team_members m join public.teams t on t.id = m.team_id where t.name not like '【テスト】%'),
    (select count(*) from public.players p join public.teams t on t.id = p.team_id where t.name not like '【テスト】%'),
    (select count(*) from public.attendance a join public.teams t on t.id = a.team_id where t.name not like '【テスト】%'))
  union all
  select 10, 'whole database', 'non-test data fingerprint (must not change)', md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.teams x where x.name not like '【テスト】%'),
    (select string_agg(to_jsonb(m)::text, ',' order by m.team_id, m.user_id) from public.team_members m join public.teams t on t.id = m.team_id where t.name not like '【テスト】%'),
    (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.players p join public.teams t on t.id = p.team_id where t.name not like '【テスト】%'),
    (select string_agg(to_jsonb(a)::text, ',' order by a.event_id, a.player_id) from public.attendance a join public.teams t on t.id = a.team_id where t.name not like '【テスト】%')))
) s order by o, section;
