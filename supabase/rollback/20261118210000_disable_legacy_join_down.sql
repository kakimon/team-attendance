-- =============================================================
-- Rollback of D5 (20261118210000_disable_legacy_join.sql)  *** RE-OPENS THE OLD JOIN PATH ***
--
-- DANGER: after this, anyone who knows an old share token (old LINE posts, screenshots, bookmarks of
-- people who left or were removed) can again (1) read the team's name and (2) JOIN the team without the
-- current join link. Re-issuing or stopping the join link does NOT close this path.
--   -> Not a normal recovery step. Prefer fixing forward: keep D5, and use the join link
--      (re-issue / reopen in 管理, or rotate_join_token / set_join_open) or apply a corrected migration.
--
-- Guard: refused unless the person running it confirms in the SAME transaction / session:
--   set app.allow_legacy_join_reenable = 'yes-reopen-old-join-path';
-- It restores join_team and get_team_by_share_token exactly as 20261118100000_member_suspension.sql
-- defined them, with EXECUTE for authenticated only (as before D5). Data is not touched.
-- =============================================================
begin;
do $$
begin
  if coalesce(current_setting('app.allow_legacy_join_reenable', true), '') <> 'yes-reopen-old-join-path' then
    raise exception 'legacy_join_rollback_refused'
      using hint = 'Re-opens the old share-token join path. Read the header of this file first.';
  end if;
end $$;

create or replace function public.join_team(p_share_token text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  perform private.check_join_attempts(v_uid);
  select id into v_team_id from public.teams where share_token = p_share_token;
  if v_team_id is null then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
  perform private.xlock('membership:' || v_uid::text);
  perform private.xlock('team-members:' || v_team_id::text);
  perform private.assert_not_suspended(v_team_id, v_uid);
  if exists (select 1 from public.team_members where team_id = v_team_id and user_id = v_uid) then
    return v_team_id;                                                   -- already a member: unchanged
  end if;
  perform private.check_new_membership(v_uid, v_team_id);
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;  -- never changes an existing role
  perform private.record_join_attempt(v_uid);
  return v_team_id;
end;
$$;

create or replace function public.get_team_by_share_token(p_share_token text)
returns table (id uuid, name text, is_member boolean, role text)
language plpgsql volatile security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  perform private.assert_not_suspended((select t.id from public.teams t where t.share_token=p_share_token), v_uid);
  if not exists (select 1 from public.teams t join public.team_members m on m.team_id = t.id and m.user_id = v_uid
                  where t.share_token = p_share_token) then
    perform private.check_join_attempts(v_uid);
    perform private.record_join_attempt(v_uid);
  end if;
  return query
    select t.id, t.name, (m.user_id is not null), m.role
    from public.teams t
    left join public.team_members m on m.team_id = t.id and m.user_id = v_uid
    where t.share_token = p_share_token;
end;
$$;

revoke all on function public.join_team(text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_team_by_share_token(text) from public, anon, authenticated, service_role;
grant execute on function public.join_team(text, text) to authenticated;
grant execute on function public.get_team_by_share_token(text) to authenticated;

commit;
