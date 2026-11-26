// Top page (logged out): usage numbers cached for 24 hours per browser, the page structure, and the existing
// login / invitation / legal-link wiring kept.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockRepo, MOCK_USERS } from '../../app/repo/mockRepo'
import { formatCount, loadServiceStats, STATS_TTL_MS } from '../../app/utils/serviceStats'
import type { ServiceStats } from '../../app/utils/types'

const read = (f: string) => readFileSync(join(import.meta.dirname, '../../app', f), 'utf8')
const S: ServiceStats = { users: 1234, teams: 56, answers: 7890, counted_at: '2026-11-26T00:00:00Z' }
function memoryStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe('loadServiceStats (24-hour cache)', () => {
  it('asks the server once, then serves the cached numbers for 24 hours', async () => {
    expect(STATS_TTL_MS).toBe(24 * 60 * 60 * 1000)
    const store = memoryStore(); const fetch = vi.fn(async () => S)
    expect(await loadServiceStats(fetch, store, 1000)).toEqual(S)
    expect(await loadServiceStats(fetch, store, 1000 + STATS_TTL_MS - 1)).toEqual(S)
    expect(fetch).toHaveBeenCalledTimes(1)
    await loadServiceStats(fetch, store, 1000 + STATS_TTL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a failed request falls back to older numbers, or hides them (null); never throws', async () => {
    const store = memoryStore()
    await loadServiceStats(async () => S, store, 0)
    expect(await loadServiceStats(async () => { throw new Error('network') }, store, STATS_TTL_MS * 3)).toEqual(S)
    expect(await loadServiceStats(async () => { throw new Error('network') }, memoryStore(), 0)).toBeNull()
    expect(await loadServiceStats(async () => null, memoryStore(), 0)).toBeNull()           // older database: hidden
  })

  it('broken or blocked storage does not break the page', async () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(await loadServiceStats(async () => S, broken, 0)).toEqual(S)
    const store = memoryStore(); store.m.set('service-stats:v1', '{"at":0,"stats":{"users":-1}}')
    const fetch = vi.fn(async () => S)
    expect(await loadServiceStats(fetch, store, 1)).toEqual(S)                                // invalid cache ignored
    expect(await loadServiceStats(async () => S, null, 0)).toEqual(S)
  })

  it('formats counts the Japanese way', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(0)).toBe('0')
  })
})

describe('demo repo', () => {
  it('gives the three counts', async () => {
    const s = await createMockRepo(() => 'u-coach', () => '').serviceStats()
    expect(s).toMatchObject({ users: MOCK_USERS.length })
    expect(s!.teams).toBeGreaterThan(0)
    expect(s!.answers).toBeGreaterThanOrEqual(0)
  })
})

describe('top page', () => {
  const landing = read('components/TopLanding.vue')
  const index = read('pages/index.vue')

  it('has the agreed sections, in order', () => {
    const order = ['使い方', 'ログイン', 'みんなの予定と出欠を、', 'スポーツ少年団・サークル・', '無料で始める', '利用状況', '主な機能', 'はじめ方', '<LegalFooter />']
    const tpl = landing.slice(landing.indexOf('<template>'))
    let last = -1
    for (const s of order) { const i = tpl.indexOf(s, last + 1); expect(i, s).toBeGreaterThan(last); last = i }
    for (const l of ['登録ユーザー', '利用チーム', '出欠の回答']) expect(landing).toContain(l)
    expect(landing).not.toMatch(/いま記録されている回答の数|時間ごとに更新/)            // no note under the numbers
  })

  it('keeps the existing login, invitation and in-app-browser handling', () => {
    expect(index).toContain('signInWithGoogle(loginTarget(redirect, intent))')
    expect(index).toContain('<TopLanding v-else')
    expect(index).toContain('@login="google"')
    expect(landing).toContain("家族から招待されています")
    expect(landing).toContain('ブラウザで開いてください')
    expect(landing).toContain("@click=\"start('create')\"")
  })

  it('shows no e-mail address, no ad, and reads only the public counts', () => {
    expect(landing).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}|mailto:|PRIVACY_EMAIL|adsbygoogle|広告/)
    expect(landing).toContain('useRepo().serviceStats()')
    expect(landing).not.toMatch(/myTeams|loadTeam|listMembers/)
  })
})
