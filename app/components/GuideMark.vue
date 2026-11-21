<script setup lang="ts">
// Records a device-only checklist step for owners/admins when the element it sits in is actually
// rendered (e.g. inside the 一覧表, which only renders with a loaded team and >= 1 event).
// Saved under this user × this team × admin. Renders nothing. Never used for permissions.
import type { TeamSnapshot } from '~/utils/types'
import { guideRoleOf } from '~/utils/onboarding'
import { updateTeamGuide } from '~/utils/guideStore'

const props = defineProps<{ snap: TeamSnapshot; flag: 'viewedTable' | 'sharedLink' }>()
const { user } = useAuth()
// Re-checked when the team / role / events change while the element stays on screen.
onMounted(() => watch(() => [props.snap.team.id, props.snap.me.role, props.snap.events.length], () => {
  if (user.value && guideRoleOf(props.snap.me.role) === 'admin' && props.snap.events.length > 0) {
    updateTeamGuide(user.value.id, props.snap.team.id, 'admin', { [props.flag]: true })
  }
}, { immediate: true }))
</script>

<template><span hidden /></template>
