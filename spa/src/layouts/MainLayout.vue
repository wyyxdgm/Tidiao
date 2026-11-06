<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '@/components/AppHeader.vue';
import ProjectSidebar from '@/components/ProjectSidebar.vue';
import TagsView from '@/components/TagsView.vue';
import { useTagsStore } from '@/stores/tags';
import { useCloseTab } from '@/composables/useCloseTab';

const tags = useTagsStore();
const route = useRoute();

const cachedNames = computed(() => tags.cachedNames);

// Ctrl/Cmd+W 关当前激活 tab. 全局挂 (mount 时挂 / unmount 时摘), 登录页
// 走的不是 MainLayout 所以不受影响. 必须 preventDefault 否则浏览器会顺
// 手关窗口. 排除 Shift/Alt 避免误碰 Ctrl+Shift+W (chrome reopen closed tab)
// 之类组合键. useCloseTab 内部会跳过 pinned tab + modal-backdrop.
const { closeActive } = useCloseTab();

function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    closeActive();
  }
}

onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="main-layout">
    <AppHeader />
    <div class="main-body">
      <ProjectSidebar />
      <div class="main-content">
        <TagsView />
        <div class="content-area">
          <router-view v-slot="{ Component, route: viewRoute }">
            <keep-alive :include="cachedNames">
              <component :is="Component" :key="viewRoute.path" />
            </keep-alive>
          </router-view>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  display: flex;
  flex-direction: column;
  /* 100vh 是 "largest possible viewport" (含地址栏, iOS Safari 地址栏缩进时
     不更新), 100dvh 是 "dynamic viewport" (Safari 15.4+ 跟地址栏缩进实时
     更新). 用 100dvh 让 sidebar 底部 AccountSwitcher 等 fixed 区不被地址栏
     遮住 — 用户反馈「左下角邮箱掉一半到页面底下」 (iOS Safari 早期版本
     bottom: 0 实际位置在地址栏下面, 视觉上被地址栏挡). fallback 100vh
     兜旧浏览器 (Safari <15.4 / Android Chrome 早期版本不识别 dvh). */
  height: 100vh;
  height: 100dvh;
}
.main-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.content-area {
  flex: 1;
  overflow: auto;
  background: var(--color-bg);
}
</style>