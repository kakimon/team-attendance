<script setup lang="ts">
// 参加用URL（オーナー・管理者）：表示・コピー／再発行／受付の停止・再開。権限はサーバーが確認する
// （get_join_link / rotate_join_token / set_join_open）。トークンは画面にだけ出し、ログには出さない。
import { CirclePause, CirclePlay, Link, RefreshCw } from 'lucide-vue-next'
import type { JoinLink, TeamSnapshot } from '~/utils/types'

const props = defineProps<{ snap: TeamSnapshot }>()
const emit = defineEmits<{ shared: [] }>()
const repo = useRepo()
const link = ref<JoinLink | null>(null)
const loadError = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const confirm = ref<'rotate' | 'stop' | null>(null)

const url = computed(() => (link.value?.token && import.meta.client
  ? shareUrl('join', link.value.token, location.origin, useRuntimeConfig().app.baseURL) : ''))

async function load() {
  loadError.value = ''
  try { link.value = await repo.getJoinLink(props.snap.team.id) } catch (e) { loadError.value = errorMessage(e) }
}
watch(() => props.snap.team.id, load, { immediate: true })

async function run(kind: 'rotate' | 'stop' | 'reopen') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    link.value = kind === 'rotate' ? await repo.rotateJoinLink(props.snap.team.id)
      : await repo.setJoinOpen(props.snap.team.id, kind === 'reopen')
    notice.value = kind === 'rotate' ? '新しい参加用URLを発行しました。以前のURLは使えなくなりました。'
      : kind === 'stop' ? '参加の受付を停止しました。' : '参加の受付を再開しました（新しい参加用URLです）。'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
    confirm.value = null
  }
}
</script>

<template>
  <AppCard title="参加用URL" :icon="Link" data-guide="share-url">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span v-if="link" class="badge gap-1 font-bold" :class="link.open ? 'badge-success badge-soft' : 'badge-warning badge-soft'" role="status">
        <component :is="link.open ? CirclePlay : CirclePause" class="size-3.5" aria-hidden="true" />{{ link.open ? '受付中' : '受付停止中' }}
      </span>
      <span class="text-xs text-base-content/60">新しいメンバーを招待するためのURLです</span>
    </div>

    <p v-if="loadError" role="alert" class="text-sm text-error">{{ loadError }}</p>
    <div v-else-if="!link" class="skeleton h-12 rounded-field bg-base-200" />

    <template v-else-if="link.open">
      <p class="mb-3 text-sm text-base-content/65">LINEグループなどに貼ってください。開いた人は、ログインして表示名を入れるとメンバーとして参加します。</p>
      <CopyField :value="url" :share-title="snap.team.name" @copied="emit('shared')" @shared="emit('shared')" />
      <div class="mt-4 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
        <button type="button" class="btn min-h-11 border-base-300 bg-base-100" :disabled="busy" @click="confirm = 'rotate'">
          <RefreshCw class="size-4" />URLを再発行
        </button>
        <button type="button" class="btn min-h-11 border-base-300 bg-base-100 text-warning" :disabled="busy" @click="confirm = 'stop'">
          <CirclePause class="size-4" />受付を停止
        </button>
      </div>
    </template>

    <template v-else>
      <p class="mb-3 text-sm text-base-content/65">参加の受付を停止しています。参加用URLを開いても参加できません。すでにメンバーの人は、これまでどおり出欠を回答できます。</p>
      <button type="button" class="btn btn-brand min-h-11 w-full" :disabled="busy" @click="run('reopen')">
        <CirclePlay class="size-4" />受付を再開（新しいURLを発行）
      </button>
    </template>

    <p v-if="notice" role="status" class="mt-3 text-sm text-success">{{ notice }}</p>
    <p v-if="error" role="alert" class="mt-3 text-sm text-error">{{ error }}</p>
    <p class="mt-3 text-xs leading-relaxed text-base-content/55">
      チーム画面のURL（ブラウザのアドレス）はメンバー専用で、参加には使えません。以前の形式の共有URLからは、この画面では新しく参加できません。
    </p>

    <ConfirmDialog :open="confirm === 'rotate'" title="参加用URLを再発行しますか？" confirm-label="再発行する" :busy="busy"
      @confirm="run('rotate')" @cancel="confirm = null">
      <p>新しい参加用URLを発行します。<b>以前の参加用URLは、すぐに使えなくなります。</b></p>
      <p class="mt-1">まだ参加していない人には、新しいURLを送り直してください。すでにメンバーの人には影響ありません。</p>
    </ConfirmDialog>
    <ConfirmDialog :open="confirm === 'stop'" title="参加の受付を停止しますか？" confirm-label="停止する" :busy="busy"
      @confirm="run('stop')" @cancel="confirm = null">
      <p>参加用URLを開いても、新しく参加できなくなります。すでにメンバーの人は、これまでどおり出欠を回答できます。</p>
      <p class="mt-1">再開すると、新しい参加用URLが発行されます（停止前のURLは使えません）。</p>
    </ConfirmDialog>
  </AppCard>
</template>
