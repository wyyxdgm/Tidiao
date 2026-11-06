// vitest 全局 setup: 每个 test file 启动前强制把 ORCHESTRATOR_DB_PATH /
// ORCHESTRATOR_HOME 指向独立 tmpdir, 防止漏设 env 的测试写到生产.
//
// 背景: 2026-09-03 src/lib/db/requirement-revisions.test.ts 的 beforeEach 只设了
// ORCHESTRATOR_HOME, 漏设 ORCHESTRATOR_DB_PATH, 导致 seedUser/seedProject 把
// 2037 个 a-@x 用户 + 2037 个 name='P' 项目写到了生产 ~/.agent-orchestrator/
// orchestrator.db. 三道防线:
//   1. 测试文件自己必须显式设 ORCHESTRATOR_DB_PATH (绝大多数已经这么做了)
//   2. src/lib/db/index.ts 的 dbDir() 改成运行时读 env (兜底)
//   3. 本文件: vitest setupFiles 设默认值, 即使 (1)(2) 失效也不会落到生产
//
// 行为: setupFiles 在每个 test file 加载前跑一次, tmpdir 跟着 file 走, afterAll
// 清掉. 已经显式设 env 的 test file (101/102 个) 不受影响 — beforeEach 在
// setupFile 之后跑, 覆盖默认值.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll } from "vitest";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-default-"));
process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
process.env.ORCHESTRATOR_HOME = tmpDir;

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup, 不影响测试结果
  }
});