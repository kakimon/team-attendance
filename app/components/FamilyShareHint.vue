<script setup lang="ts">
// 家族共有の案内（任意）。登録前・回答する人で 1 か所に出し、閉じたら以後出さない（端末保存）。
// 共有の操作（招待リンクの作成・送信）はしない。手順の説明へ案内するだけ。
import { UsersRound, X } from 'lucide-vue-next'
import { dismissFamilyHint, familyHintDismissed } from '~/utils/guideStore'

const props = defineProps<{ variant: 'before' | 'list' }>()
const { user } = useAuth()
const hidden = ref(true)
onMounted(() => (hidden.value = !user.value || familyHintDismissed(user.value.id)))
function close() {
  if (user.value) dismissFamilyHint(user.value.id)
  hidden.value = true
}
</script>

<template>
  <aside v-if="!hidden" aria-label="家族で使う" class="flex gap-3 rounded-box bg-primary/5 p-4 text-sm">
    <UsersRound class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
    <div class="min-w-0 flex-1 space-y-1">
      <p class="font-bold">家族で一緒に使えます</p>
      <p class="leading-relaxed text-base-content/75">
        お父さん・お母さんなど、家族の複数のアカウントで同じ人（お子さんなど）の出欠を回答できます。二重に登録する必要はありません。
      </p>
      <p v-if="props.variant === 'before'" class="leading-relaxed text-base-content/75">
        家族がすでにこのチームで同じ人を登録している場合は、ここで登録せず、家族から招待リンクを受け取ってください。
      </p>
      <p v-else class="leading-relaxed text-base-content/75">
        回答する人の［設定・家族招待］から招待リンクを作って、家族に送れます（任意）。
      </p>
      <NuxtLink to="/help#family" class="link link-primary inline-flex min-h-11 items-center text-sm font-bold">家族で共有する方法</NuxtLink>
    </div>
    <button type="button" class="btn btn-ghost btn-sm btn-square -mt-1 -mr-1 min-h-11 min-w-11" aria-label="家族で使う案内を閉じる" @click="close">
      <X class="size-4" aria-hidden="true" />
    </button>
  </aside>
</template>
