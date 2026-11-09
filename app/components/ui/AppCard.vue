<script setup lang="ts">
// Rounded white card with optional icon + title header.
import type { Component } from 'vue'
defineProps<{ title?: string; icon?: Component; tight?: boolean }>()
</script>

<template>
  <section class="rounded-box bg-base-100 shadow-soft" :class="tight ? 'p-4' : 'p-5'">
    <header v-if="title || $slots.action" class="mb-3 flex items-center gap-2">
      <span v-if="icon" class="grid size-8 place-items-center rounded-xl bg-primary/10 text-primary">
        <component :is="icon" class="size-4.5" />
      </span>
      <h2 class="flex-1 text-base font-bold">{{ title }}</h2>
      <slot name="action" />
    </header>
    <slot />
  </section>
</template>
