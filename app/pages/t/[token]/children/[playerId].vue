<script setup lang="ts">
// お子さんの設定：情報の修正・家族招待・登録の取り消し
import { Lock } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const playerId = computed(() => String(route.params.playerId))
const child = (s: TeamSnapshot) =>
  s.myPlayerIds.includes(playerId.value) ? s.players.find((p) => p.id === playerId.value) : undefined
</script>

<template>
  <TeamShell v-slot="{ snap, reload }" title="お子さんの設定" :back="`/t/${token}/children`">
    <EmptyState v-if="!child(snap)" :icon="Lock" tone="error" title="このお子さんの設定は開けません"
      text="設定できるのは、そのお子さんの保護者だけです。登録が取り消された可能性もあります。">
      <NuxtLink :to="`/t/${token}/children`" class="btn btn-outline border-base-300">うちの子へ戻る</NuxtLink>
    </EmptyState>
    <ChildSettings v-else :key="child(snap)!.id" :child="child(snap)!" :reload="reload" />
  </TeamShell>
</template>
