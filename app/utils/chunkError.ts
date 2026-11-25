// A build file (/_nuxt/<hash>.js|css) that could not be loaded: typically the page was opened with an older
// index.html than the files now deployed, or right while a deploy was propagating. Browser wordings differ.
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk \S+ failed/i

export function isChunkLoadError(e: unknown): boolean {
  const message = typeof e === 'string' ? e : (e as { message?: unknown } | null)?.message
  return typeof message === 'string' && CHUNK_ERROR.test(message)
}
