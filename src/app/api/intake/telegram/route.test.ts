// POST /api/intake/telegram 渠道默认角色挂载回归 (v526, docs/plans/role-scoped-roles.md D3).
//
// 覆盖:
//   - bind 时 channel 配了 role_id → 建 task 带 role (task.role_id = channel.role_id)
//   - bind 时 channel 未配 role (NULL) → task 不带 role, 行为不变 (回归)
//   - 后续消息进已有 thread 走 resume, role 不变 (thread 复用语义)
//
// 关注点:
//   - runtime 用真 DB createTask + startTask 桩化 (同 auto-dispatch route.test.ts 模式).
//   - adapter 用真 telegramAdapter (verifyRequest 不配 webhook_secret 直接过;
//     parseInbound 解析标准 update payload), 只 stub global fetch 拦 sendMessage 出站.
//   - webhook 路由在 middleware public 白名单, 不走 session, 直接 POST 即可.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createChannelConfig } from "@/lib/db/channel-configs";
import { createRole } from "@/lib/db/roles";
import { createVersion } from "@/lib/db/versions";
import { getTaskById } from "@/lib/db/tasks";
import { POST } from "./route";

// runtime 桩化: createTask 走真 DB 层, startTask 不起 SDK (同 auto-dispatch 模式).
// sendUserMessage 用模块级 spy (factory 闭包引用, 断言 resume 路径被调).
const sendUserMessageSpy = vi.fn();
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: (def: any) => realTasks.createTask(def),
    startTask: () => {},
    sendUserMessage: (...args: unknown[]) => sendUserMessageSpy(...args),
  }),
}));
import * as realTasks from "@/lib/db/tasks";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-tg-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "intake-tg-proj", ownerId }).id;

  // 拦 sendMessage 的出站 fetch (api.telegram.org 国内被墙, 测试也不该真发)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => "" })),
  );
  sendUserMessageSpy.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

function tgRequest(configId: string, text: string, fromId = 456): NextRequest {
  const url = new URL(`http://localhost/api/intake/telegram?c=${configId}`);
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify({
      message: {
        chat: { id: fromId, type: "private" },
        from: { id: fromId, first_name: "Tester" },
        text,
      },
    }),
  });
}

async function bind(configId: string, bindCode: string): Promise<void> {
  const res = await POST(tgRequest(configId, `bind ${bindCode}`));
  expect((res as any).status).toBe(200);
}

describe("intake telegram 渠道默认角色 (v526 D3)", () => {
  it("channel 配了 role → bind 建 task 带 role_id", async () => {
    const role = createRole({ name: "pre-sales", system_prompt: "你是售前", ownerId });
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
      role_id: role.id,
    });

    await bind(cfg.id, cfg.bind_code);

    const thread = getDb()
      .prepare("SELECT task_id FROM intake_threads WHERE channel = 'telegram'")
      .get() as { task_id: string };
    const task = getTaskById(thread.task_id)!;
    expect(task).toBeTruthy();
    expect(task.role_id).toBe(role.id);
  });

  it("channel 未配 role (NULL) → task 不带 role, 行为不变", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    await bind(cfg.id, cfg.bind_code);

    const thread = getDb()
      .prepare("SELECT task_id FROM intake_threads WHERE channel = 'telegram'")
      .get() as { task_id: string };
    const task = getTaskById(thread.task_id)!;
    expect(task).toBeTruthy();
    expect(task.role_id).toBeNull();
  });

  it("后续消息进已有 thread 走 resume, 不改 task role", async () => {
    const role = createRole({ name: "pre-sales", system_prompt: "你是售前", ownerId });
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
      role_id: role.id,
    });

    await bind(cfg.id, cfg.bind_code);

    const res = await POST(tgRequest(cfg.id, "帮我看看这个需求"));
    expect((res as any).status).toBe(200);
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    // resume 路径没有新建 task
    const taskCount = (
      getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }
    ).n;
    expect(taskCount).toBe(1);
  });
});

describe("intake telegram 绑定版本 (v529)", () => {
  it("channel 钉了 bound_version_id → bind 建 task 落该 version", async () => {
    const version = createVersion({ project_id: projectId, name: "v-tg" });
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
      bound_version_id: version.id,
    });

    await bind(cfg.id, cfg.bind_code);

    const thread = getDb()
      .prepare("SELECT task_id FROM intake_threads WHERE channel = 'telegram'")
      .get() as { task_id: string };
    const task = getTaskById(thread.task_id)!;
    expect(task.version_id).toBe(version.id);
  });

  it("channel 未钉版本 (NULL) → task.version_id 空, 跟随项目 current (行为不变)", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    await bind(cfg.id, cfg.bind_code);

    const thread = getDb()
      .prepare("SELECT task_id FROM intake_threads WHERE channel = 'telegram'")
      .get() as { task_id: string };
    const task = getTaskById(thread.task_id)!;
    expect(task.version_id).toBeNull();
  });
});

// 扫码绑定 QR 深链落地动作 (docs/plans/channel-qr-bind.md D1):
// QR 内容 = https://t.me/<bot>?start=<码>, Telegram 把 ?start= 参数转成 "/start <码>" 首条消息.
describe("intake telegram /start 绑定别名 (扫码绑定 D1)", () => {
  it("/start <码> 绑定成功 (QR 深链落地动作)", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      secret: "123:ABC",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await POST(tgRequest(cfg.id, `/start ${cfg.bind_code}`));
    expect((res as any).status).toBe(200);
    expect(((await res.json()) as any).bound).toBe(true);

    const thread = getDb()
      .prepare("SELECT task_id FROM intake_threads WHERE channel = 'telegram'")
      .get() as { task_id: string };
    expect(getTaskById(thread.task_id)).toBeTruthy();
  });

  it("旧 bind <码> 回归: 与 /start 并存不互斥", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      secret: "123:ABC",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await POST(tgRequest(cfg.id, `bind ${cfg.bind_code}`));
    expect((res as any).status).toBe(200);
    expect(((await res.json()) as any).bound).toBe(true);

    const n = (
      getDb().prepare("SELECT COUNT(*) AS n FROM intake_threads WHERE channel = 'telegram'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });
});
