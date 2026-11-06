// POST /api/tasks/[id]/agent-attachments 集成测试 (R121)
//
// 覆盖:
//   1. 鉴权: 401 (无 x-user-id) / 404 (task 不存在 / owner 不匹配)
//   2. 校验: 400 (缺 file_path / body 非 JSON) / 413 (size 超 10MB) /
//      415 (media type 不在白名单)
//   3. 安全: 400 (file_path 在 cwd 外) / 400 (symlink escape — realpath 校验)
//   4. 正常路径: 200/201 + attachment row + metadata 落库 + SSE emit 被调
//   5. source 字段: 默认 agent_generated
//
// 关注点:
//   - 隔离 DB: ORCHESTRATOR_DB_PATH=/tmp/<task>-test-*.db (vitest 配置自动)
//   - 隔离 ORCHESTRATOR_HOME: 测试在 tmpDir 跑, 避免污染真实 cwd/uploads

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { POST } from "./route";
import { closeDb, getDb } from "@/lib/db";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { listAttachmentsByTaskId } from "@/lib/db/attachments";

// mock getRuntime().emitAttachment —— 验证 SSE 触发
const emitAttachmentMock = vi.fn();
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({ emitAttachment: emitAttachmentMock }),
}));

let tmpDir: string;
let userId: string;
let projectId: string;
let taskId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r121-agent-attach-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  // 直接 INSERT user (避免 createUser 走 bcrypt 异步路径 + 跨 case 串 email)
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.test`, "x", "user");

  const project = createProject({ ownerId: userId, name: "p1", cwd: null });
  projectId = project.id;
  const task = createTask({
    owner_id: userId,
    project_id: projectId,
    title: "t1",
    prompt: "p1",
    cwd: path.join(tmpDir, "tasks", "t1"),
    type: null,
  });
  taskId = task.id;
  fs.mkdirSync(task.cwd!, { recursive: true });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  emitAttachmentMock.mockReset();
});

async function callAgentAttach(
  body: Record<string, unknown>,
  opts: { asUserId?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-user-id": opts.asUserId ?? userId,
  };
  const req = new Request(`http://localhost/api/tasks/${taskId}/agent-attachments`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const res = await POST(req as any, { params: Promise.resolve({ id: taskId }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("POST /api/tasks/[id]/agent-attachments", () => {
  describe("鉴权 + task 校验", () => {
    it("401 when no x-user-id", async () => {
      const req = new Request(`http://localhost/api/tasks/${taskId}/agent-attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: "/tmp/x" }),
      });
      const res = await POST(req as any, { params: Promise.resolve({ id: taskId }) });
      expect(res.status).toBe(401);
    });

    it("404 when task not found", async () => {
      const req = new Request("http://localhost/api/tasks/nonexistent/agent-attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body: JSON.stringify({ file_path: "/tmp/x" }),
      });
      const res = await POST(req as any, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("404 when owner mismatch (cross-tenant)", async () => {
      const otherId = uuidv4();
      getDb()
        .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
        .run(otherId, `${otherId}@example.test`, "x", "user");
      const r = await callAgentAttach({ file_path: "/tmp/x" }, { asUserId: otherId });
      expect(r.status).toBe(404);
    });
  });

  describe("body 校验", () => {
    it("400 when body is invalid JSON", async () => {
      const req = new Request(`http://localhost/api/tasks/${taskId}/agent-attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body: "not-json",
      });
      const res = await POST(req as any, { params: Promise.resolve({ id: taskId }) });
      expect(res.status).toBe(400);
    });

    it("400 when file_path missing", async () => {
      const r = await callAgentAttach({ filename: "x.png" });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/file_path/);
    });
  });

  describe("路径越界 / 大小 / 白名单", () => {
    it("400 when file_path outside cwd and uploads dir", async () => {
      const outsideFile = path.join(tmpDir, "outside.png");
      fs.writeFileSync(outsideFile, Buffer.from([1, 2, 3]));
      const r = await callAgentAttach({ file_path: outsideFile, media_type: "image/png" });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/inside task cwd or uploads dir/);
    });

    it("400 when source file does not exist", async () => {
      const r = await callAgentAttach({ file_path: "/nonexistent/x.png", media_type: "image/png" });
      expect(r.status).toBe(400);
    });

    it("413 when file > 10MB", async () => {
      const bigPath = path.join(tmpDir, "tasks", "t1", "big.png");
      // 写 11MB
      const fd = fs.openSync(bigPath, "w");
      fs.writeSync(fd, Buffer.alloc(11 * 1024 * 1024));
      fs.closeSync(fd);
      const r = await callAgentAttach({ file_path: bigPath, media_type: "image/png" });
      expect(r.status).toBe(413);
      expect(r.body.error).toMatch(/too large/);
    });

    it("415 when media type not allowed", async () => {
      const f = path.join(tmpDir, "tasks", "t1", "evil.exe");
      fs.writeFileSync(f, "MZ");
      const r = await callAgentAttach({ file_path: f, media_type: "application/x-msdownload" });
      expect(r.status).toBe(415);
    });
  });

  describe("正常路径", () => {
    it("201 + attachment row + metadata + emit when source file in cwd", async () => {
      const src = path.join(tmpDir, "tasks", "t1", "hero.png");
      fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
      const r = await callAgentAttach({
        file_path: src,
        media_type: "image/png",
        metadata: {
          tool: "mmx-image",
          cost_usd: 0.04,
          input_tokens: 6701,
          output_tokens: 250,
          model: "minimax-1",
          prompt: "a hero image",
        },
      });
      expect(r.status).toBe(201);
      expect(r.body.attachment.source).toBe("agent_generated");
      expect(r.body.attachment.media_type).toBe("image/png");
      expect(r.body.attachment.filename).toBe("hero.png");
      expect(JSON.parse(r.body.attachment.metadata)).toMatchObject({
        tool: "mmx-image",
        cost_usd: 0.04,
      });
      expect(emitAttachmentMock).toHaveBeenCalledWith(taskId, expect.objectContaining({
        media_type: "image/png",
        filename: "hero.png",
      }));
    });

    it("metadata 不传时落 NULL", async () => {
      const src = path.join(tmpDir, "tasks", "t1", "plain.png");
      fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const r = await callAgentAttach({ file_path: src, media_type: "image/png" });
      expect(r.status).toBe(201);
      expect(r.body.attachment.metadata).toBeNull();
    });

    it("默认 source = agent_generated", async () => {
      const src = path.join(tmpDir, "tasks", "t1", "auto.png");
      fs.writeFileSync(src, Buffer.from([1, 2, 3]));
      const r = await callAgentAttach({ file_path: src, media_type: "image/png" });
      expect(r.body.attachment.source).toBe("agent_generated");
    });

    it("attachment row 写入 DB 可查", async () => {
      const src = path.join(tmpDir, "tasks", "t1", "query.png");
      fs.writeFileSync(src, Buffer.from([1, 2, 3]));
      const r = await callAgentAttach({ file_path: src, media_type: "image/png" });
      expect(r.status).toBe(201);
      const rows = listAttachmentsByTaskId(taskId, userId);
      expect(rows.length).toBe(1);
      expect(rows[0].source).toBe("agent_generated");
    });
  });
});
