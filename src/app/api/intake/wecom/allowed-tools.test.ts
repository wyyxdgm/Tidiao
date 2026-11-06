// 企微 intake 入站建 task 时的工具收口回归测试.
//
// 功能: 走真实 POST 路由（企微 client 与 runtime 桩化, DB/createTask 是真的），
//   断言新建的 intake task 落库的 allowed_tools 是只读探索集、不含 Bash/Write/Edit.
// 关注点: INTAKE_PROJECT_ID 在路由模块顶层读取, 所以必须先设 env 再 dynamic import;
//   断言用「不含写类工具」而不是数组全等, 这样以后往探索集里加只读工具不会误红,
//   但一旦有人把 allowedTools 去掉（落回 DEFAULT_TOOLS 全开）立刻失败.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById } from "@/lib/db/tasks";
import { NextRequest } from "next/server";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
  }),
}));

vi.mock("@/lib/intake/wecom", () => ({
  decryptCallbackBody: () => "<xml/>",
  extractCallbackCursor: () => "cursor-1",
  syncMessages: async () => [{ externalUserId: "wmABCDEF123456", content: "登录页要改" }],
  ensureBotServiceState: async () => {},
  handleUrlVerification: () => null,
  isUrlVerification: () => false,
  // D1: 路由凭据候选 —— 这里桩成空表行 + env 兜底, 走 INTAKE_PROJECT_ID 旧路径
  listWecomCandidates: () => [
    {
      channelId: null,
      boundProjectId: null,
      roleId: null,
      creds: { corpId: "", corpSecret: "", aesKey: "", callbackToken: "", kfId: "" },
    },
  ],
  getWecomChannelByKfId: () => null,
}));

let tmpDir: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-tools-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  const ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "intake-proj", ownerId }).id;
  process.env.INTAKE_PROJECT_ID = projectId;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.INTAKE_PROJECT_ID;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("企微 intake 新线程的工具集", () => {
  it("落库的 allowed_tools 不含 Bash/Write/Edit, 且含只读工具", async () => {
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/api/intake/wecom", { method: "POST", body: "x" }));
    expect(res.status).toBe(200);

    const rows = getDb().prepare(`SELECT id, allowed_tools FROM tasks`).all() as {
      id: string;
      allowed_tools: string | null;
    }[];
    expect(rows).toHaveLength(1);

    // 关键断言: 不是 null（null = 运行时回落 DEFAULT_TOOLS 全开）
    expect(rows[0].allowed_tools).not.toBeNull();
    const tools = JSON.parse(rows[0].allowed_tools!) as string[];
    for (const w of ["Bash", "Write", "Edit", "NotebookEdit"]) {
      expect(tools).not.toContain(w);
    }
    expect(tools).toContain("Read");
    expect(tools).toContain("Grep");

    // task 确实是 intake 线程那条
    const task = getTaskById(rows[0].id)!;
    expect(task.tags).toContain("wecom");
  });

  it("对照: 不传 allowedTools 时 allowed_tools 为 null（= 全开）", () => {
    const t = createTask({ title: "control", prompt: "p", project_id: projectId });
    const row = getDb().prepare(`SELECT allowed_tools FROM tasks WHERE id = ?`).get(t.id) as {
      allowed_tools: string | null;
    };
    expect(row.allowed_tools).toBeNull();
  });
});
