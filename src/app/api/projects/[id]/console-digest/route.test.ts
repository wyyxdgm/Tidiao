// GET /api/projects/[id]/console-digest 路由测试 (R195).
// 不 mock generateConsoleDigest 的模块, 但走「owner 无 LLM key」路径让生成必然
// 失败 — 这样四条分支 (cache/empty/failed/stale) 都能在纯本地 DB 上确定性触发.
// 真 LLM 的行为契约在 console-digest.test.ts (parse/fingerprint) + 无头脚本实跑.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { setSetting, getSetting } from "@/lib/db/settings";
import { digestFingerprint } from "@/lib/runtime/console-digest";
import { GET } from "./route";
import type { Task } from "@/lib/db/tasks";

let tmpDir: string;
let ownerId: string;
let otherId: string;
let projectId: string;

async function call(opts?: {
  userId?: string;
  role?: string;
  pid?: string;
  refresh?: boolean;
}) {
  const pid = opts?.pid ?? projectId;
  const url = `http://localhost/api/projects/${pid}/console-digest${opts?.refresh ? "?refresh=true" : ""}`;
  const req = new NextRequest(url, {
    headers: {
      "x-user-id": opts?.userId ?? ownerId,
      "x-user-role": opts?.role ?? "user",
    },
  });
  const res = await GET(req, { params: Promise.resolve({ id: pid }) });
  return { status: res.status, json: await res.json() };
}

function mkTask(title: string, status = "queued"): Task {
  return createTask({ title, prompt: "p", project_id: projectId }) as unknown as Task;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-digest-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  ownerId = uuidv4();
  otherId = uuidv4();
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
  );
  ins.run(ownerId, `${ownerId}@example.com`, "x");
  ins.run(otherId, `${otherId}@example.com`, "x");
  projectId = createProject({ name: "p-digest", ownerId }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("GET /api/projects/[id]/console-digest", () => {
  it("401 无 x-user-id", async () => {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}/console-digest`, {
      headers: {},
    });
    const res = await GET(req, { params: Promise.resolve({ id: projectId }) });
    expect(res.status).toBe(401);
  });

  it("404 项目不存在 / 他人项目 (非 admin)", async () => {
    (await call({ pid: uuidv4() })).status === 404;
    expect((await call({ pid: uuidv4() })).status).toBe(404);
    expect((await call({ userId: otherId })).status).toBe(404);
  });

  it("admin 只读旁路: 他人项目 200", async () => {
    const r = await call({ userId: otherId, role: "admin" });
    expect(r.status).toBe(200);
  });

  it("无任务 → source:empty + 缓存落库", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("empty");
    expect(r.json.digest.items).toEqual([]);
    const cached = getSetting(`console_digest:${projectId}`);
    expect(cached).toBeTruthy();
    expect(JSON.parse(cached!).fingerprint).toBe(digestFingerprint([]));
  });

  it("指纹命中 → source:cache (零 LLM)", async () => {
    const t = mkTask("任务A");
    const fingerprint = digestFingerprint([t]);
    setSetting(
      `console_digest:${projectId}`,
      JSON.stringify({
        fingerprint,
        digest: { headline: "缓存里的归纳", items: [] },
        at: "2026-10-05T00:00:00Z",
        model: "m",
      }),
    );
    const r = await call();
    expect(r.json.source).toBe("cache");
    expect(r.json.digest.headline).toBe("缓存里的归纳");
  });

  it("无缓存 + owner 无 LLM key → source:failed (digest null)", async () => {
    mkTask("任务B");
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("failed");
    expect(r.json.digest).toBeNull();
  });

  it("生成失败但有旧缓存 → source:stale 回退旧归纳", async () => {
    const t = mkTask("任务C");
    setSetting(
      `console_digest:${projectId}`,
      JSON.stringify({
        fingerprint: "stale-fp",
        digest: { headline: "旧归纳", items: [] },
        at: "2026-10-04T00:00:00Z",
        model: "m",
      }),
    );
    const r = await call();
    expect(r.json.source).toBe("stale");
    expect(r.json.digest.headline).toBe("旧归纳");
    expect(t.id).toBeTruthy();
  });

  it("任务变了指纹失效 → 尝试重算; 失败时回 stale 旧归纳 (不是 cache)", async () => {
    const t1 = mkTask("任务D");
    setSetting(
      `console_digest:${projectId}`,
      JSON.stringify({
        fingerprint: digestFingerprint([t1]),
        digest: { headline: "旧", items: [] },
        at: "x",
        model: "m",
      }),
    );
    mkTask("任务E"); // 任务集变了 → 指纹失配
    const r = await call();
    expect(r.json.source).toBe("stale"); // 重算失败回旧归纳, 不是 cache (指纹不符)
    expect(r.json.digest.headline).toBe("旧");
  });

  it("refresh=true 绕过指纹命中重算; 失败时同样 stale 回退", async () => {
    const t = mkTask("任务F");
    setSetting(
      `console_digest:${projectId}`,
      JSON.stringify({
        fingerprint: digestFingerprint([t]),
        digest: { headline: "缓存", items: [] },
        at: "x",
        model: "m",
      }),
    );
    const r = await call({ refresh: true });
    expect(r.json.source).toBe("stale"); // 绕过了缓存 (否则 source=cache), 生成失败回旧值
  });
});
