// Tests for listTasks({favorite: true}) filter (v57, R15 task 收藏).
//
// 覆盖 3 条:
//   1) favorite=true 只返回当前用户收藏的 task (多用户隔离)
//   2) favorite=false / undefined 行为与原 listTasks 一致 (返回所有 owner task)
//   3) favorite=true + status filter 组合: 同时收窄状态 + 收藏
//
// 模式与 user-favorites.test.ts 同款: 真 SQLite 临时库 + 直接调 lib 层.
// listTasks 自身没有专属 .test.ts, 故新文件承担.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import { createProject } from "./projects";
import { createTask, listTasks, updateTaskStatus } from "./tasks";
import { addFavorite } from "./user-favorites";
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

async function makeTasksForUser(
  ownerId: string,
  count: number,
  status: TaskStatus = "completed"
): Promise<string[]> {
  const project = await createProject({
    name: `p-${uuidv4().slice(0, 8)}`,
    description: "test",
    ownerId,
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const task = await createTask({
      project_id: project.id,
      title: `task-${i}`,
      prompt: "p",
      type: "test",
      owner_id: ownerId,
    } as any);
    if (status !== "pending") {
      updateTaskStatus(task.id, status);
    }
    ids.push(task.id);
  }
  return ids;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-fav-list-"));
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

describe("listTasks({favorite}) filter", () => {
  it("favorite=true 只返回当前用户收藏的 task (多用户隔离)", async () => {
    const alice = makeUser("alice");
    const bob = makeUser("bob");
    const aliceTasks = await makeTasksForUser(alice, 2);
    const bobTasks = await makeTasksForUser(bob, 3);

    for (const tid of aliceTasks) addFavorite(alice, tid);
    for (const tid of bobTasks) addFavorite(bob, tid);

    const aliceFavs = listTasks({ ownerId: alice, favorite: true });
    const bobFavs = listTasks({ ownerId: bob, favorite: true });

    expect(aliceFavs.map((t) => t.id).sort()).toEqual(aliceTasks.sort());
    expect(bobFavs.map((t) => t.id).sort()).toEqual(bobTasks.sort());
    // 互不可见
    for (const tid of bobTasks) {
      expect(aliceFavs.find((t) => t.id === tid)).toBeUndefined();
    }
  });

  it("favorite=false / undefined 行为与原 listTasks 一致 (返回 owner 所有 task)", async () => {
    const alice = makeUser("alice");
    const tasks = await makeTasksForUser(alice, 3);
    // 收藏 1 个
    addFavorite(alice, tasks[0]);

    const allOwner = listTasks({ ownerId: alice });
    const filterFalse = listTasks({ ownerId: alice, favorite: false });
    const filterUndef = listTasks({ ownerId: alice, favorite: undefined });

    expect(allOwner.map((t) => t.id).sort()).toEqual(tasks.sort());
    expect(filterFalse.map((t) => t.id).sort()).toEqual(tasks.sort());
    expect(filterUndef.map((t) => t.id).sort()).toEqual(tasks.sort());
  });

  it("favorite=true + status filter 组合 (只收藏 + completed)", async () => {
    const alice = makeUser("alice");
    // 3 completed + 2 running, 都收藏
    const completed = await makeTasksForUser(alice, 3, "completed");
    const running = await makeTasksForUser(alice, 2, "running");
    for (const tid of [...completed, ...running]) addFavorite(alice, tid);

    const onlyCompletedFavs = listTasks({
      ownerId: alice,
      favorite: true,
      status: "completed",
    });

    expect(onlyCompletedFavs.map((t) => t.id).sort()).toEqual(completed.sort());
    expect(onlyCompletedFavs.length).toBe(3);
    for (const t of onlyCompletedFavs) expect(t.status).toBe("completed");
  });
});