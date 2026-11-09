// Phase 4-A: event edit / logical delete, child edit / cancel, "already a guardian" invitations.
// Every operation is checked for both the allowed and the refused case, and that history stays in the DB.
import { beforeAll, describe, expect, it } from 'vitest'
import { addUser, asUser, createDb, type Db } from './setup'

const OWNER = '40000000-0000-0000-0000-00000000000a' // team A owner (no child)
const ADMIN = '40000000-0000-0000-0000-0000000000ad' // promoted admin (no child)
const DAD = '40000000-0000-0000-0000-000000000001' // registrant of kid
const MOM = '40000000-0000-0000-0000-000000000002' // invited guardian of kid
const OTHER = '40000000-0000-0000-0000-000000000003' // other family in team A
const OUT = '40000000-0000-0000-0000-0000000000ff' // owner of team B
const NEW = '40000000-0000-0000-0000-000000000004' // logs in later, never in team A

let db: Db
let teamA: { id: string; share_token: string }
let teamB: { id: string; share_token: string }
let ev: string
let evB: string
let kid: string
let otherKid: string

const q = async <T = any>(uid: string | null, sql: string, params: unknown[] = []) =>
  asUser(db, uid, async () => (await db.query<T>(sql, params)).rows)
const raw = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
const deny = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re)

beforeAll(async () => {
  db = await createDb()
  for (const u of [OWNER, ADMIN, DAD, MOM, OTHER, OUT, NEW]) await addUser(db, u)
  ;[teamA] = await q(OWNER, `select id, share_token from public.create_team('Aクラブ', '代表')`)
  ;[teamB] = await q(OUT, `select id, share_token from public.create_team('Bクラブ', '別代表')`)
  for (const u of [ADMIN, DAD, MOM, OTHER]) await q(u, `select public.join_team($1, 'x')`, [teamA.share_token])
  await q(OWNER, `select public.set_member_role($1, $2, 'admin')`, [teamA.id, ADMIN])
  ;[{ id: ev }] = await q(OWNER, `select public.create_event($1, '練習', '2030-01-10T09:00:00Z', '公民館') as id`, [teamA.id])
  ;[{ id: evB }] = await q(OUT, `select public.create_event($1, 'B練習', '2030-01-10T09:00:00Z') as id`, [teamB.id])
  ;[{ r: { player_id: kid } }] = await q(DAD, `select public.register_player($1, '山田 たろう', '3年') as r`, [teamA.id])
  ;[{ r: { player_id: otherKid } }] = await q(OTHER, `select public.register_player($1, '佐藤 はなこ', '2年') as r`, [teamA.id])
  const [{ r: inv }] = await q(DAD, `select public.create_guardian_invitation($1) as r`, [kid])
  await q(MOM, `select public.accept_guardian_invitation($1, '母')`, [inv.token])
  await q(DAD, `select public.set_attendance($1, $2, 'attend', 'よろしく')`, [ev, kid])
  await q(OTHER, `select public.set_attendance($1, $2, 'absent')`, [ev, otherKid])
})

describe('予定の編集（管理者のみ）', () => {
  it('owner and admin can edit; answers are kept after a date/time change', async () => {
    await q(OWNER, `select public.update_event($1, '練習（場所変更）', '2030-01-11T10:00:00Z', '体育館', '室内シューズ')`, [ev])
    await q(ADMIN, `select public.update_event($1, '練習（時間変更）', '2030-01-11T13:00:00Z', '体育館', null)`, [ev])
    const [e] = await q(DAD, `select title, starts_at, location, note from public.events where id = $1`, [ev])
    expect(e).toMatchObject({ title: '練習（時間変更）', location: '体育館', note: null })
    expect(new Date(e.starts_at).toISOString()).toBe('2030-01-11T13:00:00.000Z')
    const answers = await q(DAD, `select player_id, status, comment from public.attendance where event_id = $1 order by status`, [ev])
    expect(answers).toEqual([
      { player_id: otherKid, status: 'absent', comment: null },
      { player_id: kid, status: 'attend', comment: 'よろしく' },
    ])
    const [meta] = await raw(`select updated_by from public.events where id = $1`, [ev])
    expect(meta.updated_by).toBe(ADMIN)
  })

  it('members (guardians), other teams and anon are refused', async () => {
    await deny(q(DAD, `select public.update_event($1, 'x', now())`, [ev]), /forbidden/)
    await deny(q(OTHER, `select public.update_event($1, 'x', now())`, [ev]), /forbidden/)
    await deny(q(OUT, `select public.update_event($1, 'x', now())`, [ev]), /forbidden/)
    await deny(q(OWNER, `select public.update_event($1, 'x', now())`, [evB]), /forbidden/)
    await deny(q(null, `select public.update_event($1, 'x', now())`, [ev]), /permission denied/)
    await deny(q(OWNER, `update public.events set title = 'x' where id = $1`, [ev]), /permission denied/)
    const [e] = await raw(`select title from public.events where id = $1`, [ev])
    expect(e.title).toBe('練習（時間変更）')
  })

  it('validation still applies (title required)', async () => {
    await deny(q(OWNER, `select public.update_event($1, '', now())`, [ev]), /check constraint/)
  })
})

describe('子どもの情報修正（その子の保護者のみ）', () => {
  it('registrant and invited guardian can edit; guardians and answers stay', async () => {
    const [{ r: r1 }] = await q(DAD, `select public.update_player($1, '山田 太郎', '4年') as r`, [kid])
    expect(r1).toEqual({ status: 'updated' })
    const [{ r: r2 }] = await q(MOM, `select public.update_player($1, '山田 太郎', '4年生') as r`, [kid])
    expect(r2.status).toBe('updated')
    const [p] = await raw(`select name, note, normalized_name, updated_by from public.players where id = $1`, [kid])
    expect(p).toMatchObject({ name: '山田 太郎', note: '4年生', normalized_name: '山田太郎', updated_by: MOM })
    const g = await raw(`select user_id from public.player_guardians where player_id = $1 order by user_id`, [kid])
    expect(g.map((x) => x.user_id)).toEqual([DAD, MOM])
    await q(MOM, `select public.set_attendance($1, $2, 'attend', 'よろしく')`, [ev, kid])
  })

  it('other family, admin/owner (not guardian), other team and anon are refused', async () => {
    await deny(q(OTHER, `select public.update_player($1, '乗っ取り')`, [kid]), /forbidden/)
    await deny(q(OWNER, `select public.update_player($1, '乗っ取り')`, [kid]), /forbidden/)
    await deny(q(ADMIN, `select public.update_player($1, '乗っ取り')`, [kid]), /forbidden/)
    await deny(q(OUT, `select public.update_player($1, '乗っ取り')`, [kid]), /forbidden/)
    await deny(q(null, `select public.update_player($1, '乗っ取り')`, [kid]), /permission denied/)
    await deny(q(DAD, `update public.players set name = '乗っ取り' where id = $1`, [otherKid]), /permission denied/)
    const [p] = await raw(`select name from public.players where id = $1`, [kid])
    expect(p.name).toBe('山田 太郎')
  })

  it('similar names only warn (own name excluded), and confirming applies the change', async () => {
    const [{ r: same }] = await q(DAD, `select public.update_player($1, 'やまだ　太郎', '4年') as r`, [kid])
    expect(same.status).toBe('updated') // only similar to itself
    const [{ r: warn }] = await q(DAD, `select public.update_player($1, '佐藤はなこ') as r`, [kid])
    expect(warn.status).toBe('similar_found')
    expect(warn.similar.map((s: any) => s.id)).toEqual([otherKid])
    const [p] = await raw(`select name from public.players where id = $1`, [kid])
    expect(p.name).toBe('やまだ　太郎') // unchanged by the warning
    const [{ r: ok }] = await q(DAD, `select public.update_player($1, '山田 太郎', '4年', true) as r`, [kid])
    expect(ok.status).toBe('updated')
    // the other family's child is still theirs alone
    await deny(q(DAD, `select public.set_attendance($1, $2, 'attend')`, [ev, otherKid]), /forbidden/)
  })

  it('empty name is refused', async () => {
    await deny(q(DAD, `select public.update_player($1, '  ')`, [kid]), /name_required/)
  })
})

describe('予定の論理削除', () => {
  let ev2: string
  beforeAll(async () => {
    ;[{ id: ev2 }] = await q(OWNER, `select public.create_event($1, '削除される予定', '2030-02-01T09:00:00Z') as id`, [teamA.id])
    await q(DAD, `select public.set_attendance($1, $2, 'undecided')`, [ev2, kid])
  })

  it('members and other teams cannot delete', async () => {
    await deny(q(DAD, `select public.delete_event($1)`, [ev2]), /forbidden/)
    await deny(q(OUT, `select public.delete_event($1)`, [ev2]), /forbidden/)
    await deny(q(null, `select public.delete_event($1)`, [ev2]), /permission denied/)
    await deny(q(OWNER, `delete from public.events where id = $1`, [ev2]), /permission denied/)
  })

  it('admin deletes logically: hidden everywhere, answers kept in the DB', async () => {
    await q(ADMIN, `select public.delete_event($1)`, [ev2])
    expect(await q(DAD, `select id from public.events where id = $1`, [ev2])).toEqual([])
    expect(await q(OWNER, `select id from public.events where id = $1`, [ev2])).toEqual([])
    expect(await q(DAD, `select * from public.attendance where event_id = $1`, [ev2])).toEqual([])
    const [row] = await raw(`select deleted_at is not null as deleted, deleted_by, title from public.events where id = $1`, [ev2])
    expect(row).toEqual({ deleted: true, deleted_by: ADMIN, title: '削除される予定' })
    const kept = await raw(`select status from public.attendance where event_id = $1`, [ev2])
    expect(kept).toEqual([{ status: 'undecided' }])
  })

  it('a deleted event cannot be answered, summarised, edited or deleted again', async () => {
    await deny(q(DAD, `select public.set_attendance($1, $2, 'attend')`, [ev2, kid]), /not_found/)
    await deny(q(DAD, `select * from public.event_attendance_summary($1)`, [ev2]), /forbidden/)
    await deny(q(OWNER, `select public.update_event($1, 'x', now())`, [ev2]), /not_found/)
    await deny(q(OWNER, `select public.delete_event($1)`, [ev2]), /not_found/)
  })

  it('can be restored later by clearing deleted_at (answers come back)', async () => {
    await raw(`update public.events set deleted_at = null, deleted_by = null where id = $1`, [ev2])
    const back = await q(DAD, `select status from public.attendance where event_id = $1`, [ev2])
    expect(back).toEqual([{ status: 'undecided' }])
    await q(OWNER, `select public.delete_event($1)`, [ev2]) // delete again for the remaining tests
  })
})

describe('子どもの登録取り消し（archived_at）', () => {
  let pendingToken: string
  let cancelKid: string
  beforeAll(async () => {
    ;[{ r: { player_id: cancelKid } }] = await q(DAD, `select public.register_player($1, '誤登録 じろう', null, true) as r`, [teamA.id])
    await q(DAD, `select public.set_attendance($1, $2, 'attend')`, [ev, cancelKid])
    ;[{ r: { token: pendingToken } }] = await q(DAD, `select public.create_guardian_invitation($1) as r`, [cancelKid])
  })

  it('other family, admin/owner (not guardian) and other team cannot cancel', async () => {
    await deny(q(OTHER, `select public.archive_player($1)`, [cancelKid]), /forbidden/)
    await deny(q(OWNER, `select public.archive_player($1)`, [cancelKid]), /forbidden/)
    await deny(q(OUT, `select public.archive_player($1)`, [cancelKid]), /forbidden/)
    await deny(q(null, `select public.archive_player($1)`, [cancelKid]), /permission denied/)
  })

  it('guardian cancels: hidden and excluded from totals, history kept', async () => {
    const [{ total: before }] = await q(OWNER, `select total from public.event_attendance_summary($1)`, [ev])
    await q(DAD, `select public.archive_player($1)`, [cancelKid])
    expect(await q(OTHER, `select id from public.players where id = $1`, [cancelKid])).toEqual([])
    expect(await q(DAD, `select id from public.players where id = $1`, [cancelKid])).toEqual([])
    expect(await q(DAD, `select * from public.attendance where player_id = $1`, [cancelKid])).toEqual([])
    const [{ total: after }] = await q(OWNER, `select total from public.event_attendance_summary($1)`, [ev])
    expect(after).toBe(before - 1)
    const [p] = await raw(`select archived_at is not null as archived, archived_by from public.players where id = $1`, [cancelKid])
    expect(p).toEqual({ archived: true, archived_by: DAD })
    expect(await raw(`select status from public.attendance where player_id = $1`, [cancelKid])).toEqual([{ status: 'attend' }])
    expect(await raw(`select count(*)::int as n from public.player_guardians where player_id = $1`, [cancelKid])).toEqual([{ n: 1 }])
  })

  it('no new answers, edits, invitations or acceptances for a cancelled child', async () => {
    await deny(q(DAD, `select public.set_attendance($1, $2, 'absent')`, [ev, cancelKid]), /not_found/)
    await deny(q(DAD, `select public.update_player($1, 'x')`, [cancelKid]), /not_found/)
    await deny(q(DAD, `select public.archive_player($1)`, [cancelKid]), /not_found/)
    await deny(q(DAD, `select public.create_guardian_invitation($1)`, [cancelKid]), /not_found/)
    await deny(q(NEW, `select public.accept_guardian_invitation($1, 'x')`, [pendingToken]), /invitation_invalid/)
    expect(await raw(`select count(*)::int as n from public.player_guardians where user_id = $1`, [NEW])).toEqual([{ n: 0 }])
  })

  it('can be restored later by clearing archived_at (answers and guardians intact)', async () => {
    await raw(`update public.players set archived_at = null, archived_by = null where id = $1`, [cancelKid])
    expect(await q(DAD, `select status from public.attendance where player_id = $1`, [cancelKid])).toEqual([{ status: 'attend' }])
    await q(DAD, `select public.set_attendance($1, $2, 'absent')`, [ev, cancelKid])
    await q(DAD, `select public.archive_player($1)`, [cancelKid])
  })
})

describe('家族招待：すでに保護者の場合は正常な案内（招待は消費しない）', () => {
  let token: string
  beforeAll(async () => {
    ;[{ r: { token } }] = await q(DAD, `select public.create_guardian_invitation($1) as r`, [kid])
  })

  it('an existing guardian opening the link gets already_guardian with team info, link not consumed', async () => {
    const [{ r }] = await q(DAD, `select public.accept_guardian_invitation($1, 'x') as r`, [token])
    expect(r).toEqual({ status: 'already_guardian', player_id: kid, player_name: '山田 太郎', team_id: teamA.id, share_token: teamA.share_token })
    const [{ r: r2 }] = await q(MOM, `select public.accept_guardian_invitation($1, 'x') as r`, [token])
    expect(r2.status).toBe('already_guardian')
    expect(await raw(`select used_at from public.guardian_invitations where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token]))
      .toEqual([{ used_at: null }])
  })

  it('a new family member can still accept it normally afterwards', async () => {
    const [{ r }] = await q(NEW, `select public.accept_guardian_invitation($1, '祖母') as r`, [token])
    expect(r).toEqual({ status: 'accepted', player_id: kid, player_name: '山田 太郎', team_id: teamA.id, share_token: teamA.share_token })
    await q(NEW, `select public.set_attendance($1, $2, 'undecided')`, [ev, kid])
    const [m] = await raw(`select role from public.team_members where team_id = $1 and user_id = $2`, [teamA.id, NEW])
    expect(m.role).toBe('member')
  })

  it('after use: other people are refused, guardians still get the friendly result', async () => {
    await deny(q(OTHER, `select public.accept_guardian_invitation($1, 'x')`, [token]), /invitation_invalid/)
    const [{ r }] = await q(NEW, `select public.accept_guardian_invitation($1, 'x') as r`, [token])
    expect(r.status).toBe('already_guardian')
    await deny(q(OTHER, `select public.accept_guardian_invitation($1, 'x')`, [repeat0()]), /invitation_invalid/)
  })
})

describe('権限の最小化', () => {
  it('new RPCs: signed-in users only, never anon; anon can still run only health_check', async () => {
    const rows = await raw<{ f: string; anon: boolean; auth: boolean; secdef: boolean; cfg: string }>(
      `select p.proname as f, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              p.prosecdef as secdef, array_to_string(p.proconfig, ',') as cfg
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('update_event','delete_event','update_player','archive_player')
       order by 1`)
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r).toMatchObject({ anon: false, auth: true, secdef: true, cfg: 'search_path=""' })
    const anon = await raw<{ f: string }>(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'execute')`)
    expect(anon.map((r) => r.f)).toEqual(['public.health_check'])
  })

  it('signed-in users still cannot write any table directly', async () => {
    const rows = await raw<{ t: string; w: boolean }>(
      `select c.relname as t, (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
         or has_table_privilege('authenticated', c.oid, 'delete')) as w
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`)
    expect(rows.filter((r) => r.w)).toEqual([])
  })
})

function repeat0() { return '0'.repeat(64) }
