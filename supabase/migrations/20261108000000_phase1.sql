-- =============================================================
-- Phase 1: pre-join team preview for the shared team URL.
-- Knowing the URL reveals only the team name. Joining gives 'member'
-- (read-only for other families). Edit rights come only from
-- registering your own child or a family invitation.
-- =============================================================

create or replace function public.get_team_by_share_token(p_share_token text)
returns table (id uuid, name text, is_member boolean, role text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_auth();
  return query
    select t.id, t.name, (m.user_id is not null), m.role
    from public.teams t
    left join public.team_members m on m.team_id = t.id and m.user_id = auth.uid()
    where t.share_token = p_share_token;
end;
$$;

-- Re-apply function privileges (Supabase grants EXECUTE to anon by default).
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema private to authenticated;
