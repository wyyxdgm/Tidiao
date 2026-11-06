// GET /api/tasks/[id] 总结字段直读的回归测试 (R200 收尾预热 + 详情接口直带).
//
// 背景: 收尾预热 (active-session warmResultLayersForTask / warmCardSummaryForTask)
// 把总结写进 tasks.metadata 缓存. 本批次起详情接口把缓存解析后直带在响应里
// (card_summary / result_layers), SPA 信息面板直接渲染, 不再调 Console 的两个
// 按需接口 (result-layers / card-summary 路由).
//
// 关注点:
//   - 没预热/缓存缺失 → 字段存在且为 null (前端隐藏模块, 不用 undefined 兜底)
//   - result 变了 (重跑) → result_layers 按 result_len 失效回 null, 不回旧总结

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, mutateTaskMetadata, updateTaskStatus } from "@/lib/db/tasks";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sum-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "sum-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeRequest(taskId: string): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${taskId}`, {
    headers: { "x-user-id": ownerId },
  });
}

async function getJson(taskId: string): Promise<Record<string, any>> {
  const { GET } = await import("./route");
  const res = await GET(makeRequest(taskId), { params: Promise.resolve({ id: taskId }) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

function seedCaches(taskId: string, result: string): void {
  updateTaskStatus(taskId, "reviewing", { result });
  mutateTaskMetadata(taskId, (m) => {
    const meta = m as Record<string, unknown>;
    meta.card_summary_v5 = { what: "修好了导出", why: "用户能拿到报表", at: new Date().toISOString() };
    meta.result_layers_v3 = {
      brief: "改了导出模块并加了测试",
      details: ["改 export.ts 加 CSV 列 → 导出带新字段", "补 3 条单测 → 全绿"],
      next: "",
      result_len: result.trim().length,
      at: new Date().toISOString(),
      src: "llm",
    };
  });
}

describe("GET /api/tasks/[id]: 总结字段直读 (信息面板数据源)", () => {
  it("没预热/无缓存 → card_summary / result_layers 字段存在且为 null", async () => {
    const task = createTask({ title: "跑着的话", prompt: "p", project_id: projectId });
    const body = await getJson(task.id);
    expect(body.card_summary).toBeNull();
    expect(body.result_layers).toBeNull();
  });

  it("有预热缓存 → 解析后直带 (前端不再调 Console 按需接口)", async () => {
    const task = createTask({ title: "x", prompt: "p", project_id: projectId });
    const result = "已完成: 导出模块改完, 测试全绿";
    seedCaches(task.id, result);

    const body = await getJson(task.id);
    expect(body.card_summary).toMatchObject({ what: "修好了导出", why: "用户能拿到报表" });
    expect(body.result_layers).toMatchObject({ brief: "改了导出模块并加了测试" });
    expect(body.result_layers.details).toHaveLength(2);
  });

  it("result 变了 (重跑) → result_layers 按 result_len 失效回 null, 不回旧总结", async () => {
    const task = createTask({ title: "x", prompt: "p", project_id: projectId });
    seedCaches(task.id, "第一轮的结论");
    // 重跑: result 变了但预热还没跑完 (缓存 result_len 不匹配)
    updateTaskStatus(task.id, "reviewing", { result: "第二轮重跑后的全新结论, 内容完全不一样" });

    const body = await getJson(task.id);
    expect(body.result_layers).toBeNull();
    // 卡片摘要无 result_len 校验 (迭代 9 闸门只看非空), 仍回缓存 — 与 Console 路由同口径
    expect(body.card_summary).not.toBeNull();
  });
});
