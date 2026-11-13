-- =============================================================
-- ROLLBACK for supabase/migrations/20261113000000_account_deletion.sql
-- Not a migration (the CLI never reads this folder). Run by hand only if the
-- migration must be undone:  supabase db query --linked -f <this file>   (after checking the ref)
--
-- * Restores the previous schema exactly (tested in tests/db/migrationAudit.test.ts).
-- * Data: open owner hand-over requests and the "deletion pending" state are dropped.
-- * NOT NULL is restored only where no row has NULL yet. After any account deletion the
--   recorder columns contain NULL (anonymised); they then stay nullable, which the old
--   code handles fine (it only inserts non-null values).
-- * Afterwards also remove the Edge Function and redeploy the previous UI.
-- =============================================================
set lock_timeout = '5s';
begin;

drop trigger if exists teams_block_while_deleting on public.teams;
drop trigger if exists team_members_block_while_deleting on public.team_members;
drop trigger if exists player_guardians_block_while_deleting on public.player_guardians;
drop trigger if exists team_members_keep_owner on public.team_members;
drop trigger if exists player_guardians_keep_one on public.player_guardians;

drop function if exists public.request_owner_transfer(uuid, uuid);
drop function if exists public.cancel_owner_transfer(uuid);
drop function if exists public.respond_owner_transfer(uuid, boolean);
drop function if exists public.my_owner_transfers();
drop function if exists public.account_deletion_preview();
drop function if exists public.purge_account_data(uuid, uuid, interval);
drop function if exists public.note_account_deletion_failure(uuid, text);
drop function if exists private.ensure_team_owner();
drop function if exists private.ensure_child_guardian();
drop function if exists private.block_while_deleting();

drop table if exists public.team_owner_transfers;
drop table if exists private.account_deletions;
drop index if exists public.team_members_one_owner;

-- previous definition (no session check)
create or replace function private.require_auth()
returns uuid language plpgsql stable security invoker set search_path = ''
as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return v;
end;
$$;

do $$
declare r record; v_con text; v_name text;
begin
  for r in select * from (values
    ('events', 'created_by'), ('events', 'updated_by'), ('events', 'deleted_by'),
    ('attendance', 'updated_by'), ('players', 'updated_by'), ('players', 'archived_by'),
    ('guardian_invitations', 'created_by'), ('guardian_invitations', 'used_by')
  ) as v(t, c)
  loop
    select con.conname into v_con
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f' and con.conrelid = format('public.%I', r.t)::regclass
       and con.confrelid = 'auth.users'::regclass and a.attname = r.c;
    execute format('alter table public.%I drop constraint %I', r.t, v_con);
    execute format('alter table public.%I add constraint %I foreign key (%I) references auth.users(id)',
                   r.t, r.t || '_' || r.c || '_fkey', r.c);
  end loop;
  for r in select * from (values ('teams', 'created_by'), ('players', 'created_by'),
                                 ('events', 'created_by'), ('attendance', 'updated_by')) as v(t, c)
  loop
    execute format('select count(*) from public.%I where %I is null', r.t, r.c) into v_name;
    if v_name = '0' then
      execute format('alter table public.%I alter column %I set not null', r.t, r.c);
    else
      raise notice '%.% keeps NULLs (% rows, anonymised by deletions): left nullable', r.t, r.c, v_name;
    end if;
  end loop;
end $$;

commit;
reset lock_timeout;
