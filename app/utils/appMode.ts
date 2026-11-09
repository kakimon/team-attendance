export type AppMode = 'supabase' | 'demo' | 'misconfigured'

/**
 * Decides how the app talks to data.
 * - 'demo' needs BOTH a dev server (`nuxt dev`) AND NUXT_PUBLIC_DEMO_MODE=true.
 *   A production build can never run in demo mode.
 * - 'supabase' needs URL and anon key.
 * - otherwise 'misconfigured' (the app shows a setup error, never demo data).
 */
export function resolveAppMode(o: {
  isDev: boolean
  demoFlag: unknown
  supabaseUrl: unknown
  supabaseAnonKey: unknown
}): AppMode {
  if (o.isDev && String(o.demoFlag) === 'true') return 'demo'
  if (typeof o.supabaseUrl === 'string' && o.supabaseUrl && typeof o.supabaseAnonKey === 'string' && o.supabaseAnonKey) {
    return 'supabase'
  }
  return 'misconfigured'
}
