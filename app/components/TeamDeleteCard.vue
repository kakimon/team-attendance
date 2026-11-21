<script setup lang="ts">
// チームの削除（オーナーのみ・ほかにメンバーがいないときだけ）。チーム名の入力で確認する。
// 削除の可否と確認はサーバー（delete_team）が判定する。
import { Trash2 } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const props = defineProps<{ snap: TeamSnapshot }>()
const repo = useRepo()
const memberCount = ref<number | null>(null)
watch(() => props.snap, async () => {
  try { memberCount.value = (await repo.listMembers(props.snap.team.id)).length } catch { memberCount.value = null }
}, { immediate: true })
const typed = ref('')
const confirmOpen = ref(false)
const busy = ref(false)
const error = ref('')
const alone = computed(() => memberCount.value === 1)
const matches = computed(() => typed.value.trim() === props.snap.team.name)

async function remove() {
  if (busy.value) return // double submit
  busy.value = true
  error.value = ''
  try {
    await repo.deleteTeam(props.snap.team.id, typed.value.trim())
    confirmOpen.value = false
    await navigateTo({ path: '/', query: { notice: 'team_deleted' } }, { replace: true })
  } catch (e) {
    confirmOpen.value = false
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppCard title="チームの削除" :icon="Trash2">
    <div class="space-y-3 text-sm">
      <p class="text-base-content/70">チームと、その予定・回答する人の登録・出欠・参加用URLがすべて削除されます。元に戻せません。</p>
      <p v-if="memberCount === null" class="skeleton h-10 rounded-field bg-base-200" />
      <div v-else-if="!alone" class="rounded-xl bg-base-200/70 p-3 text-base-content/75">
        ほかのメンバーがいるため、削除できません（いまは {{ memberCount }} 人。アクセス停止中の人も含みます）。削除するには、先にメンバーに脱退してもらうか、上の「メンバー」から除外してください。停止中の人は、本人が登録を整理して抜けるまで、または除外できるようになるまで、メンバーとして数えます。
        チームを続ける人がいる場合は、オーナーの交代もできます。
      </div>
      <form v-else class="space-y-3" @submit.prevent="matches && (confirmOpen = true)">
        <FormField label="確認のため、チーム名を入力してください" :hint="`「${snap.team.name}」`">
          <input v-model="typed" maxlength="60" class="input w-full" autocomplete="off" :placeholder="snap.team.name">
        </FormField>
        <button class="btn btn-outline btn-error min-h-11 w-full" :disabled="!matches || busy"><Trash2 class="size-4" />チームを削除する</button>
      </form>
      <p class="text-xs text-base-content/55">削除すると、作成できるチーム数の枠が1つ戻ります。ただし、24時間以内にチームを作成した回数は、削除しても減りません。</p>
      <p v-if="error" role="alert" class="text-error">{{ error }}</p>
    </div>
    <ConfirmDialog :open="confirmOpen" :title="`「${snap.team.name}」を削除しますか？`" confirm-label="削除する" :busy="busy"
      @confirm="remove" @cancel="confirmOpen = false">
      <p>予定・回答する人の登録・出欠・参加用URLを含め、チームのすべてのデータが削除されます。元に戻せません。</p>
    </ConfirmDialog>
  </AppCard>
</template>
