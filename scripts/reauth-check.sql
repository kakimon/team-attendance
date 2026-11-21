-- =============================================================
-- Read-only: login sessions of the TEST accounts (display names T1 / T2 / T3 in a 【テスト】 team).
--   supabase db query --linked -f scripts/reauth-check.sql
-- Run it before and after the Google re-login. No real session id, token, e-mail or user id is
-- printed: only an 8-character fingerprint of the newest session id (md5), so "before" and
-- "after" can be compared, plus how long ago that session was created.
-- =============================================================
select m.display_name as account,
       count(s.id) as sessions,
       left(md5((array_agg(s.id order by s.created_at desc))[1]::text), 8) as newest_session_fingerprint,
       floor(extract(epoch from now() - max(s.created_at)))::int as newest_session_age_seconds,
       (max(s.created_at) > now() - interval '10 minutes') as newest_within_10_minutes
  from public.team_members m
  join public.teams t on t.id = m.team_id and t.name like '【テスト】%'
  left join auth.sessions s on s.user_id = m.user_id
 where m.display_name in ('T1', 'T2', 'T3')
 group by m.display_name
 order by m.display_name;
