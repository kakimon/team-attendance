// The team display name, checked the same way as the database (accept_guardian_invitation):
// spaces / full-width spaces around it are removed, then it must be 1-40 characters.
export const DISPLAY_NAME_MAX = 40

export const normalizeDisplayName = (v: string | null | undefined) => (v ?? '').replace(/^[\s　]+|[\s　]+$/g, '')

/** null when the name can be sent; otherwise the error code shown next to the field. */
export function displayNameError(v: string | null | undefined): 'name_required' | 'display_name_too_long' | null {
  const n = normalizeDisplayName(v)
  if (!n) return 'name_required'
  if ([...n].length > DISPLAY_NAME_MAX) return 'display_name_too_long'
  return null
}
