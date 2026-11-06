// Goal-loop 配置项边界 case 单测 (D18, plan §阶段 5 / §9.3).
//
// 覆盖三个新 helper 的边界:
//   - getGoalResumeThreshold()   浮点 [0.0, 1.0], 默认 0.8
//   - getMaxGoalRounds()         整数 [1, 20],   默认 5
//   - getGoalGraderModel()       字符串非空,    默认 claude-haiku-4-5-20251001
//
// 模式: 真 SQLite 临时库 (与 src/lib/db/port-pool.test.ts / schedules.test.ts 一致).
//   vitest.setup.ts 已默认设 ORCHESTRATOR_DB_PATH / ORCHESTRATOR_HOME 到 tmpdir,
//   这里 beforeEach 再覆盖一次以确保隔离 (端口池测试也可能跑同一进程).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { closeDb, getDb } from "./index";
import {
  KEY_GOAL_GRADER_MODEL,
  KEY_GOAL_RESUME_THRESHOLD,
  KEY_MAX_GOAL_ROUNDS,
  DEFAULT_GOAL_GRADER_MODEL,
  DEFAULT_GOAL_RESUME_THRESHOLD,
  DEFAULT_MAX_GOAL_ROUNDS,
  MIN_MAX_GOAL_ROUNDS,
  MAX_MAX_GOAL_ROUNDS,
  getGoalGraderModel,
  getGoalResumeThreshold,
  getMaxGoalRounds,
  setSetting,
} from "./settings";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-settings-goal-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  // 清掉本文件里所有 vi.spyOn 留下的 console.warn mock, 避免跨测试累积.
  vi.restoreAllMocks();
});

// 抹掉 console.warn 以避免脏值用例刷屏 (vitest 默认会显示). 这里还原给个别断言.
function silenceConsoleWarn(): () => void {
  const original = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = original;
  };
}

describe("getGoalResumeThreshold (D18 浮点 [0.0, 1.0])", () => {
  it("app_settings 没设 → 返回默认 0.8", () => {
    expect(getGoalResumeThreshold()).toBe(DEFAULT_GOAL_RESUME_THRESHOLD);
    expect(getGoalResumeThreshold()).toBe(0.8);
  });

  it("设 0.0 → 返回 0.0 (合法下界 = 永远 fork)", () => {
    setSetting(KEY_GOAL_RESUME_THRESHOLD, "0.0");
    expect(getGoalResumeThreshold()).toBe(0.0);
  });

  it("设 1.0 → 返回 1.0 (合法上界 = 永远 resume)", () => {
    setSetting(KEY_GOAL_RESUME_THRESHOLD, "1.0");
    expect(getGoalResumeThreshold()).toBe(1.0);
  });

  it("设中间值 0.5 → 返回 0.5", () => {
    setSetting(KEY_GOAL_RESUME_THRESHOLD, "0.5");
    expect(getGoalResumeThreshold()).toBe(0.5);
  });

  it("设 0 (整数) → 返回 0.0 (parseFloatInRange 不区分整数/小数)", () => {
    setSetting(KEY_GOAL_RESUME_THRESHOLD, "0");
    expect(getGoalResumeThreshold()).toBe(0.0);
  });

  it("设 NaN → 警告 + 回退默认 0.8", () => {
    const restore = silenceConsoleWarn();
    try {
      // 库里写 NaN 字符串 = 非数字, parseFloatInRange(Number("NaN"))=NaN → isFinite=false
      setSetting(KEY_GOAL_RESUME_THRESHOLD, "NaN");
      expect(getGoalResumeThreshold()).toBe(0.8);
    } finally {
      restore();
    }
  });

  it("设 'abc' → 警告 + 回退默认 0.8", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_GOAL_RESUME_THRESHOLD, "abc");
      expect(getGoalResumeThreshold()).toBe(0.8);
    } finally {
      restore();
    }
  });

  it("设 1.5 (超 [0,1]) → 警告 + 回退默认 0.8", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_GOAL_RESUME_THRESHOLD, "1.5");
      expect(getGoalResumeThreshold()).toBe(0.8);
    } finally {
      restore();
    }
  });

  it("设 -0.1 (负数) → 警告 + 回退默认 0.8", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_GOAL_RESUME_THRESHOLD, "-0.1");
      expect(getGoalResumeThreshold()).toBe(0.8);
    } finally {
      restore();
    }
  });

  it("设 Infinity 字符串 → 警告 + 回退默认 0.8 (isFinite=false)", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_GOAL_RESUME_THRESHOLD, "Infinity");
      expect(getGoalResumeThreshold()).toBe(0.8);
    } finally {
      restore();
    }
  });
});

describe("getMaxGoalRounds (D18 整数 · R143 二轮默认 20 · R143 四轮范围 [0, 1000])", () => {
  it("app_settings 没设 → 返回默认 20 (R143 二轮改自 5)", () => {
    expect(getMaxGoalRounds()).toBe(DEFAULT_MAX_GOAL_ROUNDS);
    expect(getMaxGoalRounds()).toBe(20);
  });

  it("设 0 (R143 四轮新下界, 哨兵「不限」) → 返回 0 (不警告, 不回退)", () => {
    // R143 四轮: 0 是 sentinel, 不是「超界」. getMaxGoalRounds() 直返.
    // 0 在 continueGoalLoop 里触发「跳过 giveUp」语义.
    setSetting(KEY_MAX_GOAL_ROUNDS, "0");
    expect(getMaxGoalRounds()).toBe(MIN_MAX_GOAL_ROUNDS);
    expect(getMaxGoalRounds()).toBe(0);
  });

  it("设 1001 (R143 四轮新上界 1000 + 1) → 警告 + 回退默认 20", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_MAX_GOAL_ROUNDS, "1001");
      expect(getMaxGoalRounds()).toBe(20);
    } finally {
      restore();
    }
  });

  it("设 1 → 返回 1", () => {
    setSetting(KEY_MAX_GOAL_ROUNDS, "1");
    expect(getMaxGoalRounds()).toBe(1);
  });

  it("设 1000 (R143 四轮新上界) → 返回 1000", () => {
    setSetting(KEY_MAX_GOAL_ROUNDS, "1000");
    expect(getMaxGoalRounds()).toBe(MAX_MAX_GOAL_ROUNDS);
    expect(getMaxGoalRounds()).toBe(1000);
  });

  it("设 20 (历史默认) → 返回 20", () => {
    setSetting(KEY_MAX_GOAL_ROUNDS, "20");
    expect(getMaxGoalRounds()).toBe(20);
  });

  it("设 'abc' → 警告 + 回退默认 20", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_MAX_GOAL_ROUNDS, "abc");
      expect(getMaxGoalRounds()).toBe(20);
    } finally {
      restore();
    }
  });

  it("设 5.5 (非整数) → 警告 + 回退默认 20", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_MAX_GOAL_ROUNDS, "5.5");
      expect(getMaxGoalRounds()).toBe(20);
    } finally {
      restore();
    }
  });

  it("设负数 -1 → 警告 + 回退默认 20", () => {
    const restore = silenceConsoleWarn();
    try {
      setSetting(KEY_MAX_GOAL_ROUNDS, "-1");
      expect(getMaxGoalRounds()).toBe(20);
    } finally {
      restore();
    }
  });
});

describe("getGoalGraderModel (D18 字符串非空)", () => {
  it("app_settings 没设 → 返回默认 haiku 4.5", () => {
    expect(getGoalGraderModel()).toBe(DEFAULT_GOAL_GRADER_MODEL);
    expect(getGoalGraderModel()).toBe("claude-haiku-4-5-20251001");
  });

  it("设 'claude-opus-4-8' → 返回 opus", () => {
    setSetting(KEY_GOAL_GRADER_MODEL, "claude-opus-4-8");
    expect(getGoalGraderModel()).toBe("claude-opus-4-8");
  });

  it("设空字符串 '' → 回退默认 (与 null 等价)", () => {
    setSetting(KEY_GOAL_GRADER_MODEL, "");
    expect(getGoalGraderModel()).toBe(DEFAULT_GOAL_GRADER_MODEL);
  });

  it("设纯空格 '   ' → 回退默认 (trim 后为空)", () => {
    setSetting(KEY_GOAL_GRADER_MODEL, "   ");
    expect(getGoalGraderModel()).toBe(DEFAULT_GOAL_GRADER_MODEL);
  });

  it("设带前后空格的合法值 '  claude-haiku-4-5-20251001  ' → trim 后返回", () => {
    setSetting(KEY_GOAL_GRADER_MODEL, "  claude-haiku-4-5-20251001  ");
    expect(getGoalGraderModel()).toBe("claude-haiku-4-5-20251001");
  });
});

describe("脏值回退 - warn 行为验证 (D18 隐含)", () => {
  it("脏值真触发 console.warn (parseFloatInRange 走回退分支)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSetting(KEY_GOAL_RESUME_THRESHOLD, "abc");
    getGoalResumeThreshold();
    expect(warnSpy).toHaveBeenCalled();
    // 取最新一条 settings 警告 (getDb() 自身可能有 migration warn 噪声).
    const settingsCalls = warnSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes("[settings]"));
    expect(settingsCalls.length).toBeGreaterThan(0);
    const msg = settingsCalls.at(-1)!;
    expect(msg).toContain(KEY_GOAL_RESUME_THRESHOLD);
    expect(msg).toContain("abc");
    expect(msg).toContain("0-1 浮点数");
  });

  it("整型脏值也走回退 (parseIntInRange 走回退分支)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSetting(KEY_MAX_GOAL_ROUNDS, "abc");
    getMaxGoalRounds();
    expect(warnSpy).toHaveBeenCalled();
    const settingsCalls = warnSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes("[settings]"));
    expect(settingsCalls.length).toBeGreaterThan(0);
    const msg = settingsCalls.at(-1)!;
    expect(msg).toContain(KEY_MAX_GOAL_ROUNDS);
    expect(msg).toContain("abc");
    expect(msg).toContain(`${MIN_MAX_GOAL_ROUNDS}-${MAX_MAX_GOAL_ROUNDS}`);
  });

  it("合法值不触发 [settings] warn (避免日志噪音)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSetting(KEY_GOAL_RESUME_THRESHOLD, "0.5");
    setSetting(KEY_MAX_GOAL_ROUNDS, "3");
    getGoalResumeThreshold();
    getMaxGoalRounds();
    // 只验证 "[settings]" 前缀的警告没出现; 其它 (如 migration) 是 DB 层噪声,
    // 不是本测试关心的回退行为.
    const settingsCalls = warnSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes("[settings]"));
    expect(settingsCalls).toEqual([]);
  });
});