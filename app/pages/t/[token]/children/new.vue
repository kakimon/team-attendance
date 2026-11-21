<script setup lang="ts">
// 家族などを登録（代理登録）: the registrant becomes the first person who answers for them.
// Similar names = warning only. Registering oneself is a separate entry (children/self.vue).
import { ShieldCheck, TriangleAlert, UserPlus, UserRound } from 'lucide-vue-next'
import type { RegisterResult, TeamSnapshot } from '~/utils/types'
import { canRegisterSelf } from '~/utils/participants'

const route = useRoute()
const token = computed(() => String(route.params.token))
const repo = useRepo()
const name = ref('')
const note = ref('')
const similar = ref<Extract<RegisterResult, { status: 'similar_found' }>['similar']>([])
const error = ref('')
const busy = ref(false)

async function submit(s: TeamSnapshot, confirmSimilar: boolean) {
  if (busy.value) return // double submit
  error.value = ''
  if (!name.value.trim()) return
  busy.value = true
  try {
    const r = await repo.registerPlayer(s.team.id, name.value.trim(), note.value.trim() || null, confirmSimilar)
    if (r.status === 'similar_found') {
      similar.value = r.similar
      return
    }
    await navigateTo(`/t/${token.value}/answer?added=${r.player_id}`)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
watch(name, () => (similar.value = []))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="家族などを登録" :back="`/t/${token}/children`">
    <form class="space-y-4" @submit.prevent="submit(snap, false)">
      <FamilyShareHint variant="before" />
        <NuxtLink v-if="canRegisterSelf(snap)" :to="`/t/${token}/children/self`"
        class="flex min-h-11 items-center gap-2 rounded-box bg-base-100/70 px-4 py-2 text-sm">
        <UserRound class="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span class="flex-1">あなた自身が参加して回答する場合は、こちらから<b class="text-primary">自分を登録する</b></span>
      </NuxtLink>
      <AppCard title="回答する人の情報（お子さんなど）" :icon="UserPlus">
        <div class="space-y-4">
          <FormField label="名前">
            <input v-model="name" required maxlength="40" class="input input-lg w-full" placeholder="例：田中 ゆうと">
          </FormField>
          <FormField label="学年・クラス・メモなど" optional>
            <input v-model="note" maxlength="40" class="input input-lg w-full" placeholder="例：4年、初級クラス、祖母">
          </FormField>
        </div>
      </AppCard>

      <div v-if="similar.length" role="alert" class="space-y-3 rounded-box border border-warning/50 bg-[#fff7e6] p-4">
        <p class="flex items-center gap-2 font-bold"><TriangleAlert class="size-5 text-warning" />同じ・似た名前の登録があります</p>
        <ul class="space-y-1 text-sm">
          <li v-for="s in similar" :key="s.id" class="rounded-xl bg-base-100 px-3 py-2">{{ s.name }} <span class="text-base-content/55">{{ s.note }}</span></li>
        </ul>
        <p class="text-sm text-base-content/75">
          ご家族がすでに登録している場合は、新しく登録せず<b>登録した家族から招待リンクを送ってもらってください</b>。
          ここで登録しても、すでにある登録の出欠は編集できません。
        </p>
        <button type="button" class="btn w-full border-warning/50 bg-base-100" :disabled="busy" @click="submit(snap, true)">別の人なので登録する</button>
      </div>

      <p v-if="error" class="text-sm text-error">{{ error }}</p>
      <button v-if="!similar.length" class="btn btn-brand btn-lg w-full" :disabled="busy">登録する</button>
      <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
        <p>登録したあなたが、この人の出欠を代わりに回答できるようになります。ほかの方は編集できません（家族などは、あとから招待で追加できます）。</p>
      </div>
    </form>
  </TeamShell>
</template>
