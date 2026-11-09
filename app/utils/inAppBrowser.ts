/**
 * Google blocks OAuth inside in-app browsers (LINE, Instagram, ...).
 * LINE opens a URL in the external browser when it has ?openExternalBrowser=1.
 */
export function detectInAppBrowser(ua: string): 'line' | 'other' | null {
  if (/\bLine\//i.test(ua)) return 'line'
  if (/FBAN|FBAV|Instagram|MicroMessenger|; wv\)/i.test(ua)) return 'other'
  return null
}

export function externalBrowserUrl(href: string): string {
  const u = new URL(href)
  u.searchParams.set('openExternalBrowser', '1')
  return u.toString()
}
