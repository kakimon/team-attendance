<script setup lang="ts">
// 自分を登録（本人登録）: register_self(team_id) だけを送る。だれを登録するか・名前は
// サーバーが決める（チームでの表示名）。二重送信はボタンの無効化とサーバー側の判定の両方で防ぐ。
import { BadgeCheck, CircleAlert, PenLine, ShieldCheck, TriangleAlert, UserRound } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'
import { mySelfRegistration, similarToMe } from '~/utils/participants'

const route = useRoute()
const token = computed(() => String(route.params.token))
const repo = useRepo()
const error = ref('')
const busy = ref(false)
const done = ref(false)                 // set once the server answered: the button stays disabled
const confirmed = ref(false)            // "different person" chosen after the similar-name warning

async function submit(s: TeamSnapshot) {
  if (busy.value || done.value) return  // double submit (double tap / Enter)
  error.value = ''
  busy.value = true
  try {
    const r = await repo.registerSelf(s.team.id)
    done.value = true
    await navigateTo(`/t/${token.value}/answer?added=${r.player_id}&self=${r.status}`)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <TeamShell v-slot="{ snap }" title="自分を登録" :back="`/t/${token}/children`">
    <!-- 本人登録に未対応の環境 -->
    <EmptyState v-if="!snap.selfSupported" :icon="CircleAlert" tone="error" title="自分を登録する機能は、まだ使えません"
      text="この環境では、本人として登録する機能がまだ準備中です。代わりに、家族などの登録として自分の名前を登録することもできます。">
      <NuxtLink :to="`/t/${token}/children/new`" class="btn btn-outline border-base-300">家族などを登録する</NuxtLink>
    </EmptyState>

    <!-- すでに本人として登録済み（二重に作らない） -->
    <EmptyState v-else-if="mySelfRegistration(snap)" :icon="BadgeCheck" title="本人として登録済みです"
      :text="`「${mySelfRegistration(snap)!.name}」として登録されています。もう一度登録する必要はありません。`">
      <NuxtLink :to="`/t/${token}/answer`" class="btn btn-brand"><PenLine class="size-4" />出欠を入力する</NuxtLink>
    </EmptyState>

    <form v-else class="space-y-4" @submit.prevent="submit(snap)">
      <AppCard title="自分の出欠を自分で回答します" :icon="UserRound">
        <div class="space-y-3 text-sm">
          <p class="text-base-content/75">チームの一員として、あなた自身の出欠を回答するための登録です。</p>
          <div class="rounded-xl bg-base-200/70 px-3 py-2">
            <p class="text-xs text-base-content/60">登録される名前（チームでの表示名）</p>
            <p class="flex items-center gap-2 text-base font-bold">{{ snap.me.display_name }}<span class="badge badge-primary badge-sm">本人</span></p>
          </div>
          <p class="text-xs text-base-content/60">名前は、登録後に［設定・家族招待］の［編集］で変えられます。</p>
        </div>
      </AppCard>

      <div v-if="similarToMe(snap).length" role="alert" class="space-y-3 rounded-box border border-warning/50 bg-[#fff7e6] p-4">
        <p class="flex items-center gap-2 font-bold"><TriangleAlert class="size-5 text-warning" />同じ・似た名前の登録があります</p>
        <ul class="space-y-1 text-sm">
          <li v-for="p in similarToMe(snap)" :key="p.id" class="rounded-xl bg-base-100 px-3 py-2">{{ p.name }} <span class="text-base-content/55">{{ p.note }}</span></li>
        </ul>
        <p class="text-sm text-base-content/75">
          家族などがすでにあなたを登録している場合は、新しく登録せず<b>登録した人から招待リンクを送ってもらってください</b>。
          別の人であれば、このまま登録できます。
        </p>
        <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-base-100 px-3 text-sm font-bold">
          <input v-model="confirmed" type="checkbox" class="checkbox checkbox-primary">別の人なので自分を登録する
        </label>
      </div>

      <p v-if="error" role="alert" class="rounded-xl bg-error/10 p-3 text-sm text-error">{{ error }}</p>
      <button class="btn btn-brand btn-lg w-full" :disabled="busy || done || (similarToMe(snap).length > 0 && !confirmed)" :aria-busy="busy">
        <span v-if="busy" class="loading loading-spinner loading-sm" aria-hidden="true" />自分を登録する
      </button>
      <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
        <p>本人として登録した出欠は、あなたが回答します。家族などに代わりに回答してもらいたいときは、登録後に［設定・家族招待］から招待できます。お子さんなどを登録する場合は［家族などを登録する］を使ってください。</p>
      </div>
      <NuxtLink :to="`/t/${token}/children/new`" class="btn btn-ghost w-full">家族などを登録する</NuxtLink>
    </form>
  </TeamShell>
</template>
