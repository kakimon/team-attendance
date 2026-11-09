<script setup lang="ts">
// 出欠入力: only my children. Every write is re-checked by the server.
import { CalendarDays, CircleCheck, TriangleAlert, UserPlus } from 'lucide-vue-next'
import { STATUS_LABEL, type Status, type TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const repo = useRepo()
const toast = ref<{ ok: boolean; text: string } | null>(null)
const busy = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

const mine = (s: TeamSnapshot) => s.players.filter((p) => s.myPlayerIds.includes(p.id))

function flash(ok: boolean, text: string) {
  toast.value = { ok, text }
  clearTimeout(timer)
  timer = setTimeout(() => (toast.value = null), 2000)
}
async function save(s: TeamSnapshot, eventId: string, playerId: string, status: Status, comment: string | null) {
  busy.value = `${eventId}:${playerId}`
  try {
    await repo.setAttendance(eventId, playerId, status, comment)
    applyAttendance(s, eventId, playerId, status, comment)
    flash(true, `${STATUS_LABEL[status]}で保存しました`)
  } catch (e) {
    flash(false, errorMessage(e))
  } finally {
    busy.value = ''
  }
}
function pick(s: TeamSnapshot, eventId: string, playerId: string, next: Status) {
  const cur = statusOf(s, eventId, playerId)
  return save(s, eventId, playerId, next, next === 'unanswered' ? null : cur.comment)
}
function comment(s: TeamSnapshot, eventId: string, playerId: string, text: string) {
  const cur = statusOf(s, eventId, playerId)
  if (cur.status === 'unanswered' || (cur.comment ?? '') === text) return
  return save(s, eventId, playerId, cur.status, text || null)
}
</script>

<template>
  <TeamShell v-slot="{ snap }" title="出欠入力">
    <EmptyState v-if="!mine(snap).length" :icon="UserPlus" title="出欠を入力できるお子さんがいません"
      text="家族がすでに登録済みなら、家族から招待リンクを送ってもらってください。">
      <NuxtLink :to="`/t/${token}/children/new`" class="btn btn-brand">子どもを登録する</NuxtLink>
    </EmptyState>
    <EmptyState v-else-if="!snap.events.length" :icon="CalendarDays" title="予定はまだありません" />

    <template v-else>
      <p class="px-1 text-xs text-base-content/55">選択中のボタンをもう一度押すと「未回答」に戻ります。</p>
      <AppCard v-for="e in snap.events" :key="e.id">
        <EventInfo :e="e" />
        <ul class="mt-4 space-y-4">
          <li v-for="p in mine(snap)" :key="p.id" class="space-y-2.5 rounded-2xl bg-base-200/60 p-3">
            <div class="flex items-center gap-2">
              <TeamAvatar :name="p.name" size="sm" soft />
              <span class="flex-1 truncate font-bold">{{ p.name }}</span>
              <StatusPill :status="statusOf(snap, e.id, p.id).status" />
            </div>
            <StatusPicker :status="statusOf(snap, e.id, p.id).status" :disabled="busy === `${e.id}:${p.id}`"
              @pick="(v) => pick(snap, e.id, p.id, v)" />
            <input v-if="statusOf(snap, e.id, p.id).status !== 'unanswered'" type="text" maxlength="100"
              class="input w-full bg-base-100" placeholder="ひとこと（任意）"
              :value="statusOf(snap, e.id, p.id).comment ?? ''" aria-label="ひとこと"
              @change="comment(snap, e.id, p.id, ($event.target as HTMLInputElement).value.trim())">
          </li>
        </ul>
      </AppCard>
    </template>

    <div v-if="toast" class="toast toast-center bottom-20 z-30 md:bottom-6" role="status">
      <div class="alert rounded-full px-5 py-2 shadow-soft" :class="toast.ok ? 'alert-success' : 'alert-error'">
        <component :is="toast.ok ? CircleCheck : TriangleAlert" class="size-4" />{{ toast.text }}
      </div>
    </div>
  </TeamShell>
</template>
