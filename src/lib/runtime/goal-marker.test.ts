// Goal-driven loop 阶段 3 (D20, damo 2026-09-14 拍板) — 漏洞 #5 缓解:
//   checkGoalMarkerAutoApprove (src/lib/runtime/goal-marker.ts) 单测.
//   这是 API 层 (POST /api/tasks + 两条 fork 路由) 共享的 helper,
//   覆盖:
//     - prompt 不含 <goal> marker → 永远 ok (fast path, 99%+ 流量走这里)
//     - prompt 含 marker + autoApprove=true → ok
//     - prompt 含 marker + autoApprove=false → not ok + code=GOAL_REQUIRES_AUTO_APPROVE
//     - prompt 含 marker + autoApprove=undefined → not ok (默认 false 同义)
//     - prompt 是非字符串 (罕见) → 视为不含 marker → ok
//   反例: prompt 含 <config> 块但没 <goal> → ok (不误伤 schema 类 prompt)

import { describe, it, expect } from "vitest";
import { checkGoalMarkerAutoApprove } from "./goal-marker";

describe("checkGoalMarkerAutoApprove", () => {
  it("prompt 不含 marker → ok (fast path, 不动 autoApprove)", () => {
    expect(checkGoalMarkerAutoApprove("hello world", false).ok).toBe(true);
    expect(checkGoalMarkerAutoApprove("hello world", undefined).ok).toBe(true);
    expect(checkGoalMarkerAutoApprove("hello world", true).ok).toBe(true);
  });

  it("prompt 含 <config> 但没 <goal> → ok (不误伤)", () => {
    const p = "请修改 <config> 块的 foo 字段为 bar";
    expect(checkGoalMarkerAutoApprove(p, false).ok).toBe(true);
  });

  it("prompt 含 <goal> + autoApprove=true → ok", () => {
    const p = "请改 README.\n<goal>README 第一段第一个词是 bar</goal>";
    expect(checkGoalMarkerAutoApprove(p, true).ok).toBe(true);
  });

  it("prompt 含 <goal> + autoApprove=false → 拒 + code", () => {
    const p = "请改 README.\n<goal>README 第一段第一个词是 bar</goal>";
    const r = checkGoalMarkerAutoApprove(p, false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("GOAL_REQUIRES_AUTO_APPROVE");
      expect(r.reason).toMatch(/autoApprove=true/);
    }
  });

  it("prompt 含 <goal> + autoApprove=undefined → 拒 (默认 false 同义)", () => {
    const p = "x\n<goal>y</goal>";
    const r = checkGoalMarkerAutoApprove(p, undefined);
    expect(r.ok).toBe(false);
  });

  it("prompt 非字符串 (null / number / undefined) → 视为无 marker → ok", () => {
    expect(checkGoalMarkerAutoApprove(null, false).ok).toBe(true);
    expect(checkGoalMarkerAutoApprove(123, false).ok).toBe(true);
    expect(checkGoalMarkerAutoApprove(undefined, false).ok).toBe(true);
  });

  it("空字符串 prompt + autoApprove=false → ok (不阻断, fast path)", () => {
    // 边界: 空 prompt = 没有 marker, 走 fast path. 这种 task 在更早的校验
    // (title + prompt required) 已经被拒, 这里是兜底.
    expect(checkGoalMarkerAutoApprove("", false).ok).toBe(true);
  });
});
