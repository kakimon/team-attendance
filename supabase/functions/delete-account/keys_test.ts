import { pickSecretKey } from './keys.ts'
const env = (o: Record<string, string>) => (n: string) => o[n]
function eq(a: unknown, b: unknown) { if (a !== b) throw new Error(`expected ${b}, got ${a}`) }

Deno.test('new-style SUPABASE_SECRET_KEYS (JSON, "default") is preferred', () => {
  eq(pickSecretKey(env({ SUPABASE_SECRET_KEYS: '{"default":"new-key","other":"x"}', SUPABASE_SERVICE_ROLE_KEY: 'legacy' })), 'new-key')
})
Deno.test('falls back to the legacy key when the JSON is missing, malformed or has no default', () => {
  for (const raw of [undefined, 'not json', '[]', '{"other":"x"}', '{"default":""}', '{"default":1}']) {
    eq(pickSecretKey(env({ ...(raw === undefined ? {} : { SUPABASE_SECRET_KEYS: raw }), SUPABASE_SERVICE_ROLE_KEY: 'legacy' })), 'legacy')
  }
})
Deno.test('no key at all -> null (the function refuses to start)', () => {
  eq(pickSecretKey(env({})), null)
})
