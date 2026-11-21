<script setup lang="ts">
// 管理: join link (参加用URL), create events, totals, members (owner: remove / block list / hand-over),
// deleting the team (owner). Server re-checks the role on every write.
import { CalendarDays, CalendarPlus, ChartColumn, Lock, LogOut, PenLine } from 'lucide-vue-next'
import { updateTeamGuide } from '~/utils/guideStore'
import type { TeamSnapshot } from '~/utils/types'

const repo = useRepo()
const form = reactive({ title: '', date: '', time: '09:00', location: '', note: '' })
const error = ref('')
const done = ref(false)
const busy = ref(false)

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

/** Checklist convenience (this device): the team link was copied or shared. */
const { user } = useAuth()
function markShared(s: TeamSnapshot) {
  if (user.value) updateTeamGuide(user.value.id, s.team.id, 'admin', { sharedLink: true })
}
</script>

<template>
  <TeamShell v-slot="{ snap, reload }" title="管理">
    <EmptyState v-if="!isAdminRole(snap)" :icon="Lock" tone="error" title="管理者のみ利用できます" />

    <template v-else>
      <JoinLinkCard :snap="snap" @shared="markShared(snap)" />

      <AppCard title="予定を追加" :icon="CalendarPlus" data-guide="event-add">
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

      <AppCard title="予定と出欠集計" :icon="ChartColumn" data-guide="admin-summary">
        <EmptyState v-if="!snap.events.length" :icon="CalendarDays" title="予定はまだありません" class="shadow-none" />
        <ul class="space-y-5">
          <li v-for="e in snap.events" :key="e.id" class="space-y-3">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1"><EventInfo :e="e" /></div>
              <NuxtLink :to="`/t/${snap.team.id}/events/${e.id}`" class="btn btn-sm border-base-300 bg-base-100" :aria-label="`${e.title}を編集`">
                <PenLine class="size-4" />編集
              </NuxtLink>
            </div>
            <SummaryBar :s="summaryOf(snap, e.id)" compact />
          </li>
        </ul>
      </AppCard>

      <MemberManagement :snap="snap" :reload="reload" />
      <TeamDeleteCard v-if="snap.me.role === 'owner'" :snap="snap" />
      <NuxtLink v-else :to="`/t/${snap.team.id}/leave`" class="btn btn-ghost min-h-11 w-full text-error"><LogOut class="size-4" />このチームから脱退する</NuxtLink>
    </template>
  </TeamShell>
</template>
