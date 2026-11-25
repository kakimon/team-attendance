// Cloudflare Worker that runs ONLY for /_nuxt/* (wrangler.jsonc: assets.run_worker_first). Every other URL is
// answered by Workers static assets directly (SPA fallback to /index.html), so no billable code runs for them.
//
// Why: with not_found_handling = "single-page-application", a missing /_nuxt/<hash>.js (an old or not yet
// propagated build file) is answered with index.html and HTTP 200. The browser then fails to load the module
// ("MIME type text/html") and, because /_nuxt/* is cached for a year (immutable), keeps that broken answer.
//
// Here: an existing build file is returned as is, with the year-long immutable cache (its name contains a hash).
// Anything else under /_nuxt/ (the HTML fallback, or any non-success) becomes a plain 404 that is never cached,
// so a later request (after the next deploy has fully propagated, or after a reload) can succeed.
// builds/latest.json names the current build and changes on every deploy (the other files never change).
const IMMUTABLE = 'public, max-age=31536000, immutable'
const LATEST = /\/_nuxt\/builds\/latest\.json$/

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request)
    const type = res.headers.get('content-type') ?? ''
    if (res.ok && !type.includes('text/html')) {
      const out = new Response(res.body, res)
      out.headers.set('Cache-Control', LATEST.test(new URL(request.url).pathname) ? 'no-cache' : IMMUTABLE)
      out.headers.set('X-Content-Type-Options', 'nosniff')
      return out
    }
    if (res.status === 304) return res
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  },
}
