/**
 * Links to the legal pages are shown only when they are in this build AND they are final —
 * or this is the dev server (draft preview). A production build never links to drafts, and a
 * build without them (public export --without-legal-drafts) has no link to them at all.
 */
export function legalLinksVisible(o: { final: boolean; dev: boolean; pagesPresent: boolean }): boolean {
  return o.pagesPresent && (o.final || o.dev)
}

export interface LegalNavItem { to: string; label: string; icon: 'terms' | 'privacy' | 'contact' }
