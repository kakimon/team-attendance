// Builds the method-A restore SQL from restore_app_data.template.sql + a backup JSON
// (output of backup_tables.sql / backup_tables_latest.sql). The backup is embedded in the output.
//
//   node scripts/ops/build-restore-sql.mjs <tables.json> <out.sql> plan   [--expect-sha256 <hex>] [--scope missing-teams|all]
//   node scripts/ops/build-restore-sql.mjs <tables.json> <out.sql> commit --expect-sha256 <hex> --expect-missing-teams <N> [--scope ...]
//
// The output contains everything in the backup (names, tokens): it is written with mode 600 and never inside a git
// repository; the backup itself is refused when it lies inside a git repository. --expect-sha256 (the value saved by
// take-backup.mjs) is checked before anything is written; it is required for commit. Only the SHA-256 of the backup and
// row counts are printed — never its content (a broken file is reported without showing any of it).
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const KINDS = {
  phase4b: ['teams', 'team_members', 'players', 'player_guardians', 'events', 'attendance', 'guardian_invitations',
    'team_owner_transfers', 'account_deletions'],
}
KINDS.latest = [...KINDS.phase4b, 'team_join_tokens', 'team_member_blocks']
const META = ['format', 'kind', 'taken_at', 'migrations', 'auth_users_count', 'counts']

/** Accepts the backup object itself or the CLI output ([{backup}] or {rows:[{backup}]}, backup possibly as a string). */
export function parseBackup(raw) {
  let v = typeof raw === 'string' ? safeJson(raw) : raw
  const rows = Array.isArray(v) ? v : v && Array.isArray(v.rows) ? v.rows : null   // `--agent no` prints an array
  if (rows) {
    if (rows.length !== 1) throw new Error(`expected exactly 1 row in the CLI output, got ${rows.length}`)
    v = rows[0].backup
  }
  if (typeof v === 'string') v = safeJson(v)
  return v
}

/** JSON.parse whose error never quotes the input (Node's message shows a piece of it). */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`the backup is not valid JSON (${text.length} characters; content not shown). Was the backup command successful?`)
  }
}

/** The same shape checks the SQL makes, done early so a wrong file is refused before anything runs. */
export function checkBackup(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('backup is not a JSON object')
  if (b.format !== 3) throw new Error('unsupported backup format (expected 3: taken with backup_tables.sql / backup_tables_latest.sql)')
  const tables = KINDS[b.kind]
  if (!tables) throw new Error('unknown backup kind')
  for (const k of Object.keys(b)) if (!META.includes(k) && !tables.includes(k)) throw new Error('unexpected key in the backup')
  for (const t of tables) {
    if (!Array.isArray(b[t])) throw new Error(`table ${t} is missing in the backup`)
    if (Number(b.counts?.[t]) !== b[t].length) throw new Error(`table ${t}: ${b[t].length} rows but the backup recorded ${b.counts?.[t]}`)
  }
  return { kind: b.kind, counts: Object.fromEntries(tables.map((t) => [t, b[t].length])) }
}

export function buildRestoreSql(template, backup, { mode = 'plan', scope = 'missing-teams', expectMissingTeams = null } = {}) {
  if (!['plan', 'commit'].includes(mode)) throw new Error(`mode must be plan or commit, got ${mode}`)
  if (!['missing-teams', 'all'].includes(scope)) throw new Error(`scope must be missing-teams or all, got ${scope}`)
  if (mode === 'commit' && !(Number.isInteger(expectMissingTeams) && expectMissingTeams >= 0)) {
    throw new Error('commit needs --expect-missing-teams <N> (the number plan reported)')
  }
  checkBackup(backup)
  const json = JSON.stringify(backup)
  let tag
  do tag = `$bk_${randomBytes(6).toString('hex')}$`; while (json.includes(tag))
  let out = template.split('__MODE__').join(mode).split('__SCOPE__').join(scope)
    .split('__EXPECT_MISSING_TEAMS__').join(String(mode === 'commit' ? expectMissingTeams : -1))
  const parts = out.split('__BACKUP__')
  if (parts.length !== 2) throw new Error('template must contain __BACKUP__ exactly once')
  if (/__[A-Z_]+__/.test(parts.join(''))) throw new Error('unfilled placeholder left')
  return parts[0] + `${tag}${json}${tag}::jsonb` + parts[1]
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** The git work tree that contains `path` (a file or folder, existing or not), or null. */
export function gitRepoOf(path) {
  let dir = resolve(path)
  while (!existsSync(dir)) dir = dirname(dir)
  dir = realpathSync(dir)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** The exact migration lists the restore SQL accepts (single source: the template). */
export function migrationLists(template) {
  const m = [...template.matchAll(/c_(4b|latest)\s+text\[\] := array\[([^\]]+)\]/g)]
  const get = (k) => m.find((x) => x[1] === k)?.[2].match(/\d{14}/g) ?? []
  return { phase4b: get('4b'), latest: get('latest') }
}

const SHA = /^[0-9a-f]{64}$/

function main(args) {
  const [inFile, outFile, mode] = args
  const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  if (!inFile || !outFile || !mode) throw new Error('usage: build-restore-sql.mjs <tables.json> <out.sql> plan|commit [--expect-sha256 <hex>] [--scope missing-teams|all] [--expect-missing-teams N]')
  if (gitRepoOf(inFile)) throw new Error('refusing a backup that lies inside a git repository (move it to the backup folder outside any repository)')
  if (gitRepoOf(outFile)) throw new Error('refusing to write the restore SQL inside a git repository (it contains the backup)')
  const expectSha = opt('--expect-sha256')
  if (expectSha !== undefined && !SHA.test(expectSha)) throw new Error('--expect-sha256 must be 64 lowercase hex characters')
  if (mode === 'commit' && !expectSha) throw new Error('commit needs --expect-sha256 <hex> (the value saved next to the backup)')
  const text = readFileSync(inFile, 'utf8')
  const actual = sha256(text)
  if (expectSha && actual !== expectSha) throw new Error('the backup does not match --expect-sha256 (changed, truncated or a different file); nothing was written')
  const backup = parseBackup(text)
  const { kind, counts } = checkBackup(backup)
  const em = opt('--expect-missing-teams')
  const template = readFileSync(new URL('./restore_app_data.template.sql', import.meta.url), 'utf8')
  const sql = buildRestoreSql(template, backup, { mode, scope: opt('--scope') ?? 'missing-teams', expectMissingTeams: em === undefined ? null : Number(em) })
  writeFileSync(outFile, sql, { mode: 0o600 })
  chmodSync(outFile, 0o600)
  console.log(`backup sha256 ${actual}${expectSha ? ' (matches --expect-sha256)' : ' (not checked: pass --expect-sha256)'} | kind ${kind} | ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')}`)
  console.log(`wrote ${outFile} (mode ${mode}, file mode 600)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`error: ${e.message}`)   // message only: no stack, never file content
    process.exit(1)
  }
}
