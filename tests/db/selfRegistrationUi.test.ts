// Phase 5-C U5-A: the REAL app data layer (app/repo/supabaseRepo.ts) against the REAL migrations:
// self registration next to proxy registration, adults-only teams, and an older database (before D3.5).
import { describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { canRegisterSelf, myParticipants, participantBadge, similarToMe } from '../../app/utils/participants'
import { nextStep } from '../../app/utils/onboarding'
import { errorMessage, type Repo } from '../../app/utils/types'
import { pgliteClient } from './pgliteClient'
import { addUser, createDb, joinTeamAs } from './setup'

const U = (n: number) => `55100000-0000-4000-8000-${String(n).padStart(12, '0')}`
const COACH = U(1), ADULT = U(2), DAD = U(3), MOM = U(4), OUT = U(5)

async function setup(before?: string) {
  const db = await createDb(before ? { before } : {})
  const repos: Record<string, Repo> = {}
  for (const u of [COACH, ADULT, DAD, MOM, OUT]) {
    await addUser(db, u)
    repos[u] = createSupabaseRepo(pgliteClient(db, u), () => u)
  }
  const r = (u: string) => repos[u]!
  const t = await r(COACH).createTeam('社会人チーム', '監督')
  await r(COACH).createEvent(t.id, { title: '練習', starts_at: new Date(Date.now() + 86400_000).toISOString(), location: null, note: null })
  return { db, r, t }
}

describe('self registration through the app data layer', () => {
  it('adults-only team: join, register myself, answer; badge 本人; nobody is asked for a child', async () => {
    const { db, r, t } = await setup()
    await joinTeamAs(db, ADULT, t.share_token, '山田 一郎')
    let s = (await r(ADULT).loadTeam(t.id))!
    expect(s.selfSupported).toBe(true)
    expect(canRegisterSelf(s)).toBe(true)
    const res = await r(ADULT).registerSelf(t.id)
    expect(res.status).toBe('created')
    s = (await r(ADULT).loadTeam(t.id))!
    const me = s.players.find((p) => p.id === res.player_id)!
    expect(me).toMatchObject({ name: '山田 一郎', is_self: true, self_user_id: ADULT })
    expect(canRegisterSelf(s)).toBe(false)
    expect(myParticipants(s).map((p) => p.id)).toEqual([res.player_id])
    expect(participantBadge(s, me)?.label).toBe('あなた（本人）')
    await r(ADULT).setAttendance(s.events[0]!.id, me.id, 'attend', null)
    const coach = (await r(COACH).loadTeam(t.id))!
    expect(participantBadge(coach, coach.players.find((p) => p.id === me.id)!)?.label).toBe('本人')
    expect(coach.attendance).toEqual([expect.objectContaining({ player_id: me.id, status: 'attend' })])
    expect(nextStep({ role: 'member', myChildCount: s.myPlayerIds.length, upcomingEvents: 1, unanswered: 0, memberCount: 2, showGuidance: true })).toBeNull()
  })

  it('a second registration (double tap) does not create a second one: existing; cancel then restore', async () => {
    const { db, r, t } = await setup()
    await joinTeamAs(db, ADULT, t.share_token, '山田 一郎')
    const [a, b] = await Promise.all([r(ADULT).registerSelf(t.id), r(ADULT).registerSelf(t.id)])
    expect([a.status, b.status].sort()).toEqual(['created', 'existing'])
    expect(a.player_id).toBe(b.player_id)
    expect((await r(ADULT).loadTeam(t.id))!.players.filter((p) => p.self_user_id === ADULT)).toHaveLength(1)
    await r(ADULT).archivePlayer(a.player_id)
    expect(canRegisterSelf((await r(ADULT).loadTeam(t.id))!)).toBe(true)
    expect(await r(ADULT).registerSelf(t.id)).toEqual({ status: 'restored', player_id: a.player_id })
  })

  it('a parent: register a child (proxy) and themself; family sharing of the child still works', async () => {
    const { db, r, t } = await setup()
    await joinTeamAs(db, DAD, t.share_token, '田中（ゆうとの父）')
    const kid = await r(DAD).registerPlayer(t.id, '田中 ゆうと', '4年', false)
    expect(kid.status).toBe('created')
    const self = await r(DAD).registerSelf(t.id)
    let s = (await r(DAD).loadTeam(t.id))!
    expect(myParticipants(s).map((p) => p.id)).toEqual([self.player_id, (kid as { player_id: string }).player_id])
    const inv = await r(DAD).createInvitation((kid as { player_id: string }).player_id)
    const acc = await r(MOM).acceptInvitation(inv.token, '田中（ゆうとの母）')
    expect(acc.status).toBe('accepted')
    const mom = (await r(MOM).loadTeam(t.id))!
    expect(myParticipants(mom).map((p) => p.name)).toEqual(['田中 ゆうと'])
    expect(canRegisterSelf(mom)).toBe(true)                                  // MOM can still register herself
    s = (await r(DAD).loadTeam(t.id))!
    expect(s.players.find((p) => p.id === self.player_id)!.is_self).toBe(true)
  })

  it('a proxy registration with the same name -> similar warning before registering myself', async () => {
    const { db, r, t } = await setup()
    await joinTeamAs(db, DAD, t.share_token, '田中')
    await joinTeamAs(db, ADULT, t.share_token, '山田 一郎')
    await r(DAD).registerPlayer(t.id, '山田一郎', null, true)                // someone registered ADULT as a proxy
    const s = (await r(ADULT).loadTeam(t.id))!
    expect(similarToMe(s).map((p) => p.name)).toEqual(['山田一郎'])
  })

  it('outsiders and the proxy of someone else\'s self registration are refused with Japanese messages', async () => {
    const { db, r, t } = await setup()
    const e1 = await r(OUT).registerSelf(t.id).catch((e) => e)
    expect(e1.code).toBe('forbidden')
    expect(errorMessage(e1)).toBe('この操作の権限がありません。')
    await joinTeamAs(db, ADULT, t.share_token, '山田 一郎')
    await joinTeamAs(db, DAD, t.share_token, '田中')
    const me = await r(ADULT).registerSelf(t.id)
    const inv = await r(ADULT).createInvitation(me.player_id)                // ADULT lets DAD answer for him
    await r(DAD).acceptInvitation(inv.token, '田中')
    const e2 = await r(DAD).updatePlayer(me.player_id, '変更', null, true).catch((e) => e)
    expect(e2.code).toBe('forbidden')                                        // only the person manages it
    const dad = (await r(DAD).loadTeam(t.id))!
    expect(myParticipants(dad).map((p) => p.id)).toEqual([me.player_id])    // DAD can answer for him
    await r(DAD).setAttendance(dad.events[0]!.id, me.player_id, 'absent', null)
  })
})

describe('older database (Phase 5-B D3.5 not applied)', () => {
  it('the team still loads (no self columns); the self entry is hidden; register_self -> feature_unavailable', async () => {
    const { db, r, t } = await setup('20261117230000_self_registration.sql')
    await joinTeamAs(db, DAD, t.share_token, '田中')
    await r(DAD).registerPlayer(t.id, '田中 ゆうと', null, false)
    const s = (await r(DAD).loadTeam(t.id))!
    expect(s.selfSupported).toBe(false)
    expect(s.players.map((p) => p.name)).toEqual(['田中 ゆうと'])
    expect(canRegisterSelf(s)).toBe(false)
    const e = await r(DAD).registerSelf(t.id).catch((x) => x)
    expect(e.code).toBe('feature_unavailable')
    expect(errorMessage(e)).toContain('まだこの環境では使えません')
  })
})
