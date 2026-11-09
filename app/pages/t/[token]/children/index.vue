<script setup lang="ts">
// うちの子: my children; each links to the family invitation page.
import { ChevronRight, Plus, UserPlus, UsersRound } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const mine = (s: TeamSnapshot) => s.players.filter((p) => s.myPlayerIds.includes(p.id))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="うちの子">
    <EmptyState v-if="!mine(snap).length" :icon="UsersRound" title="まだ登録されていません"
      text="お子さんを登録すると、出欠を入力できるようになります。">
      <NuxtLink :to="`/t/${token}/children/new`" class="btn btn-brand"><Plus class="size-4" />子どもを登録する</NuxtLink>
    </EmptyState>

    <template v-else>
      <ul class="space-y-3">
        <li v-for="p in mine(snap)" :key="p.id">
          <NuxtLink :to="`/t/${token}/children/${p.id}`"
            class="flex items-center gap-3 rounded-box bg-base-100 p-4 shadow-soft transition hover:ring-2 hover:ring-primary/20 active:scale-[0.99]">
            <TeamAvatar :name="p.name" soft />
            <div class="min-w-0 flex-1">
              <p class="truncate font-bold">{{ p.name }}</p>
              <p class="flex items-center gap-1 text-xs text-primary"><UserPlus class="size-3.5" />家族を招待</p>
            </div>
            <span v-if="p.note" class="badge badge-ghost">{{ p.note }}</span>
            <ChevronRight class="size-5 text-base-content/35" />
          </NuxtLink>
        </li>
      </ul>
      <NuxtLink :to="`/t/${token}/children/new`" class="btn btn-outline w-full border-dashed border-base-300 bg-base-100/60">
        <Plus class="size-4" />子どもを登録する
      </NuxtLink>
    </template>
  </TeamShell>
</template>
