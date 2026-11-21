<script setup lang="ts">
// アクセス停止中のチーム（/suspended/<チームID>）。通常のチーム画面ではない：チーム名・予定・
// メンバーは表示しない。停止中でなければ（解除済み・別端末）通常のチーム画面へ移る。
import { Link2Off } from 'lucide-vue-next'
import type { SuspendedMembership } from '~/utils/types'

useHead({ title: 'アクセス停止中のチーム | みんなの出欠' })
const route = useRoute()
const repo = useRepo()
const teamId = String(route.params.teamId)
const entry = ref<SuspendedMembership | null>(null)
const error = ref('')
const loading = ref(true)

try {
  entry.value = (await repo.mySuspendedMemberships()).find((x) => x.team_id === teamId) ?? null
  if (!entry.value && isTeamId(teamId)) await navigateTo(`/t/${teamId}`, { replace: true }) // not stopped (any more)
} catch (e) {
  error.value = errorMessage(e)
} finally {
  loading.value = false
}
</script>

<template>
  <div>
    <AppHeader title="アクセス停止中のチーム" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <div v-if="loading" class="skeleton h-40 rounded-box bg-base-100" />
      <EmptyState v-else-if="error || !entry" :icon="Link2Off" tone="error" title="表示できません" :text="error || 'このチームのアクセス停止は見つかりませんでした。'">
        <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
      </EmptyState>
      <SuspendedLeavePanel v-else :team-id="entry.team_id" :suspended-at="entry.suspended_at" :team-name="entry.team_name ?? null" />
      <LegalFooter />
    </main>
  </div>
</template>
