// '/j' = relay page for shared links (it forwards to a protected page, which then asks for login)
const PUBLIC = new Set(['/', '/auth/callback', '/j'])

export default defineNuxtRouteMiddleware(async (to) => {
  const { $appMode } = useNuxtApp()
  if ($appMode === 'misconfigured') return // app.vue shows the setup error
  const auth = useAuth()
  await auth.init()
  if (PUBLIC.has(to.path.replace(/\/+$/, '') || '/')) return
  if (!auth.user.value) {
    return navigateTo({ path: '/', query: { redirect: to.fullPath } })
  }
})
