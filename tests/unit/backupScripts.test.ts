// Safety of the operations scripts around a backup: take-backup.mjs (exit code, verification, location, mode),
// build-restore-sql.mjs (no content in errors, SHA-256, location) and scan-export-for-data.mjs (no data in an export).
// A fake `supabase` executable stands in for the CLI: nothing here talks to any database.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without type declarations
import { migrationLists, sha256 } from '../../scripts/ops/build-restore-sql.mjs'
// @ts-expect-error plain ESM script without type declarations
import { scanFolder } from '../../scripts/ops/scan-export-for-data.mjs'

const repo = join(import.meta.dirname, '../..')
const ops = (f: string) => join(repo, 'scripts/ops', f)
const LISTS = migrationLists(readFileSync(ops('restore_app_data.template.sql'), 'utf8'))
const T4B = ['teams', 'team_members', 'players', 'player_guardians', 'events', 'attendance', 'guardian_invitations', 'team_owner_transfers', 'account_deletions']
const SECRET = 'secret-山田-' + 'x'.repeat(5)

function backup(kind: 'phase4b' | 'latest' = 'phase4b', patch: Record<string, unknown> = {}) {
  const tables = kind === 'latest' ? [...T4B, 'team_join_tokens', 'team_member_blocks'] : T4B
  const b: Record<string, unknown> = { format: 3, kind, taken_at: '2026-11-19T00:00:00Z', migrations: LISTS[kind], auth_users_count: 1,
    counts: Object.fromEntries(tables.map((t) => [t, t === 'teams' ? 1 : 0])), ...Object.fromEntries(tables.map((t) => [t, []])) }
  b.teams = [{ id: '63000000-0000-4000-8000-000000000001', name: SECRET, share_token: 'tok_' + SECRET }]
  return { ...b, ...patch }
}
/** A temp dir with a fake `supabase` that prints $FAKE_OUT and exits with $FAKE_EXIT. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'bk-test-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'supabase'), '#!/bin/sh\n[ -n "$FAKE_OUT" ] && cat "$FAKE_OUT"\n[ -n "$FAKE_ERR" ] && echo "$FAKE_ERR" >&2\nexit ${FAKE_EXIT:-0}\n')
  chmodSync(join(bin, 'supabase'), 0o755)
  const work = join(root, 'work'); mkdirSync(join(work, 'supabase/.temp'), { recursive: true })
  writeFileSync(join(work, 'supabase/.temp/project-ref'), 'ztlpsihzqzxnqyngxnbp\n')
  const out = join(root, 'out')
  const take = (args: string[], fake: { out?: string; exit?: number; err?: string }) => {
    const f = join(root, 'cli-output')
    if (fake.out !== undefined) writeFileSync(f, fake.out)
    return spawnSync('node', [ops('take-backup.mjs'), '--workdir', work, ...args], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_OUT: fake.out !== undefined ? f : '', FAKE_EXIT: String(fake.exit ?? 0), FAKE_ERR: fake.err ?? '' } })
  }
  return { root, out, take }
}
const cli = (b: unknown) => JSON.stringify([{ backup: b }])
/** A throwaway git work tree (a `.git` folder is what marks one), so the "inside a repository" guard is tested the
 *  same way in this repository and in a public export, which has no .git. Nothing is ever written into the real tree. */
function fakeRepo() {
  const r = mkdtempSync(join(tmpdir(), 'fake-repo-'))
  mkdirSync(join(r, '.git'))
  return r
}
/** Development repository only: scripts/export-public.sh is export-ignored, so it does not exist in a public export. */
/** A fictional project ref (20 lowercase letters like a real one, but no real project's). */
const OTHER_REF = 'testrefzzzzzzzzzzzzz'
const DEV_REPO = existsSync(join(repo, 'scripts/export-public.sh')) && existsSync(join(repo, '.git'))
const build = (args: string[]) => spawnSync('node', [ops('build-restore-sql.mjs'), ...args], { encoding: 'utf8' })

describe('take-backup.mjs', () => {
  const ok = ['--kind', 'phase4b', '--project-ref', 'ztlpsihzqzxnqyngxnbp']

  it('saves only a verified backup: mode 600 file + shasum file in a 700 folder; prints no content', () => {
    const s = sandbox()
    const text = cli(backup())
    const r = s.take([...ok, '--out-dir', s.out], { out: text })
    expect(r.status, r.stderr).toBe(0)
    const files = readdirSync(s.out).sort()
    expect(files).toHaveLength(2)
    const [json, sum] = files as [string, string]
    expect(json).toMatch(/^tables-phase4b-\d{8}-\d{6}\.json$/)
    expect(readFileSync(join(s.out, json), 'utf8')).toBe(text)
    expect(readFileSync(join(s.out, sum), 'utf8')).toBe(`${sha256(text)}  ${json}\n`)
    expect(statSync(join(s.out, json)).mode & 0o777).toBe(0o600)
    expect(statSync(s.out).mode & 0o777).toBe(0o700)
    expect(r.stdout).toContain(`sha256 ${sha256(text)}`)
    expect(r.stdout + r.stderr).not.toContain('secret')
  })

  it('latest: saved for both known states (17 = production, 18 = after the function-only migration); any other list is refused', () => {
    const latest = ['--kind', 'latest', '--project-ref', 'ztlpsihzqzxnqyngxnbp']
    const l17 = LISTS.latest.filter((v: string) => !LISTS.functionOnly.includes(v))
    expect(l17).toHaveLength(17)
    for (const migrations of [LISTS.latest, l17]) {
      const s = sandbox()
      const r = s.take([...latest, '--out-dir', s.out], { out: cli(backup('latest', { migrations })) })
      expect(r.status, r.stderr).toBe(0)
      expect(readdirSync(s.out).filter((f) => f.endsWith('.json'))).toHaveLength(1)
    }
    const swapped = [...l17.slice(0, -2), l17.at(-1), l17.at(-2)]
    for (const migrations of [[...LISTS.latest, '20991231000000'], [...l17, '20261124000001'], l17.slice(0, 16), swapped]) {
      const s = sandbox()
      const r = s.take([...latest, '--out-dir', s.out], { out: cli(backup('latest', { migrations })) })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/not a known latest state \(18 or 17, by ID and order\).*nothing was saved/)
      expect(existsSync(s.out) ? readdirSync(s.out) : []).toEqual([])
    }
  })

  it('CLI failure (non-zero exit) -> stops, nothing saved, even when it printed something', () => {
    const s = sandbox()
    const r = s.take([...ok, '--out-dir', s.out], { out: cli(backup()).slice(0, 50), exit: 1, err: 'failed to execute query: error: permission denied for table teams' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/the backup command failed \(exit 1\): failed to execute query: error: permission denied.*nothing was saved/)
    expect(existsSync(s.out) ? readdirSync(s.out) : []).toEqual([])
    // the CLI's own error object on stdout (how it reports when not attached to a terminal)
    const s2 = sandbox()
    const r2 = s2.take([...ok, '--out-dir', s2.out], { out: '{"_tag":"Error","error":{"code":"DbQueryExecError","message":"failed to execute query: error: relation \\"private.team_join_tokens\\" does not exist"}}', exit: 1 })
    expect(r2.stderr).toMatch(/exit 1\): failed to execute query: error: relation "private.team_join_tokens" does not exist; nothing was saved/)
    expect(existsSync(s2.out) ? readdirSync(s2.out) : []).toEqual([])
  })

  it('broken / wrong output -> stops without showing it; nothing saved', () => {
    for (const [out, re] of [
      [`[{"backup": {"teams": [{"name": "${SECRET}"`, /not valid JSON \(\d+ characters; content not shown\)/],
      [cli(backup('latest')), /is a latest backup, not phase4b/],
      [cli(backup('phase4b', { migrations: LISTS.latest })), /18 migrations are not a known phase4b state \(6, by ID and order\)/],
      [cli(backup('phase4b', { counts: { ...backup().counts as object, teams: 5 } })), /teams: 1 rows but the backup recorded 5/],
      ['[]', /expected exactly 1 row/],
    ] as const) {
      const s = sandbox()
      const r = s.take([...ok, '--out-dir', s.out], { out })
      expect(r.status, out.slice(0, 30)).toBe(1)
      expect(r.stderr).toMatch(re)
      expect(r.stderr).not.toContain('secret')
      expect(existsSync(s.out) ? readdirSync(s.out) : []).toEqual([])
    }
  })

  it('wrong target or place -> refused before running anything', () => {
    const s = sandbox()
    const text = cli(backup())
    expect(s.take(['--kind', 'phase4b', '--project-ref', OTHER_REF, '--out-dir', s.out], { out: text }).stderr).toMatch(/linked project is not/)
    expect(s.take(['--kind', 'phase4b', '--out-dir', s.out], { out: text }).stderr).toMatch(/exactly one of --project-ref/)
    const inRepo = join(fakeRepo(), 'backups')
    expect(s.take([...ok, '--out-dir', inRepo], { out: text }).stderr).toMatch(/inside a git repository/)
    expect(existsSync(inRepo)).toBe(false)                              // not even the folder is created
    const open = join(s.root, 'open'); mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755)
    expect(s.take([...ok, '--out-dir', open], { out: text }).stderr).toMatch(/open to other users/)
    expect(readdirSync(open)).toEqual([])
  })

  it('never overwrites an earlier backup', () => {
    const s = sandbox()
    const text = cli(backup())
    expect(s.take([...ok, '--out-dir', s.out], { out: text }).status).toBe(0)
    const first = readdirSync(s.out)
    // same second -> same name -> exclusive create fails, the first one stays untouched
    const again = s.take([...ok, '--out-dir', s.out], { out: cli(backup('phase4b', { auth_users_count: 2 })) })
    if (again.status !== 0) {
      expect(again.stderr).toMatch(/could not save the backup \(EEXIST\); nothing new was kept/)
      expect(readdirSync(s.out)).toEqual(first)
    } else {
      expect(readdirSync(s.out)).toHaveLength(4)                        // a new second: a second pair, the first unchanged
    }
    expect(readFileSync(join(s.out, first.find((f) => f.endsWith('.json'))!), 'utf8')).toBe(text)
  })
})

describe('build-restore-sql.mjs', () => {
  function setup(content: string) {
    const dir = mkdtempSync(join(tmpdir(), 'bk-build-'))
    chmodSync(dir, 0o700)
    const f = join(dir, 'tables.json'); writeFileSync(f, content)
    return { dir, f, out: join(dir, 'out.sql') }
  }

  it('SHA-256: a match writes the SQL; a mismatch writes nothing; commit requires it', () => {
    const text = cli(backup())
    const { f, out } = setup(text)
    const good = build([f, out, 'plan', '--expect-sha256', sha256(text)])
    expect(good.status, good.stderr).toBe(0)
    expect(good.stdout).toContain('(matches --expect-sha256)')
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const o2 = out + '2'
    const bad = build([f, o2, 'plan', '--expect-sha256', sha256(text + ' ')])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/does not match --expect-sha256.*nothing was written/)
    expect(existsSync(o2)).toBe(false)
    expect(build([f, o2, 'commit', '--expect-missing-teams', '1']).stderr).toMatch(/commit needs --expect-sha256/)
    expect(build([f, o2, 'plan', '--expect-sha256', 'abc']).stderr).toMatch(/64 lowercase hex/)
    const c = build([f, o2, 'commit', '--expect-sha256', sha256(text), '--expect-missing-teams', '1'])
    expect(c.status, c.stderr).toBe(0)
    expect(readFileSync(o2, 'utf8')).toContain("v_mode   text := 'commit'")
  })

  it('invalid JSON: the error never shows the content and has no stack trace', () => {
    const { f, out } = setup(`{"teams": [{"name": "${SECRET}", `)
    const r = build([f, out, 'plan'])
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toMatch(/^error: the backup is not valid JSON \(\d+ characters; content not shown\)/)
    expect(r.stderr).not.toContain('secret')
    expect(r.stderr).not.toMatch(/\bat \w+ \(|node:internal/)
    expect(existsSync(out)).toBe(false)
  })

  it('a backup inside a git repository, or output into one, is refused (nothing read or written)', () => {
    const { f, dir } = setup(cli(backup()))
    const r = fakeRepo()
    writeFileSync(join(r, 'tables.json'), cli(backup()))
    const res = build([join(r, 'tables.json'), join(dir, 'x.sql'), 'plan'])
    expect(res.stderr).toMatch(/backup that lies inside a git repository/)
    expect(existsSync(join(dir, 'x.sql'))).toBe(false)
    expect(build([f, join(r, 'sub', 'restore-plan.sql'), 'plan']).stderr).toMatch(/restore SQL inside a git repository/)
    expect(existsSync(join(r, 'sub', 'restore-plan.sql'))).toBe(false)
  })
})

describe('scan-export-for-data.mjs (public export guard)', () => {
  const b = backup()
  it('finds data by name, folder, JSON structure and content — and only reports paths', () => {
    const d = mkdtempSync(join(tmpdir(), 'export-'))
    mkdirSync(join(d, 'docs')); mkdirSync(join(d, 'team-attendance-backups'))
    const put = (p: string, c: string) => writeFileSync(join(d, p), c)
    put('tables-phase4b-20261120-000000.json', '{}')                                  // name
    put('team-attendance-backups/x.txt', 'anything')                                  // folder
    put('docs/data.json', JSON.stringify(b))                                          // structure (innocent name)
    put('docs/cli-copy.txt', cli(b) + ' '.repeat(200))                                // structure in a non-.json file
    const tag = '$bk_' + '0123456789ab' + '$'                                         // (built here so this file is not a hit)
    put('docs/run.sql', `do $$ begin perform ${tag}${JSON.stringify(b)}${tag}; end $$;`)  // embedded backup
    put('docs/notes.md', 'memo\nfailed to execute query: error: USAGE_REPORT（読み取り専用・ロールバック済み）\n== 0. schema state\n')
    put('docs/x.sha256', 'abc  y.json\n')
    put('docs/fine.json', JSON.stringify({ name: 'app', scripts: {} }))
    const found = scanFolder(d) as { path: string; why: string }[]
    expect(found.map((f) => f.path).sort()).toEqual(['docs/cli-copy.txt', 'docs/data.json', 'docs/notes.md', 'docs/run.sql', 'docs/x.sha256',
      'tables-phase4b-20261120-000000.json', 'team-attendance-backups'])
    expect(JSON.stringify(found)).not.toContain('secret')
    const r = spawnSync('node', [ops('scan-export-for-data.mjs'), d], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).not.toContain('secret')
  })

  it('this tree itself (repository or public export: scripts, template, tests) holds no data', () => {
    expect(scanFolder(repo)).toEqual([])
  })

  it('.gitignore keeps backups, checksums, restore SQL and usage reports out, but not the scripts', () => {
    // evaluated in a fresh git repository holding only this tree's .gitignore (works with or without .git here)
    const r = mkdtempSync(join(tmpdir(), 'ignore-check-'))
    expect(spawnSync('git', ['init', '-q'], { cwd: r }).status).toBe(0)
    writeFileSync(join(r, '.gitignore'), readFileSync(join(repo, '.gitignore'), 'utf8'))
    const ignored = (name: string) => spawnSync('git', ['check-ignore', '-q', '--no-index', name], { cwd: r }).status
    for (const name of ['tables-latest-20261120-000000.json', 'x.json.sha256', 'usage.txt', 'restore-plan.sql', 'plan.sql', 'team-attendance-backups/a.json']) {
      expect(ignored(name), name).toBe(0)
    }
    for (const name of ['scripts/ops/backup_tables.sql', 'scripts/ops/restore_app_data.template.sql', 'scripts/ops/take-backup.mjs', 'package.json']) {
      expect(ignored(name), name).toBe(1)
    }
  })
})

describe.runIf(DEV_REPO)('development repository only (scripts/export-public.sh is not exported)', () => {
  it('export-public.sh runs the data scan on the exported tree and removes the tree on a hit', () => {
    const sh = readFileSync(join(repo, 'scripts/export-public.sh'), 'utf8')
    expect(sh).toMatch(/if ! node "\$repo\/scripts\/ops\/scan-export-for-data\.mjs" "\$target"; then\n.*rm -rf "\$target"; exit 1/)
  })

  it('export-public.sh also refuses words from the internal deny list (real names), source and built site', () => {
    const sh = readFileSync(join(repo, 'scripts/export-public.sh'), 'utf8')
    const list = join(repo, 'docs/internal/ops/public-denylist.txt')
    expect(existsSync(list)).toBe(true)
    expect(readFileSync(list, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length).toBeGreaterThan(0)
    expect(sh).toContain('deny="$repo/docs/internal/ops/public-denylist.txt"')
    expect(sh).toMatch(/grep -rIlF -f <\(grep -v -e '\^#' -e '\^\[\[:space:\]\]\*\$' "\$deny"\) "\$target"/)
    expect(sh).toMatch(/grep -rIlF -f <\(grep -v -e '\^#' -e '\^\[\[:space:\]\]\*\$' "\$deny"\) "\$site"/)
    // the deny-list words really occur nowhere in what would be exported (tracked files outside the export-ignored paths)
    const words = readFileSync(list, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    const files = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n')
      .filter((f) => f && !/^(docs\/internal\/|\.claude\/|\.gitattributes$|scripts\/(export|sync)-public\.sh$)/.test(f) && existsSync(join(repo, f)))
    const hits = files.filter((f) => { const t = readFileSync(join(repo, f), 'utf8'); return words.some((w) => t.includes(w)) })
    expect(hits).toEqual([])
  })
})
