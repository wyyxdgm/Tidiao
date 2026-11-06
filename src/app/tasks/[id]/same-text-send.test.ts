// Regression: 用户在 reviewing 状态发同一条消息两次, 第二次 (running 状态) 不应被
//   appendOptimisticUserMessage 的 text dedup 静默吞掉 — 应该出现两个独立的 user bubble.
//
// 用户的实际场景 (task 3cf0b9ce-...):
//   - 14:56:07 reviewing 状态: 发 "目前...??" (event 322036 queued:true)
//   - 14:57:21 running 状态:  发 同一条 (event 322053 no queued)
//   - 后端两条都收到 + 落 events 表, agent 收到并响应.
//   - 前端 UI: 第一次 send 后能看到 (loadHistory 落 history 替换 optimistic).
//     第二次 send 用户报告 "消息没出现", 推测是 optimistic text dedup 阻止了
//     新 bubble 入 state (prev.some(text===X)→true→return prev). 用户感知 =
//     "发送后没变化", 刷新才看到两条 X (events 表两条都进 history).
//
// 测试覆盖:
//   1. 第一次 send → appendOptimisticUserMessage 应追加新 bubble (空 prev)
//   2. 模拟 loadHistory 落 history (X 已存在), state 仍含 X
//   3. 第二次 send → appendOptimisticUserMessage 应再次追加新 bubble (即使是同文本)
//      当前实现会因 text dedup 跳过 → 这是 bug.
//   4. SSE message echo (queued:true) 到达 → 不能简单按 text 跳过, 否则两条 send
//      的 echo 都会被吞掉. 需要按 clientId 区分或允许 SSE 重复 text (反正合并后
//      dedup 也得保留新 send 可见).
//
// 注: 这个测试会 FAIL 当下 (text dedup 会跳过第二次 send). 如果你跑测试过不去,
//   说明 bug 还在, 修法见下方 todo.

import { describe, it, expect } from "vitest";
import {
  appendOptimisticUserMessage,
  removeOptimisticMessage,
  type OptimisticMessageItem,
} from "./optimistic-message";
import { mergeHistory } from "./merge-history";

describe("R156 回归: 同文本第二次 send 必须可见", () => {
  it("第一次 send → state 出现 user bubble", () => {
    let msgs: OptimisticMessageItem[] = [];
    msgs = appendOptimisticUserMessage(msgs, "目前还是会关闭浏览器tab?", "client-1", 1000);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: "user", text: "目前还是会关闭浏览器tab?", clientId: "client-1" });
  });

  it("模拟 loadHistory 落 history: 第一次 send 的 bubble 被 history X 替换, 仍有 X", () => {
    let msgs: OptimisticMessageItem[] = [];
    msgs = appendOptimisticUserMessage(msgs, "目前还是会关闭浏览器tab?", "client-1", 1000);
    // 模拟 loadHistory 拿到的 history (含 backend 已落 DB 的 event-derived X, uuid=event-322036)
    const history = [
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", uuid: "event-322036", timestamp: 1000 },
    ];
    msgs = mergeHistory(msgs, history);
    // X 还在 (history 里的 event-derived X 接管 optimistic 位置)
    const userTexts = msgs.filter((m) => m.type === "user").map((m) => m.text);
    expect(userTexts).toContain("目前还是会关闭浏览器tab?");
  });

  it("第二次 send (running 状态, 同文本) → 应该再追加一条 bubble, 不被 text dedup 吞掉", () => {
    // 模拟 state: 已有第一次 send 后的 history X
    let msgs: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", uuid: "event-322036", timestamp: 1000 },
    ];
    // 第二次 send: 用户点发送 → appendOptimisticUserMessage 同文本, 新 clientId
    msgs = appendOptimisticUserMessage(msgs, "目前还是会关闭浏览器tab?", "client-2", 2000);
    // 期望: 出现第二个 user bubble (新 clientId)
    const userBubbles = msgs.filter((m) => m.type === "user");
    expect(userBubbles.length).toBeGreaterThanOrEqual(2);
    const clientIds = userBubbles.map((m) => m.clientId).filter(Boolean);
    expect(clientIds).toContain("client-2");
    // 第一次 send 的 history X 保留 (uuid 仍存)
    expect(userBubbles.some((m) => m.uuid === "event-322036")).toBe(true);
  });

  it("第二次 send 模拟 loadHistory 落 history: 两条 event-derived X 都在 state", () => {
    // 模拟两次 send 后, SDK 都 drain, history 含两条 event-derived X
    let msgs: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", uuid: "event-322036", timestamp: 1000 },
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", clientId: "client-2", timestamp: 2000 },
    ];
    const history = [
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", uuid: "event-322036", timestamp: 1000 },
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", uuid: "event-322053", timestamp: 2000 },
    ];
    msgs = mergeHistory(msgs, history);
    const userBubbles = msgs.filter((m) => m.type === "user");
    expect(userBubbles.length).toBeGreaterThanOrEqual(2);
    expect(userBubbles.some((m) => m.uuid === "event-322036")).toBe(true);
    expect(userBubbles.some((m) => m.uuid === "event-322053")).toBe(true);
  });

  it("rollback: 第二次 send POST 失败 → 仅撤回 client-2 客户端消息, 不影响 client-1", () => {
    let msgs: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", uuid: "event-322036", timestamp: 1000 },
      { type: "user", role: "user", text: "目前还是会关闭浏览器tab?", clientId: "client-2", timestamp: 2000 },
    ];
    msgs = removeOptimisticMessage(msgs, "client-2");
    const userBubbles = msgs.filter((m) => m.type === "user");
    expect(userBubbles.length).toBe(1);
    expect(userBubbles[0].uuid).toBe("event-322036");
  });
});
