// Edge Function entry point: wires the handler to Supabase (local or cloud).
// SUPABASE_URL and the secret key are injected by the Supabase runtime (never sent to browsers):
// the new-style SUPABASE_SECRET_KEYS (JSON, key "default") is preferred; the legacy
// SUPABASE_SERVICE_ROLE_KEY is the fallback.
// ALLOWED_ORIGINS (comma separated) can override the default public origin, e.g. for local dev.
import { createClient } from 'npm:@supabase/supabase-js@2.109.0'
import { createHandler } from './handler.ts'
import { pickSecretKey } from './keys.ts'

const DEFAULT_ORIGINS = ['https://kakimon.github.io']

const url = Deno.env.get('SUPABASE_URL')
const serviceKey = pickSecretKey((n) => Deno.env.get(n))
if (!url || !serviceKey) throw new Error('SUPABASE_URL / secret key are not set')

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)

Deno.serve(createHandler({
  allowedOrigins: allowedOrigins.length ? allowedOrigins : DEFAULT_ORIGINS,
  async getUser(token) {
    const { data, error } = await admin.auth.getUser(token)
    return error || !data.user ? null : { id: data.user.id }
  },
  async rpc(fn, args) {
    const { data, error } = await admin.rpc(fn, args)
    return { data, error: error ? { message: error.message } : null }
  },
  async deleteUser(userId) {
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (!error) return { ok: true }
    return { ok: false, notFound: error.status === 404, message: `${error.status ?? ''} ${error.code ?? ''}`.trim() }
  },
}))
