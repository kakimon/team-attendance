<script setup lang="ts">
// Three large buttons. Tapping the selected one again emits 'unanswered'.
import { Check, HelpCircle, X } from 'lucide-vue-next'
import { STATUS_LABEL, type AnswerStatus, type Status } from '~/utils/types'
const props = defineProps<{ status: Status; disabled?: boolean }>()
const emit = defineEmits<{ pick: [Status] }>()
const OPTIONS: { v: AnswerStatus; icon: typeof Check; on: string }[] = [
  { v: 'attend', icon: Check, on: 'bg-success text-white border-success' },
  { v: 'absent', icon: X, on: 'bg-error text-white border-error' },
  { v: 'undecided', icon: HelpCircle, on: 'bg-warning text-warning-content border-warning' },
]
const pick = (v: AnswerStatus) => emit('pick', props.status === v ? 'unanswered' : v)
</script>

<template>
  <div class="grid grid-cols-3 gap-2" role="group" aria-label="出欠を選択">
    <button v-for="o in OPTIONS" :key="o.v" type="button" :disabled="disabled" :aria-pressed="status === o.v"
      class="flex h-12 items-center justify-center gap-1.5 rounded-field border text-sm font-bold transition active:scale-[0.97] disabled:opacity-60"
      :class="status === o.v ? o.on : 'border-base-300 bg-base-100 text-base-content/75 hover:border-primary/40'"
      @click="pick(o.v)">
      <component :is="o.icon" class="size-4.5" :stroke-width="3" />{{ STATUS_LABEL[o.v] }}
    </button>
  </div>
</template>
