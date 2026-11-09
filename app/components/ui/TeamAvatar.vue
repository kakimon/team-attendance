<script setup lang="ts">
// Initial-letter avatar (no images, works for any kind of group).
const props = defineProps<{ name: string; size?: 'sm' | 'md' | 'lg'; soft?: boolean }>()
const initial = computed(() => props.name.trim().charAt(0) || '?')
const cls = computed(() => ({ sm: 'size-9 text-sm', md: 'size-11 text-base', lg: 'size-14 text-xl' })[props.size ?? 'md'])
</script>

<template>
  <span class="grid shrink-0 place-items-center rounded-2xl font-bold" :class="[cls, soft ? 'bg-primary/10 text-primary' : 'bg-brand text-white']">
    {{ initial }}
  </span>
</template>
