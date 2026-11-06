import { onBeforeUnmount, onMounted, ref } from 'vue';

/** R59+: ProjectSidebar 移动端浮层 (drawer) 状态 — AppHeader 汉堡按钮触发,
 * ProjectSidebar 读 state 决定 transform translateX. 单例 ref, 跨组件共享.

 * 桌面端 sidebar 固定占位 + 折叠 (R56-B14) 已有 collapsed state 走另一条
 * 路径 (持久化 nav-sidebar-collapsed); drawer 是窄屏独享, 不冲突.

 * ESC 关闭: 全局 keydown 监听, drawer 打开时按 ESC 收起 (跟 backdrop 等价).
 * 仅 mount 时挂, unmount 时摘 — composable 多处调用安全 (add/remove 自带去重). */
const drawerOpen = ref<boolean>(false);
let escListenerCount = 0;

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && drawerOpen.value) {
    drawerOpen.value = false;
  }
}

export function useSidebarDrawer(): {
  drawerOpen: typeof drawerOpen;
  toggleDrawer: () => void;
  closeDrawer: () => void;
} {
  if (escListenerCount === 0) {
    document.addEventListener('keydown', onEsc);
  }
  escListenerCount += 1;

  onBeforeUnmount(() => {
    escListenerCount -= 1;
    if (escListenerCount === 0) {
      document.removeEventListener('keydown', onEsc);
    }
  });
  // 兼容 Options API / 非 setup 调用方 — 不挂 onMounted 避免重复注册.
  void onMounted;

  return {
    drawerOpen,
    toggleDrawer: (): void => {
      drawerOpen.value = !drawerOpen.value;
    },
    closeDrawer: (): void => {
      drawerOpen.value = false;
    },
  };
}