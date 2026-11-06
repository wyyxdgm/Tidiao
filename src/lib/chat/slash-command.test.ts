// R143 五轮 (damo 2026-09-15): parseSlashCommand + intervalToCron 单测.
//   见 src/lib/chat/slash-command.ts 同名函数注释 + docs/usage/18-goal-loop.md.

import { describe, it, expect } from "vitest";
import { parseSlashCommand, intervalToCron } from "./slash-command";

describe("parseSlashCommand (R143 五轮 chat slash command)", () => {
  it("不以 / 开头 → none (走普通消息)", () => {
    expect(parseSlashCommand("hello world")).toEqual({ kind: "none" });
    expect(parseSlashCommand("")).toEqual({ kind: "none" });
    expect(parseSlashCommand("  普通消息")).toEqual({ kind: "none" });
  });

  it("/goal <prompt> → kind: goal + 提纯 prompt", () => {
    expect(parseSlashCommand("/goal docs/x.md 含 bar")).toEqual({
      kind: "goal",
      prompt: "docs/x.md 含 bar",
    });
  });

  it("/goal 大小写不敏感 + 自动 trim", () => {
    expect(parseSlashCommand("/GOAL 修 foo")).toEqual({
      kind: "goal",
      prompt: "修 foo",
    });
    expect(parseSlashCommand("  /goal   修 foo  ")).toEqual({
      kind: "goal",
      prompt: "修 foo",
    });
  });

  it("/goal 后无 prompt → kind: goal + 空 prompt (caller 报「请输入目标」)", () => {
    expect(parseSlashCommand("/goal")).toEqual({ kind: "goal", prompt: "" });
    expect(parseSlashCommand("/goal ")).toEqual({ kind: "goal", prompt: "" });
  });

  it("/loop [interval] <prompt> → kind: loop + cronExpr", () => {
    const cmd = parseSlashCommand("/loop 30m 修 docs/x.md 含 bar");
    expect(cmd.kind).toBe("loop");
    if (cmd.kind === "loop") {
      expect(cmd.interval).toBe("30m");
      expect(cmd.prompt).toBe("修 docs/x.md 含 bar");
      expect(cmd.cronExpr).toBe("*/30 * * * *");
    }
  });

  it("/loop 大小写不敏感 + 多种 interval 简写", () => {
    expect(parseSlashCommand("/LOOP 2h 修 bug")).toMatchObject({
      kind: "loop",
      interval: "2h",
      prompt: "修 bug",
      cronExpr: "0 */2 * * *",
    });
    expect(parseSlashCommand("/loop 1d 每天任务")).toMatchObject({
      kind: "loop",
      interval: "1d",
      cronExpr: "0 9 * * *",
    });
  });

  it("/loop 后无 prompt → kind: loop + 空 prompt (caller 提示)", () => {
    const cmd = parseSlashCommand("/loop 30m");
    expect(cmd.kind).toBe("loop");
    if (cmd.kind === "loop") {
      expect(cmd.prompt).toBe("");
      expect(cmd.cronExpr).toBe("*/30 * * * *");
    }
  });

  it("/loop 格式错 (interval 不合法) → none (caller 报「无法识别」)", () => {
    expect(parseSlashCommand("/loop 30 修 bug")).toEqual({ kind: "none" });
    expect(parseSlashCommand("/loop abc 修 bug")).toEqual({ kind: "none" });
    expect(parseSlashCommand("/loop 0m 修 bug")).toEqual({ kind: "none" });
    expect(parseSlashCommand("/loop 60m 修 bug")).toEqual({ kind: "none" }); // > 59
    expect(parseSlashCommand("/loop 24h 修 bug")).toEqual({ kind: "none" }); // > 23
    expect(parseSlashCommand("/loop 2d 修 bug")).toEqual({ kind: "none" }); // v1 只支持 1d
  });

  it("未知 slash 命令 (/exit /foo 等) → none 不拦截, 走普通消息", () => {
    // 宽容原则: 不在白名单的 /xxx 当普通文本, 不吞.
    expect(parseSlashCommand("/exit")).toEqual({ kind: "none" });
    expect(parseSlashCommand("/foo bar")).toEqual({ kind: "none" });
  });
});

describe("intervalToCron (R143 五轮 简写 → cron 表达式)", () => {
  it("Nm → */N * * * * (每 N 分钟)", () => {
    expect(intervalToCron("1m")).toBe("*/1 * * * *");
    expect(intervalToCron("30m")).toBe("*/30 * * * *");
    expect(intervalToCron("59m")).toBe("*/59 * * * *");
  });

  it("Nh → 0 */N * * * (每 N 小时, 整点)", () => {
    expect(intervalToCron("1h")).toBe("0 */1 * * *");
    expect(intervalToCron("2h")).toBe("0 */2 * * *");
    expect(intervalToCron("23h")).toBe("0 */23 * * *");
  });

  it("Nd → 0 9 * * * (v1 仅 1d, 每天 9 点首次)", () => {
    expect(intervalToCron("1d")).toBe("0 9 * * *");
  });

  it("大小写不敏感 + 自动 trim", () => {
    expect(intervalToCron(" 30M ")).toBe("*/30 * * * *");
    expect(intervalToCron("2H")).toBe("0 */2 * * *");
  });

  it("格式错 → null", () => {
    expect(intervalToCron("")).toBeNull();
    expect(intervalToCron("30")).toBeNull(); // 缺单位
    expect(intervalToCron("30x")).toBeNull(); // 不支持的单位
    expect(intervalToCron("0m")).toBeNull(); // 0
    expect(intervalToCron("60m")).toBeNull(); // 超 59
    expect(intervalToCron("24h")).toBeNull(); // 超 23
    expect(intervalToCron("2d")).toBeNull(); // v1 仅 1d
  });
});

describe("parseSlashCommand /clearhistory (R179 输入历史清除)", () => {
  it("/clearhistory → kind: clearhistory", () => {
    expect(parseSlashCommand("/clearhistory")).toEqual({ kind: "clearhistory" });
  });

  it("大小写不敏感 + 前导空白忽略 + 尾随文本忽略", () => {
    expect(parseSlashCommand("/CLEARHISTORY")).toEqual({ kind: "clearhistory" });
    expect(parseSlashCommand("  /clearhistory  ")).toEqual({
      kind: "clearhistory",
    });
    expect(parseSlashCommand("/clearhistory now")).toEqual({
      kind: "clearhistory",
    });
  });

  it("相近词不清真: /clearhistoryx → none (word boundary)", () => {
    expect(parseSlashCommand("/clearhistoryx")).toEqual({ kind: "none" });
    expect(parseSlashCommand("/clear")).toEqual({ kind: "none" });
  });
});
