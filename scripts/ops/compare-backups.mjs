// Compares two method-A backups (format 3) to prove that applying migrations kept every existing row unchanged.
// Read-only: it only reads the two files. Prints table names, column NAMES and counts — never a value.
//
//   node scripts/ops/compare-backups.mjs <before.json> <after.json> [--expect-sha256-before <hex>] [--expect-sha256-after <hex>]
//     exit 0  "RESULT: SAME"  every Phase 4-B row is still there, unchanged, nothing added or removed, and the
//                             added columns / tables are in their initial state
//     exit 1  "RESULT: DIFF"  at least one difference (the lines above say which table / column, as counts)
//     exit 2  "ERROR: ..."    the files cannot be compared (wrong kind, unexpected shape, checksum mismatch, ...)
//
// before: a Phase 4-B backup (kind phase4b, 6 migrations). after: the same database after the migrations
// (kind latest in a known latest state = 17, 18 or 19 migrations by ID and order, or kind phase4b when comparing two
// 4-B backups taken at different times).
// Or: before AND after of kind latest (e.g. 17 -> 18 around a function-only migration such as 20261124000000):
// after's migrations must be before's plus function-only migrations only (restore_app_data.template.sql c_fn_only);
// then all 11 tables are compared with ALL their columns (nothing may differ: such a migration changes no data).
// Migration lists are checked by ID and order, never by count; a schema change that is not function-only is an error.
//
// How rows are compared (all 9 Phase 4-B tables, none skipped):
//   * rows are matched by the table's primary key (PRIMARY_KEYS below, = the production schema dump)
//   * each row of BOTH files must have exactly the expected Phase 4-B columns (PHASE4B_COLUMNS); for the after file
//     only the columns listed in ADDED_COLUMNS may be extra. Anything else is an error, so a column can never be left
//     out of the comparison by accident (even when a table has no rows)
//   * an after row is reduced to the Phase 4-B columns and compared value by value (JSON equality)
//   * added = key only in after, removed = key only in before, changed = same key, different value in some column
// For a latest after file it also checks the added columns and tables against their initial state (INITIAL_STATE).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBackup, functionOnlyExtension, isAcceptedState, migrationLists, parseBackup, sha256 } from './build-restore-sql.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Primary keys (production schema dump, 2026-11-21). */
export const PRIMARY_KEYS = {
  teams: ['id'],
  team_members: ['team_id', 'user_id'],
  players: ['id'],
  player_guardians: ['player_id', 'user_id'],
  events: ['id'],
  attendance: ['event_id', 'player_id'],
  guardian_invitations: ['id'],
  team_owner_transfers: ['team_id'],
  account_deletions: ['user_id'],
}

/** Every column of the 9 Phase 4-B tables (production schema dump, 2026-11-21). */
export const PHASE4B_COLUMNS = {
  teams: ['id', 'name', 'share_token', 'created_by', 'created_at'],
  team_members: ['team_id', 'user_id', 'role', 'display_name', 'joined_at'],
  players: ['id', 'team_id', 'name', 'normalized_name', 'note', 'created_by', 'created_at', 'archived_at', 'updated_at',
    'updated_by', 'archived_by'],
  player_guardians: ['player_id', 'team_id', 'user_id', 'added_via', 'created_at'],
  events: ['id', 'team_id', 'title', 'starts_at', 'location', 'note', 'created_by', 'created_at', 'updated_at',
    'updated_by', 'deleted_at', 'deleted_by'],
  attendance: ['event_id', 'player_id', 'team_id', 'status', 'comment', 'updated_by', 'updated_at'],
  guardian_invitations: ['id', 'team_id', 'player_id', 'token_hash', 'created_by', 'created_at', 'expires_at', 'used_at',
    'used_by', 'revoked_at'],
  team_owner_transfers: ['team_id', 'from_user', 'to_user', 'created_at', 'expires_at'],
  account_deletions: ['user_id', 'purged_at', 'attempts', 'last_error', 'last_error_at'],
}

/** Columns the 11 migrations add to Phase 4-B tables (D3.5 self_registration, D6-B1 member_suspension). */
export const ADDED_COLUMNS = {
  team_members: ['suspended_at', 'access_revision'],
  players: ['is_self', 'self_user_id'],
}

/**
 * Initial state right after the migrations (confirmed on a local Supabase, 2026-11-21):
 *   team_members.suspended_at = null, team_members.access_revision = 0 (`add column ... bigint default 0` fills existing rows)
 *   players.is_self = false, players.self_user_id = null
 *   private.team_join_tokens: exactly one row per team, with a token (U2 issues one for every existing team)
 *   private.team_member_blocks: no rows
 */
export const INITIAL_STATE = {
  team_members: { suspended_at: null, access_revision: 0 },
  players: { is_self: false, self_user_id: null },
}

/** The two tables only the latest schema has (join links, re-join blocks): primary keys and every column. */
export const LATEST_ONLY = {
  team_join_tokens: { key: ['team_id'], columns: ['team_id', 'token', 'updated_at'] },
  team_member_blocks: { key: ['team_id', 'user_id'], columns: ['team_id', 'user_id', 'created_at'] },
}

const TABLES = Object.keys(PHASE4B_COLUMNS)
const keyOf = (t, r) => JSON.stringify(PRIMARY_KEYS[t].map((c) => r[c]))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function shapeErrors(t, rows, extra) {
  const want = PHASE4B_COLUMNS[t], allowed = new Set([...want, ...extra])
  const errors = new Set()
  for (const r of rows) {
    for (const c of want) if (!(c in r)) errors.add(`${t}: column ${c} is missing`)
    for (const c of Object.keys(r)) if (!allowed.has(c)) errors.add(`${t}: unexpected column ${c}`)
    if (extra.length) for (const c of extra) if (!(c in r)) errors.add(`${t}: added column ${c} is missing`)
  }
  return [...errors]
}

/**
 * Compares two parsed backups. Returns { same, lines, errors }: `errors` (shape / kind problems) mean the files
 * cannot be compared; otherwise `same` tells the result. `lines` hold names and counts only.
 */
export function compareBackups(before, after) {
  const errors = []
  try { checkBackup(before) } catch (e) { errors.push(`before: ${e.message}`) }
  try { checkBackup(after) } catch (e) { errors.push(`after: ${e.message}`) }
  if (errors.length) return { same: false, lines: [], errors }
  const lists = migrationLists(readFileSync(join(HERE, 'restore_app_data.template.sql'), 'utf8'))
  if (before.kind === 'latest') return compareLatest(before, after, lists)
  if (before.kind !== 'phase4b') errors.push(`before must be a phase4b or latest backup (got ${before.kind})`)
  if (!['phase4b', 'latest'].includes(after.kind)) errors.push(`after must be a phase4b or latest backup (got ${after.kind})`)
  if (!same(before.migrations, lists.phase4b)) errors.push(`before: ${before.migrations?.length} migrations, not the Phase 4-B list`)
  if (['phase4b', 'latest'].includes(after.kind) && !isAcceptedState(lists, after.kind, after.migrations)) {
    errors.push(`after: ${after.migrations?.length} migrations, not a known ${after.kind} state (by ID and order)`)
  }
  const latest = after.kind === 'latest'
  for (const t of TABLES) {
    errors.push(...shapeErrors(t, before[t], []).map((m) => `before ${m}`))
    errors.push(...shapeErrors(t, after[t], latest ? ADDED_COLUMNS[t] ?? [] : []).map((m) => `after ${m}`))
    for (const [side, rows] of [['before', before[t]], ['after', after[t]]]) {
      const keys = rows.map((r) => keyOf(t, r))
      if (new Set(keys).size !== keys.length) errors.push(`${side} ${t}: duplicate primary key`)
    }
  }
  if (errors.length) return { same: false, lines: [], errors }

  const lines = []
  let diff = 0
  for (const t of TABLES) {
    const b = new Map(before[t].map((r) => [keyOf(t, r), r]))
    const a = new Map(after[t].map((r) => [keyOf(t, r), r]))
    let added = 0, removed = 0, changed = 0
    const changedCols = new Set()
    for (const k of a.keys()) if (!b.has(k)) added++
    for (const [k, rb] of b) {
      const ra = a.get(k)
      if (!ra) { removed++; continue }
      const cols = PHASE4B_COLUMNS[t].filter((c) => !same(rb[c], ra[c]))
      if (cols.length) { changed++; cols.forEach((c) => changedCols.add(c)) }
    }
    if (added || removed || changed) diff++
    lines.push(`${t.padEnd(22)} rows ${b.size} -> ${a.size} | added ${added} | removed ${removed} | changed ${changed}` +
      (changedCols.size ? ` (columns: ${[...changedCols].join(', ')})` : ''))
  }
  lines.push(`migrations             ${before.migrations.length} -> ${after.migrations.length} (${after.kind} list)`)
  if (before.auth_users_count !== after.auth_users_count) diff++
  lines.push(`auth users             ${before.auth_users_count} -> ${after.auth_users_count}`)

  if (latest) {
    for (const [t, init] of Object.entries(INITIAL_STATE)) {
      for (const [c, v] of Object.entries(init)) {
        const off = after[t].filter((r) => !same(r[c], v)).length
        if (off) diff++
        lines.push(`initial ${t}.${c} = ${JSON.stringify(v)}: ${after[t].length - off}/${after[t].length}${off ? ` (${off} differ)` : ''}`)
      }
    }
    const teams = new Set(after.teams.map((r) => r.id))
    const tok = after.team_join_tokens
    const tokTeams = new Set(tok.map((r) => r.team_id))
    const tokOk = tok.length === teams.size && [...teams].every((id) => tokTeams.has(id)) && tok.every((r) => typeof r.token === 'string' && r.token.length >= 32)
    if (!tokOk) diff++
    lines.push(`initial team_join_tokens: ${tok.length} row(s) for ${teams.size} team(s), one per team with a token: ${tokOk ? 'yes' : 'NO'}`)
    const blocks = after.team_member_blocks.length
    if (blocks) diff++
    lines.push(`initial team_member_blocks: ${blocks} row(s) (expected 0)`)
  }
  return { same: diff === 0, lines, errors: [] }
}

/**
 * latest -> latest (around function-only migrations): every row of all 11 tables, every column, must be identical.
 * Refused (errors) when the after state is not before + function-only migrations, or a row has another shape.
 */
function compareLatest(before, after, lists) {
  const errors = []
  if (after.kind !== 'latest') return { same: false, lines: [], errors: [`after must be a latest backup when before is latest (got ${after.kind})`] }
  for (const [side, b] of [['before', before], ['after', after]]) {
    if (!isAcceptedState(lists, 'latest', b.migrations)) errors.push(`${side}: ${b.migrations?.length} migrations, not a known latest state (by ID and order)`)
  }
  const extra = errors.length ? null : functionOnlyExtension(lists, before.migrations, after.migrations)
  if (!errors.length && !extra) errors.push('after is not before plus function-only migrations: the schemas are not comparable row by row')
  const spec = {
    ...Object.fromEntries(TABLES.map((t) => [t, { key: PRIMARY_KEYS[t], columns: [...PHASE4B_COLUMNS[t], ...(ADDED_COLUMNS[t] ?? [])] }])),
    ...LATEST_ONLY,
  }
  const rowKey = (t, r) => JSON.stringify(spec[t].key.map((c) => r[c]))
  for (const [t, { columns }] of Object.entries(spec)) {
    for (const [side, rows] of [['before', before[t]], ['after', after[t]]]) {
      const bad = new Set()
      for (const r of rows) {
        for (const c of columns) if (!(c in r)) bad.add(`${side} ${t}: column ${c} is missing`)
        for (const c of Object.keys(r)) if (!columns.includes(c)) bad.add(`${side} ${t}: unexpected column ${c}`)
      }
      errors.push(...bad)
      const keys = rows.map((r) => rowKey(t, r))
      if (new Set(keys).size !== keys.length) errors.push(`${side} ${t}: duplicate primary key`)
    }
  }
  if (errors.length) return { same: false, lines: [], errors }
  const lines = []
  let diff = 0
  for (const [t, { columns }] of Object.entries(spec)) {
    const b = new Map(before[t].map((r) => [rowKey(t, r), r]))
    const a = new Map(after[t].map((r) => [rowKey(t, r), r]))
    let added = 0, removed = 0, changed = 0
    const changedCols = new Set()
    for (const k of a.keys()) if (!b.has(k)) added++
    for (const [k, rb] of b) {
      const ra = a.get(k)
      if (!ra) { removed++; continue }
      const cols = columns.filter((c) => !same(rb[c], ra[c]))
      if (cols.length) { changed++; cols.forEach((c) => changedCols.add(c)) }
    }
    if (added || removed || changed) diff++
    lines.push(`${t.padEnd(22)} rows ${b.size} -> ${a.size} | added ${added} | removed ${removed} | changed ${changed}` +
      (changedCols.size ? ` (columns: ${[...changedCols].join(', ')})` : ''))
  }
  lines.push(`migrations             ${before.migrations.length} -> ${after.migrations.length} (latest; function-only: ${extra.length ? extra.join(', ') : 'none'})`)
  if (before.auth_users_count !== after.auth_users_count) diff++
  lines.push(`auth users             ${before.auth_users_count} -> ${after.auth_users_count}`)
  return { same: diff === 0, lines, errors: [] }
}

function main(args) {
  const [beforeFile, afterFile] = args
  const opt = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1] }
  if (!beforeFile || !afterFile || beforeFile.startsWith('--') || afterFile.startsWith('--')) {
    console.error('usage: compare-backups.mjs <before.json> <after.json> [--expect-sha256-before <hex>] [--expect-sha256-after <hex>]')
    return 2
  }
  const read = (f, expect, label) => {
    let text
    try { text = readFileSync(f, 'utf8') } catch (e) { throw new Error(`cannot read the ${label} file (${e.code ?? 'error'})`) }
    const h = sha256(text)
    if (expect && expect !== h) throw new Error(`the ${label} file does not match --expect-sha256-${label}`)
    console.log(`${label} sha256 ${h}`)
    return parseBackup(text)
  }
  let before, after
  try {
    before = read(beforeFile, opt('--expect-sha256-before'), 'before')
    after = read(afterFile, opt('--expect-sha256-after'), 'after')
  } catch (e) {
    console.error(`ERROR: ${e.message}`)
    return 2
  }
  const r = compareBackups(before, after)
  if (r.errors.length) {
    for (const m of r.errors) console.error(`ERROR: ${m}`)
    return 2
  }
  for (const l of r.lines) console.log(l)
  console.log(r.same ? 'RESULT: SAME' : 'RESULT: DIFF')
  return r.same ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
