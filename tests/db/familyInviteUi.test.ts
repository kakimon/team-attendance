// Phase 6 family invitations through the REAL app data layer (app/repo/supabaseRepo.ts) on the real
// migrations: preview, accept without a name for members, the invitation list and revoking, the
// older-database fallback (only for a missing function), and the pure helpers the screens use.
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo, type DbClient } from '../../app/repo/supabaseRepo'
import { displayNameError, normalizeDisplayName } from '../../app/utils/displayName'
import { invitationState, visibleInvitations } from '../../app/utils/invitations'
import { myParticipants } from '../../app/utils/participants'
import { errorMessage, RepoError, type Repo } from '../../app/utils/types'
import { pgliteClient } from './pgliteClient'
import { addUser, createDb, joinTeamAs } from './setup'

const U = (n: number) => `56200000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T1 = U(1), T2 = U(2), NEW = U(3), OUT = U(4)

async function setup(before?: string) {
  const db = await createDb(before ? { before } : {})
  const repos: Record<string, Repo> = {}
  for (const u of [T1, T2, NEW, OUT]) { await addUser(db, u); repos[u] = createSupabaseRepo(pgliteClient(db, u), () => u) }
  const r = (u: string) => repos[u]!
  const t = await r(T1).createTeam('テストチーム', 'T1')
  await r(T1).createEvent(t.id, { title: 'テスト練習', starts_at: new Date(Date.now() + 86400_000).toISOString(), location: null, note: null })
  await joinTeamAs(db, T2, t.share_token, 'テスト2')
  await r(T2).registerSelf(t.id)
  const kid = (await r(T1).registerPlayer(t.id, 'テスト こどもB', null, true)).player_id
  return { db, r, t, kid }
}
const fail = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e } }

describe('family invitation through the app data layer', () => {
  it('existing member: preview says no name needed; accept with an empty name works; both registrations are listed', async () => {
    const { r, t, kid } = await setup()
    const inv = await r(T1).createInvitation(kid)
    expect(await r(T2).previewInvitation(inv.token)).toMatchObject({ status: 'valid', is_member: true, needs_display_name: false, player_name: 'テスト こどもB', team_name: 'テストチーム' })
    expect((await r(T2).acceptInvitation(inv.token, '')).status).toBe('accepted')
    const snap = (await r(T2).loadTeam(t.id))!
    expect(myParticipants(snap).map((p) => p.name)).toEqual(['テスト2', 'テスト こどもB'])
    expect(snap.me.display_name).toBe('テスト2')
    expect(await r(T2).previewInvitation(inv.token)).toMatchObject({ status: 'already_guardian', team_id: t.id })
  })

  it('new member: preview asks for a name; empty / too long names give the on-screen messages; a good name joins', async () => {
    const { r, t, kid } = await setup()
    const inv = await r(T1).createInvitation(kid)
    expect(await r(NEW).previewInvitation(inv.token)).toMatchObject({ status: 'valid', is_member: false, needs_display_name: true })
    expect(errorMessage(await fail(r(NEW).acceptInvitation(inv.token, '  ')))).toBe('名前を入力してください。')
    expect(errorMessage(await fail(r(NEW).acceptInvitation(inv.token, 'あ'.repeat(41))))).toBe('名前は40文字以内で入力してください。')
    expect((await r(NEW).acceptInvitation(inv.token, ' 田中 花子 ')).status).toBe('accepted')
    expect((await r(NEW).loadTeam(t.id))!.me.display_name).toBe('田中 花子')
  })

  it('invitation list (state columns only, guardians only) and revoking; the revoked link is refused', async () => {
    const { r, kid } = await setup()
    const a = await r(T1).createInvitation(kid)
    const b = await r(T1).createInvitation(kid)
    await r(T2).acceptInvitation(b.token, '')
    const list = await r(T1).listChildInvitations(kid)
    expect(list).toHaveLength(2)
    expect(Object.keys(list[0]!).sort()).toEqual(['created_at', 'expires_at', 'id', 'revoked_at', 'used_at'])
    expect(JSON.stringify(list)).not.toContain(a.token)
    expect(list.map((i) => invitationState(i)).sort()).toEqual(['active', 'used'])
    expect(await r(OUT).listChildInvitations(kid)).toEqual([])                                  // not a guardian: RLS hides them
    const active = list.find((i) => invitationState(i) === 'active')!
    expect((await fail(r(OUT).revokeInvitation(active.id)) as RepoError).code).toBe('forbidden')
    await r(T1).revokeInvitation(active.id)
    await r(T1).revokeInvitation(active.id)                                                   // twice: no error, no change
    const after = await r(T1).listChildInvitations(kid)
    expect(after.map((i) => invitationState(i)).sort()).toEqual(['revoked', 'used'])
    expect(await r(NEW).previewInvitation(a.token)).toEqual({ status: 'invalid' })
    expect((await fail(r(NEW).acceptInvitation(a.token, 'N')) as RepoError).code).toBe('invitation_invalid')
  })

  it('older database (no preview function): previewInvitation returns null so the page shows the old form', async () => {
    const { r, kid } = await setup('20261124000000_family_invite_accept.sql')
    const inv = await r(T1).createInvitation(kid)
    expect(await r(T2).previewInvitation(inv.token)).toBeNull()
  })

  it('auth, session and network errors are NOT taken for an older database', async () => {
    const fake = (message: string, code?: string): DbClient => ({
      from: () => { throw new Error('unused') },
      rpc: async () => ({ data: null, error: { message, code } }),
    })
    for (const [msg, code] of [['session_expired', 'P0001'], ['not_authenticated', '28000'], ['TypeError: Failed to fetch', ''],
      ['permission denied for function preview_guardian_invitation', '42501'], ['JWT expired', 'PGRST301']]) {
      const e = await fail(createSupabaseRepo(fake(msg!, code), () => T1).previewInvitation('x'.repeat(64)))
      expect(e).toBeInstanceOf(RepoError)
    }
    expect(await createSupabaseRepo(fake('Could not find the function public.preview_guardian_invitation(p_token) in the schema cache', 'PGRST202'), () => T1)
      .previewInvitation('x'.repeat(64))).toBeNull()
  })

  it('error texts never contain the token', async () => {
    const { r, kid } = await setup()
    const inv = await r(T1).createInvitation(kid)
    await r(T1).revokeInvitation((await r(T1).listChildInvitations(kid))[0]!.id)
    const e = await fail(r(NEW).acceptInvitation(inv.token, 'N')) as RepoError
    expect(`${e.message} ${errorMessage(e)}`).not.toContain(inv.token)
  })
})

describe('screen helpers', () => {
  it('display name: trimmed like the database; 1-40 characters', () => {
    expect(normalizeDisplayName('　 田中 \t')).toBe('田中')
    expect(displayNameError('')).toBe('name_required')
    expect(displayNameError('　 ')).toBe('name_required')
    expect(displayNameError(null)).toBe('name_required')
    expect(displayNameError('あ'.repeat(40))).toBeNull()
    expect(displayNameError('あ'.repeat(41))).toBe('display_name_too_long')
  })

  it('invitation state and the visible list', () => {
    const now = Date.parse('2026-11-24T00:00:00Z')
    const mk = (id: string, created: string, extra: Partial<{ used_at: string; revoked_at: string; expires_at: string }> = {}) =>
      ({ id, created_at: created, expires_at: extra.expires_at ?? '2026-11-25T00:00:00Z', used_at: extra.used_at ?? null, revoked_at: extra.revoked_at ?? null })
    const list = [
      mk('a', '2026-11-23T01:00:00Z'), mk('b', '2026-11-23T02:00:00Z', { used_at: '2026-11-23T03:00:00Z' }),
      mk('c', '2026-11-22T00:00:00Z', { expires_at: '2026-11-23T00:00:00Z' }), mk('d', '2026-11-23T04:00:00Z', { revoked_at: '2026-11-23T05:00:00Z', used_at: undefined }),
      mk('e', '2026-11-20T00:00:00Z', { used_at: '2026-11-20T01:00:00Z' }),
    ]
    expect(list.map((i) => invitationState(i, now))).toEqual(['active', 'used', 'expired', 'revoked', 'used'])
    expect(visibleInvitations(list, now).map((i) => i.id)).toEqual(['a', 'd', 'b', 'c'])
  })
})
