// アカウント画面のお問い合わせ: the operator's e-mail address is not shown (spam), all inquiries go to the form.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(import.meta.dirname, '../../app/pages/account/index.vue'), 'utf8')

describe('account page contact card', () => {
  it('shows no e-mail address and no mailto link', () => {
    expect(src).not.toMatch(/PRIVACY_EMAIL|mailto:|@gmail\.com/)
  })

  it('keeps the form link, now also for personal-data requests', () => {
    expect(src).toMatch(/:href="CONTACT_FORM_URL" target="_blank" rel="noopener noreferrer"/)
    expect(src).toContain('ご質問・不具合・個人情報に関するお問い合わせ')
  })

  it('leaves the account deletion entry and its explanation as they were', () => {
    expect(src).toContain('to="/account/delete"')
    expect(src).toContain('アカウントを削除（退会）')
    expect(src).toContain('退会はこの画面からご自身でできます（運営者への連絡は不要です）。')
  })
})
