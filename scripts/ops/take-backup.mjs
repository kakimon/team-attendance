// Takes the method-A backup (read-only) and saves it ONLY when everything is right:
// the CLI exited 0, the output is a valid format-3 backup of the requested kind whose migration list is exactly one
// known state of that kind (by ID and order: phase4b = 6; latest = 17, 18 or 19, see restore_app_data.template.sql),
// and every count matches. On any failure nothing is kept (a partial file is removed).
//
//   node scripts/ops/take-backup.mjs --kind phase4b --out-dir <folder outside any repository> --project-ref <ref>
//   node scripts/ops/take-backup.mjs --kind latest  --out-dir <folder> --project-ref <ref>
//   node scripts/ops/take-backup.mjs --kind latest  --out-dir <folder> --local          (local Supabase, for checks)
//
// --project-ref must equal the linked project (supabase/.temp/project-ref); otherwise nothing runs.
// Writes tables-<kind>-<UTC time>.json (mode 600) and the same name + .sha256 (shasum format) into --out-dir
// (created with mode 700; refused when it is inside a git repository or open to other users).
// Prints only the file name, SHA-256 and row counts — never the content.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync, closeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptedStates, checkBackup, gitRepoOf, isAcceptedState, migrationLists, parseBackup, sha256 } from './build-restore-sql.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL = { phase4b: 'backup_tables.sql', latest: 'backup_tables_latest.sql' }

function main(args) {
  const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const kind = opt('--kind'), outDirArg = opt('--out-dir'), ref = opt('--project-ref'), local = args.includes('--local')
  const workdir = resolve(opt('--workdir') ?? join(HERE, '../..'))
  if (!SQL[kind]) throw new Error('--kind must be phase4b or latest')
  if (!outDirArg) throw new Error('--out-dir <folder> is required')
  if (local === Boolean(ref)) throw new Error('give exactly one of --project-ref <ref> (linked project) or --local')

  // 1. target
  if (!local) {
    const linked = existsSync(join(workdir, 'supabase/.temp/project-ref')) ? readFileSync(join(workdir, 'supabase/.temp/project-ref'), 'utf8').trim() : ''
    if (!linked) throw new Error('no linked project (supabase/.temp/project-ref); nothing was run')
    if (linked !== ref) throw new Error(`the linked project is not ${ref}; nothing was run`)
  }
  // 2. destination
  const outDir = resolve(outDirArg)
  if (gitRepoOf(outDir)) throw new Error('refusing a backup folder inside a git repository; nothing was run')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 })
  if ((statSync(outDir).mode & 0o077) !== 0) throw new Error('the backup folder is open to other users (use chmod 700); nothing was run')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const file = join(outDir, `tables-${kind}-${stamp}.json`)

  // 3. read-only query
  const r = spawnSync('supabase', ['db', 'query', local ? '--local' : '--linked', '--workdir', workdir, '--agent', 'no', '--output-format', 'json', '-f', join(HERE, SQL[kind])],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, cwd: workdir })
  if (r.error) throw new Error(`could not run the supabase CLI (${r.error.code ?? 'error'}); nothing was saved`)
  if (r.status !== 0) {
    // The CLI prints its error as {"_tag":"Error","error":{"message":...}} on stdout (non-TTY) and/or text on stderr.
    // Only that message is shown: never other output.
    let why = ''
    try { why = String(JSON.parse(r.stdout).error?.message ?? '') } catch { /* not the CLI's error object */ }
    if (!why) why = (r.stderr || '').split('\n').filter((l) => /error|failed|denied|not exist|timeout/i.test(l)).slice(0, 3).join(' / ')
    why = why.slice(0, 400)
    throw new Error(`the backup command failed (exit ${r.status})${why ? ': ' + why : ''}; nothing was saved`)
  }
  // 4. verify before keeping anything
  const text = r.stdout
  const backup = parseBackup(text)
  const { counts } = checkBackup(backup)
  if (backup.kind !== kind) throw new Error(`the output is a ${backup.kind} backup, not ${kind}; nothing was saved`)
  // The applied migrations must be exactly one known state of the kind (IDs and order; e.g. latest = 17, 18 or 19).
  const lists = migrationLists(readFileSync(join(HERE, 'restore_app_data.template.sql'), 'utf8'))
  if (!isAcceptedState(lists, kind, backup.migrations)) {
    const known = acceptedStates(lists, kind).map((l) => l.length).join(' or ')
    throw new Error(`the database's ${backup.migrations?.length ?? '?'} migrations are not a known ${kind} state (${known}, by ID and order); wrong file or wrong database; nothing was saved`)
  }
  // 5. save (exclusive create, mode 600), then the checksum
  const hash = sha256(text)
  const created = []   // only files THIS run created are removed on failure (never an earlier backup)
  let fd
  try {
    fd = openSync(file, 'wx', 0o600); created.push(file)
    writeSync(fd, text)
    closeSync(fd); fd = undefined
    chmodSync(file, 0o600)
    const sumFd = openSync(file + '.sha256', 'wx', 0o600); created.push(file + '.sha256')
    writeSync(sumFd, `${hash}  ${basename(file)}\n`)
    closeSync(sumFd)
  } catch (e) {
    if (fd !== undefined) closeSync(fd)
    for (const f of created) if (existsSync(f)) unlinkSync(f)
    throw new Error(`could not save the backup (${e.code ?? 'error'}); nothing new was kept`)
  }
  console.log(`saved ${file}`)
  console.log(`sha256 ${hash} | kind ${kind} | auth users ${backup.auth_users_count} | ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
}
