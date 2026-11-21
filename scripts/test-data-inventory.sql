-- =============================================================
-- Read-only inventory of every team and its data, for cleaning up test data.
--   supabase db query --linked -f scripts/test-data-inventory.sql
-- SELECT only. Prints team / child / event names and display names (nicknames chosen in the app),
-- never e-mails, user ids, tokens or invitation links. The protected team is summarised only.
-- Accounts are shown as per-team display names; "acct#n" numbers the same account across teams.
-- Team / display names below are FICTIONAL samples (the published copy never carries real names). Before running
-- against a real project, replace them with the real values recorded in the internal runbook (docs/internal/ops/).
-- =============================================================
with keep as (select id from public.teams where name = 'サンプルFC'),
acct as (select u.id, 'acct#' || row_number() over (order by u.created_at) as tag from auth.users u),
t as (select * from public.teams)
select sec, team, item, detail from (
  -- 1. every team
  select 10 o, '1 team' sec, t.name team, 'created (JST) / owner / members' item,
    to_char(t.created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' / '
    || coalesce((select m.display_name from public.team_members m where m.team_id = t.id and m.role = 'owner'), 'NONE') || ' / '
    || (select string_agg(m.display_name || '=' || m.role || '(' || a.tag || ')', ', ' order by m.role, m.display_name)
          from public.team_members m join acct a on a.id = m.user_id where m.team_id = t.id) detail
  from t
  union all select 11, '1 team', t.name, 'children live/cancelled | events live/deleted | answers | invitations unused-valid/used/revoked/expired | hand-overs',
    (select count(*) filter (where archived_at is null) || '/' || count(*) filter (where archived_at is not null) from public.players where team_id = t.id) || ' | '
    || (select count(*) filter (where deleted_at is null) || '/' || count(*) filter (where deleted_at is not null) from public.events where team_id = t.id) || ' | '
    || (select count(*) from public.attendance where team_id = t.id) || ' | '
    || (select count(*) filter (where used_at is null and revoked_at is null and expires_at > now()) || '/' || count(*) filter (where used_at is not null)
          || '/' || count(*) filter (where revoked_at is not null) || '/' || count(*) filter (where used_at is null and revoked_at is null and expires_at <= now())
        from public.guardian_invitations where team_id = t.id) || ' | '
    || (select count(*) from public.team_owner_transfers where team_id = t.id)
  from t
  -- 2. children / events / answers of every team except the protected one
  union all select 20, '2 child', t.name, p.name,
    'note=' || coalesce(p.note, '-') || ' | ' || case when p.archived_at is null then 'live' else 'cancelled' end
    || ' | guardians=' || coalesce((select string_agg(coalesce(tm.display_name, '?') || '(' || a.tag || ')', '+' order by tm.display_name)
          from public.player_guardians g join acct a on a.id = g.user_id
          left join public.team_members tm on tm.team_id = g.team_id and tm.user_id = g.user_id where g.player_id = p.id), '-')
    || ' | answers=' || (select count(*) from public.attendance x where x.player_id = p.id)
    || ' | invitations=' || (select count(*) from public.guardian_invitations i where i.player_id = p.id)
    || ' | created ' || to_char(p.created_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI')
  from public.players p join t on t.id = p.team_id where t.id not in (select id from keep)
  union all select 21, '2 event', t.name, e.title,
    to_char(e.starts_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' | ' || case when e.deleted_at is null then 'live' else 'deleted' end
    || ' | answers attend/absent/undecided=' || (select count(*) filter (where status = 'attend') || '/' || count(*) filter (where status = 'absent')
          || '/' || count(*) filter (where status = 'undecided') from public.attendance x where x.event_id = e.id)
    || ' | created ' || to_char(e.created_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI')
  from public.events e join t on t.id = e.team_id where t.id not in (select id from keep)
  union all select 22, '2 invitation', t.name, 'for child ' || p.name,
    case when i.used_at is not null then 'used' when i.revoked_at is not null then 'revoked' when i.expires_at <= now() then 'expired' else 'UNUSED-VALID' end
    || ' | created by ' || coalesce(ca.tag, 'deleted account') || ' | used by ' || coalesce(ua.tag, case when i.used_at is null then '-' else 'deleted account' end)
  from public.guardian_invitations i join t on t.id = i.team_id join public.players p on p.id = i.player_id
  left join acct ca on ca.id = i.created_by left join acct ua on ua.id = i.used_by where t.id not in (select id from keep)
  -- 3. accounts: where each one belongs (a delete-by-user would touch every one of these teams)
  union all select 30, '3 account', a.tag, 'teams (display name=role)',
    coalesce((select string_agg(tt.name || ': ' || m.display_name || '=' || m.role, ', ' order by tt.name)
       from public.team_members m join public.teams tt on tt.id = m.team_id where m.user_id = a.id), 'no team')
    || ' | auth created ' || to_char(u.created_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI') || ' | sessions ' || (select count(*) from auth.sessions s where s.user_id = a.id)
  from acct a join auth.users u on u.id = a.id
  -- 4. name-independent search
  union all select 40, '4 created on/after 2026-11-13 JST', t.name, 'teams/children/events/answers/invitations',
    (case when t.created_at >= '2026-11-13 00:00+09' then 1 else 0 end) || '/'
    || (select count(*) from public.players where team_id = t.id and created_at >= '2026-11-13 00:00+09') || '/'
    || (select count(*) from public.events where team_id = t.id and created_at >= '2026-11-13 00:00+09') || '/'
    || (select count(*) from public.attendance where team_id = t.id and updated_at >= '2026-11-13 00:00+09') || '/'
    || (select count(*) from public.guardian_invitations where team_id = t.id and created_at >= '2026-11-13 00:00+09')
  from t
  union all select 41, '4 names containing テスト', t.name, 'team/children/events',
    (t.name like '%テスト%')::text || ' / ' || (select count(*) from public.players where team_id = t.id and name like '%テスト%')
    || ' / ' || (select count(*) from public.events where team_id = t.id and title like '%テスト%')
  from t
  -- 5. protected team
  union all select 50, '5 protected', 'サンプルFC', 'teams/members/children/answers/events(all)',
    concat_ws(' / ', (select count(*) from keep), (select count(*) from public.team_members where team_id in (select id from keep)),
      (select count(*) from public.players where team_id in (select id from keep)), (select count(*) from public.attendance where team_id in (select id from keep)),
      (select count(*) from public.events where team_id in (select id from keep)))
  union all select 51, '5 protected', 'サンプルFC', 'owner count / guardian links / invitations used/unused-valid/other / blank recorders',
    concat_ws(' / ', (select count(*) from public.team_members where team_id in (select id from keep) and role = 'owner'),
      (select count(*) from public.player_guardians where team_id in (select id from keep)),
      (select count(*) filter (where used_at is not null) || '/' || count(*) filter (where used_at is null and revoked_at is null and expires_at > now())
         || '/' || count(*) filter (where used_at is null and (revoked_at is not null or expires_at <= now())) from public.guardian_invitations where team_id in (select id from keep)),
      (select count(*) from public.attendance where team_id in (select id from keep) and updated_by is null)
        + (select count(*) from public.events where team_id in (select id from keep) and created_by is null)
        + (select count(*) from public.players where team_id in (select id from keep) and created_by is null))
  union all select 52, '5 protected', 'サンプルFC', 'fingerprint (teams/members/children/answers)', md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.teams x where x.id in (select id from keep)),
    (select string_agg(to_jsonb(m)::text, ',' order by m.team_id, m.user_id) from public.team_members m where m.team_id in (select id from keep)),
    (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.players p where p.team_id in (select id from keep)),
    (select string_agg(to_jsonb(a)::text, ',' order by a.event_id, a.player_id) from public.attendance a where a.team_id in (select id from keep))))
  union all select 53, '5 protected', 'サンプルFC', 'rows of other teams that point into it (must be 0)', (
      (select count(*) from public.attendance a join public.events e on e.id = a.event_id where e.team_id in (select id from keep) and a.team_id not in (select id from keep))
    + (select count(*) from public.player_guardians g join public.players p on p.id = g.player_id where p.team_id in (select id from keep) and g.team_id not in (select id from keep))
    + (select count(*) from public.guardian_invitations i join public.players p on p.id = i.player_id where p.team_id in (select id from keep) and i.team_id not in (select id from keep)))::text
  -- 6. if each non-protected team were deleted: rows removed with it (all FKs to teams/players/events are CASCADE)
  union all select 60, '6 delete simulation', t.name, 'removed with the team: members/children/guardian links/events/answers/invitations/hand-overs',
    concat_ws(' / ', (select count(*) from public.team_members where team_id = t.id), (select count(*) from public.players where team_id = t.id),
      (select count(*) from public.player_guardians where team_id = t.id), (select count(*) from public.events where team_id = t.id),
      (select count(*) from public.attendance where team_id = t.id), (select count(*) from public.guardian_invitations where team_id = t.id),
      (select count(*) from public.team_owner_transfers where team_id = t.id))
    || ' | rows elsewhere pointing into it: ' || (
      (select count(*) from public.attendance a join public.players p on p.id = a.player_id where p.team_id = t.id and a.team_id <> t.id)
    + (select count(*) from public.player_guardians g join public.players p on p.id = g.player_id where p.team_id = t.id and g.team_id <> t.id))
    || ' | accounts left with no team afterwards: ' || (select count(*) from public.team_members m where m.team_id = t.id
          and not exists (select 1 from public.team_members o where o.user_id = m.user_id and o.team_id <> t.id))
  from t where t.id not in (select id from keep)
  -- 7. integrity / leftovers
  union all select 70, '7 integrity', '-', 'teams with owners<>1 / children without guardian / pending deletions / hand-overs',
    concat_ws(' / ', (select count(*) from public.teams x where (select count(*) from public.team_members m where m.team_id = x.id and m.role = 'owner') <> 1),
      (select count(*) from public.players p where not exists (select 1 from public.player_guardians g where g.player_id = p.id)),
      (select count(*) from private.account_deletions), (select count(*) from public.team_owner_transfers))
  union all select 71, '7 integrity', '-', 'refs to missing auth users / missing teams-events-children', (
      (select count(*) from public.team_members x where not exists (select 1 from auth.users u where u.id = x.user_id))
    + (select count(*) from public.player_guardians x where not exists (select 1 from auth.users u where u.id = x.user_id))
    + (select count(*) from public.attendance x where x.updated_by is not null and not exists (select 1 from auth.users u where u.id = x.updated_by))
    + (select count(*) from public.events x where x.created_by is not null and not exists (select 1 from auth.users u where u.id = x.created_by))
    + (select count(*) from public.players x where x.created_by is not null and not exists (select 1 from auth.users u where u.id = x.created_by))
    + (select count(*) from public.teams x where x.created_by is not null and not exists (select 1 from auth.users u where u.id = x.created_by))
    + (select count(*) from public.guardian_invitations x where not exists (select 1 from auth.users u where u.id = x.created_by)))::text || ' / ' || (
      (select count(*) from public.team_members x where not exists (select 1 from public.teams tt where tt.id = x.team_id))
    + (select count(*) from public.players x where not exists (select 1 from public.teams tt where tt.id = x.team_id))
    + (select count(*) from public.events x where not exists (select 1 from public.teams tt where tt.id = x.team_id))
    + (select count(*) from public.attendance x where not exists (select 1 from public.events e where e.id = x.event_id) or not exists (select 1 from public.players p where p.id = x.player_id))
    + (select count(*) from public.player_guardians x where not exists (select 1 from public.players p where p.id = x.player_id))
    + (select count(*) from public.guardian_invitations x where not exists (select 1 from public.players p where p.id = x.player_id))
    + (select count(*) from public.team_owner_transfers x where not exists (select 1 from public.teams tt where tt.id = x.team_id)))::text
  union all select 72, '7 integrity', '-', 'auth users / sessions', (select count(*) from auth.users) || ' / ' || (select count(*) from auth.sessions)
) x order by o, team, item;
