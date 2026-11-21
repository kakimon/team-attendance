<script setup lang="ts">
// 回答する人の設定：情報の修正・家族招待・登録の取り消し
import { Lock } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const playerId = computed(() => String(route.params.playerId))
const child = (s: TeamSnapshot) => {
  const p = s.myPlayerIds.includes(playerId.value) ? s.players.find((x) => x.id === playerId.value) : undefined
  // Someone else's self registration is managed only by that person (the server refuses the rest).
  return p && (!p.self_user_id || p.self_user_id === s.me.user_id) ? p : undefined
}
</script>

<template>
  <TeamShell v-slot="{ snap, reload }" title="回答する人の設定" :back="`/t/${token}/children`">
    <EmptyState v-if="!child(snap)" :icon="Lock" tone="error" title="この設定は開けません"
      text="設定できるのは、その人の出欠を回答できる人だけです（本人として登録された人は、本人だけが設定できます）。登録が取り消された可能性もあります。">
      <NuxtLink :to="`/t/${token}/children`" class="btn btn-outline border-base-300">回答する人へ戻る</NuxtLink>
    </EmptyState>
    <ChildSettings v-else :key="child(snap)!.id" :child="child(snap)!" :is-me="child(snap)!.self_user_id === snap.me.user_id" :reload="reload" />
  </TeamShell>
</template>
