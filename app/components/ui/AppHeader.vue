<script setup lang="ts">
// Gradient page header. `back` shows a back link; default slot = extra content (e.g. desktop tabs).
import { ChevronLeft } from 'lucide-vue-next'
defineProps<{ title: string; subtitle?: string; back?: string; hideAccount?: boolean }>()
</script>

<template>
  <header class="bg-brand text-white">
    <div class="mx-auto max-w-3xl px-4 pt-[max(env(safe-area-inset-top),0.75rem)] md:px-6">
      <div class="flex min-h-14 items-center gap-2">
        <NuxtLink v-if="back" :to="back" class="btn btn-ghost btn-sm btn-circle -ml-2 text-white hover:bg-white/15" aria-label="戻る">
          <ChevronLeft class="size-6" />
        </NuxtLink>
        <div class="min-w-0 flex-1">
          <p v-if="subtitle" class="truncate text-xs font-medium text-white/75">{{ subtitle }}</p>
          <h1 class="truncate text-lg font-bold leading-snug">{{ title }}</h1>
        </div>
        <AccountMenu v-if="!hideAccount" />
      </div>
      <slot />
      <div class="h-4" />
    </div>
  </header>
</template>
