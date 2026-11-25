// Family invitation state for the settings screen (pure; the server decides what is really usable).
import type { ChildInvitation } from './types'

export type InvitationState = 'active' | 'used' | 'expired' | 'revoked'

export function invitationState(i: ChildInvitation, now = Date.now()): InvitationState {
  if (i.revoked_at) return 'revoked'
  if (i.used_at) return 'used'
  if (new Date(i.expires_at).getTime() <= now) return 'expired'
  return 'active'
}

export const INVITATION_STATE_LABEL: Record<InvitationState, string> = {
  active: '有効', used: '使用済み', expired: '期限切れ', revoked: '無効にした',
}

/** Active ones first (newest first), then the latest few finished ones. */
export function visibleInvitations(list: ChildInvitation[], now = Date.now(), finished = 3): ChildInvitation[] {
  const by = (a: ChildInvitation, b: ChildInvitation) => b.created_at.localeCompare(a.created_at)
  const active = list.filter((i) => invitationState(i, now) === 'active').sort(by)
  const done = list.filter((i) => invitationState(i, now) !== 'active').sort(by).slice(0, finished)
  return [...active, ...done]
}
