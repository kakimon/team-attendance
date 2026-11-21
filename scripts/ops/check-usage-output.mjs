// Decides whether a SAVED output of scripts/ops/usage-inventory.sql is a complete report. Read-only: it only reads the file.
//
//   node scripts/ops/check-usage-output.mjs <saved output> [--exit-code <code the CLI returned>]
//     -> exit 0 "OK: ..." only for a complete report; exit 1 "NG: <reason>" otherwise. Never prints the content.
//
// Formats handled (the report travels inside the error message the SQL raises on purpose):
//   --local  : plain lines   "failed to execute query: error: USAGE_REPORT（…）\n== 0. …\n…\nUSAGE_REPORT_COMPLETE sections=7/7"
//   --linked : one JSON line  "unexpected status 400: {"message":"Failed to run sql query: ERROR:  P0001: USAGE_REPORT（…）\n…"}"
//   agent    : one JSON line  {"_tag":"Error","error":{"message":"failed to execute query: error: USAGE_REPORT（…）\n…"}}
// Complete = exactly one report header, sections "== 0." … "== 6." each exactly once and in order, then the exact line
// "USAGE_REPORT_COMPLETE sections=7/7" exactly once after section 6, and no INCOMPLETE line. The CLI's exit code alone
// never counts as success (it is 1 for every outcome); when given, it must be 1.
import { readFileSync } from 'node:fs'

const HEADER = 'USAGE_REPORT（読み取り専用・ロールバック済み）'
const MARKER = 'USAGE_REPORT_COMPLETE sections=7/7'
const SECTIONS = ['0', '1', '2', '3', '4', '5', '6']

/** The report text carried by the output (decoded from JSON when the CLI wrapped it), or an NG reason. */
export function extractReport(output) {
  const reports = []
  let malformed = 0
  for (const line of String(output).split('\n')) {
    const i = line.indexOf('{'), j = line.lastIndexOf('}')
    if (i < 0 || !line.includes('USAGE_REPORT')) continue
    if (j <= i) { malformed++; continue }                  // a JSON line cut off
    let obj
    try {
      obj = JSON.parse(line.slice(i, j + 1))
    } catch {
      malformed++
      continue
    }
    const msg = typeof obj?.message === 'string' ? obj.message : typeof obj?.error?.message === 'string' ? obj.error.message : null
    if (msg === null) { malformed++; continue }
    reports.push(msg)
  }
  if (malformed > 0) return { ng: 'a line that should carry the report is not valid JSON of the expected shape (content not shown)' }
  if (reports.length > 1) return { ng: `the output carries ${reports.length} JSON reports (expected one run)` }
  return { text: reports.length === 1 ? reports[0] : String(output) }
}

export function checkUsageOutput(output, exitCode) {
  if (exitCode !== undefined && exitCode !== 1) return { ok: false, reason: `the CLI exit code was ${exitCode}; the report always ends with exit code 1` }
  const ex = extractReport(output)
  if (ex.ng) return { ok: false, reason: ex.ng }
  const lines = ex.text.split('\n').map((l) => l.replace(/\r$/, ''))
  const headers = lines.filter((l) => l.includes(HEADER)).length
  if (headers === 0) return { ok: false, reason: 'no report header: the SQL stopped before the report (unexpected error)' }
  if (headers > 1) return { ok: false, reason: `${headers} report headers (expected one run)` }
  if (lines.some((l) => l.startsWith('USAGE_REPORT_INCOMPLETE'))) return { ok: false, reason: 'the report is INCOMPLETE (some items were n/a or not permitted)' }
  const at = SECTIONS.map((s) => lines.map((l, k) => (l.startsWith(`== ${s}. `) ? k : -1)).filter((k) => k >= 0))
  const bad = SECTIONS.filter((_, n) => at[n].length !== 1)
  if (bad.length) return { ok: false, reason: `sections missing or repeated: ${bad.join(', ')}` }
  const pos = at.map((a) => a[0])
  if (pos.some((p, n) => n > 0 && p <= pos[n - 1])) return { ok: false, reason: 'sections are out of order' }
  const head = lines.findIndex((l) => l.includes(HEADER))
  if (pos[0] <= head) return { ok: false, reason: 'sections appear before the report header' }
  const markers = lines.map((l, k) => (l === MARKER ? k : -1)).filter((k) => k >= 0)
  if (markers.length !== 1) return { ok: false, reason: markers.length ? 'the completion marker appears more than once' : 'the completion marker is missing' }
  if (markers[0] <= pos[6]) return { ok: false, reason: 'the completion marker is not after section 6' }
  return { ok: true, reason: 'complete report: header, sections 0-6 in order, completion marker' }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const file = args[0]
  const i = args.indexOf('--exit-code')
  const exitCode = i < 0 ? undefined : Number(args[i + 1])
  if (!file) { console.error('usage: check-usage-output.mjs <saved output> [--exit-code N]'); process.exit(2) }
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { console.error(`NG: cannot read the file (${e.code ?? 'error'})`); process.exit(1) }
  const r = checkUsageOutput(text, exitCode)
  if (r.ok) console.log(`OK: ${r.reason}`)
  else console.error(`NG: ${r.reason}`)
  process.exit(r.ok ? 0 : 1)
}
