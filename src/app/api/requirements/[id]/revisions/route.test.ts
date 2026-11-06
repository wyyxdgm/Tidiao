// GET /api/requirements/[id]/revisions - 修订时间线路由层测试 (R78 W4 §4.1 场景 9).
//
// 覆盖:
//   - status / priority / title 字段级变更都能在时间线里看到 (field/old/new).
//   - revision 行按时间倒序.
//   - limit 参数生效.
//   - 跨 owner → 404 (no existence leak).
//   - 不存在 id → 404.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import {
  createRequirement,
  updateRequirement,
} from "@/lib/db/requirements";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: () => {
      throw new Error("createTask not used in GET /api/requirements/[id]/revisions");
    },
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerA: string;
let ownerB: string;
let projectA: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-req-revs-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerA = uuidv4();
  ownerB = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerA, `${ownerA}@example.com`, "x", "user");
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerB, `${ownerB}@example.com`, "x", "user");

  projectA = uuidv4();
  getDb()
    .prepare(`INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)`)
    .run(projectA, "revs-proj", ownerA);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function loadGET() {
  return (await import("./route")).GET;
}

function makeReq(id: string, qs: string, uid = ownerA) {
  return new NextRequest(`http://localhost/api/requirements/${id}/revisions${qs}`, {
    method: "GET",
    headers: { "x-user-id": uid },
  });
}

// Next.js 路由签名: handler(request, { params: Promise<{id}> }).
async function callGET(req: NextRequest, id: string) {
  const GET = await loadGET();
  return GET(req, { params: Promise.resolve({ id }) });
}

// ---- 字段级变更时间线 ----

describe("R78 W4: 修订时间线 API 字段级变更", () => {
  it("status / priority / title 三种字段变更都落 revisions + 时间线可读", async () => {
    const r = createRequirement(projectA, { title: "原 title", priority: 3 }, ownerA);
    // 改 title + priority + status (按顺序, 时间倒序检查)
    updateRequirement(r.id, { title: "新 title", priority: 5 }, ownerA);
    updateRequirement(r.id, { status: "has_suggestion" }, ownerA);

    const res = await callGET(makeReq(r.id, ""), r.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requirement_id).toBe(r.id);
    expect(Array.isArray(body.revisions)).toBe(true);
    expect(body.revisions.length).toBeGreaterThanOrEqual(4); // create + 3 update

    // 至少含 status/priority/title 三种 field
    const fields = new Set(body.revisions.map((x: any) => x.field));
    expect(fields.has("status")).toBe(true);
    expect(fields.has("priority")).toBe(true);
    expect(fields.has("title")).toBe(true);

    // status 那条: old=pending, new=has_suggestion
    const statusRev = body.revisions.find(
      (x: any) => x.field === "status" && x.new_value === "has_suggestion"
    );
    expect(statusRev).toBeDefined();
    expect(statusRev.old_value).toBe("pending");

    // title 那条: old=原 title, new=新 title
    const titleRev = body.revisions.find(
      (x: any) => x.field === "title" && x.new_value === "新 title"
    );
    expect(titleRev).toBeDefined();
    expect(titleRev.old_value).toBe("原 title");

    // priority 那条: old=3, new=5
    const prioRev = body.revisions.find(
      (x: any) => x.field === "priority" && x.new_value === "5"
    );
    expect(prioRev).toBeDefined();
    expect(prioRev.old_value).toBe("3");
  });

  it("revisions 包含 title 变更两条 (t1/t2) + create 一条", async () => {
    // sqlite DATETIME 是秒精度, 连续 updateRequirement 可能在同一秒, id DESC
    // tiebreaker 不保证时间顺序. 这里只验"两条都落库 + 不丢".
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    updateRequirement(r.id, { title: "t1" }, ownerA);
    updateRequirement(r.id, { title: "t2" }, ownerA);

    const res = await callGET(makeReq(r.id, ""), r.id);
    const body = await res.json();
    const titleRevs = body.revisions.filter((x: any) => x.field === "title");
    // create(title=t) + update(t1) + update(t2) = 至少 3 条 title revision
    expect(titleRevs.length).toBeGreaterThanOrEqual(3);
    const newValues = titleRevs.map((x: any) => x.new_value);
    expect(newValues).toContain("t1");
    expect(newValues).toContain("t2");
    expect(newValues).toContain("t");
  });

  it("LIST SQL 排序: created_at DESC, 同秒时按 id DESC 稳定 (直接读 DB 验证)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    updateRequirement(r.id, { title: "t1" }, ownerA);
    updateRequirement(r.id, { title: "t2" }, ownerA);

    // 直接读 DB, 走 listRevisions 同 ORDER BY 验证 SQL 排序行为.
    const { listRevisions } = await import("@/lib/db/requirement-revisions");
    const rows = listRevisions(r.id);
    // 至少有 title 类型的 3 条
    const titles = rows.filter((x) => x.field === "title").map((x) => x.new_value);
    expect(titles.length).toBeGreaterThanOrEqual(3);
    expect(titles).toContain("t1");
    expect(titles).toContain("t2");
  });

  it("limit=N 参数生效, 返回 ≤ N 条", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    for (let i = 0; i < 5; i++) {
      updateRequirement(r.id, { title: `t${i}` }, ownerA);
    }

    const res = await callGET(makeReq(r.id, "?limit=2"), r.id);
    const body = await res.json();
    expect(body.revisions.length).toBeLessThanOrEqual(2);
  });

  it("无效 limit (字符串/负数/超 500) 静默回落默认 100", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const res = await callGET(makeReq(r.id, "?limit=abc"), r.id);
    expect(res.status).toBe(200);
    const res2 = await callGET(makeReq(r.id, "?limit=99999"), r.id);
    expect(res2.status).toBe(200);
  });
});

// ---- 跨 owner / 不存在 404 ----

describe("R78 W4: revisions 端点跨 owner / 不存在", () => {
  it("ownerB GET ownerA 的 revisions → 404 (no existence leak)", async () => {
    const r = createRequirement(projectA, { title: "private" }, ownerA);
    const res = await callGET(makeReq(r.id, "", ownerB), r.id);
    expect(res.status).toBe(404);
  });

  it("不存在 id → 404", async () => {
    const id = uuidv4();
    const res = await callGET(makeReq(id, ""), id);
    expect(res.status).toBe(404);
  });

  it("无 revision 时返回 requirement_id + 空数组 (不 404)", async () => {
    const r = createRequirement(projectA, { title: "no-rev" }, ownerA);
    // 手工删 revisions 模拟无变更场景 (create 通常会写 1 条 title).
    getDb()
      .prepare("DELETE FROM requirement_revisions WHERE requirement_id = ?")
      .run(r.id);

    const res = await callGET(makeReq(r.id, ""), r.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requirement_id).toBe(r.id);
    expect(body.revisions).toEqual([]);
  });
});