<script setup lang="ts">
defineProps<{ label: string; hint?: string; optional?: boolean }>()
</script>

<template>
  <label class="block space-y-1.5">
    <span class="flex items-center gap-1.5 text-sm font-bold">
      {{ label }}<span v-if="optional" class="text-xs font-normal text-base-content/50">（任意）</span>
    </span>
    <slot />
    <span v-if="hint" class="block text-xs text-base-content/55">{{ hint }}</span>
  </label>
</template>
