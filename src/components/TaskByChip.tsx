"use client";

// 功能: 渲染 [by]<短id> chip, 标识本任务由哪个父任务派发 (dispatched_by_task_id).
//   短 id 走 task.id.slice(0,8) 同款现有约定 (schedules-client.tsx:166 等).
//   点击跳父 task — 父级若有 <Link href=/tasks/{id}>, 必须 stopPropagation 才能
//   正确跳父任务 (否则冒泡到外层 Link 会跳自己).
//
// 关注点:
//   - 父组件必须在 task.dispatched_by_task_id 非空时才挂载本组件, 本组件不
//     做空值短路 (避免组件拿不到真实数据时静默丢 UI).
//   - 视觉与原 board-client.tsx 834 行内联 Link 同款: slate chip (border +
//     text-xs + rounded-full), 不替换避免视觉漂移.
//   - 用 <span> + useRouter().push() 而非 <Link>: 外层 task card 已经是
//     <Link href=/tasks/{self.id}>, 再套 <a> 会触发 React hydration error
//     "In HTML, <a> cannot be a descendant of <a>". trade-off: 失去右键
//     "在新标签打开" — chip 是次级操作, 主操作仍是点整张卡片, 影响小.
//   - a11y 兜底: role="link" + tabIndex + Enter/Space keydown, 让键盘用户
//     也能跳父 task (不靠外层 Link 因为我们 stopPropagation 了).

import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent } from "react";

interface TaskByChipProps {
  dispatchedByTaskId: string;
}

export default function TaskByChip({ dispatchedByTaskId }: TaskByChipProps) {
  const router = useRouter();
  const shortId = dispatchedByTaskId.slice(0, 8);
  const target = `/tasks/${dispatchedByTaskId}`;

  function go(e: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>) {
    e.stopPropagation();
    e.preventDefault();
    router.push(target);
  }

  return (
    <span
      role="link"
      tabIndex={0}
      data-href={target}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          go(e);
        }
      }}
      className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 hover:text-slate-900 cursor-pointer"
      title={`派发自 ${dispatchedByTaskId} (短id 复制可搜)`}
    >
      [by]{shortId}
    </span>
  );
}