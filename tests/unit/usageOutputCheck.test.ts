// scripts/ops/check-usage-output.mjs: one decision for the saved output of usage-inventory.sql, whether the CLI printed
// plain lines (--local) or one JSON line (--linked / agent mode). Fictional report text only.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without type declarations
import { checkUsageOutput } from '../../scripts/ops/check-usage-output.mjs'

const SCRIPT = join(import.meta.dirname, '../../scripts/ops/check-usage-output.mjs')
const HEADER = 'USAGE_REPORT（読み取り専用・ロールバック済み）'
const body = (end = 'USAGE_REPORT_COMPLETE sections=7/7', drop?: string) => [
  `${HEADER}`,
  '== 0. schema state', 'migrations applied: 6',
  '== 1. Auth', 'users: 3 | created last 30d: 3 | last 90d: 3',
  '== 2. teams (numbered by creation time; no names)', 'teams: 1',
  '== 3. registrations', 'registrations: 3',
  '== 4. events and answers', 'events: 2',
  '== 5. activity in the last 30 / 90 days', 'joined a team: 3 / 3',
  '== 6. open procedures', 'owner hand-over requests: 0 | still valid: 0',
  end,
].filter((l) => !drop || !l.startsWith(drop)).join('\n')
const local = (b = body()) => `Connecting to local database...\nfailed to execute query: error: ${b}\nTry rerunning the command with --debug to troubleshoot the error.\n`
const linked = (b = body()) => `Initialising login role...\nunexpected status 400: ${JSON.stringify({ message: `Failed to run sql query: ERROR:  P0001: ${b}\nCONTEXT:  PL/pgSQL function inline_code_block line 135 at RAISE\n` })}\nTry rerunning the command with --debug to troubleshoot the error.\n`
const agent = (b = body()) => JSON.stringify({ _tag: 'Error', error: { code: 'DbQueryExecError', message: `failed to execute query: error: ${b}` } })
const check = (out: string, code?: number) => checkUsageOutput(out, code) as { ok: boolean; reason: string }

describe('check-usage-output.mjs', () => {
  it('a complete report is OK in all three CLI formats', () => {
    for (const out of [local(), linked(), agent()]) expect(check(out, 1)).toEqual({ ok: true, reason: expect.stringMatching(/complete report/) })
  })

  it('the documented line check really fails on the --linked format (why this script exists)', () => {
    expect(linked().split('\n')).not.toContain('USAGE_REPORT_COMPLETE sections=7/7')
    expect(check(linked()).ok).toBe(true)
  })

  it('INCOMPLETE, a missing / duplicated / misplaced marker, a missing section are refused', () => {
    for (const make of [local, linked]) {
      expect(check(make(body('USAGE_REPORT_INCOMPLETE unavailable=1'))).reason).toMatch(/INCOMPLETE/)
      expect(check(make(body(''))).reason).toMatch(/completion marker is missing/)
      expect(check(make(body('USAGE_REPORT_COMPLETE sections=7/7\nUSAGE_REPORT_COMPLETE sections=7/7'))).reason).toMatch(/more than once/)
      expect(check(make(body('USAGE_REPORT_COMPLETE sections=6/7'))).reason).toMatch(/marker is missing/)
      expect(check(make(body(undefined, '== 4.'))).reason).toMatch(/sections missing or repeated: 4/)
      const moved = body().replace('USAGE_REPORT_COMPLETE sections=7/7', '').replace('== 3. registrations', 'USAGE_REPORT_COMPLETE sections=7/7\n== 3. registrations')
      expect(check(make(moved)).reason).toMatch(/not after section 6/)
    }
  })

  it('an unexpected error (no report at all) is refused even with exit code 1', () => {
    expect(check('Connecting...\nfailed to execute query: error: canceling statement due to statement timeout\n', 1).reason).toMatch(/no report header/)
    expect(check(`unexpected status 400: ${JSON.stringify({ message: 'Failed to run sql query: ERROR:  permission denied for table teams' })}`, 1).reason).toMatch(/no report header/)
    expect(check('', 1).ok).toBe(false)
  })

  it('exit code: never the success condition; 0 or another code is refused', () => {
    expect(check(local(), 0).reason).toMatch(/exit code was 0/)
    expect(check(local(), 2).ok).toBe(false)
    expect(check(local(), 1).ok).toBe(true)
  })

  it('broken JSON is refused without showing anything of it (no names, e-mails, tokens)', () => {
    const secret = 'secret-山田 taro@example.test tok_ABCDEF0123456789'
    const broken = `unexpected status 400: {"message":"Failed to run sql query: ERROR:  P0001: USAGE_REPORT（x）\\n${secret}\\n`   // cut off
    const r = check(broken, 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not valid JSON .*content not shown/)
    expect(r.reason).not.toMatch(/secret|example|tok_/)
    const wrongShape = `unexpected status 400: ${JSON.stringify({ msg: `USAGE_REPORT ${secret}` })}`
    expect(check(wrongShape).reason).not.toMatch(/secret|example|tok_/)
    // the CLI form prints only "NG: <reason>"
    const dir = mkdtempSync(join(tmpdir(), 'usage-check-'))
    writeFileSync(join(dir, 'usage.txt'), broken)
    const p = spawnSync('node', [SCRIPT, join(dir, 'usage.txt'), '--exit-code', '1'], { encoding: 'utf8' })
    expect(p.status).toBe(1)
    expect(p.stderr.trim()).toMatch(/^NG: .*content not shown/)
    expect(p.stdout + p.stderr).not.toMatch(/secret|example|tok_|at \w+ \(/)
  })

  it('two runs in one file are refused', () => {
    expect(check(local() + local()).reason).toMatch(/2 report headers/)
    expect(check(linked() + linked()).reason).toMatch(/2 JSON reports/)
  })

  it('the CLI only reads the file (content and mode unchanged) and exits 0 only when complete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-check-'))
    const f = join(dir, 'usage.txt')
    writeFileSync(f, linked(), { mode: 0o600 })
    const before = [readFileSync(f, 'utf8'), statSync(f).mode, statSync(f).mtimeMs]
    const p = spawnSync('node', [SCRIPT, f, '--exit-code', '1'], { encoding: 'utf8' })
    expect(p.status, p.stderr).toBe(0)
    expect(p.stdout).toMatch(/^OK: complete report/)
    expect([readFileSync(f, 'utf8'), statSync(f).mode, statSync(f).mtimeMs]).toEqual(before)
    writeFileSync(f, linked(body('USAGE_REPORT_INCOMPLETE unavailable=2')))
    expect(spawnSync('node', [SCRIPT, f], { encoding: 'utf8' }).status).toBe(1)
  })
})
