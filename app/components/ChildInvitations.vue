<script setup lang="ts">
// 家族招待リンクの一覧と取り消し（保護者のみ。トークンは表示も取得もしない）。
// The list is re-read after every change, because revoking an invitation that was used or revoked
// meanwhile succeeds without changing anything: the screen shows what the database really has.
import { Ban } from 'lucide-vue-next'
import type { ChildInvitation } from '~/utils/types'
import { INVITATION_STATE_LABEL, invitationState, visibleInvitations } from '~/utils/invitations'

const props = defineProps<{ playerId: string; refreshKey: number }>()
const repo = useRepo()
const list = ref<ChildInvitation[] | null>(null)
const loadError = ref('')
const target = ref<ChildInvitation | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')

async function load() {
  loadError.value = ''
  try {
    list.value = await repo.listChildInvitations(props.playerId)
  } catch (e) {
    loadError.value = errorMessage(e)
  }
}
onMounted(load)
watch(() => props.refreshKey, load)

const shown = computed(() => visibleInvitations(list.value ?? []))
const tone = { active: 'badge-success', used: 'badge-ghost', expired: 'badge-ghost', revoked: 'badge-ghost' } as const

async function revoke() {
  if (busy.value || !target.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  const id = target.value.id
  try {
    await repo.revokeInvitation(id)
    await load()
    const now = list.value?.find((i) => i.id === id)
    const st = now ? invitationState(now) : null
    notice.value = st === 'revoked' ? 'この招待リンクを無効にしました。'
      : st === 'used' ? 'この招待リンクは、すでに使われていました（無効にする前に受け取られました）。'
        : st === 'expired' ? 'この招待リンクは、すでに期限切れでした。' : ''
    target.value = null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="loadError || shown.length" class="mt-5 space-y-2">
    <p class="text-sm font-bold">作成した招待リンク</p>
    <p v-if="loadError" role="alert" class="text-sm text-error">{{ loadError }}</p>
    <ul class="space-y-2">
      <li v-for="i in shown" :key="i.id" class="flex items-center gap-2 rounded-xl bg-base-200/60 px-3 py-2 text-xs">
        <span class="badge badge-sm shrink-0" :class="tone[invitationState(i)]">{{ INVITATION_STATE_LABEL[invitationState(i)] }}</span>
        <span class="min-w-0 flex-1 text-base-content/70">作成 {{ formatDateTime(i.created_at) }}<br>期限 {{ formatDateTime(i.expires_at) }}</span>
        <button v-if="invitationState(i) === 'active'" type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="busy"
          @click="target = i; error = ''; notice = ''">
          <Ban class="size-4" />無効にする
        </button>
      </li>
    </ul>
    <p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <ConfirmDialog :open="!!target" title="この招待リンクを無効にしますか？" confirm-label="無効にする" :busy="busy"
      @confirm="revoke" @cancel="busy || (target = null)">
      <p>送ったリンクは使えなくなります。まだ受け取っていない家族には、新しいリンクを作って送ってください。</p>
      <p class="mt-1">すでに受け取った人の回答権限は変わりません。</p>
    </ConfirmDialog>
  </div>
</template>
