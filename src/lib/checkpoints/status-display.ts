// Checkpoint status → 渲染展示(R108 T2).
//
// 功能: 把 agent 在 <checkpoint status="..."/> 里写的字符串映射成 UI chip
//   颜色 + 中文标签. UI 调用方拿到 null → 不渲染 chip; 拿到对象 → 渲染.
//   4 个中文 + 4 个英文 alias 共存 (e.g. "等回复" 和 "waiting" 同色),
//   其他 status 走 unknown (灰色).
//
// 关注点:
//   - 输入归一化: trim + toLowerCase. 大小写不敏感 ("WAITING" = "waiting").
//   - 严格别名表: 8 个值命中其一 → 对应 tone; 其他 → unknown (gray).
//     T1 测试用过的 "waiting_reply" / "has_suggestion" 落入 unknown —
//     这是有意为之: 任务 R108 描述明确写 4 个状态别名, 没在范围内的
//     一律视作 agent 自由文本, UI 不替它解读.
//   - 不依赖 React/DOM: 纯函数模块便于 vitest 独立测, 也便于其他视图
//     (board / kanban / global board / checkpoint 面板) 复用.

export type CheckpointStatusTone =
  | "waiting" // 等回复 — 蓝色
  | "suggestion" // 有建议 — 紫色
  | "decision" // 需拍板 — 橙色
  | "blocked" // 卡住 — 红色
  | "unknown"; // 其他 — 灰色

export interface CheckpointStatusDisplay {
  /** tone 名, 与四态之一对应; unknown 兜底其他值 */
  tone: CheckpointStatusTone;
  /** chip 内显示的短文本 (中文 2-3 字) */
  label: string;
  /** Tailwind 背景色 class */
  bgClass: string;
  /** Tailwind 文字色 class */
  textClass: string;
}

const STATUS_MAP: Record<string, CheckpointStatusDisplay> = {
  // 中文中文
  等回复: {
    tone: "waiting",
    label: "等回复",
    bgClass: "bg-blue-100",
    textClass: "text-blue-700",
  },
  有建议: {
    tone: "suggestion",
    label: "有建议",
    bgClass: "bg-purple-100",
    textClass: "text-purple-700",
  },
  需拍板: {
    tone: "decision",
    label: "需拍板",
    bgClass: "bg-orange-100",
    textClass: "text-orange-700",
  },
  卡住: {
    tone: "blocked",
    label: "卡住",
    bgClass: "bg-red-100",
    textClass: "text-red-700",
  },
  // 英文 alias (lowercase 归一化后查)
  waiting: {
    tone: "waiting",
    label: "等回复",
    bgClass: "bg-blue-100",
    textClass: "text-blue-700",
  },
  suggestion: {
    tone: "suggestion",
    label: "有建议",
    bgClass: "bg-purple-100",
    textClass: "text-purple-700",
  },
  decision: {
    tone: "decision",
    label: "需拍板",
    bgClass: "bg-orange-100",
    textClass: "text-orange-700",
  },
  blocked: {
    tone: "blocked",
    label: "卡住",
    bgClass: "bg-red-100",
    textClass: "text-red-700",
  },
  // 自然措辞 alias (damo 1007): 模型常写「待拍板」「请选择」而非「需拍板」,
  // 不收进表会落 unknown 灰 chip — 同 decision 档直通.
  待拍板: {
    tone: "decision",
    label: "需拍板",
    bgClass: "bg-orange-100",
    textClass: "text-orange-700",
  },
  请选择: {
    tone: "decision",
    label: "请选择",
    bgClass: "bg-orange-100",
    textClass: "text-orange-700",
  },
};

const UNKNOWN_DISPLAY: CheckpointStatusDisplay = {
  tone: "unknown",
  label: "unknown",
  bgClass: "bg-gray-100",
  textClass: "text-gray-600",
};

/**
 * 把 checkpoint.status 字符串转成 UI chip 渲染所需的展示对象.
 *
 * 返回 null 表示输入为空(UI 不渲染 chip);
 * 返回 unknown tone 的对象表示 status 有值但不在 8 个别名内(UI 渲染灰 chip).
 */
export function getStatusDisplay(
  status: string | null | undefined,
): CheckpointStatusDisplay | null {
  if (status == null) return null;
  const trimmed = status.trim();
  if (trimmed.length === 0) return null;
  const key = trimmed.toLowerCase();
  return STATUS_MAP[key] ?? UNKNOWN_DISPLAY;
}
