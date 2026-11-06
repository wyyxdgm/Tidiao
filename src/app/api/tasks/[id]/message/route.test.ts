// POST /api/tasks/[id]/message 的 sender_type 校验回归测试 (R55 B1).
//
// 覆盖:
//   - 缺省 sender_type → 透传 "user" 给 sendUserMessage
//   - 显式 sender_type="script" → 透传 "script"
//   - 非法值 → 400 + 错误信息, sendUserMessage 不被调用
//   - 缺 message → 400 (保持原行为)
//
// 关注点:
//   - 用 vi.mock runtime 桩化, 避免 SDK subprocess.
//   - runtime.sendUserMessage 用 vi.fn() 捕获入参断言.
//   - 复用 start/route.test.ts 的 db/temp-dir 模式.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { createUser } from "@/lib/db/users";

const sendUserMessage = vi.fn();

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: vi.fn(),
    sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let userId: string;
let taskId: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-msg-sender-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();

  const user = await createUser(`u-${Date.now()}@example.com`, "pw");
  userId = user.id;
  const proj = createProject({ name: "p", ownerId: userId });
  taskId = createTask({ title: "T", prompt: "p", project_id: proj.id, session_id: uuidv4() }).id;

  sendUserMessage.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeReq(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/tasks/${taskId}/message`, {
    method: "POST",
    headers: { "x-user-id": userId, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/message: sender_type (R55 B1)", () => {
  it("缺省 sender_type → 透传 'user' 给 runtime", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ message: "hi" }), {
      params: Promise.resolve({ id: taskId }),
    });
    expect(res.status).toBe(200);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    // args: (taskId, message, opts, reason, senderType)
    const args = sendUserMessage.mock.calls[0];
    expect(args[0]).toBe(taskId);
    expect(args[1]).toBe("hi");
    expect(args[4]).toBe("user"); // ← senderType 缺省透传 "user"
  });

  it("显式 sender_type='script' → 透传 'script'", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ message: "xfer", sender_type: "script" }), {
      params: Promise.resolve({ id: taskId }),
    });
    expect(res.status).toBe(200);
    expect(sendUserMessage.mock.calls[0][4]).toBe("script");
  });

  it("显式 sender_type='system' → 透传 'system'", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ message: "deploy ok", sender_type: "system" }), {
      params: Promise.resolve({ id: taskId }),
    });
    expect(res.status).toBe(200);
    expect(sendUserMessage.mock.calls[0][4]).toBe("system");
  });

  it("非法 sender_type='foo' → 400 + sendUserMessage 不被调用", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ message: "x", sender_type: "foo" }), {
      params: Promise.resolve({ id: taskId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid sender_type/);
    expect(body.error).toMatch(/user\|script\|system/);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("缺 message → 400 (保持原行为, sender_type 不影响)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ sender_type: "script" }), {
      params: Promise.resolve({ id: taskId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("message is required");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});