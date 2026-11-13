<script setup lang="ts">
// 退会（アカウント削除）: 1) what happens  2) Google login again  3) type and confirm.
// The server decides everything (who you are, what is deleted); this page only explains and asks.
import {
  CircleAlert, CircleCheck, Crown, KeyRound, RefreshCw, Trash2, TriangleAlert, UserX,
} from 'lucide-vue-next'
import { DELETE_CONFIRM_TEXT, RepoError, type DeletionPreview } from '~/utils/types'

type Step = 'impact' | 'verify' | 'confirm'
const repo = useRepo()
const route = useRoute()
const { isDemo, reauthenticate, signOut } = useAuth()

const pv = ref<DeletionPreview | null>(null)
const loadError = ref('')
const step = ref<Step>('impact')
const secondsLeft = ref(0)
const typed = ref('')
const busy = ref(false)
const error = ref('')
/** App data is gone but the account itself is not deleted yet: only "retry" is left. */
const unfinished = ref(false)
const pick = reactive<Record<string, string>>({})

const mustHandOver = computed(() => pv.value?.teams_to_hand_over ?? [])
const canContinue = computed(() => !!pv.value && mustHandOver.value.length === 0)
const STEPS: { key: Step; label: string }[] = [
  { key: 'impact', label: '内容の確認' }, { key: 'verify', label: '本人確認' }, { key: 'confirm', label: '最終確認' },
]
const stepIndex = computed(() => STEPS.findIndex((s) => s.key === step.value))

async function load() {
  loadError.value = ''
  try {
    pv.value = await repo.deletionPreview()
    secondsLeft.value = pv.value.reauth_seconds_left
    unfinished.value = pv.value.deletion_pending
  } catch (e) {
    loadError.value = errorMessage(e)
  }
}
await load()
// Back from the Google login: go straight on.
if (route.query.step === 'confirm' && canContinue.value) step.value = secondsLeft.value > 0 ? 'confirm' : 'verify'

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (secondsLeft.value > 0) secondsLeft.value--
    else if (step.value === 'confirm' && !busy.value) step.value = 'verify'
  }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))

async function act(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try { await fn() } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}
const requestTransfer = (teamId: string) => act(async () => {
  await repo.requestOwnerTransfer(teamId, pick[teamId]!)
  await load()
})
const cancelTransfer = (teamId: string) => act(async () => {
  await repo.cancelOwnerTransfer(teamId)
  await load()
})
const refresh = () => act(load)

function next() {
  error.value = ''
  step.value = secondsLeft.value > 0 ? 'confirm' : 'verify'
}
// Supabase: leaves for Google and comes back with ?step=confirm. Demo: returns at once.
const relogin = () => act(async () => {
  await reauthenticate('/account/delete?step=confirm')
  await load()
  if (secondsLeft.value > 0) step.value = 'confirm'
})

async function execute() {
  busy.value = true
  error.value = ''
  try {
    await repo.deleteAccount(unfinished.value ? DELETE_CONFIRM_TEXT : typed.value)
    await signOut('local')
    await navigateTo('/account/deleted', { replace: true })
  } catch (e) {
    const code = e instanceof RepoError ? e.code : 'unknown'
    if (code === 'auth_delete_failed') {
      unfinished.value = true
    } else if (code === 'reauth_required' || code === 'session_expired') {
      secondsLeft.value = 0
      step.value = 'verify'
      error.value = 'ログインから時間がたっているため、本人確認が必要です。'
    } else if (code === 'owner_must_transfer') {
      step.value = 'impact'
      error.value = errorMessage(e)
      await load()
    } else {
      error.value = `${errorMessage(e)}（何度実行しても大丈夫です）`
    }
  } finally {
    busy.value = false
  }
}
const minutes = computed(() => Math.max(1, Math.ceil(secondsLeft.value / 60)))
</script>

<template>
  <div>
    <AppHeader title="アカウントを削除" subtitle="退会の手続き" back="/account" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <p v-if="loadError" role="alert" class="rounded-box bg-error/10 p-4 text-sm text-error">
        {{ loadError }}
        <button class="btn btn-sm mt-2 w-full" @click="refresh">再読み込み</button>
      </p>

      <!-- Data already removed, account deletion not finished -->
      <template v-else-if="unfinished">
        <AppCard title="退会の手続きが途中です" :icon="RefreshCw">
          <p class="text-sm leading-relaxed">
            あなたのデータの削除は完了しています。<b>アカウントの削除だけが完了していません。</b>
            下のボタンで、もう一度実行してください。
          </p>
          <p class="mt-2 text-xs text-base-content/60">
            何度実行しても大丈夫です。時間をおいてからでも、ログインし直してからでも、この画面から完了できます。運営者への連絡は必要ありません。
          </p>
          <button class="btn btn-error btn-lg mt-4 w-full" :disabled="busy" @click="execute">
            <span v-if="busy" class="loading loading-spinner" />退会を完了する
          </button>
          <p v-if="error" role="alert" class="mt-2 text-sm text-error">{{ error }}</p>
        </AppCard>
      </template>

      <template v-else-if="pv">
        <ul class="steps w-full text-xs">
          <li v-for="(s, i) in STEPS" :key="s.key" class="step" :class="i <= stepIndex ? 'step-error' : ''">{{ s.label }}</li>
        </ul>

        <!-- 1. What happens -->
        <template v-if="step === 'impact'">
          <AppCard v-if="mustHandOver.length" title="先に、オーナーの引き継ぎが必要です" :icon="Crown">
            <div class="space-y-4">
              <div v-for="t in mustHandOver" :key="t.team_id" class="rounded-box border border-warning/40 bg-warning/5 p-3">
                <p class="text-sm">「<b>{{ t.team_name }}</b>」はあなたがオーナーです。退会の前に、ほかのメンバーに引き継いでください。</p>
                <template v-if="t.pending">
                  <p class="mt-2 text-sm">
                    <b>{{ t.pending.to_name || 'メンバー' }}</b>さんの承認を待っています（{{ formatDate(t.pending.expires_at) }}まで）。
                  </p>
                  <p class="mt-1 text-xs text-base-content/60">相手が「引き受ける」を押すと、あなたは一般メンバーになり、退会できるようになります。</p>
                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <button class="btn btn-sm" :disabled="busy" @click="cancelTransfer(t.team_id)">依頼を取り消す</button>
                    <button class="btn btn-sm" :disabled="busy" @click="refresh"><RefreshCw class="size-4" />状況を更新</button>
                  </div>
                </template>
                <template v-else>
                  <fieldset class="mt-3 space-y-1">
                    <legend class="mb-1 text-xs font-bold text-base-content/70">引き継ぐ相手を選ぶ</legend>
                    <label v-for="c in t.candidates" :key="c.user_id"
                      class="flex min-h-11 cursor-pointer items-center gap-3 rounded-field px-2 hover:bg-base-200">
                      <input v-model="pick[t.team_id]" type="radio" class="radio radio-sm" :name="`to-${t.team_id}`" :value="c.user_id">
                      <span class="flex-1 text-sm">{{ c.display_name }}</span>
                      <span v-if="c.role === 'admin'" class="badge badge-ghost badge-sm">管理者</span>
                    </label>
                  </fieldset>
                  <button class="btn btn-brand btn-sm mt-3 w-full" :disabled="busy || !pick[t.team_id]" @click="requestTransfer(t.team_id)">
                    引き継ぎを依頼する
                  </button>
                  <p class="mt-1 text-xs text-base-content/60">相手が承認するまで、オーナーは変わりません。</p>
                </template>
              </div>
            </div>
          </AppCard>

          <AppCard title="削除されるもの" :icon="Trash2">
            <ul class="space-y-2 text-sm">
              <li class="flex gap-2"><span class="text-error">●</span>あなたのログイン情報と、チームでの表示名</li>
              <li v-for="c in pv.children_to_delete" :key="c.player_id" class="flex gap-2">
                <span class="text-error">●</span>
                <span>「<b>{{ c.name }}</b>」（{{ c.team_name }}）と出欠 {{ c.answers }} 件<br>
                  <span class="text-xs text-base-content/60">保護者があなただけのため</span></span>
              </li>
              <li v-for="t in pv.teams_to_close" :key="t.team_id" class="flex gap-2">
                <span class="text-error">●</span>
                <span>チーム「<b>{{ t.team_name }}</b>」と、その予定・出欠<br>
                  <span class="text-xs text-base-content/60">メンバーがあなただけのため、チームを終了します</span></span>
              </li>
            </ul>
          </AppCard>

          <AppCard v-if="pv.children_kept_by_family.length || pv.teams_to_leave.length" title="残るもの" :icon="CircleCheck">
            <ul class="space-y-2 text-sm">
              <li v-for="c in pv.children_kept_by_family" :key="c.player_id" class="flex gap-2">
                <span class="text-success">●</span>
                <span>「<b>{{ c.name }}</b>」（{{ c.team_name }}）と出欠<br>
                  <span class="text-xs text-base-content/60">ほかの保護者がいるため残ります。あなたは保護者から外れます。</span></span>
              </li>
              <li v-for="t in pv.teams_to_leave" :key="t.team_id" class="flex gap-2">
                <span class="text-success">●</span>
                <span>チーム「<b>{{ t.team_name }}</b>」の予定と、ほかの家庭の出欠<br>
                  <span class="text-xs text-base-content/60">あなたはチームから抜けます</span></span>
              </li>
            </ul>
            <p class="mt-3 text-xs text-base-content/55">残る記録からは、あなたが登録・変更したという情報を消します。</p>
          </AppCard>

          <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
          <button class="btn btn-lg w-full border-base-300 bg-base-100 shadow-sm" :disabled="!canContinue || busy" @click="next">次へ（本人確認）</button>
          <p v-if="!canContinue" class="text-center text-xs text-base-content/60">オーナーの引き継ぎが終わると、次へ進めます。</p>
        </template>

        <!-- 2. Google login again -->
        <AppCard v-else-if="step === 'verify'" title="本人確認" :icon="KeyRound">
          <p class="text-sm leading-relaxed">本人確認のため、もう一度 Google でログインしてください。ログイン後、この画面に戻ります。</p>
          <p v-if="isDemo" class="mt-1 text-xs text-base-content/55">（デモ：ボタンを押すと確認済みになります）</p>
          <p v-if="error" role="alert" class="mt-2 text-sm text-error">{{ error }}</p>
          <button class="btn btn-brand btn-lg mt-4 w-full" :disabled="busy" @click="relogin">
            <span v-if="busy" class="loading loading-spinner" />Google でログインして続ける
          </button>
          <button class="btn btn-ghost btn-sm mt-2 w-full" :disabled="busy" @click="step = 'impact'">内容の確認に戻る</button>
        </AppCard>

        <!-- 3. Final confirmation -->
        <template v-else>
          <div role="alert" class="flex gap-3 rounded-box border border-error/40 bg-error/5 p-4 text-sm">
            <TriangleAlert class="mt-0.5 size-5 shrink-0 text-error" />
            <div>
              <p class="font-bold text-error">退会すると、元に戻せません。</p>
              <p class="mt-1 text-base-content/70">運営者もデータを復元できません。削除される内容をもう一度確認してください。</p>
            </div>
          </div>
          <AppCard title="最終確認" :icon="UserX">
            <FormField :label="`確認のため「${DELETE_CONFIRM_TEXT}」と入力してください`">
              <input v-model="typed" class="input input-lg w-full" autocomplete="off" :placeholder="DELETE_CONFIRM_TEXT" :disabled="busy">
            </FormField>
            <p v-if="error" role="alert" class="mt-2 text-sm text-error">{{ error }}</p>
            <button class="btn btn-error btn-lg mt-4 w-full" :disabled="busy || typed.trim() !== DELETE_CONFIRM_TEXT" @click="execute">
              <span v-if="busy" class="loading loading-spinner" />退会する
            </button>
            <p class="mt-2 flex items-center justify-center gap-1 text-xs text-base-content/55">
              <CircleAlert class="size-3.5" />本人確認の有効時間：あと約 {{ minutes }} 分
            </p>
          </AppCard>
          <button class="btn btn-ghost btn-sm w-full" :disabled="busy" @click="step = 'impact'">内容の確認に戻る</button>
        </template>
      </template>
    </main>
  </div>
</template>
