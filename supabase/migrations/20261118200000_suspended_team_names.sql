-- D6-B3: a member whose access is stopped sees the CURRENT name of those teams (and nothing else),
-- so they can tell several stopped teams apart without asking the operator.
--   * Only rows of the caller (user_id = auth.uid()) that are suspended; nobody else's, never active ones.
--   * Only the name: no schedule, members, comments, notes or join / invitation tokens.
--   * No new column, no history: the name is read from public.teams at call time.
--   * Ordinary SELECT / RLS are unchanged (the stopped member still reads nothing through tables).
-- The return type changes (one more column), so the function is dropped and created again with the
-- same name, argument list and grants.
-- Rollback: supabase/rollback/20261118200000_suspended_team_names_down.sql
begin;
drop function public.my_suspended_memberships();
create function public.my_suspended_memberships()
returns table(team_id uuid, suspended_at timestamptz, team_name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_auth();
begin
  return query
    select m.team_id, m.suspended_at, t.name
      from public.team_members m
      join public.teams t on t.id = m.team_id
     where m.user_id = v_uid and m.suspended_at is not null
     order by m.team_id;
end;
$$;
revoke all on function public.my_suspended_memberships() from public, anon;
grant execute on function public.my_suspended_memberships() to authenticated;
commit;
