<script setup lang="ts">
// 功能: 顶部 header — 品牌 + 用户区.
// 用户区挂 AccountSwitcher (G1): 头像按钮 + dropdown (当前账号 / 切换账号 / 退出).
// 旧版平铺 username + role chip + 登出按钮被替换, 避免重复 UI.
// R59+: ≤1023px 在 brand 左侧加汉堡按钮, 触发 ProjectSidebar drawer (浮层).
//   drawer 打开时汉堡变 × (toggleDrawer 已存在, 加图标切换给关闭入口视觉提示).
//   AppHeader 改 sticky + z-index 70 (sidebar=60 之上), 保证 hamburger 永远可点,
//   不被 sidebar/backdrop 覆盖.
import { onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useSidebarDrawer } from '@/composables/useSidebarDrawer';
import AccountSwitcher from '@/components/AccountSwitcher.vue';
import BackendBreathDot from '@/components/BackendBreathDot.vue';
import HostGaugeRing from '@/components/HostGaugeRing.vue';
import TaskSearchBox from '@/components/TaskSearchBox.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import LangToggle from '@/components/LangToggle.vue';
import {
  acquireTaskResourcesPolling,
  releaseTaskResourcesPolling,
  hostResourceSummary,
} from '@/composables/useTaskResources';

const auth = useAuthStore();
const { t } = useI18n();
const { drawerOpen, toggleDrawer } = useSidebarDrawer();

// R232 Round5 (damo「搜索框左侧就是看不到」): 系统资源小块挂顶栏搜索框左侧 —
// 顶栏全页面常驻, 才是 damo 说的「总是加到页面最上方」; 此前挂看板 filter 行
// damo 找不到. 非管理员 hostResourceSummary 恒 null → v-if 不渲染.
// AppHeader 不在 keep-alive, mounted/unmounted 配对 acquire/release 即可
// (BoardPage 等页面的 badge 共享同一份单例数据, refCount 叠加无冲突).
onMounted(() => acquireTaskResourcesPolling());
onBeforeUnmount(() => releaseTaskResourcesPolling());
</script>

<template>
  <header class="app-header">
    <!-- R59+: 移动端汉堡按钮 (≤1023px). 点开 trigger ProjectSidebar 浮层.
         drawer 打开时图标变 × (close affordance, 跟 backdrop 双重保险).
         用户反馈「面板 icon 已经被挡住」: hamburger z-index 必须 > sidebar (60)
         才能点. AppHeader 自身 z=70 (sidebar 60 + 1) 兜底. -->
    <button
      type="button"
      class="sidebar-toggle"
      :title="drawerOpen ? t('header.closeNav') : t('header.openNav')"
      :aria-label="drawerOpen ? t('header.closeNav') : t('header.openNav')"
      :aria-expanded="drawerOpen"
      @click="toggleDrawer"
    >
      <svg v-if="!drawerOpen" viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true">
        <path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
      </svg>
      <svg v-else viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true">
        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
      </svg>
    </button>
    <div class="brand">
      <!-- H5 (≤1023px) 文字换 logo 方块 (damo 1011): 省 ~110px 给单环/账号;
           桌面文字不变. -->
      <span class="brand-logo" aria-hidden="true">AO</span>
      <span class="brand-text">{{ t('header.brand') }} <span class="brand-tag">SPA</span></span>
    </div>
    <!-- R185 迭代: 后台状态呼吸点挂标题旁 (damo 10-05: 原视口右缘中间位置错, 应在左上角标题边).
         登录页不经过 MainLayout (AppHeader 唯一引用方) 天然不显示. -->
    <BackendBreathDot />
    <div class="spacer"></div>
    <!-- R235: 主机状态圈 (单环/四环可切, popover 底部切换) — 搜索框左侧.
         非管理员 hostResourceSummary 恒 null → 不渲染.
         R235 追加 (damo 1011): 原 SystemResourceBars 两条资源条移除, 顶栏
         只留本组件; 「哪个任务占哪段」细分信息随条移除 (damo 拍板). -->
    <HostGaugeRing
      v-if="hostResourceSummary"
      :host="hostResourceSummary"
    />
    <!-- 飞书 R180: 顶栏全局任务搜索 — 用户区 (邮箱/头像) 左侧. -->
    <TaskSearchBox v-if="auth.user" />
    <!-- R206: 主题切换 (浅色/深色/随系统) — 用户区左侧, 未登录也显示. -->
    <ThemeToggle />
    <!-- i18n W1: 语言切换 (zh-CN/en-US) — 主题切换右侧. -->
    <LangToggle />
    <div v-if="auth.user" class="user">
      <span class="user-name">{{ auth.user.name || auth.user.email }}</span>
      <span class="user-role">{{ auth.user.role }}</span>
      <AccountSwitcher />
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  /* R59+: ≤1023px sticky + z-index:70 (sidebar=60 + backdrop=55 之上)
     — 确保 hamburger 永远可点, 不被 drawer 覆盖. 桌面端 z=auto, 不影响. */
  position: sticky;
  top: 0;
  z-index: 70;
}
.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  /* R59+: nowrap + 允许 flex shrink + min-width:0 让 brand 在窄屏 (≤1023px)
     可压缩不折行 (原 "Agent Orchestrator" 长文字会断三行, 用户原话;
     品牌切提调后文字变短, 机制保留兜底). H5 起文字整体换 logo 方块,
     ellipsis 留给极端窄屏的兜底. */
  flex-shrink: 1;
  min-width: 0;
}
.brand-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* H5 logo 方块: 24px AO monogram (damo 1011), 桌面隐藏文字照旧. */
.brand-logo {
  display: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--color-primary);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.brand-tag {
  margin-left: 4px;
  font-size: 10px;
  padding: 2px 6px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 8px;
  vertical-align: middle;
  /* R59+: H5 默认藏, 释放 ~35px 给 brand 文字不被切. SPA 标签是开发态标识,
     不必每次看到. 桌面端 ≥1024px 恢复显示. */
  flex-shrink: 0;
}
.spacer {
  flex: 1;
}
.user {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.user-name {
  font-size: 13px;
  /* R59+: nowrap + ellipsis 兜底 — H5 窄屏 AccountSwitcher 抢位时名字优雅截断,
     不撑破 header 布局. 桌面端宽度充裕, 不显式限宽. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.user-role {
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--tw-gray-100);
  padding: 2px 6px;
  border-radius: 8px;
  /* R59+: H5 默认藏, 释放 ~30px. 角色 chip 不是关键信息, drawer 头部也能看到. */
  flex-shrink: 0;
}

@media (max-width: 1023px) {
  /* R59+: H5 释放宽度 — tag 是开发态标识, role chip 用户也能从 drawer 入口看到.
     damo 1011: brand 文字换 logo 方块 (顶部主机圈上 H5 后顶栏更紧). */
  .brand-tag,
  .user-role {
    display: none;
  }
  .brand-text {
    display: none;
  }
  .brand-logo {
    display: flex;
  }
  .user-name {
    max-width: 80px;
  }
}

/* 手机窄档 (≤480px) 再藏 user-name — 账号名在 AccountSwitcher dropdown 里可见
   (与 user-role 藏法同构). 背景: 414px 视口时顶栏固定元素合计 ~394px > 可用
   386px, spacer 压成 0 → 左侧呼吸点贴死四环, 呼吸 halo (放大溢出 ~4px) 与
   负载环视觉重叠. 藏掉 ~80px 后 spacer 恢复 ~70px, 呼吸点与四环分开;
   375/360px 同受益, ≤350px 已由 HostGaugeRing 窄屏替身 (单环) 兜底. */
@media (max-width: 480px) {
  .user-name {
    display: none;
  }
}

/* R59+: 汉堡按钮 — 桌面隐藏 (≥1024px), 移动端显示触发 sidebar drawer. */
.sidebar-toggle {
  display: none;
  border: 0;
  background: transparent;
  padding: 6px;
  margin: 0 -4px 0 0;
  cursor: pointer;
  color: var(--color-text-muted);
  border-radius: var(--radius, 6px);
  transition: background 0.12s, color 0.12s;
}
.sidebar-toggle:hover {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text);
}
@media (max-width: 1023px) {
  .sidebar-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}
</style>