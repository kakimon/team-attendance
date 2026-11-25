// Cloudflare Workers static-asset publishing: the config must keep the app a static SPA (a Worker runs only for
// /_nuxt/*), serve app URLs (direct access / reload) from index.html, and send the minimum security / cache headers.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = join(import.meta.dirname, '../..')
const jsonc = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, ''))
const cfg = jsonc(readFileSync(join(repo, 'wrangler.jsonc'), 'utf8'))
const headers = readFileSync(join(repo, 'app/public/_headers'), 'utf8')
const rules = (() => {
  const out: Record<string, string[]> = {}
  let cur = ''
  for (const line of headers.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) { cur = line.trim(); out[cur] = []; continue }
    out[cur]!.push(line.trim())
  }
  return out
})()

describe('wrangler.jsonc (Workers static assets)', () => {
  it('static assets with SPA fallback; the Worker runs first only for the hashed build files (/_nuxt/*)', () => {
    expect(cfg.main).toBe('./cloudflare/assets-worker.js')
    expect(cfg.assets).toEqual({ directory: './.output/public', binding: 'ASSETS', not_found_handling: 'single-page-application',
      html_handling: 'auto-trailing-slash', run_worker_first: ['/_nuxt/*'] })
    expect(Object.keys(cfg).filter((k) => /vars|kv|d1|r2|durable|services|routes|secrets/i.test(k))).toEqual([])
    expect(cfg.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(cfg.preview_urls).toBe(false)
  })

  it('the app stays a static SPA served from the domain root', () => {
    const nuxt = readFileSync(join(repo, 'nuxt.config.ts'), 'utf8')
    expect(nuxt).toMatch(/ssr: false/)
    expect(nuxt).not.toMatch(/baseURL\s*:/)                       // base URL comes only from NUXT_APP_BASE_URL (unset = "/")
    expect(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.generate).toBe('nuxt generate')
  })
})

describe('app/public/_headers', () => {
  it('every response: no referrer (tokens in URLs), no framing, no sniffing, no device permissions', () => {
    expect(rules['/*']).toEqual(expect.arrayContaining([
      'Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY',
      "Content-Security-Policy: frame-ancestors 'none'",
    ]))
    expect(rules['/*']!.some((h) => h.startsWith('Permissions-Policy:'))).toBe(true)
  })

  it('only the hashed build files are cached long; HTML is not (left to the default revalidation)', () => {
    expect(rules['/_nuxt/*']).toEqual(['Cache-Control: public, max-age=31536000, immutable'])
    expect(Object.entries(rules).filter(([p, hs]) => p !== '/_nuxt/*' && hs.some((h) => /cache-control/i.test(h)))).toEqual([])
  })

  it('.assetsignore keeps GitHub Pages-only files from being served', () => {
    expect(readFileSync(join(repo, 'app/public/.assetsignore'), 'utf8').split('\n').map((l) => l.trim())).toContain('.nojekyll')
  })
})

describe('cloudflare/assets-worker.js (only /_nuxt/*)', () => {
  type Init = { status?: number; type?: string; body?: string; headers?: Record<string, string> }
  const assets = (init: Init) => ({
    fetch: async () => new Response(init.status === 304 ? null : (init.body ?? 'x'), { status: init.status ?? 200,
      headers: { ...(init.type ? { 'content-type': init.type } : {}), ...(init.headers ?? {}) } }),
  })
  const run = async (init: Init, path = '/_nuxt/Abc12345.js') => {
    // @ts-expect-error plain ESM module without type declarations
    const worker = (await import('../../cloudflare/assets-worker.js')).default
    return worker.fetch(new Request('https://example.test' + path), { ASSETS: assets(init) }) as Promise<Response>
  }

  it('an existing JS / CSS file is served unchanged, cached for a year (immutable), nosniff', async () => {
    for (const type of ['text/javascript', 'application/javascript; charset=utf-8', 'text/css; charset=utf-8']) {
      const r = await run({ type, body: 'export {}' })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe(type)
      expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await r.text()).toBe('export {}')
    }
  })

  it('builds/latest.json (changes on every deploy) is revalidated, not cached for a year', async () => {
    const r = await run({ type: 'application/json', body: '{}' }, '/_nuxt/builds/latest.json')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect((await run({ type: 'application/json', body: '{}' }, '/_nuxt/builds/meta/abc.json')).headers.get('cache-control')).toMatch(/immutable/)
  })

  it('a missing file (the SPA fallback answers index.html with 200) becomes a 404 that is never cached', async () => {
    const r = await run({ type: 'text/html; charset=utf-8', body: '<!doctype html>', headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).not.toMatch(/html/)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.text()).not.toMatch(/<html|doctype/i)
  })

  it('any other non-success answer is also a non-cached 404; a 304 revalidation passes through', async () => {
    for (const status of [404, 500, 503]) {
      const r = await run({ status, type: 'text/plain' })
      expect(r.status).toBe(404)
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    const nm = await run({ status: 304 })
    expect(nm.status).toBe(304)
  })
})
