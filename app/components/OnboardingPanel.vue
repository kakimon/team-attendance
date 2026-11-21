<script setup lang="ts">
// 出欠一覧の上部：「つぎにやること」（最大 1 枚）と「はじめの準備」（初期状態はたたむ）。
// 自動で出すのは、まだそのチームを使っていない人（DB の利用実績なし）だけ。既存利用者には
// /help の［もう一度表示する］で任意に表示。端末保存は表示の便宜だけ（権限の判断はサーバー）。
import { CalendarPlus, Check, ChevronDown, Circle, Compass, ListChecks, Mail, PenLine, UserPlus, X } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'
import { type OnboardingFacts, checklist, guidanceDecision, guideRoleOf, nextStep, startOfToday, upcomingStatus } from '~/utils/onboarding'
import { SNOOZE_MS, getTeamGuide, guideRevision, isHidden, isOptedIn, setTour, startTour, updateTeamGuide, type TeamGuideState } from '~/utils/guideStore'
import { tourLength, tourOffer } from '~/utils/tour'

const props = defineProps<{ snap: TeamSnapshot; token: string }>()
const repo = useRepo()
const { user } = useAuth()

const facts = ref<OnboardingFacts | null>(null)   // null = loading or failed: decide nothing from it
const store = ref<TeamGuideState>({})
const expanded = ref(false)                        // the checklist starts folded; kept while on this screen
const finishedHere = ref(false)                    // completed during this visit: stay visible (folded) until leaving
const role = computed(() => guideRoleOf(props.snap.me.role))
const teamId = computed(() => props.snap.team.id)

async function loadFacts() {
  facts.value = null
  const forTeam = teamId.value
  try {
    const f = await repo.onboardingFacts(forTeam, props.snap.myPlayerIds)
    if (forTeam === teamId.value) facts.value = f // ignore a late answer for another team
  } catch { facts.value = null }
}
function readStore() { store.value = user.value ? getTeamGuide(user.value.id, teamId.value, role.value) : {} }
function patch(p: Partial<TeamGuideState>) {
  if (!user.value) return
  updateTeamGuide(user.value.id, teamId.value, role.value, p)
  readStore()
}
// Team switch, role change (e.g. after an owner hand-over) -> fresh, folded, decided again.
watch(() => [teamId.value, props.snap.me.role], () => { expanded.value = false; finishedHere.value = false }, { immediate: true })
watch(() => [teamId.value, props.snap.me.role, props.snap.myPlayerIds.join(',')], () => { readStore(); loadFacts() }, { immediate: true })
watch(guideRevision, readStore) // e.g. the 一覧表 was just shown below

const decision = computed(() => guidanceDecision({
  facts: facts.value, role: role.value, myChildCount: props.snap.myPlayerIds.length,
  intro: store.value, optedIn: !!user.value && isOptedIn(user.value.id),
}))
const showGuidance = computed(() => decision.value.show || finishedHere.value)
// The first time the help is shown on this device, remember it, so it keeps going while the person
// registers / answers (which would otherwise count as "already used").
watch(decision, (d) => { if (d.reason === 'first-time') patch({ introStarted: true }) })

const status = computed(() => upcomingStatus(props.snap, startOfToday()))
const step = computed(() => nextStep({
  role: props.snap.me.role,
  myChildCount: props.snap.myPlayerIds.length,
  upcomingEvents: status.value.upcomingEvents,
  unanswered: status.value.unanswered,
  memberCount: facts.value?.memberCount ?? null,
  showGuidance: showGuidance.value,
}))
// ---- 操作ガイド（ツアー）: never started automatically; offered as the one card, or hidden while it runs ----
const otherRecord = computed(() => {
  void guideRevision.value
  return user.value ? getTeamGuide(user.value.id, teamId.value, role.value === 'admin' ? 'parent' : 'admin') : {}
})
const tourRunning = computed(() => store.value.tour?.status === 'active' || otherRecord.value.tour?.status === 'active')
const offer = computed(() => !!facts.value && tourOffer({
  kind: role.value, tour: store.value.tour, otherRecordExists: Object.keys(otherRecord.value).length > 0,
  showGuidance: showGuidance.value, running: tourRunning.value,
}))
function watchTour() {
  if (!user.value) return
  const t = store.value.tour
  if (t?.status === 'later') setTour(user.value.id, teamId.value, role.value, { status: 'active', step: t.step }) // continue
  else startTour(user.value.id, teamId.value, role.value)
}
const tourLater = () => user.value && setTour(user.value.id, teamId.value, role.value, { status: 'later', step: store.value.tour?.step ?? 0, snoozeUntil: Date.now() + SNOOZE_MS })
const tourNo = () => user.value && setTour(user.value.id, teamId.value, role.value, { status: 'skipped', step: store.value.tour?.step ?? 0 })

const showCard = computed(() => !!step.value && !isHidden(store.value.card) && !offer.value && !tourRunning.value)

const items = computed(() => (facts.value ? checklist(role.value, facts.value, props.snap.myPlayerIds.length, store.value, props.token) : []))
const doneCount = computed(() => items.value.filter((i) => i.done).length)
const allDone = computed(() => items.value.length > 0 && doneCount.value === items.value.length)
const showList = computed(() => showGuidance.value && items.value.length > 0 && !isHidden(store.value.list) && !tourRunning.value)
// All done: fold automatically, and count the help as seen (it will not come back by itself).
watch(allDone, (d) => {
  if (d && showGuidance.value && !store.value.introDone) {
    finishedHere.value = true
    expanded.value = false
    patch({ introDone: true })
  }
})

const CARD = computed(() => {
  const t = props.token
  switch (step.value?.kind) {
    case 'child': return { icon: UserPlus, title: '回答する人を登録しましょう', text: '自分が参加するなら自分を、お子さんなどの代わりに回答するならその人を登録します。家族がすでに登録している場合は、家族から招待を受け取ってください。', to: `/t/${t}/children`, action: '登録する' }
    case 'answer': return { icon: PenLine, title: '出欠を回答しましょう', text: `今日以降の予定に、未回答が ${step.value.count} 件あります。`, to: `/t/${t}/answer`, action: '出欠を回答する' }
    case 'invite': return { icon: Mail, title: '招待リンクを送りましょう', text: 'メンバーはまだあなただけです。LINE などでリンクを送ると参加できます。', to: `/t/${t}/admin`, action: '招待リンクを開く' }
    case 'event': return { icon: CalendarPlus, title: '予定を登録しましょう', text: '今日以降の予定がありません。', to: `/t/${t}/admin`, action: '予定を追加する' }
    default: return null
  }
})
const later = (k: 'card' | 'list') => patch({ [k]: { snoozeUntil: Date.now() + SNOOZE_MS } })
function close(k: 'card' | 'list') {
  // Closing the checklist also counts as "seen": it does not come back until /help turns it on.
  patch(k === 'list' ? { list: { dismissed: true }, introDone: true } : { card: { dismissed: true } })
  if (k === 'list') finishedHere.value = false
}
</script>

<template>
  <section v-if="offer && !tourRunning" aria-labelledby="tour-offer-title" class="rounded-box border-l-4 border-primary bg-base-100 p-3 shadow-soft sm:p-4">
    <div class="flex items-start gap-3">
      <span class="hidden size-9 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary min-[360px]:grid" aria-hidden="true"><Compass class="size-5" /></span>
      <div class="min-w-0 flex-1">
        <p class="text-xs font-bold text-primary">{{ role === 'admin' ? '管理者の方へ' : 'はじめての方へ' }}</p>
        <h2 id="tour-offer-title" class="font-bold leading-snug">{{ store.tour?.status === 'later' ? '操作ガイドの続きを見ますか？' : '操作ガイドを見ますか？' }}</h2>
        <p class="mt-0.5 text-xs leading-relaxed text-base-content/65">画面を順番に案内します（{{ tourLength(role) }}ステップ）。いつでも終了でき、［使い方］からもう一度見られます。</p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm btn-square -mt-1 -mr-1 min-h-11 min-w-11" aria-label="操作ガイドの案内を閉じる（使い方からいつでも見られます）" @click="tourNo">
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <div class="mt-2 flex items-center gap-2">
      <button type="button" class="btn btn-brand min-h-11 flex-1" @click="watchTour">ガイドを見る</button>
      <button type="button" class="btn btn-ghost min-h-11" @click="tourLater">あとで</button>
    </div>
  </section>

  <section v-if="showCard && CARD" aria-labelledby="next-step-title" class="rounded-box border-l-4 border-primary bg-base-100 p-3 shadow-soft sm:p-4">
    <div class="flex items-start gap-3">
      <span class="hidden size-9 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary min-[360px]:grid" aria-hidden="true"><component :is="CARD.icon" class="size-5" /></span>
      <div class="min-w-0 flex-1">
        <p class="text-xs font-bold text-primary">つぎにやること</p>
        <h2 id="next-step-title" class="font-bold leading-snug">{{ CARD.title }}</h2>
        <p class="mt-0.5 text-xs leading-relaxed text-base-content/65">{{ CARD.text }}</p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm btn-square -mt-1 -mr-1 min-h-11 min-w-11" aria-label="つぎにやることを閉じる（使い方ページからもう一度表示できます）" @click="close('card')">
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <div class="mt-2 flex items-center gap-2">
      <NuxtLink :to="CARD.to" class="btn btn-brand min-h-11 flex-1">{{ CARD.action }}</NuxtLink>
      <button type="button" class="btn btn-ghost min-h-11" @click="later('card')">あとで</button>
    </div>
  </section>

  <section v-if="showList" aria-labelledby="setup-title" class="rounded-box bg-base-100 shadow-soft">
    <div class="flex items-center gap-2 py-1 pr-1 pl-3">
      <ListChecks class="hidden size-5 shrink-0 text-primary min-[360px]:block" aria-hidden="true" />
      <h2 id="setup-title" class="min-w-0 flex-1 text-sm leading-tight font-bold">
        <span class="whitespace-nowrap">はじめの準備</span>{{ ' ' }}
        <span class="block text-xs font-normal whitespace-nowrap text-base-content/65">{{ doneCount }}/{{ items.length }} 完了</span>
      </h2>
      <button type="button" class="btn btn-ghost btn-sm min-h-11 px-2 text-xs" :aria-expanded="expanded" aria-controls="setup-items"
        @click="expanded = !expanded">
        {{ expanded ? '設定内容を閉じる' : '設定内容を表示' }}<ChevronDown class="size-4 transition" :class="expanded ? 'rotate-180' : ''" aria-hidden="true" />
      </button>
      <button type="button" class="btn btn-ghost btn-sm btn-square min-h-11 min-w-11" aria-label="はじめの準備を閉じる（使い方ページからもう一度表示できます）" @click="close('list')">
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <progress class="progress progress-primary mx-3 mb-2 block h-1 w-[calc(100%-1.5rem)]" :value="doneCount" :max="items.length" aria-hidden="true" />
    <div v-show="expanded" id="setup-items">
      <ul class="px-2">
        <li v-for="i in [...items].sort((a, b) => Number(a.done) - Number(b.done))" :key="i.id" class="flex min-h-11 items-center gap-2 px-2">
          <Check v-if="i.done" class="size-5 shrink-0 text-success" aria-hidden="true" />
          <Circle v-else class="size-5 shrink-0 text-base-content/30" aria-hidden="true" />
          <span class="flex-1 text-sm" :class="i.done ? 'text-base-content/55' : 'font-bold'">
            {{ i.label }}<span class="sr-only">（{{ i.done ? '完了' : '未完了' }}）</span>
          </span>
          <span v-if="i.done" class="text-xs text-success">完了</span>
          <NuxtLink v-else-if="i.to" :to="i.to" class="btn btn-outline btn-sm min-h-11 border-base-300">{{ i.action }}</NuxtLink>
        </li>
      </ul>
      <div v-if="!allDone" class="flex justify-end px-3 pb-2">
        <button type="button" class="btn btn-ghost btn-sm min-h-11" @click="later('list')">あとで</button>
      </div>
    </div>
  </section>
</template>
