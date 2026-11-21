import { describe, expect, it } from 'vitest'
import { createMockRepo, DEMO_TEAM_ID } from '../../app/repo/mockRepo'

describe('demo member management: family invitations after removal / leaving', () => {
  it('blocks a removed member through a family invitation; unblocking leaves that invitation usable', async () => {
    let who = 'u-tanaka-f'
    const repo = createMockRepo(() => who, () => '')
    const player = (await repo.loadTeam(DEMO_TEAM_ID))!.players.find((p) => p.name === '田中 ゆうと')!
    const invitation = await repo.createInvitation(player.id)
    who = 'u-coach'
    await repo.removeMember(DEMO_TEAM_ID, 'u-tanaka-m')
    who = 'u-tanaka-m'
    await expect(repo.acceptInvitation(invitation.token, '母')).rejects.toMatchObject({ code: 'blocked_from_team' })
    expect(await repo.loadTeam(DEMO_TEAM_ID)).toBeNull()
    who = 'u-coach'
    await repo.unblockMember(DEMO_TEAM_ID, 'u-tanaka-m')
    who = 'u-tanaka-m'
    expect((await repo.acceptInvitation(invitation.token, '母')).status).toBe('accepted')
  })

  for (const action of ['leave', 'remove'] as const) {
    it(`${action}: revokes invitations created by that member only in the affected team`, async () => {
      let who = 'u-tanaka-m'
      const repo = createMockRepo(() => who, () => '')
      const player = (await repo.loadTeam(DEMO_TEAM_ID))!.players.find((p) => p.name === '田中 ゆうと')!
      const revoked = await repo.createInvitation(player.id)
      const other = await repo.createTeam('別チーム', '母')
      const self = await repo.registerSelf(other.id)
      const retained = await repo.createInvitation(self.player_id)
      if (action === 'remove') who = 'u-coach'
      const result = action === 'remove'
        ? await repo.removeMember(DEMO_TEAM_ID, 'u-tanaka-m')
        : await repo.leaveTeam(DEMO_TEAM_ID)
      expect(result.invitations_deleted).toBe(1)
      who = 'u-new'
      await expect(repo.acceptInvitation(revoked.token, '新規')).rejects.toMatchObject({ code: 'invitation_invalid' })
      expect((await repo.acceptInvitation(retained.token, '新規')).status).toBe('accepted')
    })
  }
})
