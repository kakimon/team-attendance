import type { User } from '@supabase/supabase-js'
import type { DemoUser } from '~/plugins/data.client'

/** Login state: Supabase Google OAuth, or demo users in demo mode. */
export function useAuth() {
  const { $supabase, $appMode, $demoUsers } = useNuxtApp()
  const user = useState<DemoUser | null>('auth:user', () => null)
  const ready = useState<boolean>('auth:ready', () => false)
  const isDemo = $appMode === 'demo'

  const toUser = (u: User): DemoUser => ({
    id: u.id,
    email: u.email ?? null,
    name: (u.user_metadata?.full_name as string) || (u.user_metadata?.name as string) || '',
  })

  async function init() {
    if (ready.value) return
    if ($supabase) {
      // Also completes the PKCE code exchange when returning from Google.
      const { data } = await $supabase.auth.getSession()
      user.value = data.session ? toUser(data.session.user) : null
      $supabase.auth.onAuthStateChange((_e, session) => {
        user.value = session ? toUser(session.user) : null
      })
    } else if (isDemo) {
      const saved = localStorage.getItem('demo:user')
      user.value = $demoUsers.find((u) => u.id === saved) ?? null
    }
    ready.value = true
  }

  async function signInWithGoogle(redirectPath: string) {
    if (!$supabase) throw new Error('Supabase is not configured')
    sessionStorage.setItem('auth:redirect', redirectPath)
    const base = useRuntimeConfig().app.baseURL.replace(/\/$/, '')
    const { error } = await $supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}${base}/auth/callback` },
    })
    if (error) throw error
  }

  function signInDemo(id: string) {
    user.value = $demoUsers.find((u) => u.id === id) ?? null
    localStorage.setItem('demo:user', id)
    localStorage.setItem('demo:loginAt', String(Date.now()))
  }

  /**
   * Fresh Google login for sensitive steps (account deletion). Creates a new Supabase session,
   * whose creation time the server checks. Returns to `returnPath` via /auth/callback.
   */
  async function reauthenticate(returnPath: string) {
    if (!$supabase) {
      localStorage.setItem('demo:loginAt', String(Date.now())) // demo: counts as a fresh login, stay on the page
      return
    }
    sessionStorage.setItem('auth:redirect', returnPath)
    const base = useRuntimeConfig().app.baseURL.replace(/\/$/, '')
    const { error } = await $supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}${base}/auth/callback`, queryParams: { prompt: 'select_account' } },
    })
    if (error) throw error
  }

  /** `local`: only forget this device's session (used after the account was deleted on the server). */
  async function signOut(scope: 'global' | 'local' = 'global') {
    if ($supabase) await $supabase.auth.signOut({ scope }).catch(() => {})
    else localStorage.removeItem('demo:user')
    user.value = null
  }

  return { user, ready, isDemo, init, signInWithGoogle, signInDemo, reauthenticate, signOut }
}
