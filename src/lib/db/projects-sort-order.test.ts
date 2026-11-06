// v58: 项目导航手动排序 (飞书 R28).
//
// 覆盖:
//  - listProjects(sort="manual"): sort_order ASC NULLS LAST 兜底 created_at DESC
//  - updateProject 接受 sort_order (number/null), 非法值 (非整数) 抛错
//  - 创建的项目 sort_order 默认 NULL (不破坏旧排序, 直到用户首次拖动)
//  - pinned 项目仍然置顶, 不受 sort_order 影响
//  - 跨 owner 隔离: 别人的 sort_order 不影响我的 manual 排序

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  createProject,
  updateProject,
  listProjects,
  getProjectById,
} from "./projects";

let tmpDir: string;
let userId: string;
let otherUserId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sort-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑全部 migration, 含 v58
  userId = uuidv4();
  otherUserId = uuidv4();
  const db = getDb();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run(userId, "u@test.com", "x", "user");
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run(otherUserId, "o@test.com", "x", "user");
});

afterEach(() => {
  closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("projects.sort_order (v58)", () => {
  it("新建项目 sort_order 默认 NULL (未排序 = 走 created_at DESC 兜底)", () => {
    const a = createProject({ name: "A", ownerId: userId });
    const b = createProject({ name: "B", ownerId: userId });
    expect(a.sort_order).toBeNull();
    expect(b.sort_order).toBeNull();
  });

  it("listProjects(sort='manual'): sort_order ASC, NULL 行兜底到 created_at DESC", () => {
    // 给 b/c 显式不同 created_at 让顺序可断言 (同秒默认精度导致 created_at
    // 全相同 → 无法判先后; 不在这里 sleep 拖测试时间).
    const a = createProject({ name: "A", ownerId: userId });
    const b = createProject({ name: "B", ownerId: userId });
    const c = createProject({ name: "C", ownerId: userId });
    getDb().prepare(`UPDATE projects SET created_at = ? WHERE id = ?`).run("2026-01-01 10:00:00", a.id);
    getDb().prepare(`UPDATE projects SET created_at = ? WHERE id = ?`).run("2026-01-02 10:00:00", b.id);
    getDb().prepare(`UPDATE projects SET created_at = ? WHERE id = ?`).run("2026-01-03 10:00:00", c.id);
    // 只给 a 手动 sort_order=500, b/c 仍 NULL —— NULL 兜底到 created_at DESC
    updateProject(a.id, { sort_order: 500 });
    const sorted = listProjects(userId, "manual");
    // 期望: a (sort_order=500 升序排第一) 然后 b/c 按 created_at DESC
    expect(sorted.map((p) => p.name)).toEqual(["A", "C", "B"]);
  });

  it("listProjects(sort='manual'): 全部有 sort_order 时严格按其升序", () => {
    const a = createProject({ name: "A", ownerId: userId });
    const b = createProject({ name: "B", ownerId: userId });
    const c = createProject({ name: "C", ownerId: userId });
    updateProject(a.id, { sort_order: 2000 });
    updateProject(b.id, { sort_order: 0 });
    updateProject(c.id, { sort_order: 1000 });
    const sorted = listProjects(userId, "manual");
    expect(sorted.map((p) => p.name)).toEqual(["B", "C", "A"]);
  });

  it("pinned 项目仍然置顶 (与 sort_order 解耦)", () => {
    const a = createProject({ name: "A", ownerId: userId, description: "" });
    const b = createProject({ name: "B", ownerId: userId, description: "" });
    const c = createProject({ name: "C", ownerId: userId, description: "" });
    updateProject(a.id, { sort_order: 100 });
    updateProject(b.id, { sort_order: 50, pinned: 1 });
    updateProject(c.id, { sort_order: 200 });
    const sorted = listProjects(userId, "manual");
    expect(sorted.map((p) => p.name)).toEqual(["B", "A", "C"]);
  });

  it("updateProject sort_order: null 清空回 created_at 排序", () => {
    const a = createProject({ name: "A", ownerId: userId });
    updateProject(a.id, { sort_order: 100 });
    expect(getProjectById(a.id)?.sort_order).toBe(100);
    updateProject(a.id, { sort_order: null });
    expect(getProjectById(a.id)?.sort_order).toBeNull();
  });

  it("updateProject sort_order: 负数 + 0 接受 (前端可能用 0/-1 做边界标记)", () => {
    const a = createProject({ name: "A", ownerId: userId });
    updateProject(a.id, { sort_order: 0 });
    expect(getProjectById(a.id)?.sort_order).toBe(0);
    updateProject(a.id, { sort_order: -500 });
    expect(getProjectById(a.id)?.sort_order).toBe(-500);
  });

  it("updateProject sort_order: 非法值 (浮点) 抛错 -> PATCH 路由回 400", () => {
    const a = createProject({ name: "A", ownerId: userId });
    expect(() => updateProject(a.id, { sort_order: 1.5 })).toThrow(/sort_order/);
    expect(() => updateProject(a.id, { sort_order: NaN })).toThrow(/sort_order/);
    expect(() => updateProject(a.id, { sort_order: Infinity })).toThrow(/sort_order/);
    expect(getProjectById(a.id)?.sort_order).toBeNull();
  });

  it("listProjects 跨 owner 隔离: 别家 sort_order 不影响我", () => {
    const mine = createProject({ name: "mine", ownerId: userId });
    const other = createProject({ name: "other", ownerId: otherUserId });
    updateProject(other.id, { sort_order: -9999 }); // 试图把别家项目排到顶
    const sorted = listProjects(userId, "manual");
    expect(sorted.map((p) => p.name)).toEqual(["mine"]);
  });

  it("listProjects(sort='manual'): 创建顺序反向时 NULL 兜底按 created_at DESC", () => {
    // 全部 sort_order=NULL → 完全等价 created_at DESC 排序. SQLite datetime('now')
    // 默认秒级精度, 同秒创建的项目 created_at 完全相同 → 主键没法判先后. 这里
    // 直接覆盖 created_at 给它们不同的稳定顺序, 避免 sleep 拖测试时间.
    const a = createProject({ name: "A", ownerId: userId });
    const b = createProject({ name: "B", ownerId: userId });
    const c = createProject({ name: "C", ownerId: userId });
    getDb().prepare(`UPDATE projects SET created_at = ? WHERE id = ?`).run("2026-01-01 10:00:00", a.id);
    getDb().prepare(`UPDATE projects SET created_at = ? WHERE id = ?`).run("2026-01-02 10:00:00", b.id);
    getDb().prepare(`UPDATE projects SET created_at = ? WHERE id = ?`).run("2026-01-03 10:00:00", c.id);
    const sorted = listProjects(userId, "manual");
    expect(sorted.map((p) => p.name)).toEqual(["C", "B", "A"]);
  });
});