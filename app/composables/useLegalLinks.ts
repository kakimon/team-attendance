import { legalLinksVisible, type LegalNavItem } from '~/utils/legalLinks'

// Optional module: an empty object when app/legal/ is not in the build (public export without drafts).
const found = import.meta.glob<{ LEGAL_NAV: readonly LegalNavItem[] }>('../legal/nav.ts', { eager: true })
const NAV: readonly LegalNavItem[] = Object.values(found)[0]?.LEGAL_NAV ?? []

/** Legal page links to show (empty = offer only the external contact form). */
export function useLegalLinks(): readonly LegalNavItem[] {
  return legalLinksVisible({ final: LEGAL_DOCS_FINAL, dev: !!import.meta.dev, pagesPresent: NAV.length > 0 }) ? NAV : []
}
