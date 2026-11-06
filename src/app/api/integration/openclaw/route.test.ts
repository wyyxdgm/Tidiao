// /api/integration/openclaw 路由回归测试.
//
// 功能: 跑真实 POST 路由 (runtime 桩化, DB 是真的), 覆盖 HMAC/时间戳/schema/幂等/
//   target 解析/trace 冲突/env 回退等所有分支. 不 mock 平台 (DB + project + user 都是自建).
// 关注点: OPENCLAW_WEBHOOK_SECRET 在路由模块顶层读取, 必须先 setenv 再 dynamic import;
//   每个 case 用唯一 trace_id 避免跨 case 撞 UNIQUE(channel, external_user_id) 兜底.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { NextRequest } from "next/server";

// 桩 runtime: createTask 落 DB (走真 db layer), 不真起 SDK.
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
  }),
}));

let tmpDir: string;
let projectId: string;
const SECRET = "test-openclaw-secret-xxx";
const FALLBACK_PROJ_ENV = "INTAKE_OPENCLAW_PROJECT_ID";

function sign(body: string, ts: string): string {
  return (
    "sha256=" +
    createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")
  );
}

function buildRequest(body: string, ts?: string, sig?: string | null) {
  const tsHeader = ts ?? String(Date.now());
  const sigHeader = sig === undefined ? sign(body, tsHeader) : sig;
  return new NextRequest("http://localhost/api/integration/openclaw", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenClaw-Timestamp": tsHeader,
      ...(sigHeader ? { "X-OpenClaw-Signature": sigHeader } : {}),
    },
    body,
  });
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "dispatch",
    trace_id: uuidv4(),
    source: "openclaw-gateway",
    ts: new Date().toISOString(),
    target: { project_id: projectId },
    payload: { prompt: "hello partner" },
    reply_to: "feishu",
    ...overrides,
  });
}

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-openclaw-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.OPENCLAW_WEBHOOK_SECRET = SECRET;
  delete process.env[FALLBACK_PROJ_ENV];
  closeDb();
  getDb();

  const ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: `ocw-${Math.random().toString(36).slice(2, 8)}`, ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.OPENCLAW_WEBHOOK_SECRET;
  delete process.env[FALLBACK_PROJ_ENV];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("OpenClaw bridge 路由", () => {
  it("签名正确 + 新 trace_id → 200 created + 落 1 task + 1 intake_thread", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("created");
    expect(json.project_id).toBe(projectId);

    const tasks = getDb().prepare(`SELECT id, tags FROM tasks`).all() as {
      id: string;
      tags: string | null;
    }[];
    expect(tasks).toHaveLength(1);
    expect(JSON.parse(tasks[0].tags!)).toEqual(
      expect.arrayContaining(["openclaw", "src:openclaw-gateway"])
    );

    const threads = getDb()
      .prepare(`SELECT * FROM intake_threads WHERE channel = 'openclaw'`)
      .all();
    expect(threads).toHaveLength(1);
  });

  it("同 trace_id 重发 → 200 replay + 仍 1 task (幂等)", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    const r1 = await POST(buildRequest(body));
    const j1 = await r1.json();
    expect(j1.mode).toBe("created");

    const r2 = await POST(buildRequest(body));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.mode).toBe("replay");
    expect(j2.task_id).toBe(j1.task_id);

    const tasks = getDb().prepare(`SELECT id FROM tasks`).all();
    expect(tasks).toHaveLength(1);
  });

  it("签名错误 → 403 + DB 无变化", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    const res = await POST(buildRequest(body, String(Date.now()), "sha256=" + "0".repeat(64)));
    expect(res.status).toBe(403);
    const tasks = getDb().prepare(`SELECT id FROM tasks`).all();
    expect(tasks).toHaveLength(0);
  });

  it("缺 signature header → 403", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    const res = await POST(buildRequest(body, String(Date.now()), null));
    expect(res.status).toBe(403);
  });

  it("secret 未配置 → 403", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    delete process.env.OPENCLAW_WEBHOOK_SECRET;
    vi.resetModules();
    const { POST: POST2 } = await import("./route");
    const res = await POST2(buildRequest(body));
    expect(res.status).toBe(403);
  });

  it("时间戳漂移 10min → 408", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    const oldTs = String(Date.now() - 10 * 60 * 1000);
    const res = await POST(buildRequest(body, oldTs));
    expect(res.status).toBe(408);
  });

  it("body 非 JSON → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(buildRequest("not json {{{"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("bad_json");
  });

  it("缺 prompt → 400 + zod issue", async () => {
    const { POST } = await import("./route");
    const body = JSON.stringify({
      action: "dispatch",
      trace_id: uuidv4(),
      source: "openclaw-gateway",
      ts: new Date().toISOString(),
      target: { project_id: projectId },
      payload: {},
    });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("bad_schema");
    expect(json.message).toContain("prompt");
  });

  it("trace_id 非 UUID → 400", async () => {
    const { POST } = await import("./route");
    const body = validBody({ trace_id: "not-a-uuid" });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(400);
  });

  it("action 不支持 → 400", async () => {
    const { POST } = await import("./route");
    const body = validBody({ action: "query" });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(400);
  });

  it("target 用 project_slug → 正确解析", async () => {
    const { POST } = await import("./route");
    const projectName = (
      getDb().prepare(`SELECT name FROM projects WHERE id = ?`).get(projectId) as {
        name: string;
      }
    ).name;
    const body = validBody({ target: { project_slug: projectName } });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.project_id).toBe(projectId);
  });

  it("target 缺 + env 未配 → 400 no_target", async () => {
    const { POST } = await import("./route");
    const body = validBody({ target: undefined });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("no_target");
  });

  it("target 用 env INTAKE_OPENCLAW_PROJECT_ID 回退", async () => {
    // FALLBACK_PROJECT_ID 在路由模块顶层读取; 必须先 setenv 再 import.
    process.env[FALLBACK_PROJ_ENV] = projectId;
    const { POST } = await import("./route");
    const body = validBody({ target: undefined });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
  });

  it("target 用不存在 project_id → 502", async () => {
    const { POST } = await import("./route");
    const body = validBody({ target: { project_id: uuidv4() } });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(502);
  });

  it("同 trace_id + 不同 target 重试 → 409 + 返回原 task_id", async () => {
    const { POST } = await import("./route");
    const traceId = uuidv4();
    // 第二个 project 复用同 owner (FK 要求 user 先存在, 这次直接拿现成的).
    const otherProjectId = createProject({
      name: `other-${Math.random().toString(36).slice(2, 6)}`,
      ownerId: (
        getDb().prepare(`SELECT owner_id FROM projects WHERE id = ?`).get(projectId) as {
          owner_id: string;
        }
      ).owner_id,
    }).id;

    const body1 = validBody({ trace_id: traceId, target: { project_id: projectId } });
    const r1 = await POST(buildRequest(body1));
    expect(r1.status).toBe(200);

    const body2 = validBody({ trace_id: traceId, target: { project_id: otherProjectId } });
    const r2 = await POST(buildRequest(body2));
    expect(r2.status).toBe(409);
    const j2 = await r2.json();
    expect(j2.error).toBe("trace_conflict");
    expect(j2.task_id).toBeDefined();
  });

  it("GET 探针 → 200 + 反映 secret/env 状态", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe("probe");
    expect(j.secret_configured).toBe(true);
    expect(j.fallback_project_configured).toBe(false);
  });

  it("payload.allowed_tools 显式传 → 落库到 allowed_tools", async () => {
    const { POST } = await import("./route");
    const body = validBody({
      payload: {
        prompt: "build me a thing",
        allowed_tools: ["Read", "Bash", "Write"],
      },
    });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(`SELECT allowed_tools FROM tasks`)
      .get() as { allowed_tools: string | null };
    expect(row.allowed_tools).not.toBeNull();
    expect(JSON.parse(row.allowed_tools!)).toEqual(["Read", "Bash", "Write"]);
  });

  it("空 allowed_tools → 不写 allowed_tools (落 DEFAULT_TOOLS)", async () => {
    const { POST } = await import("./route");
    const body = validBody();
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(`SELECT allowed_tools FROM tasks`)
      .get() as { allowed_tools: string | null };
    expect(row.allowed_tools).toBeNull();
  });

  it("payload.effort=high 落库", async () => {
    const { POST } = await import("./route");
    const body = validBody({ payload: { prompt: "x", effort: "high" } });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
    const row = getDb().prepare(`SELECT effort FROM tasks`).get() as { effort: string };
    expect(row.effort).toBe("high");
  });

  it("payload.auto_approve=false 落库", async () => {
    const { POST } = await import("./route");
    const body = validBody({ payload: { prompt: "x", auto_approve: false } });
    const res = await POST(buildRequest(body));
    expect(res.status).toBe(200);
    const row = getDb()
      .prepare(`SELECT auto_approve FROM tasks`)
      .get() as { auto_approve: number };
    expect(row.auto_approve).toBe(0);
  });
});
