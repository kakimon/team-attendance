<script setup lang="ts">
import { Check, HelpCircle, Minus, X } from 'lucide-vue-next'
import { STATUS_LABEL, type Status } from '~/utils/types'
defineProps<{ status: Status }>()
const ICON = { attend: Check, absent: X, undecided: HelpCircle, unanswered: Minus }
const CLS: Record<Status, string> = {
  attend: 'bg-success/12 text-success',
  absent: 'bg-error/10 text-error',
  undecided: 'bg-warning/15 text-[#a86b00]',
  unanswered: 'border border-dashed border-base-300 text-base-content/45',
}
</script>

<template>
  <span class="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" :class="CLS[status]">
    <component :is="ICON[status]" class="size-3.5" :stroke-width="3" />{{ STATUS_LABEL[status] }}
  </span>
</template>
