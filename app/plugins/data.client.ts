import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseRepo, type DbClient, type InvokeFn } from '~/repo/supabaseRepo'
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
    const client = supabase
    // Edge Functions: supabase-js adds the user's access token. Error bodies carry { code }.
    const invoke: InvokeFn = async (fn, body) => {
      const { error } = await client.functions.invoke(fn, { body })
      if (!error) return { error: null }
      const res = (error as { context?: unknown }).context
      const code = res instanceof Response
        ? await res.json().then((j: { code?: string }) => j?.code ?? 'unknown', () => 'unknown')
        : 'unknown'
      return { error: { code } }
    }
    repo = createSupabaseRepo(client as unknown as DbClient, uid, invoke)
  } else if (import.meta.dev && mode === 'demo') {
    // Dynamic import inside an import.meta.dev branch: not shipped in production builds.
    const m = await import('~/repo/mockRepo')
    repo = m.createMockRepo(uid, () => currentUser.value?.name ?? '', () => Number(localStorage.getItem('demo:loginAt') ?? 0))
    demoUsers = m.MOCK_USERS
  }

  return { provide: { appMode: mode, supabase, repo, demoUsers } }
})
