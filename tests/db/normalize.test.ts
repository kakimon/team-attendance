// The client-side similar-name check must match private.normalize_name() in SQL.
import { beforeAll, expect, it } from 'vitest'
import { normalizeName } from '../../app/utils/normalizeName'
import { createDb, type Db } from './setup'

let db: Db
beforeAll(async () => { db = await createDb() })

it.each(['山田 太郎', 'ヤマダ　タロウ', 'ｽｽﾞｷ ｲﾁﾛｳ', 'ＡＢＣ　ｄｅｆ', 'ヴィヴィ', 'すずき いちろう', ' 田中 ゆうと '])(
  'TS and SQL normalize %s the same way', async (s) => {
    const { rows } = await db.query<{ n: string }>('select private.normalize_name($1) as n', [s])
    expect(normalizeName(s)).toBe(rows[0]!.n)
  })
