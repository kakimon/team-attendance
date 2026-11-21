<script setup lang="ts">
// 除外・脱退の前に、そのチームの登録がどうなるかを示す（サーバーの removal_preview / leave_preview の結果）。
// who: 'self' = 自分が脱退する / 'other' = オーナーが別のメンバーを除外する。
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-vue-next'
import type { LeaveCleanup, MemberImpact } from '~/utils/types'

const props = defineProps<{ impact: MemberImpact; who: 'self' | 'other'; token: string; cleanup?: LeaveCleanup }>()
const them = computed(() => (props.who === 'self' ? 'あなた' : 'このメンバー'))
const active = computed(() => props.impact.sole_guardian_children.filter((c) => !c.cancelled))
const cancelled = computed(() => props.impact.sole_guardian_children.filter((c) => c.cancelled))
const nothing = computed(() => !props.impact.self_registrations.length && !props.impact.links_removed.length && !props.impact.sole_guardian_children.length)
</script>

<template>
  <div class="space-y-3 text-sm">
    <!-- Refused: someone would be left with nobody to answer for them -->
    <div v-if="impact.sole_guardian_children.length" role="alert" class="space-y-2 rounded-box border border-warning/50 bg-[#fff7e6] p-3">
      <p v-if="who === 'self' && cleanup" class="font-bold">あなただけが回答できる登録があります。残す方法か、削除する方法を選んでください。</p>
      <p v-else class="flex items-center gap-2 font-bold"><TriangleAlert class="size-5 shrink-0 text-warning" />{{ them }}だけが回答できる登録があるため、{{ who === 'self' ? '脱退' : '除外' }}できません</p>
      <ul class="space-y-1">
        <li v-for="c in impact.sole_guardian_children" :key="c.player_id" class="rounded-xl bg-base-100 px-3 py-1.5">
          {{ c.name }}<span v-if="c.cancelled" class="ml-1 text-xs text-base-content/55">（取り消し済み）</span>
        </li>
      </ul>
      <template v-if="active.length">
        <p v-if="who === 'self'" class="text-base-content/75">
          先に、別の回答者を追加してください：［回答する人］で人を選び、［設定・家族招待］の［招待リンクを作成］で家族などを招待し、受け取ってもらいます。
          <NuxtLink :to="`/t/${token}/children`" class="link link-primary font-bold">回答する人を開く</NuxtLink>
        </p>
        <!-- Only true without a self registration: with one, removal stays refused (D6-B1) whatever is added. -->
        <p v-else-if="!impact.self_registrations.length" class="text-base-content/75">
          このメンバー本人に、［回答する人］の［設定・家族招待］から別の回答者（家族など）を追加してもらうと、除外できるようになります。
        </p>
        <p class="text-xs text-base-content/60">※ 登録を取り消しても、取り消し済みの登録として残るため、この状態は解消しません。</p>
      </template>
      <p v-if="cancelled.length && who === 'self' && cleanup" class="text-base-content/75">取り消し済みの登録には、現在の画面から回答者を追加できません。削除する方法を選ぶと、残っている登録と出欠も削除します。</p>
      <p v-else-if="cancelled.length" class="text-base-content/75">
        取り消し済みの登録には、いまの画面から別の回答者を追加できません。現在の画面ではこの状態を解消できないため、{{ who === 'self' ? '脱退' : '除外' }}できません。
      </p>
    </div>

    <section v-if="who === 'self' && cleanup" class="space-y-2">
      <p class="font-bold text-error">削除する方法を選んだ場合</p>
      <CleanupDeletionList :deletions="cleanup.deletions" />
      <p>上記の登録・出欠・コメント・家族招待は削除され、元に戻せません。招待は相手が受け取るまで共有にはなりません。</p>
      <p v-if="impact.self_registrations.length" class="text-xs text-base-content/60">あなた自身の本人登録は、家族が代わりに回答できる場合も削除されます。</p>
    </section>

    <div v-if="who === 'other' && impact.self_registrations.length" role="alert" class="space-y-2 rounded-box border border-warning/50 bg-[#fff7e6] p-3">
      <p class="flex items-center gap-2 font-bold"><TriangleAlert class="size-5 shrink-0 text-warning" />本人登録があるため、除外できません</p>
      <ul class="space-y-1">
        <li v-for="r in impact.self_registrations" :key="r.player_id" class="rounded-xl bg-base-100 px-3 py-1.5">本人登録「<b>{{ r.name }}</b>」と、その出欠 {{ r.answers }} 件</li>
      </ul>
      <p class="text-base-content/75">本人登録と出欠は、オーナーの判断では削除しません。代わりに「アクセス停止」を使うと、登録を残したままチームを見られなくなります。本人は自分の登録を確認して整理し、チームから抜けられます。</p>
    </div>

    <div v-if="who === 'self' && impact.self_registrations.length && !cleanup" class="space-y-1">
      <p class="flex items-center gap-1.5 font-bold text-error"><CircleX class="size-4" />削除されるもの</p>
      <ul class="space-y-1">
        <li v-for="r in impact.self_registrations" :key="r.player_id" class="rounded-xl bg-base-200/70 px-3 py-1.5">
          本人登録「<b>{{ r.name }}</b>」と、その出欠 {{ r.answers }} 件
        </li>
      </ul>
      <p class="text-xs text-base-content/60">本人登録は、代わりに回答できる家族などがいても削除されます。</p>
    </div>

    <div v-if="impact.links_removed.length" class="space-y-1">
      <p class="flex items-center gap-1.5 font-bold text-success"><CircleCheck class="size-4" />残るもの（{{ them }}は回答できなくなります）</p>
      <ul class="space-y-1">
        <li v-for="r in impact.links_removed" :key="r.player_id" class="rounded-xl bg-base-200/70 px-3 py-1.5">「<b>{{ r.name }}</b>」と、その出欠</li>
      </ul>
      <p class="text-xs text-base-content/60">ほかにも回答できる人（家族など、または本人）がいるため、登録と出欠は残ります。</p>
    </div>

    <p v-if="nothing" class="text-base-content/70">{{ them }}が回答している登録は、このチームにはありません。</p>
    <p class="text-xs text-base-content/60">{{ them }}が作成した未使用の家族招待リンクは使えなくなります。チームの予定や、ほかの人の出欠はそのまま残ります。</p>
  </div>
</template>
