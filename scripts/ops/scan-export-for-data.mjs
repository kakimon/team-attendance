// Refuses an export folder (or any folder) that contains production data from the operations scripts:
// backups, restore SQL with an embedded backup, checksums, usage reports, or files under a backup folder.
// It looks at file NAMES, LOCATIONS, JSON STRUCTURE and CONTENT, not at one fixed string.
//
//   node scripts/ops/scan-export-for-data.mjs <folder>      -> exit 0 clean, exit 1 with the offending paths (never content)
//
// Used by scripts/export-public.sh on the exported tree.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '.nuxt', '.output', '.data', '.nitro', '.cache', 'dist'])
const NAME_RULES = [
  [/^tables.*\.json$/i, 'backup file name'],
  [/\.sha256$/i, 'checksum file'],
  [/^usage.*\.(txt|log|out)$/i, 'usage report file name'],
  [/^(?!.*\.template\.sql$)((r|restore)[-_].*\.sql|(.*[-_])?(plan|commit)\.sql)$/i, 'generated restore SQL name'],
]
const BACKUP_KEYS = ['teams', 'team_members', 'players', 'player_guardians', 'events', 'attendance']

/** A JSON value that looks like a backup (any of the shapes the CLI or the scripts produce). */
export function looksLikeBackup(v, depth = 0) {
  if (depth > 3 || v === null || typeof v !== 'object') return false
  if (typeof v === 'string') return false
  if (Array.isArray(v)) return v.some((x) => looksLikeBackup(x, depth + 1))
  if (BACKUP_KEYS.filter((k) => Array.isArray(v[k])).length >= 3) return true
  if (v.format === 3 && (v.kind === 'phase4b' || v.kind === 'latest')) return true
  if ('backup' in v) {
    let b = v.backup
    if (typeof b === 'string') { try { b = JSON.parse(b) } catch { return false } }
    return looksLikeBackup(b, depth + 1)
  }
  return Array.isArray(v.rows) && looksLikeBackup(v.rows, depth + 1)
}

const CONTENT_RULES = [
  [/\$bk_[0-9a-f]{12}\$/, 'restore SQL with an embedded backup'],
  [/^(failed to execute query: error: )?USAGE_REPORT（/m, 'usage report output'],
  [/^USAGE_REPORT_(COMPLETE|INCOMPLETE)\b/m, 'usage report output'],
  [/^(failed to execute query: error: )?RESTORE_PLAN（/m, 'restore plan output'],
  [/^== [0-6]\. (schema state|Auth|teams|registrations|events and answers|activity|open procedures)/m, 'usage report output'],
]

export function scanFolder(root) {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      const rel = relative(root, p)
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        if (/team-attendance-backups|(^|[-_])backups?$/i.test(name)) { found.push([rel, 'backup folder']); continue }
        walk(p)
        continue
      }
      for (const [re, why] of NAME_RULES) if (re.test(name)) found.push([rel, why])
      if (st.size > 20 * 1024 * 1024) continue
      const buf = readFileSync(p)
      if (buf.includes(0)) continue                                     // binary
      const text = buf.toString('utf8')
      if (/\.json$/i.test(name)) {
        try { if (looksLikeBackup(JSON.parse(text))) found.push([rel, 'backup JSON structure']) } catch { /* not JSON: content rules below */ }
      } else if (/^\s*[[{]/.test(text) && text.length > 200) {
        try { if (looksLikeBackup(JSON.parse(text))) found.push([rel, 'backup JSON structure']) } catch { /* not JSON */ }
      }
      for (const [re, why] of CONTENT_RULES) if (re.test(text)) found.push([rel, why])
    }
  }
  walk(root)
  const seen = new Set()
  return found.filter(([p, w]) => !seen.has(p + w) && seen.add(p + w)).map(([p, w]) => ({ path: p.split(sep).join('/'), why: w }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: scan-export-for-data.mjs <folder>'); process.exit(2) }
  const found = scanFolder(dir)
  if (found.length) {
    for (const f of found) console.error(`  ${f.path}  (${f.why})`)
    console.error('運用データ（バックアップ・復元 SQL・利用状況の出力など）と思われるファイルがあります（上記。内容は表示していません）。')
    process.exit(1)
  }
  console.log('OK: no backup / restore / usage-report data')
}
