// DEMO ONLY data (dev server + NUXT_PUBLIC_DEMO_MODE=true). Fictional names only.
import type { Attendance, Guardian, Member, Player, Team, TeamEvent } from '../utils/types'

/** The demo team's id (a UUID like real team ids: the team page address is /t/<team id>). */
export const DEMO_TEAM_ID = '00000000-0000-4000-8000-00000000d001'
/** The demo team's join link token (owners / admins see it in 管理). */
export const DEMO_JOIN_TOKEN = 'demojoin'.repeat(4)

export const MOCK_USERS = [
  { id: 'u-coach', email: null, name: '監督（デモ）' },
  { id: 'u-tanaka-f', email: null, name: '田中 父（デモ）' },
  { id: 'u-tanaka-m', email: null, name: '田中 母（デモ）' },
  { id: 'u-sato', email: null, name: '佐藤 母（デモ）' },
  { id: 'u-new', email: null, name: '新規の保護者（デモ）' },
]

const day = (n: number, h = 9) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  d.setHours(h, 0, 0, 0)
  return d.toISOString()
}

export function createMockDb() {
  const team: Team = { id: DEMO_TEAM_ID, name: 'ひまわりジュニア（デモ）', share_token: 'demo' }
  const members: Member[] = [
    { team_id: DEMO_TEAM_ID, user_id: 'u-coach', role: 'owner', display_name: '監督' },
    { team_id: DEMO_TEAM_ID, user_id: 'u-tanaka-f', role: 'member', display_name: '田中（父）' },
    { team_id: DEMO_TEAM_ID, user_id: 'u-tanaka-m', role: 'member', display_name: '田中（母）' },
    { team_id: DEMO_TEAM_ID, user_id: 'u-sato', role: 'member', display_name: '佐藤（母）' },
  ]
  const players: Player[] = [
    { id: 'p1', team_id: DEMO_TEAM_ID, name: '田中 ゆうと', note: '4年' },
    { id: 'p2', team_id: DEMO_TEAM_ID, name: '田中 さくら', note: '2年' },
    { id: 'p3', team_id: DEMO_TEAM_ID, name: '佐藤 はるき', note: '4年' },
    { id: 'p4', team_id: DEMO_TEAM_ID, name: '鈴木 れん', note: '3年' },
    { id: 'p5', team_id: DEMO_TEAM_ID, name: '監督', note: null, is_self: true, self_user_id: 'u-coach' },
  ]
  const guardians: Guardian[] = [
    { player_id: 'p1', user_id: 'u-tanaka-f', added_via: 'registrant' },
    { player_id: 'p1', user_id: 'u-tanaka-m', added_via: 'invitation' },
    { player_id: 'p2', user_id: 'u-tanaka-f', added_via: 'registrant' },
    { player_id: 'p3', user_id: 'u-sato', added_via: 'registrant' },
    { player_id: 'p4', user_id: 'u-coach', added_via: 'registrant' },
    { player_id: 'p5', user_id: 'u-coach', added_via: 'registrant' },
  ]
  const events: TeamEvent[] = [
    { id: 'e1', team_id: DEMO_TEAM_ID, title: '通常練習', starts_at: day(2), location: '第一グラウンド', note: null },
    { id: 'e2', team_id: DEMO_TEAM_ID, title: '練習試合 vs 東小', starts_at: day(6, 8), location: '東小学校', note: '弁当持参' },
    { id: 'e3', team_id: DEMO_TEAM_ID, title: '通常練習', starts_at: day(9), location: '第一グラウンド', note: null },
  ]
  const now = new Date().toISOString()
  const attendance: Attendance[] = [
    { event_id: 'e1', player_id: 'p1', status: 'attend', comment: null, updated_at: now },
    { event_id: 'e1', player_id: 'p3', status: 'absent', comment: '発熱のため', updated_at: now },
    { event_id: 'e1', player_id: 'p4', status: 'undecided', comment: null, updated_at: now },
    { event_id: 'e2', player_id: 'p1', status: 'attend', comment: null, updated_at: now },
    { event_id: 'e2', player_id: 'p2', status: 'absent', comment: null, updated_at: now },
  ]
  const invitations: { id?: string; token: string; player_id: string; created_by: string; created_at?: number; expires_at: number; used: boolean; used_at?: number; revoked_at?: number }[] = []
  const joinTokens = new Map<string, string | null>([[DEMO_TEAM_ID, DEMO_JOIN_TOKEN]])
  return { teams: [team], members, players, guardians, events, attendance, invitations, joinTokens }
}
