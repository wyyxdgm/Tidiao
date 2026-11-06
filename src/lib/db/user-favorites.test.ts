// Tests for user_favorites (v57, R15 task 收藏).
//
// 覆盖 5 条验收:
//   1) addFavorite 同 user × task 重复 add 幂等 (UNIQUE + INSERT OR IGNORE)
//   2) removeFavorite 未收藏 DELETE 不报错 (idempotent)
//   3) listFavoriteTaskIds 多用户隔离 (A 看 A 不看 B)
//   4) isFavoriteByUser: 收藏 true / 取消 false / 不存在 task false
//   5) FK CASCADE: 删 task → 自动清所有用户对该 task 的收藏
//
// 模式与 quota.test.ts / attachments.test.ts 同款: 真 SQLite 临时库 +
// closeDb() 重启 + getDb() 跑 migration (含 v57).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import {
  addFavorite,
  removeFavorite,
  listFavoriteTaskIds,
  listFavorites,
  isFavoriteByUser,
  countFavorites,
} from "./user-favorites";
import { createTask } from "./tasks";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-fav-db-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb(); // 跑 migrations (含 v57 user_favorites)
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

function makeUserId(prefix: string): string {
  // 直接 INSERT, 跳过 createUser 的 bcrypt 异步 (避免 hash 在 afterEach
  // 之后才完成 → DB 已关 → "connection is not open" 报错). 只用 user_id
  // 字段, 不测密码逻辑, password_hash 用固定 dummy.
  const id = `${prefix}-${uuidv4()}`;
  getDb()
    .prepare(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
    )
    .run(id, `${prefix}-${id}@example.com`, "test-hash", "user");
  return id;
}

async function makeTaskForUser(ownerId: string): Promise<string> {
  // createTask 需要 project_id; 用一个兜底 project. 不关心 project 内容, 只
  // 关心 owner_id 落进 tasks 表 + task 真实存在.
  const projectId = uuidv4();
  getDb()
    .prepare(
      "INSERT INTO projects (id, name, description, owner_id) VALUES (?, ?, ?, ?)"
    )
    .run(projectId, `p-${uuidv4().slice(0, 8)}`, "test", ownerId);
  const task = await createTask({
    project_id: projectId,
    title: "test task",
    prompt: "test prompt",
    type: "test",
    owner_id: ownerId,
  } as any);
  return task.id;
}

describe("user_favorites: addFavorite", () => {
  it("重复 add 同一 user × task → 仅一行 (UNIQUE + INSERT OR IGNORE 幂等)", async () => {
    const userId = makeUserId("u");
    const taskId = await makeTaskForUser(userId);

    const a = addFavorite(userId, taskId);
    const b = addFavorite(userId, taskId); // 第二次应幂等
    expect(a.user_id).toBe(userId);
    expect(a.task_id).toBe(taskId);
    expect(b.user_id).toBe(userId);
    expect(b.task_id).toBe(taskId);
    // created_at 应相同 (INSERT OR IGNORE 没改行).
    expect(a.created_at).toBe(b.created_at);

    const rows = getDb()
      .prepare("SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ? AND task_id = ?")
      .get(userId, taskId) as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe("user_favorites: removeFavorite", () => {
  it("未收藏的 task DELETE 不报错, 返回 0 (idempotent)", async () => {
    const userId = makeUserId("u");
    const taskId = await makeTaskForUser(userId);

    const removed = removeFavorite(userId, taskId);
    expect(removed).toBe(0);
  });

  it("收藏后再取消 → affected=1; 列表里消失", async () => {
    const userId = makeUserId("u");
    const taskId = await makeTaskForUser(userId);
    addFavorite(userId, taskId);

    const removed = removeFavorite(userId, taskId);
    expect(removed).toBe(1);
    expect(isFavoriteByUser(userId, taskId)).toBe(false);
    expect(listFavoriteTaskIds(userId)).not.toContain(taskId);
  });
});

describe("user_favorites: listFavoriteTaskIds 多用户隔离", () => {
  it("用户 A 收藏 3 个 / 用户 B 收藏 2 个 → A 只看到 A 的 3 个", async () => {
    const userA = makeUserId("a");
    const userB = makeUserId("b");
    const aTasks = await Promise.all([
      makeTaskForUser(userA),
      makeTaskForUser(userA),
      makeTaskForUser(userA),
    ]);
    const bTasks = await Promise.all([
      makeTaskForUser(userB),
      makeTaskForUser(userB),
    ]);
    for (const tid of aTasks) addFavorite(userA, tid);
    for (const tid of bTasks) addFavorite(userB, tid);

    const aFavs = listFavoriteTaskIds(userA);
    const bFavs = listFavoriteTaskIds(userB);

    expect(aFavs.sort()).toEqual(aTasks.sort());
    expect(bFavs.sort()).toEqual(bTasks.sort());
    // 互不可见
    for (const tid of bTasks) expect(aFavs).not.toContain(tid);
    for (const tid of aTasks) expect(bFavs).not.toContain(tid);
  });
});

describe("user_favorites: isFavoriteByUser", () => {
  it("收藏后 true / 取消后 false / 不存在 task 返回 false", async () => {
    const userId = makeUserId("u");
    const realTaskId = await makeTaskForUser(userId);
    const fakeTaskId = "00000000-0000-0000-0000-000000000000";

    expect(isFavoriteByUser(userId, realTaskId)).toBe(false);
    addFavorite(userId, realTaskId);
    expect(isFavoriteByUser(userId, realTaskId)).toBe(true);
    removeFavorite(userId, realTaskId);
    expect(isFavoriteByUser(userId, realTaskId)).toBe(false);
    // 不存在 task 不应抛错, 返 false (FK 不会到这层校验, 走 SELECT 1)
    expect(isFavoriteByUser(userId, fakeTaskId)).toBe(false);
  });
});

describe("user_favorites: FK CASCADE", () => {
  it("删 task → 所有用户对该 task 的收藏自动消失 (FK ON DELETE CASCADE)", async () => {
    const taskId = await makeTaskForUser(makeUserId("u"));
    const u1 = makeUserId("u1");
    const u2 = makeUserId("u2");
    addFavorite(u1, taskId);
    addFavorite(u2, taskId);
    expect(countFavorites(u1)).toBe(1);
    expect(countFavorites(u2)).toBe(1);

    // 删 task: getDb() 的 PRAGMA foreign_keys=ON 应让 CASCADE 生效
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(taskId);

    expect(countFavorites(u1)).toBe(0);
    expect(countFavorites(u2)).toBe(0);
    expect(listFavoriteTaskIds(u1)).toEqual([]);
    expect(listFavoriteTaskIds(u2)).toEqual([]);
    // listFavorites 也返空
    expect(listFavorites(u1)).toEqual([]);
  });
});