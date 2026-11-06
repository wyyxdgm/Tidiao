// Goal-driven loop 阶段 3 (D20, damo 2026-09-14 拍板) — 漏洞 #5 缓解:
//   API 层 (POST /api/tasks + /api/tasks/[id]/fork + /api/tasks/[id]/fork-at-checkpoint)
//   共享 helper: 检测 prompt 是否含 <goal>...</goal> marker + 校验 autoApprove=true.
//
// 设计点 (见 docs/plans/goal-loop.md §9.5 漏洞 #5 + §4.1 不变量):
//   - regex 与 active-session.GOAL_MARKER_RE 保持一致 (首匹配非贪婪), 避免
//     解析口径漂移 → API 放过但 active-session 拒, 或反之.
//   - 行为契约: prompt 含 marker + autoApprove != true → 返 null (caller 翻 400).
//     不命中 marker → 返 null (caller 放行, 原行为).
//     命中 marker + autoApprove === true → 返 "ok" (caller 放行).
//   - 漏洞 #8 (P0, 阶段 4 解决) 留口: fork 出来的 task 如果新 prompt 没
//     goal marker, 不强制. 本 helper 走 prompt 自检, 不读 parent task.
//
// 关注点:
//   - 复用 regex 字面量, 改一处 = 改三处 (active-session + 三个 API route).
//     若改 marker 语法, 改 4 处同步.
//   - 不读 DB 不写 DB, 纯函数, 易测.

const GOAL_MARKER_RE = /<goal>([\s\S]*?)<\/goal>/;

export type GoalMarkerCheckResult =
  | { ok: true }
  | { ok: false; code: "GOAL_REQUIRES_AUTO_APPROVE"; reason: string };

// 功能: 检测 prompt 含 <goal> marker 时, 校验 autoApprove=true. 不含 marker
//   时永远返回 { ok: true } (caller 放行原行为).
// 关注点:
//   - 留 fast path: prompt 不命中 regex → 不校验 autoApprove, 直接 ok. 大多数
//     task 不是 goal task, 这条 fast path 命中 99%+.
//   - autoApprove 字段语义: true = 自动审批, false = 走人工审批. goal loop
//     pushMessage 注入到非 autoApprove task 时, 下一轮工具调用进审批 UI =
//     loop 死锁 (漏洞 #5). 所以含 marker 必须 autoApprove=true.
export function checkGoalMarkerAutoApprove(
  prompt: unknown,
  autoApprove: unknown,
): GoalMarkerCheckResult {
  if (typeof prompt !== "string" || !GOAL_MARKER_RE.test(prompt)) {
    return { ok: true };
  }
  if (autoApprove === true) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "GOAL_REQUIRES_AUTO_APPROVE",
    reason:
      "tasks with <goal>...</goal> marker must be created with autoApprove=true " +
      "(goal loop needs unattended tool execution; autoApprove=false would block " +
      "pushMessage feedback injection on tool-approval UI and deadlock the loop)",
  };
}
