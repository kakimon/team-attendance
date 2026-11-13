import type { PrerenderRoute } from 'nitropack'
import tailwindcss from '@tailwindcss/vite'

// Legal / contact pages are pre-generated only if they are in this tree
// (a public export made with --without-legal-drafts leaves them out). Filled by 'pages:extend'.
const LEGAL_PATHS = ['/terms', '/privacy', '/contact']
const legalRoutes = new Set<string>()

// SPA (static hosting friendly). Supabase values come from env vars only:
//   NUXT_PUBLIC_SUPABASE_URL, NUXT_PUBLIC_SUPABASE_ANON_KEY
// When they are empty the app runs in mock mode (in-memory demo data).
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  srcDir: 'app/',
  ssr: false,
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  components: [{ path: '~/components', pathPrefix: false }],
  vite: { plugins: [tailwindcss()] },
  app: {
    head: {
      htmlAttrs: { lang: 'ja' },
      title: 'みんなの出欠',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'robots', content: 'noindex' },
        { name: 'theme-color', content: '#4f5bf0' },
        // GitHub Pages cannot set HTTP headers: keep invite/team tokens in URLs out of Referer.
        // (In built HTML it is also inserted first in <head> by the nitro hook below.)
        { name: 'referrer', content: 'no-referrer' },
        // Same static preview for every page: never includes team names or tokens.
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'みんなの出欠' },
        { property: 'og:title', content: 'みんなの出欠' },
        { name: 'description', content: 'チーム・クラブ・教室の出欠をかんたんに共有。保護者は自分の子の出欠だけを入力できます。' },
        { property: 'og:description', content: 'チーム・クラブ・教室の出欠をかんたんに共有。保護者は自分の子の出欠だけを入力できます。' },
        { name: 'twitter:card', content: 'summary' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      supabaseUrl: '',
      supabaseAnonKey: '',
      // Only honored by `nuxt dev`. Production builds ignore it.
      demoMode: '',
    },
  },
  typescript: { strict: true },
  hooks: {
    'pages:extend'(pages) {
      for (const p of pages) if (LEGAL_PATHS.includes(p.path)) legalRoutes.add(p.path)
    },
    // Nuxt emits its CSS/JS <link>s before app.head metas, so the first asset requests would
    // still send a Referer (with tokens in the URL). Put the policy right after <meta charset>.
    'nitro:init'(nitro) {
      nitro.hooks.hook('prerender:routes', (routes: Set<string>) => {
        for (const r of legalRoutes) routes.add(r)
      })
      nitro.hooks.hook('prerender:generate', (route: PrerenderRoute) => {
        if (typeof route.contents === 'string' && route.fileName?.endsWith('.html')) {
          route.contents = route.contents.replace(/<meta charset="utf-8">/i,
            '<meta charset="utf-8"><meta name="referrer" content="no-referrer">')
        }
      })
    },
  },
  nitro: {
    prerender: {
      // Not pre-generated on purpose: on GitHub Pages a pre-generated directory
      // (/auth/callback/) would trigger a trailing-slash redirect. Leaving it to the
      // SPA fallback (404.html) keeps the OAuth ?code= query untouched.
      ignore: ['/auth/callback'],
      // Relay page for shared links: must exist as a real file (HTTP 200 on GitHub Pages).
      // Legal / contact pages (when present): readable without login, real files so direct access works.
      routes: ['/j'], // + legal pages that exist (added in the 'prerender:routes' hook below)
    },
  },
})
