<script setup lang="ts">
// アカウント: who am I, owner hand-over requests, and the way to delete the account.
import { ChevronRight, CircleUserRound, ExternalLink, Mail, UserX } from 'lucide-vue-next'
const { user } = useAuth()
const privacyMail = `mailto:${PRIVACY_EMAIL}?subject=${encodeURIComponent('【みんなの出欠】個人情報に関するご請求')}`
</script>

<template>
  <div>
    <AppHeader title="アカウント" subtitle="みんなの出欠" back="/" />
    <main class="mx-auto max-w-md space-y-4 px-4 py-5">
      <AppCard title="ログイン中のアカウント" :icon="CircleUserRound">
        <p class="font-bold">{{ user?.name || '（名前なし）' }}</p>
        <p v-if="user?.email" class="break-all text-sm text-base-content/60">{{ user.email }}</p>
        <p class="mt-2 text-xs text-base-content/50">メールアドレスは、ほかのメンバーには表示されません。</p>
      </AppCard>

      <OwnerTransferInbox />

      <NuxtLink to="/account/delete"
        class="flex items-center gap-3 rounded-box bg-base-100 p-4 shadow-soft transition active:scale-[0.99]">
        <span class="grid size-10 shrink-0 place-items-center rounded-2xl bg-error/10 text-error"><UserX class="size-5" /></span>
        <div class="min-w-0 flex-1">
          <p class="font-bold">アカウントを削除（退会）</p>
          <p class="text-xs text-base-content/60">削除される内容を確認してから手続きできます</p>
        </div>
        <ChevronRight class="size-5 text-base-content/35" />
      </NuxtLink>

      <AppCard title="お問い合わせ" :icon="Mail" tight>
        <p class="text-sm text-base-content/75">退会はこの画面からご自身でできます（運営者への連絡は不要です）。</p>
        <a :href="CONTACT_FORM_URL" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm mt-3 w-full border-base-300">
          <ExternalLink class="size-4" />ご質問・不具合（お問い合わせフォーム）
        </a>
        <p class="mt-3 text-xs text-base-content/65">
          個人情報の開示・訂正・利用停止などのご請求：
          <a :href="privacyMail" class="link break-all">{{ PRIVACY_EMAIL }}</a>
        </p>
      </AppCard>
      <LegalFooter />
    </main>
  </div>
</template>
