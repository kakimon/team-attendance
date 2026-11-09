<script setup lang="ts">
// Calendar-style date block (month / day / weekday).
const props = defineProps<{ iso: string }>()
const WD = ['日', '月', '火', '水', '木', '金', '土']
const d = computed(() => new Date(props.iso))
const wd = computed(() => d.value.getDay())
</script>

<template>
  <div class="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-2xl bg-base-100 text-center ring-1 ring-base-300">
    <span class="w-full bg-brand py-0.5 text-[10px] font-bold text-white">{{ d.getMonth() + 1 }}月</span>
    <span class="text-xl leading-tight font-bold">{{ d.getDate() }}</span>
    <span class="pb-1 text-[11px] font-bold" :class="wd === 0 ? 'text-error' : wd === 6 ? 'text-info' : 'text-base-content/55'">{{ WD[wd] }}</span>
  </div>
</template>
