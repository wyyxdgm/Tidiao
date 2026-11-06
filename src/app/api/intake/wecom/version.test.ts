// 企微 intake 绑定版本 (v529) 传递测试.
//
// 功能: 走真实 POST 路由 (wecom client 与 runtime 桩化, DB/createTask 是真的),
//   断言渠道行钉了 bound_version_id 时新建的 intake task 落该 version;
//   NULL (含 env 兜底路径) 时不传 → task.version_id 空 = 跟随项目 current_version.
// 关注点: 同 allowed-tools.test.ts —— INTAKE_PROJECT_ID 在路由模块顶层读取,
//   必须先设 env 再 dynamic import; listWecomCandidates 桩化隔离真实凭据解密.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { NextRequest } from "next/server";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
  }),
}));

// 桩候选: 测试里按用例覆盖 (withVersion / envFallback 两种形态)
const candidates: any[] = [];
vi.mock("@/lib/intake/wecom", () => ({
  decryptCallbackBody: () => "<xml/>",
  extractCallbackCursor: () => "cursor-1",
  syncMessages: async () => [{ externalUserId: "wmABCDEF123456", content: "登录页要改" }],
  ensureBotServiceState: async () => {},
  handleUrlVerification: () => null,
  isUrlVerification: () => false,
  listWecomCandidates: () => candidates,
  getWecomChannelByKfId: () => candidates[0] ?? null,
}));

let tmpDir: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-wecom-ver-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  const ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "wecom-ver-proj", ownerId }).id;
  process.env.INTAKE_PROJECT_ID = projectId;
  candidates.length = 0;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.INTAKE_PROJECT_ID;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function postInbound(): Promise<void> {
  const { POST } = await import("./route");
  const res = await POST(
    new NextRequest("http://localhost/api/intake/wecom", { method: "POST", body: "x" }),
  );
  expect(res.status).toBe(200);
}

function taskVersionId(): string | null {
  const row = getDb().prepare(`SELECT version_id FROM tasks`).get() as {
    version_id: string | null;
  };
  return row?.version_id ?? null;
}

describe("企微 intake 绑定版本 (v529)", () => {
  it("渠道行钉了 bound_version_id → 首 task 落该 version", async () => {
    const { createVersion } = await import("@/lib/db/versions");
    const version = createVersion({ project_id: projectId, name: "v-wecom" });
    candidates.push({
      channelId: "ch_x",
      boundProjectId: projectId,
      roleId: null,
      versionId: version.id,
      creds: { corpId: "", corpSecret: "", aesKey: "", callbackToken: "", kfId: "" },
    });

    await postInbound();
    expect(taskVersionId()).toBe(version.id);
  });

  it("bound_version_id NULL (env 兜底形态) → task.version_id 空, 行为不变", async () => {
    candidates.push({
      channelId: null,
      boundProjectId: projectId, // env 兜底走 INTAKE_PROJECT_ID, projectId 字段不参与
      roleId: null,
      versionId: null,
      creds: { corpId: "", corpSecret: "", aesKey: "", callbackToken: "", kfId: "" },
    });

    await postInbound();
    expect(taskVersionId()).toBeNull();
  });
});
