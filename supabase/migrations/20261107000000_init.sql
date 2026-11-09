-- =============================================================
-- Team Attendance: Phase 0 initial schema
--
-- Policy:
--   * Every table has RLS enabled.
--   * Browser roles (anon / authenticated) get SELECT only, filtered by RLS.
--   * All writes go through SECURITY DEFINER functions (RPC) that check
--     permissions explicitly. No INSERT/UPDATE/DELETE grants on tables.
--   * "Unanswered" = no attendance row. It is never stored as "absent".
-- =============================================================

-- -------------------------------------------------------------
-- Private schema for helper functions (not exposed via PostgREST)
-- -------------------------------------------------------------
create schema if not exists private;
grant usage on schema private to authenticated;

-- Name normalization for similar-name warnings:
-- NFKC (full/half width), lower case, drop all whitespace, katakana -> hiragana.
create or replace function private.normalize_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(
    regexp_replace(lower(normalize(coalesce(p, ''), NFKC)), '[[:space:]　]+', '', 'g'),
    'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴ',
    'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔ'
  );
$$;

-- -------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------
create table public.teams (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 60),
  -- Unguessable token used in the one shared team URL (/t/<share_token>)
  share_token  text not null unique
                 default replace(gen_random_uuid()::text, '-', ''),
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now()
);

create table public.team_members (
  team_id      uuid not null references public.teams(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member'
                 check (role in ('owner', 'admin', 'member')),
  display_name text not null check (char_length(display_name) between 1 and 40),
  joined_at    timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.players (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 40),
  normalized_name text not null,
  note            text check (char_length(note) <= 40),  -- e.g. grade, "4年"
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  unique (id, team_id)
);
create index players_team_idx on public.players (team_id);
create index players_team_norm_idx on public.players (team_id, normalized_name);

create table public.player_guardians (
  player_id   uuid not null,
  team_id     uuid not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  added_via   text not null check (added_via in ('registrant', 'invitation')),
  created_at  timestamptz not null default now(),
  primary key (player_id, user_id),
  foreign key (player_id, team_id) references public.players(id, team_id) on delete cascade
);
create index player_guardians_user_idx on public.player_guardians (user_id);

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 60),
  starts_at   timestamptz not null,
  location    text check (char_length(location) <= 80),
  note        text check (char_length(note) <= 500),
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (id, team_id)
);
create index events_team_starts_idx on public.events (team_id, starts_at);

create table public.attendance (
  event_id    uuid not null,
  player_id   uuid not null,
  team_id     uuid not null,
  -- 'unanswered' is represented by the absence of a row.
  status      text not null check (status in ('attend', 'absent', 'undecided')),
  comment     text check (char_length(comment) <= 100),
  updated_by  uuid not null references auth.users(id),
  updated_at  timestamptz not null default now(),
  primary key (event_id, player_id),
  -- Event and player must belong to the same team as the row.
  foreign key (event_id, team_id) references public.events(id, team_id) on delete cascade,
  foreign key (player_id, team_id) references public.players(id, team_id) on delete cascade
);

create table public.guardian_invitations (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null,
  player_id   uuid not null,
  -- Only the SHA-256 hash is stored; the raw token is shown once to the inviter.
  token_hash  text not null unique,
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references auth.users(id),
  revoked_at  timestamptz,
  foreign key (player_id, team_id) references public.players(id, team_id) on delete cascade,
  check (expires_at > created_at)
);
create index guardian_invitations_player_idx on public.guardian_invitations (player_id);

-- -------------------------------------------------------------
-- Permission helpers (SECURITY DEFINER so RLS policies don't recurse)
-- -------------------------------------------------------------
create or replace function private.is_team_member(p_team_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid()
  );
$$;

create or replace function private.is_team_admin(p_team_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

create or replace function private.is_guardian(p_player_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.player_guardians g
    join public.team_members m on m.team_id = g.team_id and m.user_id = g.user_id
    where g.player_id = p_player_id and g.user_id = auth.uid()
  );
$$;

create or replace function private.require_auth()
returns uuid language plpgsql stable set search_path = ''
as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return v;
end;
$$;

create or replace function private.random_token()
returns text language sql volatile set search_path = ''
as $$
  -- two v4 UUIDs = 244 random bits, hex
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

create or replace function private.hash_token(p text)
returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex');
$$;

-- -------------------------------------------------------------
-- RLS: enable on every table, SELECT policies only
-- -------------------------------------------------------------
alter table public.teams                enable row level security;
alter table public.team_members         enable row level security;
alter table public.players              enable row level security;
alter table public.player_guardians     enable row level security;
alter table public.events               enable row level security;
alter table public.attendance           enable row level security;
alter table public.guardian_invitations enable row level security;

create policy teams_select on public.teams
  for select to authenticated using (private.is_team_member(id));

create policy team_members_select on public.team_members
  for select to authenticated using (private.is_team_member(team_id));

create policy players_select on public.players
  for select to authenticated using (private.is_team_member(team_id));

-- Guardians: you see your own links; admins see all links in their team.
create policy player_guardians_select on public.player_guardians
  for select to authenticated
  using (user_id = auth.uid() or private.is_team_admin(team_id));

create policy events_select on public.events
  for select to authenticated using (private.is_team_member(team_id));

-- Attendance list is shared inside the team (Chouseisan style).
create policy attendance_select on public.attendance
  for select to authenticated using (private.is_team_member(team_id));

create policy guardian_invitations_select on public.guardian_invitations
  for select to authenticated using (private.is_guardian(player_id));

-- Table privileges: SELECT only for authenticated, nothing for anon.
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
-- token_hash is never needed by the browser.
revoke select on public.guardian_invitations from authenticated;
grant select (id, team_id, player_id, created_by, created_at, expires_at, used_at, used_by, revoked_at)
  on public.guardian_invitations to authenticated;

-- -------------------------------------------------------------
-- RPC: teams & membership
-- -------------------------------------------------------------

-- Creating a new team makes the caller its owner. This is the only way to
-- become owner; admin of an existing team requires an owner/admin to grant it.
create or replace function public.create_team(p_name text, p_display_name text)
returns public.teams
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team public.teams;
begin
  insert into public.teams (name, created_by) values (trim(p_name), v_uid)
  returning * into v_team;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team.id, v_uid, 'owner', trim(p_display_name));
  return v_team;
end;
$$;

-- Joining via the shared team URL always gives role 'member'.
create or replace function public.join_team(p_share_token text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  select id into v_team_id from public.teams where share_token = p_share_token;
  if v_team_id is null then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;  -- never changes an existing role
  return v_team_id;
end;
$$;

-- Owner can make someone admin/member. Owner role itself can't be granted here.
create or replace function public.set_member_role(p_team_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
begin
  if p_role not in ('admin', 'member') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if not exists (select 1 from public.team_members
                 where team_id = p_team_id and user_id = v_uid and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.team_members set role = p_role
  where team_id = p_team_id and user_id = p_user_id and role <> 'owner';
  if not found then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- -------------------------------------------------------------
-- RPC: players
-- -------------------------------------------------------------

-- Returns same/similar names in the team. Read-only; never grants anything.
create or replace function public.find_similar_players(p_team_id uuid, p_name text)
returns table (id uuid, name text, note text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_norm text := private.normalize_name(p_name);
begin
  perform private.require_auth();
  if not private.is_team_member(p_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select p.id, p.name, p.note from public.players p
    where p.team_id = p_team_id and p.archived_at is null
      and char_length(v_norm) > 0
      and (p.normalized_name = v_norm
           or (char_length(v_norm) >= 2 and p.normalized_name like '%' || v_norm || '%')
           or (char_length(p.normalized_name) >= 2 and v_norm like '%' || p.normalized_name || '%'))
    order by p.name;
end;
$$;

-- Registers a NEW child. The caller becomes its first guardian.
-- If similar names exist and p_confirm_similar is false, nothing is created and
-- the candidates are returned as a warning. Even when confirmed, a separate new
-- player is created: existing players are never linked to the caller.
create or replace function public.register_player(
  p_team_id uuid, p_name text, p_note text default null, p_confirm_similar boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_similar jsonb;
  v_player_id uuid;
begin
  if not private.is_team_member(p_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'note', s.note)), '[]'::jsonb)
    into v_similar
    from public.find_similar_players(p_team_id, p_name) s;

  if jsonb_array_length(v_similar) > 0 and not p_confirm_similar then
    return jsonb_build_object('status', 'similar_found', 'similar', v_similar);
  end if;

  insert into public.players (team_id, name, normalized_name, note, created_by)
  values (p_team_id, trim(p_name), private.normalize_name(p_name), nullif(trim(p_note), ''), v_uid)
  returning id into v_player_id;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_player_id, p_team_id, v_uid, 'registrant');

  return jsonb_build_object('status', 'created', 'player_id', v_player_id, 'similar', v_similar);
end;
$$;

-- -------------------------------------------------------------
-- RPC: events (admin only)
-- -------------------------------------------------------------
create or replace function public.create_event(
  p_team_id uuid, p_title text, p_starts_at timestamptz,
  p_location text default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_id uuid;
begin
  if not private.is_team_admin(p_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.events (team_id, title, starts_at, location, note, created_by)
  values (p_team_id, trim(p_title), p_starts_at, nullif(trim(p_location), ''), nullif(trim(p_note), ''), v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

-- -------------------------------------------------------------
-- RPC: attendance (guardian only)
-- -------------------------------------------------------------
-- p_status: 'attend' | 'absent' | 'undecided' | 'unanswered'
-- 'unanswered' deletes the row (back to "not answered yet").
create or replace function public.set_attendance(
  p_event_id uuid, p_player_id uuid, p_status text, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
begin
  if p_status not in ('attend', 'absent', 'undecided', 'unanswered') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select e.team_id into v_team_id
  from public.events e
  join public.players p on p.team_id = e.team_id
  where e.id = p_event_id and p.id = p_player_id and p.archived_at is null;
  if v_team_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- The core rule: only this child's guardians can write.
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_status = 'unanswered' then
    delete from public.attendance where event_id = p_event_id and player_id = p_player_id;
  else
    insert into public.attendance (event_id, player_id, team_id, status, comment, updated_by, updated_at)
    values (p_event_id, p_player_id, v_team_id, p_status, nullif(trim(p_comment), ''), v_uid, now())
    on conflict (event_id, player_id) do update
      set status = excluded.status, comment = excluded.comment,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
end;
$$;

-- Totals per event. 'unanswered' = active players without a row.
create or replace function public.event_attendance_summary(p_event_id uuid)
returns table (attend int, absent int, undecided int, unanswered int, total int)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_team_id uuid;
begin
  perform private.require_auth();
  select team_id into v_team_id from public.events where id = p_event_id;
  if v_team_id is null or not private.is_team_member(v_team_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select
      count(*) filter (where a.status = 'attend')::int,
      count(*) filter (where a.status = 'absent')::int,
      count(*) filter (where a.status = 'undecided')::int,
      count(*) filter (where a.status is null)::int,
      count(*)::int
    from public.players p
    left join public.attendance a on a.player_id = p.id and a.event_id = p_event_id
    where p.team_id = v_team_id and p.archived_at is null;
end;
$$;

-- -------------------------------------------------------------
-- RPC: family invitations
-- -------------------------------------------------------------
-- Valid for 24 hours, single use. Returns the raw token once.
create or replace function public.create_guardian_invitation(p_player_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_team_id uuid;
  v_token text := private.random_token();
  v_expires timestamptz := now() + interval '24 hours';
  v_id uuid;
begin
  if not private.is_guardian(p_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select team_id into v_team_id from public.players where id = p_player_id;

  if (select count(*) from public.guardian_invitations
      where player_id = p_player_id and used_at is null and revoked_at is null
        and expires_at > now()) >= 5 then
    raise exception 'too_many_active_invitations' using errcode = '54000';
  end if;

  insert into public.guardian_invitations (team_id, player_id, token_hash, created_by, expires_at)
  values (v_team_id, p_player_id, private.hash_token(v_token), v_uid, v_expires)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

create or replace function public.revoke_guardian_invitation(p_invitation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_player_id uuid;
begin
  perform private.require_auth();
  select player_id into v_player_id from public.guardian_invitations where id = p_invitation_id;
  if v_player_id is null or not private.is_guardian(v_player_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.guardian_invitations set revoked_at = now()
  where id = p_invitation_id and used_at is null and revoked_at is null;
end;
$$;

-- Consumes the invitation atomically (one UPDATE with all conditions), so two
-- people racing on the same link can't both succeed. Also joins the team.
create or replace function public.accept_guardian_invitation(p_token text, p_display_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_inv public.guardian_invitations;
begin
  select * into v_inv from public.guardian_invitations
  where token_hash = private.hash_token(p_token);
  if v_inv.id is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.player_guardians
             where player_id = v_inv.player_id and user_id = v_uid) then
    raise exception 'already_guardian' using errcode = '23505';
  end if;

  update public.guardian_invitations
     set used_at = now(), used_by = v_uid
   where id = v_inv.id and used_at is null and revoked_at is null and expires_at > now()
  returning * into v_inv;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_inv.team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_inv.player_id, v_inv.team_id, v_uid, 'invitation');

  return jsonb_build_object('player_id', v_inv.player_id, 'team_id', v_inv.team_id);
end;
$$;

-- -------------------------------------------------------------
-- Function privileges
-- -------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema private to authenticated;
