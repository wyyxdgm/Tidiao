// 派发方溯源 (v32 dispatched_by_task_id) 在 POST + PATCH 路由层的回归测试.
//
// damo 0826 实测: server 侧 env 兜底读 process.env.ORCHESTRATOR_TASK_ID 会
// 被 pm2 env 残留污染 (c73132be agent 会话内重启 pm2 把 ORCHESTRATOR_TASK_ID
// 注入 ao-prod server 进程 env, 后续 38 条 HTTP 创建被静默归因 + prompt 被注入
// 污染 prelude). 本测试反测 server **不**读 env -- 派发方溯源走两条路径:
// (1) body 显式 dispatched_by_task_id 字段; (2) ao-dispatch.sh 客户端从
// agent 子进程 env 读 ORCHESTRATOR_TASK_ID 转成显式 --from-task.
//
// 关注点:
//   - DB 层 createTask 的存在性 + 同 owner 校验 (跨 owner / 不存在 抛
//     DISPATCHER_NOT_FOUND → 400) 已由 tasks-prompt-prelude.test.ts 覆盖,
//     这里只锁路由层: env **不**读, body 显式值为唯一来源.
//   - PATCH 拒写路径独立 (不走 createTask), 需单独覆盖.
//   - runtime 用 vi.mock 桩化, 避免启动 SDK subprocess.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById } from "@/lib/db/tasks";

// runtime 用 DB 层 createTask 替身, 不启动 SDK session.
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let otherOwnerId: string;
let projectId: string;
let upstreamId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dispatch-inject-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  otherOwnerId = uuidv4();
  for (const id of [ownerId, otherOwnerId]) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", "user");
  }
  projectId = createProject({ name: "dispatch-proj", ownerId }).id;
  // 先建一个上游 task, 拿它的 id 当 dispatcher 引用.
  upstreamId = createTask({ title: "上游", prompt: "u", project_id: projectId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_TASK_ID;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": ownerId },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks: dispatched_by_task_id 路由层校验 (server 不读 env)", () => {
  it("env 有 ORCHESTRATOR_TASK_ID 且 body 未传 -> 落 null (server 兜底已删，不再读 process.env)", async () => {
    process.env.ORCHESTRATOR_TASK_ID = upstreamId;
    const { POST } = await import("./route");

    const res = await POST(makeReq({
      title: "子任务",
      prompt: "p",
      project_id: projectId,
    }));
    expect(res.status).toBe(201);

    const created = (await res.json()) as { id: string; dispatched_by_task_id: string | null };
    // 反测：即使 env 残留了 upstreamId, server 也不读, 字段落 null.
    // 派发链如要建立, 走 ao-dispatch.sh 客户端把 env 转成 --from-task.
    expect(created.dispatched_by_task_id).toBeNull();
    expect(getTaskById(created.id)!.dispatched_by_task_id).toBeNull();
  });

  it("body 显式传 dispatched_by_task_id 决定落库值 (server 只信 body，忽略 env 残留)", async () => {
    process.env.ORCHESTRATOR_TASK_ID = upstreamId;
    const { POST } = await import("./route");
    const other = createTask({ title: "另一个上游", prompt: "u", project_id: projectId }).id;

    const res = await POST(makeReq({
      title: "t",
      prompt: "p",
      project_id: projectId,
      dispatched_by_task_id: other,
    }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { dispatched_by_task_id: string };
    // server 已删 env 回退, body 显式值是唯一来源. env 残留对此请求无影响.
    expect(created.dispatched_by_task_id).toBe(other);
  });

  it("env 不存在 + body 未传 -> 字段落 null (兼容非派发场景)", async () => {
    delete process.env.ORCHESTRATOR_TASK_ID;
    const { POST } = await import("./route");

    const res = await POST(makeReq({
      title: "独立任务",
      prompt: "p",
      project_id: projectId,
    }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { dispatched_by_task_id: string | null };
    expect(created.dispatched_by_task_id).toBeNull();
  });

  it("body 显式 null 时 dispatched_by_task_id 落 null (server 不读 env)", async () => {
    process.env.ORCHESTRATOR_TASK_ID = upstreamId;
    const { POST } = await import("./route");

    const res = await POST(makeReq({
      title: "t",
      prompt: "p",
      project_id: projectId,
      dispatched_by_task_id: null,
    }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { dispatched_by_task_id: string | null };
    // body 显式 null 就落 null, 即便 env 残留也不被读回覆盖. 与 ao-dispatch.sh
    // --no-from-task 对齐.
    expect(created.dispatched_by_task_id).toBeNull();
  });

  it("body 显式传不存在 task id -> 201 + dispatched_by_task_id 落 null + console.warn (0826 P1 降级)", async () => {
    // 0826 P1 (撞同根第 3 次): 真不存在的 dispatcher → warn + 降级 + 任务继续创建
    // (不抛 400). 派发方溯源是诊断信号, 链断了不该阻塞新任务. 跨 owner 仍抛
    // (见下一条). 详见 docs/conventions/dispatched-by-fallback.md.
    const { POST } = await import("./route");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await POST(makeReq({
        title: "t",
        prompt: "p",
        project_id: projectId,
        dispatched_by_task_id: "00000000-0000-0000-0000-000000000000",
      }));
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; dispatched_by_task_id: string | null };
      // 落库确认 null (不留 dangling reference).
      expect(created.dispatched_by_task_id).toBeNull();
      expect(getTaskById(created.id)!.dispatched_by_task_id).toBeNull();
      // console.warn 至少一次, 含 dispatcher ID + "falling back".
      const calls = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(calls).toContain("00000000-0000-0000-0000-000000000000");
      expect(calls).toContain("falling back");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("body 显式传别 owner 的 task id -> 400 DISPATCHER_NOT_FOUND (跨 owner 拦死)", async () => {
    const strangerProject = createProject({ name: "stranger", ownerId: otherOwnerId }).id;
    const strangerTask = createTask({ title: "别人的", prompt: "u", project_id: strangerProject }).id;

    const { POST } = await import("./route");
    const res = await POST(makeReq({
      title: "t",
      prompt: "p",
      project_id: projectId,
      dispatched_by_task_id: strangerTask,
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("DISPATCHER_NOT_FOUND");
  });

  it("env 设了跨 owner task id 但 body 未传：dispatched_by_task_id 落 null (不读 env，不触发 DB 校验)", async () => {
    // 反测：以前 server 兜底会读 env 然后到 DB 层被同 owner 校验拦死
    // → 400. 现在 server 不读 env, 整个跨 owner 路径在路由层就被跳过,
    // 字段安静落 null, 没有任何 400. 这正是修复想要的行为 —— pm2 env
    // 残留不该污染后续 HTTP 创建, 也不该让请求方拿到莫名其妙的 400.
    const strangerProject = createProject({ name: "stranger", ownerId: otherOwnerId }).id;
    const strangerTask = createTask({ title: "别人的", prompt: "u", project_id: strangerProject }).id;
    process.env.ORCHESTRATOR_TASK_ID = strangerTask;

    const { POST } = await import("./route");
    const res = await POST(makeReq({
      title: "t",
      prompt: "p",
      project_id: projectId,
    }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { dispatched_by_task_id: string | null };
    expect(created.dispatched_by_task_id).toBeNull();
  });
});

describe("PATCH /api/tasks/[id]: dispatched_by_task_id 拒写", () => {
  it("PATCH body 含 dispatched_by_task_id -> 400 DISPATCHED_BY_IMMUTABLE", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const { PATCH } = await import("./[id]/route");

    const req = new NextRequest(`http://localhost/api/tasks/${target}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user-id": ownerId },
      body: JSON.stringify({ dispatched_by_task_id: upstreamId }),
    });
    const params = Promise.resolve({ id: target });
    const res = await PATCH(req, { params });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("DISPATCHED_BY_IMMUTABLE");
    // 关键: 不写到库 (damo 0823 实测: partner PATCH 静默丢弃但 response 也带 null,
    // 现在直接 400, 调用方能立刻看见失败).
    expect(getTaskById(target)!.dispatched_by_task_id).toBeNull();
  });

  it("PATCH body 含 dispatched_by_task_id=null 也被拒 (任何写入尝试)", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const { PATCH } = await import("./[id]/route");

    const req = new NextRequest(`http://localhost/api/tasks/${target}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user-id": ownerId },
      body: JSON.stringify({ dispatched_by_task_id: null }),
    });
    const params = Promise.resolve({ id: target });
    const res = await PATCH(req, { params });
    expect(res.status).toBe(400);
  });

  it("PATCH 其他字段正常 + 不带 dispatched_by_task_id -> 200", async () => {
    const target = createTask({ title: "t", prompt: "p", project_id: projectId }).id;
    const { PATCH } = await import("./[id]/route");

    const req = new NextRequest(`http://localhost/api/tasks/${target}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user-id": ownerId },
      body: JSON.stringify({ title: "新标题" }),
    });
    const params = Promise.resolve({ id: target });
    const res = await PATCH(req, { params });
    expect(res.status).toBe(200);
    expect(getTaskById(target)!.title).toBe("新标题");
    // 顺便确认 PATCH 没误碰 dispatched_by_task_id (虽然本来也是 null).
    expect(getTaskById(target)!.dispatched_by_task_id).toBeNull();
  });
});