<script setup lang="ts">
import { House, LogOut } from 'lucide-vue-next'
const { user, signOut } = useAuth()
const initial = computed(() => (user.value?.name || user.value?.email || '?').trim().charAt(0))
async function logout() {
  await signOut()
  await navigateTo('/')
}
</script>

<template>
  <div v-if="user" class="dropdown dropdown-end">
    <button tabindex="0" class="grid size-9 place-items-center rounded-full bg-white/20 text-sm font-bold ring-1 ring-white/30"
      :aria-label="`アカウント：${user.name || user.email || ''}`">{{ initial }}</button>
    <ul tabindex="0" class="menu dropdown-content z-30 mt-2 w-56 rounded-box bg-base-100 p-2 text-base-content shadow-soft">
      <li class="menu-title truncate">{{ user.name || user.email }}</li>
      <li><NuxtLink to="/"><House class="size-4" />チーム一覧</NuxtLink></li>
      <li><button @click="logout"><LogOut class="size-4" />ログアウト</button></li>
    </ul>
  </div>
</template>
