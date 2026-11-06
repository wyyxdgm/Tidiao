// R88 Phase 3 UI 后端 admin/users 路由层单测.
//
// 覆盖:
//   - GET /api/admin/users admin 鉴权 + 返 listUsersWithQuota 形状
//   - PATCH /api/admin/users/[id] 4 字段独立更新 + 校验 (非 admin / 错类型 / 空 body)
//   - GET /api/admin/users/[id]/quota-log 返变更历史 + limit 参数
//
// 关注点:
//   - 跟 quota.test.ts 21 条 (lib 层) 互补: 这里验证路由层调用了 lib 层 + 返
//     正确 status code + 鉴权. 是集成测试.
//   - 用真实 DB (不开 vi.mock checkUserQuota), 走端到端.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import {
  createUser,
  setUserPartyAEnabled,
  setUserQuotaTotalSpentCap,
} from "@/lib/db/users";

let tmpDir: string;
let adminId: string;
let normalId: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-admin-users-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();
  const admin = await createUser(`admin-${Date.now()}@example.com`, "pw");
  // 强制角色为 admin (createUser 默认 user)
  getDb().prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(admin.id);
  adminId = admin.id;
  const normal = await createUser(`normal-${Date.now()}@example.com`, "pw");
  normalId = normal.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function adminGet(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "x-user-id": adminId, "x-user-role": "admin" },
  });
}

function adminPatch(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "x-user-id": adminId, "x-user-role": "admin", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function normalReq(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "x-user-id": normalId, "x-user-role": "user" },
  });
}

describe("GET /api/admin/users (Sheet L 验收 ④ 后端)", () => {
  it("非 admin → 403", async () => {
    const { GET } = await import("./route");
    const res = await GET(normalReq("/api/admin/users"));
    expect(res.status).toBe(403);
  });

  it("admin → 200 + 返 {users: [...]} 含 4 quota 字段 + used_total_usd", async () => {
    setUserPartyAEnabled(normalId, true, { operatorId: adminId });
    setUserQuotaTotalSpentCap(normalId, 100, { operatorId: adminId });
    const { GET } = await import("./route");
    const res = await GET(adminGet("/api/admin/users"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      users: Array<{
        id: string;
        email: string;
        party_a_enabled: boolean;
        quota_total_spent_cap: number | null;
        used_total_usd: number;
      }>;
    };
    expect(data.users.length).toBe(2); // admin + normal
    const target = data.users.find((u) => u.id === normalId);
    expect(target).toBeDefined();
    expect(target?.party_a_enabled).toBe(true);
    expect(target?.quota_total_spent_cap).toBe(100);
    expect(typeof target?.used_total_usd).toBe("number");
  });

  // AO-DEV R208: 分页. 4 用户 (admin + normal + 2 extra), pageSize=2 走两页.
  it("page/pageSize → 返 {users,total,page,pageSize} 切片正确", async () => {
    await createUser(`extra1-${Date.now()}@example.com`, "pw");
    await createUser(`extra2-${Date.now()}@example.com`, "pw");
    const { GET } = await import("./route");
    const res1 = await GET(adminGet("/api/admin/users?page=1&pageSize=2"));
    expect(res1.status).toBe(200);
    const d1 = (await res1.json()) as {
      users: Array<{ id: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(d1.users.length).toBe(2);
    expect(d1.total).toBe(4);
    expect(d1.page).toBe(1);
    expect(d1.pageSize).toBe(2);

    const res2 = await GET(adminGet("/api/admin/users?page=2&pageSize=2"));
    const d2 = (await res2.json()) as { users: Array<{ id: string }>; total: number };
    expect(d2.users.length).toBe(2);
    expect(d2.total).toBe(4);
    // 两页并集 = 全量, 无重复无遗漏
    const ids = new Set([...d1.users, ...d2.users].map((u) => u.id));
    expect(ids.size).toBe(4);
  });

  it("末页不满页 → 剩余条数, 越界页 → 空 users + total 仍返回", async () => {
    await createUser(`extra-${Date.now()}@example.com`, "pw");
    const { GET } = await import("./route");
    const resTail = await GET(adminGet("/api/admin/users?page=2&pageSize=2"));
    const dTail = (await resTail.json()) as { users: unknown[]; total: number };
    expect(dTail.users.length).toBe(1);
    expect(dTail.total).toBe(3);

    const resOut = await GET(adminGet("/api/admin/users?page=99&pageSize=2"));
    const dOut = (await resOut.json()) as { users: unknown[]; total: number };
    expect(dOut.users.length).toBe(0);
    expect(dOut.total).toBe(3);
  });

  it("非法 page/pageSize → 400 (不静默兜底)", async () => {
    const { GET } = await import("./route");
    for (const q of ["?page=0&pageSize=2", "?page=abc&pageSize=2", "?page=1&pageSize=-1", "?page=1&pageSize=x"]) {
      const res = await GET(adminGet(`/api/admin/users${q}`));
      expect(res.status).toBe(400);
    }
  });

  it("pageSize 超 200 → clamp 到 200; 只传 pageSize 无 page → 默认 page=1", async () => {
    const { GET } = await import("./route");
    const res = await GET(adminGet("/api/admin/users?pageSize=9999"));
    expect(res.status).toBe(200);
    const d = (await res.json()) as { users: unknown[]; total: number; pageSize: number; page: number };
    expect(d.page).toBe(1);
    expect(d.pageSize).toBe(200);
    expect(d.users.length).toBe(2);
    expect(d.total).toBe(2);
  });
});

describe("PATCH /api/admin/users/[id] (Sheet L 验收 ④ 后端)", () => {
  it("非 admin → 403", async () => {
    const req = new NextRequest(`http://localhost/api/admin/users/${normalId}`, {
      method: "PATCH",
      headers: { "x-user-id": normalId, "x-user-role": "user", "content-type": "application/json" },
      body: JSON.stringify({ party_a_enabled: true }),
    });
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(req, { params: Promise.resolve({ id: normalId }) });
    expect(res.status).toBe(403);
  });

  it("空 body → 400 (避免静默 no-op)", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(adminPatch(`/api/admin/users/${normalId}`, {}), {
      params: Promise.resolve({ id: normalId }),
    });
    expect(res.status).toBe(400);
  });

  it("party_a_enabled=true → 200 + DB 落库 + 留 log", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      adminPatch(`/api/admin/users/${normalId}`, {
        party_a_enabled: true,
        reason: "test",
      }),
      { params: Promise.resolve({ id: normalId }) },
    );
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(`SELECT party_a_enabled FROM users WHERE id = ?`)
      .get(normalId) as { party_a_enabled: number };
    expect(row.party_a_enabled).toBe(1);
    const log = getDb()
      .prepare(
        `SELECT field, reason FROM user_quota_change_log WHERE target_user_id = ? ORDER BY id DESC`,
      )
      .all(normalId) as Array<{ field: string; reason: string | null }>;
    expect(log[0].field).toBe("party_a_enabled");
    expect(log[0].reason).toBe("test");
  });

  it("party_a_enabled 非 boolean → 400", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      adminPatch(`/api/admin/users/${normalId}`, { party_a_enabled: "yes" }),
      { params: Promise.resolve({ id: normalId }) },
    );
    expect(res.status).toBe(400);
  });

  it("quota_total_spent_cap 负数 → 400", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      adminPatch(`/api/admin/users/${normalId}`, { quota_total_spent_cap: -5 }),
      { params: Promise.resolve({ id: normalId }) },
    );
    expect(res.status).toBe(400);
  });

  it("quota_expire_at 非法 ISO → 400", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      adminPatch(`/api/admin/users/${normalId}`, {
        quota_expire_at: "not-a-date",
      }),
      { params: Promise.resolve({ id: normalId }) },
    );
    expect(res.status).toBe(400);
  });

  it("不存在的 user → 404", async () => {
    const ghost = uuidv4();
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      adminPatch(`/api/admin/users/${ghost}`, { party_a_enabled: true }),
      { params: Promise.resolve({ id: ghost }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/users/[id]/quota-log (Sheet L 验收 ② 变更留痕)", () => {
  it("非 admin → 403", async () => {
    const { GET } = await import("./[id]/quota-log/route");
    const res = await GET(normalReq(`/api/admin/users/${normalId}/quota-log`), {
      params: Promise.resolve({ id: normalId }),
    });
    expect(res.status).toBe(403);
  });

  it("admin → 200 + 返 {log: [...]} 含最近一次变更", async () => {
    setUserPartyAEnabled(normalId, true, { operatorId: adminId, reason: "ui test" });
    const { GET } = await import("./[id]/quota-log/route");
    const res = await GET(adminGet(`/api/admin/users/${normalId}/quota-log`), {
      params: Promise.resolve({ id: normalId }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      log: Array<{ field: string; operator_id: string; reason: string | null }>;
    };
    expect(data.log.length).toBeGreaterThan(0);
    expect(data.log[0].field).toBe("party_a_enabled");
    expect(data.log[0].operator_id).toBe(adminId);
    expect(data.log[0].reason).toBe("ui test");
  });
});