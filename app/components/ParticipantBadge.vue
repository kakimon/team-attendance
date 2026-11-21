<script setup lang="ts">
// 名前の横の小さな表示：あなた（本人）／本人／あなたが回答
import type { Player, TeamSnapshot } from '~/utils/types'
import { participantBadge } from '~/utils/participants'

const props = defineProps<{ snap: TeamSnapshot; player: Player; size?: 'xs' | 'sm' }>()
const badge = computed(() => participantBadge(props.snap, props.player))
</script>

<template>
  <span v-if="badge" class="badge shrink-0 whitespace-nowrap"
    :class="[badge.tone === 'primary' ? 'badge-primary' : 'badge-ghost border-base-300', size === 'sm' ? 'badge-sm' : 'badge-xs']">{{ badge.label }}</span>
</template>
