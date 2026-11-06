// 2026-08-31 GDM 事故回归: cron agent schedule 强制 auto_approve=true。
//
// 事故: GDM 项目的 gdm-monetization-research schedule 昨晚 23:25 触发, agent 跑完
//   数据采集 + 决策分析, 最后一步 Write 卡 35+ 分钟没人批, SDK 子进程 (PID 568919)
//   一直挂着。原因: cron agent task 当时 auto_approve=false, Write 触发 canUseTool
//   等审批, 半夜没人在 UI 上点。
//
// damo 拍板: 「auto_approve 这个旋钮本身就不该存在 —— 直接内置为开」
//
// 三道防线覆盖:
//   ① createSchedule / POST 路由 —— agent 类型强制 auto_approve=1, 外部传入无效
//   ② PATCH 路由 —— auto_approve 已从 UPDATABLE_SCHEDULE_FIELDS 移除, PATCH body
//      带 auto_approve 返 400 unknown_fields
//   ③ fireAgent —— 即便 DB 行 schedule.auto_approve=0 (历史数据 / SQL 直改),
//      创建 task 时也硬传 auto_approve=true
//
// shell schedule 不受影响 (shell 本就要人审)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";

// spawn 必须假掉: shell 触发会真去跑命令
// 🆕 damo 0906: fireShell 从 exec 改成 spawn detached; mock 跟着换。
const spawnMock = vi.fn();
class FakeStream {
  on() { return this; }
}
class FakeChild {
  pid = 99999;
  stdout = new FakeStream();
  stderr = new FakeStream();
  on() { return this; }
}
vi.mock("child_process", () => ({
  spawn: (_cmd: string, _opts: unknown) => {
    spawnMock(_cmd, _opts);
    return new FakeChild();
  },
}));
// SDK 也得假掉: agent schedule 的 startTask 会调 SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { POST as createRoute } from "@/app/api/schedules/route";
import { PATCH as patchRoute } from "@/app/api/schedules/[id]/route";
import { _tickForTest } from "@/lib/runtime/schedule-runner";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import {
  createSchedule,
  getScheduleById,
  UPDATABLE_SCHEDULE_FIELDS,
} from "@/lib/db/schedules";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-autoap-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "autoap-proj", ownerId }).id;
  spawnMock.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAgentSchedule() {
  return createSchedule({
    name: "agent-test",
    exec_type: "agent",
    title: "test",
    prompt: "noop",
    project_id: projectId,
    schedule_type: "cron",
    schedule_expr: "* * * * *",
    ownerId,
  });
}

async function post(body: unknown) {
  const req = new NextRequest("http://localhost/api/schedules", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": ownerId,
      "x-user-role": "user",
    },
    body: JSON.stringify(body),
  });
  const res = await createRoute(req);
  return { status: res.status, json: await res.json() };
}

async function patch(id: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/schedules/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-user-id": ownerId,
      "x-user-role": "user",
    },
    body: JSON.stringify(body),
  });
  const res = await patchRoute(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}

describe("createSchedule / POST /api/schedules: agent 强制 auto_approve=true", () => {
  it("createSchedule agent 不传 auto_approve → DB 是 1", () => {
    const s = makeAgentSchedule();
    expect(s.auto_approve).toBe(true);
    const raw = getDb()
      .prepare("SELECT auto_approve FROM schedules WHERE id = ?")
      .get(s.id) as { auto_approve: number };
    expect(raw.auto_approve).toBe(1);
  });

  it("POST /api/schedules body.auto_approve=false → 入库仍是 1（被忽略）", async () => {
    const { status, json } = await post({
      name: "gdm-monetization",
      exec_type: "agent",
      title: "monetization",
      prompt: "do research",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 23 * * *",
      auto_approve: false, // 想关掉 → 后端忽略
    });
    expect(status).toBe(201);
    expect(json.auto_approve).toBe(true);
    const raw = getDb()
      .prepare("SELECT auto_approve FROM schedules WHERE id = ?")
      .get(json.id) as { auto_approve: number };
    expect(raw.auto_approve).toBe(1);
  });

  it("POST /api/schedules body.auto_approve=true → 入库 1（不影响）", async () => {
    const { status, json } = await post({
      name: "gdm-monetization",
      exec_type: "agent",
      title: "monetization",
      prompt: "do research",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 23 * * *",
      auto_approve: true,
    });
    expect(status).toBe(201);
    expect(json.auto_approve).toBe(true);
  });

  it("shell schedule 默认 auto_approve=0（不受新规则影响, shell 本就要人审）", () => {
    const s = createSchedule({
      name: "shell-test",
      exec_type: "shell",
      command: "echo tick",
      schedule_type: "cron",
      schedule_expr: "*/10 * * * *",
    });
    expect(s.auto_approve).toBe(false);
  });

  it("shell schedule auto_approve=true 入库也是 1（shell 不强制, 接受外部）", async () => {
    const { status, json } = await post({
      name: "shell-test",
      exec_type: "shell",
      command: "echo tick",
      schedule_type: "cron",
      schedule_expr: "*/10 * * * *",
      auto_approve: true,
    });
    expect(status).toBe(201);
    expect(json.auto_approve).toBe(true);
  });
});

describe("PATCH /api/schedules/[id]: auto_approve 不再是允许字段", () => {
  it("UPDATABLE_SCHEDULE_FIELDS 已不含 auto_approve", () => {
    expect(UPDATABLE_SCHEDULE_FIELDS as readonly string[]).not.toContain("auto_approve");
  });

  it("PATCH body.auto_approve=false → 400 unknown_fields, 调度不动", async () => {
    const s = makeAgentSchedule();
    const { status, json } = await patch(s.id, { auto_approve: false });
    expect(status).toBe(400);
    expect(json.unknown_fields).toEqual(["auto_approve"]);
    // 原值不变
    expect(getScheduleById(s.id)!.auto_approve).toBe(true);
  });

  it("PATCH body.auto_approve=true → 400 unknown_fields, 即便试图「保持开着」也不行", async () => {
    const s = makeAgentSchedule();
    const { status, json } = await patch(s.id, { auto_approve: true });
    expect(status).toBe(400);
    expect(json.unknown_fields).toEqual(["auto_approve"]);
  });

  it("PATCH 混合合法字段 + auto_approve → 整请求拒, 合法字段也不写", async () => {
    const s = makeAgentSchedule();
    const before = getScheduleById(s.id)!;
    const { status } = await patch(s.id, { name: "新名", auto_approve: false });
    expect(status).toBe(400);
    const after = getScheduleById(s.id)!;
    expect(after.name).toBe(before.name); // 名字也没改成
    expect(after.auto_approve).toBe(true);
  });
});

describe("schedule-runner fireAgent: 第三道防线 — 写死 auto_approve=true", () => {
  it("DB 行 schedule.auto_approve=0 (历史 / SQL 直改) → fireAgent 创建的 task 仍是 auto_approve=1", async () => {
    // 模拟事故形态: 老 schedule 行里 auto_approve=0, 但 runner 必须强制 1
    const s = createSchedule({
      name: "gdm-legacy",
      exec_type: "agent",
      title: "monetization",
      prompt: "do research",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "* * * * *",
    });
    // SQL 直改 (模拟绕过路由的脏数据)
    getDb()
      .prepare("UPDATE schedules SET auto_approve = 0 WHERE id = ?")
      .run(s.id);
    expect(getScheduleById(s.id)!.auto_approve).toBe(false);
    // 推进 next_run 到过去, 让 listDueSchedules 选中
    const past = new Date(Date.now() - 60_000).toISOString();
    getDb()
      .prepare("UPDATE schedules SET next_run = ? WHERE id = ?")
      .run(past, s.id);

    await _tickForTest();

    // 新建的 task 必须 auto_approve=1, 不论 schedule 行里是什么
    const fired = getDb()
      .prepare("SELECT id, auto_approve FROM tasks WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(s.id) as { id: string; auto_approve: number } | undefined;
    expect(fired, "agent schedule 应该 fire 出 task").toBeDefined();
    expect(fired!.auto_approve).toBe(1);
  });
});
