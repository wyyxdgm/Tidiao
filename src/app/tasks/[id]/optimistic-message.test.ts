// 真 optimistic UI (任务详情页 chat) 的纯函数单测.
// 覆盖:
//   - appendOptimisticUserMessage:
//     1. 空 prev → 追加新 message
//     2. prev 含不同文本 → 追加到末尾
//     3. prev 含相同 user 文本 → 跳过 (去重)
//     4. prev 含相同文本但 role=assistant → 追加 (type 不同)
//     5. timestamp 走 now 参数 (便于测试固定)
//     6. 同文本多条 → 只追加一次
//   - removeOptimisticMessage:
//     1. clientId 匹配 → 撤回
//     2. clientId 不匹配 → 保留
//     3. 无 clientId 的消息不被误删
//     4. 多条 optimistic → 仅撤回匹配的那一条
//     5. 空 prev → 返回空
//
// 关注点:
//   - 测试纯函数, 不依赖 React DOM (项目 vitest 未配 jsdom/happy-dom).
//   - 这些 helper 直接对应 handleSendMessage 的 state 写入路径, 单测覆盖
//     「消息是否进入 state」的最小时序; SSE / loadHistory 集成由人工冒烟验.

import { describe, it, expect } from "vitest";
import {
  appendOptimisticUserMessage,
  removeOptimisticMessage,
  type OptimisticMessageItem,
} from "./optimistic-message";

describe("appendOptimisticUserMessage", () => {
  it("空 prev → 追加一条带 clientId 的 user message", () => {
    const next = appendOptimisticUserMessage([], "hello", "c1", 1700000000000);
    expect(next).toEqual([
      {
        type: "user",
        role: "user",
        text: "hello",
        timestamp: 1700000000000,
        clientId: "c1",
      },
    ]);
  });

  it("prev 含不同文本 → 追加到末尾", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "first", timestamp: 1, clientId: "c0" },
      { type: "assistant", role: "assistant", text: "reply", timestamp: 2 },
    ];
    const next = appendOptimisticUserMessage(prev, "second", "c1", 3);
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ text: "second", clientId: "c1", type: "user" });
    // 不可变: 返回新数组, 不改 prev
    expect(next).not.toBe(prev);
    expect(prev).toHaveLength(2);
  });

  it("prev 含相同 user 文本 → 仍追加新 bubble (R156: 同文本 send 不再被静默吞掉)", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "hello", timestamp: 1, uuid: "real-uuid" },
    ];
    const next = appendOptimisticUserMessage(prev, "hello", "c1", 2);
    // 旧行为: return prev, 不追加 (SSE echo 已带进同 text).
    // 新行为: 每次 send 都产生新 bubble + 新 clientId, 重复由后续 SSE / loadHistory 合并.
    // 同文本的乐观消息 + 后端 event 落库后, mergeHistory 按 text 接管 (uuid 替换 clientId),
    // 历史回放路径自动收敛. 用户感知: 「每次点击发送都有可见反馈」.
    expect(next).not.toBe(prev);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ type: "user", text: "hello", clientId: "c1", timestamp: 2 });
    expect(next[0]).toMatchObject({ uuid: "real-uuid", text: "hello" });
  });

  it("prev 含相同文本但 type=assistant → 追加 (type 不同, 不算 user 消息)", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "assistant", role: "assistant", text: "hello", timestamp: 1 },
    ];
    const next = appendOptimisticUserMessage(prev, "hello", "c1", 2);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ type: "user", text: "hello", clientId: "c1" });
  });

  it("now 不传 → 走 Date.now()", () => {
    const before = Date.now();
    const next = appendOptimisticUserMessage([], "x", "c1");
    const after = Date.now();
    expect(next[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(next[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("同文本多条已存在 → 仍追加 (R156: 不再 dedup)", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "dup", timestamp: 1, clientId: "c0" },
      { type: "user", role: "user", text: "dup", timestamp: 2, uuid: "real-uuid" },
    ];
    const next = appendOptimisticUserMessage(prev, "dup", "c-new", 3);
    // 旧行为: 返回 prev, 不追加.
    // 新行为: 每次 send 追加, 同文本多条并存. 后续 mergeHistory 按 text 把所有乐观
    // 消息视作「待 SDK drain」占位, history 一旦含 text 就接替; 同文本多次 send 落
    // 库后会按各自 timestamp 进入 history (多次 send 仍可见).
    expect(next).not.toBe(prev);
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ type: "user", text: "dup", clientId: "c-new", timestamp: 3 });
  });
});

describe("removeOptimisticMessage", () => {
  it("clientId 匹配 → 撤回该条", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "lost", timestamp: 1, clientId: "c1" },
    ];
    const next = removeOptimisticMessage(prev, "c1");
    expect(next).toEqual([]);
  });

  it("clientId 不匹配 → 保留", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "keep", timestamp: 1, clientId: "c-other" },
    ];
    const next = removeOptimisticMessage(prev, "c1");
    // filter 总是返回新数组 — 这里关心内容不变, 不强求引用相等
    expect(next).toEqual(prev);
    expect(next).toHaveLength(1);
  });

  it("无 clientId 的消息不被误删 (SSE/historical 推送)", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "real", timestamp: 1, uuid: "real-uuid" },
      { type: "user", role: "user", text: "prompt", timestamp: 0 }, // 无 clientId, 无 uuid (task.prompt 注入)
    ];
    const next = removeOptimisticMessage(prev, "c1");
    expect(next).toEqual(prev);
    expect(next).toHaveLength(2);
  });

  it("多条 optimistic → 仅撤回匹配的那一条", () => {
    const prev: OptimisticMessageItem[] = [
      { type: "user", role: "user", text: "a", timestamp: 1, clientId: "c-a" },
      { type: "user", role: "user", text: "b", timestamp: 2, clientId: "c-b" },
      { type: "user", role: "user", text: "c", timestamp: 3, clientId: "c-c" },
    ];
    const next = removeOptimisticMessage(prev, "c-b");
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.text)).toEqual(["a", "c"]);
    expect(next.find((m) => m.text === "b")).toBeUndefined();
  });

  it("空 prev → 返回空数组", () => {
    const next = removeOptimisticMessage([], "c1");
    expect(next).toEqual([]);
  });
});

describe("乐观插入 + 撤回 完整流", () => {
  it("POST 成功路径: 插入 temp → POST → 不撤回 (SSE 会按 text 去重)", () => {
    let msgs: OptimisticMessageItem[] = [];
    const text = "fix this bug";
    const clientId = "c-1";

    // 点击发送 → 清输入框 → 立即追加 temp message (不依赖 SSE/POST)
    msgs = appendOptimisticUserMessage(msgs, text, clientId, 100);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].clientId).toBe(clientId);

    // POST 成功 → 不撤回 (SSE 后续推送的同 text 消息按 text 去重不会重复)
    // (本测试只验证 "未撤回"; 去重由 SSE handler 内部逻辑保证)
    const afterPost = removeOptimisticMessage(msgs, "__nope__");
    expect(afterPost).toEqual(msgs);
    expect(msgs).toHaveLength(1);
  });

  // 模拟 task-detail-client.tsx 中 handleSendMessage 的 onClick 流 (无 jsdom):
  //   1. preventDefault + 空 input 短路
  //   2. 立刻 setMessages(appendOptimisticUserMessage(...)) — 不等 POST
  //   3. await postAction(...) — POST 200 时不动 messages; 失败按 clientId 撤回
  //   4. SSE message 事件按 text 去重, 不会重复渲染
  // 关键不变式 (R2/R8 修复目标): POST 200 后 messages 数组立即包含新消息,
  // 无需等待 SSE 推送回写. 此测试断言该不变式.
  it("模拟 onClick → POST 200 → SSE 回声: 消息在 POST resolve 之前已入 state, SSE 不重复", async () => {
    let msgs: OptimisticMessageItem[] = [];
    const setMessages = (fn: (p: OptimisticMessageItem[]) => OptimisticMessageItem[]) => {
      msgs = fn(msgs);
    };

    // 模拟 handleSendMessage 入口
    let messageInput = "hello agent";
    let pendingAttachments: { id: string }[] = [{ id: "att-1" }];
    const clientId = "click-1";
    const text = messageInput;
    const attIds = pendingAttachments.map((a) => a.id);
    expect(text.trim()).toBeTruthy(); // 非空才继续

    // ── 关键: 点发送后, 同步立即入 state ──────────────────────────────
    messageInput = "";
    pendingAttachments = [];
    setMessages((prev) => appendOptimisticUserMessage(prev, text, clientId, 1000));

    // 此时 POST 还没发出, 但 messages 已含新消息 (R2/R8 修复目标断言)
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: "user",
      role: "user",
      text: "hello agent",
      clientId: "click-1",
      timestamp: 1000,
    });
    expect(messageInput).toBe(""); // 输入框已清
    expect(pendingAttachments).toEqual([]); // 附件已清

    // ── 模拟 POST: 服务端响应 + 客户端 await ──────────────────────────
    const postResult = await Promise.resolve({ ok: true, status: "reviewing" });

    // POST 200 → 不撤回
    if (postResult?.ok === false) {
      setMessages((prev) => removeOptimisticMessage(prev, clientId));
      messageInput = text;
      pendingAttachments = [{ id: "att-1" }];
    }

    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("hello agent");
    expect(messageInput).toBe(""); // 失败未触发, 输入框保持清空

    // ── 模拟 SSE message 事件 (服务端广播自己的回声) ──────────────────
    const sseEvent = { role: "user", text: "hello agent", timestamp: 1000 };
    setMessages((prev) => {
      // SSE handler 的去重逻辑: 同 type+text 跳过
      if (prev.some((m) => m.type === "user" && m.text === sseEvent.text)) return prev;
      return [
        ...prev,
        {
          type: "user",
          role: "user",
          text: sseEvent.text,
          timestamp: sseEvent.timestamp,
        },
      ];
    });

    // SSE 回声被去重, 不会产生第二条
    expect(msgs).toHaveLength(1);
    expect(msgs.filter((m) => m.text === "hello agent")).toHaveLength(1);
  });

  // 模拟 onClick → POST 失败: 撤回 temp message + 还原输入框 + 还原附件.
  // 与成功路径对称, 保证失败时用户体验对称 (输入内容不丢).
  it("模拟 onClick → POST 失败: 撤回 + 输入框/附件还原", async () => {
    let msgs: OptimisticMessageItem[] = [];
    const setMessages = (fn: (p: OptimisticMessageItem[]) => OptimisticMessageItem[]) => {
      msgs = fn(msgs);
    };

    let messageInput = "请帮我修 bug";
    let pendingAttachments: { id: string }[] = [{ id: "att-1" }, { id: "att-2" }];
    const clientId = "click-2";

    // onClick: 立即乐观插入 + 清空
    const text = messageInput;
    const atts = pendingAttachments;
    messageInput = "";
    pendingAttachments = [];
    setMessages((prev) => appendOptimisticUserMessage(prev, text, clientId, 2000));

    expect(msgs).toHaveLength(1);

    // 模拟 POST 失败
    const postResult = await Promise.resolve({ ok: false, error: "网络错误" });

    if (postResult?.ok === false) {
      setMessages((prev) => removeOptimisticMessage(prev, clientId));
      messageInput = text;
      pendingAttachments = atts;
    }

    expect(msgs).toEqual([]);
    expect(messageInput).toBe("请帮我修 bug"); // 输入框还原
    expect(pendingAttachments).toHaveLength(2); // 附件还原
  });

  // 模拟 onClick 在空输入时短路 — 防御性边界.
  it("空文本 onClick → 直接 return, 不发 POST, 不插消息", () => {
    let msgs: OptimisticMessageItem[] = [];
    const setMessages = (fn: (p: OptimisticMessageItem[]) => OptimisticMessageItem[]) => {
      msgs = fn(msgs);
    };

    const messageInput = "   ";
    if (!messageInput.trim()) {
      // 早 return, 不调用 setMessages, 不发 POST
    } else {
      setMessages((prev) => appendOptimisticUserMessage(prev, messageInput, "c"));
    }

    expect(msgs).toEqual([]);
  });

  it("POST 失败路径: 插入 temp → POST fail → 撤回 + 输入框/附件还原", () => {
    let msgs: OptimisticMessageItem[] = [
      { type: "assistant", role: "assistant", text: "how can I help?", timestamp: 1 },
    ];
    const text = "fix this bug";
    const atts = [{ id: "att-1", filename: "x.png", media_type: "image/png", size_bytes: 10 }];
    const clientId = "c-1";
    let messageInput = "";
    let pendingAttachments: typeof atts = [];

    // 点击发送: 清输入框 + 清附件 + 立即插入 temp message
    messageInput = "";
    pendingAttachments = [];
    msgs = appendOptimisticUserMessage(msgs, text, clientId, 100);
    expect(msgs).toHaveLength(2);

    // POST 失败 → 撤回 temp + 还原输入框 + 还原附件
    msgs = removeOptimisticMessage(msgs, clientId);
    messageInput = text;
    pendingAttachments = atts;

    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("assistant");
    expect(messageInput).toBe(text);
    expect(pendingAttachments).toBe(atts);
  });
});