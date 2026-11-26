<script setup lang="ts">
// トップページ（未ログイン時）: what the service is, live usage numbers, main features, how to start.
// Login itself stays in pages/index.vue (Google login with the invitation / redirect kept).
import { BookOpen, CalendarCheck, ChevronRight, ExternalLink, Link, LogIn, ShieldCheck, UserPlus, UsersRound } from 'lucide-vue-next'
import type { DemoUser } from '~/plugins/data.client'
import type { ServiceStats } from '~/utils/types'
import type { InviteKind } from '~/utils/loginTarget'
import { formatCount, loadServiceStats } from '~/utils/serviceStats'

const props = defineProps<{
  invite: InviteKind
  inApp: 'line' | 'other' | null
  externalUrl: string
  error: string
  signingIn: boolean
  isDemo: boolean
  demoUsers: DemoUser[]
}>()
const emit = defineEmits<{ login: [intent: 'create' | null]; demo: [id: string] }>()

/** undefined = loading, null = not available (hidden). */
const stats = ref<ServiceStats | null | undefined>(undefined)
onMounted(async () => {
  let store: Storage | null = null
  try { store = window.localStorage } catch { /* blocked storage: no cache */ }
  stats.value = await loadServiceStats(() => useRepo().serviceStats(), store)
})
const STAT_ITEMS = [
  { key: 'users', label: '登録ユーザー', unit: '人' },
  { key: 'teams', label: '利用チーム', unit: 'チーム' },
  { key: 'answers', label: '出欠の回答', unit: '件' },
] as const

const FEATURES = [
  { icon: CalendarCheck, title: '予定と出欠をひと目で', text: '練習・試合などの予定ごとに、だれが出席・欠席・未定かを一覧で確認できます。' },
  { icon: UsersRound, title: '家族の分もまとめて回答', text: '自分の出欠も、お子さんなど家族の出欠も回答できます。家族の別のアカウントからも回答できます。' },
  { icon: Link, title: '参加はリンクを開くだけ', text: 'LINE などで参加用のリンクを送るだけ。アプリのインストールは不要です。' },
  { icon: ShieldCheck, title: '安心のしくみ', text: '回答できるのは、自分が登録した人の出欠だけ。メールアドレスはほかのメンバーに表示されません。' },
]

function start(intent: 'create' | null = null) {
  if (props.isDemo) return document.getElementById('demo-login')?.scrollIntoView({ behavior: 'smooth' })
  emit('login', intent)
}
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header class="bg-brand px-4 pt-[max(env(safe-area-inset-top),0.75rem)] text-white">
      <div class="mx-auto flex h-14 max-w-3xl items-center gap-3">
        <span class="flex min-w-0 flex-1 items-center gap-2 font-bold">
          <span class="grid size-8 shrink-0 place-items-center rounded-xl bg-white/20 ring-1 ring-white/30" aria-hidden="true"><UsersRound class="size-4.5" /></span>
          みんなの出欠
        </span>
        <NuxtLink to="/help" class="btn btn-ghost btn-sm min-h-11 text-white hover:bg-white/15"><BookOpen class="size-4" />使い方</NuxtLink>
        <button type="button" class="btn btn-sm min-h-11 border-0 bg-white text-primary hover:bg-white/90" :disabled="signingIn" @click="start()">
          <LogIn class="size-4" />ログイン
        </button>
      </div>
    </header>

    <section class="bg-brand px-6 pb-14 pt-8 text-white">
      <div class="mx-auto max-w-3xl text-center">
        <h1 class="text-3xl font-bold leading-snug [word-break:keep-all] sm:text-4xl">みんなの予定と出欠を、<wbr>もっと簡単に。</h1>
        <p class="mt-3 text-base text-white/90 [word-break:keep-all]">スポーツ少年団・サークル・<wbr>地域活動向けの<wbr>出欠管理サービス</p>
        <button type="button" class="btn btn-lg mt-6 min-w-56 border-0 bg-white font-bold text-primary shadow-soft hover:bg-white/90"
          :disabled="signingIn" @click="start()">
          {{ invite ? 'ログインして進む' : '無料で始める' }}
        </button>
        <p class="mt-2 text-xs text-white/80">Google アカウントでログインするだけ。一度ログインすれば、次回からはそのまま使えます。</p>
        <p v-if="error" role="alert" class="mt-2 text-sm font-bold text-white">{{ error }}</p>
      </div>
    </section>

    <main class="mx-auto -mt-8 w-full max-w-3xl flex-1 space-y-6 px-4 pb-6">
      <div v-if="inApp" role="alert" class="rounded-box border border-warning/40 bg-[#fff7e6] p-4 text-sm shadow-soft">
        <p class="font-bold">ブラウザで開いてください</p>
        <p class="mt-1 text-base-content/70">LINE などのアプリ内ブラウザでは Google ログインができません。Safari / Chrome で開いてください。</p>
        <a v-if="inApp === 'line'" :href="externalUrl" class="btn btn-sm mt-3"><ExternalLink class="size-4" />ブラウザで開く</a>
        <p v-else class="mt-2 text-xs">右上のメニューから「ブラウザで開く」を選んでください。</p>
      </div>

      <div v-if="invite" role="status" class="flex gap-3 rounded-box border-l-4 border-primary bg-base-100 p-4 text-sm shadow-soft">
        <Link class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <p>
          <span class="font-bold">{{ invite === 'family' ? '家族から招待されています' : 'チームに招待されています' }}</span><br>
          <span class="text-base-content/70">ログインすると、{{ invite === 'family' ? '招待の受け取り画面' : 'チームの参加画面' }}に進みます。</span>
        </p>
      </div>

      <AppCard v-if="isDemo" id="demo-login" title="デモユーザーで試す" :icon="UsersRound">
        <div class="space-y-2">
          <button v-for="u in demoUsers" :key="u.id" type="button" class="btn w-full justify-start border-base-300 bg-base-100" @click="emit('demo', u.id)">
            {{ u.name }}
          </button>
        </div>
      </AppCard>

      <section v-if="stats !== null" aria-labelledby="stats-title" class="rounded-box bg-base-100 p-4 shadow-soft">
        <h2 id="stats-title" class="text-sm font-bold text-base-content/70">利用状況</h2>
        <dl class="mt-3 grid grid-cols-3 gap-2 text-center">
          <div v-for="s in STAT_ITEMS" :key="s.key" class="min-w-0 rounded-2xl bg-base-200/60 px-1 py-3">
            <dt class="text-xs text-base-content/65">{{ s.label }}</dt>
            <dd class="mt-1">
              <span v-if="stats === undefined" class="skeleton mx-auto block h-8 w-14" aria-label="読み込み中" />
              <template v-else>
                <span class="text-2xl font-bold tabular-nums text-primary sm:text-4xl">{{ formatCount(stats[s.key]) }}</span>
                <span class="ml-0.5 text-xs text-base-content/60">{{ s.unit }}</span>
              </template>
            </dd>
          </div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-base-content/55">
          出欠の回答は、いま記録されている回答の数です（回答を変更しても 1 件のままです）。数字は 1 時間ごとに更新されます。
        </p>
      </section>

      <section aria-labelledby="features-title">
        <h2 id="features-title" class="px-1 text-lg font-bold">主な機能</h2>
        <ul class="mt-3 grid gap-3 sm:grid-cols-2">
          <li v-for="f in FEATURES" :key="f.title" class="flex gap-3 rounded-box bg-base-100 p-4 shadow-soft">
            <span class="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary"><component :is="f.icon" class="size-5" aria-hidden="true" /></span>
            <div class="min-w-0">
              <h3 class="font-bold">{{ f.title }}</h3>
              <p class="mt-1 text-sm leading-relaxed text-base-content/70">{{ f.text }}</p>
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="start-title" class="rounded-box bg-base-100 p-4 shadow-soft">
        <h2 id="start-title" class="text-lg font-bold">はじめ方</h2>
        <div class="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <p class="flex items-center gap-2 text-sm font-bold"><UserPlus class="size-5 text-primary" aria-hidden="true" />チームを作る方（代表・コーチ）</p>
            <ol class="mt-2 space-y-1.5 text-sm text-base-content/75">
              <li class="flex gap-2"><span class="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">1</span>Google でログイン</li>
              <li class="flex gap-2"><span class="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">2</span>チームを作って予定を登録</li>
              <li class="flex gap-2"><span class="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">3</span>参加用リンクを LINE などで送る</li>
            </ol>
            <NuxtLink v-if="isDemo" to="/teams/new" class="btn btn-outline mt-3 min-h-11 w-full border-base-300">チームを作る</NuxtLink>
            <button v-else type="button" class="btn btn-outline mt-3 min-h-11 w-full border-base-300" :disabled="signingIn"
              aria-label="Google でログインしてチームを作る" @click="start('create')">チームを作る</button>
          </div>
          <div>
            <p class="flex items-center gap-2 text-sm font-bold"><Link class="size-5 text-primary" aria-hidden="true" />招待された方（メンバー・保護者）</p>
            <p class="mt-2 text-sm leading-relaxed text-base-content/75">LINE などで届いたチームのリンクを開いて、ログインするだけで参加できます。</p>
            <NuxtLink to="/help" class="mt-3 flex min-h-11 items-center gap-2 text-sm font-bold text-primary">
              使い方・よくある質問を見る<ChevronRight class="size-4" aria-hidden="true" />
            </NuxtLink>
          </div>
        </div>
      </section>

      <LegalFooter />
    </main>
  </div>
</template>
