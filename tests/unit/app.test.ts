import { describe, expect, it } from 'vitest'
import { resolveAppMode } from '../../app/utils/appMode'
import { detectInAppBrowser, externalBrowserUrl } from '../../app/utils/inAppBrowser'
import { safeRedirect } from '../../app/utils/safeRedirect'

describe('resolveAppMode: demo can never turn on in a production build', () => {
  const url = 'http://127.0.0.1:54321'
  const key = 'anon'
  it.each([
    [{ isDev: false, demoFlag: 'true', supabaseUrl: url, supabaseAnonKey: key }, 'supabase'],
    [{ isDev: false, demoFlag: 'true', supabaseUrl: '', supabaseAnonKey: '' }, 'misconfigured'],
    [{ isDev: false, demoFlag: '', supabaseUrl: '', supabaseAnonKey: '' }, 'misconfigured'],
    [{ isDev: false, demoFlag: '', supabaseUrl: url, supabaseAnonKey: '' }, 'misconfigured'],
    [{ isDev: true, demoFlag: '', supabaseUrl: '', supabaseAnonKey: '' }, 'misconfigured'],
    [{ isDev: true, demoFlag: 'true', supabaseUrl: '', supabaseAnonKey: '' }, 'demo'],
    [{ isDev: true, demoFlag: '1', supabaseUrl: url, supabaseAnonKey: key }, 'supabase'],
  ])('%j -> %s', (input, expected) => {
    expect(resolveAppMode(input)).toBe(expected)
  })
})

describe('safeRedirect', () => {
  it.each([
    ['/t/abc', '/t/abc'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    [undefined, '/'],
  ])('%s -> %s', (v, expected) => expect(safeRedirect(v)).toBe(expected))
})

describe('in-app browser detection', () => {
  it('detects LINE and builds an external-browser URL', () => {
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) Mobile/15E148 Safari Line/14.0.0')).toBe('line')
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) Version/17.0 Mobile/15E148 Safari/604.1')).toBeNull()
    expect(externalBrowserUrl('https://x.example/t/abc?redirect=%2Fa'))
      .toBe('https://x.example/t/abc?redirect=%2Fa&openExternalBrowser=1')
  })
})
