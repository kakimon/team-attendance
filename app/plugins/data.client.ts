import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseRepo, type DbClient } from '~/repo/supabaseRepo'
import { resolveAppMode, type AppMode } from '~/utils/appMode'
import type { Repo } from '~/utils/types'

export interface DemoUser { id: string; email: string | null; name: string }

/**
 * Builds the data layer once. Keys come only from env vars
 * (NUXT_PUBLIC_SUPABASE_URL / NUXT_PUBLIC_SUPABASE_ANON_KEY).
 */
export default defineNuxtPlugin(async () => {
  const cfg = useRuntimeConfig().public
  const mode: AppMode = resolveAppMode({
    isDev: !!import.meta.dev,
    demoFlag: cfg.demoMode,
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey,
  })

  const currentUser = useState<DemoUser | null>('auth:user', () => null)
  const uid = () => {
    if (!currentUser.value) throw new Error('not_authenticated')
    return currentUser.value.id
  }

  let supabase: SupabaseClient | null = null
  let repo: Repo | null = null
  let demoUsers: DemoUser[] = []

  if (mode === 'supabase') {
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
    repo = createSupabaseRepo(supabase as unknown as DbClient, uid)
  } else if (import.meta.dev && mode === 'demo') {
    // Dynamic import inside an import.meta.dev branch: not shipped in production builds.
    const m = await import('~/repo/mockRepo')
    repo = m.createMockRepo(uid, () => currentUser.value?.name ?? '')
    demoUsers = m.MOCK_USERS
  }

  return { provide: { appMode: mode, supabase, repo, demoUsers } }
})
