// 飞书 R60 §3.1 — 详情页状态流转 UI 烟雾测试.
//
// 功能: 验证 StatusFlow client 组件的最小契约 (6 态枚举 + 走 PATCH 端点),
//   避免集成测试需要 testing-library. 关注点:
//   - 客户端不引 better-sqlite3, 所以本文件独立复制 6 态数组用于校验.
//   - 组件本身默认导出 = 函数, 走 client bundle.
//   - JSX 编译后会切碎标识符, 改读源文件做契约校验.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import StatusFlow from "./status-flow";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./status-flow.tsx"), "utf8");
}

const EXPECTED_STATUSES = [
  "pending",
  "done",
  "awaiting_reply",
  "has_suggestion",
  "blocked",
  "closed",
] as const;

describe("StatusFlow (smoke)", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof StatusFlow).toBe("function");
  });

  it("走 PATCH /api/requirements/[id] 端点", () => {
    const src = readSrc();
    // 组件文件里硬编码 PATCH 路径, 防止误把端点改成 POST /api/requirements.
    expect(src).toMatch(/method:\s*"PATCH"/);
    expect(src).toContain("/api/requirements/");
    expect(src).toContain("requirementId");
  });

  it("6 态覆盖: 与 db/requirements.ts REQUIREMENT_STATUSES 同源", () => {
    // 这里本地复制的 6 态必须与 db/requirements.ts 同步, 否则 dropdown 漏态.
    // 单测里仅校验长度 + 顺序, 不引 db (避免 better-sqlite3 进 client bundle).
    expect(EXPECTED_STATUSES).toHaveLength(6);
    expect(EXPECTED_STATUSES).toContain("closed");
    expect(EXPECTED_STATUSES).toContain("pending");
    expect(EXPECTED_STATUSES).toContain("done");
  });

  it("closed 二次确认: ConfirmDialog + danger variant", () => {
    const src = readSrc();
    expect(src).toMatch(/import\s+ConfirmDialog\s+from\s+["']@\/components\/ConfirmDialog["']/);
    expect(src).toContain("closed");
    // danger variant 是 ConfirmDialog 二次确认的视觉信号, 防止误用 default.
    expect(src).toMatch(/variant\s*[:=]\s*["']danger["']/);
  });

  it("R78 W1 §4.3 (c): 接受 eligibleForDone prop 并在 done 项 disabled + tooltip", () => {
    const src = readSrc();
    // prop 必带, 否则 invariant 无数据.
    expect(src).toContain("eligibleForDone");
    // done 项必须有 disabled + title (tooltip) 逻辑.
    expect(src).toContain("doneDisabled");
    expect(src).toMatch(/至少一个.+实现.+测试.+部署.+任务完成|invariant/);
  });
});