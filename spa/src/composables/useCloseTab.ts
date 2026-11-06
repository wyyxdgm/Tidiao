/** R123 后续 (v2.0-spa): Ctrl/Cmd+W 关当前激活 tab.
 *
 * 单独抽 composable 而不是复用 TagsView.onClose 是因为后者用了组件本地的
 * context menu / Modal 状态, 在 MainLayout 全局 listener 里调不到. 这里是
 * 键盘快捷键专用入口, 重复 ~8 行比抽公共抽象更省事 (Karpathy §2).
 *
 * 关注点:
 *  - 必须 preventDefault 否则浏览器会顺手关窗口.
 *  - pinned tab (closable=false) 静默 no-op.
 *  - 任一 modal-backdrop 存在时 (rename / ConfirmDialog 等) 跳过 — 让
 *    弹窗自己处理 ESC. */
import { useRoute, useRouter } from 'vue-router';
import { useTagsStore } from '@/stores/tags';

export function useCloseTab() {
  const tags = useTagsStore();
  const router = useRouter();
  const route = useRoute();

  function closeActive(): void {
    const active = tags.visited.find((t) => t.path === route.path);
    if (!active || active.closable === false) return;
    if (document.querySelector('.modal-backdrop')) return;

    const idx = tags.visited.findIndex((t) => t.path === route.path);
    tags.close(route.path);
    const next = tags.visited[idx - 1] || tags.visited[idx] || tags.visited[0];
    if (next) {
      const query = next.query && Object.keys(next.query).length > 0 ? next.query : undefined;
      void router.push({ path: next.path, query });
    } else {
      void router.push('/');
    }
  }

  return { closeActive };
}