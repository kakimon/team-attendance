<script setup lang="ts">
// 出欠入力: only the people I answer for (myself / my registrations). Every write is re-checked by the server.
import { CalendarDays, CircleCheck, TriangleAlert, UserPlus, UsersRound, X } from 'lucide-vue-next'
import { STATUS_LABEL, type Status, type TeamSnapshot } from '~/utils/types'
import { myParticipants } from '~/utils/participants'

const route = useRoute()
const token = computed(() => String(route.params.token))
const repo = useRepo()
const toast = ref<{ ok: boolean; text: string } | null>(null)
const busy = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

const mine = (s: TeamSnapshot) => myParticipants(s)
/** Just registered (自分を登録 / 家族などを登録): a one-time note. ?self=<status> after a self registration. */
const added = (s: TeamSnapshot) => {
  const id = typeof route.query.added === 'string' ? route.query.added : ''
  return id && s.myPlayerIds.includes(id) ? s.players.find((p) => p.id === id) ?? null : null
}
const addedSelf = computed(() => typeof route.query.self === 'string' ? route.query.self : '')
const closeAdded = () => navigateTo({ path: route.path, query: {} }, { replace: true })

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
    <div v-if="added(snap)" role="status" class="flex gap-3 rounded-box border-l-4 border-success bg-base-100 p-4 text-sm shadow-soft">
      <UsersRound class="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
      <div class="min-w-0 flex-1 space-y-1">
        <template v-if="addedSelf">
          <p class="font-bold">{{ addedSelf === 'existing' ? 'すでに本人として登録されています' : addedSelf === 'restored' ? '本人の登録を元に戻しました' : '本人として登録しました' }}</p>
          <p class="leading-relaxed text-base-content/75">「{{ added(snap)!.name }}」として、あなた自身の出欠を下で回答できます。</p>
        </template>
        <template v-else>
          <p class="font-bold">「{{ added(snap)!.name }}」を登録しました</p>
          <p class="leading-relaxed text-base-content/75">お父さん・お母さんなど、家族の複数のアカウントで同じ人の出欠を回答できます。二重に登録する必要はありません。</p>
          <NuxtLink :to="`/t/${token}/children/${added(snap)!.id}`" class="link link-primary inline-flex min-h-11 items-center font-bold">家族と共有する（任意）</NuxtLink>
        </template>
      </div>
      <button type="button" class="btn btn-ghost btn-sm btn-square -mt-1 -mr-1 min-h-11 min-w-11" aria-label="登録のお知らせを閉じる" @click="closeAdded">
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <EmptyState v-if="!mine(snap).length" :icon="UserPlus" title="回答する人を登録しましょう"
      text="あなた自身が参加するなら「自分を登録する」、お子さんなどの代わりに回答するなら「家族などを登録する」を選んでください。家族がすでに登録済みなら、家族から招待リンクを送ってもらってください。">
      <RegisterChoices :snap="snap" :token="token" />
    </EmptyState>
    <EmptyState v-else-if="!snap.events.length" :icon="CalendarDays" title="予定はまだありません" />

    <template v-else>
      <p class="px-1 text-xs text-base-content/55">選択中のボタンをもう一度押すと「未回答」に戻ります。</p>
      <AppCard v-for="(e, ei) in snap.events" :key="e.id">
        <EventInfo :e="e" />
        <ul class="mt-4 space-y-4">
          <li v-for="(p, pi) in mine(snap)" :key="p.id" class="space-y-2.5 rounded-2xl bg-base-200/60 p-3">
            <div class="flex items-center gap-2">
              <TeamAvatar :name="p.name" size="sm" soft />
              <span class="min-w-0 flex-1 truncate font-bold">{{ p.name }}</span>
              <span v-if="p.self_user_id" class="badge badge-ghost badge-sm shrink-0 border-base-300">本人</span>
              <StatusPill :status="statusOf(snap, e.id, p.id).status" />
            </div>
            <StatusPicker :status="statusOf(snap, e.id, p.id).status" :disabled="busy === `${e.id}:${p.id}`"
              :data-guide="ei === 0 && pi === 0 ? 'answer-first' : undefined"
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
