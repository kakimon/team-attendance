<script setup lang="ts">
// Shown on every screen (also before login). Legal pages are linked only when they are in the
// build and final (or on the dev server); otherwise only the contact form (Google Forms).
// 「使い方」 is always linked (it is a public page and part of the app).
const links = useLegalLinks()
</script>

<template>
  <footer class="space-y-1 py-6 text-center text-xs text-base-content/55">
    <nav aria-label="使い方とお問い合わせ" class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      <NuxtLink to="/help" class="underline-offset-2 hover:underline">使い方</NuxtLink>
      <span aria-hidden="true">・</span>
      <template v-for="(l, i) in links" :key="l.to">
        <span v-if="i" aria-hidden="true">・</span>
        <NuxtLink :to="l.to" class="underline-offset-2 hover:underline">{{ l.label }}</NuxtLink>
      </template>
      <a v-if="!links.length" :href="CONTACT_FORM_URL" target="_blank" rel="noopener noreferrer" class="underline-offset-2 hover:underline">お問い合わせ</a>
    </nav>
    <p>運営：{{ OPERATOR_NAME }}</p>
  </footer>
</template>
