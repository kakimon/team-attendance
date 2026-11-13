import { beforeAll, describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, type Db } from './setup'

// Users
const OWNER = '00000000-0000-0000-0000-00000000000a' // creates team A
const P1 = '00000000-0000-0000-0000-000000000001' // parent of Taro
const P1B = '00000000-0000-0000-0000-0000000001b0' // Taro's other parent (invited)
const P2 = '00000000-0000-0000-0000-000000000002' // another family in team A
const OUT = '00000000-0000-0000-0000-0000000000ff' // owner of another team B

let db: Db
let teamA: { id: string; share_token: string }
let teamB: { id: string; share_token: string }
let taro: string // P1's child
let hanako: string // P2's child
let eventA: string
let eventB: string

const rpc = async <T = any>(uid: string | null, sql: string, params: unknown[] = []) =>
  asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)

const expectError = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toThrow(re)
}

beforeAll(async () => {
  db = await createDb()
  for (const u of [OWNER, P1, P1B, P2, OUT]) await addUser(db, u)

  ;[teamA] = await rpc(OWNER, `select id, share_token from public.create_team('Aチーム', '監督')`)
  ;[teamB] = await rpc(OUT, `select id, share_token from public.create_team('Bチーム', '別監督')`)
  await rpc(P1, `select public.join_team($1, '太郎の父')`, [teamA.share_token])
  await rpc(P2, `select public.join_team($1, '花子の母')`, [teamA.share_token])

  const [r1] = await rpc(P1, `select public.register_player($1, '山田 太郎', '4年') as r`, [teamA.id])
  taro = r1.r.player_id
  const [r2] = await rpc(P2, `select public.register_player($1, '佐藤 花子') as r`, [teamA.id])
  hanako = r2.r.player_id

  ;[{ id: eventA }] = await rpc(OWNER,
    `select public.create_event($1, '練習', now() + interval '3 days', '河川敷') as id`, [teamA.id])
  ;[{ id: eventB }] = await rpc(OUT,
    `select public.create_event($1, 'B練習', now() + interval '3 days') as id`, [teamB.id])
})

describe('RLS is on for every table', () => {
  it('all public tables have row level security enabled', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`)
    expect(rows.map((r) => r.relname)).toEqual([
      'attendance', 'events', 'guardian_invitations', 'player_guardians',
      'players', 'team_members', 'team_owner_transfers', 'teams',
    ])
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
  })
})

describe('1. team separation', () => {
  it('members see their own team data', async () => {
    expect(await rpc(P2, `select id from public.players order by name`)).toHaveLength(2)
    expect(await rpc(P2, `select id from public.events`)).toEqual([{ id: eventA }])
  })

  it('other team cannot see team A at all', async () => {
    const teams = await rpc(OUT, `select id from public.teams`)
    expect(teams).toEqual([{ id: teamB.id }])
    expect(await rpc(OUT, `select * from public.players`)).toEqual([])
    expect(await rpc(OUT, `select id from public.events`)).toEqual([{ id: eventB }])
  })

  it('anon cannot read tables or call RPCs', async () => {
    await expectError(rpc(null, `select * from public.players`), /permission denied/)
    await expectError(rpc(null, `select public.join_team($1, 'x')`, [teamA.share_token]),
      /permission denied/)
    await expectError(rpc(null, `select * from public.get_team_by_share_token($1)`, [teamA.share_token]),
      /permission denied/)
  })

  it('cannot answer an event of another team', async () => {
    await expectError(
      rpc(P1, `select public.set_attendance($1, $2, 'attend')`, [eventB, taro]), /not_found/)
  })

  it('outsider cannot register a player into team A', async () => {
    await expectError(rpc(OUT, `select public.register_player($1, '侵入者')`, [teamA.id]), /forbidden/)
  })
})

describe('2. registrant is the first guardian', () => {
  it('registrant is guardian with added_via=registrant', async () => {
    const rows = await rpc(P1, `select player_id, added_via from public.player_guardians`)
    expect(rows).toEqual([{ player_id: taro, added_via: 'registrant' }])
  })

  it('registrant can answer for own child', async () => {
    await rpc(P1, `select public.set_attendance($1, $2, 'attend', 'よろしく')`, [eventA, taro])
    const [row] = await rpc(P2, `select status, comment from public.attendance where player_id = $1`, [taro])
    expect(row).toEqual({ status: 'attend', comment: 'よろしく' })
  })
})

describe("3. editing another family's child is refused server-side", () => {
  it('RPC refuses', async () => {
    await expectError(
      rpc(P2, `select public.set_attendance($1, $2, 'absent')`, [eventA, taro]), /forbidden/)
  })

  it('admin cannot edit a child they are not guardian of', async () => {
    await expectError(
      rpc(OWNER, `select public.set_attendance($1, $2, 'absent')`, [eventA, taro]), /forbidden/)
  })

  it('direct INSERT / UPDATE / DELETE on tables is denied', async () => {
    await expectError(rpc(P2,
      `insert into public.attendance (event_id, player_id, team_id, status, updated_by)
       values ($1, $2, $3, 'absent', $4)`, [eventA, taro, teamA.id, P2]), /permission denied/)
    await expectError(rpc(P2, `update public.attendance set status = 'absent'`), /permission denied/)
    await expectError(rpc(P2, `delete from public.attendance`), /permission denied/)
    await expectError(rpc(P2,
      `insert into public.player_guardians (player_id, team_id, user_id, added_via)
       values ($1, $2, $3, 'registrant')`, [taro, teamA.id, P2]), /permission denied/)
    const [row] = await rpc(P1, `select status from public.attendance where player_id = $1`, [taro])
    expect(row.status).toBe('attend')
  })
})

describe('4 & 5. family invitations (multiple guardians, short-lived, single use)', () => {
  let token: string

  it('non-guardian cannot create an invitation', async () => {
    await expectError(rpc(P2, `select public.create_guardian_invitation($1)`, [taro]), /forbidden/)
  })

  it('guardian creates a 24h invitation; token hash is not readable', async () => {
    const [r] = await rpc(P1, `select public.create_guardian_invitation($1) as r`, [taro])
    token = r.r.token
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const hours = (new Date(r.r.expires_at).getTime() - Date.now()) / 3600_000
    expect(hours).toBeGreaterThan(23.9)
    expect(hours).toBeLessThanOrEqual(24)
    await expectError(rpc(P1, `select token_hash from public.guardian_invitations`), /permission denied/)
    expect(await rpc(P2, `select id from public.guardian_invitations`)).toEqual([])
  })

  it('invited parent accepts, joins the team and can edit', async () => {
    const [r] = await rpc(P1B, `select public.accept_guardian_invitation($1, '太郎の母') as r`, [token])
    expect(r.r.player_id).toBe(taro)
    await rpc(P1B, `select public.set_attendance($1, $2, 'undecided')`, [eventA, taro])
    const guardians = await rpc(OWNER,
      `select user_id from public.player_guardians where player_id = $1 order by user_id`, [taro])
    expect(guardians.map((g) => g.user_id)).toEqual([P1, P1B])
  })

  it('a used invitation can never be reused', async () => {
    await expectError(
      rpc(P2, `select public.accept_guardian_invitation($1, 'x')`, [token]), /invitation_invalid/)
    const rows = await rpc(P2, `select 1 from public.player_guardians where player_id = $1`, [taro])
    expect(rows).toEqual([])
  })

  it('expired invitation is refused', async () => {
    const [r] = await rpc(P1, `select public.create_guardian_invitation($1) as r`, [taro])
    await db.query(`update public.guardian_invitations
                    set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
                    where id = $1`, [r.r.id])
    await expectError(
      rpc(P2, `select public.accept_guardian_invitation($1, 'x')`, [r.r.token]), /invitation_invalid/)
  })

  it('revoked invitation is refused', async () => {
    const [r] = await rpc(P1, `select public.create_guardian_invitation($1) as r`, [taro])
    await rpc(P1, `select public.revoke_guardian_invitation($1)`, [r.r.id])
    await expectError(
      rpc(P2, `select public.accept_guardian_invitation($1, 'x')`, [r.r.token]), /invitation_invalid/)
  })

  it('wrong token is refused', async () => {
    await expectError(
      rpc(P2, `select public.accept_guardian_invitation($1, 'x')`, ['0'.repeat(64)]), /invitation_invalid/)
  })
})

describe('6. similar names warn and never grant edit rights', () => {
  it('kana / spacing variants are detected and nothing is created', async () => {
    await rpc(P1, `select public.register_player($1, 'すずき いちろう')`, [teamA.id])
    const [r] = await rpc(P2, `select public.register_player($1, 'スズキイチロウ') as r`, [teamA.id])
    expect(r.r.status).toBe('similar_found')
    expect(r.r.similar[0].name).toBe('すずき いちろう')
    const n = await rpc(P2, `select id from public.players where name = 'スズキイチロウ'`)
    expect(n).toEqual([])
  })

  it('confirming creates a separate player; existing one stays not editable', async () => {
    const [r] = await rpc(P2,
      `select public.register_player($1, 'スズキイチロウ', null, true) as r`, [teamA.id])
    expect(r.r.status).toBe('created')
    const mine = await rpc(P2, `select player_id from public.player_guardians`)
    expect(mine.map((m) => m.player_id).sort()).toEqual([hanako, r.r.player_id].sort())
    const [orig] = await rpc(P1, `select id from public.players where name = 'すずき いちろう'`)
    await expectError(
      rpc(P2, `select public.set_attendance($1, $2, 'attend')`, [eventA, orig.id]), /forbidden/)
  })
})

describe('7. unanswered is distinct from absent', () => {
  it('summary counts unanswered separately, and "unanswered" removes the answer', async () => {
    await rpc(P2, `select public.set_attendance($1, $2, 'absent')`, [eventA, hanako])
    const [s1] = await rpc(OWNER, `select * from public.event_attendance_summary($1)`, [eventA])
    // taro=undecided, hanako=absent, 2 suzuki players = unanswered
    expect(s1).toEqual({ attend: 0, absent: 1, undecided: 1, unanswered: 2, total: 4 })

    await rpc(P2, `select public.set_attendance($1, $2, 'unanswered')`, [eventA, hanako])
    const [s2] = await rpc(OWNER, `select * from public.event_attendance_summary($1)`, [eventA])
    expect(s2).toEqual({ attend: 0, absent: 0, undecided: 1, unanswered: 3, total: 4 })
  })

  it('"unanswered" cannot be stored as a status value', async () => {
    await expectError(db.query(
      `insert into public.attendance (event_id, player_id, team_id, status, updated_by)
       values ($1, $2, $3, 'unanswered', $4)`, [eventA, hanako, teamA.id, P2]), /check constraint/)
  })

  it('other team cannot read the summary', async () => {
    await expectError(rpc(OUT, `select * from public.event_attendance_summary($1)`, [eventA]), /forbidden/)
  })
})

describe('9. admin rights cannot be self-declared', () => {
  it('joining via team URL gives member, re-joining never changes role', async () => {
    await rpc(P2, `select public.join_team($1, '花子の母')`, [teamA.share_token])
    const [m] = await rpc(P2, `select role from public.team_members where user_id = $1`, [P2])
    expect(m.role).toBe('member')
  })

  it('direct role update / self insert is denied', async () => {
    await expectError(rpc(P2, `update public.team_members set role = 'admin' where user_id = $1`, [P2]),
      /permission denied/)
    await expectError(rpc(OUT,
      `insert into public.team_members (team_id, user_id, role, display_name) values ($1, $2, 'owner', 'x')`,
      [teamA.id, OUT]), /permission denied/)
  })

  it('non-owner cannot grant admin (including to self)', async () => {
    await expectError(rpc(P2, `select public.set_member_role($1, $2, 'admin')`, [teamA.id, P2]), /forbidden/)
  })

  it('owner role cannot be granted by RPC', async () => {
    await expectError(rpc(OWNER, `select public.set_member_role($1, $2, 'owner')`, [teamA.id, P1]),
      /invalid_role/)
  })

  it('members cannot create events; owner-granted admin can', async () => {
    await expectError(rpc(P1, `select public.create_event($1, 'x', now())`, [teamA.id]), /forbidden/)
    await rpc(OWNER, `select public.set_member_role($1, $2, 'admin')`, [teamA.id, P1])
    const [r] = await rpc(P1, `select public.create_event($1, '試合', now() + interval '7 days') as id`, [teamA.id])
    expect(r.id).toBeTruthy()
    // admin still cannot promote others (owner only)
    await expectError(rpc(P1, `select public.set_member_role($1, $2, 'admin')`, [teamA.id, P2]), /forbidden/)
  })
})
