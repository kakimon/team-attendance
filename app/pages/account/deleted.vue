<script setup lang="ts">
// Shown after the account was deleted (public page: the user is signed out by now).
import { CircleCheck } from 'lucide-vue-next'
</script>

<template>
  <div>
    <AppHeader title="退会しました" subtitle="みんなの出欠" hide-account />
    <main class="mx-auto max-w-md space-y-4 px-4 py-8">
      <EmptyState :icon="CircleCheck" title="退会が完了しました"
        text="アカウントと、あなたのデータを削除しました。ご利用ありがとうございました。">
        <NuxtLink to="/" class="btn btn-brand">トップへ</NuxtLink>
      </EmptyState>
      <p class="text-center text-xs text-base-content/55">
        ほかの保護者がいるお子さんの情報と出欠、チームの予定は、チームに残っています。<br>
        また使うときは、もう一度 Google でログインしてください（新しいアカウントになります）。
      </p>
      <LegalFooter />
    </main>
  </div>
</template>
