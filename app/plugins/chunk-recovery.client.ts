// When a build file fails to load while the app STARTS (Nuxt's own nuxt:chunk-reload covers later page
// changes only), reload the page once so the browser fetches the current index.html and its files.
// reloadNuxtApp remembers the path in sessionStorage: no second reload of the same URL within a minute,
// so a lasting failure shows the error page instead of reloading forever.
import { isChunkLoadError } from '~/utils/chunkError'

export default defineNuxtPlugin({
  name: 'chunk-recovery',
  enforce: 'pre',
  setup(nuxtApp) {
    nuxtApp.hook('app:error', (error) => {
      if (!isChunkLoadError(error)) return
      const { pathname, search, hash } = window.location
      reloadNuxtApp({ path: pathname + search + hash, ttl: 60_000 })
    })
  },
})
