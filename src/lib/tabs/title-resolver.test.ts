// 单测: formatTaskTitle — 飞书 R123 R 列反馈 #3 任务标题格式
// 入口: `{项目名≤6}-{任务标题≤12}` (damo 原意: {项目名称-6字符以内}-{任务标题~12个字以内})
//
// 退化:
//   - 只有任务标题 → `{任务标题≤12}`
//   - 只有项目名 → `{项目名≤6}`
//   - 都无 → `任务 {id 前 8}`
//
// 鲁棒:
//   - surrogate pair (emoji / 罕用汉字) 不会被切成半个 codepoint
//   - null / undefined 安全

import { describe, expect, it } from "vitest";

import { formatTaskTitle } from "./title-resolver";

const TASK = { id: "706b1184-aa7e-46fa-8ef5-3afd027f134a", title: "tab 容器" };

describe("formatTaskTitle", () => {
  it("项目名 + 任务标题 → 都截 6/12, 用 '-' 连", () => {
    // "agent-orchestrator-dev" 前 6 字符 = "agent-" (含末尾连字符)
    expect(formatTaskTitle(TASK, "agent-orchestrator-dev")).toBe("agent--tab 容器");
  });

  it("中文项目名 + 中文标题 → 各截 6/12 字符", () => {
    // 标题 13 字符 → 截 12
    expect(formatTaskTitle({ ...TASK, title: "修关闭右侧激活额外" }, "智能体中台")).toBe(
      "智能体中台-修关闭右侧激活额外",
    );
  });

  it("只有项目名 → 只显示项目名", () => {
    // "agent-orchestrator-dev" 前 6 字符 = "agent-"
    expect(formatTaskTitle({ ...TASK, title: "" }, "agent-orchestrator-dev")).toBe(
      "agent-",
    );
  });

  it("只有标题 → 只显示标题", () => {
    expect(formatTaskTitle(TASK, null)).toBe("tab 容器");
  });

  it("都拿不到 → 回退 '任务 {id 前 8}'", () => {
    expect(formatTaskTitle({ ...TASK, title: "" }, null)).toBe("任务 706b1184");
    expect(formatTaskTitle({ ...TASK, title: "" }, "")).toBe("任务 706b1184");
  });

  it("surrogate pair 字符不切成半个 codepoint", () => {
    // 😀 = U+1F600, 在 JS string 里是 2 个 UTF-16 code unit.
    // Array.from 按 codepoint 切 → 截 12 不会卡在 surrogate 中间.
    const surrogate = "😀😀😀😀😀😀😀😀😀😀😀😀😀😀";
    const result = formatTaskTitle({ ...TASK, title: surrogate }, "项目");
    expect(result).toBe("项目-😀😀😀😀😀😀😀😀😀😀😀😀"); // 12 个完整 emoji
    // 不应包含单独的高/低 surrogate (会渲染成豆腐)
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("null / undefined 输入不崩", () => {
    expect(() =>
      formatTaskTitle(
        { id: "abc12345-xxxx", title: undefined },
        undefined,
      ),
    ).not.toThrow();
    expect(
      formatTaskTitle(
        { id: "abc12345-xxxx", title: undefined },
        undefined,
      ),
    ).toBe("任务 abc12345");
  });

  it("标题超过 12 字符 → 截断, 总长不超过 6+1+12=19", () => {
    const result = formatTaskTitle(
      { id: "abc12345-xxxx", title: "abcdefghijklmno" }, // 15 字符
      "p",
    );
    expect(result).toBe("p-abcdefghijkl");
    expect(result.length).toBe(14); // 1+1+12
  });

  it("项目名超过 6 字符 → 截断 (前 6 字符)", () => {
    const result = formatTaskTitle(TASK, "agent-orchestrator-dev-platform");
    // "agent-" 是前 6 字符
    expect(result).toBe("agent--tab 容器");
  });

  it("项目名刚好 6 字符 → 完整保留", () => {
    expect(formatTaskTitle(TASK, "abcdef")).toBe("abcdef-tab 容器");
  });

  it("项目名 5 字符 + 标题 12 字符 → 都完整保留", () => {
    expect(formatTaskTitle({ ...TASK, title: "abcdefghijkl" }, "12345")).toBe("12345-abcdefghijkl");
  });
});