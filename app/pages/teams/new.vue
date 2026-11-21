<script setup lang="ts">
// チーム作成: the creator becomes owner. Members join via the shared URL.
import { updateTeamGuide } from '~/utils/guideStore'
import { OWNER_TEAM_LIMIT, ownedTeamCount } from '~/utils/teamUsage'
import { CalendarPlus, CircleCheck, Info, UsersRound } from 'lucide-vue-next'
const { user } = useAuth()
const repo = useRepo()
const name = ref('')
const displayName = ref(user.value?.name ?? '')
const created = ref<{ id: string; name: string; url: string } | null>(null)
const linkError = ref('')
const error = ref('')
const busy = ref(false)
const ownedCount = ref<number | null>(null)
const countLoading = ref(true)

async function refreshCount() {
  countLoading.value = true
  ownedCount.value = null
  try { ownedCount.value = ownedTeamCount(await repo.myTeams()) }
  catch { /* Unknown is shown with a retry; never infer a count from a failed request. */ }
  finally { countLoading.value = false }
}
onMounted(refreshCount)
const canCreate = computed(() => !busy.value && !countLoading.value && ownedCount.value !== null && ownedCount.value < OWNER_TEAM_LIMIT)

async function submit() {
  if (!canCreate.value) return
  busy.value = true
  error.value = ''
  try {
    const t = await repo.createTeam(name.value.trim(), displayName.value.trim())
    created.value = { id: t.id, name: t.name, url: '' }
    // The join link (参加用URL) is separate from the team page address; owners can re-issue / stop it in 管理.
    try {
      const link = await repo.getJoinLink(t.id)
      if (link.token) created.value.url = shareUrl('join', link.token, location.origin, useRuntimeConfig().app.baseURL)
    } catch (e) {
      linkError.value = errorMessage(e)
    }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    // Re-read DB state after success or refusal, including changes made in another tab.
    await refreshCount()
    busy.value = false
  }
}
/** Checklist convenience (this device): the new team's link was copied or shared. */
function markShared() {
  if (user.value && created.value) updateTeamGuide(user.value.id, created.value.id, 'admin', { sharedLink: true })
}
</script>

<template>
  <div>
    <AppHeader title="チームを作成" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <OwnedTeamUsage :count="ownedCount" :loading="countLoading" :disabled="busy" @refresh="refreshCount" />
      <template v-if="created">
        <AppCard>
          <div class="flex flex-col items-center gap-2 text-center">
            <span class="grid size-14 place-items-center rounded-2xl bg-success/12 text-success"><CircleCheck class="size-8" /></span>
            <p class="text-lg font-bold">「{{ created.name }}」を作成しました</p>
            <p class="text-sm text-base-content/60">この参加用URLを LINE グループなどに貼ってください。</p>
          </div>
          <div v-if="created.url" class="mt-4"><CopyField :value="created.url" :share-title="created.name" @copied="markShared" @shared="markShared" /></div>
          <p v-else role="alert" class="mt-4 text-sm text-error">{{ linkError || '参加用URLを表示できませんでした。' }}［管理］の「参加用URL」から確認できます。</p>
        </AppCard>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <Info class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>参加用URLを開いた人は「メンバー」として参加します（出欠一覧の閲覧と、自分・家族などの登録と出欠の入力のみ）。管理者にはなりません。参加用URLは［管理］で再発行・受付停止ができます。</p>
        </div>
        <NuxtLink :to="`/t/${created.id}/admin`" class="btn btn-brand btn-lg w-full"><CalendarPlus class="size-5" />予定を追加する</NuxtLink>
      </template>

      <form v-else class="space-y-4" @submit.prevent="submit">
        <AppCard title="チーム情報" :icon="UsersRound">
          <div class="space-y-4">
            <FormField label="チーム名" hint="クラブ・教室・サークルなど、メンバーが分かる名前">
              <input v-model="name" required maxlength="60" class="input input-lg w-full" placeholder="例：ひまわりクラブ">
            </FormField>
            <FormField label="あなたの表示名">
              <input v-model="displayName" required maxlength="40" class="input input-lg w-full" placeholder="例：代表 山田">
            </FormField>
          </div>
        </AppCard>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
        <button class="btn btn-brand btn-lg w-full" :disabled="!canCreate">チームを作成する</button>
        <p class="text-center text-xs text-base-content/55">作成したあなたがチームの管理者（オーナー）になります。</p>
      </form>
      <LegalFooter />
    </main>
  </div>
</template>
