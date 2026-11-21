<script setup lang="ts">
// Wraps every /t/[token]/* page. The route param is the team id (/t/<team id>); an old
// /t/<share token> address is resolved for members only (see useTeamPage). Never a join form here:
// joining uses the separate join link (/join/<token>).
import { Link2Off, Lock } from 'lucide-vue-next'
const props = defineProps<{ title: string; back?: string }>()
const route = useRoute()
const token = computed(() => String(route.params.token))
const { state, load } = useTeamPage(() => token.value)
await load()
watch(token, () => load()) // moved from an old address, or another team
const roleLabel = computed(() => (state.snap ? { owner: 'オーナー', admin: '管理者', member: '' }[state.snap.me.role] : ''))
</script>

<template>
  <div>
    <!-- Loading -->
    <template v-if="state.status === 'loading'">
      <AppHeader :title="props.title" subtitle="読み込み中…" />
      <main class="mx-auto max-w-3xl space-y-3 px-4 py-5 md:px-6">
        <div v-for="i in 3" :key="i" class="skeleton h-24 rounded-box bg-base-100" />
      </main>
    </template>

    <!-- Error -->
    <template v-else-if="state.status === 'error'">
      <AppHeader title="みんなの出欠" back="/" />
      <main class="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <EmptyState :icon="Link2Off" tone="error" title="エラーが発生しました" :text="state.error">
          <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
        </EmptyState>
        <LegalFooter />
      </main>
    </template>

    <!-- Not a member (team address) / old address of a team I am not in: no team information at all -->
    <!-- My access to this team was stopped by the owner: no team data, only the way to my own cleanup -->
    <template v-else-if="state.status === 'suspended'">
      <AppHeader title="みんなの出欠" back="/" />
      <main class="mx-auto max-w-md space-y-4 px-4 py-6">
        <EmptyState :icon="Lock" tone="error" title="このチームへのアクセスは停止されています"
          text="チームのオーナーが、あなたのアクセスを停止しました。チームの画面・予定・メンバーは表示できません。あなたの登録と出欠は削除されていません。">
          <NuxtLink :to="`/suspended/${token}`" class="btn btn-outline border-base-300">自分の登録を確認・整理する</NuxtLink>
        </EmptyState>
        <LegalFooter />
      </main>
    </template>

    <template v-else-if="state.status !== 'ok' || !state.snap">
      <AppHeader title="みんなの出欠" back="/" />
      <main class="mx-auto max-w-md space-y-4 px-4 py-6">
        <EmptyState :icon="Lock" tone="error" title="このチームの画面は表示できません"
          :text="state.status === 'legacy_unknown'
            ? 'このリンクは以前の形式です。この形式のリンクからは、新しくチームに参加できません。参加するには、チームの管理者から「参加用URL」を受け取ってください。'
            : 'チームの画面は、そのチームのメンバーだけが見られます。参加するには、チームの管理者から「参加用URL」を受け取ってください。'">
          <NuxtLink to="/" class="btn btn-outline border-base-300">チーム一覧へ</NuxtLink>
        </EmptyState>
        <p class="px-1 text-xs leading-relaxed text-base-content/60">
          すでにメンバーのはずの場合は、参加したときと同じ Google アカウントでログインしているか確認してください。
        </p>
        <LegalFooter />
      </main>
    </template>

<!-- Member -->
    <template v-else>
      <AppHeader :title="props.title" :subtitle="state.snap.team.name + (roleLabel ? `（${roleLabel}）` : '')" :back="props.back">
        <TeamTabs :token="token" :is-admin="isAdminRole(state.snap)" placement="header" />
      </AppHeader>
      <main class="mx-auto max-w-3xl space-y-4 px-4 pt-5 pb-28 md:px-6 md:pb-10">
        <div v-if="state.error" role="alert" class="alert alert-error rounded-box">{{ state.error }}</div>
        <slot :snap="state.snap" :reload="load" />
        <LegalFooter />
      </main>
      <TeamTabs :token="token" :is-admin="isAdminRole(state.snap)" placement="bottom" />
      <GuideTour :snap="state.snap" :token="token" />
    </template>
  </div>
</template>
