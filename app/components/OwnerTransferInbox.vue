<script setup lang="ts">
// Owner hand-over requests addressed to me: accept or decline.
// Nothing changes until I accept; then I become the owner and the old owner a member.
import { Crown } from 'lucide-vue-next'
import type { OwnerTransfers, TransferResponse } from '~/utils/types'

const emit = defineEmits<{ changed: [] }>()
const repo = useRepo()
const inbox = ref<OwnerTransfers['incoming']>([])
const busy = ref('')
const notice = ref('')
const error = ref('')

async function load() {
  try { inbox.value = (await repo.myOwnerTransfers()).incoming } catch { inbox.value = [] }
}
onMounted(load)

const RESULT: Record<TransferResponse, string> = {
  accepted: 'オーナーを引き継ぎました。',
  declined: '依頼をお断りしました。',
  expired: 'この依頼は期限が切れていました。',
  stale: 'チームの状況が変わったため、この依頼は無効になりました。',
}
async function respond(teamId: string, accept: boolean) {
  busy.value = teamId
  error.value = ''
  try {
    notice.value = RESULT[await repo.respondOwnerTransfer(teamId, accept)]
    emit('changed')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = ''
    await load()
  }
}
</script>

<template>
  <div v-if="inbox.length || notice || error" class="space-y-3">
    <AppCard v-for="x in inbox" :key="x.team_id" title="オーナー引き継ぎの依頼" :icon="Crown" tight>
      <p class="text-sm leading-relaxed">
        <b>{{ x.from_name || 'オーナー' }}</b>さんから、チーム「<b>{{ x.team_name }}</b>」のオーナーを引き継いでほしいという依頼が届いています。
      </p>
      <p class="mt-1 text-xs text-base-content/60">
        引き受けると、あなたがオーナー（予定の管理やメンバーの権限を変更できる人）になり、{{ x.from_name || 'オーナー' }}さんは一般メンバーになります。{{ formatDate(x.expires_at) }}まで有効です。
      </p>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <button class="btn" :disabled="!!busy" @click="respond(x.team_id, false)">断る</button>
        <button class="btn btn-brand" :disabled="!!busy" @click="respond(x.team_id, true)">
          <span v-if="busy === x.team_id" class="loading loading-spinner loading-sm" />引き受ける
        </button>
      </div>
    </AppCard>
    <p v-if="notice" role="status" class="rounded-box bg-success/10 p-3 text-sm text-success">{{ notice }}</p>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
  </div>
</template>
