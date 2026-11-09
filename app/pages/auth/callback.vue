<script setup lang="ts">
// Supabase (PKCE) exchanges ?code= during auth.init() (detectSessionInUrl).
import { TriangleAlert } from 'lucide-vue-next'
const { user } = useAuth()
const error = ref('')
onMounted(async () => {
  if (!user.value) {
    error.value = 'ログインに失敗しました。もう一度お試しください。'
    return
  }
  const to = safeRedirect(sessionStorage.getItem('auth:redirect'), '/')
  sessionStorage.removeItem('auth:redirect')
  await navigateTo(to, { replace: true })
})
</script>

<template>
  <main class="mx-auto max-w-md px-4 py-16">
    <EmptyState v-if="error" :icon="TriangleAlert" tone="error" title="ログインできませんでした" :text="error">
      <NuxtLink to="/" class="btn btn-brand">ログイン画面へ戻る</NuxtLink>
    </EmptyState>
    <div v-else class="flex flex-col items-center gap-3 text-base-content/60">
      <span class="loading loading-spinner loading-lg text-primary" />
      <p class="text-sm">ログインしています…</p>
    </div>
  </main>
</template>
