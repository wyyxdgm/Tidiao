"use client";

// 功能: 关联需求 status 派生 chip 元数据 + 渲染组件. 任务列表 / 看板卡片 / 全局看板
// 共享同一份配色与文案, 避免四处复制漂移.
//
// 设计要点 (R94):
//   - 仅当 task.status === "reviewing" 且 requirement_status 命中 4 个中间态之一
//     (has_suggestion / awaiting_reply / blocked) 时显示 chip. pending/done/closed 不显.
//     pending 是「未开始」无信息量; done/closed 是终态, 任务挂在 reviewing 等拍板时
//     看板上也没意义.
//   - chip 顺序: 与飞书 O 列四态视觉顺序对齐 (等回复 → 有建议 → 需拍板), 但需求 status
//     三选一, 一次只可能显示一个 chip. status 字段互斥, 不做合并.
//   - 与 awaiting_markers chip 是两套不同信号: awaiting_markers 来自 agent 的 <awaiting>
//     marker (任务自身在等什么), 本 chip 来自关联需求点的 status (上游需求在等什么).
//     R94 拍板: 两套并存, 不要互踩.
//
// 关注点:
//   - 不引入新依赖, 仅用 tailwind class + 纯函数. tests/board-client/kanban-view/
//     global-board/chat-task-list 都用这个, 颜色硬编码在 META 表里.
import type { TaskTrimmed, RequirementStatus, TaskStatus } from "./types";

// REVIEWING_ONLY: 与 R94 文本一致 — 只在 reviewing 状态下显示. 若以后扩展到其他状态,
//   把这个常量拆成可配置即可 (与 awaiting_markers chip 一致, 那是任何 status 都显示).
export const REVIEWING_STATUS: TaskStatus = "reviewing";

// 飞书 O 列四态子集 (含 needs_response 和 needs_decision) — 中文文案 + 配色与
// R84 awaiting markers chip 同源风格 (cyan/emerald/red/amber), 方便用户一眼区分.
export interface RequirementChipMeta {
  label: string;
  color: string;
  title: string;
}

const META: Record<string, RequirementChipMeta> = {
  awaiting_reply: {
    label: "等回复",
    color: "bg-cyan-100 text-cyan-800 border-cyan-200",
    title: "关联需求状态: 等回复 (飞书 O=等回复)",
  },
  has_suggestion: {
    label: "有建议",
    color: "bg-emerald-100 text-emerald-800 border-emerald-200",
    title: "关联需求状态: 有建议 (飞书 O=有建议)",
  },
  blocked: {
    label: "需拍板",
    color: "bg-amber-100 text-amber-800 border-amber-200",
    title: "关联需求状态: 需派发人/伙伴拍板 (飞书 O=卡住)",
  },
};

// 导出的可枚举状态集, 测试 / UI 校验都用它. 故意只暴露这三个 — 其他 status
// (pending/done/closed) 不在 chip 范围内, 暴露会鼓励误用.
export const VISIBLE_REQUIREMENT_STATUSES: RequirementStatus[] = [
  "awaiting_reply",
  "has_suggestion",
  "blocked",
];

// 纯函数: 给定 TaskTrimmed, 决定是否显示 chip + meta. 不读 React state, 方便单测
// 覆盖三入口 (chat-list/kanban/card/global-card). 测试只校验这个函数即可保证
// 三处 UI 渲染口径一致.
export function getRequirementChipMeta(
  task: Pick<TaskTrimmed, "status" | "requirement_status">,
): RequirementChipMeta | null {
  if (task.status !== REVIEWING_STATUS) return null;
  const rs = task.requirement_status;
  if (!rs) return null;
  return META[rs] ?? null;
}

// 共用渲染组件. className 让调用方微调 (chat-task-list 用紧凑尺寸, 看板卡片用完整 padding).
export function RequirementStatusChip({
  task,
  size = "md",
}: {
  task: Pick<TaskTrimmed, "status" | "requirement_status">;
  size?: "sm" | "md";
}) {
  const meta = getRequirementChipMeta(task);
  if (!meta) return null;
  const sizeClass = size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-0.5 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full border ${sizeClass} ${meta.color}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
}
