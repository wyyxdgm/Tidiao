"use client";

// 功能: 渲染 4 色 sub-status chip (等回复/有建议/需拍板/卡住/未知) 标识任务当前
//   最新 checkpoint 子状态. props 接 status 字符串, 内部调 getStatusDisplay() 拿
//   tone + label + 颜色 class. status=null/空 → 组件返回 null 不渲染 (父级可省
//   条件挂载, 也可让组件自行短路).
//
// 关注点:
//   - 视觉与 right-dock.tsx CheckpointNode 已有 status chip 保持一致 (4 色 bgClass
//     + textClass 由 status-display.ts 提供, 共享颜色常量 = 任务卡片与详情面板
//     同色, 用户不会认错).
//   - 4 视图 (board / kanban / global board / requirements) 父组件统一挂载, 组件
//     自身不做"渲染前先拿 status-display" 的额外判断 — 拿不到就 null, 不静默吞错.
//   - 不挂 onClick / href (不是 link, 纯展示). 父组件若把 chip 嵌在 <Link> 内
//     不需要 stopPropagation — chip 本身不响应点击.
//   - 不引入新依赖: react + status-display.ts 已存在, 不动 DB / API / Tailwind 配置.

import { getStatusDisplay } from "@/lib/checkpoints/status-display";

interface TaskStatusChipProps {
  /** 最新 checkpoint 的 status 字符串 (原始值, 由 listTasksPage latest_checkpoint_status 字段带回). */
  status: string | null | undefined;
}

export default function TaskStatusChip({ status }: TaskStatusChipProps) {
  const display = getStatusDisplay(status);
  if (!display) return null;
  return (
    <span
      data-status-tone={display.tone}
      title={`sub-status: ${status}`}
      className={`px-2 py-0.5 rounded-full text-xs ${display.bgClass} ${display.textClass}`}
    >
      {display.label}
    </span>
  );
}