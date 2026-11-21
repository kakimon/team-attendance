// Phase 5-C U5-B: team page address (/t/<team id>) vs join link (/join/<token>), old addresses,
// and the screens' use of them (source checks).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTeamId, legacyTeamPath, resolveJump, shareUrl } from '../../app/utils/jump'
import { inviteKindOf } from '../../app/utils/loginTarget'
import { ERROR_MESSAGE } from '../../app/utils/types'

const APP = join(import.meta.dirname, '../../app')
const read = (f: string) => readFileSync(join(APP, f), 'utf8')
const ID = '2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const JOIN = 'J'.repeat(40)

describe('links', () => {
  it('join links use their own key (k) and open /join/<token>; old t links still open /t/<share token>', () => {
    expect(shareUrl('join', JOIN, 'https://u.github.io', '/repo/')).toBe(`https://u.github.io/repo/j/?k=${JOIN}&openExternalBrowser=1`)
    const u = new URL(shareUrl('join', JOIN, 'https://u.github.io', '/repo/'))
    expect(resolveJump(Object.fromEntries(u.searchParams))).toBe(`/join/${JOIN}`)
    expect(resolveJump({ t: 'a'.repeat(32) })).toBe(`/t/${'a'.repeat(32)}`)
    expect(resolveJump({ k: JOIN, t: 'abcd' })).toBeNull()             // ambiguous
    expect(resolveJump({ k: JOIN, i: 'abcd' })).toBeNull()
    for (const bad of ['../x', 'a/b', 'x', '<s>']) expect(resolveJump({ k: bad })).toBeNull()
  })

  it('team id vs old share token', () => {
    expect(isTeamId(ID)).toBe(true)
    expect(isTeamId('a'.repeat(32))).toBe(false)                        // share tokens are 32 hex characters
    expect(isTeamId('demo')).toBe(false)
  })

  it('old address -> same page under the team id (query/hash kept by the caller)', () => {
    const old = 'a'.repeat(32)
    expect(legacyTeamPath(`/t/${old}`, old, ID)).toBe(`/t/${ID}`)
    expect(legacyTeamPath(`/t/${old}/answer`, old, ID)).toBe(`/t/${ID}/answer`)
    expect(legacyTeamPath(`/t/${old}/children/p1`, old, ID)).toBe(`/t/${ID}/children/p1`)
    expect(legacyTeamPath(`/t/${old}x/answer`, old, ID)).toBe(`/t/${old}x/answer`)   // another token: unchanged
  })

  it('login page: a join link counts as a team invitation', () => {
    expect(inviteKindOf(`/join/${JOIN}`)).toBe('team')
    expect(inviteKindOf('/invite/xyz')).toBe('family')
  })

  it('join errors have understandable Japanese messages', () => {
    for (const c of ['join_link_invalid', 'join_attempt_rate_limited', 'membership_limit_exceeded', 'team_member_limit_exceeded', 'blocked_from_team'] as const) {
      expect(ERROR_MESSAGE[c], c).toMatch(/[ぁ-ん]/)
    }
    expect(ERROR_MESSAGE.join_link_invalid).toContain('再発行')
  })
})

describe('screens (source checks)', () => {
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(vue|ts)$/.test(f) && files.push(p) } }
  walk(APP)

  it('no screen links to a team page by its share token any more', () => {
    for (const f of files) {
      if (/\/repo\//.test(f)) continue
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\/t\/\$\{[^}]*share_token/)
    }
  })

  it('the team shell has no join form and does not use the old join path', () => {
    const shell = read('components/TeamShell.vue')
    expect(shell).not.toContain('joinTeam')
    expect(shell).not.toContain('teamPreview')
    expect(shell).not.toContain('チームに参加する')
    const page = read('composables/useTeamPage.ts')
    expect(page).toContain('repo.resolveLegacyTeam(k)')
    expect(page).toContain('{ replace: true }')
    expect(page).not.toMatch(/joinTeam|teamPreview/)
  })

  it('join page: server-checked preview and join, double-submit guard, token never in the title or logs', () => {
    const src = read('pages/join/[token].vue')
    expect(src).toContain('repo.previewJoin(token)')
    expect(src).toContain('repo.joinByToken(token, displayName.value.trim())')
    expect(src).toContain('if (busy.value) return')
    expect(src).toContain("navigateTo(`/t/${teamId}`, { replace: true })")
    expect(src).toMatch(/useHead\(\{ title: 'チームへの参加 \| みんなの出欠' \}\)/)
    for (const f of ['pages/join/[token].vue', 'components/JoinLinkCard.vue', 'composables/useTeamPage.ts']) expect(read(f), f).not.toMatch(/console\.|sendBeacon|gtag|analytics/)
  })

  it('join link management: status, copy, re-issue with a warning, stop / reopen; on the admin screen only', () => {
    const card = read('components/JoinLinkCard.vue')
    for (const w of ['受付中', '受付停止中', 'URLを再発行', '受付を停止', '受付を再開', '以前の参加用URLは、すぐに使えなくなります', 'CopyField']) expect(card).toContain(w)
    expect(card).toContain("shareUrl('join'")
    expect(read('pages/t/[token]/admin.vue')).toContain('<JoinLinkCard')
    expect(read('pages/t/[token]/admin.vue')).toContain('v-if="!isAdminRole(snap)"')
    expect(read('pages/teams/new.vue')).toContain('repo.getJoinLink(t.id)')
    expect(read('pages/teams/new.vue')).not.toContain("shareUrl('team'")
  })
})
