// D6-B3: the stopped team's name is shown in the list and on the cleanup screen when the server gives it,
// and the screens fall back to the old wording on a DB without it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_TEAM_ID, createMockRepo } from '../../app/repo/mockRepo'

const read = (f: string) => readFileSync(join(import.meta.dirname, '../../app', f), 'utf8')

describe('stopped team name in the screens', () => {
  it('team list: the name when present, otherwise the old label and the note', () => {
    const src = read('pages/index.vue')
    expect(src).toContain("{{ x.team_name || '停止中のチーム' }}")
    expect(src).toContain('<template v-if="!x.team_name">・チーム名は表示されません</template>')
  })
  it('cleanup screen: the name in the heading when present; nothing else about the team is read', () => {
    const panel = read('components/SuspendedLeavePanel.vue')
    expect(panel).toContain('<template v-if="teamName">「{{ teamName }}」への</template><template v-else>このチームへの</template>')
    expect(panel).not.toMatch(/loadTeam|listMembers|events|console\./)
    expect(read('pages/suspended/[teamId].vue')).toContain(':team-name="entry.team_name ?? null"')
  })
  it('demo repo gives the name to the stopped member only', async () => {
    let who = 'u-coach'
    const repo = createMockRepo(() => who, () => '')
    await repo.suspendMember(DEMO_TEAM_ID, 'u-sato')
    expect(await repo.mySuspendedMemberships()).toEqual([])
    who = 'u-sato'
    expect(await repo.mySuspendedMemberships()).toEqual([{ team_id: DEMO_TEAM_ID, suspended_at: expect.any(String), team_name: 'ひまわりジュニア（デモ）' }])
  })
})
