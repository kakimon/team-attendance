<script setup lang="ts">
// 家族招待: create a 24h, single-use link for another guardian of this child.
import { Clock, Link, Lock, Send, ShieldCheck, UserPlus, UsersRound } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const playerId = computed(() => String(route.params.playerId))
const repo = useRepo()
const link = ref<{ url: string; expiresAt: string } | null>(null)
const error = ref('')
const busy = ref(false)

const child = (s: TeamSnapshot) =>
  s.myPlayerIds.includes(playerId.value) ? s.players.find((p) => p.id === playerId.value) : undefined

async function create() {
  error.value = ''
  busy.value = true
  try {
    const r = await repo.createInvitation(playerId.value)
    link.value = { url: shareUrl('invite', r.token, location.origin, useRuntimeConfig().app.baseURL), expiresAt: r.expires_at }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
const steps = [
  { icon: Link, text: '招待リンクを作成' },
  { icon: Send, text: '家族にLINEなどで送る' },
  { icon: UserPlus, text: '家族がGoogleでログインして受け取る' },
]
</script>

<template>
  <TeamShell v-slot="{ snap }" title="家族を招待" :back="`/t/${token}/children`">
    <EmptyState v-if="!child(snap)" :icon="Lock" tone="error" title="このお子さんの保護者ではありません"
      text="家族の招待は、そのお子さんの保護者だけが行えます。">
      <NuxtLink :to="`/t/${token}/children`" class="btn btn-outline border-base-300">うちの子へ戻る</NuxtLink>
    </EmptyState>

    <template v-else>
      <AppCard tight>
        <div class="flex items-center gap-3">
          <TeamAvatar :name="child(snap)!.name" size="lg" soft />
          <div>
            <p class="text-lg font-bold">{{ child(snap)!.name }}</p>
            <p class="text-sm text-base-content/55">{{ child(snap)!.note }}</p>
          </div>
        </div>
      </AppCard>

      <AppCard title="もう一人の保護者を追加" :icon="UsersRound">
        <p class="text-sm text-base-content/70">父・母など、別の Google アカウントでもこの子の出欠を入力できるようになります。</p>
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
        </div>
        <button v-else class="btn btn-brand btn-lg mt-5 w-full" :disabled="busy" @click="create">
          <Link class="size-5" />招待リンクを作成
        </button>
        <p v-if="error" class="mt-2 text-sm text-error">{{ error }}</p>
      </AppCard>

      <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
        <p>招待リンクは24時間で無効になり、一度使うと再利用できません。家族以外には送らないでください。</p>
      </div>
    </template>
  </TeamShell>
</template>
