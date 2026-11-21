<script setup lang="ts">
// 参加用URL（/join/<参加トークン>）。ログインが必要（未ログインならログイン後にこの画面へ戻る）。
// トークンの確認と参加はサーバーが行う（preview_join / join_by_token）。参加したらチーム画面
// （/t/<チームID>）へ移り、トークン入りの URL は履歴に残さない（replace）。
import { CircleCheck, Link2Off, Lock, LogIn, ShieldCheck } from 'lucide-vue-next'
import type { JoinPreview } from '~/utils/types'

useHead({ title: 'チームへの参加 | みんなの出欠' })   // never the token or the team name in the title
const route = useRoute()
const repo = useRepo()
const { user } = useAuth()
const token = String(route.params.token)
const preview = ref<JoinPreview | null>(null)
const loading = ref(true)
const loadError = ref('')
const displayName = ref(user.value?.name ?? '')
const busy = ref(false)
const error = ref('')
const invalid = ref(false)

try {
  preview.value = await repo.previewJoin(token)
  invalid.value = !preview.value
} catch (e) {
  loadError.value = errorMessage(e)
} finally {
  loading.value = false
}

const goTeam = (teamId: string) => navigateTo(`/t/${teamId}`, { replace: true })

async function submit() {
  if (busy.value) return // double submit
  error.value = ''
  busy.value = true
  try {
    const r = await repo.joinByToken(token, displayName.value.trim())
    if (r.status === 'invalid') {
      invalid.value = true
      return
    }
    await goTeam(r.team_id)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <AppHeader title="チームへの参加" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-6">
      <div v-if="loading" class="skeleton h-48 rounded-box bg-base-100" />

      <EmptyState v-else-if="loadError" :icon="Link2Off" tone="error" title="参加画面を開けませんでした" :text="loadError">
        <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
      </EmptyState>

      <!-- Unknown, re-issued or stopped link (the same answer for every case) -->
      <EmptyState v-else-if="invalid || !preview" :icon="Link2Off" tone="error" title="この参加用URLは使えません"
        text="参加用URLが再発行されたか、参加の受付が停止されています。チームの管理者に、新しい参加用URLを確認してください。">
        <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
      </EmptyState>

      <!-- Already a member -->
      <AppCard v-else-if="preview.is_member">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="grid size-14 place-items-center rounded-2xl bg-success/12 text-success"><CircleCheck class="size-8" /></span>
          <p class="text-lg font-bold">すでに参加しています</p>
          <p class="text-sm text-base-content/65">「{{ preview.name }}」のメンバーです。</p>
          <button type="button" class="btn btn-brand btn-lg mt-2 w-full" @click="goTeam(preview.team_id)">チームの画面へ</button>
        </div>
      </AppCard>

      <!-- Join -->
      <template v-else>
        <ol class="flex items-center justify-center gap-1.5 text-[11px] whitespace-nowrap text-base-content/60" aria-label="参加の手順">
          <li class="flex items-center gap-1"><span class="grid size-5 place-items-center rounded-full bg-success text-[10px] font-bold text-white" aria-hidden="true">✓</span>ログイン<span class="sr-only">（完了）</span></li>
          <li aria-hidden="true">―</li>
          <li class="flex items-center gap-1 font-bold text-primary" aria-current="step"><span class="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-bold text-white" aria-hidden="true">2</span>名前を入れて参加</li>
          <li aria-hidden="true">―</li>
          <li class="flex items-center gap-1"><span class="grid size-5 place-items-center rounded-full bg-base-300 text-[10px] font-bold" aria-hidden="true">3</span>チーム画面</li>
        </ol>
        <AppCard>
          <div class="flex flex-col items-center gap-3 pb-2 text-center">
            <TeamAvatar :name="preview.name" size="lg" />
            <p class="text-lg font-bold">{{ preview.name }}</p>
            <p class="text-sm text-base-content/60">このチームの出欠表に参加します</p>
          </div>
          <form class="mt-4 space-y-4" @submit.prevent="submit">
            <FormField label="チーム内で表示する名前" hint="例：田中 太郎、田中（ゆうとの父）。チームの人に分かる名前がおすすめです。">
              <input v-model="displayName" required maxlength="40" class="input input-lg w-full" placeholder="表示名">
            </FormField>
            <p v-if="error" role="alert" class="rounded-xl bg-error/10 p-3 text-sm text-error">{{ error }}</p>
            <button class="btn btn-brand btn-lg w-full" :disabled="busy" :aria-busy="busy">
              <span v-if="busy" class="loading loading-spinner loading-sm" aria-hidden="true" /><LogIn v-else class="size-5" />チームに参加する
            </button>
          </form>
        </AppCard>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <Lock class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>参加すると出欠一覧を見られます。出欠を入力できるのは、自分（本人として登録した場合）と、自分で登録した人・家族から招待された人の分だけです。</p>
        </div>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>この参加用URLは、チームの人だけに共有してください。</p>
        </div>
      </template>
      <LegalFooter />
    </main>
  </div>
</template>
