// 功能: R235 全局看板视图模式持久化 — localStorage 'ao_global_mode' 存用户显式
//   点选过的模式; 裸链接 (#/global 不带 ?mode) 进来时优先读它, 没有再回落
//   viewport 缺省 (H5=cards / 桌面=kanban). 带 ?mode= 仍是最优先 (显式指定).
// 关注点:
//   - 只在用户显式点选 (setViewMode) 时写入, 不在渲染/回落路径写 — 避免纯访客
//     被「顺手」写入 viewport 缺省, 换设备/换窗口宽窄时被旧缓存绑架 (桌面写入
//     kanban → 手机上被挤压, 正是 R58.5 动态缺省想避免的场景).
//   - localStorage 不可用 (隐私模式/配额满/测试环境) → 静默降级, 与 theme.ts 同款.
//   - cachedMode 用 ref 而非裸变量: viewMode computed 需要把缓存当依赖 —
//     点选「等于 viewport 缺省的模式」时 URL param 会被剥掉 (query 不变),
//     没有 ref 依赖 computed 不会重算, UI 会卡在旧模式.
import { ref } from 'vue';

export type GlobalBoardMode = 'cards' | 'list' | 'grouped' | 'kanban' | 'chat' | 'category';

/** localStorage key for the persisted board mode. */
export const BOARD_MODE_STORAGE_KEY = 'ao_global_mode';

const VALID_MODES: readonly GlobalBoardMode[] = ['cards', 'list', 'grouped', 'kanban', 'chat', 'category'];

function readStored(): GlobalBoardMode | null {
  try {
    const raw = localStorage.getItem(BOARD_MODE_STORAGE_KEY);
    if (raw !== null && VALID_MODES.includes(raw as GlobalBoardMode)) {
      return raw as GlobalBoardMode;
    }
  } catch {
    /* localStorage 不可用 → 无缓存 */
  }
  return null;
}

/** 会话内响应式缓存 (初始化自 localStorage; 写盘失败仍更新内存). */
const cachedMode = ref<GlobalBoardMode | null>(readStored());

/** 读持久化模式; 用户从未显式点选过 / 值非法 / localStorage 不可用 → null. */
export function readGlobalBoardMode(): GlobalBoardMode | null {
  return cachedMode.value;
}

/** 写持久化模式 (localStorage 失败静默 — 本次会话仍生效, 刷新后丢). */
export function writeGlobalBoardMode(m: GlobalBoardMode): void {
  cachedMode.value = m;
  try {
    localStorage.setItem(BOARD_MODE_STORAGE_KEY, m);
  } catch {
    /* 静默降级 */
  }
}
