<script setup lang="ts">
// 家族招待の受け取り: become an additional guardian (single use, 24h). Server-checked.
import { CircleCheck, PenLine, ShieldCheck, UserPlus } from 'lucide-vue-next'
const route = useRoute()
const repo = useRepo()
const { user } = useAuth()
const displayName = ref(user.value?.name ?? '')
const result = ref<{ share_token: string } | null>(null)
const error = ref('')
const busy = ref(false)

async function accept() {
  busy.value = true
  error.value = ''
  try {
    result.value = await repo.acceptInvitation(String(route.params.token), displayName.value.trim())
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <AppHeader title="家族からの招待" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <AppCard v-if="result">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="grid size-14 place-items-center rounded-2xl bg-success/12 text-success"><CircleCheck class="size-8" /></span>
          <p class="text-lg font-bold">保護者として追加されました</p>
          <p class="text-sm text-base-content/60">お子さんの出欠を入力できます。</p>
          <NuxtLink :to="`/t/${result.share_token}/answer`" class="btn btn-brand btn-lg mt-2 w-full"><PenLine class="size-5" />出欠入力へ</NuxtLink>
        </div>
      </AppCard>

      <template v-else>
        <AppCard>
          <div class="flex flex-col items-center gap-2 text-center">
            <span class="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><UserPlus class="size-7" /></span>
            <p class="text-lg font-bold">お子さんの保護者に追加されます</p>
            <p class="text-sm text-base-content/60">受け取ると、あなたのアカウントでもお子さんの出欠を入力できるようになります。</p>
          </div>
          <form class="mt-5 space-y-4" @submit.prevent="accept">
            <FormField label="チーム内で表示する名前" hint="例：田中（ゆうとの母）">
              <input v-model="displayName" required maxlength="40" class="input input-lg w-full" placeholder="表示名">
            </FormField>
            <p v-if="error" role="alert" class="rounded-xl bg-error/10 p-3 text-sm text-error">{{ error }}</p>
            <button class="btn btn-brand btn-lg w-full" :disabled="busy">招待を受け取る</button>
          </form>
        </AppCard>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>招待リンクは24時間・1回限り有効です。心当たりのない招待は受け取らないでください。</p>
        </div>
      </template>
    </main>
  </div>
</template>
