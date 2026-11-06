// 全局设置回归测试（v39/v40: app_settings KV + projects.timeout_minutes）
//
// 覆盖两个设置: 壁钟超时(项目可覆盖) + 全局并发上限(无项目级)。守三件事:
//   1. 解析链 project 列 → app_settings → 硬编码默认 的优先级不被改乱。
//      每一层错位都是「改了没生效」类问题, 排查很贵(要等 30 分钟才看得出来)。
//      (曾有一层 ORCHESTRATOR_* env 种子, 2026-08-13 删掉了 —— 见 db/settings.ts 文件头)
//   2. **落库**: 设置过的值在关掉重开连接后仍在 —— 这是引入 app_settings 的全部理由
//      (并发以前只改内存, pm2 重启回落到 2, 踩过「以为调好了、重启就没了」)。
//   3. 任何脏值都不能算出 0 / NaN —— setTimeout(0) 等于任务一启动就被挂起,
//      并发 0 等于一个任务都不跑, 两者在 DB 里都看不出任何异常。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// agent-runtime 顶层会 import SDK, 这里不跑任何真实会话, stub 掉即可。
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { resolveTaskTimeoutMs, AgentRuntime } from "./agent-runtime";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject, updateProject } from "../db/projects";
import {
  getGlobalTaskTimeoutMinutes,
  setGlobalTaskTimeoutMinutes,
  setSetting,
  KEY_TASK_TIMEOUT_MINUTES,
  DEFAULT_TASK_TIMEOUT_MINUTES,
  MAX_TASK_TIMEOUT_MINUTES,
  KEY_MAX_CONCURRENCY,
  DEFAULT_MAX_CONCURRENCY,
  MAX_MAX_CONCURRENCY,
  getGlobalMaxConcurrency,
  setGlobalMaxConcurrency,
  // 🆕 R79: schedule_runs 清理阈值
  getGlobalScheduleRunsTtlDays,
  setGlobalScheduleRunsTtlDays,
  getGlobalScheduleRunsKeepLastN,
  setGlobalScheduleRunsKeepLastN,
  DEFAULT_SCHEDULE_RUNS_TTL_DAYS,
  DEFAULT_SCHEDULE_RUNS_KEEP_LAST_N,
  MAX_SCHEDULE_RUNS_TTL_DAYS,
  MAX_SCHEDULE_RUNS_KEEP_LAST_N,
  KEY_SCHEDULE_RUNS_TTL_DAYS,
  KEY_SCHEDULE_RUNS_KEEP_LAST_N,
  // 🆕 DAG P3 (B5 拍板 2026-09-06): 平台级 master switch
  resolveVerificationGloballyEnabled,
  setVerificationGloballyEnabled,
  KEY_VERIFICATION_GLOBALLY_ENABLED,
} from "../db/settings";

let tmpDir: string;
let projectId: string;

// 只有 project_id 参与超时解析, 其余字段不影响判据。
function fakeTask(project_id: string | null): Task {
  return { id: "task-1", project_id } as Task;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-timeout-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_TIMEOUT_MIN;
  delete process.env.ORCHESTRATOR_MAX_CONCURRENCY;
  closeDb();
  getDb(); // 跑 migration
  projectId = createProject({ name: "p" }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_TASK_TIMEOUT_MIN;
  delete process.env.ORCHESTRATOR_MAX_CONCURRENCY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("全局默认超时", () => {
  it("什么都没配 = 30 分钟(与本特性上线前的硬编码值一致)", () => {
    expect(getGlobalTaskTimeoutMinutes()).toBe(30);
    expect(DEFAULT_TASK_TIMEOUT_MINUTES).toBe(30);
    expect(resolveTaskTimeoutMs(fakeTask(projectId))).toBe(30 * 60 * 1000);
  });

  it("设过就以库为准", () => {
    setGlobalTaskTimeoutMinutes(90);
    expect(getGlobalTaskTimeoutMinutes()).toBe(90);
  });

  it("不认 ORCHESTRATOR_TASK_TIMEOUT_MIN(2026-08-13 删除的 env 种子, 别再加回来)", () => {
    process.env.ORCHESTRATOR_TASK_TIMEOUT_MIN = "45";
    expect(getGlobalTaskTimeoutMinutes()).toBe(30);
  });

  it("落库后重开连接仍在(这是加 app_settings 的全部理由)", () => {
    setGlobalTaskTimeoutMinutes(120);
    closeDb();
    getDb();
    expect(getGlobalTaskTimeoutMinutes()).toBe(120);
  });

  it("非法值抛错而不是静默夹取到边界", () => {
    expect(() => setGlobalTaskTimeoutMinutes(0)).toThrow(/1-1440/);
    expect(() => setGlobalTaskTimeoutMinutes(MAX_TASK_TIMEOUT_MINUTES + 1)).toThrow(/1-1440/);
    expect(() => setGlobalTaskTimeoutMinutes(1.5)).toThrow(/1-1440/);
    expect(() => setGlobalTaskTimeoutMinutes("abc")).toThrow(/1-1440/);
    expect(getGlobalTaskTimeoutMinutes()).toBe(30); // 一个都没写进去
  });

  it("库里被手工写进脏值时降级为默认值, 不抛错也不返回 NaN", () => {
    setSetting(KEY_TASK_TIMEOUT_MINUTES, "abc");
    expect(getGlobalTaskTimeoutMinutes()).toBe(30);
    setSetting(KEY_TASK_TIMEOUT_MINUTES, "0");
    expect(getGlobalTaskTimeoutMinutes()).toBe(30);
  });
});

describe("项目级超时覆盖", () => {
  it("project.timeout_minutes 覆盖全局默认", () => {
    setGlobalTaskTimeoutMinutes(30);
    updateProject(projectId, { timeout_minutes: 180 });
    expect(resolveTaskTimeoutMs(fakeTask(projectId))).toBe(180 * 60 * 1000);
  });

  it("置 null = 恢复继承全局", () => {
    updateProject(projectId, { timeout_minutes: 180 });
    setGlobalTaskTimeoutMinutes(60);
    updateProject(projectId, { timeout_minutes: null });
    expect(resolveTaskTimeoutMs(fakeTask(projectId))).toBe(60 * 60 * 1000);
  });

  it("存量项目(从未设置过)行为与上线前完全一致", () => {
    const fresh = createProject({ name: "fresh" });
    expect(fresh.timeout_minutes).toBeNull();
    expect(resolveTaskTimeoutMs(fakeTask(fresh.id))).toBe(30 * 60 * 1000);
  });

  it("非法值抛错(PATCH 路由据此回 400), 不静默写库", () => {
    expect(() => updateProject(projectId, { timeout_minutes: 0 })).toThrow(/1-1440/);
    expect(() => updateProject(projectId, { timeout_minutes: 2000 })).toThrow(/1-1440/);
    expect(() => updateProject(projectId, { timeout_minutes: 1.5 })).toThrow(/1-1440/);
  });

  it("手工 SQL 写进列里的脏值回退全局值, 绝不算出 0", () => {
    setGlobalTaskTimeoutMinutes(60);
    getDb().prepare("UPDATE projects SET timeout_minutes = 0 WHERE id = ?").run(projectId);
    expect(resolveTaskTimeoutMs(fakeTask(projectId))).toBe(60 * 60 * 1000);
  });

  it("无项目的系统任务(project_id = NULL)走全局值", () => {
    setGlobalTaskTimeoutMinutes(15);
    expect(resolveTaskTimeoutMs(fakeTask(null))).toBe(15 * 60 * 1000);
  });

  it("改完立刻生效(不缓存 project 行, 同 cwdLimit 的判据)", () => {
    expect(resolveTaskTimeoutMs(fakeTask(projectId))).toBe(30 * 60 * 1000);
    updateProject(projectId, { timeout_minutes: 5 });
    expect(resolveTaskTimeoutMs(fakeTask(projectId))).toBe(5 * 60 * 1000);
  });
});

describe("全局并发上限（v39 起落库）", () => {
  it("什么都没配 = 2(与落库前的缺省一致)", () => {
    expect(getGlobalMaxConcurrency()).toBe(2);
    expect(DEFAULT_MAX_CONCURRENCY).toBe(2);
  });

  it("设过就以库为准", () => {
    setGlobalMaxConcurrency(8);
    expect(getGlobalMaxConcurrency()).toBe(8);
  });

  it("不认 ORCHESTRATOR_MAX_CONCURRENCY(2026-08-13 删除的 env 种子, 别再加回来)", () => {
    process.env.ORCHESTRATOR_MAX_CONCURRENCY = "5";
    expect(getGlobalMaxConcurrency()).toBe(2);
  });

  it("落库后重开连接仍在(pm2 重启不再回落到 2)", () => {
    setGlobalMaxConcurrency(7);
    closeDb();
    getDb();
    expect(getGlobalMaxConcurrency()).toBe(7);
  });

  it("新起的 runtime 用库里的值初始化调度器(= 重启后仍生效的判据)", () => {
    setGlobalMaxConcurrency(4);
    const rt = new AgentRuntime();
    expect(rt.getScheduler().getConcurrency()).toBe(4);
  });

  it("非法值抛错, 不静默夹取到边界", () => {
    expect(() => setGlobalMaxConcurrency(0)).toThrow(/1-10/);
    expect(() => setGlobalMaxConcurrency(MAX_MAX_CONCURRENCY + 1)).toThrow(/1-10/);
    expect(() => setGlobalMaxConcurrency(2.5)).toThrow(/1-10/);
    expect(getGlobalMaxConcurrency()).toBe(2);
  });

  it("库里被手工写进脏值时降级为 2, 不返回 0/NaN(并发 0 = 一个任务都不跑)", () => {
    setSetting(KEY_MAX_CONCURRENCY, "0");
    expect(getGlobalMaxConcurrency()).toBe(2);
    setSetting(KEY_MAX_CONCURRENCY, "many");
    expect(getGlobalMaxConcurrency()).toBe(2);
  });

  it("两个设置互不干扰(同一张 KV 表, key 别写串)", () => {
    setGlobalMaxConcurrency(6);
    setGlobalTaskTimeoutMinutes(90);
    expect(getGlobalMaxConcurrency()).toBe(6);
    expect(getGlobalTaskTimeoutMinutes()).toBe(90);
    expect(KEY_MAX_CONCURRENCY).not.toBe(KEY_TASK_TIMEOUT_MINUTES);
  });
});

// 🆕 飞书 R79: schedule_runs 清理阈值
// 覆盖:
//   - 默认 30 天 / 100 条与上线前硬编码值一致
//   - setter 落库 + getter 即时读回
//   - 0 是合法值（=关闭该维度）, 必须能写入; 但其它非法值仍要拒
//   - 脏值降级: 库里被手工写进非数字, 不返 NaN
//   - 互不干扰（与 max_concurrency / timeout 共存一张表）
describe("schedule_runs 清理阈值 (R79)", () => {
  it("什么都没配 = 默认 30 天 + 100 条", () => {
    expect(DEFAULT_SCHEDULE_RUNS_TTL_DAYS).toBe(30);
    expect(DEFAULT_SCHEDULE_RUNS_KEEP_LAST_N).toBe(100);
    expect(getGlobalScheduleRunsTtlDays()).toBe(30);
    expect(getGlobalScheduleRunsKeepLastN()).toBe(100);
  });

  it("setter 落库 + getter 即时读回", () => {
    expect(setGlobalScheduleRunsTtlDays(7)).toBe(7);
    expect(getGlobalScheduleRunsTtlDays()).toBe(7);
    expect(setGlobalScheduleRunsKeepLastN(50)).toBe(50);
    expect(getGlobalScheduleRunsKeepLastN()).toBe(50);
  });

  it("0 是合法值 (= 关闭该层清理), 不能被拒", () => {
    expect(setGlobalScheduleRunsTtlDays(0)).toBe(0);
    expect(getGlobalScheduleRunsTtlDays()).toBe(0);
    expect(setGlobalScheduleRunsKeepLastN(0)).toBe(0);
    expect(getGlobalScheduleRunsKeepLastN()).toBe(0);
  });

  it("越界值抛错, 不写库", () => {
    expect(() => setGlobalScheduleRunsTtlDays(-1)).toThrow();
    expect(getGlobalScheduleRunsTtlDays()).toBe(30);
    expect(() => setGlobalScheduleRunsTtlDays(MAX_SCHEDULE_RUNS_TTL_DAYS + 1)).toThrow();
    expect(() => setGlobalScheduleRunsKeepLastN(MAX_SCHEDULE_RUNS_KEEP_LAST_N + 1)).toThrow();
  });

  it("非整数 / 字符串 / NaN 抛错", () => {
    expect(() => setGlobalScheduleRunsTtlDays(1.5)).toThrow();
    expect(() => setGlobalScheduleRunsTtlDays("abc")).toThrow();
    expect(() => setGlobalScheduleRunsKeepLastN(NaN)).toThrow();
  });

  it("库里被手工写脏值时降级到默认, 不返 NaN", () => {
    setSetting(KEY_SCHEDULE_RUNS_TTL_DAYS, "many");
    expect(getGlobalScheduleRunsTtlDays()).toBe(30);
    setSetting(KEY_SCHEDULE_RUNS_TTL_DAYS, "99999999"); // 越界
    expect(getGlobalScheduleRunsTtlDays()).toBe(30);
    setSetting(KEY_SCHEDULE_RUNS_KEEP_LAST_N, "NaN");
    expect(getGlobalScheduleRunsKeepLastN()).toBe(100);
  });

  it("四个设置互不干扰 (KEY_* 不重)", () => {
    setGlobalMaxConcurrency(6);
    setGlobalTaskTimeoutMinutes(90);
    setGlobalScheduleRunsTtlDays(7);
    setGlobalScheduleRunsKeepLastN(50);
    expect(getGlobalMaxConcurrency()).toBe(6);
    expect(getGlobalTaskTimeoutMinutes()).toBe(90);
    expect(getGlobalScheduleRunsTtlDays()).toBe(7);
    expect(getGlobalScheduleRunsKeepLastN()).toBe(50);
    const allKeys = new Set([
      KEY_MAX_CONCURRENCY,
      KEY_TASK_TIMEOUT_MINUTES,
      KEY_SCHEDULE_RUNS_TTL_DAYS,
      KEY_SCHEDULE_RUNS_KEEP_LAST_N,
    ]);
    expect(allKeys.size).toBe(4);
  });
});

// DAG P3 (B5 拍板 2026-09-06): 平台级 master switch. 默认 false —— 与今天
// byte-identical 行为. 三条核心断言:
//   1) 缺值返 false (B5: 「默认关」);
//   2) 'true' 返 true (PATCH /api/config 落库后即时生效, 不缓存);
//   3) '1' 返 true (setter 兼容性, 也允许数字 1);
// 顺手守「非法输入抛错 + 写库覆盖 + 跨 key 不互相污染」三条不变量.
describe("DAG P3 平台级 master switch (verification_globally_enabled)", () => {
  it("缺值返 false (B5 默认关 = 与今天 byte-identical 行为)", () => {
    expect(resolveVerificationGloballyEnabled()).toBe(false);
  });

  it("setter true / 'true' / '1' / 1 / boolean true 都返 true, 写库后即时生效", () => {
    setVerificationGloballyEnabled(true);
    expect(resolveVerificationGloballyEnabled()).toBe(true);
    setVerificationGloballyEnabled("true");
    expect(resolveVerificationGloballyEnabled()).toBe(true);
    setVerificationGloballyEnabled("1");
    expect(resolveVerificationGloballyEnabled()).toBe(true);
    setVerificationGloballyEnabled(1);
    expect(resolveVerificationGloballyEnabled()).toBe(true);
  });

  it("非法输入抛错 (字符串 'yes' / 对象 / 浮点) — PATCH /api/config 据此回 400", () => {
    expect(() => setVerificationGloballyEnabled("yes")).toThrow(/boolean/);
    expect(() => setVerificationGloballyEnabled({})).toThrow(/boolean/);
    expect(() => setVerificationGloballyEnabled(0.5)).toThrow(/boolean/);
    // 非法不能写库 —— 跑完上面三条, L1 仍应该是 false (默认), 不是被部分写入的脏值
    expect(resolveVerificationGloballyEnabled()).toBe(false);
  });

  it("改完 false 后立刻生效, 不缓存 (与 task_timeout_minutes 模式一致)", () => {
    setVerificationGloballyEnabled(true);
    expect(resolveVerificationGloballyEnabled()).toBe(true);
    setVerificationGloballyEnabled(false);
    expect(resolveVerificationGloballyEnabled()).toBe(false);
  });

  it("KEY_VERIFICATION_GLOBALLY_ENABLED 与其它 KV 互不污染 (key 名常量稳定)", () => {
    setGlobalTaskTimeoutMinutes(60);
    setVerificationGloballyEnabled(true);
    expect(getGlobalTaskTimeoutMinutes()).toBe(60);
    expect(resolveVerificationGloballyEnabled()).toBe(true);
    expect(KEY_VERIFICATION_GLOBALLY_ENABLED).toBe("verification_globally_enabled");
  });
});
