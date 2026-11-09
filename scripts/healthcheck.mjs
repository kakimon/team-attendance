// Daily Supabase health check (used by .github/workflows/healthcheck.yml).
// Calls the read-only RPC public.health_check() with the publishable key.
// Exit 0 = healthy, exit 1 = unhealthy. Never writes data.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... node scripts/healthcheck.mjs
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export async function checkOnce({ url, key, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const started = Date.now()
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/rpc/health_check`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ms = Date.now() - started
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    const ok = res.ok && body?.ok === true && body?.database === true
    return { ok, status: res.status, ms, checkedAt: body?.checkedAt ?? null, error: ok ? null : (body?.message ?? text.slice(0, 200)) }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, checkedAt: null, error: String(e?.message ?? e) }
  }
}

/** One retry after a short wait, so a single network blip doesn't page anyone. At most 2 requests. */
export async function run({ url, key, fetchImpl = fetch, retryDelayMs = 30_000 }) {
  if (!url || !key) return { ok: false, attempts: [], error: 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required' }
  if (/^sb_secret_|service_role/.test(key)) return { ok: false, attempts: [], error: 'Use the publishable key, not a secret key' }
  const attempts = [await checkOnce({ url, key, fetchImpl })]
  if (!attempts[0].ok && (attempts[0].status === 0 || attempts[0].status >= 500)) {
    await new Promise((r) => setTimeout(r, retryDelayMs))
    attempts.push(await checkOnce({ url, key, fetchImpl }))
  }
  const last = attempts.at(-1)
  return { ok: last.ok, attempts, error: last.error }
}

function summary(result, host) {
  const rows = result.attempts.map((a, i) => `| ${i + 1} | ${a.ok ? 'OK' : 'NG'} | ${a.status} | ${a.ms} ms | ${a.checkedAt ?? '-'} | ${a.error ?? ''} |`)
  return [
    `## Supabase health check: ${result.ok ? 'OK' : 'FAILED'}`,
    '',
    `Project: \`${host}\`　Run at: ${new Date().toISOString()}`,
    '',
    '| # | Result | HTTP | Latency | DB time | Error |',
    '|---|---|---|---|---|---|',
    ...rows,
    result.error && !result.attempts.length ? `\nError: ${result.error}` : '',
    '',
  ].join('\n')
}

async function main() {
  const url = process.env.SUPABASE_URL ?? ''
  const result = await run({ url, key: process.env.SUPABASE_PUBLISHABLE_KEY ?? '' })
  const host = url ? new URL(url).host : '(unset)'
  const text = summary(result, host)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  if (!result.ok) {
    console.log(`::error::Supabase health check failed: ${result.error}`)
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
