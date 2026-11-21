// Cloudflare Workers static-asset publishing: the config must keep the app a static SPA with no Worker script,
// serve app URLs (direct access / reload) from index.html, and send the minimum security / cache headers.
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
  it('static assets only: the Nuxt generate output, no Worker script, SPA fallback', () => {
    expect(cfg.main).toBeUndefined()
    expect(cfg.assets).toEqual({ directory: './.output/public', not_found_handling: 'single-page-application', html_handling: 'auto-trailing-slash' })
    expect(cfg.assets.binding).toBeUndefined()
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
