// 功能: 结构性断言 —— 两个看板 (版本级 board-client.tsx + 全局 global-board.tsx) 的
// 拖拽 optimistic update 必须共用 computeTaskMove 纯函数, 不许各写一份。
//
// 关注点:
//   - R54 第一轮只修了 board-client.tsx, global-board.tsx 里同一份错逻辑仍在 →
//     /global 看板拖 queued→running 仍消失。本测试就是防这种「修一半」复发。
//   - 扫源码文本而非跑组件: 两个看板是重型 client component (SSE / 虚拟列表 /
//     localStorage), 起 jsdom 渲染成本远高于收益; 行为正确性由
//     board-task-move.test.ts (8 条) 保证, 这里只保证「两边都走那个函数」。
//   - canary = 旧实现独有的 `const newIsTerminal =` 行。它一旦回归, 说明有人把
//     无条件 setActiveTasks(filter) 的老写法抄回来了。

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const BOARDS = [
  "src/app/[projectId]/[versionId]/board-client.tsx",
  "src/app/global/global-board.tsx",
];

function readBoard(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("board optimistic move parity (R54)", () => {
  it.each(BOARDS)("%s 走 computeTaskMove 纯函数", (rel) => {
    const src = readBoard(rel);
    expect(src).toContain("computeTaskMove");
    // 必须传 ref.current (不是闭包里的 stale state 数组).
    expect(src).toMatch(/computeTaskMove\(\s*activeTasksRef\.current,\s*terminalTasksRef\.current,/);
  });

  it.each(BOARDS)("%s 不含旧的无条件删除实现", (rel) => {
    const src = readBoard(rel);
    // 旧 runAction 独有标记: 先算 newIsTerminal, 再无条件从 active 删。
    expect(src).not.toContain("const newIsTerminal =");
    expect(src).not.toContain("setActiveTasks(prev => prev.filter(t => t.id !== taskId))");
  });

  it.each(BOARDS)("%s runAction 内含 start→queued warning toast", (rel) => {
    // R54 N 列 damo 回复「可以toast,好看的,别alert」: 拖到「运行中」若并发已满,
    // 后端真返 queued → 起 warning toast 提示。仅 start action 触发。
    const src = readBoard(rel);
    expect(src).toMatch(/action === "start" && data\.status === "queued"/);
    expect(src).toMatch(/toastWarning\(/);
    // 强制不许用 alert (damo 原话:「别alert」).
    expect(src).not.toMatch(/^\s*alert\(/m);
  });
});
