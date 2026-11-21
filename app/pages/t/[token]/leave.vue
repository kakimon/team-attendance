<script setup lang="ts">
// チームから脱退（自分のみ）。影響の確認・オーナーの場合の案内・脱退は LeaveTeamPanel。
const route = useRoute()
const token = computed(() => String(route.params.token))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="チームから脱退" :back="`/t/${token}/children`">
    <LeaveTeamPanel :snap="snap" />
  </TeamShell>
</template>
