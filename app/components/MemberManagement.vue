<script setup lang="ts">
// メンバー（管理画面）：一覧と役割・活動中／停止中。オーナーだけが、除外（影響の確認つき）・アクセス停止と解除・
// 再参加拒否の解除・オーナー交代の依頼をできる。権限は毎回サーバーが確認する（remove_member / suspend_member など）。
// 本人登録がある人は除外できない（D6-B1）ので、除外の代わりにアクセス停止を案内する。
import { Ban, CirclePause, CirclePlay, Crown, ShieldCheck, UserMinus, UsersRound } from 'lucide-vue-next'
import { removalRoute } from '~/utils/memberActions'
import type { BlockedMember, MemberImpact, OwnerTransfers, TeamMember, TeamSnapshot } from '~/utils/types'

const props = defineProps<{ snap: TeamSnapshot; reload: () => Promise<void> }>()
const repo = useRepo()
const isOwner = computed(() => props.snap.me.role === 'owner')
const teamId = computed(() => props.snap.team.id)
const ROLE = { owner: 'オーナー', admin: '管理者', member: 'メンバー' } as const

const members = ref<TeamMember[] | null>(null)
const blocked = ref<BlockedMember[]>([])
const transfer = ref<OwnerTransfers['outgoing'][number] | null>(null)
const loadError = ref('')
const notice = ref('')
const error = ref('')
const busy = ref(false)

async function load() {
  loadError.value = ''
  try {
    members.value = await repo.listMembers(teamId.value)
    if (isOwner.value) {
      blocked.value = await repo.blockedMembers(teamId.value)
      transfer.value = (await repo.myOwnerTransfers()).outgoing.find((x) => x.team_id === teamId.value) ?? null
    }
  } catch (e) { loadError.value = errorMessage(e) }
}
watch(() => [teamId.value, props.snap.me.role], load, { immediate: true })
// Hand-over only to people with access (a stopped member cannot become the owner).
const others = computed(() => (members.value ?? []).filter((m) => m.user_id !== props.snap.me.user_id && !m.suspended_at))
const stopped = computed(() => (members.value ?? []).filter((m) => m.suspended_at))

async function act(fn: () => Promise<string>) {
  if (busy.value) return // double submit
  busy.value = true
  error.value = ''
  notice.value = ''
  try { notice.value = await fn() } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}

// --- 除外（オーナーのみ）: 影響を確認してから
const target = ref<TeamMember | null>(null)
const impact = ref<MemberImpact | null>(null)
const impactError = ref('')
let previewRequest = 0
async function openRemove(m: TeamMember) {
  const request = ++previewRequest
  const id = teamId.value
  target.value = m
  impact.value = null
  impactError.value = ''
  error.value = ''
  try {
    const result = await repo.removalPreview(id, m.user_id)
    if (request === previewRequest && target.value?.user_id === m.user_id && teamId.value === id) {
      impact.value = result
      // A self registration is never deleted by the owner (D6-B1): offer access suspension instead,
      // also when there are registrations only this person answers for (adding a responder would not help).
      if (removalRoute(result) === 'suspend') {
        ++previewRequest
        target.value = null
        openSuspend(m, true)
      }
    }
  } catch (e) {
    if (request === previewRequest && target.value?.user_id === m.user_id && teamId.value === id) impactError.value = errorMessage(e)
  }
}
const closeRemove = () => { if (!busy.value) { ++previewRequest; target.value = null } }
const removeTarget = () => act(async () => {
  const m = target.value!
  try {
    const r = await repo.removeMember(teamId.value, m.user_id)
    target.value = null
    await Promise.all([load(), props.reload()])
    return `「${m.display_name}」をチームから除外しました。`
      + (r.self_registrations_deleted ? `本人登録 ${r.self_registrations_deleted} 件を削除しました。` : '')
  } catch (e) {
    // Changed since the preview (e.g. a new registration only this person answers for): show it again.
    if (e instanceof RepoError && e.code === 'sole_guardian_children') impact.value = await repo.removalPreview(teamId.value, m.user_id).catch(() => impact.value)
    if (e instanceof RepoError && e.code === 'member_data_confirmation_required') {
      target.value = null
      openSuspend(m, true)
      return ''
    }
    throw e
  }
})

// --- アクセス停止・解除（オーナーのみ）。停止しても登録・出欠は削除しない（D6-B1）
const suspendTarget = ref<TeamMember | null>(null)
const suspendFromRemoval = ref(false)
function openSuspend(m: TeamMember, fromRemoval = false) {
  error.value = ''
  suspendFromRemoval.value = fromRemoval
  suspendTarget.value = m
}
const suspend = () => act(async () => {
  const m = suspendTarget.value!
  await repo.suspendMember(teamId.value, m.user_id)
  suspendTarget.value = null
  await Promise.all([load(), props.reload()])
  return `「${m.display_name}」のアクセスを停止しました。登録と出欠は残っています。`
})
const resumeTarget = ref<TeamMember | null>(null)
const resume = () => act(async () => {
  const m = resumeTarget.value!
  await repo.resumeMember(teamId.value, m.user_id)
  resumeTarget.value = null
  await Promise.all([load(), props.reload()])
  return `「${m.display_name}」のアクセス停止を解除しました。一般のメンバーとして使えるようになります。`
})

// --- 再参加拒否の解除（オーナーのみ）
const unblockTarget = ref<BlockedMember | null>(null)
const unblock = () => act(async () => {
  const b = unblockTarget.value!
  await repo.unblockMember(teamId.value, b.user_id)
  unblockTarget.value = null
  await load()
  return '再参加の拒否を解除しました。参加用URLから、もう一度参加できるようになります。'
})

// --- オーナー交代の依頼（既存の仕組み：相手の承認で交代）
const pick = ref('')
const requestTransfer = () => act(async () => {
  if (!pick.value) return ''
  await repo.requestOwnerTransfer(teamId.value, pick.value)
  await load()
  return '交代を依頼しました。相手が［引き受ける］を押すと交代します（それまではあなたがオーナーです）。'
})
const cancelTransfer = () => act(async () => {
  await repo.cancelOwnerTransfer(teamId.value)
  await load()
  return '交代の依頼を取り消しました。'
})
const shortId = (id: string) => id.slice(0, 8)
</script>

<template>
  <AppCard title="メンバー" :icon="UsersRound">
    <p v-if="loadError" role="alert" class="text-sm text-error">{{ loadError }}</p>
    <div v-else-if="!members" class="skeleton h-24 rounded-field bg-base-200" />
    <template v-else>
      <p class="mb-2 text-xs text-base-content/60">{{ members.length }}人<template v-if="stopped.length">（うちアクセス停止中 {{ stopped.length }}人）</template><template v-if="!isOwner">・メンバーの除外・停止はオーナーだけができます</template></p>
      <details v-if="isOwner" class="mb-2 rounded-xl bg-base-200/50 px-3 py-2 text-xs text-base-content/70">
        <summary class="min-h-8 cursor-pointer font-bold">「除外」と「アクセス停止」の違い</summary>
        <ul class="mt-1 list-disc space-y-1 pl-4">
          <li><b>除外</b>：チームから外し、再参加も拒否します。本人登録がある人や、その人だけが回答できる登録がある人は除外できません。</li>
          <li><b>アクセス停止</b>：登録と出欠を残したまま、チームを見たり回答したりできなくします。解除すると一般のメンバーに戻ります。停止中の本人は、自分の登録を確認して整理し、チームから抜けられます。</li>
        </ul>
      </details>
      <ul class="divide-y divide-base-200">
        <li v-for="m in members" :key="m.user_id" class="flex min-h-14 items-center gap-3 py-2">
          <TeamAvatar :name="m.display_name" size="sm" soft />
          <div class="min-w-0 flex-1">
            <p class="flex min-w-0 items-center gap-1.5 font-bold">
              <span class="truncate">{{ m.display_name }}</span>
              <span v-if="m.user_id === snap.me.user_id" class="badge badge-ghost badge-xs shrink-0 border-base-300">あなた</span>
            </p>
            <p class="flex flex-wrap items-center gap-1 text-xs text-base-content/60">
              <Crown v-if="m.role === 'owner'" class="size-3.5 text-warning" aria-hidden="true" /><ShieldCheck v-else-if="m.role === 'admin'" class="size-3.5 text-primary" aria-hidden="true" />{{ ROLE[m.role] }}
              <span v-if="m.suspended_at" class="badge badge-warning badge-soft badge-xs gap-0.5 font-bold"><CirclePause class="size-3" aria-hidden="true" />アクセス停止中</span>
              <span v-else class="sr-only">（活動中）</span>
            </p>
          </div>
          <div v-if="isOwner && m.user_id !== snap.me.user_id" class="flex shrink-0 flex-col items-end min-[400px]:flex-row">
            <button v-if="!m.suspended_at" type="button" class="btn btn-ghost btn-sm min-h-11 px-2 text-warning" :disabled="busy"
              :aria-label="`${m.display_name}のアクセスを停止`" @click="openSuspend(m)">
              <CirclePause class="size-4" />停止
            </button>
            <button v-if="isOwner && m.role !== 'owner'" type="button" class="btn btn-ghost btn-sm min-h-11 px-2 text-error" :disabled="busy"
              :aria-label="`${m.display_name}をチームから除外`" @click="openRemove(m)">
              <UserMinus class="size-4" />除外
            </button>
          </div>
        </li>
      </ul>
    </template>

    <p v-if="notice" role="status" class="mt-3 text-sm text-success">{{ notice }}</p>
    <p v-if="error && !target" role="alert" class="mt-3 text-sm text-error">{{ error }}</p>

    <!-- オーナー交代（オーナーのみ） -->
    <section v-if="isOwner && members" aria-labelledby="owner-transfer-title" class="mt-5 space-y-2 border-t border-base-200 pt-4">
      <h3 id="owner-transfer-title" class="flex items-center gap-1.5 text-sm font-bold"><Crown class="size-4 text-warning" />オーナーの交代</h3>
      <template v-if="transfer">
        <p class="text-sm text-base-content/70">「{{ transfer.to_name ?? '（チームにいない人）' }}」に交代を依頼中です（{{ formatDateTime(transfer.expires_at) }} まで）。相手が［引き受ける］を押すと交代します。</p>
        <button type="button" class="btn btn-sm min-h-11 border-base-300 bg-base-100" :disabled="busy" @click="cancelTransfer">依頼を取り消す</button>
      </template>
      <p v-else-if="!others.length" class="text-sm text-base-content/60">ほかのメンバーが参加すると、オーナーの交代を依頼できます。</p>
      <form v-else class="flex flex-col gap-2 min-[400px]:flex-row" @submit.prevent="requestTransfer">
        <select v-model="pick" class="select min-h-11 flex-1" aria-label="新しいオーナー" required>
          <option value="" disabled>新しいオーナーを選ぶ</option>
          <option v-for="m in others" :key="m.user_id" :value="m.user_id">{{ m.display_name }}（{{ ROLE[m.role] }}）</option>
        </select>
        <button class="btn min-h-11 border-base-300 bg-base-100" :disabled="busy || !pick">交代を依頼する</button>
      </form>
      <p class="text-xs text-base-content/55">交代は相手の承認が必要です。依頼するだけでは何も変わらず、退会にもなりません。交代後、あなたは一般のメンバーになります。</p>
    </section>

    <!-- アクセス停止中の人（オーナーのみ） -->
    <section v-if="isOwner && members && stopped.length" aria-labelledby="stopped-title" class="mt-5 space-y-2 border-t border-base-200 pt-4">
      <h3 id="stopped-title" class="flex items-center gap-1.5 text-sm font-bold"><CirclePause class="size-4 text-warning" />アクセス停止中の人</h3>
      <ul class="space-y-2">
        <li v-for="m in stopped" :key="m.user_id" class="flex min-h-11 items-center gap-2 rounded-xl bg-base-200/60 px-3 py-1.5 text-sm">
          <span class="min-w-0 flex-1 break-words">{{ m.display_name }}<span class="block text-xs text-base-content/55">{{ formatDateTime(m.suspended_at!) }} に停止</span></span>
          <button type="button" class="btn btn-ghost btn-sm min-h-11 shrink-0" :disabled="busy" @click="resumeTarget = m"><CirclePlay class="size-4" />解除</button>
        </li>
      </ul>
    </section>

    <!-- 再参加の拒否（オーナーのみ） -->
    <section v-if="isOwner && members" aria-labelledby="blocked-title" class="mt-5 space-y-2 border-t border-base-200 pt-4">
      <h3 id="blocked-title" class="flex items-center gap-1.5 text-sm font-bold"><Ban class="size-4 text-error" />再参加を拒否している人</h3>
      <p v-if="!blocked.length" class="text-sm text-base-content/60">いません。除外した人は、ここに表示されます（参加用URL・家族招待のどちらからも再参加できません）。</p>
      <ul v-else class="space-y-2">
        <li v-for="b in blocked" :key="b.user_id" class="flex min-h-11 items-center gap-2 rounded-xl bg-base-200/60 px-3 py-1.5 text-sm">
          <span class="min-w-0 flex-1">{{ formatDateTime(b.blocked_at) }} に除外<span class="block text-xs text-base-content/55">利用者ID {{ shortId(b.user_id) }}…（名前は保存していません）</span></span>
          <button type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="busy" @click="unblockTarget = b">解除</button>
        </li>
      </ul>
    </section>

    <ConfirmDialog :open="!!target" :title="target ? `「${target.display_name}」を除外しますか？` : ''" confirm-label="除外する" :busy="busy"
      :confirm-disabled="!impact || impact.sole_guardian_children.length > 0" @confirm="removeTarget" @cancel="closeRemove">
      <div class="space-y-3">
        <p v-if="impactError" role="alert" class="text-error">{{ impactError }}</p>
        <div v-else-if="!impact" class="skeleton h-16 rounded-field bg-base-200" />
        <MemberImpactView v-else :impact="impact" who="other" :token="snap.team.id" />
        <p class="text-xs text-base-content/60">除外した人は、このチームを見られなくなり、参加用URL・家族招待のどちらからも再参加できなくなります（下の一覧から解除できます）。</p>
        <p v-if="error" role="alert" class="text-error">{{ error }}</p>
      </div>
    </ConfirmDialog>
    <ConfirmDialog :open="!!suspendTarget" :title="suspendTarget ? `「${suspendTarget.display_name}」のアクセスを停止しますか？` : ''" confirm-label="停止する" :busy="busy"
      @confirm="suspend" @cancel="suspendTarget = null">
      <div class="space-y-2">
        <p v-if="suspendFromRemoval" class="font-bold">本人登録があるため除外できません。代わりにアクセスを停止できます。</p>
        <p><b>本人登録・代理登録・出欠は削除しません。</b>停止中、この人はチームの画面・予定・ほかのメンバーを見られず、回答もできません。</p>
        <p>この人が作った未使用の家族招待は使えなくなり、オーナー交代の依頼も取り消されます。</p>
        <p>停止中の本人は、自分の登録を確認して整理し、チームから抜けられます。いつでも解除できます。</p>
        <p v-if="error" role="alert" class="text-error">{{ error }}</p>
      </div>
    </ConfirmDialog>
    <ConfirmDialog :open="!!resumeTarget" :title="resumeTarget ? `「${resumeTarget.display_name}」の停止を解除しますか？` : ''" confirm-label="解除する" :busy="busy"
      @confirm="resume" @cancel="resumeTarget = null">
      <p>解除すると、この人は<b>一般のメンバー</b>としてチームを使えるようになります（以前が管理者でも、メンバーとして戻ります）。登録と出欠は停止前のままです。</p>
    </ConfirmDialog>
    <ConfirmDialog :open="!!unblockTarget" title="再参加の拒否を解除しますか？" confirm-label="解除する" :busy="busy"
      @confirm="unblock" @cancel="unblockTarget = null">
      <p>解除すると、この人は参加用URLからもう一度参加できるようになります。自動では参加しません。</p>
    </ConfirmDialog>
  </AppCard>
</template>
