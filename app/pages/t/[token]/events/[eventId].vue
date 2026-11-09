<script setup lang="ts">
// 予定の編集・削除（管理者のみ）
import { CalendarX2, Lock } from 'lucide-vue-next'
const route = useRoute()
const token = computed(() => String(route.params.token))
const eventId = computed(() => String(route.params.eventId))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="予定を編集" :back="`/t/${token}/admin`">
    <EmptyState v-if="!isAdminRole(snap)" :icon="Lock" tone="error" title="管理者のみ利用できます" />
    <EmptyState v-else-if="!snap.events.some((e) => e.id === eventId)" :icon="CalendarX2" title="予定が見つかりません"
      text="すでに削除された可能性があります。">
      <NuxtLink :to="`/t/${token}/admin`" class="btn btn-outline border-base-300">管理へ戻る</NuxtLink>
    </EmptyState>
    <EventEditor v-else :snap="snap" :event="snap.events.find((e) => e.id === eventId)!" />
  </TeamShell>
</template>
