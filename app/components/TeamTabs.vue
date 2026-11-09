<script setup lang="ts">
// Team navigation: bottom tab bar on phones, pill tabs inside the header on md+.
import { ClipboardList, PenLine, Settings, UsersRound } from 'lucide-vue-next'
const props = defineProps<{ token: string; isAdmin: boolean; placement: 'bottom' | 'header' }>()
const route = useRoute()
const items = computed(() => [
  { to: `/t/${props.token}`, label: '出欠一覧', icon: ClipboardList, exact: true },
  { to: `/t/${props.token}/answer`, label: '出欠入力', icon: PenLine, exact: true },
  { to: `/t/${props.token}/children`, label: 'うちの子', icon: UsersRound, exact: false },
  ...(props.isAdmin ? [{ to: `/t/${props.token}/admin`, label: '管理', icon: Settings, exact: true }] : []),
])
const active = (i: { to: string; exact: boolean }) => (i.exact ? route.path === i.to : route.path.startsWith(i.to))
</script>

<template>
  <nav v-if="placement === 'bottom'" aria-label="チームメニュー"
    class="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-base-300 bg-base-100/95 backdrop-blur md:hidden">
    <ul class="mx-auto grid max-w-md" :style="{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }">
      <li v-for="i in items" :key="i.to">
        <NuxtLink :to="i.to" class="flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-bold"
          :class="active(i) ? 'text-primary' : 'text-base-content/50'" :aria-current="active(i) ? 'page' : undefined">
          <span class="grid h-7 w-12 place-items-center rounded-full transition" :class="active(i) ? 'bg-primary/12' : ''">
            <component :is="i.icon" class="size-5" />
          </span>
          {{ i.label }}
        </NuxtLink>
      </li>
    </ul>
  </nav>
  <nav v-else aria-label="チームメニュー" class="hidden gap-1 pt-1 md:flex">
    <NuxtLink v-for="i in items" :key="i.to" :to="i.to"
      class="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-bold transition"
      :class="active(i) ? 'bg-white text-primary' : 'text-white/85 hover:bg-white/15'" :aria-current="active(i) ? 'page' : undefined">
      <component :is="i.icon" class="size-4" />{{ i.label }}
    </NuxtLink>
  </nav>
</template>
