// Unit tests for the delete-account handler with fake Auth/DB (no network).
// Run: deno test supabase/functions/delete-account/
import { CONFIRM_TEXT, createHandler, type Deps } from './handler.ts'

function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`)
}
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SID = '33333333-3333-4333-8333-333333333333'
const ORIGIN = 'https://kakimon.github.io'

function setup(over: Partial<Deps> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const deleted: string[] = []
  const deps: Deps = {
    allowedOrigins: [ORIGIN],
    getUser: async () => ({ id: ME }),
    rpc: async (fn, args) => {
      calls.push({ fn, args })
      return { data: { status: 'purged' }, error: null }
    },
    deleteUser: async (id) => {
      deleted.push(id)
      return { ok: true }
    },
    ...over,
  }
  return { handler: createHandler(deps), calls, deleted }
}
const post = (body: unknown, token: string | null = jwt({ sub: ME, session_id: SID }), origin = ORIGIN) =>
  new Request('http://x/delete-account', {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

Deno.test('deletes: purge with ids from the token, then the Auth user', async () => {
  const { handler, calls, deleted } = setup()
  const r = await handler(post({ confirm: CONFIRM_TEXT }))
  eq(r.status, 200)
  eq((await r.json()).status, 'deleted')
  eq(calls, [{ fn: 'purge_account_data', args: { p_user: ME, p_session: SID } }])
  eq(deleted, [ME])
  eq(r.headers.get('Access-Control-Allow-Origin'), ORIGIN)
})

Deno.test('refuses a user id (or any other field) in the body', async () => {
  const { handler, calls } = setup()
  const r = await handler(post({ confirm: CONFIRM_TEXT, user_id: OTHER }))
  eq(r.status, 400)
  eq((await r.json()).code, 'unexpected_field')
  eq(calls.length, 0)
})

Deno.test('token sub must match the user the Auth server verified', async () => {
  const { handler, calls } = setup({ getUser: async () => ({ id: ME }) })
  const r = await handler(post({ confirm: CONFIRM_TEXT }, jwt({ sub: OTHER, session_id: SID })))
  eq(r.status, 401)
  eq(calls.length, 0)
})

Deno.test('no token / invalid token -> 401, nothing called', async () => {
  const a = setup()
  eq((await a.handler(post({ confirm: CONFIRM_TEXT }, null))).status, 401)
  const b = setup({ getUser: async () => null })
  eq((await b.handler(post({ confirm: CONFIRM_TEXT }))).status, 401)
  const c = setup({ getUser: () => Promise.reject(new Error('network')) })
  eq((await c.handler(post({ confirm: CONFIRM_TEXT }))).status, 401)
  eq([...a.calls, ...b.calls, ...c.calls].length, 0)
})

Deno.test('confirmation text is required', async () => {
  const { handler, calls } = setup()
  eq((await handler(post({ confirm: 'はい' }))).status, 400)
  eq((await handler(post([]))).status, 400)
  eq(calls.length, 0)
})

Deno.test('CORS: only the allowed origin; others refused without CORS headers', async () => {
  const { handler, calls } = setup()
  const pre = await handler(new Request('http://x', { method: 'OPTIONS', headers: { Origin: ORIGIN } }))
  eq(pre.status, 204)
  eq(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN)
  const bad = await handler(new Request('http://x', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }))
  eq(bad.status, 403)
  eq(bad.headers.get('Access-Control-Allow-Origin'), null)
  const badPost = await handler(post({ confirm: CONFIRM_TEXT }, undefined, 'https://kakimon.github.io.evil.example'))
  eq(badPost.status, 403)
  eq(calls.length, 0)
  eq((await handler(new Request('http://x', { method: 'GET', headers: { Origin: ORIGIN } }))).status, 405)
})

Deno.test('known DB refusals -> 409 with the code; Auth user untouched', async () => {
  for (const code of ['owner_must_transfer', 'reauth_required']) {
    const { handler, deleted } = setup({ rpc: async () => ({ data: null, error: { message: code } }) })
    const r = await handler(post({ confirm: CONFIRM_TEXT }))
    eq(r.status, 409)
    eq((await r.json()).code, code)
    eq(deleted.length, 0)
  }
  const { handler, deleted } = setup({ rpc: async () => ({ data: null, error: { message: 'boom' } }) })
  const r = await handler(post({ confirm: CONFIRM_TEXT }))
  eq(r.status, 500)
  eq(await r.json(), { code: 'purge_failed', retry: true })
  eq(deleted.length, 0)
})

Deno.test('Auth deletion fails -> 503 retry, failure noted; retry then succeeds', async () => {
  let fail = true
  const { handler, calls } = setup({
    deleteUser: async () => (fail ? { ok: false, notFound: false, message: '500 unexpected_failure' } : { ok: true }),
  })
  const r1 = await handler(post({ confirm: CONFIRM_TEXT }))
  eq(r1.status, 503)
  eq(await r1.json(), { code: 'auth_delete_failed', retry: true })
  eq(calls.map((c) => c.fn), ['purge_account_data', 'note_account_deletion_failure'])
  fail = false
  const r2 = await handler(post({ confirm: CONFIRM_TEXT }))
  eq(r2.status, 200)
})

Deno.test('noting the failure may itself fail: still 503 (no crash)', async () => {
  const { handler } = setup({
    rpc: async (fn) => (fn === 'purge_account_data' ? { data: { status: 'purged' }, error: null } : Promise.reject(new Error('db down'))),
    deleteUser: async () => ({ ok: false, notFound: false, message: '500' }),
  })
  eq((await handler(post({ confirm: CONFIRM_TEXT }))).status, 503)
})

Deno.test('double run: user already gone in Auth counts as deleted', async () => {
  const { handler } = setup({ deleteUser: async () => ({ ok: false, notFound: true, message: '404' }) })
  eq((await handler(post({ confirm: CONFIRM_TEXT }))).status, 200)
  const b = setup({ rpc: async () => ({ data: { status: 'already_deleted' }, error: null }) })
  const r = await b.handler(post({ confirm: CONFIRM_TEXT }))
  eq(r.status, 200)
  eq(b.deleted.length, 0)
})

Deno.test('malformed / expired / tampered tokens never reach the purge', async () => {
  // The Auth server refuses expired or badly signed tokens; getUser then returns null.
  const refused = setup({ getUser: async () => null })
  const expired = jwt({ sub: ME, session_id: SID, exp: Math.floor(Date.now() / 1000) - 60 })
  for (const t of [expired, 'not.a.jwt', 'garbage', `${jwt({ sub: ME })}x`]) {
    eq((await refused.handler(post({ confirm: CONFIRM_TEXT }, t))).status, 401, t)
  }
  eq(refused.calls.length, 0)
  // Even if the Auth server accepted it, an unreadable payload is refused.
  const ok = setup()
  eq((await ok.handler(post({ confirm: CONFIRM_TEXT }, 'a.%%%.c'))).status, 401)
  eq(ok.calls.length, 0)
})

Deno.test('requests without Origin (not a browser) still need a verified token', async () => {
  const { handler, calls } = setup({ getUser: async () => null })
  eq((await handler(post({ confirm: CONFIRM_TEXT }, jwt({ sub: ME, session_id: SID }), ''))).status, 401)
  eq(calls.length, 0)
})
