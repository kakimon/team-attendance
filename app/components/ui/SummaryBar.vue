<script setup lang="ts">
// Stacked bar + counts. "未回答" is always shown separately from "欠席".
import type { Summary } from '~/utils/types'
const props = defineProps<{ s: Summary; compact?: boolean }>()
const parts = computed(() => [
  { key: 'attend', label: '出席', n: props.s.attend, bar: 'bg-success', dot: 'bg-success' },
  { key: 'absent', label: '欠席', n: props.s.absent, bar: 'bg-error', dot: 'bg-error' },
  { key: 'undecided', label: '未定', n: props.s.undecided, bar: 'bg-warning', dot: 'bg-warning' },
  { key: 'unanswered', label: '未回答', n: props.s.unanswered, bar: 'bg-base-300', dot: 'bg-base-300' },
])
const pct = (n: number) => (props.s.total ? (n / props.s.total) * 100 : 0)
</script>

<template>
  <div class="space-y-2">
    <div class="flex h-2.5 overflow-hidden rounded-full bg-base-200" role="img"
      :aria-label="parts.map((p) => `${p.label}${p.n}`).join('、')">
      <div v-for="p in parts" :key="p.key" :class="p.bar" :style="{ width: `${pct(p.n)}%` }" />
    </div>
    <div class="grid grid-cols-4 gap-1 text-center">
      <div v-for="p in parts" :key="p.key" class="rounded-xl bg-base-200/70 py-1.5">
        <div class="flex items-center justify-center gap-1 text-[11px] text-base-content/60">
          <span class="size-1.5 rounded-full" :class="p.dot" />{{ p.label }}
        </div>
        <div class="font-bold" :class="compact ? 'text-sm' : 'text-lg'">{{ p.n }}</div>
      </div>
    </div>
  </div>
</template>
