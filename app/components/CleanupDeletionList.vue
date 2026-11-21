<script setup lang="ts">
// D6-A の削除対象一覧（登録名・本人／取り消し済み・出欠件数）。脱退時の整理（MemberImpactView）と、
// アクセス停止中の本人の整理（SuspendedLeavePanel）で同じ表示を使う。
import type { LeaveCleanup } from '~/utils/types'

defineProps<{ deletions: LeaveCleanup['deletions'] }>()
</script>

<template>
  <ul class="space-y-2">
    <li v-for="p in deletions" :key="p.player_id" class="break-words rounded-xl bg-base-200/70 px-3 py-2">{{ p.name }}{{ p.is_self ? '（本人）' : '' }}{{ p.cancelled ? '（取り消し済み）' : '' }}：出欠 {{ p.answers }} 件</li>
  </ul>
</template>
