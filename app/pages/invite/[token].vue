<script setup lang="ts">
// 家族招待の受け取り（24時間・1回限り。サーバー側で検証）
// 1. Login is settled first (auth middleware), then the server is asked what this link would do
//    (preview: nothing is consumed). Only a NEW member is asked for a team display name.
// 2. The name is checked here (no browser bubble that disappears) and again by the server.
// 3. After accepting, the page moves on to the team's answer page, so the token leaves the URL.
// The token is never logged or shown; error texts come from the fixed messages only.
import { BadgeCheck, PenLine, RefreshCw, ShieldCheck, TriangleAlert, UserPlus } from 'lucide-vue-next'
import { ERROR_MESSAGE, RepoError, type AcceptResult, type InvitationPreview } from '~/utils/types'
import { DISPLAY_NAME_MAX, displayNameError, normalizeDisplayName } from '~/utils/displayName'

const route = useRoute()
const repo = useRepo()
const { user } = useAuth()
const token = computed(() => String(route.params.token))

/** undefined = loading, null = older database without preview (old form), otherwise the server's answer. */
const preview = ref<InvitationPreview | null | undefined>(undefined)
const loadError = ref('')
const displayName = ref('')
const nameError = ref('')
const error = ref('')
const busy = ref(false)
const already = ref<AcceptResult | null>(null)

const askName = computed(() => preview.value === null || (preview.value?.status === 'valid' && preview.value.needs_display_name))
/** The 'already registered' card: from the preview, or from an accept that found it already done. */
const alreadyView = computed(() => already.value ?? (preview.value?.status === 'already_guardian' ? preview.value : null))
const canAccept = computed(() => preview.value === null || preview.value?.status === 'valid')

async function load() {
  loadError.value = ''
  preview.value = undefined
  try {
    preview.value = await repo.previewInvitation(token.value)
    if (askName.value && !displayName.value) displayName.value = user.value?.name ?? ''
  } catch (e) {
    loadError.value = errorMessage(e)          // auth / network errors: never treated as an older database
  }
}
onMounted(load)

function checkName() {
  if (!askName.value) return true
  const code = displayNameError(displayName.value)
  nameError.value = code ? ERROR_MESSAGE[code] : ''
  return !code
}
watch(displayName, () => { if (nameError.value) checkName() })   // the message stays until the name is fixed

async function accept() {
  if (busy.value || !canAccept.value) return
  error.value = ''
  if (!checkName()) return
  busy.value = true
  try {
    const r = await repo.acceptInvitation(token.value, askName.value ? normalizeDisplayName(displayName.value) : '')
    if (r.status === 'already_guardian') { already.value = r; return }
    // Leave the invitation URL: the answer page greets the new guardian (replace = no token in history).
    await navigateTo({ path: `/t/${r.team_id}/answer`, query: { invited: r.player_id } }, { replace: true })
  } catch (e) {
    const code = e instanceof RepoError ? e.code : 'unknown'
    if (code === 'name_required' || code === 'display_name_too_long') nameError.value = ERROR_MESSAGE[code]
    else error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <AppHeader title="家族からの招待" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <!-- 確認中 -->
      <div v-if="preview === undefined && !loadError" class="flex justify-center py-10" role="status" aria-label="招待を確認しています">
        <span class="loading loading-spinner loading-lg text-primary" />
      </div>

      <!-- 確認できなかった（通信・ログインなど）: もう一度 -->
      <AppCard v-else-if="loadError">
        <div class="flex flex-col items-center gap-3 text-center">
          <TriangleAlert class="size-8 text-error" />
          <p role="alert" class="text-sm text-error">{{ loadError }}</p>
          <button type="button" class="btn btn-outline border-base-300" @click="load"><RefreshCw class="size-4" />もう一度確認する</button>
        </div>
      </AppCard>

      <!-- すでに保護者（正常な案内。招待は消費されない） -->
      <AppCard v-else-if="alreadyView">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="grid size-14 place-items-center rounded-2xl bg-info/12 text-info"><BadgeCheck class="size-8" /></span>
          <p class="text-lg font-bold">すでに登録済みです</p>
          <p class="text-sm text-base-content/65">
            あなたは {{ alreadyView.player_name }} さんの出欠を回答できるように登録されています。<br>このまま出欠を入力できます。
          </p>
          <NuxtLink :to="`/t/${alreadyView.team_id}/answer`" class="btn btn-brand btn-lg mt-2 w-full"><PenLine class="size-5" />出欠入力へ</NuxtLink>
          <p class="text-xs text-base-content/55">この招待リンクは使われていません。ほかの家族に送る場合は、そのまま使えます。</p>
        </div>
      </AppCard>

      <!-- 使えないリンク / 停止中 -->
      <AppCard v-else-if="preview?.status === 'invalid' || preview?.status === 'suspended'">
        <div role="alert" class="flex flex-col items-center gap-3 text-center">
          <TriangleAlert class="size-8 text-error" />
          <template v-if="preview.status === 'invalid'">
            <p class="font-bold">{{ ERROR_MESSAGE.invitation_invalid }}</p>
            <p class="text-sm text-base-content/65">リンクが途中で切れていないかも確認してください（LINE などでは、全体を長押ししてコピーすると確実です）。</p>
          </template>
          <p v-else class="font-bold">{{ ERROR_MESSAGE.team_access_suspended }}</p>
          <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
        </div>
      </AppCard>

      <template v-else>
        <AppCard>
          <div class="flex flex-col items-center gap-2 text-center">
            <span class="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><UserPlus class="size-7" /></span>
            <p class="text-lg font-bold">一緒に回答する人として追加されます</p>
            <p v-if="preview?.status === 'valid'" class="text-sm text-base-content/70">
              {{ preview.team_name }} の「{{ preview.player_name }}」さんの出欠を、あなたのアカウントでも入力できるようになります。
            </p>
            <p v-else class="text-sm text-base-content/60">受け取ると、あなたのアカウントでも、招待した人が登録した人（お子さんなど）の出欠を入力できるようになります。</p>
          </div>
          <form class="mt-5 space-y-4" novalidate @submit.prevent="accept">
            <FormField v-if="askName" label="チーム内で表示する名前" hint="例：田中 花子、田中（ゆうとの母）">
              <input v-model="displayName" :maxlength="DISPLAY_NAME_MAX + 10" autocomplete="nickname" class="input input-lg w-full"
                :class="nameError && 'input-error'" placeholder="表示名" :aria-invalid="!!nameError" aria-describedby="invite-name-error">
            </FormField>
            <p v-if="nameError" id="invite-name-error" role="alert" class="rounded-xl bg-error/10 p-3 text-sm text-error">{{ nameError }}</p>
            <p v-if="error" role="alert" class="rounded-xl bg-error/10 p-3 text-sm text-error">{{ error }}</p>
            <button class="btn btn-brand btn-lg w-full" :disabled="busy" :aria-busy="busy">
              <span v-if="busy" class="loading loading-spinner loading-sm" aria-hidden="true" />{{ busy ? '受け取り中…' : '招待を受け取る' }}
            </button>
          </form>
        </AppCard>
        <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
          <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
          <p>招待リンクは24時間・1回限り有効です。心当たりのない招待は受け取らないでください。</p>
        </div>
      </template>
      <LegalFooter />
    </main>
  </div>
</template>
