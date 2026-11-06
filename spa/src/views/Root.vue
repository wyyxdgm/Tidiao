<script setup lang="ts">
// 功能: 根路径入口 — 已登录跳 /global, 未登录跳 /login.
// 关注点: 这是 SPA 启动后的第一个页面 (用户访问根 URL 或刷新非 login 路径).
//   router 的 beforeEach 已经做完 auth gate, 这里只需按 session 状态分流.
//   为了避免「跳一跳」可见, 用 v-if 渲染一个 Loading 占位, 配合 replace
//   立刻跳走 —— 不留中间帧.
//
// 与 Next.js master src/app/page.tsx (ProjectsClient, 1795 行) 的分歧:
//   1) Next.js `/` 实际渲染项目列表 (ProjectsClient), 没有任何 redirect 逻辑.
//      sheet R2 字面 = "已登录跳 /global", 与 master 实际行为有出入. 走 sheet
//      字面 = 把 Root 当 redirect 壳 (本组件当前实现); 完整镜像 ProjectsClient
//      是数天级工作量, 远超 R2 红线 (sheet 红线 ≤ 30min/组件), 后续 task 单独排期
//      (披露在 vue-spa-migration.md §6 进度表).
//   2) R5 全局看板路由上线后 (/global), Root 入口改回跳 /global (sheet 字面).
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

onMounted(async () => {
  // router beforeEach 已处理 unknown -> checkSession, 但 Root 是入口,
  // 极端情况 (首次访问 / + checkSession 还没跑) 还是兜一次.
  if (auth.sessionState === 'unknown') {
    await auth.checkSession();
  }
  // R5: /global 路由上线, 入口跳全局看板 (sheet 字面).
  const target = auth.sessionState === 'yes' ? '/global' : '/login';
  router.replace(target);
});
</script>

<template>
  <!-- 占位: 在 redirect 完成前不显示空页面闪烁 -->
  <div class="root-loading">
    <span class="root-loading-text">{{ t('misc.root.loading') }}</span>
  </div>
</template>

<style scoped>
.root-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 占满视口避免 redirect 到 /global 后从 60vh 跳到 100vh 的 layout shift.
     之前 60vh 让初次加载 body 只占半屏, 用户感觉「body 只有一半」. */
  min-height: 100vh;
}
.root-loading-text {
  color: var(--color-text-muted, #6b7280);
  font-size: 14px;
}
</style>
