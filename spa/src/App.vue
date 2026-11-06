<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ToastHost from '@/components/ToastHost.vue';

// Root component: routes are organized as either /login (no shell) or a
// layout-wrapped page. The keep-alive lives inside MainLayout (around its
// inner router-view) — that's where route components actually render.
// <ToastHost /> is mounted here (not inside the router-view) so it stays
// alive across route changes and stays reachable from the login page.
const route = useRoute();
const isAuthRoute = computed(() => route.path === '/login');
</script>

<template>
  <router-view v-if="isAuthRoute" />
  <router-view v-else />
  <ToastHost />
</template>