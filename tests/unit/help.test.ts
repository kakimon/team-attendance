// Phase 4-D stage 1: top page login destinations, help page content and links.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_TOPICS, FAQ, PARENT_TOPICS } from '../../app/utils/helpContent'
import { inviteKindOf, loginTarget } from '../../app/utils/loginTarget'

const APP = join(import.meta.dirname, '../../app')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(vue|ts)$/.test(n) ? [p] : []
  })
}
const appFiles = walk(APP)
const read = (f: string) => readFileSync(f, 'utf8')

describe('login destination (top page)', () => {
  it('an invitation always wins; "create a team" only without one', () => {
    expect(loginTarget('/t/abc', 'create')).toBe('/t/abc')
    expect(loginTarget('/invite/xyz', null)).toBe('/invite/xyz')
    expect(loginTarget('', 'create')).toBe('/teams/new')
    expect(loginTarget('', null)).toBe('/')
  })
  it('recognises team and family invitations only', () => {
    expect(inviteKindOf('/t/abc')).toBe('team')
    expect(inviteKindOf('/t/abc/answer')).toBe('team')
    expect(inviteKindOf('/invite/xyz')).toBe('family')
    expect(inviteKindOf('/teams/new')).toBeNull()
    expect(inviteKindOf('/account')).toBeNull()
    expect(inviteKindOf('')).toBeNull()
  })
  it('the top page passes the destination to the existing Google login (no new auth code)', () => {
    const src = read(join(APP, 'pages/index.vue'))
    expect(src).toContain('signInWithGoogle(loginTarget(redirect, intent))')
    expect(src).toContain("const redirect = safeRedirect(route.query.redirect, '')")
    expect(read(join(APP, 'composables/useAuth.ts'))).toContain("sessionStorage.setItem('auth:redirect', redirectPath)")
  })
})

describe('help page content', () => {
  it('has the required topics for parents and admins, in order', () => {
    expect(PARENT_TOPICS.map((t) => t.title)).toEqual([
      '招待リンクからチームに参加する', 'Google でログインする', '自分を登録して回答する（本人回答）',
      'お子さんなど家族を登録する（代理回答）', '予定を確認する', '出欠を回答する・変更する', '家族で一緒に回答する',
    ])
    expect(ADMIN_TOPICS.map((t) => t.title)).toEqual([
      'Google でログインする', '新しいチームを作成する', '招待リンクを共有する',
      '練習・試合などの予定を登録する', '出欠一覧を確認する', 'オーナー交代について',
    ])
  })

  it('FAQ contains every required question; the fee answer is the approved wording', () => {
    const qs = FAQ.map((f) => f.q)
    for (const q of ['利用料金はかかりますか？', 'チームへの参加方法は？', '招待リンクが開けない場合は？', '子どもを間違えて登録した場合は？',
      '父母で同じ子どもを管理できますか？', '子どもを二重登録してしまった場合は？', '出欠回答は後から変更できますか？',
      'スマートフォンを変更した場合は？', 'Google アカウントを変更した場合は？', 'チーム管理者を変更できますか？', 'アカウントを退会する方法は？',
      '大人だけのチームでも使えますか？', '「自分を登録する」と「家族などを登録する」の違いは？']) {
      expect(qs, q).toContain(q)
    }
    expect(FAQ.find((f) => f.id === 'price')!.a).toEqual(['現在、無料でご利用いただけます。'])
    expect(new Set(FAQ.map((f) => f.id)).size).toBe(FAQ.length)
  })

  it('every ［button / screen name］ mentioned in the help exists in the app screens', () => {
    const ui = appFiles.filter((f) => !f.endsWith('helpContent.ts')).map(read).join('\n')
    const all = [...PARENT_TOPICS, ...ADMIN_TOPICS].flatMap((t) => [...t.steps, t.note ?? '']).concat(FAQ.flatMap((f) => f.a))
    const names = new Set(all.flatMap((s) => [...s.matchAll(/［([^］]+)］/g)].map((m) => m[1]!)))
    expect(names.size).toBeGreaterThan(20)
    for (const n of names) expect(ui, `［${n}］ is not on any screen`).toContain(n)
  })

  it('does not present missing features as available, and does not push people into leaving', () => {
    const text = JSON.stringify({ PARENT_TOPICS, ADMIN_TOPICS, FAQ })
    expect(text).toContain('管理者を増やしたり、メンバーの役割を変えたりする画面は、現在ありません')
    const owner = ADMIN_TOPICS.find((t) => t.id === 'owner')!
    expect(owner.steps.join('')).toContain('依頼するだけでは退会になりません')
    expect(owner.note).toContain('「退会する」の入力には進まないでください')
    expect(text).not.toMatch(/https?:\/\/|\/terms|\/privacy|\/contact|利用規約|プライバシーポリシー/)
  })
})

describe('links and pages', () => {
  it('/help is public, and the 4 team tabs are unchanged', () => {
    expect(read(join(APP, 'pages/help.vue'))).toContain('definePageMeta({ public: true })')
    const tabs = read(join(APP, 'components/TeamTabs.vue'))
    for (const l of ["label: '出欠一覧'", "label: '出欠入力'", "label: '回答する人'", "label: '管理'"]) expect(tabs).toContain(l)
    expect((tabs.match(/label: '/g) ?? []).length).toBe(4)
  })

  it('every static in-app link points to an existing page (outside the legal drafts)', () => {
    const pages = walk(join(APP, 'pages')).map((f) => relative(join(APP, 'pages'), f).replace(/\.vue$/, ''))
    const exists = (path: string) => {
      const clean = path.split(/[?#]/)[0]!.replace(/\/$/, '') || '/'
      if (clean === '/') return pages.includes('index')
      const want = clean.slice(1)
      return pages.some((p) => p === want || p === `${want}/index`)
    }
    const bad: string[] = []
    for (const f of appFiles) {
      if (/app\/(legal|components\/legal)\/|pages\/(terms|privacy|contact)\.vue$/.test(f)) continue
      for (const m of read(f).matchAll(/\bto="(\/[^"]*)"/g)) if (!exists(m[1]!)) bad.push(`${relative(APP, f)} -> ${m[1]}`)
    }
    expect(bad).toEqual([])
    expect(existsSync(join(APP, 'pages/help.vue'))).toBe(true)
  })

  it('the footer and account menu link to /help; no legal link was added', () => {
    for (const f of ['components/LegalFooter.vue', 'components/AccountMenu.vue']) {
      const src = read(join(APP, f))
      expect(src).toContain('to="/help"')
      expect(src).not.toMatch(/to="\/(terms|privacy|contact)"/)
    }
  })
})
