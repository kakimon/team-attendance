import type { Status, Summary, TeamSnapshot } from './types'

export function statusOf(s: TeamSnapshot, eventId: string, playerId: string): { status: Status; comment: string | null } {
  const a = s.attendance.find((x) => x.event_id === eventId && x.player_id === playerId)
  return a ? { status: a.status, comment: a.comment } : { status: 'unanswered', comment: null }
}

export function summaryOf(s: TeamSnapshot, eventId: string): Summary {
  const r: Summary = { attend: 0, absent: 0, undecided: 0, unanswered: 0, total: 0 }
  for (const p of s.players) {
    r[statusOf(s, eventId, p.id).status]++
    r.total++
  }
  return r
}

/** Apply a successful write locally (avoids a full reload). */
export function applyAttendance(s: TeamSnapshot, eventId: string, playerId: string, status: Status, comment: string | null) {
  const i = s.attendance.findIndex((x) => x.event_id === eventId && x.player_id === playerId)
  if (i >= 0) s.attendance.splice(i, 1)
  if (status !== 'unanswered') {
    s.attendance.push({ event_id: eventId, player_id: playerId, status, comment, updated_at: new Date().toISOString() })
  }
}

export const isAdminRole = (s: TeamSnapshot) => s.me.role === 'owner' || s.me.role === 'admin'
