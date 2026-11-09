// A tiny stand-in for supabase-js that runs queries in PGlite AS a given user
// (role authenticated + auth.uid()), with PostgREST-like result shapes.
// Lets tests run the real app/repo/supabaseRepo.ts against the real migrations.
import type { DbClient, DbQuery } from '../../app/repo/supabaseRepo'
import { asUser, type Db } from './setup'

const IDENT = /^[a-z_][a-z0-9_]*$/
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`bad identifier: ${s}`)
  return s
}
const toErr = (e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : String(e) } })

export function pgliteClient(db: Db, uid: string | null): DbClient {
  function from(table: string): DbQuery {
    let cols = '*'
    const where: string[] = []
    const params: unknown[] = []
    const orders: string[] = []
    const q: DbQuery = {
      select(c) { cols = c.split(',').map((x) => ident(x.trim())).join(', '); return q },
      eq(c, v) { params.push(v); where.push(`${ident(c)} = $${params.length}`); return q },
      is(c, _v) { where.push(`${ident(c)} is null`); return q },
      gte(c, v) { params.push(v); where.push(`${ident(c)} >= $${params.length}`); return q },
      in(c, v) { params.push(v); where.push(`${ident(c)} = any($${params.length})`); return q },
      order(c, o) { orders.push(`${ident(c)} ${o?.ascending === false ? 'desc' : 'asc'}`); return q },
      then(onF, onR) {
        const sql = `select ${cols} from public.${ident(table)}`
          + (where.length ? ` where ${where.join(' and ')}` : '')
          + (orders.length ? ` order by ${orders.join(', ')}` : '')
        return asUser(db, uid, () => db.query(sql, params))
          .then((r) => ({ data: JSON.parse(JSON.stringify(r.rows)), error: null }), toErr)
          .then(onF, onR)
      },
    }
    return q
  }

  async function rpc(fn: string, args: Record<string, unknown> = {}) {
    // Same return shapes as PostgREST: setof -> array, composite -> object, scalar -> value.
    const meta = await db.query<{ retset: boolean; typtype: string }>(
      `select p.proretset as retset, t.typtype from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
       where n.nspname = 'public' and p.proname = $1`, [ident(fn)])
    if (!meta.rows[0]) return toErr(new Error(`function ${fn} not found`))
    const { retset, typtype } = meta.rows[0]
    const keys = Object.keys(args)
    const call = `public.${fn}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`
    const values = keys.map((k) => args[k] ?? null)
    const sql = retset || typtype === 'c'
      ? `select to_jsonb(r) as v from ${call} r`
      : `select to_jsonb(${call}) as v`
    try {
      const r = await asUser(db, uid, () => db.query<{ v: unknown }>(sql, values))
      const rows = r.rows.map((x) => x.v)
      return { data: retset ? rows : (rows[0] ?? null), error: null }
    } catch (e) {
      return toErr(e)
    }
  }

  return { from, rpc }
}
