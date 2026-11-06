// 功能: R248 看板状态分组（活跃/历史/全部）持久化记忆 — 用户显式点选过的组存
//   localStorage[key]; 裸链接 (URL 不带 ?statusGroup=) 进来时优先读它, 从未点选
//   过回落缺省 'all' (damo: 默认全部). 带 ?statusGroup= 仍是最优先 (显式指定,
//   如从详情页跳回恢复).
// 关注点:
//   - 只在用户显式点选 (setStatusGroup / toggleStatus 恰好回到某组全集) 时写入,
//     不在渲染/回落路径写 — 避免纯访客被「顺手」写入缺省值, 换设备被旧记忆绑架
//     (board-mode.ts R235 同款纪律).
//   - localStorage 不可用 (隐私模式/配额满/测试环境) → 静默降级, 会话内仍靠缓存
//     ref 生效, 刷新后丢.
//   - 缓存按 key 区分 (BoardPage 走 syncLevel 三级 key, GlobalBoard 两档 key),
//     用 ref 包一层: 调用方的 statusGroup computed 需要把缓存当依赖 — 点选「等于
//     当前记忆」的组时 URL param 会被剥掉 (query 不变), 没有 ref 依赖 computed
//     不会重算, UI 会卡在旧组 (board-mode.ts 注释里的同款坑).
//   - key 变化 (syncLevel 切换 / 跨 version scope) → computed 重算时读新 key 的
//     记忆, 各 scope 各自记忆.
import { ref } from 'vue';

export type BoardStatusGroup = 'active' | 'terminal' | 'all';

const VALID_GROUPS: readonly BoardStatusGroup[] = ['active', 'terminal', 'all'];

function readFromStorage(key: string): BoardStatusGroup | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null && VALID_GROUPS.includes(raw as BoardStatusGroup)) {
      return raw as BoardStatusGroup;
    }
  } catch {
    /* localStorage 不可用 → 无记忆 */
  }
  return null;
}

/** 会话内缓存 (按 key 区分; 写盘失败仍更新内存).
 *  🔴 响应式纪律: cache 本体必须是**非响应式**普通变量 —— 读路径 (readBoardStatusGroup)
 *  在各看板 statusGroup computed 里调用 (渲染期间), 若 miss 时写响应式 ref, 两个
 *  看板 (GlobalBoard 全局 key / BoardPage 版本 key) 交替 miss 会交替写同一 ref,
 *  互相把对方的 update job 踢回队列 → 「Maximum recursive updates」: dev 报错中断,
 *  prod 无递归保护 = 渲染进程死循环 CPU 100% 页面僵死 (2026-10-31 实证, 从别的
 *  tab 切进版本页秒卡死).
 *  响应式语义改由 version ref 承担: 仅 writeBoardStatusGroup 时 bump —— 保住
 *  「点选等于当前记忆的组 → URL param 被剥掉 → 靠 ref 依赖触发重算」的原语义. */
let cached = { key: '', val: null as BoardStatusGroup | null };
const version = ref(0);

/** 读持久化分组; 该 key 从未写入 / 值非法 / localStorage 不可用 → null.
 *  渲染期间调用安全: 只读 version (track 依赖) + 纯内存 cache, 绝不写响应式. */
export function readBoardStatusGroup(key: string): BoardStatusGroup | null {
  version.value; // track: writeBoardStatusGroup bump 后依赖它的 computed 重算
  if (cached.key === key) return cached.val;
  cached = { key, val: readFromStorage(key) };
  return cached.val;
}

/** 写持久化分组 (localStorage 失败静默 — 本次会话仍生效, 刷新后丢). */
export function writeBoardStatusGroup(key: string, g: BoardStatusGroup): void {
  cached = { key, val: g };
  version.value++; // 触发依赖 readBoardStatusGroup 的 computed 重算
  try {
    localStorage.setItem(key, g);
  } catch {
    /* 静默降级 */
  }
}
