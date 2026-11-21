<script setup lang="ts">
// Loads, once per team, which of my children another guardian manages with me (read-only).
// Emits nothing on failure: the page then simply shows no sharing information.
import type { TeamSnapshot } from '~/utils/types'

const props = defineProps<{ snap: TeamSnapshot }>()
const emit = defineEmits<{ loaded: [ids: Set<string>] }>()
const repo = useRepo()
watch(() => [props.snap.team.id, props.snap.myPlayerIds.join(',')], async () => {
  if (!props.snap.myPlayerIds.length) return emit('loaded', new Set())
  try {
    emit('loaded', new Set((await repo.onboardingFacts(props.snap.team.id, props.snap.myPlayerIds)).sharedPlayerIds))
  } catch { /* unknown: show nothing */ }
}, { immediate: true })
</script>

<template><span hidden /></template>
