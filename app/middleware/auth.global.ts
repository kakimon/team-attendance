export default defineNuxtRouteMiddleware(async (to) => {
  const { $appMode } = useNuxtApp()
  if ($appMode === 'misconfigured') return // app.vue shows the setup error
  const auth = useAuth()
  await auth.init()
  if (isPublicPath(to.path) || to.meta.public === true) return
  if (!auth.user.value) {
    return navigateTo({ path: '/', query: { redirect: to.fullPath } })
  }
})
