// GET /api/tasks projectId filter 行为回归测试.
//
// partner 实测撞坑: ao.py:184 用 ?projectId=<pid>, 但 route.ts GET 之前只读
// ?project=, partner 端的 filter 完全失效 → 返回 owner 可见的全部 task.
// 本文件锁住修复后行为: ?projectId=X 严格按 project_id 字段过滤.
//
// 关注点:
//   - route.ts GET handler 现在 projectId (camelCase) 优先, ?project= 兜底;
//     两者都给则 projectId 赢.
//   - 不传 projectId/project 时按 owner 范围返回 (无 project filter).
//   - 同 owner 多 project 时互不污染.
//   - runtime 用 vi.mock 桩化避免拉起 SDK subprocess.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createRole } from "@/lib/db/roles";
import { createTask, createTask as realCreateTask } from "@/lib/db/tasks";
import { createRequirement, softDeleteRequirement } from "@/lib/db/requirements";
import {
  createUser,
  setUserPartyAEnabled,
  setUserQuotaTotalSpentCap,
  setUserQuotaExpireAt,
} from "@/lib/db/users";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: (def: any) => realCreateTask(def),
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-tasks-filter-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");

  projectA = createProject({ name: "proj-A", ownerId }).id;
  projectB = createProject({ name: "proj-B", ownerId }).id;

  // A 里建 2 个, B 里建 3 个
  createTask({ title: "A1", prompt: "a1", project_id: projectA });
  createTask({ title: "A2", prompt: "a2", project_id: projectA });
  createTask({ title: "B1", prompt: "b1", project_id: projectB });
  createTask({ title: "B2", prompt: "b2", project_id: projectB });
  createTask({ title: "B3", prompt: "b3", project_id: projectB });
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeGetReq(qs: string) {
  return new NextRequest(`http://localhost/api/tasks${qs}`, {
    method: "GET",
    headers: { "x-user-id": ownerId },
  });
}

describe("GET /api/tasks: projectId filter (partner ao.py:184 用法)", () => {
  it("?projectId=A 只返回 A 的 task (不含 B)", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeGetReq(`?projectId=${projectA}`));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { project_id: string; title: string }[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.project_id === projectA)).toBe(true);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(["A1", "A2"]);
  });

  it("?projectId=B 只返回 B 的 task (不含 A)", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeGetReq(`?projectId=${projectB}`));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { project_id: string; title: string }[];
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.project_id === projectB)).toBe(true);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(["B1", "B2", "B3"]);
  });

  it("?project= (旧名) 也仍生效 (docs/api-routes.md 兼容)", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeGetReq(`?project=${projectA}`));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { project_id: string }[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.project_id === projectA)).toBe(true);
  });

  it("两个都给 (projectId=B, project=A) -> projectId 赢 (partner 现状优先)", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      makeGetReq(`?projectId=${projectB}&project=${projectA}`),
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { project_id: string }[];
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.project_id === projectB)).toBe(true);
  });

  it("两个都给空串 / 不传 -> 按 owner 范围返回全部 (现有默认行为)", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeGetReq(""));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { project_id: string }[];
    // 5 个全是 owner 的, 不管 project 归属
    expect(rows.length).toBe(5);
    const pids = new Set(rows.map((r) => r.project_id));
    expect(pids.has(projectA)).toBe(true);
    expect(pids.has(projectB)).toBe(true);
  });
});

// =====================================================================
// R88 quota 拦截 (Sheet L 验收 ⑥): POST /api/tasks 在 getRuntime().createTask
//   之前调 checkUserQuota, 触发时返 403 + code=QUOTA_BLOCKED.
// 跟 quota.test.ts 21 条 (lib 层) 不同, 这里验证**路由层**调用了 lib 层 + 返
//   正确 status code, 是集成测试.
// =====================================================================

describe("POST /api/tasks: R88 quota 拦截 (Sheet L 验收 ⑥)", () => {
  it("party_a=1 + cap 已触达 → 403 + code=QUOTA_BLOCKED + reason=total_spent_cap", async () => {
    const partyA = await createUser(`pa-create-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(partyA.id, true, {
      operatorId: partyA.id,
      reason: "test setup",
    });
    setUserQuotaTotalSpentCap(partyA.id, 5, {
      operatorId: partyA.id,
      reason: "test setup",
    });
    // 给 projectA 造一个已超 cap 的 cost_usd (同 owner 不重要, 按 user 聚合)
    const seedProj = createProject({ name: "seed", ownerId: partyA.id });
    createTask({ title: "seed-cost", prompt: "x", project_id: seedProj.id });
    getDb()
      .prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`)
      .run(5, partyA.id);

    const projForPartyA = createProject({ name: "p-pa", ownerId: partyA.id });
    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "x-user-id": partyA.id, "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "p", project_id: projForPartyA.id }),
    });
    const { POST } = await import("./route");
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      reason: string;
      quota: { allowed: boolean };
    };
    expect(body.code).toBe("QUOTA_BLOCKED");
    expect(body.reason).toBe("total_spent_cap");
    expect(body.quota.allowed).toBe(false);
  });

  it("party_a=1 + expire_at 已过期 → 403 + reason=expired", async () => {
    const partyA = await createUser(`pa-expire-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(partyA.id, true, {
      operatorId: partyA.id,
      reason: "test setup",
    });
    setUserQuotaExpireAt(partyA.id, "2020-01-01T00:00:00Z", {
      operatorId: partyA.id,
      reason: "test setup",
    });
    const proj = createProject({ name: "p-exp", ownerId: partyA.id });
    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "x-user-id": partyA.id, "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "p", project_id: proj.id }),
    });
    const { POST } = await import("./route");
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("QUOTA_BLOCKED");
    expect(body.reason).toBe("expired");
  });

  it("party_a=0 + cap 已触达 → 放行 (Sheet L 验收 ③ 老用户无感)", async () => {
    const normal = await createUser(`normal-create-${Date.now()}@example.com`, "pw");
    setUserQuotaTotalSpentCap(normal.id, 1, {
      operatorId: normal.id,
      reason: "test setup",
    });
    // 给 owner 累计 cost 远超 cap
    const seedProj = createProject({ name: "seed-n", ownerId: normal.id });
    createTask({ title: "seed", prompt: "x", project_id: seedProj.id });
    getDb()
      .prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`)
      .run(100, normal.id);

    const proj = createProject({ name: "p-n", ownerId: normal.id });
    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "x-user-id": normal.id, "content-type": "application/json" },
      body: JSON.stringify({ title: "t", prompt: "p", project_id: proj.id }),
    });
    const { POST } = await import("./route");
    const res = await POST(req);
    // party_a=0 走 checkUserQuota 直接 allowed=true (no_party_a), 进 createTask
    expect(res.status).toBe(201);
  });
});

// =====================================================================
// R78 W4 场景 7: closed requirement 拒收 POST /api/tasks 带 requirement_id
//   (auto-dispatch route.test.ts 已有, 但 POST /api/tasks 这条主路径未覆盖).
// =====================================================================

describe("R78 W4: POST /api/tasks 带 closed requirement_id = 400 REQUIREMENT_CLOSED", () => {
  it("requirement.status=closed → POST /api/tasks 返 400 + code: REQUIREMENT_CLOSED", async () => {
    // 造一个 requirement + 软删 (status=closed).
    const req1 = createRequirement(projectA, { title: "to-be-closed" }, ownerId);
    softDeleteRequirement(req1.id, ownerId);

    const req2 = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "x-user-id": ownerId, "content-type": "application/json" },
      body: JSON.stringify({
        title: "new-task",
        prompt: "p",
        project_id: projectA,
        requirement_id: req1.id,
      }),
    });
    const { POST } = await import("./route");
    const res = await POST(req2);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("REQUIREMENT_CLOSED");
  });

  it("requirement 跨 owner + closed → POST 返 400 REQUIREMENT_CLOSED (or NOT_FOUND, 一致路径即可)", async () => {
    // 跨 owner 创建 POST: createTask 内部先 getRequirementById 不带 ownerId 兜底,
    // closed 防御优先, 命中 REQUIREMENT_CLOSED. 这是 W1 §5 边界测试.
    const otherUser = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(otherUser, `${otherUser}@example.com`, "x", "user");
    const req = createRequirement(projectA, { title: "cross" }, otherUser);
    softDeleteRequirement(req.id, otherUser);

    const req2 = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "x-user-id": ownerId, "content-type": "application/json" },
      body: JSON.stringify({
        title: "new-task",
        prompt: "p",
        project_id: projectA,
        requirement_id: req.id,
      }),
    });
    const { POST } = await import("./route");
    const res = await POST(req2);
    // 跨 owner + closed: createTask 内部先走 getRequirementById(rid, ownerId) → null
    // → 抛 REQUIREMENT_NOT_FOUND, 命中 code 列表 → 400.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(["REQUIREMENT_NOT_FOUND", "REQUIREMENT_CLOSED"]).toContain(body.code);
  });
});

// =====================================================================
// Role 场景化 P2 (docs/plans/role-scoped-roles.md D2): POST /api/tasks
//   role_id 透传 + createTask 抛的 ROLE_NOT_FOUND / ROLE_SCOPE_MISMATCH
//   映射 400 (P1 之前 ROLE_NOT_FOUND 是裸 Error → route 层 500).
// =====================================================================

describe("POST /api/tasks: role_id 透传 + 错误映射 (Role 场景化 P2, D2)", () => {
  function makePostReq(payload: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "x-user-id": ownerId, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("合法 role_id → 201 且 task.role_id 落库 (透传)", async () => {
    const role = createRole({ name: "Talker", system_prompt: "be terse", ownerId });
    const { POST } = await import("./route");
    const res = await POST(makePostReq({
      title: "t", prompt: "p", project_id: projectA, role_id: role.id,
    }));
    expect(res.status).toBe(201);
    const task = (await res.json()) as { role_id: string | null };
    expect(task.role_id).toBe(role.id);
  });

  it("role_id 不存在 → 400 + code=ROLE_NOT_FOUND (裸 Error 时代是 500)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makePostReq({
      title: "t", prompt: "p", project_id: projectA, role_id: uuidv4(),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("ROLE_NOT_FOUND");
    expect(body.error).toMatch(/not found/);
  });

  it("project 专属 role 跨 project 用 → 400 + code=ROLE_SCOPE_MISMATCH", async () => {
    const scoped = createRole({
      name: "Scoped", system_prompt: "x", ownerId, projectId: projectB,
    });
    const { POST } = await import("./route");
    const res = await POST(makePostReq({
      title: "t", prompt: "p", project_id: projectA, role_id: scoped.id,
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ROLE_SCOPE_MISMATCH");
  });

  it("不传 role_id → 201 且 role_id 为 null (默认路径不受影响)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makePostReq({ title: "t", prompt: "p", project_id: projectA }));
    expect(res.status).toBe(201);
    const task = (await res.json()) as { role_id: string | null };
    expect(task.role_id).toBeNull();
  });
});

describe("GET /api/tasks: ?search= 透传 (飞书 R180 顶栏搜索)", () => {
  it("?search=A1 只返回标题命中 task; 不传 search 返回全量", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeGetReq("?search=A1"));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { title: string; id: string }[];
    // LIKE 对 ASCII 不分大小写: beforeEach 随机 uuid 里含 "a1" 时也会命中
    // (id LIKE %A1%), 属预期行为 → 断言意图锁 title 维度, 不锁总行数.
    const byTitle = rows.filter((r) => r.title === "A1");
    expect(byTitle.length).toBe(1);
    expect(byTitle[0].title).toBe("A1");

    const all = await GET(makeGetReq(""));
    const allRows = (await all.json()) as unknown[];
    expect(allRows.length).toBe(5); // beforeEach 建的 A1/A2/B1/B2/B3
  });

  it("?search=<uuid 前缀> 命中 id", async () => {
    const { GET } = await import("./route");
    const all = (await (await GET(makeGetReq(""))).json()) as { id: string }[];
    const target = all[0];
    const res = await GET(makeGetReq(`?search=${target.id.slice(0, 8)}`));
    const rows = (await res.json()) as { id: string }[];
    expect(rows.some((r) => r.id === target.id)).toBe(true);
  });
});
