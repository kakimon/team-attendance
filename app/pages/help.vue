<script setup lang="ts">
// 使い方（ログイン不要）。メンバー／管理者の切替と、よくある質問。
// 内容は app/utils/helpContent.ts（いま使える機能だけ）。?for=admin で管理者向けを開く。#faq で質問へ。
import { ChevronDown, CircleHelp, Compass, Info, ListChecks, ShieldCheck, UsersRound } from 'lucide-vue-next'
import { ADMIN_TOPICS, FAQ, PARENT_TOPICS } from '~/utils/helpContent'
import { showGuidanceAgain, startTour } from '~/utils/guideStore'
import { guideRoleOf } from '~/utils/onboarding'
import { tourLength } from '~/utils/tour'
import type { Role, Team } from '~/utils/types'

definePageMeta({ public: true })
useHead({ title: '使い方 | みんなの出欠' })

type Audience = 'parent' | 'admin'
const route = useRoute()
const router = useRouter()
const audience = ref<Audience>(route.query.for === 'admin' ? 'admin' : 'parent')
const topics = computed(() => (audience.value === 'admin' ? ADMIN_TOPICS : PARENT_TOPICS))
const TABS: { key: Audience; label: string; icon: typeof UsersRound }[] = [
  { key: 'parent', label: 'メンバーの方', icon: UsersRound },
  { key: 'admin', label: '管理者の方', icon: ShieldCheck },
]

function select(a: Audience, focus = false) {
  audience.value = a
  router.replace({ query: a === 'admin' ? { for: 'admin' } : {}, hash: route.hash })
  if (focus) nextTick(() => document.getElementById(`help-tab-${a}`)?.focus())
}
// Signed-in users can bring back the first-use help (つぎにやること / はじめの準備 / 家族で使う).
const { user } = useAuth()
const guidanceOn = ref(false)
function guidanceAgain() {
  if (!user.value) return
  showGuidanceAgain(user.value.id)
  guidanceOn.value = true
}
// 操作ガイド: start from step 1 in the chosen team. The admin guide only for teams where I am owner /
// admin (the team screen checks the role again). With several teams, the person picks one first.
const repo = useRepo()
const teams = ref<(Team & { role: Role })[] | null>(null)
const teamsError = ref(false)
const picked = ref('')
watch(user, async (u) => {
  teams.value = null
  teamsError.value = false
  if (!u) return
  try { teams.value = await repo.myTeams() } catch { teamsError.value = true }
}, { immediate: true })
const eligible = computed(() => (teams.value ?? []).filter((t) => audience.value === 'parent' || guideRoleOf(t.role) === 'admin'))
watch([eligible, audience], () => { picked.value = eligible.value.length === 1 ? eligible.value[0]!.id : '' }, { immediate: true })
function startGuide() {
  const t = eligible.value.find((x) => x.id === picked.value)
  if (!user.value || !t) return
  startTour(user.value.id, t.id, audience.value)
  navigateTo(`/t/${t.id}`)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    select(audience.value === 'parent' ? 'admin' : 'parent', true)
  }
}
</script>

<template>
  <div>
    <AppHeader title="使い方" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-3xl space-y-5 px-4 py-5 md:px-6">
      <div role="tablist" aria-label="だれ向けの説明か" class="grid grid-cols-2 gap-1 rounded-box bg-base-100 p-1 shadow-soft">
        <button v-for="t in TABS" :id="`help-tab-${t.key}`" :key="t.key" type="button" role="tab"
          :aria-selected="audience === t.key" :aria-controls="`help-panel`" :tabindex="audience === t.key ? 0 : -1"
          class="flex min-h-11 items-center justify-center gap-1.5 rounded-field px-2 text-sm font-bold transition"
          :class="audience === t.key ? 'bg-primary text-primary-content' : 'text-base-content/70 hover:bg-base-200'"
          @click="select(t.key)" @keydown="onKey">
          <component :is="t.icon" class="size-4" aria-hidden="true" />{{ t.label }}
        </button>
      </div>

      <div v-if="user" class="flex flex-wrap items-center gap-3 rounded-box bg-base-100 p-4 text-sm shadow-soft">
        <ListChecks class="size-5 shrink-0 text-primary" aria-hidden="true" />
        <p class="min-w-0 flex-1">「つぎにやること」と「はじめの準備」を、チームの［出欠一覧］にもう一度表示します。</p>
        <button type="button" class="btn btn-outline min-h-11 border-base-300" :disabled="guidanceOn" @click="guidanceAgain">
          {{ guidanceOn ? '表示するようにしました' : 'もう一度表示する' }}
        </button>
        <p v-if="guidanceOn" role="status" class="w-full text-xs text-success">次にチーム画面を開くと表示されます。</p>
      </div>

      <section aria-labelledby="tour-title" class="rounded-box bg-base-100 p-4 text-sm shadow-soft">
        <h2 id="tour-title" class="flex items-center gap-2 text-base font-bold">
          <Compass class="size-5 shrink-0 text-primary" aria-hidden="true" />操作ガイド（{{ audience === 'admin' ? '管理者向け' : 'メンバー向け' }}・{{ tourLength(audience) }}ステップ）
        </h2>
        <p class="mt-1 text-base-content/70">チームの画面を順番に案内します。ガイドがボタンを押したり、登録・保存したりすることはありません。何度でも最初から見られます。</p>
        <template v-if="!user">
          <p class="mt-3 text-base-content/70">ガイドは、ログインしてチームに参加すると始められます。チームへの参加は、管理者から届いた共有URLを開いて行います。</p>
          <NuxtLink to="/" class="btn btn-outline mt-3 min-h-11 border-base-300">ログインする</NuxtLink>
        </template>
        <p v-else-if="teamsError" role="alert" class="mt-3 text-error">チームを読み込めませんでした。時間をおいてもう一度開いてください。</p>
        <p v-else-if="!teams" class="mt-3 text-base-content/55">チームを読み込み中…</p>
        <p v-else-if="!eligible.length" class="mt-3 text-base-content/70">
          {{ audience === 'admin' ? 'あなたが管理者（オーナー）のチームがないため、管理者向けガイドは始められません。' : 'チームに参加すると始められます。管理者から届いた共有URLを開いてください。' }}
        </p>
        <div v-else class="mt-3 flex flex-wrap items-end gap-3">
          <label v-if="eligible.length > 1" class="min-w-0 flex-1">
            <span class="mb-1 block text-xs font-bold text-base-content/70">ガイドを見るチーム</span>
            <select v-model="picked" class="select w-full min-h-11">
              <option value="" disabled>チームを選んでください</option>
              <option v-for="t in eligible" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
          </label>
          <p v-else class="min-w-0 flex-1 text-base-content/70">チーム：<b>{{ eligible[0]!.name }}</b></p>
          <button type="button" class="btn btn-brand min-h-11" :disabled="!picked" @click="startGuide">ガイドを始める</button>
        </div>
      </section>

      <section id="help-panel" role="tabpanel" :aria-labelledby="`help-tab-${audience}`" class="space-y-3">
        <article v-for="(t, i) in topics" :id="t.id" :key="t.id" class="rounded-box bg-base-100 p-4 shadow-soft md:p-5">
          <h2 class="flex items-start gap-2 text-base font-bold">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-xs text-primary" aria-hidden="true">{{ i + 1 }}</span>
            <span><span class="sr-only">{{ i + 1 }}. </span>{{ t.title }}</span>
          </h2>
          <ol class="mt-3 list-decimal space-y-1.5 pl-6 text-sm leading-relaxed text-base-content/85 marker:text-base-content/45">
            <li v-for="(s, j) in t.steps" :key="j">{{ s }}</li>
          </ol>
          <p v-if="t.note" class="mt-3 flex gap-2 rounded-field bg-base-200/70 p-3 text-xs leading-relaxed text-base-content/75">
            <Info class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><span><span class="sr-only">補足：</span>{{ t.note }}</span>
          </p>
        </article>
      </section>

      <section id="faq" aria-labelledby="faq-title" class="space-y-2 scroll-mt-4">
        <h2 id="faq-title" class="flex items-center gap-2 px-1 pt-2 text-base font-bold">
          <CircleHelp class="size-5 text-primary" aria-hidden="true" />よくある質問
        </h2>
        <details v-for="f in FAQ" :id="`faq-${f.id}`" :key="f.id" class="group rounded-box bg-base-100 shadow-soft">
          <summary class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-bold [&::-webkit-details-marker]:hidden">
            <span class="flex-1">{{ f.q }}</span>
            <ChevronDown class="size-4 shrink-0 text-base-content/45 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div class="space-y-2 px-4 pb-4 text-sm leading-relaxed text-base-content/80">
            <p v-for="(a, j) in f.a" :key="j">{{ a }}</p>
          </div>
        </details>
      </section>

      <p class="px-1 text-center text-xs text-base-content/60">
        解決しないときは、下の「お問い合わせ」からご連絡ください。
      </p>
      <LegalFooter />
    </main>
  </div>
</template>
