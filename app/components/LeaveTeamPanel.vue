<script setup lang="ts">
// チームから脱退（自分のみ。pages/t/[token]/leave.vue の中身）。先に leave_preview で影響を見せ、確認してから leave_team。
// オーナーは脱退できない（交代または削除へ案内）。脱退後はチーム一覧へ。脱退は拒否リストに入らない。
import { Crown, LogOut } from 'lucide-vue-next'
import { LEAVE_CLEANUP_CONFIRM, type LeaveCleanup, type LeavePreview, type TeamSnapshot } from '~/utils/types'

const props = defineProps<{ snap: TeamSnapshot }>()
const token = computed(() => props.snap.team.id)
const repo = useRepo()
const pv = ref<LeavePreview | null>(null)
const loadError = ref('')
const busy = ref(false)
const error = ref('')
const confirmOpen = ref(false)
const cleanup = ref<LeaveCleanup | null>(null)
const cleanupError = ref('')
const deleteSelected = ref(false)
let previewRequest = 0

async function loadPreview(s: TeamSnapshot) {
  const request = ++previewRequest
  pv.value = null
  cleanup.value = null
  cleanupError.value = ''
  deleteSelected.value = false
  confirmOpen.value = false
  loadError.value = ''
  try {
    const preview = await repo.leavePreview(s.team.id)
    if (request !== previewRequest) return
    pv.value = preview
    if (!preview.is_owner && preview.sole_guardian_children.length) {
      try {
        const fresh = await repo.leaveCleanupPreview(s.team.id)
        if (request === previewRequest) {
          pv.value = fresh
          cleanup.value = fresh.sole_guardian_children.length ? fresh.cleanup : null
        }
      } catch (e) { if (request === previewRequest) cleanupError.value = errorMessage(e) }
    }
  } catch (e) { if (request === previewRequest) loadError.value = errorMessage(e) }
}
watch(() => props.snap.team.id, () => loadPreview(props.snap), { immediate: true })
async function leave(s: TeamSnapshot) {
  if (busy.value) return // double submit
  if (!pv.value || pv.value.is_owner) return
  const needsCleanup = pv.value.sole_guardian_children.length > 0
  if (needsCleanup && (!cleanup.value || !deleteSelected.value)) return
  busy.value = true
  error.value = ''
  try {
    if (needsCleanup) await repo.leaveTeamWithCleanup(s.team.id, cleanup.value!.fingerprint, LEAVE_CLEANUP_CONFIRM)
    else await repo.leaveTeam(s.team.id)
    confirmOpen.value = false
    await navigateTo({ path: '/', query: { notice: 'left' } }, { replace: true })
  } catch (e) {
    confirmOpen.value = false
    if (e instanceof RepoError && e.code === 'not_member') {
      // The first request may have committed even if its response was lost. Never repeat deletion.
      await navigateTo({ path: '/', query: { notice: 'left' } }, { replace: true })
      return
    }
    error.value = errorMessage(e)
    await loadPreview(s) // e.g. a registration only I answer for appeared meanwhile
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="!pv && !loadError" class="skeleton h-40 rounded-box bg-base-100" />
    <p v-else-if="loadError" role="alert" class="rounded-box bg-error/10 p-4 text-sm text-error">{{ loadError }}</p>

    <!-- Owner: cannot leave -->
    <AppCard v-else-if="pv!.is_owner" title="オーナーは脱退できません" :icon="Crown">
      <div class="space-y-3 text-sm text-base-content/75">
        <p>チームにはオーナーが必要なため、オーナーのままでは脱退できません。次のどちらかを先に行ってください。</p>
        <ul class="list-disc space-y-1 pl-5">
          <li>ほかのメンバーにオーナーを交代する（相手の承認が必要）。交代後は一般のメンバーとして脱退できます。</li>
          <li>ほかにメンバーがいない場合は、チームを削除する。</li>
        </ul>
        <NuxtLink :to="`/t/${token}/admin`" class="btn btn-brand min-h-11 w-full">［管理］で交代・削除を行う</NuxtLink>
      </div>
    </AppCard>

    <template v-else>
      <AppCard :title="`「${snap.team.name}」から脱退します`" :icon="LogOut">
        <MemberImpactView :impact="pv!" who="self" :token="token" :cleanup="cleanup ?? undefined" />
      </AppCard>
      <p v-if="cleanupError" role="alert" class="text-sm text-error">削除内容を確認できませんでした。{{ cleanupError }}</p>
      <button type="button" class="btn btn-ghost w-full" :disabled="busy || !pv" @click="loadPreview(snap)">脱退内容を再確認</button>
      <label v-if="cleanup && pv!.sole_guardian_children.length" class="flex items-start gap-3 rounded-box border border-error/30 bg-base-100 p-4 text-sm">
        <input v-model="deleteSelected" type="checkbox" class="checkbox checkbox-error mt-0.5 shrink-0" :disabled="busy">
        <span>単独管理の登録と出欠を削除して脱退する方法を選ぶ（元に戻せません）</span>
      </label>
      <p class="px-1 text-xs leading-relaxed text-base-content/60">
        脱退すると、このチームの画面を見られなくなります。もう一度参加したいときは、チームの管理者から参加用URLを受け取ってください。
      </p>
      <p v-if="error" role="alert" class="rounded-box bg-error/10 p-3 text-sm text-error">{{ error }}</p>
      <button v-if="cleanup && pv!.sole_guardian_children.length" type="button" class="btn btn-outline btn-error min-h-12 h-auto w-full whitespace-normal py-3" :disabled="busy || !deleteSelected" @click="confirmOpen = true">削除内容を確認して脱退へ</button>
      <button v-else type="button" class="btn btn-outline btn-error btn-lg w-full" :disabled="busy || pv!.sole_guardian_children.length > 0" @click="confirmOpen = true">
        <LogOut class="size-5" />チームから脱退する
      </button>
      <ConfirmDialog :open="confirmOpen" :title="`「${snap.team.name}」から脱退しますか？`" :confirm-label="deleteSelected ? '削除して脱退する' : '脱退する'" :busy="busy"
        @confirm="leave(snap)" @cancel="confirmOpen = false">
        <template v-if="deleteSelected && cleanup">
          <p class="font-bold text-error">次の{{ cleanup.deletions.length }}件の登録と、出欠・コメントを削除します。元に戻せません。</p>
          <ul class="space-y-2 text-sm">
            <li v-for="p in cleanup.deletions" :key="p.player_id" class="break-words">{{ p.name }}{{ p.is_self ? '（本人）' : '' }}{{ p.cancelled ? '（取り消し済み）' : '' }}：出欠 {{ p.answers }} 件</li>
          </ul>
          <p class="text-sm">共有している代理登録や、ほかの人の本人登録は削除しません。家族招待を送っただけの登録は削除対象です。</p>
        </template>
        <p v-else-if="pv!.self_registrations.length">あなたの本人登録と、その出欠は削除されます。</p>
        <p>脱退すると、このチームの画面を見られなくなります。</p>
      </ConfirmDialog>
    </template>
  </div>
</template>
