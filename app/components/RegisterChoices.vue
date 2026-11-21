<script setup lang="ts">
// 登録の入口（2 つ）：自分を登録する（本人登録）／家族などを登録する（代理登録）。
// 本人登録済み、または本人登録に未対応の環境では「自分を登録する」を出さない。
import { UserPlus, UserRound } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'
import { canRegisterSelf } from '~/utils/participants'

const props = defineProps<{ snap: TeamSnapshot; token: string; compact?: boolean }>()
const self = computed(() => canRegisterSelf(props.snap))
</script>

<template>
  <div data-guide="children-add" class="grid w-full gap-2" :class="self && !compact ? 'sm:grid-cols-2' : ''">
    <NuxtLink v-if="self" :to="`/t/${token}/children/self`" class="btn h-auto min-h-12 justify-start gap-3 py-2 text-left"
      :class="compact ? 'btn-outline border-dashed border-base-300 bg-base-100/60' : 'btn-brand'">
      <UserRound class="size-5 shrink-0" aria-hidden="true" />
      <span class="flex min-w-0 flex-col">
        <span class="font-bold">自分を登録する</span>
        <span class="text-xs font-normal opacity-80">自分の出欠を自分で回答します</span>
      </span>
    </NuxtLink>
    <NuxtLink :to="`/t/${token}/children/new`" class="btn h-auto min-h-12 justify-start gap-3 py-2 text-left"
      :class="compact || self ? 'btn-outline border-base-300 bg-base-100' : 'btn-brand'">
      <UserPlus class="size-5 shrink-0" aria-hidden="true" />
      <span class="flex min-w-0 flex-col">
        <span class="font-bold">家族などを登録する</span>
        <span class="text-xs font-normal opacity-80">お子さんなどの出欠を代わりに回答します</span>
      </span>
    </NuxtLink>
  </div>
</template>
