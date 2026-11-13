// Self-service account deletion (method B: official Admin API).
// The pure request handler lives here so it can be unit-tested with fakes (handler_test.ts).
//
// Security model
// - The caller is identified ONLY from the access token, verified by the Auth server.
//   The request body may contain nothing but the typed confirmation; any other field
//   (for example a user id) is refused.
// - The service-role key exists only in the Edge Function runtime (index.ts reads it
//   from the environment Supabase injects). It never reaches the browser or the repository.
// - Re-authentication and "only a live session" are checked in the database by
//   purge_account_data (auth.sessions.created_at within 10 minutes for the first run).
//
// Steps and failure handling
//   1. purge_account_data   one DB transaction; on error nothing changes
//   2. auth.admin.deleteUser  official API; on error the user has no app data left and
//      can call this function again (the DB step is idempotent and skips the
//      recent-login rule once the data is gone).

export const CONFIRM_TEXT = '退会する'
const KNOWN_DB_ERRORS = ['owner_must_transfer', 'reauth_required', 'user_required'] as const

export interface Deps {
  allowedOrigins: string[]
  /** Verifies the token with the Auth server. */
  getUser(token: string): Promise<{ id: string } | null>
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>
  /** auth.admin.deleteUser; `notFound` when the user is already gone. */
  deleteUser(userId: string): Promise<{ ok: true } | { ok: false; notFound: boolean; message: string }>
}

function claimsOf(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1] ?? ''
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export function createHandler(deps: Deps) {
  const cors = (origin: string): Record<string, string> =>
    deps.allowedOrigins.includes(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : { Vary: 'Origin' }

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin') ?? ''
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })

    // Browsers always send Origin on this cross-origin call; refuse unknown sites outright.
    if (origin && !deps.allowedOrigins.includes(origin)) return json(403, { code: 'origin_not_allowed' })
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    if (req.method !== 'POST') return json(405, { code: 'method_not_allowed' })

    // 1) Who is calling: only from the verified token.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!token) return json(401, { code: 'not_authenticated' })
    const user = await deps.getUser(token).catch(() => null)
    const claims = claimsOf(token)
    if (!user || !claims || claims.sub !== user.id) return json(401, { code: 'not_authenticated' })
    const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null

    // 2) The body carries only the typed confirmation (never a user id).
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { code: 'confirm_required' })
    if (Object.keys(body).some((k) => k !== 'confirm')) return json(400, { code: 'unexpected_field' })
    if ((body as { confirm?: unknown }).confirm !== CONFIRM_TEXT) return json(400, { code: 'confirm_required' })

    // 3) App data: one transaction (re-auth, owner hand-over and locking checked inside).
    const purge = await deps.rpc('purge_account_data', { p_user: user.id, p_session: sessionId })
    if (purge.error) {
      const code = KNOWN_DB_ERRORS.find((c) => purge.error!.message.includes(c))
      return code ? json(409, { code }) : json(500, { code: 'purge_failed', retry: true })
    }
    const summary = purge.data as { status?: string } | null
    if (summary?.status === 'already_deleted') return json(200, { status: 'deleted' })

    // 4) Auth user: official Admin API (also removes sessions, so refresh tokens stop working).
    const del = await deps.deleteUser(user.id)
    if (!del.ok && !del.notFound) {
      await deps.rpc('note_account_deletion_failure', { p_user: user.id, p_error: del.message }).catch(() => {})
      return json(503, { code: 'auth_delete_failed', retry: true })
    }
    return json(200, { status: 'deleted', summary })
  }
}
