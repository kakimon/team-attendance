-- ROLLBACK for supabase/migrations/20261113100000_session_bound_reads.sql (run BEFORE the
-- 20261113000000 rollback). Restores the previous SELECT policies; reads then work again for
-- logged-out tokens until they expire. Tested in tests/db/migrationAudit.test.ts.
set lock_timeout = '5s';
begin;
alter policy teams_select on public.teams using (private.is_team_member(id));
alter policy team_members_select on public.team_members using (private.is_team_member(team_id));
alter policy players_select on public.players using (private.is_team_member(team_id) and archived_at is null);
alter policy player_guardians_select on public.player_guardians using (user_id = auth.uid() or private.is_team_admin(team_id));
alter policy events_select on public.events using (private.is_team_member(team_id) and deleted_at is null);
alter policy attendance_select on public.attendance using (private.is_team_member(team_id)
  and exists (select 1 from public.events e where e.id = attendance.event_id and e.deleted_at is null)
  and exists (select 1 from public.players p where p.id = attendance.player_id and p.archived_at is null));
alter policy guardian_invitations_select on public.guardian_invitations using (private.is_guardian(player_id));
alter policy team_owner_transfers_select on public.team_owner_transfers using (from_user = auth.uid() or to_user = auth.uid());
drop function if exists private.session_ok();
commit;
reset lock_timeout;
