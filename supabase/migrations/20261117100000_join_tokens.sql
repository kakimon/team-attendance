-- =============================================================
-- Phase 5-B U2 (D2): join tokens, separate from the team's page address
--
--   * The team page keeps its address; joining will use a separate secret token that
--     owners / admins can see, rotate, stop and reopen.
--   * Tokens live in a private table: browsers can only reach them through the RPCs below,
--     which check the caller's role. public.teams and its grants are NOT changed, so the
--     currently published app keeps working.
--   * Every existing team gets a NEW random token (the old share_token value is not reused).
--
-- Additive only (stage 1). NOT done here (stage 2, D5, after the new app is live):
--   the old path join_team(share_token) keeps working, and share_token stays readable by
--   members. Until D5, rotating / stopping the new token does not stop joining through an
--   old shared link.
--
-- Concurrency: rotate / stop / reopen lock the team row FOR UPDATE; join_by_token looks the
-- token up again after taking the same row lock (FOR SHARE), so a join cannot succeed with
-- a token that a concurrent rotation has already replaced.
--
-- Rollback: supabase/rollback/20261117100000_join_tokens_down.sql
-- =============================================================

-- -------------------------------------------------------------
-- 1. Tokens (one row per team; token null = joining stopped)
-- -------------------------------------------------------------
create table if not exists private.team_join_tokens (
  team_id    uuid primary key references public.teams(id) on delete cascade,
  token      text unique,
  updated_at timestamptz not null default now(),
  check (token is null or char_length(token) >= 32)
);
alter table private.team_join_tokens enable row level security;
revoke all on private.team_join_tokens from public, anon, authenticated;

-- New random token for every existing team (never the share_token value).
insert into private.team_join_tokens (team_id, token)
select t.id, private.random_token() from public.teams t
on conflict (team_id) do nothing;

-- New teams get a token automatically (create_team itself is not changed).
create or replace function private.add_join_token()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.team_join_tokens (team_id, token) values (new.id, private.random_token())
  on conflict (team_id) do nothing;
  return new;
end;
$$;
drop trigger if exists teams_add_join_token on public.teams;
create trigger teams_add_join_token after insert on public.teams
  for each row execute function private.add_join_token();

-- Owner or admin of the team (the caller must already be authenticated).
create or replace function private.can_manage_join(p_team_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.team_members
                  where team_id = p_team_id and user_id = p_user and role in ('owner', 'admin'));
$$;

-- -------------------------------------------------------------
-- 2. Owners / admins: read, rotate, stop, reopen
--    Result: { open: boolean, token: text | null }. Errors: forbidden.
-- -------------------------------------------------------------
create or replace function public.get_join_link(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_token text;
begin
  if not private.can_manage_join(p_team_id, v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select token into v_token from private.team_join_tokens where team_id = p_team_id;
  return jsonb_build_object('open', v_token is not null, 'token', v_token);
end;
$$;

create or replace function public.rotate_join_token(p_team_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_token text := private.random_token();
begin
  perform 1 from public.teams where id = p_team_id for update;      -- lock first, then check the role
  if not private.can_manage_join(p_team_id, v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into private.team_join_tokens (team_id, token, updated_at) values (p_team_id, v_token, now())
  on conflict (team_id) do update set token = excluded.token, updated_at = excluded.updated_at;
  return jsonb_build_object('open', true, 'token', v_token);
end;
$$;

-- p_open = false: stop (token removed). p_open = true: reopen with a NEW token if stopped;
-- if already open, the current token is kept.
create or replace function public.set_join_open(p_team_id uuid, p_open boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_token text;
begin
  perform 1 from public.teams where id = p_team_id for update;      -- lock first, then check the role
  if not private.can_manage_join(p_team_id, v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select token into v_token from private.team_join_tokens where team_id = p_team_id;
  if not coalesce(p_open, false) then
    v_token := null;
  elsif v_token is null then
    v_token := private.random_token();
  end if;
  insert into private.team_join_tokens (team_id, token, updated_at) values (p_team_id, v_token, now())
  on conflict (team_id) do update set token = excluded.token, updated_at = excluded.updated_at;
  return jsonb_build_object('open', v_token is not null, 'token', v_token);
end;
$$;

-- -------------------------------------------------------------
-- 3. Joining with the new token
-- -------------------------------------------------------------
-- Before joining: the team name and whether the caller is already a member.
-- Nothing is returned for an unknown, replaced or stopped token.
create or replace function public.preview_join(p_token text)
returns table (team_id uuid, name text, is_member boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  if p_token is null or char_length(p_token) < 32 then return; end if;
  return query
    select t.id, t.name, exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = v_uid)
      from private.team_join_tokens j join public.teams t on t.id = j.team_id
     where j.token = p_token;
end;
$$;

-- Joins as a member (an existing membership and its role are never changed).
-- Errors: join_link_invalid (unknown, replaced or stopped token).
create or replace function public.join_by_token(p_token text, p_display_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth(); v_team uuid;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'join_link_invalid' using errcode = 'P0002';
  end if;
  select team_id into v_team from private.team_join_tokens where token = p_token;
  if v_team is null then
    raise exception 'join_link_invalid' using errcode = 'P0002';
  end if;
  perform 1 from public.teams where id = v_team for share;            -- waits for a concurrent rotation
  if not exists (select 1 from private.team_join_tokens where team_id = v_team and token = p_token) then
    raise exception 'join_link_invalid' using errcode = 'P0002';      -- replaced or stopped meanwhile
  end if;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;
  return v_team;
end;
$$;

-- For members only: the team behind an old page address (/t/<share_token>), so old bookmarks
-- can move to the new address. Returns nothing to non-members (never a way to join).
create or replace function public.resolve_legacy_team(p_share_token text)
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := private.require_auth();
begin
  return (select t.id from public.teams t
           join public.team_members m on m.team_id = t.id and m.user_id = v_uid
          where t.share_token = p_share_token);
end;
$$;

-- -------------------------------------------------------------
-- 4. Privileges (Supabase grants EXECUTE to anon by default: revoke explicitly)
-- -------------------------------------------------------------
revoke execute on function private.add_join_token() from public, anon, authenticated;
revoke execute on function private.can_manage_join(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.get_join_link(uuid) from public, anon;
revoke execute on function public.rotate_join_token(uuid) from public, anon;
revoke execute on function public.set_join_open(uuid, boolean) from public, anon;
revoke execute on function public.preview_join(text) from public, anon;
revoke execute on function public.join_by_token(text, text) from public, anon;
revoke execute on function public.resolve_legacy_team(text) from public, anon;
grant execute on function public.get_join_link(uuid) to authenticated;
grant execute on function public.rotate_join_token(uuid) to authenticated;
grant execute on function public.set_join_open(uuid, boolean) to authenticated;
grant execute on function public.preview_join(text) to authenticated;
grant execute on function public.join_by_token(text, text) to authenticated;
grant execute on function public.resolve_legacy_team(text) to authenticated;
