<script setup lang="ts">
import { Clock, MapPin } from 'lucide-vue-next'
import type { TeamEvent } from '~/utils/types'
defineProps<{ e: TeamEvent }>()
const time = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="flex gap-3">
    <EventDate :iso="e.starts_at" />
    <div class="min-w-0 flex-1 space-y-0.5">
      <p class="font-bold leading-snug">{{ e.title }}</p>
      <p class="flex items-center gap-1 text-xs text-base-content/60"><Clock class="size-3.5" />{{ time(e.starts_at) }}〜</p>
      <p v-if="e.location" class="flex items-center gap-1 text-xs text-base-content/60"><MapPin class="size-3.5" />{{ e.location }}</p>
      <p v-if="e.note" class="text-xs text-base-content/60">{{ e.note }}</p>
    </div>
  </div>
</template>
