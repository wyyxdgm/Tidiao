// formatSessionMarkdown / formatSessionJsonl 回归测试。
//
// 为什么需要这个文件: 导出的价值全在"内容完整"上。历史实现只读 events 表,
// 实测丢掉约 90% 的会话内容(events 3.7KB vs SDK jsonl 32.7KB 同一个 task),
// 而这种残缺不会让任何测试变红 —— 导出照样返回 200、照样是合法 markdown。
// 这里钉住三件事: summary 的瘦身规则、full 的逐字保留、content 两种形状都不炸。

import { describe, it, expect } from "vitest";
import { formatSessionMarkdown, formatSessionJsonl, type TranscriptTaskMeta } from "./transcript";

// 造 SessionMessage 用的宽松形状 —— 从函数签名反推, 免得为测试重复声明 SDK 类型。
type Msg = Parameters<typeof formatSessionMarkdown>[1][number];
const asMsg = (o: unknown) => o as Msg;

const TASK: TranscriptTaskMeta = {
  id: "t-1",
  title: "修复 SMTP 超时",
  status: "completed",
  session_id: "s-1",
  cwd: "/home/user/workspace/x",
  model: "claude-opus-5",
  cost_usd: 0.1234,
  source: "win",
  project_name: "GDM",
};

// content 用裸 string 的 user 消息 (SDK 对首条 prompt 就是这么存的)
const userStr = (text: string) => asMsg({
  type: "user",
  uuid: "u1",
  session_id: "s-1",
  message: { role: "user", content: text },
});

const assistant = (...blocks: unknown[]) => asMsg({
  type: "assistant",
  uuid: "a1",
  session_id: "s-1",
  message: { role: "assistant", content: blocks },
});

const toolResult = (content: unknown, isError = false) => asMsg({
  type: "user",
  uuid: "r1",
  session_id: "s-1",
  message: { role: "user", content: [{ type: "tool_result", content, is_error: isError }] },
});

describe("formatSessionMarkdown", () => {
  it("渲染元信息头 + 用户/助手正文", () => {
    const md = formatSessionMarkdown(TASK, [
      userStr("SMTP 超时了"),
      assistant({ type: "text", text: "我看一下配置" }),
    ]);
    expect(md).toContain("# 修复 SMTP 超时");
    expect(md).toContain("- Task ID: t-1");
    expect(md).toContain("- Project: GDM");
    expect(md).toContain("- Exported from: win");
    expect(md).toContain("- Cost: $0.1234");
    expect(md).toContain("## 👤 User\n\nSMTP 超时了");
    expect(md).toContain("## 🤖 Assistant\n\n我看一下配置");
  });

  it("summary 丢弃 thinking, full 折叠保留", () => {
    const msgs = [assistant({ type: "thinking", thinking: "内心戏" }, { type: "text", text: "结论" })];
    const summary = formatSessionMarkdown(TASK, msgs);
    expect(summary).not.toContain("内心戏");
    expect(summary).toContain("结论");

    const full = formatSessionMarkdown(TASK, msgs, { verbosity: "full" });
    expect(full).toContain("内心戏");
    expect(full).toContain("<details>");
  });

  it("summary 截断 tool_result, full 原样", () => {
    const long = "x".repeat(5000);
    const summary = formatSessionMarkdown(TASK, [toolResult(long)]);
    expect(summary).toContain("已截断 3000 字");
    expect(summary.length).toBeLessThan(4000);

    const full = formatSessionMarkdown(TASK, [toolResult(long)], { verbosity: "full" });
    expect(full).toContain(long);
    expect(full).not.toContain("已截断");
  });

  it("tool_result 的 content 为 block 数组时抽出文本", () => {
    const md = formatSessionMarkdown(TASK, [toolResult([{ type: "text", text: "命令输出" }])]);
    expect(md).toContain("命令输出");
  });

  it("标记出错的 tool_result", () => {
    const md = formatSessionMarkdown(TASK, [toolResult("boom", true)]);
    expect(md).toContain("❌");
  });

  it("summary 下 tool_use 只出关键参数, 大块参数降级成字数", () => {
    const md = formatSessionMarkdown(TASK, [
      assistant({
        type: "tool_use",
        name: "Edit",
        input: { file_path: "/a/b.ts", old_string: "y".repeat(3000), new_string: "z" },
      }),
    ]);
    expect(md).toContain("### 🔧 Edit");
    expect(md).toContain("file_path: /a/b.ts");
    expect(md).toContain("old_string: 3000 字");
    expect(md).not.toContain("y".repeat(100));
  });

  it("full 下 tool_use 输出完整 JSON 入参", () => {
    const md = formatSessionMarkdown(
      TASK,
      [assistant({ type: "tool_use", name: "Bash", input: { command: "ls -la" } })],
      { verbosity: "full" },
    );
    expect(md).toContain('"command": "ls -la"');
  });

  it("content 缺失 / 空文本不炸也不留空标题", () => {
    const md = formatSessionMarkdown(TASK, [
      asMsg({ type: "assistant", uuid: "x", session_id: "s", message: { role: "assistant" } }),
      assistant({ type: "text", text: "   " }),
      asMsg({ type: "user", uuid: "y", session_id: "s", message: { role: "user", content: null } }),
    ]);
    expect(md).not.toContain("## 🤖 Assistant");
    expect(md).not.toContain("## 👤 User");
  });

  it("harness 注入的取消 tool_result 渲染成 🛑 而非 ❌ ↩ result", () => {
    // 复现 R56: Anthropic CLI harness 在用户取消时注入 user-role tool_result,
    // 文本是固定的英文 STOP 指令. 模型看到它会误读为"用户在叫停".
    const cancelText = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
    const msgs = [
      assistant({ type: "tool_use", name: "Bash", input: { command: "grep -n foo" } }),
      asMsg({
        type: "user",
        uuid: "r-cancel",
        session_id: "s-1",
        toolDenialKind: "cancelled",
        message: { role: "user", content: [{ type: "tool_result", content: cancelText, is_error: true }] },
      }),
    ];
    const md = formatSessionMarkdown(TASK, msgs);
    expect(md).toContain("🛑 harness event");
    expect(md).toContain("(cancelled)");
    expect(md).toContain(cancelText);
    // 不能误渲染成普通 ❌ ↩ result —— 会让运维以为用户 tool 真挂了
    expect(md).not.toContain("❌ ↩ result");
    expect(md).not.toContain("## 👤 User");
    // 必须给运维留指针, 让知道是 model-guidance 红线 8 范围内的
    expect(md).toMatch(/model-guidance.*8|红线 8/);
  });

  it("harness 注入的拒绝 tool_use 渲染成 🛑 而非 ❌ ↩ result", () => {
    // 另一条 harness 模板: 用户拒绝某个 tool_use 时也走这条路径
    const rejectText = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
    const msgs = [
      asMsg({
        type: "user",
        uuid: "r-reject",
        session_id: "s-1",
        toolDenialKind: "rejected",
        message: { role: "user", content: [{ type: "tool_result", content: rejectText, is_error: true }] },
      }),
    ];
    const md = formatSessionMarkdown(TASK, msgs);
    expect(md).toContain("🛑 harness event");
    expect(md).toContain("(rejected)");
    expect(md).not.toContain("❌ ↩ result");
  });

  it("普通真 tool_result 失败仍然走 ❌ ↩ result 路径, 不被误判成 harness event", () => {
    // Bash 命令真实失败的 is_error:true 文本, 不该被升级成 harness event
    const md = formatSessionMarkdown(TASK, [toolResult("bash: foo: command not found", true)]);
    expect(md).toContain("❌");
    expect(md).toContain("↩ result");
    expect(md).not.toContain("🛑");
  });

  it("空会话仍产出带元信息的合法 markdown", () => {
    const md = formatSessionMarkdown(TASK, []);
    expect(md).toContain("- Messages: 0");
  });
});

describe("formatSessionJsonl", () => {
  it("第一行是元信息头, 之后每条消息一行原样", () => {
    const msgs = [userStr("hi"), assistant({ type: "thinking", thinking: "内心戏" })];
    const lines = formatSessionJsonl(TASK, msgs).trim().split("\n");
    expect(lines).toHaveLength(3);

    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("orchestrator-export");
    expect(header.message_count).toBe(2);
    expect(header.task.id).toBe("t-1");

    // 逐字存档: thinking 不能被丢
    expect(JSON.parse(lines[2]).message.content[0].thinking).toBe("内心戏");
  });
});
