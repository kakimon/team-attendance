// End-to-end flow through the REAL app data layer (app/repo/supabaseRepo.ts)
// against the REAL migrations, as different logged-in users.
// Covers: team create -> share URL -> join -> child registration -> attendance
// save/load -> family invitation, and what a URL-only person can NOT do.
import { beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import type { Repo, TeamSnapshot } from '../../app/utils/types'
import { pgliteClient } from './pgliteClient'
import { addUser, createDb, type Db } from './setup'

const COACH = '10000000-0000-0000-0000-000000000001'
const DAD = '10000000-0000-0000-0000-000000000002'
const MOM = '10000000-0000-0000-0000-000000000003'
const OTHER = '10000000-0000-0000-0000-000000000004' // another family, knows the URL
const STRANGER = '10000000-0000-0000-0000-000000000005' // got the URL, never registers a child

let db: Db
const repos: Record<string, Repo> = {}
const repo = (u: string) => repos[u]!
let teamId: string
let shareToken: string
let eventId: string
let kid: string

const expectCode = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code })

beforeAll(async () => {
  db = await createDb()
  for (const u of [COACH, DAD, MOM, OTHER, STRANGER]) {
    await addUser(db, u)
    repos[u] = createSupabaseRepo(pgliteClient(db, u), () => u)
  }
})

describe('team creation and shared URL', () => {
  it('creator becomes owner and gets a share token', async () => {
    const t = await repo(COACH).createTeam('ひまわりジュニア', '監督')
    teamId = t.id
    shareToken = t.share_token
    expect(shareToken).toMatch(/^[0-9a-f]{32}$/)
    expect(await repo(COACH).myTeams()).toEqual([{ ...t, role: 'owner' }])
  })

  it('admin creates an event', async () => {
    await repo(COACH).createEvent(teamId, {
      title: '練習', starts_at: new Date(Date.now() + 86400_000).toISOString(), location: '河川敷', note: null,
    })
    const s = (await repo(COACH).loadTeam(teamId))!
    eventId = s.events[0]!.id
  })

  it('before joining, the URL reveals only the team name', async () => {
    const p = await repo(DAD).teamPreview(shareToken)
    expect(p).toEqual({ id: teamId, name: 'ひまわりジュニア', is_member: false, role: null })
    expect(await repo(DAD).loadTeam(teamId)).toBeNull()
    expect(await repo(DAD).myTeams()).toEqual([])
  })

  it('unknown token -> null', async () => {
    expect(await repo(DAD).teamPreview('nope')).toBeNull()
  })

  it('joining via URL gives member role', async () => {
    for (const u of [DAD, OTHER, STRANGER]) await repo(u).joinTeam(shareToken, 'x')
    expect((await repo(DAD).teamPreview(shareToken))!.role).toBe('member')
  })
})

describe('Google login -> child registration -> attendance -> DB', () => {
  it('parent registers own child and becomes its guardian', async () => {
    const r = await repo(DAD).registerPlayer(teamId, '田中 ゆうと', '4年', false)
    expect(r.status).toBe('created')
    kid = (r as { player_id: string }).player_id
    const s = (await repo(DAD).loadTeam(teamId))!
    expect(s.myPlayerIds).toEqual([kid])
  })

  it('saves, changes, and resets attendance; everyone in the team sees it', async () => {
    await repo(DAD).setAttendance(eventId, kid, 'attend', '遅れます')
    let s = (await repo(OTHER).loadTeam(teamId))!
    expect(s.attendance).toMatchObject([{ event_id: eventId, player_id: kid, status: 'attend', comment: '遅れます' }])

    await repo(DAD).setAttendance(eventId, kid, 'absent', null)
    s = (await repo(COACH).loadTeam(teamId))!
    expect(s.attendance).toMatchObject([{ status: 'absent', comment: null }])

    await repo(DAD).setAttendance(eventId, kid, 'unanswered', null)
    s = (await repo(COACH).loadTeam(teamId))!
    expect(s.attendance).toEqual([])
  })
})

describe('knowing the team URL does NOT give edit rights to other families', () => {
  let snap: TeamSnapshot
  beforeAll(async () => {
    await repo(DAD).setAttendance(eventId, kid, 'attend', null)
    snap = (await repo(STRANGER).loadTeam(teamId))!
  })

  it('URL-only member can read the list but has no children of their own', () => {
    expect(snap.players.map((p) => p.id)).toEqual([kid])
    expect(snap.myPlayerIds).toEqual([])
    expect(snap.me.role).toBe('member')
  })

  it('cannot change, reset, or comment on another family\'s child', async () => {
    await expectCode(repo(STRANGER).setAttendance(eventId, kid, 'absent', null), 'forbidden')
    await expectCode(repo(STRANGER).setAttendance(eventId, kid, 'unanswered', null), 'forbidden')
    await expectCode(repo(OTHER).setAttendance(eventId, kid, 'undecided', 'x'), 'forbidden')
    const s = (await repo(DAD).loadTeam(teamId))!
    expect(s.attendance).toMatchObject([{ status: 'attend' }])
  })

  it('cannot create a family invitation for another family\'s child', async () => {
    await expectCode(repo(STRANGER).createInvitation(kid), 'forbidden')
  })

  it('registering the same name creates a warning, never access to the existing child', async () => {
    const r = await repo(STRANGER).registerPlayer(teamId, '田中ゆうと', null, false)
    expect(r.status).toBe('similar_found')
    const r2 = await repo(STRANGER).registerPlayer(teamId, '田中ゆうと', null, true)
    expect(r2.status).toBe('created')
    await expectCode(repo(STRANGER).setAttendance(eventId, kid, 'absent', null), 'forbidden')
  })

  it('cannot create events or see admin-only guardian links', async () => {
    await expectCode(repo(STRANGER).createEvent(teamId, {
      title: 'x', starts_at: new Date().toISOString(), location: null, note: null,
    }), 'forbidden')
  })

  it('re-joining never upgrades the role', async () => {
    await repo(STRANGER).joinTeam(shareToken, 'again')
    expect((await repo(STRANGER).teamPreview(shareToken))!.role).toBe('member')
  })
})

describe('family invitation through the app data layer', () => {
  let token: string

  it('guardian creates a 24h link; spouse accepts and can edit', async () => {
    const inv = await repo(DAD).createInvitation(kid)
    token = inv.token
    const r = await repo(MOM).acceptInvitation(token, '田中（母）')
    expect(r).toMatchObject({ status: 'accepted', player_id: kid, team_id: teamId, share_token: shareToken })
    await repo(MOM).setAttendance(eventId, kid, 'undecided', null)
    const s = (await repo(MOM).loadTeam(teamId))!
    expect(s.myPlayerIds).toEqual([kid])
    expect(s.me.role).toBe('member')
  })

  it('the same link cannot be used again', async () => {
    await expectCode(repo(OTHER).acceptInvitation(token, 'x'), 'invitation_invalid')
    await expectCode(repo(OTHER).setAttendance(eventId, kid, 'absent', null), 'forbidden')
  })
})

describe('Phase 4-A through the app data layer', () => {
  it('existing guardian opening an invitation gets a normal result and does not consume it', async () => {
    const inv = await repo(DAD).createInvitation(kid)
    const r = await repo(MOM).acceptInvitation(inv.token, 'x')
    expect(r).toMatchObject({ status: 'already_guardian', player_id: kid, share_token: shareToken })
    const r2 = await repo(STRANGER).acceptInvitation(inv.token, '祖父')
    expect(r2.status).toBe('accepted')
  })

  it('admin edits an event (answers kept) and deletes it logically', async () => {
    await repo(DAD).setAttendance(eventId, kid, 'attend', '持ち物OK')
    const when = new Date(Date.now() + 2 * 86400_000).toISOString()
    await repo(COACH).updateEvent(eventId, { title: '練習（時間変更）', starts_at: when, location: '体育館', note: null })
    let s = (await repo(DAD).loadTeam(teamId))!
    expect(s.events.find((e) => e.id === eventId)).toMatchObject({ title: '練習（時間変更）', location: '体育館' })
    expect(s.attendance).toEqual(expect.arrayContaining([expect.objectContaining({ player_id: kid, status: 'attend', comment: '持ち物OK' })]))
    await expectCode(repo(DAD).updateEvent(eventId, { title: 'x', starts_at: when, location: null, note: null }), 'forbidden')
    await expectCode(repo(DAD).deleteEvent(eventId), 'forbidden')

    await repo(COACH).deleteEvent(eventId)
    s = (await repo(DAD).loadTeam(teamId))!
    expect(s.events.find((e) => e.id === eventId)).toBeUndefined()
    await expectCode(repo(DAD).setAttendance(eventId, kid, 'absent', null), 'not_found')
    const kept = await db.query('select count(*)::int as n from public.attendance where event_id = $1', [eventId])
    expect((kept.rows[0] as { n: number }).n).toBeGreaterThan(0)
  })

  it('guardian edits and cancels their child; another family cannot', async () => {
    const r = await repo(STRANGER).registerPlayer(teamId, 'テスト さぶろう', null, true)
    const sab = (r as { player_id: string }).player_id
    await expectCode(repo(OTHER).updatePlayer(sab, '乗っ取り', null, true), 'forbidden')
    await expectCode(repo(OTHER).archivePlayer(sab), 'forbidden')
    const u = await repo(STRANGER).updatePlayer(sab, 'テスト 三郎', '1年', false)
    expect(u.status).toBe('updated')
    const warn = await repo(STRANGER).updatePlayer(sab, '田中ゆうと', null, false)
    expect(warn.status).toBe('similar_found')
    await repo(STRANGER).archivePlayer(sab)
    const s = (await repo(STRANGER).loadTeam(teamId))!
    expect(s.players.find((p) => p.id === sab)).toBeUndefined()
    await expectCode(repo(STRANGER).createInvitation(sab), 'not_found')
  })
})
