<script setup lang="ts">
// 回答する人: people I answer for (myself = 本人登録, children / family = 代理登録);
// each links to its settings and family invitation page.
import { ChevronRight, LogOut, Settings2, UsersRound } from 'lucide-vue-next'
import type { TeamSnapshot } from '~/utils/types'
import { myParticipants } from '~/utils/participants'

const route = useRoute()
const token = computed(() => String(route.params.token))
/** People another member answers for with me (null = unknown: show nothing about sharing). */
const shared = ref<Set<string> | null>(null)
const someNotShared = (s: TeamSnapshot) => !!shared.value && s.myPlayerIds.some((id) => !shared.value!.has(id))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="回答する人">
    <EmptyState v-if="!myParticipants(snap).length" :icon="UsersRound" title="回答する人がまだ登録されていません"
      text="あなた自身が参加するなら「自分を登録する」、お子さんなどの代わりに回答するなら「家族などを登録する」を選んでください。両方登録することもできます。">
      <RegisterChoices :snap="snap" :token="token" />
    </EmptyState>

    <template v-else>
      <SharedChildrenLoader :snap="snap" @loaded="(ids) => (shared = ids)" />
      <ul class="space-y-3" data-guide="children-list">
        <li v-for="p in myParticipants(snap)" :key="p.id">
          <!-- Someone else's self registration that I may answer for: only that person manages it. -->
          <div v-if="p.self_user_id && p.self_user_id !== snap.me.user_id" class="flex items-center gap-3 rounded-box bg-base-100 p-4 shadow-soft">
            <TeamAvatar :name="p.name" soft />
            <div class="min-w-0 flex-1">
              <p class="flex min-w-0 items-center gap-1.5 font-bold"><span class="truncate">{{ p.name }}</span><ParticipantBadge :snap="snap" :player="p" /></p>
              <p class="text-xs text-base-content/60">代わりに回答できます（設定は本人が行います）</p>
            </div>
          </div>
          <NuxtLink v-else :to="`/t/${token}/children/${p.id}`"
            class="flex items-center gap-3 rounded-box bg-base-100 p-4 shadow-soft transition hover:ring-2 hover:ring-primary/20 active:scale-[0.99]">
            <TeamAvatar :name="p.name" soft />
            <div class="min-w-0 flex-1">
              <p class="flex min-w-0 items-center gap-1.5 font-bold"><span class="truncate">{{ p.name }}</span><ParticipantBadge :snap="snap" :player="p" /></p>
              <p class="flex items-center gap-1 text-xs text-primary"><Settings2 class="size-3.5" />設定・家族招待</p>
            </div>
            <span v-if="shared?.has(p.id)" class="badge badge-success badge-soft shrink-0 gap-1"><UsersRound class="size-3" aria-hidden="true" />家族と共有中</span>
            <span v-if="p.note" class="badge badge-ghost hidden shrink-0 min-[400px]:inline-flex">{{ p.note }}</span>
            <ChevronRight class="size-5 shrink-0 text-base-content/35" />
          </NuxtLink>
        </li>
      </ul>
      <RegisterChoices :snap="snap" :token="token" compact />
      <FamilyShareHint v-if="someNotShared(snap)" variant="list" />
    </template>
    <NuxtLink v-if="snap.me.role !== 'owner'" :to="`/t/${token}/leave`" class="btn btn-ghost btn-sm min-h-11 w-full text-base-content/60">
      <LogOut class="size-4" />このチームから脱退する
    </NuxtLink>
  </TeamShell>
</template>
