<script setup lang="ts">
// アクセス停止中のチームで、自分の登録だけを確認して整理し、チームから抜ける（D6-B1）。
// 表示するのはサーバーが返す自分の整理対象だけ（チーム名・予定・ほかのメンバーは出さない）。
// D6-A と同じ確認の流れ：削除は初期状態で未選択 → 確認画面 → 指紋値が変わっていたら何もせず再確認。
import { CirclePause, LogOut } from 'lucide-vue-next'
import { LEAVE_CLEANUP_CONFIRM, type SuspendedLeavePreview } from '~/utils/types'

// teamName: the current name of the stopped team (D6-B3); null on an older DB (then no name is shown).
const props = defineProps<{ teamId: string; suspendedAt: string | null; teamName?: string | null }>()
const repo = useRepo()
const pv = ref<SuspendedLeavePreview | null>(null)
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const confirmOpen = ref(false)
const deleteSelected = ref(false)
let previewRequest = 0

async function loadPreview() {
  const request = ++previewRequest
  pv.value = null
  deleteSelected.value = false
  confirmOpen.value = false
  loadError.value = ''
  try {
    const fresh = await repo.suspendedLeavePreview(props.teamId)
    if (request === previewRequest) pv.value = fresh
  } catch (e) {
    if (request !== previewRequest) return
    // Resumed meanwhile (another device, the owner): back to the normal team screen.
    if (e instanceof RepoError && e.code === 'not_suspended') return void navigateTo(`/t/${props.teamId}`, { replace: true })
    loadError.value = errorMessage(e)
  }
}
watch(() => props.teamId, loadPreview, { immediate: true })

async function leave() {
  if (busy.value) return // double submit
  if (!pv.value || !deleteSelected.value) return
  busy.value = true
  error.value = ''
  try {
    await repo.leaveSuspendedTeam(props.teamId, pv.value.fingerprint, LEAVE_CLEANUP_CONFIRM)
    confirmOpen.value = false
    await navigateTo({ path: '/', query: { notice: 'suspended_left' } }, { replace: true })
  } catch (e) {
    confirmOpen.value = false
    if (e instanceof RepoError && e.code === 'not_member') {
      // The first request may have committed although its answer was lost. Never repeat it.
      await navigateTo({ path: '/', query: { notice: 'suspended_left' } }, { replace: true })
      return
    }
    if (e instanceof RepoError && e.code === 'not_suspended') return void navigateTo(`/t/${props.teamId}`, { replace: true })
    error.value = errorMessage(e)
    await loadPreview() // e.g. leave_confirmation_stale: show the current state, nothing selected
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex gap-3 rounded-box border-l-4 border-warning bg-base-100 p-4 text-sm shadow-soft">
      <CirclePause class="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div class="min-w-0 space-y-1">
        <p class="font-bold break-words"><template v-if="teamName">「{{ teamName }}」への</template><template v-else>このチームへの</template>アクセスは停止されています</p>
        <p class="text-base-content/70">
          <template v-if="suspendedAt">{{ formatDateTime(suspendedAt) }} に、</template>チームのオーナーが停止しました。登録と出欠は削除されていません。
          オーナーが停止を解除すると、また使えるようになります。自分で整理してチームから抜けることもできます。
        </p>
      </div>
    </div>

    <div v-if="!pv && !loadError" class="skeleton h-40 rounded-box bg-base-100" />
    <p v-else-if="loadError" role="alert" class="rounded-box bg-error/10 p-4 text-sm text-error">{{ loadError }}</p>

    <template v-else-if="pv">
      <AppCard title="整理してチームから抜ける" :icon="LogOut">
        <div class="space-y-3 text-sm">
          <template v-if="pv.deletions.length">
            <p class="font-bold text-error">削除する方法を選んだ場合、次の登録と出欠・コメントが削除されます</p>
            <CleanupDeletionList :deletions="pv.deletions" />
            <p class="text-xs text-base-content/60">あなたの本人登録と、あなただけが回答できる登録（取り消し済みを含む）です。削除すると元に戻せません。</p>
          </template>
          <p v-else class="text-base-content/70">削除される登録はありません。</p>
          <p v-if="pv.links_removed_count" class="text-base-content/70">
            ほかにも回答できる人がいる登録 {{ pv.links_removed_count }} 件は残ります（あなたは回答できなくなります）。
          </p>
          <p class="text-xs text-base-content/60">
            抜けたあとは、このチームに再参加できません（オーナーが拒否を解除した場合を除きます）。あなたのアカウントと、ほかのチームはそのまま使えます。
          </p>
        </div>
      </AppCard>
      <button type="button" class="btn btn-ghost min-h-11 w-full" :disabled="busy" @click="loadPreview">内容を再確認</button>
      <label class="flex items-start gap-3 rounded-box border border-error/30 bg-base-100 p-4 text-sm">
        <input v-model="deleteSelected" type="checkbox" class="checkbox checkbox-error mt-0.5 shrink-0" :disabled="busy">
        <span>{{ pv.deletions.length ? '上の登録と出欠を削除して、チームから抜ける方法を選ぶ（元に戻せません）' : 'チームから抜ける方法を選ぶ' }}</span>
      </label>
      <p v-if="error" role="alert" class="rounded-box bg-error/10 p-3 text-sm text-error">{{ error }}</p>
      <button type="button" class="btn btn-outline btn-error min-h-12 h-auto w-full whitespace-normal py-3" :disabled="busy || !deleteSelected" @click="confirmOpen = true">
        内容を確認してチームから抜ける
      </button>
      <ConfirmDialog :open="confirmOpen" title="チームから抜けますか？" :confirm-label="pv.deletions.length ? '削除して抜ける' : '抜ける'" :busy="busy"
        @confirm="leave" @cancel="confirmOpen = false">
        <p v-if="pv.deletions.length" class="font-bold text-error">{{ pv.deletions.length }}件の登録と、その出欠・コメントを削除します。元に戻せません。</p>
        <p>抜けたあとは、このチームに再参加できません。</p>
      </ConfirmDialog>
    </template>
  </div>
</template>
