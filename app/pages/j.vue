<script setup lang="ts">
// 共有リンクの中継ページ（/j/?t=チーム or /j/?i=家族招待）。
// Pre-generated as /j/index.html, so GitHub Pages returns 200. Replaces itself in history.
import { Link2Off } from 'lucide-vue-next'
const route = useRoute()
const target = resolveJump(route.query)
if (target) await navigateTo(target, { replace: true })
</script>

<template>
  <main class="mx-auto max-w-md px-4 py-16">
    <EmptyState v-if="!target" :icon="Link2Off" tone="error" title="リンクが正しくありません"
      text="LINE などで届いたリンクを、もう一度そのまま開いてください。">
      <NuxtLink to="/" class="btn btn-outline border-base-300">トップへ</NuxtLink>
    </EmptyState>
    <div v-else class="flex justify-center"><span class="loading loading-spinner loading-lg text-primary" /></div>
  </main>
</template>
