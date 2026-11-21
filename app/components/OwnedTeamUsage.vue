<script setup lang="ts">
import { OWNER_TEAM_LIMIT } from '~/utils/teamUsage'

defineProps<{ count: number | null; loading?: boolean; disabled?: boolean }>()
defineEmits<{ refresh: [] }>()
</script>

<template>
  <section aria-label="所有チーム数" class="space-y-2 rounded-box bg-base-100 p-4 text-sm shadow-soft">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p role="status" class="font-bold">
        作成・所有中のチーム数
        <span class="whitespace-nowrap">{{ count === null ? '—' : count }}/{{ OWNER_TEAM_LIMIT }}</span>
      </p>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || disabled" @click="$emit('refresh')">件数を更新</button>
    </div>
    <p v-if="loading" class="text-base-content/65">所有数を確認しています…</p>
    <p v-else-if="count === null" class="text-base-content/65">所有数を取得できませんでした。「件数を更新」で再確認してください。</p>
    <p v-else-if="count >= OWNER_TEAM_LIMIT" class="text-base-content/80">所有上限の{{ OWNER_TEAM_LIMIT }}件に達しているため、新しいチームは作成できません。</p>
    <details :open="count !== null && count >= OWNER_TEAM_LIMIT" class="text-base-content/70">
      <summary class="cursor-pointer py-1">所有枠と作成回数について</summary>
      <div class="mt-1 space-y-2 leading-relaxed">
        <p>チームを削除するか、別のメンバーがオーナー交代を引き受けると、あなたの所有枠が戻ります。交代の依頼だけでは戻りません。どちらもチームの［管理］から行えます。</p>
        <p>作成は直近24時間で5回までです。チームを削除しても、この作成回数は減りません。回数制限に達した場合は、時間をおいてお試しください。</p>
      </div>
    </details>
  </section>
</template>
