<script setup lang="ts">
// 管理: share URL, create events, totals. Server re-checks admin role on every write.
import { CalendarDays, CalendarPlus, ChartColumn, Link, Lock } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const repo = useRepo()
const form = reactive({ title: '', date: '', time: '09:00', location: '', note: '' })
const error = ref('')
const done = ref(false)
const busy = ref(false)

const teamUrl = (s: TeamSnapshot) =>
  import.meta.client ? shareUrl('team', s.team.share_token, location.origin, useRuntimeConfig().app.baseURL) : ''
async function create(s: TeamSnapshot, reload: () => Promise<void>) {
  if (!form.title || !form.date) return
  busy.value = true
  error.value = ''
  done.value = false
  try {
    await repo.createEvent(s.team.id, {
      title: form.title.trim(),
      starts_at: new Date(`${form.date}T${form.time || '00:00'}`).toISOString(),
      location: form.location.trim() || null,
      note: form.note.trim() || null,
    })
    Object.assign(form, { title: '', date: '', location: '', note: '' })
    done.value = true
    await reload()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <TeamShell v-slot="{ snap, reload }" title="管理">
    <EmptyState v-if="!isAdminRole(snap)" :icon="Lock" tone="error" title="管理者のみ利用できます" />

    <template v-else>
      <AppCard title="チームの共有URL" :icon="Link">
        <p class="mb-3 text-sm text-base-content/65">LINEグループなどに貼ってください。開いた人はメンバーとして参加します。</p>
        <CopyField :value="teamUrl(snap)" :share-title="snap.team.name" />
      </AppCard>

      <AppCard title="予定を追加" :icon="CalendarPlus">
        <form class="space-y-4" @submit.prevent="create(snap, reload)">
          <FormField label="タイトル">
            <input v-model="form.title" required maxlength="60" class="input w-full" placeholder="例：定例練習、発表会リハーサル">
          </FormField>
          <div class="grid grid-cols-2 gap-3">
            <FormField label="日付"><input v-model="form.date" required type="date" class="input w-full"></FormField>
            <FormField label="開始時刻"><input v-model="form.time" type="time" class="input w-full"></FormField>
          </div>
          <FormField label="場所" optional><input v-model="form.location" maxlength="80" class="input w-full" placeholder="例：市民センター"></FormField>
          <FormField label="メモ" optional><input v-model="form.note" maxlength="500" class="input w-full" placeholder="例：持ち物、集合時間"></FormField>
          <p v-if="error" class="text-sm text-error">{{ error }}</p>
          <p v-if="done" class="text-sm text-success">予定を追加しました。</p>
          <button class="btn btn-brand w-full" :disabled="busy"><CalendarPlus class="size-4" />追加する</button>
        </form>
      </AppCard>

      <AppCard title="出欠集計" :icon="ChartColumn">
        <EmptyState v-if="!snap.events.length" :icon="CalendarDays" title="予定はまだありません" class="shadow-none" />
        <ul class="space-y-5">
          <li v-for="e in snap.events" :key="e.id" class="space-y-3">
            <EventInfo :e="e" />
            <SummaryBar :s="summaryOf(snap, e.id)" compact />
          </li>
        </ul>
      </AppCard>
    </template>
  </TeamShell>
</template>
