// PATCH /api/tasks/[id] 数组/对象字段序列化的回归测试.
//
// 2026-08-25 实测: JSON 客户端把 tags 传成数组 -> updateTask 的 stmt.run(...params)
// 里 better-sqlite3 把数组值展开成多个绑定参数 -> RangeError "Too many parameter
// values were provided" 500 (对象值则是 "Too few"). 修复: 路由层把 tags/
// allowed_tools 数组 stringifyStrArray, metadata 对象 JSON.stringify, 与
// createTask 的列序列化同构.
//
// 与 depends-on-ids.test.ts 一样用 vi.mock 桩化 runtime, 不拉 SDK.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById } from "@/lib/db/tasks";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-patch-json-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "patch-json-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function patchReq(id: string, body: unknown, uid = ownerId) {
  return new NextRequest(`http://localhost/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-user-id": uid },
    body: JSON.stringify(body),
  });
}

async function loadRoute() {
  return (await import("./route")).PATCH;
}

describe("PATCH /api/tasks/[id]: 数组/对象字段序列化 (不再 500)", () => {
  it("tags 传 string[] 落库为 JSON 字符串且回读一致", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { tags: ["a", "b"] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);

    const row = getDb().prepare("SELECT tags FROM tasks WHERE id = ?").get(target) as { tags: string | null };
    expect(JSON.parse(row.tags!)).toEqual(["a", "b"]);
    expect(getTaskById(target, ownerId)?.tags).toBe('["a","b"]');
  });

  it("allowed_tools 传 string[] 同样序列化", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { allowed_tools: ["Read", "Grep"] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);

    const row = getDb().prepare("SELECT allowed_tools FROM tasks WHERE id = ?").get(target) as { allowed_tools: string | null };
    expect(JSON.parse(row.allowed_tools!)).toEqual(["Read", "Grep"]);
  });

  it("metadata 传对象序列化为 JSON 字符串", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { metadata: { foo: 1, bar: "x" } }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);

    const row = getDb().prepare("SELECT metadata FROM tasks WHERE id = ?").get(target) as { metadata: string | null };
    expect(JSON.parse(row.metadata!)).toEqual({ foo: 1, bar: "x" });
  });

  it("tags 已是字符串时原样透传 (不双序列化)", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { tags: '["legacy"]' }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);
    expect(getTaskById(target, ownerId)?.tags).toBe('["legacy"]');
  });
});

// R15 sub-3: PATCH 改 title 自动置 metadata.title_lock='manual', 锁死后续
// auto-rename (用户手动优先于被动改名, 详见 src/lib/runtime/auto-rename.ts).
describe("PATCH /api/tasks/[id]: R15 sub-3 title 改动 → metadata.title_lock='manual'", () => {
  it("改 title 后 metadata.title_lock='manual' (sub-3 手动优先)", async () => {
    const target = createTask({ title: "原标题", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { title: "新标题 (用户改的)" }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);

    const after = getTaskById(target, ownerId)!;
    expect(after.title).toBe("新标题 (用户改的)");
    const meta = JSON.parse(after.metadata || "{}");
    expect(meta.title_lock).toBe("manual");
  });

  it("PATCH 同名 title (值未变) 不置 lock — 没真改就别锁", async () => {
    const target = createTask({ title: "同标题", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { title: "同标题" }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);

    const after = getTaskById(target, ownerId)!;
    expect(after.metadata).toBeNull(); // 没置 lock
  });

  it("改非 title 字段不影响 title_lock (例如只改 priority)", async () => {
    const target = createTask({ title: "原", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { priority: 5 }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);
    expect(getTaskById(target, ownerId)?.metadata).toBeNull();
  });
});
