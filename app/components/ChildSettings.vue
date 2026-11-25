<script setup lang="ts">
// 回答する人の設定：情報の修正・家族招待・登録の取り消し（回答できる人のみ。サーバーでも再確認）。
// 本人登録（isMe）は本人だけが管理できる。
import { Clock, Link, PenLine, Save, Send, ShieldCheck, TriangleAlert, UserPlus, UsersRound, UserX } from 'lucide-vue-next'
import type { Player, SimilarPlayer } from '~/utils/types'

const props = defineProps<{ child: Player; isMe?: boolean; reload: () => Promise<void> }>()
const route = useRoute()
const token = computed(() => String(route.params.token))
const repo = useRepo()

// --- 情報の修正
const editing = ref(false)
const form = reactive({ name: '', note: '' })
const similar = ref<SimilarPlayer[]>([])
const saving = ref(false)
const editError = ref('')
const saved = ref(false)
function startEdit() {
  Object.assign(form, { name: props.child.name, note: props.child.note ?? '' })
  similar.value = []
  editError.value = ''
  saved.value = false
  editing.value = true
}
watch(() => form.name, () => (similar.value = []))
async function save(confirmSimilar: boolean) {
  if (!form.name.trim()) return
  saving.value = true
  editError.value = ''
  try {
    const r = await repo.updatePlayer(props.child.id, form.name.trim(), form.note.trim() || null, confirmSimilar)
    if (r.status === 'similar_found') {
      similar.value = r.similar
      return
    }
    editing.value = false
    saved.value = true
    await props.reload()
  } catch (e) {
    editError.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}

// --- 家族招待
const link = ref<{ url: string; expiresAt: string } | null>(null)
const inviteError = ref('')
const inviting = ref(false)
const invitesKey = ref(0)
async function createInvite() {
  if (inviting.value) return
  inviteError.value = ''
  inviting.value = true
  try {
    const r = await repo.createInvitation(props.child.id)
    link.value = { url: shareUrl('invite', r.token, location.origin, useRuntimeConfig().app.baseURL), expiresAt: r.expires_at }
    invitesKey.value++
  } catch (e) {
    inviteError.value = errorMessage(e)
  } finally {
    inviting.value = false
  }
}
const steps = [
  { icon: Link, text: '招待リンクを作成' },
  { icon: Send, text: '家族などにLINEなどで送る' },
  { icon: UserPlus, text: '受け取った人がGoogleでログインして受け取る' },
]

// --- 登録の取り消し
const confirmOpen = ref(false)
const archiving = ref(false)
const archiveError = ref('')
async function archive() {
  archiving.value = true
  archiveError.value = ''
  try {
    await repo.archivePlayer(props.child.id)
    confirmOpen.value = false
    await navigateTo(`/t/${token.value}/children`)
  } catch (e) {
    confirmOpen.value = false
    archiveError.value = errorMessage(e)
  } finally {
    archiving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- 情報 -->
    <AppCard tight>
      <div v-if="!editing" class="flex items-center gap-3">
        <TeamAvatar :name="child.name" size="lg" soft />
        <div class="min-w-0 flex-1">
          <p class="flex min-w-0 items-center gap-2 text-lg font-bold"><span class="truncate">{{ child.name }}</span><span v-if="isMe" class="badge badge-primary badge-sm shrink-0">本人</span></p>
          <p class="text-sm text-base-content/55">{{ child.note || 'メモなし' }}</p>
        </div>
        <button type="button" class="btn btn-sm border-base-300 bg-base-100" @click="startEdit"><PenLine class="size-4" />編集</button>
      </div>
      <p v-if="saved && !editing" role="status" class="mt-2 text-sm text-success">保存しました。</p>

      <form v-else-if="editing" class="space-y-4" @submit.prevent="save(false)">
        <FormField label="名前">
          <input v-model="form.name" required maxlength="40" class="input input-lg w-full">
        </FormField>
        <FormField label="学年・クラス・メモなど" optional>
          <input v-model="form.note" maxlength="40" class="input input-lg w-full" placeholder="例：4年、初級クラス">
        </FormField>

        <div v-if="similar.length" role="alert" class="space-y-3 rounded-box border border-warning/50 bg-[#fff7e6] p-4">
          <p class="flex items-center gap-2 font-bold"><TriangleAlert class="size-5 text-warning" />同じ・似た名前の登録があります</p>
          <ul class="space-y-1 text-sm">
            <li v-for="s in similar" :key="s.id" class="rounded-xl bg-base-100 px-3 py-2">{{ s.name }} <span class="text-base-content/55">{{ s.note }}</span></li>
          </ul>
          <p class="text-sm text-base-content/75">別の人であれば、このまま保存できます（ほかの人の出欠には影響しません）。</p>
          <button type="button" class="btn w-full border-warning/50 bg-base-100" :disabled="saving" @click="save(true)">このまま保存する</button>
        </div>

        <p v-if="editError" role="alert" class="text-sm text-error">{{ editError }}</p>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" class="btn border-base-300 bg-base-100" :disabled="saving" @click="editing = false">やめる</button>
          <button v-if="!similar.length" class="btn btn-brand" :disabled="saving"><Save class="size-4" />保存</button>
        </div>
        <p class="text-xs text-base-content/55">名前を変えても、これまでの出欠と家族などの回答権限はそのままです。<template v-if="isMe">チームでの表示名は変わりません。</template></p>
      </form>
    </AppCard>

    <!-- 家族招待 -->
    <AppCard :title="isMe ? '代わりに回答できる人を追加' : '一緒に回答する人を追加'" :icon="UsersRound">
      <p class="text-sm text-base-content/70">{{ isMe ? '家族など、別の Google アカウントからもあなたの出欠を回答できるようになります（任意）。' : '父・母など家族の別の Google アカウントでも、この人の出欠を入力できるようになります。' }}</p>
      <ol class="mt-4 space-y-2">
        <li v-for="(s, i) in steps" :key="i" class="flex items-center gap-3 text-sm">
          <span class="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">{{ i + 1 }}</span>
          <component :is="s.icon" class="size-4 text-primary" />{{ s.text }}
        </li>
      </ol>
      <div v-if="link" class="mt-5 space-y-3">
        <CopyField :value="link.url" share-title="みんなの出欠：家族の招待" />
        <p class="flex items-center gap-1.5 text-xs text-base-content/60">
          <Clock class="size-3.5" />有効期限 {{ formatDateTime(link.expiresAt) }} まで・1回だけ使えます
        </p>
        <p class="text-xs text-base-content/55">このリンクはこの画面でしか表示されません。なくした場合や、違う人に送ってしまった場合は、下の一覧で無効にして作り直してください。</p>
      </div>
      <button v-else type="button" class="btn btn-brand btn-lg mt-5 w-full" :disabled="inviting" @click="createInvite">
        <Link class="size-5" />招待リンクを作成
      </button>
      <p v-if="inviteError" role="alert" class="mt-2 text-sm text-error">{{ inviteError }}</p>
      <ChildInvitations :player-id="child.id" :refresh-key="invitesKey" />
    </AppCard>

    <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
      <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
      <p>招待リンクは24時間で無効になり、一度使うと再利用できません。家族以外には送らないでください。</p>
    </div>

    <!-- 登録の取り消し -->
    <div class="pt-2">
      <button type="button" class="btn btn-ghost w-full text-error" :disabled="archiving" @click="confirmOpen = true">
        <UserX class="size-4" />この登録を取り消す
      </button>
      <p v-if="archiveError" role="alert" class="text-center text-sm text-error">{{ archiveError }}</p>
    </div>
    <ConfirmDialog :open="confirmOpen" title="この登録を取り消しますか？" confirm-label="取り消す" :busy="archiving"
      @confirm="archive" @cancel="confirmOpen = false">
      <p>「{{ child.name }}」が出欠一覧・集計・出欠入力から消えます。家族などの招待もできなくなります。</p>
      <p class="mt-1">これまでの出欠はデータとして保存されます。間違えて登録した場合や、重複して登録した場合に使ってください。<template v-if="isMe">あとで［自分を登録する］を押すと、同じ登録が戻ります。</template></p>
    </ConfirmDialog>
  </div>
</template>
