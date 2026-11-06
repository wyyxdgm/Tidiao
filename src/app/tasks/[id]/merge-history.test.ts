// loadHistory 合并逻辑 (task-detail-client.tsx) 的纯函数单测.
// 覆盖:
//   - prev 为空 → 直接返回 history (初次加载走这条)
//   - prev 含 optimistic user (无 uuid) + history 含同 text → 不重复追加
//   - prev 含 optimistic user + history 不含 → 追加到末尾 (R106 修复点 #1)
//   - prev 含 SSE assistant_message (带 uuid) + history 不含 → 追加 (R106 修复点 #2)
//   - prev 含 SSE assistant_message + history 含同 uuid → 不重复
//   - prev 含 prompt 注入 (isPrompt=true) → 不算 pending
//   - prev 含两条同 text 的 user (1 条 optimistic + 1 条 history 镜像) → 只保留 1 条
//   - history 与 prev 完全一致 → 返回 history (无 pending)
//   - prev 同时含 optimistic user + SSE assistant → 两条都保留
// 关注点:
//   - 项目未配 jsdom/happy-dom, 直接测 React 组件不现实, 抽到独立纯函数.
//   - 不依赖 task-detail-client 的完整 MessageItem 类型 (含 attachment /
//     groupSize / toolInput 等), 测试只关心合并路径用的字段.

import { describe, it, expect } from "vitest";
import { mergeHistory, type MergeHistoryItem } from "./merge-history";

describe("mergeHistory", () => {
  it("prev 为空 → 直接返回 history (初次加载场景)", () => {
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "hello", uuid: "a1" },
    ];
    expect(mergeHistory([], history)).toBe(history);
  });

  it("prev 含 optimistic user (无 uuid) + history 含同 text → 不重复追加", () => {
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "fix this bug", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "on it", uuid: "a1" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "fix this bug", timestamp: 1000, clientId: "c1" },
    ];
    // text 在 historyUserTexts 中 → 不进 pending → 直接返回 history
    expect(mergeHistory(prev, history)).toBe(history);
  });

  it("prev 含 optimistic user + history 不含同 text → 追加到末尾 (R106 修复点 #1)", () => {
    // 场景: 用户在 reviewing 状态发消息 → optimistic 加入 → SSE 触发
    // status_change reviewing→running → loadHistory 启动 → fetch 返回时 SDK
    // 还没把 user msg 落进 JSONL/DB → history 不含此 user msg → 必须保留
    // optimistic 否则用户消息会被冲掉.
    const history: MergeHistoryItem[] = [
      { type: "assistant", role: "assistant", text: "old reply", uuid: "a0" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "assistant", role: "assistant", text: "old reply", uuid: "a0" },
      { type: "user", role: "user", text: "new question", timestamp: 1000, clientId: "c1" },
    ];
    const merged = mergeHistory(prev, history);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ type: "assistant", uuid: "a0" });
    expect(merged[1]).toMatchObject({ type: "user", text: "new question", clientId: "c1" });
    // 不可变: 不改 history
    expect(history).toHaveLength(1);
  });

  it("prev 含 SSE assistant_message (带 uuid) + history 不含 → 追加 (R106 修复点 #2)", () => {
    // 场景: loadHistory 启动 → SSE 推 assistant_message (uuid=a_new) → SSE 又
    // 推 status_change 跑 review 周期 → loadHistory fetch 终于返回时 SDK 还
    // 没把 assistant_message 落库 → history 不含 a_new → 原实现会丢这条.
    // 新实现按 uuid 保留 prev 中的 a_new, 拼到 history 末尾.
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      // 注意: a_new 不在 history (SDK 还没落库)
    ];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "I'll check", uuid: "a_new", timestamp: 1100 },
    ];
    const merged = mergeHistory(prev, history);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ uuid: "u1" });
    expect(merged[1]).toMatchObject({ uuid: "a_new", text: "I'll check" });
  });

  it("prev 含 SSE assistant_message + history 含同 uuid → 不重复", () => {
    // 场景: loadHistory 二次触发, SDK 已落库 → prev 与 history 重合 →
    // 不应 append 产生两条一样的 assistant_message.
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "answer", uuid: "a1" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "answer", uuid: "a1" },
    ];
    expect(mergeHistory(prev, history)).toBe(history);
  });

  it("prev 含 prompt 注入 (isPrompt=true) → 不算 pending (history 已含 task.prompt 时不重复)", () => {
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "task prompt", uuid: "u_prompt" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "task prompt", timestamp: 0, isPrompt: true },
    ];
    // isPrompt=true → filter 排掉 → pending 为空 → 返回 history
    expect(mergeHistory(prev, history)).toBe(history);
  });

  it("prev 含两条同 text 的 user (1 条 optimistic + 1 条 history 镜像) → history 那条已存在, 只追加 optimistic 那一条", () => {
    // 边界: prev 数组里有两条 user 同 text, 一条是 optimistic (无 uuid),
    // 一条是 SSE 镜像过来的 history 副本 (有 uuid 但 text 相同). 合并后
    // history 已含 → optimistic 那条会因 text 匹配被丢弃 (因为 history
    // 有同 text user, 即使 uuid 不同); SSE 镜像那条按 uuid 去重. 结果:
    // 只保留 history 的那条 + history 原内容.
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hello", uuid: "u1" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hello", uuid: "u1" },
      { type: "user", role: "user", text: "hello", timestamp: 999, clientId: "c1" },
    ];
    // historyUserTexts 包含 "hello" → optimistic 不进 pending
    // historyUuids 包含 u1 → SSE 镜像不进 pending
    // pending 为空 → 返回 history
    expect(mergeHistory(prev, history)).toBe(history);
  });

  it("prev 同时含 optimistic user + SSE assistant → 两条都保留", () => {
    // 完整 reviewing → running 流程: 用户消息 optimistic + AI SSE 推回
    // assistant_message, 此时 SDK 还没落库 → history 只有旧消息.
    const history: MergeHistoryItem[] = [
      { type: "assistant", role: "assistant", text: "old reply", uuid: "a0" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "assistant", role: "assistant", text: "old reply", uuid: "a0" },
      { type: "user", role: "user", text: "follow up", timestamp: 1500, clientId: "c2" },
      { type: "assistant", role: "assistant", text: "got it", uuid: "a_new", timestamp: 1600 },
    ];
    const merged = mergeHistory(prev, history);
    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.uuid ?? m.clientId)).toEqual(["a0", "c2", "a_new"]);
  });

  it("prev 含 SSE tool_use (带 uuid) + history 不含 → 保留", () => {
    // 场景扩展: SSE 推的 tool_use 也带 uuid, 应一并保留.
    const history: MergeHistoryItem[] = [];
    const prev: MergeHistoryItem[] = [
      {
        type: "tool_use",
        role: "assistant",
        text: "Read /x",
        uuid: "tu1",
        timestamp: 100,
      },
    ];
    const merged = mergeHistory(prev, history);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ type: "tool_use", uuid: "tu1" });
  });

  it("prev 与 history 完全一致 → 返回 history 引用 (无 pending 优化路径)", () => {
    const history: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "hello", uuid: "a1" },
    ];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "hi", uuid: "u1" },
      { type: "assistant", role: "assistant", text: "hello", uuid: "a1" },
    ];
    expect(mergeHistory(prev, history)).toBe(history);
  });

  it("history 全空 + prev 含若干条 → 全部追加 (空 history 也允许 prev 保留)", () => {
    const history: MergeHistoryItem[] = [];
    const prev: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "q", timestamp: 1, clientId: "c" },
      { type: "assistant", role: "assistant", text: "a", uuid: "a1" },
    ];
    const merged = mergeHistory(prev, history);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ type: "user", clientId: "c" });
    expect(merged[1]).toMatchObject({ type: "assistant", uuid: "a1" });
  });

  it("R147 回归: prev 含 A 的完整 history + history 改换为 B → 返回 B (无 A 内容残留)", () => {
    // 场景: chat-view 切换 taskId 时, TaskDetailClient 复用不重挂载.
    //   修复前: messages 一直保留 A 的内容, 直到 B 的 fetch 完成才被 merge
    //           覆盖 (且 merge 会保留 prev 中的 uuid 项, 部分 A 内容会残留)
    //   修复后: useEffect([taskId]) 先 setMessages([]), 再触发 loadHistory →
    //           mergeHistory(prev=[], history=B) 直接返回 B
    // 此单测覆盖修复后契约: 「prev 被清空时, 不会泄漏任何 A 的内容到 B 的视图」.
    const historyA: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "A's question", uuid: "uA1" },
      { type: "assistant", role: "assistant", text: "A's reply 1", uuid: "aA1" },
      { type: "assistant", role: "assistant", text: "A's reply 2", uuid: "aA2" },
    ];
    const historyB: MergeHistoryItem[] = [
      { type: "user", role: "user", text: "B's question", uuid: "uB1" },
      { type: "assistant", role: "assistant", text: "B's reply", uuid: "aB1" },
    ];
    // 修复路径: 切换到 B 时先 setMessages([]), 即 prev=[].
    // mergeHistory([], historyB) 必须只返回 B 的内容.
    const merged = mergeHistory([], historyB);
    expect(merged).toBe(historyB);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.text === "A's reply 1")).toBeUndefined();
    expect(merged.find((m) => m.text === "A's reply 2")).toBeUndefined();
    expect(merged[0]).toMatchObject({ text: "B's question", uuid: "uB1" });
    expect(merged[1]).toMatchObject({ text: "B's reply", uuid: "aB1" });
  });
});
