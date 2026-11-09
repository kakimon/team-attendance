<script setup lang="ts">
// Wraps every /t/[token]/* page: loading, not found, join prompt, header + navigation.
import { Link2Off, Lock, LogIn } from 'lucide-vue-next'
const props = defineProps<{ title: string; back?: string }>()
const route = useRoute()
const token = computed(() => String(route.params.token))
const { user } = useAuth()
const { state, load, join } = useTeamPage(() => token.value)
const displayName = ref(user.value?.name ?? '')
const joining = ref(false)
await load()

async function submitJoin() {
  joining.value = true
  await join(displayName.value.trim())
  joining.value = false
}
const roleLabel = computed(() => (state.snap ? { owner: 'オーナー', admin: '管理者', member: '' }[state.snap.me.role] : ''))
</script>

<template>
  <div>
    <!-- Loading -->
    <template v-if="state.loading && !state.snap">
      <AppHeader :title="props.title" subtitle="読み込み中…" />
      <main class="mx-auto max-w-3xl space-y-3 px-4 py-5 md:px-6">
        <div v-for="i in 3" :key="i" class="skeleton h-24 rounded-box bg-base-100" />
      </main>
    </template>

    <!-- Error / not found -->
    <template v-else-if="(state.error && !state.snap) || !state.preview">
      <AppHeader title="みんなの出欠" back="/" />
      <main class="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <EmptyState :icon="Link2Off" tone="error" :title="state.error ? 'エラーが発生しました' : 'チームが見つかりません'"
          :text="state.error || '共有URLが正しいか、もう一度確認してください。'">
          <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
        </EmptyState>
      </main>
    </template>

    <!-- Join -->
    <template v-else-if="!state.snap">
      <AppHeader :title="state.preview.name" subtitle="チームへの招待" back="/" />
      <main class="mx-auto max-w-md space-y-4 px-4 py-6">
        <AppCard>
          <div class="flex flex-col items-center gap-3 pb-2 text-center">
            <TeamAvatar :name="state.preview.name" size="lg" />
            <p class="text-lg font-bold">{{ state.preview.name }}</p>
            <p class="text-sm text-base-content/60">このチームの出欠表に参加します</p>
          </div>
          <form class="mt-4 space-y-4" @submit.prevent="submitJoin">
            <FormField label="チーム内で表示する名前" hint="例：田中（ゆうとの父）。あとから保護者だと分かる名前がおすすめです。">
              <input v-model="displayName" required maxlength="40" class="input input-lg w-full" placeholder="表示名">
            </FormField>
            <button class="btn btn-brand btn-lg w-full" :disabled="joining"><LogIn class="size-5" />参加する</button>
          </form>
        </AppCard>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <Lock class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>参加すると出欠一覧を見られます。出欠を入力できるのは、自分で登録した子（または家族から招待された子）だけです。</p>
        </div>
      </main>
    </template>

    <!-- Member -->
    <template v-else>
      <AppHeader :title="props.title" :subtitle="state.snap.team.name + (roleLabel ? `（${roleLabel}）` : '')" :back="props.back">
        <TeamTabs :token="token" :is-admin="isAdminRole(state.snap)" placement="header" />
      </AppHeader>
      <main class="mx-auto max-w-3xl space-y-4 px-4 pt-5 pb-28 md:px-6 md:pb-10">
        <div v-if="state.error" role="alert" class="alert alert-error rounded-box">{{ state.error }}</div>
        <slot :snap="state.snap" :reload="load" />
      </main>
      <TeamTabs :token="token" :is-admin="isAdminRole(state.snap)" placement="bottom" />
    </template>
  </div>
</template>
