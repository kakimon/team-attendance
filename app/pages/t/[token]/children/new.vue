<script setup lang="ts">
// 子ども登録: registrant becomes the first guardian. Similar names = warning only.
import { ShieldCheck, TriangleAlert, UserPlus } from 'lucide-vue-next'
import type { RegisterResult, TeamSnapshot } from '~/utils/types'

const route = useRoute()
const token = computed(() => String(route.params.token))
const repo = useRepo()
const name = ref('')
const note = ref('')
const similar = ref<Extract<RegisterResult, { status: 'similar_found' }>['similar']>([])
const error = ref('')
const busy = ref(false)

async function submit(s: TeamSnapshot, confirmSimilar: boolean) {
  error.value = ''
  if (!name.value.trim()) return
  busy.value = true
  try {
    const r = await repo.registerPlayer(s.team.id, name.value.trim(), note.value.trim() || null, confirmSimilar)
    if (r.status === 'similar_found') {
      similar.value = r.similar
      return
    }
    await navigateTo(`/t/${token.value}/answer`)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
watch(name, () => (similar.value = []))
</script>

<template>
  <TeamShell v-slot="{ snap }" title="子どもを登録" :back="`/t/${token}/children`">
    <form class="space-y-4" @submit.prevent="submit(snap, false)">
      <AppCard title="お子さんの情報" :icon="UserPlus">
        <div class="space-y-4">
          <FormField label="名前">
            <input v-model="name" required maxlength="40" class="input input-lg w-full" placeholder="例：田中 ゆうと">
          </FormField>
          <FormField label="学年・クラスなど" optional>
            <input v-model="note" maxlength="40" class="input input-lg w-full" placeholder="例：4年、初級クラス">
          </FormField>
        </div>
      </AppCard>

      <div v-if="similar.length" role="alert" class="space-y-3 rounded-box border border-warning/50 bg-[#fff7e6] p-4">
        <p class="flex items-center gap-2 font-bold"><TriangleAlert class="size-5 text-warning" />同じ・似た名前の子がいます</p>
        <ul class="space-y-1 text-sm">
          <li v-for="s in similar" :key="s.id" class="rounded-xl bg-base-100 px-3 py-2">{{ s.name }} <span class="text-base-content/55">{{ s.note }}</span></li>
        </ul>
        <p class="text-sm text-base-content/75">
          ご家族がすでに登録している場合は、新しく登録せず<b>登録した家族から招待リンクを送ってもらってください</b>。
          ここで登録しても、既存の子の出欠は編集できません。
        </p>
        <button type="button" class="btn w-full border-warning/50 bg-base-100" :disabled="busy" @click="submit(snap, true)">別の子なので登録する</button>
      </div>

      <p v-if="error" class="text-sm text-error">{{ error }}</p>
      <button v-if="!similar.length" class="btn btn-brand btn-lg w-full" :disabled="busy">登録する</button>
      <div class="flex gap-3 rounded-box bg-base-100/70 p-4 text-sm text-base-content/70">
        <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" />
        <p>登録したあなたが、この子の出欠を編集できる保護者になります。ほかの家庭の方は編集できません。</p>
      </div>
    </form>
  </TeamShell>
</template>
