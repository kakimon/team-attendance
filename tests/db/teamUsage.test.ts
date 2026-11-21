import { expect, it } from 'vitest'
import { createSupabaseRepo } from '../../app/repo/supabaseRepo'
import { OWNER_TEAM_LIMIT, ownedTeamCount } from '../../app/utils/teamUsage'
import { errorMessage } from '../../app/utils/types'
import { addUser, createDb } from './setup'
import { pgliteClient } from './pgliteClient'

it('displays actual RLS memberships, recovers slots only after deletion / accepted transfer, and keeps the creation rate limit', async () => {
  const db = await createDb()
  try {
    const owner = '55400000-0000-4000-8000-000000000001'
    const other = '55400000-0000-4000-8000-000000000002'
    for (const id of [owner, other]) await addUser(db, id)
    const a = createSupabaseRepo(pgliteClient(db, owner), () => owner)
    const b = createSupabaseRepo(pgliteClient(db, other), () => other)
    const count = async () => ownedTeamCount(await a.myTeams())
    // Check the UI denominator against the actual local SQL, not a duplicate fixture.
    const quota = await db.query<{ quota: number }>('select private.owner_quota($1) as quota', [owner])
    expect(OWNER_TEAM_LIMIT).toBe(quota.rows[0]!.quota)
    expect(await count()).toBe(0)
    const first = await a.createTeam('一つ目', '代表')
    const second = await a.createTeam('二つ目', '代表')
    const third = await a.createTeam('三つ目', '代表')
    const joined = await b.createTeam('参加先', '別の代表')
    await a.joinByToken((await b.getJoinLink(joined.id)).token!, '参加者')
    expect(await a.myTeams()).toHaveLength(4)
    expect(await count()).toBe(3)
    await expect(a.createTeam('上限超過', '代表')).rejects.toMatchObject({ code: 'owner_quota_exceeded' })
    await b.joinByToken((await a.getJoinLink(third.id)).token!, '次の代表')
    await a.requestOwnerTransfer(third.id, other)
    expect(await count()).toBe(3) // requesting is not acceptance
    await b.respondOwnerTransfer(third.id, true)
    expect(await count()).toBe(2)
    expect(ownedTeamCount(await b.myTeams())).toBe(2)
    await a.deleteTeam(first.id, first.name)
    expect(await count()).toBe(1)
    const fourth = await a.createTeam('四つ目', '代表')
    await a.createTeam('五つ目', '代表')
    expect(await count()).toBe(3)
    await a.deleteTeam(fourth.id, fourth.name)
    expect(await count()).toBe(2)
    const e = await a.createTeam('六つ目', '代表').catch((e) => e)
    expect(e.code).toBe('team_create_rate_limited')
    expect(errorMessage(e)).toContain('削除しても作成回数は減りません')
    expect(await count()).toBe(2)
    expect((await a.myTeams()).some((t) => t.id === second.id)).toBe(true)
  } finally { await db.close() }
})
