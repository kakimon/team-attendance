// The top page's usage numbers: fetched at most once an hour per browser (cached in localStorage),
// so visitors do not query the database on every page view. Storage problems never break the page.
import type { ServiceStats } from './types'

export const STATS_TTL_MS = 60 * 60 * 1000
const KEY = 'service-stats:v1'

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined
type Cached = { at: number; stats: ServiceStats }

function read(store: Store): Cached | null {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? 'null') as Cached | null
    const s = v?.stats
    return v && typeof v.at === 'number' && s && [s.users, s.teams, s.answers].every((n) => Number.isFinite(n) && n >= 0) ? v : null
  } catch { return null }
}

/**
 * Fresh cache -> no request. Otherwise ask the server; on failure fall back to an older cached value
 * (or null: the page then simply hides the numbers).
 */
export async function loadServiceStats(fetchStats: () => Promise<ServiceStats | null>, store: Store, now = Date.now()): Promise<ServiceStats | null> {
  const cached = read(store)
  if (cached && now - cached.at < STATS_TTL_MS && now >= cached.at) return cached.stats
  try {
    const stats = await fetchStats()
    if (!stats) return null
    try { store?.setItem(KEY, JSON.stringify({ at: now, stats } satisfies Cached)) } catch { /* private mode etc. */ }
    return stats
  } catch {
    return cached?.stats ?? null
  }
}

/** 1234 -> "1,234" */
export const formatCount = (n: number) => Math.max(0, Math.floor(n)).toLocaleString('ja-JP')
