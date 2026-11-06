import { onScopeDispose, ref, type Ref } from 'vue';

/** 功能: 响应式 media query — 返回随 viewport 变化实时更新的 boolean ref.
    关注点: window.matchMedia 本身非响应式 (computed 拿它当依赖永远不重算,
    R236 面板宽度 bug 根因), 这里挂 change 监听并在 scope 销毁时摘除;
    SSR / 无 window 环境恒 false. */
export function useMediaQuery(query: string): Ref<boolean> {
  const mql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  const matches = ref<boolean>(mql?.matches ?? false);
  if (mql) {
    const onChange = (e: MediaQueryListEvent): void => {
      matches.value = e.matches;
    };
    mql.addEventListener('change', onChange);
    onScopeDispose(() => mql.removeEventListener('change', onChange));
  }
  return matches;
}
