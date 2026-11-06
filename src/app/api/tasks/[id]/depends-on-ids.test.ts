// PATCH /api/tasks/[id] 增 depends_on_ids 白名单的回归测试.
//
// damo 0824 派发路径踩坑：ALLOWED_FIELDS 不含 depends_on_ids, PATCH 静默丢.
//
// 关注点:
//   - depend_on 在 DB 中由两张表承担: tasks.depends_on (JSON 列) + task_dependencies
//     (N 行). PATCH 必须原子替换两张表, 否则 GET 回读会出现「JSON 有但表行缺」
//     的不变量漂移 (replaceTaskDependencies 已经用 transaction 包住, 这里只
//     验端到端 read-back).
//   - 同 owner 校验不在这里做 (POST createTask 也没做), 见
//     docs/fixes/2026-08-24-dispatch-pitfalls.md §后续 TODO (跨 owner 让 POST 静默
//     drop, 与 PATCH 行为一致 = 「不引入新不一致」).
//   - 与 dispatched-by-task-id.test.ts 一样的用 vi.mock 桩化 runtime, 不拉 SDK.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById, getDependencyTaskIds } from "@/lib/db/tasks";

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
let dep1Id: string;
let dep2Id: string;
let dep3Id: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-deps-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "deps-proj", ownerId }).id;
  dep1Id = createTask({ title: "dep1", prompt: "d1", project_id: projectId }).id;
  dep2Id = createTask({ title: "dep2", prompt: "d2", project_id: projectId }).id;
  dep3Id = createTask({ title: "dep3", prompt: "d3", project_id: projectId }).id;
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

describe("PATCH /api/tasks/[id]: depends_on_ids 增白名单", () => {
  it("string[] 真写到 task_dependencies (不再静默丢)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { depends_on_ids: [dep1Id, dep2Id] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);

    const stored = getDependencyTaskIds(target).sort();
    expect(stored).toEqual([dep1Id, dep2Id].sort());
    // 同步写 tasks.depends_on JSON 不变量. JSON 列保留写入顺序 (与 POST 一致),
    //   这里双方都 sort 后比对, 避免依赖 uuid 字典序偶然一致.
    const row = getDb().prepare("SELECT depends_on FROM tasks WHERE id = ?").get(target) as { depends_on: string | null };
    expect(JSON.parse(row.depends_on!).sort()).toEqual([dep1Id, dep2Id].sort());
  });

  it("depends_on_ids 替换 (旧 deps 被清掉, 新 deps 写入)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    // 先建一组
    await PATCH(patchReq(target, { depends_on_ids: [dep1Id, dep2Id] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(getDependencyTaskIds(target).sort()).toEqual([dep1Id, dep2Id].sort());

    // PATCH 替换为另一组
    await PATCH(patchReq(target, { depends_on_ids: [dep2Id, dep3Id] }), {
      params: Promise.resolve({ id: target }),
    });
    const after = getDependencyTaskIds(target).sort();
    expect(after).toEqual([dep2Id, dep3Id].sort());
    expect(after).not.toContain(dep1Id);
    // 同上 JSON 列同步 (双方排序后比对, 避免 uuid 字典序偶然).
    const row = getDb().prepare("SELECT depends_on FROM tasks WHERE id = ?").get(target) as { depends_on: string | null };
    expect(JSON.parse(row.depends_on!).sort()).toEqual([dep2Id, dep3Id].sort());
  });

  it("depends_on_ids: null → 显式清空 (与 timeout_minutes 语义对齐)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    await PATCH(patchReq(target, { depends_on_ids: [dep1Id] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(getDependencyTaskIds(target)).toEqual([dep1Id]);

    // 清空
    const res = await PATCH(patchReq(target, { depends_on_ids: null }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);
    expect(getDependencyTaskIds(target)).toEqual([]);
    const row = getDb().prepare("SELECT depends_on FROM tasks WHERE id = ?").get(target) as { depends_on: string | null };
    expect(row.depends_on).toBeNull();
  });

  it("depends_on_ids: [] → 空数组等价于清空 (JSON 列变 null)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    await PATCH(patchReq(target, { depends_on_ids: [] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(getDependencyTaskIds(target)).toEqual([]);
    const row = getDb().prepare("SELECT depends_on FROM tasks WHERE id = ?").get(target) as { depends_on: string | null };
    expect(row.depends_on).toBeNull();
  });

  it("不传 depends_on_ids → 保持现状 (undefined 字段不动库)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    await PATCH(patchReq(target, { depends_on_ids: [dep1Id] }), {
      params: Promise.resolve({ id: target }),
    });
    const before = getDependencyTaskIds(target);

    // PATCH 别的不相干字段
    const res = await PATCH(patchReq(target, { title: "新标题" }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(200);
    expect(getDependencyTaskIds(target)).toEqual(before); // deps 没被误清
    expect(getTaskById(target)!.title).toBe("新标题");
  });

  it("depends_on_ids 非法类型 (string) → 400", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { depends_on_ids: dep1Id }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/string\[\]/);
  });

  it("depends_on_ids 含非字符串 → 400 (空串也算)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, { depends_on_ids: [dep1Id, ""] }), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(400);
  });

  it("白名单中没有 depends_on_ids 时 PATCH 仍要求至少一个有效字段 (空 PATCH 拒为 400)", async () => {
    const target = createTask({ title: "target", prompt: "p", project_id: projectId }).id;
    const PATCH = await loadRoute();

    const res = await PATCH(patchReq(target, {}), {
      params: Promise.resolve({ id: target }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("No valid fields to update");
  });
});
