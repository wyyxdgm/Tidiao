// /tasks/new 页面 Ctrl/Cmd+Enter 快捷键判断逻辑单测.
//
// 关注点:
//   1. shouldTriggerSubmitOnKey 是纯函数 (仅依赖入参), 不需要 DOM mock,
//      所以能在 vitest 直接断言. 真表单集成 (preventDefault / requestSubmit)
//      留给手动 E2E, 此处只守「判断口径」, 改这个函数的人能秒验证三种按键.
//   2. 跟着改点 1: target 检查由调用方负责 (handler 里 instanceof), 函数本身
//      只看 boolean. 改「什么算 input」时要同时改 handler, 测试已经覆盖了
//      targetIsInputOrTextarea=false 这一支作为 reminder.
//   3. submitting=true 必须早退 —— 表单已经在请求中, 重复触发会双提交.
//      canSubmit=false 同理 (required 字段没填齐), 直接点按钮也是 disabled.

import { describe, it, expect } from "vitest";
import { shouldBlockClickSubmit, shouldTriggerSubmitOnKey, shouldShowSpinner, getSubmitButtonLabel, buildGoalPrompt, parseGoalRoundsInput } from "./page";

describe("shouldTriggerSubmitOnKey", () => {
  // Three primary scenarios from the spec: Ctrl+Enter / Cmd+Enter / plain Enter.
  describe("三主路径 (Ctrl/Cmd + Enter 必须触发, 单独 Enter 不触发)", () => {
    it("Ctrl+Enter 在 textarea 触发提交 (Win/Linux)", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: true, metaKey: false, targetIsInputOrTextarea: true },
          { submitting: false, canSubmit: true }
        )
      ).toBe(true);
    });

    it("Cmd+Enter 在 input 触发提交 (mac)", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: false, metaKey: true, targetIsInputOrTextarea: true },
          { submitting: false, canSubmit: true }
        )
      ).toBe(true);
    });

    it("Ctrl+Cmd+Enter (两者都按) 也触发 —— 全键盘都是 Mac, 不会冲突", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: true, metaKey: true, targetIsInputOrTextarea: true },
          { submitting: false, canSubmit: true }
        )
      ).toBe(true);
    });

    it("单纯 Enter (无 Ctrl/Cmd) 不触发 —— textarea 里就该换行", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: false, metaKey: false, targetIsInputOrTextarea: true },
          { submitting: false, canSubmit: true }
        )
      ).toBe(false);
    });
  });

  // 防误触 + 防双提交 —— 这是表单「按钮 disabled」语义在键盘层的对应.
  describe("边界: 不应触发", () => {
    it("非 input/textarea 焦点 (例如按了按钮) 不触发", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: true, metaKey: false, targetIsInputOrTextarea: false },
          { submitting: false, canSubmit: true }
        )
      ).toBe(false);
    });

    it("submitting=true (按钮已 loading) 不触发 —— 防双提交", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: true, metaKey: false, targetIsInputOrTextarea: true },
          { submitting: true, canSubmit: true }
        )
      ).toBe(false);
    });

    it("canSubmit=false (required 字段没填齐, 按钮 disabled) 不触发", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "Enter", ctrlKey: true, metaKey: false, targetIsInputOrTextarea: true },
          { submitting: false, canSubmit: false }
        )
      ).toBe(false);
    });

    it("其他键 (例如 Ctrl+S) 不触发 —— 留给浏览器默认行为", () => {
      expect(
        shouldTriggerSubmitOnKey(
          { key: "s", ctrlKey: true, metaKey: false, targetIsInputOrTextarea: true },
          { submitting: false, canSubmit: true }
        )
      ).toBe(false);
    });
  });
});

// shouldBlockClickSubmit 防止 fast-click 双提交 (R114r2 实测)。
// 背景: React setSubmitting(true) 在 React 18 batching 下不会立即应用，
// 同步事件循环里第二次点击的 handler 看到的还是 submitting=false。
// 改用 useRef.submitLockRef.current 做同步锁后,此处断言「锁住就挡」不依赖渲染时机。
describe("shouldBlockClickSubmit", () => {
  it("inFlight=true (锁持有) 阻止双提交 —— fast-click 第二下", () => {
    expect(shouldBlockClickSubmit({ inFlight: true, canSubmit: true })).toBe(true);
  });

  it("canSubmit=false (required 字段没填齐) 阻止提交 —— 按钮 disabled 也走这里", () => {
    expect(shouldBlockClickSubmit({ inFlight: false, canSubmit: false })).toBe(true);
  });

  it("inFlight=false + canSubmit=true 放行 —— 正常首次点击", () => {
    expect(shouldBlockClickSubmit({ inFlight: false, canSubmit: true })).toBe(false);
  });

  it("双阻止条件同时成立 → 仍然阻止 (短路)", () => {
    expect(shouldBlockClickSubmit({ inFlight: true, canSubmit: false })).toBe(true);
  });
});

// Spinner 显隐判断 (damo 2026-09-18 反馈: 原版只切文案, 远看察觉不到
// loading 状态, 用户在 router.push 之前的窗口期重复点). 抽成纯函数后,
// 单测断言「submitting=true 必显示」即可保证 UI 不会因 typo 退化.
describe("shouldShowSpinner", () => {
  it("submitting=true → 显示 spinner (强 loading 视觉)", () => {
    expect(shouldShowSpinner(true)).toBe(true);
  });

  it("submitting=false → 隐藏 spinner (默认态)", () => {
    expect(shouldShowSpinner(false)).toBe(false);
  });
});

// 提交按钮文案统一从 getSubmitButtonLabel 出, 三处按钮 (quick / full /
// snapshot) 共享同一口径, 改文案只需改这一处. 单测覆盖三种 mode × submitting
// 组合 + snapshot 的 editing 双态.
describe("getSubmitButtonLabel", () => {
  it("quick 模式: submitting=true → '创建启动中...', 否则 '创建并启动 →'", () => {
    expect(getSubmitButtonLabel("quick", true, false)).toBe("创建启动中...");
    expect(getSubmitButtonLabel("quick", false, false)).toBe("创建并启动 →");
  });

  it("full 模式: submitting=true → '创建中...', 否则 '创建任务'", () => {
    expect(getSubmitButtonLabel("full", true, false)).toBe("创建中...");
    expect(getSubmitButtonLabel("full", false, false)).toBe("创建任务");
  });

  it("snapshot 模式: submitting=true 优先级最高 (盖过 editing 态)", () => {
    expect(getSubmitButtonLabel("snapshot", true, false)).toBe("保存中...");
    expect(getSubmitButtonLabel("snapshot", true, true)).toBe("保存中...");
  });

  it("snapshot 模式: 非 submitting 时 editing 决定 '保存修改' vs '创建快照'", () => {
    expect(getSubmitButtonLabel("snapshot", false, true)).toBe("保存修改");
    expect(getSubmitButtonLabel("snapshot", false, false)).toBe("创建快照");
  });
});

// buildGoalPrompt 把 UI 的 goal_text 结构化字段拼回 prompt, 触发 goal loop.
//   见 page.tsx 同名函数注释 + docs/usage/18-goal-loop.md §"怎么用".
describe("buildGoalPrompt (R143 UI 集成)", () => {
  it("goalText 为空 → 原样返回 basePrompt (向后兼容, 不污染普通 task)", () => {
    expect(buildGoalPrompt("修一下登录 bug", "")).toBe("修一下登录 bug");
    expect(buildGoalPrompt("修一下登录 bug", undefined)).toBe("修一下登录 bug");
    expect(buildGoalPrompt("修一下登录 bug", null)).toBe("修一下登录 bug");
    expect(buildGoalPrompt("修一下登录 bug", "   \n  ")).toBe("修一下登录 bug");
  });

  it("basePrompt 为空 + goalText 非空 → 直接产出 marker (quick 模式合法)", () => {
    expect(buildGoalPrompt("", "docs/x.md 包含 'bar'")).toBe(
      "<goal>docs/x.md 包含 'bar'</goal>"
    );
  });

  it("两边都非空 → basePrompt + \\n\\n<goal>...</goal>", () => {
    expect(buildGoalPrompt("修 docs/foo.md", "第一段第一个词是 'bar'")).toBe(
      "修 docs/foo.md\n\n<goal>第一段第一个词是 'bar'</goal>"
    );
  });

  it("goalText 自动 trim (用户手填前后空白不污染 marker)", () => {
    expect(buildGoalPrompt("x", "  goal body  \n")).toBe("x\n\n<goal>goal body</goal>");
  });

  it("goalText 已含 `<goal>` 字面 → tolerant, 不去重也不抛错 (regex 首匹配)", () => {
    // 接受重复 marker: API 端 GOAL_MARKER_RE /<goal>([\s\S]*?)<\/goal>/ 首匹配
    // 即可, 后续 cap 4KB 也不会读到第二个 marker. 设计取舍: 简单 > 严格.
    expect(buildGoalPrompt("y", "<goal>another</goal>")).toBe(
      "y\n\n<goal><goal>another</goal></goal>"
    );
  });
});

// parseGoalRoundsInput (R143 二轮): UI 表单 → API 字段.
//   "" / 非整数 → null (不传, 走 settings 默认 20).
//   整数 → 直接传 (API 层有 [0, 1000] 范围校验, 越界返 400; R143 四轮扩上限, 0 = 不限).
describe("parseGoalRoundsInput (R143 二轮)", () => {
  it("空串 / 纯空白 → null (不传, 走 settings 默认 20)", () => {
    expect(parseGoalRoundsInput("")).toBeNull();
    expect(parseGoalRoundsInput("   ")).toBeNull();
    expect(parseGoalRoundsInput(undefined)).toBeNull();
    expect(parseGoalRoundsInput(null)).toBeNull();
  });

  it("合法整数 → 直接返回数字 (含 R143 四轮 0=不限 + 1000 上界)", () => {
    expect(parseGoalRoundsInput("0")).toBe(0); // 哨兵 = 不限轮次
    expect(parseGoalRoundsInput("1")).toBe(1);
    expect(parseGoalRoundsInput("10")).toBe(10);
    expect(parseGoalRoundsInput("20")).toBe(20);
    expect(parseGoalRoundsInput("1000")).toBe(1000); // R143 四轮新上界
    expect(parseGoalRoundsInput("  5  ")).toBe(5); // 自动 trim
  });

  it("非整数 (浮点 / 字符串 / NaN) → null, 不抛错", () => {
    expect(parseGoalRoundsInput("3.5")).toBeNull();
    expect(parseGoalRoundsInput("abc")).toBeNull();
    expect(parseGoalRoundsInput("Infinity")).toBeNull();
    expect(parseGoalRoundsInput("5,000")).toBeNull(); // 千分位逗号不是合法 number
  });

  it("越界整数 (负数 / 1001+) → 仍返回数字 (API 层报 400 GOAL_ROUNDS_INVALID)", () => {
    // UI 不预校验范围, 让 API 单点防御 + 错误信息更准.
    // 注意 0 已合法 (R143 四轮哨兵), 不在此列.
    expect(parseGoalRoundsInput("-1")).toBe(-1);
    expect(parseGoalRoundsInput("1001")).toBe(1001);
    expect(parseGoalRoundsInput("9999")).toBe(9999);
  });
});
