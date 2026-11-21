// 回答する人（本人登録・代理登録）の表示用の判断。純粋関数（I/O なし）。
// 表示の便宜だけで、権限の判断には使わない（だれが何をできるかは常にサーバーが決める）。
import { isSimilarName } from './normalizeName'
import type { Player, TeamSnapshot } from './types'

/** A registration of a person who answers for themself (Phase 5-B D3.5). */
export const isSelfRegistration = (p: Player) => !!p.is_self || !!p.self_user_id

/** My own self registration in this team (active ones only), or undefined. */
export const mySelfRegistration = (s: TeamSnapshot): Player | undefined =>
  s.players.find((p) => !!p.self_user_id && p.self_user_id === s.me.user_id)

/** People I answer for (my self registration first, then the others in registration order). */
export function myParticipants(s: TeamSnapshot): Player[] {
  const mine = s.players.filter((p) => s.myPlayerIds.includes(p.id))
  const self = mySelfRegistration(s)
  return self ? [self, ...mine.filter((p) => p.id !== self.id)] : mine
}

/** Show the "register myself" entry: the DB supports it and I am not registered yet. */
export const canRegisterSelf = (s: TeamSnapshot) => s.selfSupported && !mySelfRegistration(s)

/**
 * Registrations (made by someone else, as a proxy) whose name looks like my team display name:
 * maybe a family member already registered me. Warning only; the person decides.
 */
export const similarToMe = (s: TeamSnapshot): Player[] =>
  s.players.filter((p) => !isSelfRegistration(p) && isSimilarName(p.name, s.me.display_name))

export interface ParticipantBadge { label: string; tone: 'primary' | 'neutral' }
/** Badge next to a name in lists: whose registration it is, from my point of view. */
export function participantBadge(s: TeamSnapshot, p: Player): ParticipantBadge | null {
  if (p.self_user_id && p.self_user_id === s.me.user_id) return { label: 'あなた（本人）', tone: 'primary' }
  if (isSelfRegistration(p)) return { label: '本人', tone: 'neutral' }
  if (s.myPlayerIds.includes(p.id)) return { label: 'あなたが回答', tone: 'primary' }
  return null
}
