// 2026-09-18 双实例根因的回归测试
//
// 覆盖 1 条不变量:
//   1. globalThis 单例: 两个独立模块副本 (query import 强制新实例化 = 模拟
//      Next.js instrumentation bundle 与 server bundle 各持一份模块状态)
//      调 getRuntime() 拿到的是**同一个** runtime 实例.
//
// 故意走生产分支 (临时摘掉 process.env.VITEST) — vitest 分支是模块级单例,
// 测不到跨 bundle 去重这条路径. 背景: docs/fixes/2026-09-18-queued-orphan-zombie-sdk-cwd-lock.md

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb, closeDb } from "../db";

const RUNTIME_GLOBAL_KEY = Symbol.for("agent-orchestrator.runtime");
type RuntimeHolder = { [k: symbol]: unknown };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-singleton-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // run all migrations (init() 的 recoverOrphanedTasks 要扫 tasks 表)
});

afterEach(() => {
  // 清 global key + 恢复 VITEST, 不向同 worker 后续测试文件泄漏实例
  delete (globalThis as RuntimeHolder)[RUNTIME_GLOBAL_KEY];
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRuntime 跨 bundle 单例 (globalThis 去重)", () => {
  it("两个独立模块副本拿到同一个 runtime 实例", async () => {
    delete process.env.VITEST; // 走生产分支
    try {
      // ?copy= query 让 vite 重新实例化一份独立模块图 (= 第二个 bundle)
      // (@ts-expect-error: query import 是 vite 运行时特性, tsc 静态解析不到)
      // @ts-expect-error
      const a = await import("./agent-runtime?copy=a");
      // @ts-expect-error
      const b = await import("./agent-runtime?copy=b");
      expect(a.getRuntime()).toBe(b.getRuntime());
      // 且实例挂在 globalThis 上 (跨 bundle 可见的共享锚点)
      expect((globalThis as RuntimeHolder)[RUNTIME_GLOBAL_KEY]).toBe(a.getRuntime());
    } finally {
      process.env.VITEST = "true";
    }
  });
});
