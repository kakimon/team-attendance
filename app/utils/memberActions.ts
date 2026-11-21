// 除外前の影響（removal_preview）から、オーナーに出す次の操作を決める。表示の判断だけで、
// 実際に除外できるかは常にサーバー（remove_member）が判定する。
import type { MemberImpact } from './types'

/**
 * 'suspend': the person has a self registration -> removal is never possible (D6-B1), offer access
 *            suspension instead, whether or not there are registrations only they answer for.
 * 'blocked': registrations only they answer for -> removal refused until another responder is added.
 * 'remove' : removal can go ahead (after the confirmation).
 */
export function removalRoute(impact: MemberImpact): 'suspend' | 'blocked' | 'remove' {
  if (impact.self_registrations.length) return 'suspend'
  if (impact.sole_guardian_children.length) return 'blocked'
  return 'remove'
}
