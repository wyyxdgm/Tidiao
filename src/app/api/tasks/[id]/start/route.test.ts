// POST /api/tasks/[id]/start 的 R88 quota 拦截回归测试.
//
// 覆盖 Sheet L 验收 ⑥ "模拟 quota 触发 → 任务拒绝 + 友好提示":
//   - party_a_enabled=1 + 累计 cost >= cap → 403 + code=QUOTA_BLOCKED
//   - party_a_enabled=1 + expire_at 已过期 → 403 + code=QUOTA_BLOCKED + reason=expired
//   - party_a_enabled=0 (普通用户) → 不走 quota, 直接放行
//
// 关注点:
//   - 用真实 DB (不是 vi.mock checkUserQuota), 跟 quota.test.ts 同源, 验证拦截
//     点 (路由层) 与判据 (lib 层) 之间的集成 = 真实链路.
//   - runtime 用 vi.mock 桩化, 避免 SDK subprocess.
//   - 现有 quota.test.ts 21 条覆盖了 checkUserQuota 本身的所有边界; 这里只验证
//     路由层调用了它 + 正确返 403.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import {
  createUser,
  setUserPartyAEnabled,
  setUserQuotaTotalSpentCap,
  setUserQuotaExpireAt,
} from "@/lib/db/users";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: vi.fn(),
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let partyAUserId: string;
let normalUserId: string;
let taskAId: string;
let taskNormalId: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-start-quota-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  // 关键: 清掉平台注入的 ORCHESTRATOR_TASK_ID, 避免被测 test 误派
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();

  // 两个 user: 每个各持一个 project + task. 隔离 owner 才能让 normal user 看
  //   到自己的 task (start route 有 ownership gate).
  const partyA = await createUser(`pa-${Date.now()}@example.com`, "pw");
  partyAUserId = partyA.id;
  const normal = await createUser(`normal-${Date.now()}@example.com`, "pw");
  normalUserId = normal.id;

  const projA = createProject({ name: "pA", ownerId: partyAUserId });
  const projNormal = createProject({ name: "pN", ownerId: normalUserId });
  taskAId = createTask({ title: "T-A", prompt: "p", project_id: projA.id }).id;
  taskNormalId = createTask({
    title: "T-N",
    prompt: "p",
    project_id: projNormal.id,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makePostReq(taskId: string, userId: string) {
  return new NextRequest(`http://localhost/api/tasks/${taskId}/start`, {
    method: "POST",
    headers: { "x-user-id": userId, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /api/tasks/[id]/start: R88 quota 拦截 (Sheet L 验收 ⑥)", () => {
  it("party_a=1 + cap 已触达 → 403 + code=QUOTA_BLOCKED + reason=total_spent_cap", async () => {
    // 把 task 的 cost_usd 写满 cap, 让 checkUserQuota 触发拦截
    setUserPartyAEnabled(partyAUserId, true, {
      operatorId: partyAUserId,
      reason: "test setup",
    });
    setUserQuotaTotalSpentCap(partyAUserId, 5, {
      operatorId: partyAUserId,
      reason: "test setup",
    });
    // 用 partyA 用户的任意 task 做种子 cost; update 直接按 owner_id 写
    getDb()
      .prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`)
      .run(5, partyAUserId);

    const { POST } = await import("./route");
    const res = await POST(makePostReq(taskAId, partyAUserId), {
      params: Promise.resolve({ id: taskAId }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; reason: string; quota: { allowed: boolean } };
    expect(body.code).toBe("QUOTA_BLOCKED");
    expect(body.reason).toBe("total_spent_cap");
    expect(body.quota.allowed).toBe(false);
  });

  it("party_a=1 + expire_at 已过期 → 403 + reason=expired", async () => {
    setUserPartyAEnabled(partyAUserId, true, {
      operatorId: partyAUserId,
      reason: "test setup",
    });
    setUserQuotaExpireAt(partyAUserId, "2020-01-01T00:00:00Z", {
      operatorId: partyAUserId,
      reason: "test setup",
    });

    const { POST } = await import("./route");
    const res = await POST(makePostReq(taskAId, partyAUserId), {
      params: Promise.resolve({ id: taskAId }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("QUOTA_BLOCKED");
    expect(body.reason).toBe("expired");
  });

  it("party_a=0 普通用户 → 不走 quota, 放行 (Sheet L 验收 ③ 老用户无感)", async () => {
    // 给 normalUser 配 cap+expire 全炸的状态, 验证 party_a=0 直接 bypass
    setUserQuotaTotalSpentCap(normalUserId, 5, {
      operatorId: normalUserId,
      reason: "test setup",
    });
    setUserQuotaExpireAt(normalUserId, "2020-01-01T00:00:00Z", {
      operatorId: normalUserId,
      reason: "test setup",
    });
    getDb()
      .prepare(`UPDATE tasks SET cost_usd = ? WHERE id = ?`)
      .run(100, taskNormalId); // 超 cap, 也过期

    const { POST } = await import("./route");
    const res = await POST(makePostReq(taskNormalId, normalUserId), {
      params: Promise.resolve({ id: taskNormalId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("party_a=1 + cap=NULL/0 → 不限, 放行 (Sheet L 验收 ② ≤0=NUll=不限)", async () => {
    setUserPartyAEnabled(partyAUserId, true, {
      operatorId: partyAUserId,
      reason: "test setup",
    });
    // cap 不设 (NULL), 累计 cost 超大也放行
    getDb()
      .prepare(`UPDATE tasks SET cost_usd = ? WHERE id = ?`)
      .run(9999, taskAId);

    const { POST } = await import("./route");
    const res = await POST(makePostReq(taskAId, partyAUserId), {
      params: Promise.resolve({ id: taskAId }),
    });
    expect(res.status).toBe(200);
  });
});