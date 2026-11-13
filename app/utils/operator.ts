// Operator / contact details shown on the public pages (confirmed by the operator).
export const SERVICE_NAME = 'みんなの出欠'
export const OPERATOR_NAME = 'Imagimo（イマジモ）'
/** General questions, bug reports (Google Forms). */
export const CONTACT_FORM_URL = 'https://forms.gle/qp3Vs6sSog2GkSG97'
/** Personal-data requests and account deletion (Imagimo's dedicated address, not a personal one). */
export const PRIVACY_EMAIL = 'imagimo.work@gmail.com'

/**
 * Terms / privacy policy are still drafts: production builds do not link to them and the
 * public export refuses them (or leaves them out with --without-legal-drafts).
 * Set to true only after every undecided item is settled (tests/unit/legal.test.ts enforces this).
 */
export const LEGAL_DOCS_FINAL = false
