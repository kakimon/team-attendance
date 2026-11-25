-- =============================================================
-- Phase 6 family invitations (docs/internal/PHASE6_FAMILY_INVITE_IMPROVEMENTS.md)
--
-- 1. accept_guardian_invitation(token, display_name)
--    - An EXISTING member of the team is not inserted into team_members again: their display name,
--      role, joined_at, suspension and access_revision never change, and display_name is ignored
--      (before: an empty name failed on team_members_display_name_check even for members).
--    - A NEW member's display name is checked here (after trimming spaces / full-width spaces):
--      empty -> 'name_required', more than 40 characters -> 'display_name_too_long' (22023).
--      An invitation that is already used / revoked / expired answers 'invitation_invalid' first.
--    - Unchanged: signature and result, lock order (account -> team members -> team row),
--      assert_not_suspended, check_new_membership (blocks, limits), check_guardian_children,
--      the guarded UPDATE that consumes the invitation exactly once.
-- 2. preview_guardian_invitation(token) (new, read only, authenticated only)
--    - Never consumes / locks / writes anything and never returns the token.
--    - {status: 'invalid'} for every unusable link (unknown, used, revoked, expired, cancelled child):
--      the reason is not revealed. Otherwise the team and registration names, whether the caller is
--      already a member, whether a display name is needed, and when the link expires.
--    - 'already_guardian' and 'suspended' mirror what accept_guardian_invitation would answer.
-- No table, column, RLS or data change. EXECUTE: authenticated only, granted explicitly (see the end).
-- Rollback: supabase/rollback/20261124000000_family_invite_accept_down.sql
-- =============================================================
begin;

create or replace function public.accept_guardian_invitation(p_token text, p_display_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_inv public.guardian_invitations;
  v_player public.players;
  v_share text;
  v_team uuid;
  v_name text;
begin
  -- U4-Fix: locks first (account -> team members -> team row), then every check reads the
  -- state after any removal / leave that was running has committed.
  perform private.xlock('membership:' || v_uid::text);
  select team_id into v_team from public.guardian_invitations
  where token_hash = private.hash_token(p_token);
  if v_team is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;
  perform private.xlock('team-members:' || v_team::text);
  perform 1 from public.teams where id = v_team for key share;

  perform private.assert_not_suspended(v_team, v_uid);
  select * into v_inv from public.guardian_invitations
  where token_hash = private.hash_token(p_token);
  if v_inv.id is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  select * into v_player from public.players where id = v_inv.player_id and archived_at is null;
  if v_player.id is null then
    raise exception 'invitation_invalid' using errcode = 'P0002';  -- child was cancelled
  end if;
  select share_token into v_share from public.teams where id = v_inv.team_id;

  if exists (select 1 from public.player_guardians
             where player_id = v_inv.player_id and user_id = v_uid) then
    return jsonb_build_object('status', 'already_guardian', 'player_id', v_player.id,
      'player_name', v_player.name, 'team_id', v_inv.team_id, 'share_token', v_share);
  end if;

  -- An unusable link is reported as such before any question about the name.
  if v_inv.used_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.team_members where team_id = v_inv.team_id and user_id = v_uid) then
    -- Only a NEW member needs a name; it is checked before anything is written.
    -- The characters removed from both ends: space, tab, CR, LF and U+3000 (IDEOGRAPHIC SPACE, the full-width
    -- space; it is the last character inside the quotes below, written as the character itself).
    v_name := btrim(coalesce(p_display_name, ''), E' \t\r\n　');
    if v_name = '' then
      raise exception 'name_required' using errcode = '22023';
    end if;
    if char_length(v_name) > 40 then
      raise exception 'display_name_too_long' using errcode = '22023';
    end if;
    perform private.check_new_membership(v_uid, v_inv.team_id);
  end if;
  perform private.check_guardian_children(v_uid, v_inv.team_id);

  update public.guardian_invitations
     set used_at = now(), used_by = v_uid
   where id = v_inv.id and used_at is null and revoked_at is null and expires_at > now()
  returning * into v_inv;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  -- Existing members are left exactly as they are (no insert, no name change).
  if v_name is not null then
    insert into public.team_members (team_id, user_id, role, display_name)
    values (v_inv.team_id, v_uid, 'member', v_name)
    on conflict (team_id, user_id) do nothing;
  end if;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_inv.player_id, v_inv.team_id, v_uid, 'invitation');

  return jsonb_build_object('status', 'accepted', 'player_id', v_player.id,
    'player_name', v_player.name, 'team_id', v_inv.team_id, 'share_token', v_share);
end;
$$;

create function public.preview_guardian_invitation(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  v_inv public.guardian_invitations;
  v_player public.players;
  v_team_name text;
  v_member public.team_members;
begin
  if p_token is null or char_length(p_token) < 32 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_inv from public.guardian_invitations where token_hash = private.hash_token(p_token);
  if v_inv.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_player from public.players where id = v_inv.player_id and archived_at is null;
  if v_player.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_member from public.team_members where team_id = v_inv.team_id and user_id = v_uid;
  if v_member.suspended_at is not null then
    return jsonb_build_object('status', 'suspended');                -- accept: team_access_suspended
  end if;
  select name into v_team_name from public.teams where id = v_inv.team_id;
  if exists (select 1 from public.player_guardians where player_id = v_player.id and user_id = v_uid) then
    return jsonb_build_object('status', 'already_guardian', 'player_name', v_player.name,
      'team_name', v_team_name, 'team_id', v_inv.team_id);
  end if;
  if v_inv.used_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'valid', 'player_name', v_player.name, 'team_name', v_team_name,
    'is_member', v_member.user_id is not null, 'needs_display_name', v_member.user_id is null,
    'expires_at', v_inv.expires_at);
end;
$$;

-- Explicit, not left to default privileges: authenticated only (no PUBLIC, anon or service_role), like the
-- production ACL of the other app RPCs ({postgres=X, authenticated=X}).
revoke all on function public.preview_guardian_invitation(text) from public, anon, service_role;
grant execute on function public.preview_guardian_invitation(text) to authenticated;
-- accept_guardian_invitation keeps its ACL (CREATE OR REPLACE does not change it); stated again so a database
-- whose grant was lost gets it back. Nothing is revoked from service_role here: its existing ACL is not touched.
revoke all on function public.accept_guardian_invitation(text, text) from public, anon;
grant execute on function public.accept_guardian_invitation(text, text) to authenticated;

commit;
