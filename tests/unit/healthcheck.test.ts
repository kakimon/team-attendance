import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain .mjs script without types
import { run } from '../../scripts/healthcheck.mjs'

const URL = 'https://example.supabase.co'
const KEY = 'sb_publishable_test'
const res = (status: number, body: unknown) =>
  Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))

describe('scripts/healthcheck.mjs', () => {
  it('passes on ok + database', async () => {
    const f = vi.fn(() => res(200, { ok: true, database: true, checkedAt: '2026-11-09T00:00:00Z' }))
    const r = await run({ url: URL, key: KEY, fetchImpl: f, retryDelayMs: 0 })
    expect(r.ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe(`${URL}/rest/v1/rpc/health_check`)
    expect(init.method).toBe('POST')
  })

  it('fails without retry when the function is missing (404 = migration not applied)', async () => {
    const f = vi.fn(() => res(404, { code: 'PGRST202', message: 'Could not find the function public.health_check' }))
    const r = await run({ url: URL, key: KEY, fetchImpl: f, retryDelayMs: 0 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('health_check')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('fails when the schema check is false', async () => {
    const f = vi.fn(() => res(200, { ok: true, database: false }))
    expect((await run({ url: URL, key: KEY, fetchImpl: f, retryDelayMs: 0 })).ok).toBe(false)
  })

  it('retries once on 5xx / network error, never more than 2 requests', async () => {
    const f = vi.fn()
      .mockImplementationOnce(() => res(503, 'paused'))
      .mockImplementationOnce(() => res(200, { ok: true, database: true }))
    expect((await run({ url: URL, key: KEY, fetchImpl: f, retryDelayMs: 0 })).ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)

    const g = vi.fn(() => Promise.reject(new Error('ECONNRESET')))
    const r = await run({ url: URL, key: KEY, fetchImpl: g, retryDelayMs: 0 })
    expect(r.ok).toBe(false)
    expect(g).toHaveBeenCalledTimes(2)
  })

  it('refuses secret keys and missing config without calling the network', async () => {
    const f = vi.fn()
    expect((await run({ url: URL, key: 'sb_secret_xxx', fetchImpl: f })).ok).toBe(false)
    expect((await run({ url: '', key: KEY, fetchImpl: f })).ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
})
