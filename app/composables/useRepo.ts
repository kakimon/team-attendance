import type { Repo } from '~/utils/types'

export function useRepo(): Repo {
  const { $repo } = useNuxtApp()
  if (!$repo) throw new Error('Data layer is not configured')
  return $repo
}
