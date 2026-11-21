-- =============================================================
-- Read-only pre-deletion check for ONE test account (cloud).
--   supabase db query --linked -f scripts/deletion-target-check.sql
-- Edit the two constants below (display name + a team the account belongs to).
-- Team / display names below are FICTIONAL samples (the published copy never carries real names). Before running
-- against a real project, replace them with the real values recorded in the internal runbook (docs/internal/ops/).
-- Output: labels and counts only. No e-mail, user id, session id or token is printed;
-- teams other than the protected team are named, the protected team's items are only counted.
-- Always ends with RAISE (nothing can persist; the preview runs as the account in-transaction).
-- =============================================================
do $$
declare
  c_label constant text := 'test-account';        -- display name of the account to be deleted
  c_team  constant text := 'テストチーム';     -- a team it belongs to (identifies the account)
  c_keep  constant text := 'サンプルFC';         -- team that must not be affected at all
  uid uuid; sid uuid; n int; v jsonb; e jsonb; k text; out text := '';
  keep_fp text; keep_counts text;
begin
  select m.user_id into uid from public.team_members m join public.teams t on t.id = m.team_id
   where t.name = c_team and m.display_name = c_label;
  select count(*) into n from public.team_members m join public.teams t on t.id = m.team_id
   where t.name = c_team and m.display_name = c_label;
  if n <> 1 then raise exception 'CHECK_STOP: % accounts named % in % (need exactly 1)', n, c_label, c_team; end if;

  -- 1. footprint
  out := out || E'\n[target ' || c_label || ']';
  out := out || E'\n  memberships: ' || coalesce((select string_agg(t.name || '=' || m.role, ', ' order by t.name)
    from public.team_members m join public.teams t on t.id = m.team_id where m.user_id = uid), 'none');
  out := out || E'\n  guardian of: ' || coalesce((select string_agg(p.name || '(' || t.name || ', guardians '
      || (select count(*) from public.player_guardians x where x.player_id = p.id) || ')', ', ' order by t.name, p.name)
    from public.player_guardians g join public.players p on p.id = g.player_id join public.teams t on t.id = p.team_id
    where g.user_id = uid), 'none');
  select (select count(*) from public.team_members m join public.teams t on t.id = m.team_id where t.name = c_keep and m.user_id = uid)
       + (select count(*) from public.player_guardians g join public.teams t on t.id = g.team_id where t.name = c_keep and g.user_id = uid)
       + (select count(*) from public.attendance a join public.teams t on t.id = a.team_id where t.name = c_keep and a.updated_by = uid)
       + (select count(*) from public.events x join public.teams t on t.id = x.team_id where t.name = c_keep and uid in (x.created_by, x.updated_by, x.deleted_by))
       + (select count(*) from public.players p join public.teams t on t.id = p.team_id where t.name = c_keep and uid in (p.created_by, p.updated_by, p.archived_by))
       + (select count(*) from public.guardian_invitations i join public.teams t on t.id = i.team_id where t.name = c_keep and uid in (i.created_by, i.used_by))
       + (select count(*) from public.teams t where t.name = c_keep and t.created_by = uid)
    into n;
  out := out || E'\n  rows inside ' || c_keep || ' referencing it (must be 0): ' || n;
  out := out || E'\n  live sessions: ' || (select count(*) from auth.sessions where user_id = uid)
    || ', pending deletion: ' || (select count(*) from private.account_deletions where user_id = uid);

  -- 2. server preview, as the account (needs a live session)
  select id into sid from auth.sessions where user_id = uid order by created_at desc limit 1;
  if sid is null then
    out := out || E'\n[preview] skipped: no live session (log in once with the account)';
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', uid::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'session_id', sid)::text, true);
    v := public.account_deletion_preview();
    perform set_config('role', 'postgres', true);
    out := out || E'\n[preview]';
    foreach k in array array['teams_to_hand_over', 'teams_to_close', 'teams_to_leave', 'children_to_delete', 'children_kept_by_family'] loop
      out := out || E'\n  ' || k || ': ';
      for e in select * from jsonb_array_elements(v -> k) loop
        if (e ->> 'team_name') = c_keep then out := out || '[' || c_keep || ' item] ';
        else out := out || coalesce(e ->> 'name' || ' ', '') || '(' || (e ->> 'team_name')
               || coalesce(', answers ' || (e ->> 'answers'), '') || ') ';
        end if;
      end loop;
    end loop;
  end if;

  -- 3. other users: what changes for them if the target leaves
  out := out || E'\n[other accounts] auth users other than the target: ' || (select count(*) from auth.users where id <> uid)
    || ' (none is deleted). Shared children where they stay as guardians: '
    || (select count(*) from public.player_guardians g where g.user_id = uid
          and exists (select 1 from public.player_guardians o where o.player_id = g.player_id and o.user_id <> uid));

  -- 4. protected team and integrity
  select concat_ws(' / ', count(distinct t.id), (select count(*) from public.team_members m join public.teams x on x.id = m.team_id where x.name = c_keep),
           (select count(*) from public.players p join public.teams x on x.id = p.team_id where x.name = c_keep),
           (select count(*) from public.attendance a join public.teams x on x.id = a.team_id where x.name = c_keep))
    into keep_counts from public.teams t where t.name = c_keep;
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.teams x where x.name = c_keep),
    (select string_agg(to_jsonb(m)::text, ',' order by m.team_id, m.user_id) from public.team_members m join public.teams t on t.id = m.team_id where t.name = c_keep),
    (select string_agg(to_jsonb(p)::text, ',' order by p.id) from public.players p join public.teams t on t.id = p.team_id where t.name = c_keep),
    (select string_agg(to_jsonb(a)::text, ',' order by a.event_id, a.player_id) from public.attendance a join public.teams t on t.id = a.team_id where t.name = c_keep)))
    into keep_fp;
  out := out || E'\n[' || c_keep || '] teams/members/children/answers: ' || keep_counts || ', fingerprint: ' || keep_fp;
  out := out || E'\n[integrity] teams without exactly one owner: '
    || (select count(*) from public.teams t where (select count(*) from public.team_members m where m.team_id = t.id and m.role = 'owner') <> 1)
    || ', children without guardian: ' || (select count(*) from public.players p where not exists (select 1 from public.player_guardians g where g.player_id = p.id))
    || ', open hand-over requests: ' || (select count(*) from public.team_owner_transfers)
    || ', pending deletions: ' || (select count(*) from private.account_deletions);

  raise exception 'CHECK_RESULT%', out;
end $$;
