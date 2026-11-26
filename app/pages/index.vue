<script setup lang="ts">
// トップページ・ログイン（未ログイン時: TopLanding） / チーム一覧（ログイン時）
import { ChevronRight, CirclePause, Plus, UsersRound } from 'lucide-vue-next'
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

  <!-- Logged out: top page (service, usage numbers, features, how to start) with the Google login -->
  <TopLanding v-else :invite="invite" :in-app="inApp" :external-url="externalUrl" :error="error" :signing-in="signingIn"
    :is-demo="isDemo" :demo-users="$demoUsers" @login="google" @demo="demo" />
</template>
