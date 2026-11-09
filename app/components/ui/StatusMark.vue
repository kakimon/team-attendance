<script setup lang="ts">
// Compact symbol for the table view.
import { STATUS_CLASS, STATUS_LABEL, STATUS_MARK, type Status } from '~/utils/types'
defineProps<{ status: Status }>()
</script>

<template>
  <span class="text-lg font-bold" :class="STATUS_CLASS[status]" :title="STATUS_LABEL[status]"
    :aria-label="STATUS_LABEL[status]">{{ STATUS_MARK[status] }}</span>
</template>
