<script setup lang="ts">
// チーム作成: the creator becomes owner. Members join via the shared URL.
import { CalendarPlus, CircleCheck, Info, UsersRound } from 'lucide-vue-next'
const { user } = useAuth()
const repo = useRepo()
const name = ref('')
const displayName = ref(user.value?.name ?? '')
const created = ref<{ name: string; url: string; token: string } | null>(null)
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    const t = await repo.createTeam(name.value.trim(), displayName.value.trim())
    created.value = { name: t.name, token: t.share_token, url: shareUrl('team', t.share_token, location.origin, useRuntimeConfig().app.baseURL) }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <AppHeader title="チームを作成" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <template v-if="created">
        <AppCard>
          <div class="flex flex-col items-center gap-2 text-center">
            <span class="grid size-14 place-items-center rounded-2xl bg-success/12 text-success"><CircleCheck class="size-8" /></span>
            <p class="text-lg font-bold">「{{ created.name }}」を作成しました</p>
            <p class="text-sm text-base-content/60">この共有URLを LINE グループなどに貼ってください。</p>
          </div>
          <div class="mt-4"><CopyField :value="created.url" :share-title="created.name" /></div>
        </AppCard>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <Info class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>URLを開いた人は「メンバー」として参加します（出欠一覧の閲覧と、自分の子の登録・入力のみ）。管理者にはなりません。</p>
        </div>
        <NuxtLink :to="`/t/${created.token}/admin`" class="btn btn-brand btn-lg w-full"><CalendarPlus class="size-5" />予定を追加する</NuxtLink>
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
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
        <button class="btn btn-brand btn-lg w-full" :disabled="busy">チームを作成する</button>
        <p class="text-center text-xs text-base-content/55">作成したあなたがチームの管理者（オーナー）になります。</p>
      </form>
      <LegalFooter />
    </main>
  </div>
</template>
