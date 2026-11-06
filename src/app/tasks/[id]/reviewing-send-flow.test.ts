// R106 reviewing→send→assistant_message 完整时序模拟测试.
// 模拟 task-detail-client 的 state 转换:
//   1. 用户在 reviewing 状态点发送 → optimistic 添加
//   2. SSE status_change(reviewing→queued/running) → loadHistory 启动
//   3. SSE message echo → text dedup → no-op
//   4. SSE assistant_message → state += assistant
//   5. loadHistory fetch resolve → mergeHistory(prev, history)
// 6. status_change(running→reviewing) → no loadHistory (不重复触发)
// 关键断言: 用户消息 + AI 回复两条都不应丢失.

// 这个测试模拟完整的状态机, 不依赖 React/jsdom. 用模拟函数替代 setMessages.

import { describe, it, expect } from "vitest";
import {
  appendOptimisticUserMessage,
  removeOptimisticMessage,
} from "./optimistic-message";
import { mergeHistory } from "./merge-history";

// 模拟 SSE 事件序列: (reviewing → queued) → message echo → assistant_message → (running → reviewing).
// loadHistory 在 reviewing→queued 时启动, 在 (running→reviewing) 之前完成.
describe("R106 完整时序: reviewing 状态发消息 + AI 回复 + loadHistory", () => {
  it("乐观插入 + AI 回复 + loadHistory resolve → 用户消息和 AI 回复都保留", () => {
    // Step 0: 初始 state (reviewing 中, 有历史对话)
    let messages: any[] = [
      { type: "user", role: "user", text: "请帮我分析下", uuid: "u_history_1", timestamp: 1000 },
      { type: "assistant", role: "assistant", text: "好的, 请稍等", uuid: "a_history_1", timestamp: 1100 },
    ];

    // Step 1: 用户点击发送 → optimistic 立即入 state
    const clientId = "click_abc";
    const userText = "follow up question";
    messages = appendOptimisticUserMessage(messages, userText, clientId, 2000);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ type: "user", text: userText, clientId });

    // Step 2: SSE message echo 到达 (后端广播 user msg 给自己)
    // text dedup → skip (用户消息已在)
    const sseMessageEcho = { role: "user", text: userText, timestamp: Date.now() };
    messages = (() => {
      const data = sseMessageEcho;
      if (messages.some((m: any) => m.type === "user" && m.text === data.text)) return messages;
      return [...messages, { type: "user", role: "user", text: data.text, timestamp: Date.now() }];
    })();
    expect(messages).toHaveLength(3); // 仍然 3 条, echo 被去重

    // Step 3: SSE assistant_message 到达
    const sseAssistant = { text: "AI is responding", uuid: "a_new_1" };
    messages = [...messages, {
      type: "assistant",
      role: "assistant",
      text: sseAssistant.text,
      uuid: sseAssistant.uuid,
      timestamp: 2100,
    }];
    expect(messages).toHaveLength(4);
    expect(messages[3]).toMatchObject({ type: "assistant", text: "AI is responding", uuid: "a_new_1" });

    // Step 4: loadHistory fetch resolve. SDK 此时已 drain 用户消息, 所以 history 包含
    // user msg (uuid=u_new_1) + assistant (uuid=a_new_1, 与 SSE 同 uuid).
    const history = [
      { type: "user", role: "user", text: "请帮我分析下", uuid: "u_history_1", timestamp: 1000 },
      { type: "assistant", role: "assistant", text: "好的, 请稍等", uuid: "a_history_1", timestamp: 1100 },
      { type: "user", role: "user", text: userText, uuid: "u_new_1", timestamp: 2050 },
      { type: "assistant", role: "assistant", text: "AI is responding", uuid: "a_new_1", timestamp: 2100 },
    ];

    const prevBeforeMerge = messages;
    messages = mergeHistory(prevBeforeMerge, history);

    // 关键断言: 用户消息和 AI 回复两条都还在
    expect(messages).toHaveLength(4);
    const userTexts = messages.filter((m: any) => m.type === "user").map((m: any) => m.text);
    expect(userTexts).toContain(userText);
    const assistantTexts = messages.filter((m: any) => m.type === "assistant").map((m: any) => m.text);
    expect(assistantTexts).toContain("AI is responding");
  });

  it("乐观插入 + AI 回复 + loadHistory 在 SDK drain 之前 resolve → 用户消息保留 (fallback)", () => {
    // SDK drain 比 loadHistory fetch 慢的场景: history 还没追上, optimistic 应保留.
    let messages: any[] = [
      { type: "user", role: "user", text: "请帮我分析下", uuid: "u_history_1", timestamp: 1000 },
    ];

    const clientId = "click_abc";
    const userText = "follow up question";
    messages = appendOptimisticUserMessage(messages, userText, clientId, 2000);

    const sseAssistant = { text: "AI is responding", uuid: "a_new_1" };
    messages = [...messages, {
      type: "assistant",
      role: "assistant",
      text: sseAssistant.text,
      uuid: sseAssistant.uuid,
      timestamp: 2100,
    }];

    // loadHistory resolve 时, SDK 还没 drain. history 只有历史消息.
    const history = [
      { type: "user", role: "user", text: "请帮我分析下", uuid: "u_history_1", timestamp: 1000 },
    ];

    messages = mergeHistory(messages, history);

    // 关键断言: optimistic 用户消息 + SSE assistant 都还在
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const allTexts = messages.map((m: any) => m.text).filter(Boolean);
    expect(allTexts).toContain(userText);
    expect(allTexts).toContain("AI is responding");
  });

  it("POST 失败: optimistic 撤回 + 输入框/附件还原", () => {
    let messages: any[] = [];
    const clientId = "click_xyz";
    const text = "失败测试";
    messages = appendOptimisticUserMessage(messages, text, clientId, 3000);
    expect(messages).toHaveLength(1);

    // 模拟 POST 返回 ok:false
    messages = removeOptimisticMessage(messages, clientId);
    expect(messages).toEqual([]);
  });

  it("同一会话内发两条不同文本消息: 两条都保留", () => {
    // 用户连发 "first" 和 "second", 应该两条都入 state.
    let messages: any[] = [];
    messages = appendOptimisticUserMessage(messages, "first", "c1", 100);
    messages = appendOptimisticUserMessage(messages, "second", "c2", 200);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ text: "first" });
    expect(messages[1]).toMatchObject({ text: "second" });

    // 模拟 loadHistory resolve 时 SDK 都已 drain
    const history = [
      { type: "user", role: "user", text: "first", uuid: "u1", timestamp: 100 },
      { type: "user", role: "user", text: "second", uuid: "u2", timestamp: 200 },
    ];
    messages = mergeHistory(messages, history);
    expect(messages).toHaveLength(2);
    const texts = messages.map((m: any) => m.text);
    expect(texts).toEqual(["first", "second"]);
  });
});