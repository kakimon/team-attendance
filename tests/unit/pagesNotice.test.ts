// Old address (GitHub Pages) after the move: the workflow publishes only the notice page, only by hand,
// never with a placeholder; pushing / syncing the public repository never deploys anything to GitHub Pages.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
// @ts-expect-error plain ESM script without type declarations
import { checkNewUrl, renderNotice } from '../../pages-notice/build.mjs'

const repo = join(import.meta.dirname, '../..')
const WF_TEXT = readFileSync(join(repo, '.github/workflows/deploy-pages.yml'), 'utf8')
const wf = parse(WF_TEXT)
const TEMPLATE = readFileSync(join(repo, 'pages-notice/index.template.html'), 'utf8')
const NEW = 'https://team-attendance.sample-sub.workers.dev'

describe('GitHub Pages workflow (old address)', () => {
  it('is valid YAML with a manual trigger only: no push / schedule / pull request / release / workflow_run', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch'])
    expect(wf.on.workflow_dispatch.inputs.new_url).toMatchObject({ required: true, type: 'string' })
    expect(WF_TEXT).not.toMatch(/^\s*(push|schedule|pull_request|pull_request_target|release|workflow_run)\s*:/m)
  })

  it('builds only the notice page (never the app) and passes the URL through an env var, not inline', () => {
    const steps = wf.jobs.build.steps as { run?: string; env?: Record<string, string>; uses?: string }[]
    const runs = steps.map((s) => s.run ?? '').join('\n')
    expect(runs).toContain('node pages-notice/build.mjs "$NEW_URL" _site')
    expect(runs).not.toMatch(/npm (ci|run|test)|nuxt (generate|build)|\.output\/public/)
    expect(runs).not.toContain('${{')                                   // no expression injected into a shell line
    expect(steps.find((s) => s.run?.includes('build.mjs'))!.env).toEqual({ NEW_URL: '${{ inputs.new_url }}' })
    expect(steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact'))).toMatchObject({ with: { path: '_site' } })
    expect(WF_TEXT).not.toMatch(/SUPABASE|vars\./)                       // no app configuration needed or exposed
    expect(wf.permissions).toEqual({ contents: 'read' })
    expect(wf.jobs.deploy.permissions).toEqual({ pages: 'write', 'id-token': 'write' })
  })
})

describe('notice page', () => {
  it('the template keeps the placeholder (the real URL is set only when building)', () => {
    expect(TEMPLATE.match(/__NEW_URL__/g)!.length).toBeGreaterThanOrEqual(2)
    expect(TEMPLATE).toMatch(/MUST be set before publishing/)
  })

  it('refuses a placeholder, http, example / local / old address, query, fragment, credentials or odd characters', () => {
    for (const bad of ['__NEW_URL__', '', 'http://minna.app', 'https://example.com', 'https://x.invalid', 'https://localhost',
      'https://kakimon.github.io/team-attendance', 'https://minna.app/?a=1', 'https://minna.app/#x', 'https://u:p@minna.app',
      'https://minna.app/"><script>', 'javascript:alert(1)']) {
      expect(() => checkNewUrl(bad), bad).toThrow()
    }
    expect(checkNewUrl(NEW)).toBe(NEW + '/')
    expect(checkNewUrl('https://minna.app')).toBe('https://minna.app/')
  })

  it('renders the move notice with the new URL: mobile viewport, no-referrer, noindex, steps; no names or internal details', () => {
    const html = renderNotice(TEMPLATE, NEW)
    expect(html).not.toContain('__NEW_URL__')
    expect(html).toContain(`href="${NEW}/"`)
    expect(html).toMatch(/<meta name="viewport" content="width=device-width/)
    expect(html).toMatch(/<meta name="referrer" content="no-referrer">/)
    expect(html).toMatch(/<meta name="robots" content="noindex">/)
    expect(html).toContain('新しいURLに移りました')
    expect(html).toMatch(/<ol>[\s\S]*Google アカウント[\s\S]*<\/ol>/)
    expect(html).not.toMatch(/<script|supabase|kakimon|imagimo\.work|@gmail|docs\/internal|ztlpsi/i)
  })

  it('the build script writes exactly index.html, 404.html and .nojekyll, and exits non-zero without a real URL', () => {
    const out = mkdtempSync(join(tmpdir(), 'notice-'))
    const ok = spawnSync('node', [join(repo, 'pages-notice/build.mjs'), NEW, out], { encoding: 'utf8' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(readdirSync(out).sort()).toEqual(['.nojekyll', '404.html', 'index.html'])
    expect(readFileSync(join(out, '404.html'), 'utf8')).toBe(readFileSync(join(out, 'index.html'), 'utf8'))
    const out2 = mkdtempSync(join(tmpdir(), 'notice-'))
    const bad = spawnSync('node', [join(repo, 'pages-notice/build.mjs'), '__NEW_URL__', out2], { encoding: 'utf8' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/^error: /)
    expect(readdirSync(out2)).toEqual([])
  })
})
