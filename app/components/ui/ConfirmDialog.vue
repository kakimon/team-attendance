<script setup lang="ts">
// Confirmation sheet for destructive actions (bottom sheet on phones, centered on PC).
import { TriangleAlert } from 'lucide-vue-next'
const props = defineProps<{ open: boolean; title: string; confirmLabel: string; busy?: boolean }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const dlg = ref<HTMLDialogElement | null>(null)
watch(() => props.open, (v) => (v ? dlg.value?.showModal() : dlg.value?.close()))
</script>

<template>
  <dialog ref="dlg" class="modal modal-bottom sm:modal-middle" @close="emit('cancel')">
    <div class="modal-box space-y-4 rounded-t-3xl sm:rounded-box">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-2xl bg-error/10 text-error"><TriangleAlert class="size-5" /></span>
        <div class="space-y-1">
          <h3 class="font-bold">{{ title }}</h3>
          <div class="text-sm text-base-content/70"><slot /></div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" class="btn border-base-300 bg-base-100" :disabled="busy" @click="emit('cancel')">やめる</button>
        <button type="button" class="btn btn-error text-white" :disabled="busy" @click="emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button aria-label="閉じる">close</button></form>
  </dialog>
</template>
