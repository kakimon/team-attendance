import { describe, expect, it } from 'vitest'
import { resolveJump, shareUrl } from '../../app/utils/jump'

describe('relay page /j/', () => {
  it('team link -> /t/<token>, invite link -> /invite/<token>', () => {
    expect(resolveJump({ t: 'abc123', openExternalBrowser: '1' })).toBe('/t/abc123')
    expect(resolveJump({ i: 'f'.repeat(64) })).toBe(`/invite/${'f'.repeat(64)}`)
  })
  it('rejects missing, ambiguous, or malformed tokens', () => {
    expect(resolveJump({})).toBeNull()
    expect(resolveJump({ t: 'abc123', i: 'def456' })).toBeNull()
    for (const bad of ['../admin', 'a/b', 'x', '<script>', 'a'.repeat(129), '%2e%2e']) {
      expect(resolveJump({ t: bad })).toBeNull()
      expect(resolveJump({ i: bad })).toBeNull()
    }
  })
  it('share URLs keep the repo base path, use /j/ with a trailing slash, and open outside LINE', () => {
    expect(shareUrl('team', 'abc', 'https://u.github.io', '/team-attendance/'))
      .toBe('https://u.github.io/team-attendance/j/?t=abc&openExternalBrowser=1')
    expect(shareUrl('invite', 'def', 'http://localhost:3000', '/'))
      .toBe('http://localhost:3000/j/?i=def&openExternalBrowser=1')
  })
  it('round-trips: a generated link resolves to the right screen', () => {
    const u = new URL(shareUrl('invite', 'f'.repeat(64), 'https://u.github.io', '/repo/'))
    expect(resolveJump(Object.fromEntries(u.searchParams))).toBe(`/invite/${'f'.repeat(64)}`)
  })
})
