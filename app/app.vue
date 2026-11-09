<script setup lang="ts">
import { TriangleAlert } from 'lucide-vue-next'
const { $appMode } = useNuxtApp()
</script>

<template>
  <div class="min-h-dvh bg-base-200 text-base-content">
    <main v-if="$appMode === 'misconfigured'" class="mx-auto max-w-md px-4 py-16">
      <EmptyState :icon="TriangleAlert" tone="error" title="アプリの設定が不足しています"
        text="Supabase の接続設定がありません。管理者に連絡してください。" />
    </main>
    <template v-else>
      <div v-if="$appMode === 'demo'" class="bg-warning px-4 py-1 text-center text-xs font-bold text-warning-content">
        デモモード（開発用・データは保存されません）
      </div>
      <NuxtPage />
    </template>
  </div>
</template>
