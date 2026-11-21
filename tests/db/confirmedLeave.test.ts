import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { LEAVE_CLEANUP_CONFIRM } from '../../app/utils/types'
import { addUser, applyMigration, asUser, createDb } from './setup'
import { pgliteClient } from './pgliteClient'

const MIG = '20261118000000_confirmed_leave.sql'
const DOWN = readFileSync(new URL('../../supabase/rollback/20261118000000_confirmed_leave_down.sql', import.meta.url), 'utf8')
const O = '56000000-0000-4000-8000-000000000001', A = '56000000-0000-4000-8000-000000000002', B = '56000000-0000-4000-8000-000000000003'
async function setup() {
  const db = await createDb()
  for (const id of [O, A, B]) await addUser(db, id)
  const r = (id: string) => createSupabaseRepo(pgliteClient(db, id), () => id)
  const o = r(O), a = r(A), b = r(B)
  const t = await o.createTeam('D6-A', '代表')
  const token = (await o.getJoinLink(t.id)).token!
  await a.joinByToken(token, '本人'); await b.joinByToken(token, '家族')
  const kid = (await a.registerPlayer(t.id, '単独', null, true)) as { player_id: string }
  await o.createEvent(t.id, { title: '練習', starts_at: '2026-12-01T09:00:00Z', location: null, note: null })
  const ev = (await a.loadTeam(t.id))!.events[0]!.id
  const preview = () => a.leaveCleanupPreview(t.id)
  const leave = (hash: string, confirm = LEAVE_CLEANUP_CONFIRM) => a.leaveTeamWithCleanup(t.id, hash, confirm)
  return { db, o, a, b, t, kid: kid.player_id, ev, token, preview, leave }
}

describe('D6-A confirmed self leave through the real data layer', () => {
  it('deletes active/cancelled sole proxies + own self; protects shared/other self, teams, account and events', async () => {
    const s = await setup(); const { db, a, b, o, t, kid, ev } = s
    try {
      await a.setAttendance(ev, kid, 'absent', '出欠コメント')
      const cancelled = (await a.registerPlayer(t.id, '取り消し', null, true)) as { player_id: string }
      await a.archivePlayer(cancelled.player_id)
      const shared = (await a.registerPlayer(t.id, '共有', null, true)) as { player_id: string }
      await b.acceptInvitation((await a.createInvitation(shared.player_id)).token, '家族')
      const self = await a.registerSelf(t.id)
      await b.acceptInvitation((await a.createInvitation(self.player_id)).token, '家族')
      await b.setAttendance(ev, self.player_id, 'attend', '代理回答')
      const otherSelf = await b.registerSelf(t.id)
      await a.acceptInvitation((await b.createInvitation(otherSelf.player_id)).token, '本人')
      const unused = await a.createInvitation(kid)
      const otherTeam = await a.createTeam('他チーム', '本人')
      await a.registerSelf(otherTeam.id)
      const pv = await s.preview()
      expect(pv.cleanup.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(pv.cleanup.deletions).toEqual(expect.arrayContaining([
        expect.objectContaining({ player_id: kid, answers: 1, is_self: false }),
        expect.objectContaining({ player_id: cancelled.player_id, answers: 0, cancelled: true }),
        expect.objectContaining({ player_id: self.player_id, answers: 1, is_self: true }),
      ]))
      expect(pv.cleanup.deletions).toHaveLength(3)
      await expect(a.leaveTeam(t.id)).rejects.toMatchObject({ code: 'sole_guardian_children' })
      await expect(o.removeMember(t.id, A)).rejects.toMatchObject({ code: 'sole_guardian_children' })
      expect(await s.leave(pv.cleanup.fingerprint)).toMatchObject({ status: 'left', proxy_registrations_deleted: 2, self_registrations_deleted: 1, answers_deleted: 2 })
      const snap = (await b.loadTeam(t.id))!
      expect(snap.players.map((p) => p.id).sort()).toEqual([shared.player_id, otherSelf.player_id].sort())
      expect(snap.events).toHaveLength(1)
      expect(await a.loadTeam(t.id)).toBeNull()
      expect(await a.loadTeam(otherTeam.id)).not.toBeNull()
      expect((await db.query('select id from auth.users where id=$1', [A])).rows).toHaveLength(1)
      expect(await o.blockedMembers(t.id)).toEqual([])
      await expect(b.acceptInvitation(unused.token, '家族')).rejects.toMatchObject({ code: 'invitation_invalid' })
      await expect(s.leave(pv.cleanup.fingerprint)).rejects.toMatchObject({ code: 'not_member' })
      await a.joinByToken(s.token, '本人')
      await expect(s.leave(pv.cleanup.fingerprint)).rejects.toMatchObject({ code: 'leave_confirmation_stale' })
    } finally { await db.close() }
  })

  it.each(['answer', 'comment', 'rename', 'archive', 'register', 'share', 'invite', 'newly-sole'] as const)('rejects a stale preview after %s, with no partial deletion', async (change) => {
    const s = await setup(); const { db, a, b, kid, ev, t } = s
    try {
      await a.setAttendance(ev, kid, 'attend', 'before')
      if (change === 'newly-sole') {
        const shared = (await a.registerPlayer(t.id, '共有から単独', null, true)) as { player_id: string }
        await b.acceptInvitation((await a.createInvitation(shared.player_id)).token, '家族')
      }
      const pv = await s.preview()
      if (change === 'answer') await a.setAttendance(ev, kid, 'unanswered', null)
      if (change === 'comment') await a.setAttendance(ev, kid, 'attend', 'after')
      if (change === 'rename') await a.updatePlayer(kid, '名前変更', null, true)
      if (change === 'archive') await a.archivePlayer(kid)
      if (change === 'register') await a.registerPlayer(t.id, '追加', null, true)
      if (change === 'share') await b.acceptInvitation((await a.createInvitation(kid)).token, '家族')
      if (change === 'invite') await a.createInvitation(kid)
      if (change === 'newly-sole') await b.leaveTeam(t.id)
      const before = (await db.query('select to_jsonb(p) as p from public.players p order by id')).rows
      await expect(s.leave(pv.cleanup.fingerprint)).rejects.toMatchObject({ code: 'leave_confirmation_stale' })
      expect((await db.query('select to_jsonb(p) as p from public.players p order by id')).rows).toEqual(before)
      expect(await a.loadTeam(t.id)).not.toBeNull()
    } finally { await db.close() }
  })

  it('checks auth, ownership, explicit confirmation and fingerprint; invitation issuance alone is not sharing', async () => {
    const s = await setup(); const { db, a, b, o, t, kid } = s
    try {
      await a.createInvitation(kid)
      const pv = await s.preview()
      expect(pv.sole_guardian_children).toHaveLength(1)
      await expect(s.leave(pv.cleanup.fingerprint, '')).rejects.toMatchObject({ code: 'confirm_required' })
      await expect(s.leave('0'.repeat(64))).rejects.toMatchObject({ code: 'leave_confirmation_stale' })
      await expect(b.leaveTeamWithCleanup(t.id, pv.cleanup.fingerprint, LEAVE_CLEANUP_CONFIRM)).rejects.toMatchObject({ code: 'leave_confirmation_stale' })
      await expect(o.leaveTeamWithCleanup(t.id, pv.cleanup.fingerprint, LEAVE_CLEANUP_CONFIRM)).rejects.toMatchObject({ code: 'owner_cannot_leave' })
      await expect(asUser(db, null, () => db.query('select public.leave_cleanup_preview($1)', [t.id]))).rejects.toThrow(/permission denied/)
      await expect(asUser(db, A, () => db.query('select private.leave_cleanup_state($1,$2)', [t.id, A]))).rejects.toThrow(/permission denied/)
      await db.query('delete from auth.sessions where user_id=$1', [A])
      await expect(s.leave(pv.cleanup.fingerprint)).rejects.toMatchObject({ code: 'session_expired' })
      expect((await db.query('select id from public.players where id=$1', [kid])).rows).toHaveLength(1)
    } finally { await db.close() }
  })

  it('never deletes another person\'s self registration even with inconsistent guardian links', async () => {
    const s = await setup(); const { db, a, b, t } = s
    try {
      const other = await b.registerSelf(t.id)
      await a.acceptInvitation((await b.createInvitation(other.player_id)).token, '本人')
      await db.query('delete from public.player_guardians where player_id=$1 and user_id=$2', [other.player_id, B])
      const pv = await s.preview()
      expect(pv.cleanup.deletions.some((p) => p.player_id === other.player_id)).toBe(false)
      await expect(s.leave(pv.cleanup.fingerprint)).rejects.toMatchObject({ code: 'forbidden' })
      expect((await db.query('select id from public.players where id=$1', [other.player_id])).rows).toHaveLength(1)
    } finally { await db.close() }
  })

  it('rolls back all deletion on downstream failure', async () => {
    const s = await setup()
    try {
      const pv = await s.preview()
      await s.db.exec(`create function public.d6_test_fail() returns trigger language plpgsql as $$begin raise exception 'test_failure'; end;$$;
        create trigger d6_test_fail before delete on public.team_members for each row execute function public.d6_test_fail();`)
      await expect(s.leave(pv.cleanup.fingerprint)).rejects.toThrow(/test_failure/)
      expect((await s.db.query('select id from public.players where id=$1', [s.kid])).rows).toHaveLength(1)
      expect(await s.a.loadTeam(s.t.id)).not.toBeNull()
    } finally { await s.db.close() }
  })

  it('rollback/reapply restores bodies and grants; old leave/remove remain byte-for-byte unchanged', async () => {
    const db = await createDb({ before: MIG })
    const functions = async () => (await db.query(`select oid::regprocedure::text as signature, prosrc, proacl::text as acl from pg_proc
      where pronamespace in ('public'::regnamespace,'private'::regnamespace) order by 1`)).rows
    try {
      const before = await functions()
      await applyMigration(db, MIG)
      const after = await functions()
      for (const name of ['leave_team(', 'remove_member(', 'leave_preview(', 'removal_preview(', 'purge_account_data(']) {
        expect(after.find((f: any) => f.signature.startsWith(name))).toEqual(before.find((f: any) => f.signature.startsWith(name)))
      }
      await db.exec(DOWN)
      expect(await functions()).toEqual(before)
      await applyMigration(db, MIG)
      expect(await functions()).toEqual(after)
    } finally { await db.close() }
  })
})
