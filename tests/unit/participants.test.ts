// Phase 5-C U5-A: self registration (本人登録) and proxy registration (代理登録) in the UI.
// Pure display rules, the data layer's request shape, the demo repo, and source checks of the screens.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_TEAM_ID, createMockRepo } from '../../app/repo/mockRepo'
import { createSupabaseRepo, type DbClient } from '../../app/repo/supabaseRepo'
import {
  canRegisterSelf, isSelfRegistration, myParticipants, mySelfRegistration, participantBadge, similarToMe,
} from '../../app/utils/participants'
import { ERROR_MESSAGE, RepoError, errorMessage, type Player, type TeamSnapshot } from '../../app/utils/types'

const APP = join(import.meta.dirname, '../../app')
const read = (f: string) => readFileSync(join(APP, f), 'utf8')
const ME = 'u-me', OTHER = 'u-other'
const P = (id: string, name: string, o: Partial<Player> = {}): Player => ({ id, team_id: 't', name, note: null, ...o })
const snap = (o: Partial<TeamSnapshot> = {}): TeamSnapshot => ({
  team: { id: 't', name: 'T', share_token: 'tok' },
  me: { team_id: 't', user_id: ME, role: 'member', display_name: '田中 太郎' },
  players: [], events: [], attendance: [], myPlayerIds: [], selfSupported: true, ...o,
})

describe('display rules (participants.ts)', () => {
  it('my own self registration comes first; badges: あなた（本人）/ 本人 / あなたが回答 / none', () => {
    const kid = P('k', 'ゆうと'), me = P('m', '田中 太郎', { is_self: true, self_user_id: ME })
    const other = P('o', '佐藤 花子', { is_self: true, self_user_id: OTHER }), theirs = P('x', 'はるき')
    const s = snap({ players: [kid, other, me, theirs], myPlayerIds: ['k', 'm'] })
    expect(myParticipants(s).map((p) => p.id)).toEqual(['m', 'k'])
    expect(participantBadge(s, me)).toEqual({ label: 'あなた（本人）', tone: 'primary' })
    expect(participantBadge(s, other)).toEqual({ label: '本人', tone: 'neutral' })
    expect(participantBadge(s, kid)).toEqual({ label: 'あなたが回答', tone: 'primary' })
    expect(participantBadge(s, theirs)).toBeNull()
    expect(isSelfRegistration(other)).toBe(true)
    expect(isSelfRegistration(kid)).toBe(false)
  })

  it('"register myself" is offered only when the DB supports it and I am not registered yet', () => {
    expect(canRegisterSelf(snap())).toBe(true)
    expect(canRegisterSelf(snap({ selfSupported: false }))).toBe(false)
    const s = snap({ players: [P('m', '田中 太郎', { is_self: true, self_user_id: ME })], myPlayerIds: ['m'] })
    expect(mySelfRegistration(s)?.id).toBe('m')
    expect(canRegisterSelf(s)).toBe(false)
    // someone else's self registration does not count as mine
    expect(canRegisterSelf(snap({ players: [P('o', 'x', { is_self: true, self_user_id: OTHER })] }))).toBe(true)
  })

  it('a proxy registration with my display name is reported as a possible duplicate (warning only)', () => {
    const s = snap({ players: [P('a', 'たなか たろう'), P('b', '田中太郎'), P('c', '佐藤'), P('d', '田中 太郎', { is_self: true, self_user_id: OTHER })] })
    expect(similarToMe(s).map((p) => p.id)).toEqual(['b'])   // NFKC / spaces ignored; self registrations excluded
    expect(similarToMe(snap({ players: [P('c', '佐藤')] }))).toEqual([])
  })

  it('an adults-only team: nobody is asked to register a child, the own entry is enough', () => {
    const s = snap({ players: [P('m', '田中 太郎', { is_self: true, self_user_id: ME })], myPlayerIds: ['m'] })
    expect(myParticipants(s)).toHaveLength(1)
    expect(participantBadge(s, s.players[0]!)?.label).toBe('あなた（本人）')
  })
})

describe('data layer: what the browser sends', () => {
  function fake(result: { data?: unknown; error?: { message: string } | null }) {
    const calls: { fn: string; args?: Record<string, unknown> }[] = []
    const db = {
      from: () => { throw new Error('not used') },
      rpc: (fn: string, args?: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }) },
    } as unknown as DbClient
    return { repo: createSupabaseRepo(db, () => ME), calls }
  }

  it('register_self gets ONLY the team id (no user id, no is_self, no name)', async () => {
    const { repo, calls } = fake({ data: { status: 'created', player_id: 'p' } })
    expect(await repo.registerSelf('t1')).toEqual({ status: 'created', player_id: 'p' })
    expect(calls).toEqual([{ fn: 'register_self', args: { p_team_id: 't1' } }])
  })

  it('a database without register_self -> feature_unavailable, with a Japanese message', async () => {
    const { repo } = fake({ error: { message: 'Could not find the function public.register_self(p_team_id) in the schema cache' } })
    const e = await repo.registerSelf('t1').catch((x) => x)
    expect(e).toBeInstanceOf(RepoError)
    expect(e.code).toBe('feature_unavailable')
    expect(errorMessage(e)).toBe(ERROR_MESSAGE.feature_unavailable)
  })

  it('permission and limit errors become understandable Japanese messages', async () => {
    for (const [msg, code] of [
      ['forbidden', 'forbidden'], ['guardian_child_limit_exceeded', 'guardian_child_limit_exceeded'],
      ['team_child_limit_exceeded', 'team_child_limit_exceeded'], ['account_deletion_pending', 'account_deletion_pending'],
    ] as const) {
      const { repo } = fake({ error: { message: msg } })
      const e = await repo.registerSelf('t1').catch((x) => x)
      expect(e.code, msg).toBe(code)
      expect(errorMessage(e)).toMatch(/[ぁ-んァ-ン一-龥]/)
      expect(errorMessage(e)).not.toBe(ERROR_MESSAGE.unknown)
    }
  })
})

describe('demo repo (same rules as the server)', () => {
  it('created -> existing -> (cancel) -> restored; name = team display name; only the person manages it', async () => {
    let who = 'u-sato'
    const repo = createMockRepo(() => who, () => '')
    const r1 = await repo.registerSelf(DEMO_TEAM_ID)
    expect(r1.status).toBe('created')
    expect((await repo.registerSelf(DEMO_TEAM_ID))).toEqual({ status: 'existing', player_id: r1.player_id })
    const s = (await repo.loadTeam(DEMO_TEAM_ID))!
    expect(s.players.find((p) => p.id === r1.player_id)).toMatchObject({ name: '佐藤（母）', is_self: true, self_user_id: 'u-sato' })
    expect(s.myPlayerIds).toContain(r1.player_id)
    await repo.archivePlayer(r1.player_id)
    expect((await repo.registerSelf(DEMO_TEAM_ID))).toEqual({ status: 'restored', player_id: r1.player_id })
    who = 'u-new'
    await expect(repo.registerSelf(DEMO_TEAM_ID)).rejects.toMatchObject({ code: 'forbidden' })   // not a member
  })
})

describe('screens (source checks)', () => {
  const tabs = read('components/TeamTabs.vue')
  const self = read('pages/t/[token]/children/self.vue')
  const choices = read('components/RegisterChoices.vue')

  it('the tab is 「回答する人」; the URL stays /children (old links keep working)', () => {
    expect(tabs).toContain("label: '回答する人'")
    expect(tabs).toContain('`/t/${props.token}/children`')
    expect(tabs).not.toContain('うちの子')
  })

  it('two separate entries: 自分を登録する (self page) and 家族などを登録する (existing form)', () => {
    expect(choices).toContain('自分を登録する')
    expect(choices).toContain('家族などを登録する')
    expect(choices).toContain('/children/self')
    expect(choices).toContain('/children/new')
    expect(choices).toContain('canRegisterSelf(props.snap)')            // hidden when registered / unsupported
    for (const f of ['pages/t/[token]/answer.vue', 'pages/t/[token]/children/index.vue']) expect(read(f)).toContain('<RegisterChoices')
  })

  it('self registration: double submit blocked, already-registered and unsupported states, similar-name warning', () => {
    expect(self).toContain('if (busy.value || done.value) return')
    expect(self).toMatch(/:disabled="busy \|\| done/)
    expect(self).toContain('repo.registerSelf(s.team.id)')              // nothing else is sent
    expect(self).toContain('v-if="!snap.selfSupported"')
    expect(self).toContain('v-else-if="mySelfRegistration(snap)"')
    expect(self).toContain('similarToMe(snap)')
    expect(self).toContain('errorMessage(e)')
  })

  it('the proxy form is kept (register_player) with a double-submit guard', () => {
    const form = read('pages/t/[token]/children/new.vue')
    expect(form).toContain('repo.registerPlayer(s.team.id')
    expect(form).toContain('if (busy.value) return')
  })

  it('no team screen tells members to register a "child" as the only option', () => {
    const files = ['components/OnboardingPanel.vue', 'pages/t/[token]/answer.vue', 'pages/t/[token]/children/index.vue', 'utils/onboarding.ts', 'utils/tour.ts']
    for (const f of files) expect(read(f), f).not.toMatch(/子どもを登録する'|>子どもを登録する</)
  })
})
