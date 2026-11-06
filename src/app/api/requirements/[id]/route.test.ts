// PATCH /api/requirements/[id] 回归测试 — R78 W1 关键修复 (Bug 1).
//
// 覆盖:
//   - M reject 反馈 Bug 1: PATCH 短路只看 status 会静默丢其他字段 (W1 v1 commit 1402f36
//     的回归). 修复后: 仅当 body 只有 status 一个字段时才短路.
//   - 幂等性 (W1 §4.4): 纯 status PATCH 仍走短路返 200 + 不写 revision.
//   - invariant (W1 §4.3 (a)): 想变 done 但无 dev/test/deploy 完成 task = 400.
//
// 关注点:
//   - runtime 不拉 SDK, vi.mock 桩化 createTask (本测试用不到, 但 PATCH 不调 createTask).
//   - 用真正的 DB 层 helper (createRequirement / getRequirementById / updateRequirement)
//     验证 short-circuit 后 GET 真能拿到新 title/description (防静默丢).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import {
  createRequirement,
  getRequirementById,
  REQUIREMENT_STATUSES,
} from "@/lib/db/requirements";

// runtime 不拉 SDK (本测试不需要, 但保持一致模式以防以后 PATCH 路径变).
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: () => {
      throw new Error("createTask not used in PATCH /api/requirements/[id]");
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-req-route-"));
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
    .run(projectA, "patch-proj", ownerA);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function patchReq(id: string, body: unknown, uid = ownerA) {
  return new NextRequest(`http://localhost/api/requirements/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-user-id": uid },
    body: JSON.stringify(body),
  });
}

async function loadPatch() {
  return (await import("./route")).PATCH;
}

async function loadGet() {
  return (await import("./route")).GET;
}

// ---- Bug 1: PATCH 短路不能静默丢其他字段 ----

describe("Bug 1: PATCH status+other field 短路不能丢字段", () => {
  it("X. PATCH {status:current.status, title:'新'} → title 必须落库 (不再静默丢)", async () => {
    const r = createRequirement(projectA, { title: "原标题", description: "原描述" }, ownerA);
    expect(r.status).toBe("pending");
    const PATCH = await loadPatch();

    const res = await PATCH(patchReq(r.id, { status: "pending", title: "新标题" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("新标题");
    expect(body.status).toBe("pending");

    // GET 回来再确认 — 防止 updateRequirement 写错或 short-circuit 骗前端.
    const GET = await loadGet();
    const getRes = await GET(
      new NextRequest(`http://localhost/api/requirements/${r.id}`, {
        method: "GET",
        headers: { "x-user-id": ownerA },
      }),
      { params: Promise.resolve({ id: r.id }) }
    );
    const got = await getRes.json();
    expect(got.title).toBe("新标题");
    expect(got.description).toBe("原描述");
  });

  it("Y. PATCH {status:current.status, description:'新'} → description 必须落库", async () => {
    const r = createRequirement(projectA, { title: "t", description: "原 desc" }, ownerA);
    const PATCH = await loadPatch();

    const res = await PATCH(patchReq(r.id, { status: "pending", description: "新 desc" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe("新 desc");

    // GET 二次确认
    const fresh = getRequirementById(r.id, ownerA);
    expect(fresh?.description).toBe("新 desc");
    expect(fresh?.title).toBe("t"); // title 不动
  });

  it("Z. PATCH {status:current.status} (纯 status) → 200 + 不写 revision (幂等保留)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const PATCH = await loadPatch();

    // 记录 revisions 行数 (createRequirement 已写 1 条 title revision).
    const revBefore = getDb()
      .prepare("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?")
      .get(r.id) as { n: number };

    const res = await PATCH(patchReq(r.id, { status: "pending" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");

    // revision 行数不变 = 短路生效.
    const revAfter = getDb()
      .prepare("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?")
      .get(r.id) as { n: number };
    expect(revAfter.n).toBe(revBefore.n);
  });

  it("补丁: PATCH {status:'pending', title:'新', description:'新'} → 全部字段一并落 (多字段同测)", async () => {
    const r = createRequirement(projectA, { title: "原", description: "原 desc" }, ownerA);
    const PATCH = await loadPatch();
    const res = await PATCH(
      patchReq(r.id, { status: "pending", title: "新 title", description: "新 desc" }),
      { params: Promise.resolve({ id: r.id }) }
    );
    expect(res.status).toBe(200);
    const fresh = getRequirementById(r.id, ownerA);
    expect(fresh?.title).toBe("新 title");
    expect(fresh?.description).toBe("新 desc");
    expect(fresh?.status).toBe("pending");
  });
});

// ---- invariant §4.3 (a) DONE_GUARD ----

describe("R78 W1 §4.3 (a) invariant: status→done 守卫", () => {
  it("没有 dev/test/deploy completed task 时 PATCH status=done → 400 REQUIREMENT_DONE_GUARD", async () => {
    const r = createRequirement(projectA, { title: "no impl" }, ownerA);
    const PATCH = await loadPatch();

    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("REQUIREMENT_DONE_GUARD");
    // status 实际未变
    const fresh = getRequirementById(r.id, ownerA);
    expect(fresh?.status).toBe("pending");
  });

  it("Bug 3: DONE_GUARD hint 必须指向真实存在的 GET 字段 eligible_for_done (不再指 POST /qualifies-for-done)", async () => {
    const r = createRequirement(projectA, { title: "no impl" }, ownerA);
    const PATCH = await loadPatch();

    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("REQUIREMENT_DONE_GUARD");
    // hint 必须含 eligible_for_done 字串 (GET 字段), 不能含 qualifies-for-done (不存在的 POST 端点)
    expect(body.hint).toContain("eligible_for_done");
    expect(body.hint).not.toContain("qualifies-for-done");
  });

  it("Bug 3: GET /api/requirements/[id] 返回 eligible_for_done: boolean 契约保持", async () => {
    // 1) 无实现 task → eligible_for_done=false
    const r1 = createRequirement(projectA, { title: "no impl" }, ownerA);
    const GET = await loadGet();
    const getRes1 = await GET(
      new NextRequest(`http://localhost/api/requirements/${r1.id}`, {
        method: "GET",
        headers: { "x-user-id": ownerA },
      }),
      { params: Promise.resolve({ id: r1.id }) }
    );
    expect(getRes1.status).toBe(200);
    const body1 = await getRes1.json();
    expect(body1.eligible_for_done).toBe(false);

    // 2) 有 dev completed task → eligible_for_done=true
    const r2 = createRequirement(projectA, { title: "has impl" }, ownerA);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'impl', 'completed', ?, ?, ?, '[]', '', 'dev')`
      )
      .run(uuidv4(), ownerA, projectA, r2.id);
    const getRes2 = await GET(
      new NextRequest(`http://localhost/api/requirements/${r2.id}`, {
        method: "GET",
        headers: { "x-user-id": ownerA },
      }),
      { params: Promise.resolve({ id: r2.id }) }
    );
    const body2 = await getRes2.json();
    expect(body2.eligible_for_done).toBe(true);
  });

  it("有 dev completed task → status=done 放行", async () => {
    const r = createRequirement(projectA, { title: "has impl" }, ownerA);
    // 直接 INSERT dev completed task (绕过 createTask 避免拉 SDK).
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'impl', 'completed', ?, ?, ?, '[]', '', 'dev')`
      )
      .run(uuidv4(), ownerA, projectA, r.id);

    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(200);
    const fresh = getRequirementById(r.id, ownerA);
    expect(fresh?.status).toBe("done");
  });

  it("只有 design completed task → invariant 仍拒 (damo 痛点核心)", async () => {
    const r = createRequirement(projectA, { title: "design only" }, ownerA);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'design-task', 'completed', ?, ?, ?, '[]', '', 'design')`
      )
      .run(uuidv4(), ownerA, projectA, r.id);

    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("REQUIREMENT_DONE_GUARD");
  });
});

// ---- §4.4 idempotency 边界 ----

describe("R78 W1 §4.4 idempotency: 同 status 重复 PATCH", () => {
  it("PATCH {status:current.status} + 一堆 null/undefined 字段不视作单字段短路", async () => {
    // undefined 字段不算 key (与 updateRequirement 语义对齐). 但 null 字段是显式置空, 算 key.
    const r = createRequirement(projectA, { title: "t", description: "d" }, ownerA);
    const PATCH = await loadPatch();

    const res = await PATCH(
      patchReq(r.id, { status: "pending", description: null }), // description=null = 显式置空
      { params: Promise.resolve({ id: r.id }) }
    );
    expect(res.status).toBe(200);
    const fresh = getRequirementById(r.id, ownerA);
    expect(fresh?.description).toBeNull(); // 真的置空了, 不是被短路丢
  });

  it("REQUIREMENT_STATUSES 长度 = 6 (防 enum 漂移)", () => {
    expect(REQUIREMENT_STATUSES).toHaveLength(6);
    expect(REQUIREMENT_STATUSES).toContain("done");
    expect(REQUIREMENT_STATUSES).toContain("closed");
  });
});

// ---- owner 隔离 ----

describe("R78 W1: PATCH 跨 owner = 404 (no existence leak)", () => {
  it("ownerB PATCH ownerA 的 requirement → 404", async () => {
    const r = createRequirement(projectA, { title: "private" }, ownerA);
    const PATCH = await loadPatch();
    const res = await PATCH(
      patchReq(r.id, { status: "pending" }, ownerB),
      { params: Promise.resolve({ id: r.id }) }
    );
    expect(res.status).toBe(404);
  });
});

// =====================================================================
// R78 W4 集成验收: 10 条场景补齐 (W4 prompt §4.1 表).
// 涵盖: 状态机三段推进 / type ∈ {test, deploy} 完成放行 / 跨 owner GET 404 /
//       非法 status 400 STATUS_INVALID.
// =====================================================================

// W4 场景 2: suggestion → reply → done 三段状态机推进 (3 步均 200 + revision 写入).
describe("R78 W4: status 三段状态机推进 (suggestion → reply → done)", () => {
  it("pending → has_suggestion → awaiting_reply → done 三步都 200 + 各自写 revision", async () => {
    const r = createRequirement(projectA, { title: "flow" }, ownerA);
    // 先造一个 dev completed task, 满足 done 守卫 (场景 3 联动).
    const devTaskId = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'impl', 'completed', ?, ?, ?, '[]', '', 'dev')`
      )
      .run(devTaskId, ownerA, projectA, r.id);

    const PATCH = await loadPatch();

    // step 1: pending → has_suggestion
    const revBefore = getDb()
      .prepare("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?")
      .get(r.id) as { n: number };

    const res1 = await PATCH(patchReq(r.id, { status: "has_suggestion" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res1.status).toBe(200);
    expect((await res1.json()).status).toBe("has_suggestion");

    // step 2: has_suggestion → awaiting_reply (回退/任意方向都允许)
    const res2 = await PATCH(patchReq(r.id, { status: "awaiting_reply" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res2.status).toBe(200);
    expect((await res2.json()).status).toBe("awaiting_reply");

    // step 3: awaiting_reply → done (需要 impl task, 上面已造)
    const res3 = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res3.status).toBe(200);
    expect((await res3.json()).status).toBe("done");

    // revision 写入: create + 3 次 status 变更 = 至少 +3 行
    const revAfter = getDb()
      .prepare("SELECT COUNT(*) AS n FROM requirement_revisions WHERE requirement_id = ?")
      .get(r.id) as { n: number };
    expect(revAfter.n - revBefore.n).toBeGreaterThanOrEqual(3);
  });

  it("回退方向也允许: done → awaiting_reply (中间态之间任意方向)", async () => {
    // 先把 requirement 推到 done (需 impl task)
    const r = createRequirement(projectA, { title: "rollback" }, ownerA);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'impl', 'completed', ?, ?, ?, '[]', '', 'dev')`
      )
      .run(uuidv4(), ownerA, projectA, r.id);

    const PATCH = await loadPatch();
    const done = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(done.status).toBe(200);

    // 回退到 awaiting_reply (中间态之间任意方向都允许, 与 done-guard 解耦)
    const back = await PATCH(patchReq(r.id, { status: "awaiting_reply" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(back.status).toBe(200);
    expect((await back.json()).status).toBe("awaiting_reply");
  });
});

// W4 场景 3 扩展: type ∈ {test, deploy} completed 也可解锁 done (之前只测了 dev).
describe("R78 W4: type ∈ {test, deploy} completed 同样解锁 done 守卫", () => {
  it("test completed → status=done 放行", async () => {
    const r = createRequirement(projectA, { title: "test impl" }, ownerA);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'test-impl', 'completed', ?, ?, ?, '[]', '', 'test')`
      )
      .run(uuidv4(), ownerA, projectA, r.id);

    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(200);
    expect(getRequirementById(r.id, ownerA)?.status).toBe("done");
  });

  it("deploy completed → status=done 放行", async () => {
    const r = createRequirement(projectA, { title: "deploy impl" }, ownerA);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'dep-impl', 'completed', ?, ?, ?, '[]', '', 'deploy')`
      )
      .run(uuidv4(), ownerA, projectA, r.id);

    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(200);
    expect(getRequirementById(r.id, ownerA)?.status).toBe("done");
  });

  it("只有 completed null-type task → 仍拒 (type 是关键过滤项)", async () => {
    const r = createRequirement(projectA, { title: "null type" }, ownerA);
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'no-type', 'completed', ?, ?, ?, '[]', '', NULL)`
      )
      .run(uuidv4(), ownerA, projectA, r.id);

    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("REQUIREMENT_DONE_GUARD");
  });
});

// W4 场景 5: 跨 owner GET requirement → 404 (no existence leak, W1 已测 PATCH 跨 owner).
describe("R78 W4: GET 跨 owner = 404", () => {
  it("ownerB GET ownerA 的 requirement → 404 (不泄露存在性)", async () => {
    const r = createRequirement(projectA, { title: "private" }, ownerA);
    const GET = await loadGet();
    const res = await GET(
      new NextRequest(`http://localhost/api/requirements/${r.id}`, {
        method: "GET",
        headers: { "x-user-id": ownerB },
      }),
      { params: Promise.resolve({ id: r.id }) }
    );
    expect(res.status).toBe(404);
  });

  it("ownerB DELETE ownerA 的 requirement → 404", async () => {
    const r = createRequirement(projectA, { title: "private" }, ownerA);
    const { DELETE } = await import("./route");
    const res = await DELETE(
      new NextRequest(`http://localhost/api/requirements/${r.id}`, {
        method: "DELETE",
        headers: { "x-user-id": ownerB },
      }),
      { params: Promise.resolve({ id: r.id }) }
    );
    expect(res.status).toBe(404);
    // 确认 ownerA 的 requirement 没被删
    expect(getRequirementById(r.id, ownerA)?.status).toBe("pending");
  });
});

// W4 场景 6: PATCH 非法 status 值 → 400 + code: STATUS_INVALID.
describe("R78 W4: PATCH 非法 status = 400 STATUS_INVALID", () => {
  it("PATCH {status: 'BOGUS'} → 400 + code: STATUS_INVALID", async () => {
    const r = createRequirement(projectA, { title: "bad status" }, ownerA);
    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "BOGUS" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("STATUS_INVALID");
    // status 实际未变 (pending 默认)
    expect(getRequirementById(r.id, ownerA)?.status).toBe("pending");
  });

  it("PATCH {status: 'Done'} (大小写敏感) → 400 STATUS_INVALID", async () => {
    const r = createRequirement(projectA, { title: "case" }, ownerA);
    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "Done" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("STATUS_INVALID");
  });

  it("PATCH {status: ''} (空串) → 400 STATUS_INVALID", async () => {
    const r = createRequirement(projectA, { title: "empty" }, ownerA);
    const PATCH = await loadPatch();
    const res = await PATCH(patchReq(r.id, { status: "" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("STATUS_INVALID");
  });
});