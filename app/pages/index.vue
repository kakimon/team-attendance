<script setup lang="ts">
// ログイン（未ログイン時） / チーム一覧（ログイン時）
import { ChevronRight, ExternalLink, Link, Plus, ShieldCheck, UserPlus, UsersRound } from 'lucide-vue-next'
import type { Role, Team } from '~/utils/types'

const route = useRoute()
const { user, isDemo, signInWithGoogle, signInDemo } = useAuth()
const { $demoUsers } = useNuxtApp()
const redirect = safeRedirect(route.query.redirect, '')
const error = ref('')
const inApp = ref<'line' | 'other' | null>(null)
const teams = ref<(Team & { role: Role })[] | null>(null)
const signingIn = ref(false)
/** Account deletion stopped half-way (data removed, account not yet): offer to finish it. */
const deletionPending = ref(false)

onMounted(() => (inApp.value = detectInAppBrowser(navigator.userAgent)))

async function afterLogin() {
  if (redirect) return navigateTo(redirect)
  try {
    teams.value = await useRepo().myTeams()
    if (!teams.value.length) deletionPending.value = (await useRepo().deletionPreview()).deletion_pending
  } catch (e) { error.value = errorMessage(e) }
}
if (user.value) await afterLogin()

async function google() {
  error.value = ''
  signingIn.value = true
  try { await signInWithGoogle(redirect || '/') } catch {
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
const features = [
  { icon: Link, title: '共有URLを開くだけ', text: 'LINEグループなどで届いたリンクから参加' },
  { icon: ShieldCheck, title: '他の家庭の子は編集できない', text: '入力できるのは自分の子だけ' },
  { icon: UserPlus, title: '家族も一緒に使える', text: '招待リンクで2人目の保護者を追加' },
]
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
      <OwnerTransferInbox @changed="afterLogin" />
      <div v-if="teams === null && !error" class="space-y-3">
        <div v-for="i in 2" :key="i" class="skeleton h-20 rounded-box bg-base-100" />
      </div>
      <EmptyState v-else-if="teams && !teams.length" :icon="UsersRound" title="まだチームに参加していません"
        text="チームの共有URL（LINEなどで届いたリンク）を開くと参加できます。" />
      <ul v-else class="space-y-3">
        <li v-for="t in teams ?? []" :key="t.id">
          <NuxtLink :to="`/t/${t.share_token}`"
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
      <p v-if="error" class="text-sm text-error">{{ error }}</p>

      <NuxtLink to="/teams/new" class="btn btn-outline w-full border-dashed border-base-300 bg-base-100/60">
        <Plus class="size-4" />新しいチームを作る
      </NuxtLink>
      <p class="text-center text-xs text-base-content/50">チームを作るのは代表者・コーチの方です。保護者の方は共有URLから参加してください。</p>
      <LegalFooter />
    </main>
  </div>

  <!-- Logged out: login -->
  <div v-else class="flex min-h-dvh flex-col">
    <section class="bg-brand px-6 pt-[max(env(safe-area-inset-top),3rem)] pb-16 text-white">
      <div class="mx-auto flex max-w-md flex-col items-center text-center">
        <span class="grid size-16 place-items-center rounded-3xl bg-white/20 ring-1 ring-white/30">
          <UsersRound class="size-8" />
        </span>
        <h1 class="mt-4 text-3xl font-bold tracking-wide">みんなの出欠</h1>
        <p class="mt-2 text-sm leading-relaxed text-white/85">
          チーム・クラブ・教室の出欠を、<br>かんたんに共有。
        </p>
      </div>
    </section>

    <main class="mx-auto -mt-10 w-full max-w-md flex-1 space-y-4 px-4 pb-10">
      <div v-if="inApp" role="alert" class="rounded-box border border-warning/40 bg-[#fff7e6] p-4 text-sm shadow-soft">
        <p class="font-bold">ブラウザで開いてください</p>
        <p class="mt-1 text-base-content/70">LINE などのアプリ内ブラウザでは Google ログインができません。Safari / Chrome で開いてください。</p>
        <a v-if="inApp === 'line'" :href="externalUrl" class="btn btn-sm mt-3"><ExternalLink class="size-4" />ブラウザで開く</a>
        <p v-else class="mt-2 text-xs">右上のメニューから「ブラウザで開く」を選んでください。</p>
      </div>

      <AppCard v-if="!isDemo">
        <button class="btn btn-lg w-full border-base-300 bg-base-100 font-bold shadow-sm hover:bg-base-200" :disabled="signingIn" @click="google">
          <svg viewBox="0 0 48 48" class="size-5" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Googleでログイン
        </button>
        <p class="mt-3 text-center text-xs text-base-content/55">一度ログインすれば、次回からはそのまま使えます。</p>
        <p v-if="error" class="mt-2 text-center text-sm text-error">{{ error }}</p>
      </AppCard>

      <AppCard v-else title="デモユーザーで試す" :icon="UsersRound">
        <div class="space-y-2">
          <button v-for="u in $demoUsers" :key="u.id" class="btn w-full justify-start border-base-300 bg-base-100" @click="demo(u.id)">
            {{ u.name }}
          </button>
        </div>
      </AppCard>

      <ul class="space-y-2">
        <li v-for="f in features" :key="f.title" class="flex items-center gap-3 rounded-box bg-base-100/70 p-4">
          <span class="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <component :is="f.icon" class="size-5" />
          </span>
          <div>
            <p class="text-sm font-bold">{{ f.title }}</p>
            <p class="text-xs text-base-content/60">{{ f.text }}</p>
          </div>
        </li>
      </ul>
      <LegalFooter />
    </main>
  </div>
</template>
