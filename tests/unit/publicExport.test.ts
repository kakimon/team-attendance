// What must hold in BOTH the development repo and a public export made without the legal drafts.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legalLinksVisible } from '../../app/utils/legalLinks'
import { CONTACT_FORM_URL, OPERATOR_NAME, PRIVACY_EMAIL } from '../../app/utils/operator'
import { isPublicPath } from '../../app/utils/publicPaths'

const repo = join(import.meta.dirname, '../..')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(vue|ts)$/.test(n) ? [p] : []
  })
}
// The same list scripts/export-public.sh uses (that script is internal; the list may be absent in an export).
const listFile = join(repo, 'scripts/legal-drafts.txt')
const DRAFTS = existsSync(listFile)
  ? readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : ['app/pages/terms.vue', 'app/pages/privacy.vue', 'app/pages/contact.vue', 'app/components/legal', 'app/legal', 'tests/unit/legal.test.ts']
const isDraft = (rel: string) => DRAFTS.some((d) => rel === d || rel.startsWith(d + '/'))

describe('legal links', () => {
  it('only when the pages are in the build AND (final OR dev server)', () => {
    expect(legalLinksVisible({ final: false, dev: false, pagesPresent: true })).toBe(false) // production with drafts
    expect(legalLinksVisible({ final: false, dev: true, pagesPresent: true })).toBe(true)   // draft preview
    expect(legalLinksVisible({ final: true, dev: false, pagesPresent: true })).toBe(true)
    for (const final of [true, false]) for (const dev of [true, false]) {
      expect(legalLinksVisible({ final, dev, pagesPresent: false })).toBe(false)            // export without drafts
    }
  })

  it('nothing outside the draft files refers to the draft pages or their components', () => {
    const offenders: string[] = []
    for (const f of [...walk(join(repo, 'app')), ...walk(join(repo, 'tests'))]) {
      const rel = relative(repo, f)
      if (isDraft(rel) || rel === 'tests/unit/publicExport.test.ts') continue
      const src = readFileSync(f, 'utf8')
        .replace("import.meta.glob<{ LEGAL_NAV: readonly LegalNavItem[] }>('../legal/nav.ts'", '') // optional load (allowed)
      if (/['"`]\/(terms|privacy|contact)\b|components\/legal|\blegal\/nav\b|<(LegalPage|LegalSection|PendingItem)\b|_DRAFT\.md/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})

describe('public pages and operator details', () => {
  it('login-free paths do not include the legal pages (they declare it themselves)', () => {
    for (const p of ['/', '/auth/callback', '/j', '/account/deleted']) expect(isPublicPath(p)).toBe(true)
    for (const p of ['/terms', '/privacy', '/contact', '/t/abc', '/invite/x', '/teams/new', '/account', '/account/delete']) expect(isPublicPath(p)).toBe(false)
  })

  it('operator constants are the confirmed ones', () => {
    expect(OPERATOR_NAME).toBe('Imagimo（イマジモ）')
    expect(CONTACT_FORM_URL).toMatch(/^https:\/\/forms\.gle\/[A-Za-z0-9]+$/)
    expect(PRIVACY_EMAIL).toMatch(/^[a-z0-9.]+@gmail\.com$/)
  })

  it('the only e-mail address anywhere in the app is the operator contact address', () => {
    const found = new Set<string>()
    for (const f of walk(join(repo, 'app'))) for (const m of readFileSync(f, 'utf8').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)) found.add(m[0])
    expect([...found]).toEqual([PRIVACY_EMAIL])
  })
})
