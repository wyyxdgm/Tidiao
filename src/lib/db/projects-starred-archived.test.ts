// v532 (侧栏项目右键操作) starred / archived 行为回归.
//
// 覆盖:
//   - listProjects 默认过滤 archived=1; opts.archived=true 只回归档项目
//   - 排序: pinned DESC 优先于 starred DESC 优先于其余 (pin ⇒ star 不变量由
//     调用方维护, DB 层只管排序)
//   - updateProject starred / archived 白名单落库 (0/1 规范化)
//   - getProjectById **不过滤** archived — 归档 ≠ 删除, URL 仍可访问
//   - GET /api/projects?archived=1 返回归档列表 (owner 隔离照旧)
//   - PATCH 重命名: 正常落库 / 撞同名活项目回 409 DUPLICATE_NAME (与 POST 同款
//     口径, 不再裸 400 透 SQLITE message)
//
// 真 SQLite 临时库, 模式与 src/app/api/projects/route.test.ts 一致.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db/index";
import {
  createProject,
  getProjectById,
  listProjects,
  updateProject,
} from "@/lib/db/projects";
import { GET as listRoute } from "@/app/api/projects/route";
import { PATCH as patchRoute } from "@/app/api/projects/[id]/route";

let tmpDir: string;
let ownerId: string;

async function listViaRoute(query = "", userId = ownerId) {
  const req = new NextRequest(`http://localhost/api/projects${query}`, {
    headers: { "x-user-id": userId, "x-user-role": "user" },
  });
  const res = await listRoute(req);
  return { status: res.status, json: await res.json() };
}

async function patchProject(id: string, body: unknown, userId = ownerId) {
  const req = new NextRequest(`http://localhost/api/projects/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
      "x-user-role": "user",
    },
    body: JSON.stringify(body),
  });
  const res = await patchRoute(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-proj-star-arch-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("listProjects — archived 过滤 + starred 排序", () => {
  it("默认只回活跃项目, 归档的藏起来", () => {
    const live = createProject({ name: "live", ownerId });
    const gone = createProject({ name: "gone", ownerId });
    updateProject(gone.id, { archived: 1 });

    const names = listProjects(ownerId).map((p) => p.name);
    expect(names).toContain("live");
    expect(names).not.toContain("gone");
    expect(listProjects(ownerId).find((p) => p.id === gone.id)).toBeUndefined();
    expect(live.archived).toBe(0);
  });

  it("opts.archived=true 只回归档项目", () => {
    const live = createProject({ name: "live", ownerId });
    const gone = createProject({ name: "gone", ownerId });
    updateProject(gone.id, { archived: 1 });

    const archived = listProjects(ownerId, "created_at", { archived: true });
    expect(archived.map((p) => p.name)).toEqual(["gone"]);
    expect(archived.map((p) => p.id)).not.toContain(live.id);
  });

  it("排序: 置顶 > 收藏 > 其余; created_at DESC 兜底", () => {
    // 创建顺序: old → starred → pinned (created_at DESC 反序兜底).
    createProject({ name: "plain", ownerId });
    const star = createProject({ name: "starred", ownerId });
    const pin = createProject({ name: "pinned", ownerId });
    updateProject(star.id, { starred: 1 });
    updateProject(pin.id, { pinned: 1, starred: 1 });

    const names = listProjects(ownerId).map((p) => p.name);
    expect(names.indexOf("pinned")).toBeLessThan(names.indexOf("starred"));
    expect(names.indexOf("starred")).toBeLessThan(names.indexOf("plain"));
  });

  it("getProjectById 不过滤 archived — 归档项目 URL 仍可访问", () => {
    const p = createProject({ name: "gone-but-alive", ownerId });
    updateProject(p.id, { archived: 1 });
    expect(getProjectById(p.id, ownerId)?.name).toBe("gone-but-alive");
    expect(getProjectById(p.id, ownerId)?.archived).toBe(1);
  });

  it("updateProject starred / archived 规范化为 0/1", () => {
    const p = createProject({ name: "norm", ownerId });
    updateProject(p.id, { starred: 1, archived: 1 });
    expect(getProjectById(p.id)?.starred).toBe(1);
    expect(getProjectById(p.id)?.archived).toBe(1);
    // truthy/falsy 入参规范化 (route 直接透传, DB 层兜住)
    updateProject(p.id, { starred: 0, archived: 0 });
    expect(getProjectById(p.id)?.starred).toBe(0);
    expect(getProjectById(p.id)?.archived).toBe(0);
  });
});

describe("GET /api/projects — ?archived=1", () => {
  it("默认不带参数不返回归档项目 (回归)", async () => {
    const gone = createProject({ name: "gone", ownerId });
    updateProject(gone.id, { archived: 1 });
    const { status, json } = await listViaRoute("");
    expect(status).toBe(200);
    expect(json.projects.map((p: { name: string }) => p.name)).not.toContain("gone");
  });

  it("?archived=1 返回归档项目且带 archived 字段", async () => {
    const gone = createProject({ name: "gone", ownerId });
    updateProject(gone.id, { archived: 1, starred: 0 });
    const { status, json } = await listViaRoute("?archived=1");
    expect(status).toBe(200);
    const row = json.projects.find((p: { id: string }) => p.id === gone.id);
    expect(row).toBeDefined();
    expect(row.archived).toBe(1);
  });

  it("owner 隔离在归档视图同样生效", async () => {
    const other = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(other, `${other}@example.com`, "x", "user");
    const foreign = createProject({ name: "foreign", ownerId: other });
    updateProject(foreign.id, { archived: 1 });
    const { json } = await listViaRoute("?archived=1");
    expect(json.projects).toHaveLength(0);
  });
});

describe("PATCH /api/projects/[id] — 重命名", () => {
  it("正常重命名落库", async () => {
    const p = createProject({ name: "old-name", ownerId });
    const { status, json } = await patchProject(p.id, { name: "new-name" });
    expect(status).toBe(200);
    expect(json.project.name).toBe("new-name");
    expect(getProjectById(p.id)?.name).toBe("new-name");
  });

  it("撞同名活项目回 409 DUPLICATE_NAME (人话 message, 非裸 SQLITE)", async () => {
    createProject({ name: "taken", ownerId });
    const p = createProject({ name: "rename-me", ownerId });
    const { status, json } = await patchProject(p.id, { name: "taken" });
    expect(status).toBe(409);
    expect(json.code).toBe("DUPLICATE_NAME");
    expect(json.error).toContain("taken");
    // 原名未动
    expect(getProjectById(p.id)?.name).toBe("rename-me");
  });

  it("重命名回软删项目占用的名字不冲突 (partial unique 只约束活行)", async () => {
    const dead = createProject({ name: "recycled", ownerId });
    const { deleteProject } = await import("@/lib/db/projects");
    deleteProject(dead.id); // 级联软删
    const p = createProject({ name: "other", ownerId });
    const { status, json } = await patchProject(p.id, { name: "recycled" });
    expect(status).toBe(200);
    expect(json.project.name).toBe("recycled");
  });
});
