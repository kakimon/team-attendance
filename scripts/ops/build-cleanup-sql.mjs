// Builds the admin cleanup SQL from the template + identity values (read-only query output)
// + the APPROVED expectations below (not read from the database, so the SQL really checks them).
//
//   node scripts/ops/build-cleanup-sql.mjs <values.json> <out.sql> [check|dry-run|commit]
//
// The output pins team ids: write it outside the public repository (docs/internal/ is never exported).
import { readFileSync, writeFileSync } from 'node:fs'

/** Approved on 2026-11-14 (test-data inventory 0533cce). Change only with a new approval. */
export const APPROVED = {
  expect: 'members=3 children=5 guardians=5 events=1 answers=4 invitations=1 transfers=0',
  keepFp: 'f04ceec43395748da8e068208f877d8d',
  keepCounts: '1/3/3/4/2/4/1', // teams/members/children/answers/events/guardian links/invitations
  authUsers: 3,
}

const sqlText = (s) => String(s).replace(/'/g, "''")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function buildCleanupSql(template, values, mode = 'dry-run', approved = APPROVED) {
  if (!['check', 'dry-run', 'commit'].includes(mode)) throw new Error(`mode must be check, dry-run or commit, got ${mode}`)
  for (const k of ['team_a_id', 'team_b_id', 'keep_id']) if (!UUID.test(values[k] ?? '')) throw new Error(`${k} is not a uuid`)
  for (const k of ['team_a_name', 'team_a_created', 'team_a_members', 'team_b_name', 'team_b_created', 'team_b_members', 'keep_name']) {
    if (!values[k]) throw new Error(`missing ${k}`)
  }
  const map = {
    __MODE__: mode,
    __TEAM_A_ID__: values.team_a_id, __TEAM_A_NAME__: values.team_a_name,
    __TEAM_A_CREATED__: values.team_a_created, __TEAM_A_MEMBERS__: values.team_a_members,
    __TEAM_B_ID__: values.team_b_id, __TEAM_B_NAME__: values.team_b_name,
    __TEAM_B_CREATED__: values.team_b_created, __TEAM_B_MEMBERS__: values.team_b_members,
    __KEEP_ID__: values.keep_id, __KEEP_NAME__: values.keep_name,
    __KEEP_FP__: approved.keepFp, __KEEP_COUNTS__: approved.keepCounts, __EXPECT__: approved.expect,
    __AUTH_USERS__: String(approved.authUsers),
  }
  let out = template
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(k === '__AUTH_USERS__' ? v : sqlText(v))
  if (/__[A-Z_]+__/.test(out)) throw new Error('unfilled placeholder left')
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [valuesFile, outFile, mode = 'dry-run'] = process.argv.slice(2)
  if (!valuesFile || !outFile) throw new Error('usage: build-cleanup-sql.mjs <values.json> <out.sql> [check|dry-run|commit]')
  const raw = JSON.parse(readFileSync(valuesFile, 'utf8'))
  const rows = Array.isArray(raw) ? raw : raw.rows
  if (!rows || rows.length !== 1) throw new Error(`expected exactly 1 row of values, got ${rows?.length ?? 0}`)
  const template = readFileSync(new URL('./cleanup-test-teams.template.sql', import.meta.url), 'utf8')
  writeFileSync(outFile, buildCleanupSql(template, rows[0], mode))
  console.log(`wrote ${outFile} (mode ${mode})`)
}
