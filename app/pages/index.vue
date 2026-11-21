<script setup lang="ts">
// ログイン（未ログイン時） / チーム一覧（ログイン時）
import { BookOpen, ChevronRight, CircleHelp, CirclePause, ExternalLink, Link, Plus, UsersRound } from 'lucide-vue-next'
import type { Role, SuspendedMembership, Team } from '~/utils/types'
import { ownedTeamCount } from '~/utils/teamUsage'

const route = useRoute()
const { user, isDemo, signInWithGoogle, signInDemo } = useAuth()
const { $demoUsers } = useNuxtApp()
const redirect = safeRedirect(route.query.redirect, '')
/** One-time message after leaving / deleting a team (set by those screens). */
const NOTICE: Record<string, string> = {
  left: 'チームから脱退しました。もう一度参加するときは、チームの管理者から参加用URLを受け取ってください。',
  team_deleted: 'チームを削除しました。作成できるチーム数の枠が1つ戻りました（24時間以内の作成回数は戻りません）。',
  suspended_left: 'アクセスが停止されていたチームから抜けました。あなたのアカウントと、ほかのチームはそのまま使えます。',
}
const notice = computed(() => (typeof route.query.notice === 'string' ? NOTICE[route.query.notice] ?? '' : ''))
/** Came here from a team / family invitation link (kept through the login). */
const invite = inviteKindOf(redirect)
const error = ref('')
const inApp = ref<'line' | 'other' | null>(null)
const teams = ref<(Team & { role: Role })[] | null>(null)
/** Teams where my access is stopped (ids and dates only: the server gives no names). */
const stopped = ref<SuspendedMembership[]>([])
const signingIn = ref(false)
/** Account deletion stopped half-way (data removed, account not yet): offer to finish it. */
const deletionPending = ref(false)
const loadingTeams = ref(false)
let teamRequest = 0
const ownedCount = computed(() => ownedTeamCount(teams.value))

onMounted(() => (inApp.value = detectInAppBrowser(navigator.userAgent)))

async function afterLogin() {
  if (redirect) return navigateTo(redirect)
  const request = ++teamRequest
  loadingTeams.value = true
  teams.value = null
  error.value = ''
  deletionPending.value = false
  try {
    const [current, suspended] = await Promise.all([useRepo().myTeams(), useRepo().mySuspendedMemberships().catch(() => [])])
    if (request !== teamRequest) return
    stopped.value = suspended
    teams.value = current
    if (!current.length) {
      const preview = await useRepo().deletionPreview()
      if (request === teamRequest) deletionPending.value = preview.deletion_pending
    }
  } catch (e) { if (request === teamRequest) error.value = errorMessage(e) }
  finally { if (request === teamRequest) loadingTeams.value = false }
}
if (user.value) await afterLogin()

/** intent 'create' = 「チームを作る」: after login go to the team creation page (an invitation wins). */
async function google(intent: 'create' | null = null) {
  error.value = ''
  signingIn.value = true
  try { await signInWithGoogle(loginTarget(redirect, intent)) } catch {
    error.value = 'ログインを開始できませんでした。'
    signingIn.value = false
  }
}
async function demo(id: string) {
  signInDemo(id)
  await afterLogin()
}
const externalUrl = computed(() => (import.meta.client ? externalBrowserUrl(location.href) : ''))
const ROLE: Record<Role, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー' }
</script>

<template>
  <!-- Logged in: team list -->
  <div v-if="user">
    <AppHeader title="参加しているチーム" subtitle="みんなの出欠" />
    <main class="mx-auto max-w-3xl space-y-4 px-4 py-5 md:px-6">
      <div v-if="deletionPending" role="alert" class="rounded-box border border-error/40 bg-error/5 p-4 text-sm">
        <p class="font-bold">退会の手続きが途中です</p>
        <p class="mt-1 text-base-content/70">データの削除は完了しています。アカウントの削除を完了してください。</p>
        <NuxtLink to="/account/delete" class="btn btn-error btn-sm mt-3">退会を完了する</NuxtLink>
      </div>
      <p v-if="notice" role="status" class="rounded-box border-l-4 border-success bg-base-100 p-4 text-sm shadow-soft">{{ notice }}</p>
      <OwnerTransferInbox @changed="afterLogin" />
      <div v-if="teams === null && !error" class="space-y-3">
        <div v-for="i in 2" :key="i" class="skeleton h-20 rounded-box bg-base-100" />
      </div>
      <EmptyState v-else-if="teams && !teams.length && !stopped.length" :icon="UsersRound" title="まだチームに参加していません"
        text="チームの参加用URL（LINEなどで届いたリンク）を開くと参加できます。" />
      <ul v-else class="space-y-3">
        <li v-for="t in teams ?? []" :key="t.id">
          <NuxtLink :to="`/t/${t.id}`"
            class="flex items-center gap-3 rounded-box bg-base-100 p-4 shadow-soft transition hover:ring-2 hover:ring-primary/20 active:scale-[0.99]">
            <TeamAvatar :name="t.name" />
            <div class="min-w-0 flex-1">
              <p class="truncate font-bold">{{ t.name }}</p>
              <p class="text-xs text-base-content/55">{{ ROLE[t.role] }}</p>
            </div>
            <ChevronRight class="size-5 text-base-content/35" />
          </NuxtLink>
        </li>
      </ul>
      <section v-if="stopped.length" aria-labelledby="stopped-teams-title" class="space-y-2">
        <h2 id="stopped-teams-title" class="px-1 text-sm font-bold text-base-content/70">アクセスが停止されているチーム</h2>
        <ul class="space-y-2">
          <li v-for="x in stopped" :key="x.team_id">
            <NuxtLink :to="`/suspended/${x.team_id}`" class="flex items-center gap-3 rounded-box border border-warning/40 bg-base-100 p-4 text-sm shadow-soft">
              <CirclePause class="size-5 shrink-0 text-warning" aria-hidden="true" />
              <span class="min-w-0 flex-1">
                <span class="block break-words font-bold">{{ x.team_name || '停止中のチーム' }}</span>
                <span class="block text-xs text-base-content/60">{{ formatDateTime(x.suspended_at) }} に停止<template v-if="!x.team_name">・チーム名は表示されません</template></span>
              </span>
              <span class="shrink-0 text-xs font-bold text-primary">登録を確認</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
      <p v-if="error" class="text-sm text-error">{{ error }}</p>

      <OwnedTeamUsage :count="ownedCount" :loading="loadingTeams" @refresh="afterLogin" />
      <NuxtLink to="/teams/new" class="btn btn-outline w-full border-dashed border-base-300 bg-base-100/60">
        <Plus class="size-4" />新しいチームを作る
      </NuxtLink>
      <p class="text-center text-xs text-base-content/50">チームを作るのは代表者・コーチなどの方です。メンバーの方は参加用URLから参加してください。</p>
      <LegalFooter />
    </main>
  </div>

  <!-- Logged out: login -->
  <div v-else class="flex min-h-dvh flex-col">
    <section class="bg-brand px-6 pt-[max(env(safe-area-inset-top),2.5rem)] pb-14 text-white">
      <div class="mx-auto flex max-w-md flex-col items-center text-center">
        <span class="grid size-14 place-items-center rounded-3xl bg-white/20 ring-1 ring-white/30" aria-hidden="true">
          <UsersRound class="size-7" />
        </span>
        <h1 class="mt-3 text-3xl font-bold tracking-wide">みんなの出欠</h1>
        <p class="mt-2 text-base font-bold [word-break:keep-all]">チームの出欠連絡を、<wbr>もっと簡単に。</p>
        <p class="mt-1 text-sm leading-relaxed text-white/85">
          スポーツ・クラブ・習い事の出欠を、LINE などで届いたリンクから共有できます。<br class="hidden sm:inline">
          自分の出欠も、お子さんなど家族の出欠も回答できます。
        </p>
      </div>
    </section>

    <main class="mx-auto -mt-8 w-full max-w-md flex-1 space-y-3 px-4 pb-8">
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

      <AppCard v-if="!isDemo">
        <button class="btn btn-lg w-full border-base-300 bg-base-100 font-bold shadow-sm hover:bg-base-200" :disabled="signingIn" @click="google()">
          <svg viewBox="0 0 48 48" class="size-5" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Google でログイン
        </button>
        <p class="mt-3 text-center text-xs text-base-content/60">一度ログインすれば、次回からはそのまま使えます。</p>
        <p v-if="error" role="alert" class="mt-2 text-center text-sm text-error">{{ error }}</p>
      </AppCard>

      <AppCard v-else title="デモユーザーで試す" :icon="UsersRound">
        <div class="space-y-2">
          <button v-for="u in $demoUsers" :key="u.id" class="btn w-full justify-start border-base-300 bg-base-100" @click="demo(u.id)">
            {{ u.name }}
          </button>
        </div>
      </AppCard>

      <section v-if="!invite" aria-labelledby="first-time" class="rounded-box bg-base-100 shadow-soft">
        <h2 id="first-time" class="px-4 pt-4 text-sm font-bold text-base-content/70">はじめての方</h2>
        <div class="flex gap-3 border-b border-base-200 px-4 py-3">
          <UsersRound class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div class="text-sm">
            <p class="font-bold">チームに招待された方</p>
            <p class="text-base-content/65">LINE などで届いたチームのリンクを開いてください。ログインすると参加できます。</p>
          </div>
        </div>
        <div class="flex items-center gap-3 px-4 py-3">
          <Plus class="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div class="min-w-0 flex-1 text-sm">
            <p class="font-bold [word-break:keep-all]">チームを<wbr>作りたい方</p>
            <p class="text-base-content/65">代表・コーチの方はこちら</p>
          </div>
          <NuxtLink v-if="isDemo" to="/teams/new" class="btn btn-outline min-h-11 border-base-300">チームを作る</NuxtLink>
          <button v-else type="button" class="btn btn-outline min-h-11 border-base-300" :disabled="signingIn"
            aria-label="Google でログインしてチームを作る" @click="google('create')">チームを作る</button>
        </div>
      </section>

      <nav aria-label="使い方" class="overflow-hidden rounded-box bg-base-100 shadow-soft">
        <NuxtLink to="/help" class="flex min-h-12 items-center gap-3 border-b border-base-200 px-4 text-sm font-bold hover:bg-base-200/60">
          <BookOpen class="size-5 text-primary" aria-hidden="true" /><span class="flex-1">使い方を見る</span>
          <ChevronRight class="size-4 text-base-content/40" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink to="/help#faq" class="flex min-h-12 items-center gap-3 px-4 text-sm font-bold hover:bg-base-200/60">
          <CircleHelp class="size-5 text-primary" aria-hidden="true" /><span class="flex-1">よくある質問</span>
          <ChevronRight class="size-4 text-base-content/40" aria-hidden="true" />
        </NuxtLink>
      </nav>
      <LegalFooter />
    </main>
  </div>
</template>
