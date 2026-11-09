// Local stand-in for GitHub Pages (project site) to test a build before deploying.
//   NUXT_APP_BASE_URL=/team-attendance/ npm run generate
//   node scripts/pages-preview.mjs [base=/team-attendance/] [port=4173]
// Behaviour copied from GitHub Pages: exact file -> 200; directory without slash ->
// 301 to slash (query kept); directory/index.html -> 200; anything else -> 404.html with 404.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const base = (process.argv[2] ?? '/team-attendance/').replace(/\/?$/, '/')
const port = Number(process.argv[3] ?? 4173)
const root = join(process.cwd(), '.output/public')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }

const send = (res, status, file) => {
  res.writeHead(status, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}

createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  // LOG_REFERER=1: print any Referer the browser sends (should never appear: no-referrer policy)
  if (process.env.LOG_REFERER && req.headers.referer) console.log(`REFERER ${req.headers.referer} -> ${u.pathname}`)
  const notFound = () => send(res, 404, join(root, '404.html'))
  if (!u.pathname.startsWith(base) && u.pathname !== base.slice(0, -1)) return notFound()
  const rel = decodeURIComponent(u.pathname.slice(base.length - 1))
  const file = normalize(join(root, rel))
  if (!file.startsWith(root)) return notFound()
  if (existsSync(file) && statSync(file).isFile()) return send(res, 200, file)
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!u.pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${u.pathname}/${u.search}` })
      return res.end()
    }
    if (existsSync(join(file, 'index.html'))) return send(res, 200, join(file, 'index.html'))
  }
  return notFound()
}).listen(port, () => console.log(`GitHub Pages preview: http://localhost:${port}${base}`))
