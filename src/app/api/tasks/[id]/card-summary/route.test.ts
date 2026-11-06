// GET /api/tasks/[id]/card-summary 路由测试 (damo 1004 迭代9, 回归 task 6f5eeecd).
//
// 核心闸门: result 为空 (running/queued 等非终态) → 不调 LLM、不写缓存, 返回
// 与 LLM 失败同形的空回退 (source='pending', 前端机械提取兜底). 修的是「开跑
// 1 分钟就生成空话摘要并永久缓存」的 bug.
//
// 覆盖:
//   - result 空 → source='pending', generateCardSummary 0 调用, metadata 无缓存
//   - result 空 + ?refresh=true → 同样不生成 (refresh 只绕缓存, 不豁免闸门)
//   - result 非空 → 调 LLM + 写缓存 + source='llm'
//   - result 非空 + 有缓存 → 返 cache, 不调 LLM
//   - result 非空 + ?refresh=true → 绕缓存重算

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById, mutateTaskMetadata, updateTaskStatus } from "@/lib/db/tasks";

// mock LLM 生成器 (不真跑 SDK 子进程), 断言调用与否 + 返回固定摘要.
vi.mock("@/lib/runtime/card-summary-llm", async () => {
  const actual = await vi.importActual<typeof import("@/lib/runtime/card-summary-llm")>(
    "@/lib/runtime/card-summary-llm",
  );
  return {
    ...actual,
    generateCardSummary: vi.fn(),
  };
});
import { generateCardSummary } from "@/lib/runtime/card-summary-llm";
const generateMock = vi.mocked(generateCardSummary);

import { GET } from "./route";

let tmpDir: string;
let ownerId: string;
let projectId: string;

function makeRequest(taskId: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${taskId}/card-summary${query}`, {
    headers: { "x-user-id": ownerId },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-card-summary-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "card-summary-test", cwd: tmpDir, ownerId }).id;

  generateMock.mockReset();
  generateMock.mockResolvedValue({
    summary: { what: "修复卡片摘要空话", why: "画布卡片一眼能懂" },
    model: "test-model",
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

function readCache(taskId: string): unknown {
  const task = getTaskById(taskId)!;
  const meta = task.metadata ? JSON.parse(task.metadata) : {};
  return meta.card_summary_v5; // 缓存键随 store 同步 (现 v5, damo 1010 价值口径 bump), 测试同键
}

describe("GET /api/tasks/[id]/card-summary 迭代9 result 闸门", () => {
  it("🔴 result 空 → source='pending', 不调 LLM, 不写缓存 (回归 6f5eeecd)", async () => {
    const task = createTask({ title: "飞书 R189 更新", prompt: "修 tab 标题", project_id: projectId });
    // 不写 result (queued/running 态)

    const res = await GET(makeRequest(task.id), { params: Promise.resolve({ id: task.id }) });
    const body = (await res.json()) as { what: string; why: string; source: string };

    expect(body).toEqual({ what: "", why: "", source: "pending" });
    expect(generateMock).not.toHaveBeenCalled();
    expect(readCache(task.id)).toBeUndefined();
  });

  it("result 空 + ?refresh=true → 同样不生成 (refresh 只绕缓存, 不豁免闸门)", async () => {
    const task = createTask({ title: "x", prompt: "y", project_id: projectId });

    const res = await GET(makeRequest(task.id, "?refresh=true"), {
      params: Promise.resolve({ id: task.id }),
    });
    const body = (await res.json()) as { source: string };

    expect(body.source).toBe("pending");
    expect(generateMock).not.toHaveBeenCalled();
    expect(readCache(task.id)).toBeUndefined();
  });

  it("result 非空 → 调 LLM + 写缓存 + source='llm'", async () => {
    const task = createTask({ title: "x", prompt: "y", project_id: projectId });
    updateTaskStatus(task.id, "reviewing", { result: "已完成: 修好 tab 标题区分" });

    const res = await GET(makeRequest(task.id), { params: Promise.resolve({ id: task.id }) });
    const body = (await res.json()) as { what: string; source: string };

    expect(body.source).toBe("llm");
    expect(body.what).toBe("修复卡片摘要空话");
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(readCache(task.id)).toMatchObject({ what: "修复卡片摘要空话" });
  });

  it("result 非空 + 有缓存 → 返 cache, 不调 LLM", async () => {
    const task = createTask({ title: "x", prompt: "y", project_id: projectId });
    updateTaskStatus(task.id, "reviewing", { result: "已完成" });
    mutateTaskMetadata(task.id, (m) => {
      (m as Record<string, unknown>).card_summary_v5 = {
        what: "缓存摘要", why: "缓存价值", at: new Date().toISOString(),
      };
    });

    const res = await GET(makeRequest(task.id), { params: Promise.resolve({ id: task.id }) });
    const body = (await res.json()) as { what: string; source: string };

    expect(body.source).toBe("cache");
    expect(body.what).toBe("缓存摘要");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("result 非空 + ?refresh=true → 绕缓存重算 (refresh 语义保留)", async () => {
    const task = createTask({ title: "x", prompt: "y", project_id: projectId });
    updateTaskStatus(task.id, "reviewing", { result: "已完成" });
    mutateTaskMetadata(task.id, (m) => {
      (m as Record<string, unknown>).card_summary_v3 = {
        what: "旧摘要", why: "旧", at: new Date().toISOString(),
      };
    });

    const res = await GET(makeRequest(task.id, "?refresh=true"), {
      params: Promise.resolve({ id: task.id }),
    });
    const body = (await res.json()) as { what: string; source: string };

    expect(body.source).toBe("llm");
    expect(body.what).toBe("修复卡片摘要空话");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
