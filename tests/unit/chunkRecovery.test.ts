// A failed build-file load at app start reloads the page at most once per URL and minute (no reload loop).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isChunkLoadError } from '../../app/utils/chunkError'

describe('isChunkLoadError', () => {
  it('recognises the browsers\' messages for a build file that failed to load', () => {
    for (const m of [
      'Failed to fetch dynamically imported module: https://example.test/_nuxt/mQquoI93.js',   // Chrome
      'Importing a module script failed.',                                                     // Safari
      'error loading dynamically imported module: https://example.test/_nuxt/x.js',            // Firefox
      'Unable to preload CSS for /_nuxt/entry.css',                                            // Vite preload
    ]) {
      expect(isChunkLoadError(new TypeError(m)), m).toBe(true)
      expect(isChunkLoadError(m), m).toBe(true)
    }
  })

  it('ignores every other error (no reload for app or network errors)', () => {
    for (const e of [new Error('session_expired'), new Error('invitation_invalid'), new TypeError('Failed to fetch'), null, undefined, 42, {}]) {
      expect(isChunkLoadError(e)).toBe(false)
    }
  })

  it('the plugin reloads through reloadNuxtApp with a one-minute guard and keeps the full URL (query, hash)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../app/plugins/chunk-recovery.client.ts'), 'utf8')
    expect(src).toMatch(/hook\('app:error'/)
    expect(src).toMatch(/reloadNuxtApp\(\{ path: pathname \+ search \+ hash, ttl: 60_000 \}\)/)
    expect(src).not.toMatch(/location\.reload\(|force:\s*true/)
  })
})
