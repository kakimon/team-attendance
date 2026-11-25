-- =============================================================
-- Rollback of 20261124000000_family_invite_accept.sql
-- Restores accept_guardian_invitation exactly as 20261118100000_member_suspension.sql defined it
-- (existing members are inserted again with ON CONFLICT DO NOTHING; an empty name then fails on the
-- display-name constraint) and drops preview_guardian_invitation. Data is not touched.
-- The app falls back to the old invitation form when preview_guardian_invitation does not exist.
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

  if not exists (select 1 from public.team_members where team_id = v_inv.team_id and user_id = v_uid) then
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

  insert into public.team_members (team_id, user_id, role, display_name)
  values (v_inv.team_id, v_uid, 'member', trim(p_display_name))
  on conflict (team_id, user_id) do nothing;

  insert into public.player_guardians (player_id, team_id, user_id, added_via)
  values (v_inv.player_id, v_inv.team_id, v_uid, 'invitation');

  return jsonb_build_object('status', 'accepted', 'player_id', v_player.id,
    'player_name', v_player.name, 'team_id', v_inv.team_id, 'share_token', v_share);
end;
$$;

drop function if exists public.preview_guardian_invitation(text);

commit;
