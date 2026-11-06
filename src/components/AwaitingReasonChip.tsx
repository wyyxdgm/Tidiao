"use client";

// 功能: 渲染 reviewing 状态下的子终态标签 chip (v129 / R112 续). 标识当前 task
//   等待外部派发出去的子 task 完成 (设计阶段完成 → 实施派发出去 / 实施完成 → 部署派发
//   出去 / 或 AI 自定义任何「待<tag>」理由).
//
// 关注点:
//   - reason = string → 查映射表; 命中 → 用预设 label + 颜色; 未命中 → 兜底
//     「待<原值>」+ 灰 chip (damo 拍板第 3 tag 允许 AI 自主定义).
//   - 自由字符串: 不锁枚举 (db 列是 TEXT NOT NULL CHECK, 任意字符串允许写入).
//     映射表只覆盖 2 个常用 alias, 其他走兜底.
//   - 视觉与 right-dock.tsx CheckpointNode / TaskStatusChip 区分: 待实施 (蓝)
//     / 待部署 (紫) / 待<自定义> (灰). 三色不撞既有 4 色 sub-status chip (蓝紫橙红).
//     — 灰 chip 与 unknown 同色但意图不同 (灰 here = 自定义 tag).
//   - 不挂 href / onClick (chip 不是 link, 纯展示). 父组件在 awaiting_reason 非空时
//     才挂载, 组件本身再做一次 null 兜底 (双保险).
//   - 不引入新依赖: react + 内联常量映射.

interface AwaitingReasonChipProps {
  /** tasks.awaiting_reason 原值 (R112 续 v129). */
  reason: string | null | undefined;
}

interface AwaitingReasonDisplay {
  /** chip 内显示文本, 含「待」前缀 */
  label: string;
  /** Tailwind 背景色 class */
  bgClass: string;
  /** Tailwind 文字色 class */
  textClass: string;
}

// 2 个常用 alias + 兜底. 设计上只有 2 个预设, 其余走 catch-all「待<原值>」+ 灰.
// 设计取舍: 不预设太多 alias, 让 AI 自由定义 (damo R112 E/R 明确). 这里只是
// "看到 design_pending / deploy_pending 时给个更好看的颜色和直白 label", 其他值
// 不替 AI 解读 — 跟 status-display.ts 同款哲学.
const REASON_MAP: Record<string, AwaitingReasonDisplay> = {
  design_pending: {
    label: "待实施",
    bgClass: "bg-blue-100",
    textClass: "text-blue-700",
  },
  deploy_pending: {
    label: "待部署",
    bgClass: "bg-purple-100",
    textClass: "text-purple-700",
  },
};

const FALLBACK_DISPLAY: AwaitingReasonDisplay = {
  label: "",
  bgClass: "bg-gray-100",
  textClass: "text-gray-600",
};

/**
 * 把 awaiting_reason 字符串映射成 UI chip 展示对象.
 * 返回 null 表示输入为空 (UI 不渲染 chip); 返回对象则渲染对应 chip.
 * 未命中预设 alias → 兜底「待<原值>」+ 灰.
 */
function getReasonDisplay(reason: string): AwaitingReasonDisplay | null {
  const trimmed = reason.trim();
  if (!trimmed) return null;
  const preset = REASON_MAP[trimmed];
  if (preset) return preset;
  // 兜底: 「待<原值>」+ 灰. 自由字符串原样展示, 不替 AI 解读语义.
  return {
    ...FALLBACK_DISPLAY,
    label: `待${trimmed}`,
  };
}

export default function AwaitingReasonChip({ reason }: AwaitingReasonChipProps) {
  if (!reason) return null;
  const display = getReasonDisplay(reason);
  if (!display) return null;
  return (
    <span
      data-awaiting-reason={reason}
      title={`awaiting_reason: ${reason}`}
      className={`px-2 py-0.5 rounded-full text-xs ${display.bgClass} ${display.textClass}`}
    >
      {display.label}
    </span>
  );
}