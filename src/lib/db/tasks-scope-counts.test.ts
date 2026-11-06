// Tests for getTaskCountsByScope 的 queued 字段 (2026-10-11 侧栏全局面板徽章区分显示).
//
// 口径:
//   running = running + queued (合并, 历史口径不变 — master 老组件依赖)
//   queued  = 纯排队
//   前端用 running - queued 反推纯运行.
//
// 模式与 tasks-favorite.test.ts 同款: 真 SQLite 临时库 + 直接调 lib 层.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import { createProject } from "./projects";
import { createTask, getTaskCountsByScope, updateTaskStatus } from "./tasks";
import type { TaskStatus } from "../runtime/types";

let tmpDir: string;

function makeUser(prefix: string): string {
  const id = `${prefix}-${uuidv4()}`;
  getDb()
    .prepare(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
    )
    .run(id, `${prefix}-${id}@example.com`, "test-hash", "user");
  return id;
}

async function makeProjectWithTasks(
  ownerId: string,
  statuses: TaskStatus[]
): Promise<string> {
  const project = await createProject({
    name: `p-${uuidv4().slice(0, 8)}`,
    description: "test",
    ownerId,
  });
  for (let i = 0; i < statuses.length; i++) {
    const task = await createTask({
      project_id: project.id,
      title: `task-${i}`,
      prompt: "p",
      type: "test",
      owner_id: ownerId,
    } as any);
    // createTask 默认 pending; 非 pending 状态走 updateTaskStatus 推转.
    if (statuses[i] !== "pending") {
      updateTaskStatus(task.id, statuses[i]);
    }
  }
  return project.id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-scope-counts-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("getTaskCountsByScope queued 字段", () => {
  it("running 保持合并口径 (running+queued), queued 为纯排队", async () => {
    const alice = makeUser("alice");
    // 2 running + 3 queued + 1 reviewing + 1 paused
    await makeProjectWithTasks(alice, [
      "running",
      "running",
      "queued",
      "queued",
      "queued",
      "reviewing",
      "paused",
    ]);

    const counts = getTaskCountsByScope(alice);
    const scope = Object.values(counts)[0];

    expect(scope.running).toBe(5); // 2 运行 + 3 排队 (历史口径不变)
    expect(scope.queued).toBe(3); // 纯排队
    expect(scope.reviewing).toBe(1);
    expect(scope.paused).toBe(1);
    expect(scope.total).toBe(7);
  });

  it("无排队任务时 queued=0, running 仍正确", async () => {
    const alice = makeUser("alice");
    await makeProjectWithTasks(alice, ["running", "running"]);

    const counts = getTaskCountsByScope(alice);
    const scope = Object.values(counts)[0];

    expect(scope.running).toBe(2);
    expect(scope.queued).toBe(0);
  });

  it("多用户隔离: bob 的排队任务不混进 alice 的计数", async () => {
    const alice = makeUser("alice");
    const bob = makeUser("bob");
    await makeProjectWithTasks(alice, ["running"]);
    await makeProjectWithTasks(bob, ["queued", "queued"]);

    const aliceCounts = getTaskCountsByScope(alice);
    const bobCounts = getTaskCountsByScope(bob);

    expect(Object.values(aliceCounts)[0].running).toBe(1);
    expect(Object.values(aliceCounts)[0].queued).toBe(0);
    expect(Object.values(bobCounts)[0].running).toBe(2);
    expect(Object.values(bobCounts)[0].queued).toBe(2);
  });
});
