// Picks the server-side secret key from the environment Supabase injects into Edge Functions.
// New-style projects: SUPABASE_SECRET_KEYS = JSON object of named secret keys ({"default": "sb_secret_..."}).
// Legacy projects: SUPABASE_SERVICE_ROLE_KEY. The key never leaves the function.
export function pickSecretKey(get: (name: string) => string | undefined): string | null {
  const raw = get('SUPABASE_SECRET_KEYS')
  if (raw) {
    try {
      const keys = JSON.parse(raw) as unknown
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        const k = (keys as Record<string, unknown>).default
        if (typeof k === 'string' && k) return k
      }
    } catch { /* malformed: fall back */ }
  }
  const legacy = get('SUPABASE_SERVICE_ROLE_KEY')
  return legacy ? legacy : null
}
