<script setup lang="ts">
// 出欠一覧: per-event view (phones) and table view; visible to all team members.
import { CalendarDays, LayoutList, PenLine, Table, UserPlus } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const view = ref<'event' | 'table'>('event')
const selected = ref<string | null>(null)
const current = (s: TeamSnapshot) => s.events.find((e) => e.id === selected.value) ?? s.events[0]
const ordered = (s: TeamSnapshot) =>
  [...s.players].sort((a, b) => Number(s.myPlayerIds.includes(b.id)) - Number(s.myPlayerIds.includes(a.id)))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="出欠一覧">
    <AppCard v-if="!snap.myPlayerIds.length" tight>
      <div class="flex items-center gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary"><UserPlus class="size-5" /></span>
        <p class="flex-1 text-sm">まずはお子さんを登録しましょう</p>
        <NuxtLink :to="`/t/${token}/children/new`" class="btn btn-brand btn-sm">登録</NuxtLink>
      </div>
    </AppCard>

    <EmptyState v-if="!snap.events.length" :icon="CalendarDays" title="予定はまだありません"
      text="管理者が予定を追加すると、ここに表示されます。" />

    <template v-else>
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-sm font-bold text-base-content/70">{{ snap.players.length }}人・{{ snap.events.length }}件の予定</h2>
        <div role="tablist" class="tabs tabs-box tabs-sm bg-base-100 shadow-soft">
          <button role="tab" class="tab gap-1" :class="{ 'tab-active': view === 'event' }" @click="view = 'event'"><LayoutList class="size-4" />予定ごと</button>
          <button role="tab" class="tab gap-1" :class="{ 'tab-active': view === 'table' }" @click="view = 'table'"><Table class="size-4" />一覧表</button>
        </div>
      </div>

      <!-- Per event -->
      <template v-if="view === 'event'">
        <div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" role="tablist" aria-label="予定を選択">
          <button v-for="e in snap.events" :key="e.id" role="tab" :aria-selected="current(snap)?.id === e.id"
            class="flex shrink-0 flex-col items-start rounded-2xl px-3.5 py-2 text-left transition"
            :class="current(snap)?.id === e.id ? 'bg-brand text-white shadow-soft' : 'bg-base-100 text-base-content shadow-soft'"
            @click="selected = e.id">
            <span class="text-sm font-bold">{{ formatDate(e.starts_at) }}</span>
            <span class="max-w-28 truncate text-xs" :class="current(snap)?.id === e.id ? 'text-white/80' : 'text-base-content/55'">{{ e.title }}</span>
          </button>
        </div>

        <AppCard v-if="current(snap)">
          <EventInfo :e="current(snap)!" />
          <div class="mt-4"><SummaryBar :s="summaryOf(snap, current(snap)!.id)" /></div>
        </AppCard>

        <AppCard v-if="current(snap)" title="メンバーの出欠" tight>
          <p v-if="!snap.players.length" class="py-4 text-center text-sm text-base-content/55">まだ子どもが登録されていません。</p>
          <ul class="divide-y divide-base-200">
            <li v-for="p in ordered(snap)" :key="p.id" class="flex items-center gap-3 py-3">
              <TeamAvatar :name="p.name" size="sm" soft />
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-1.5 truncate font-bold">
                  {{ p.name }}
                  <span v-if="snap.myPlayerIds.includes(p.id)" class="badge badge-primary badge-xs">うちの子</span>
                </p>
                <p class="truncate text-xs text-base-content/55">
                  {{ p.note }}<template v-if="statusOf(snap, current(snap)!.id, p.id).comment">　「{{ statusOf(snap, current(snap)!.id, p.id).comment }}」</template>
                </p>
              </div>
              <StatusPill :status="statusOf(snap, current(snap)!.id, p.id).status" />
            </li>
          </ul>
        </AppCard>
      </template>

      <!-- Table -->
      <AppCard v-else tight>
        <div class="-mx-4 overflow-x-auto">
          <table class="table table-pin-cols table-sm">
            <thead>
              <tr>
                <th class="bg-base-100">名前</th>
                <td v-for="e in snap.events" :key="e.id" class="min-w-20 text-center align-top">
                  <div class="font-bold">{{ formatDate(e.starts_at) }}</div>
                  <div class="text-xs font-normal text-base-content/55">{{ e.title }}</div>
                </td>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in ordered(snap)" :key="p.id">
                <th class="bg-base-100 whitespace-nowrap">
                  {{ p.name }}
                  <span v-if="snap.myPlayerIds.includes(p.id)" class="badge badge-primary badge-xs ml-1">うちの子</span>
                </th>
                <td v-for="e in snap.events" :key="e.id" class="text-center">
                  <StatusMark :status="statusOf(snap, e.id, p.id).status" />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th class="bg-base-100">出席</th>
                <td v-for="e in snap.events" :key="e.id" class="text-center">{{ summaryOf(snap, e.id).attend }}/{{ snap.players.length }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="mt-2 text-xs text-base-content/55">○出席　×欠席　△未定　−未回答</p>
      </AppCard>

      <NuxtLink v-if="snap.myPlayerIds.length" :to="`/t/${token}/answer`" class="btn btn-brand btn-lg w-full">
        <PenLine class="size-5" />うちの子の出欠を入力する
      </NuxtLink>
    </template>
  </TeamShell>
</template>
