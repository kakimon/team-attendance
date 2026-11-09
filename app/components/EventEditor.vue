<script setup lang="ts">
// 予定の編集フォーム＋削除（管理者用）。Server re-checks the admin role on every write.
import { Info, PenLine, Save, Trash2 } from 'lucide-vue-next'
import type { TeamEvent, TeamSnapshot } from '~/utils/types'

const props = defineProps<{ snap: TeamSnapshot; event: TeamEvent }>()
const route = useRoute()
const back = computed(() => `/t/${String(route.params.token)}/admin`)
const repo = useRepo()
const form = reactive({
  title: props.event.title,
  date: toDateInput(props.event.starts_at),
  time: toTimeInput(props.event.starts_at),
  location: props.event.location ?? '',
  note: props.event.note ?? '',
})
const original = { date: form.date, time: form.time }
const scheduleChanged = computed(() => form.date !== original.date || form.time !== original.time)
const answerCount = computed(() => props.snap.attendance.filter((a) => a.event_id === props.event.id).length)
const error = ref('')
const busy = ref(false)
const confirmOpen = ref(false)

async function save() {
  if (!form.title.trim() || !form.date) return
  busy.value = true
  error.value = ''
  try {
    await repo.updateEvent(props.event.id, {
      title: form.title.trim(),
      starts_at: new Date(`${form.date}T${form.time || '00:00'}`).toISOString(),
      location: form.location.trim() || null,
      note: form.note.trim() || null,
    })
    await navigateTo(back.value)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
async function remove() {
  busy.value = true
  error.value = ''
  try {
    await repo.deleteEvent(props.event.id)
    confirmOpen.value = false
    await navigateTo(back.value)
  } catch (e) {
    confirmOpen.value = false
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <form class="space-y-4" @submit.prevent="save">
      <AppCard title="予定の内容" :icon="PenLine">
        <div class="space-y-4">
          <FormField label="タイトル">
            <input v-model="form.title" required maxlength="60" class="input w-full">
          </FormField>
          <div class="grid grid-cols-2 gap-3">
            <FormField label="日付"><input v-model="form.date" required type="date" class="input w-full"></FormField>
            <FormField label="開始時刻"><input v-model="form.time" type="time" class="input w-full"></FormField>
          </div>
          <FormField label="場所" optional><input v-model="form.location" maxlength="80" class="input w-full"></FormField>
          <FormField label="メモ" optional><input v-model="form.note" maxlength="500" class="input w-full"></FormField>
        </div>
      </AppCard>

      <div v-if="scheduleChanged" role="status" class="flex gap-3 rounded-box border border-info/30 bg-info/10 p-4 text-sm">
        <Info class="mt-0.5 size-4 shrink-0 text-info" />
        <p>日時を変更しても、<b>これまでの出欠回答はそのまま残ります</b>。予定が大きく変わる場合は、LINE などで回答の見直しをお願いしてください。</p>
      </div>

      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <button class="btn btn-brand btn-lg w-full" :disabled="busy"><Save class="size-5" />保存する</button>
    </form>

    <button type="button" class="btn btn-ghost w-full text-error" :disabled="busy" @click="confirmOpen = true">
      <Trash2 class="size-4" />この予定を削除
    </button>

    <ConfirmDialog :open="confirmOpen" title="この予定を削除しますか？" confirm-label="削除する" :busy="busy"
      @confirm="remove" @cancel="confirmOpen = false">
      <p>「{{ event.title }}」は出欠一覧と集計から消えます。</p>
      <p class="mt-1">回答 {{ answerCount }} 件はデータとして保存されたまま非表示になります。</p>
    </ConfirmDialog>
  </div>
</template>
