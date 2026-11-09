<script setup lang="ts">
import type { Component } from 'vue'
defineProps<{ icon: Component; title: string; text?: string; tone?: 'default' | 'error' }>()
</script>

<template>
  <div class="flex flex-col items-center gap-3 rounded-box bg-base-100 px-6 py-10 text-center shadow-soft">
    <span class="grid size-14 place-items-center rounded-2xl" :class="tone === 'error' ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary'">
      <component :is="icon" class="size-7" />
    </span>
    <p class="font-bold">{{ title }}</p>
    <p v-if="text" class="max-w-xs text-sm text-base-content/60">{{ text }}</p>
    <div v-if="$slots.default" class="mt-1 flex w-full max-w-xs flex-col gap-2"><slot /></div>
  </div>
</template>
