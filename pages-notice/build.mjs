// Builds the notice page for the OLD address (GitHub Pages) from index.template.html.
//   node pages-notice/build.mjs <new https URL> <output folder>
// Refuses anything but a plain https URL (no credentials, query, fragment, quotes or spaces), so the placeholder can never
// be published and nothing can be injected into the page. Writes index.html and 404.html (the same page for every old
// path) and .nojekyll. The old path / tokens are NOT carried over (old share links no longer join anyone).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function checkNewUrl(raw) {
  const s = String(raw ?? '').trim()
  let u
  try { u = new URL(s) } catch { throw new Error('the new URL is not a valid URL') }
  if (u.protocol !== 'https:') throw new Error('the new URL must start with https://')
  if (u.username || u.password || u.search || u.hash) throw new Error('the new URL must not contain credentials, a query or a fragment')
  if (/__NEW_URL__/i.test(s) || /(^|\.)example\.(com|org|net)$|\.invalid$|^localhost$|^127\.|\.github\.io$/i.test(u.hostname)) {
    throw new Error('the new URL is still a placeholder / example / local / the old address')
  }
  if (!/^[a-z0-9.-]+$/i.test(u.hostname) || /["'<>\s`]/.test(s)) throw new Error('the new URL contains characters that are not allowed')
  return u.href
}

export function renderNotice(template, newUrl) {
  const url = checkNewUrl(newUrl)
  if (!template.includes('__NEW_URL__')) throw new Error('template has no __NEW_URL__ placeholder')
  const out = template.split('__NEW_URL__').join(url)
  if (out.includes('__NEW_URL__')) throw new Error('placeholder left')
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [newUrl, outDir] = process.argv.slice(2)
    if (!outDir) throw new Error('usage: node pages-notice/build.mjs <new https URL> <output folder>')
    const html = renderNotice(readFileSync(new URL('./index.template.html', import.meta.url), 'utf8'), newUrl)
    mkdirSync(outDir, { recursive: true })
    for (const f of ['index.html', '404.html']) writeFileSync(join(outDir, f), html)
    writeFileSync(join(outDir, '.nojekyll'), '')
    console.log(`notice page built for ${checkNewUrl(newUrl)} -> ${outDir}`)
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
}
