<script setup lang="ts">
// Read-only URL with copy button (+ OS share sheet when the device supports it).
import { Check, Copy, Share2 } from 'lucide-vue-next'
const props = defineProps<{ value: string; shareTitle?: string }>()
const copied = ref(false)
const canShare = ref(false)
onMounted(() => (canShare.value = typeof navigator.share === 'function'))
async function copy() {
  try {
    await navigator.clipboard.writeText(props.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch { /* clipboard blocked: user can select the text */ }
}
async function share() {
  try { await navigator.share({ title: props.shareTitle, url: props.value }) } catch { /* cancelled */ }
}
</script>

<template>
  <div class="space-y-2">
    <div class="rounded-field border border-base-300 bg-base-200/60 px-3 py-2.5 font-mono text-xs break-all select-all">{{ value }}</div>
    <div class="grid gap-2" :class="canShare ? 'grid-cols-2' : 'grid-cols-1'">
      <button type="button" class="btn btn-brand" @click="copy">
        <component :is="copied ? Check : Copy" class="size-4" />{{ copied ? 'コピーしました' : 'URLをコピー' }}
      </button>
      <button v-if="canShare" type="button" class="btn btn-outline border-base-300" @click="share">
        <Share2 class="size-4" />共有
      </button>
    </div>
  </div>
</template>
