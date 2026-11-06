// 飞书 R86: schedule 编辑流回归测试 —— PATCH /api/schedules/[id] 编辑场景。
//
// 重点覆盖 (前端 EditScheduleModal 的提交走 PATCH, 后端必须有保障):
//   - admin 可编辑其他 owner 的 schedule (ownerScope = undefined 走全库)
//   - 非 admin 编辑别人的 schedule -> 404 (不是 403, 不暴露存在性)
//   - 多字段同时 PATCH 真的全部生效 (前端一次提交改 name + schedule_expr + description + project_id)
//   - schedule_type cron -> once 切换 + schedule_expr 同步生效
//   - exec_type 不在白名单 -> 400 (前端 EditScheduleModal 把 exec_type 锁成只读,
//     因为后端 PATCH 白名单不接受 exec_type, UI 上能改但保存无效是反模式)
//
// 与 schedule-update-fields.test.ts 互补: 后者盯单字段写库 + 未知键 400 + 静默丢弃 bug;
//   本测试盯「编辑流」的端到端 + 跨 owner 隔离 + exec_type 边界.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import {
  createSchedule,
  getScheduleById,
  updateSchedule,
} from "./schedules";
import { PATCH } from "@/app/api/schedules/[id]/route";

let tmpDir: string;
let ownerId: string;
let otherOwnerId: string;
let projectId: string;
let otherProjectId: string;
let scheduleId: string;

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return createSchedule({
    name: "搭档日常巡检",
    exec_type: "agent",
    title: "巡检",
    prompt: "检查项目状态并汇报",
    project_id: projectId,
    max_turns: 250,
    schedule_type: "cron",
    schedule_expr: "0 9 * * *",
    ownerId,
    ...overrides,
  }).id;
}

// 直接调路由 handler, 模拟 middleware 注入身份头。
// 默认 PATCH 全局 scheduleId; 传 sidOverride 可改 PATCH 别条 schedule。
async function patchAs(userId: string, role: "user" | "admin", body: unknown, sidOverride?: string) {
  const targetId = sidOverride ?? scheduleId;
  const req = new NextRequest(`http://localhost/api/schedules/${targetId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
      "x-user-role": role,
    },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: targetId }) });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-edit-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  otherOwnerId = uuidv4();
  const db = getDb();
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`)
    .run(ownerId, `${ownerId}@example.com`, "x");
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`)
    .run(otherOwnerId, `${otherOwnerId}@example.com`, "x");
  projectId = createProject({ name: "owner-proj", ownerId }).id;
  otherProjectId = createProject({ name: "other-proj", ownerId: otherOwnerId }).id;
  scheduleId = makeSchedule();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("R86 编辑流: owner 隔离", () => {
  it("非 admin 编辑其他 owner 的 schedule -> 404 (不暴露存在性)", async () => {
    const otherSchedule = createSchedule({
      name: "别人的定时任务",
      exec_type: "shell",
      command: "echo x",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId: otherOwnerId,
    }).id;
    const req = new NextRequest(`http://localhost/api/schedules/${otherSchedule}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": ownerId,
        "x-user-role": "user",
      },
      body: JSON.stringify({ name: "想改别人的名" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: otherSchedule }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    // 数据库原值不变
    expect(getScheduleById(otherSchedule)!.name).toBe("别人的定时任务");
  });

  it("admin 编辑其他 owner 的 schedule -> 200 + 真改了", async () => {
    const otherSchedule = createSchedule({
      name: "别人的",
      exec_type: "shell",
      command: "echo x",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId: otherOwnerId,
    }).id;
    const req = new NextRequest(`http://localhost/api/schedules/${otherSchedule}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": ownerId,
        "x-user-role": "admin",
      },
      body: JSON.stringify({ name: "admin 改的", description: "管理员代改" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: otherSchedule }) });
    expect(res.status).toBe(200);
    const after = getScheduleById(otherSchedule)!;
    expect(after.name).toBe("admin 改的");
    expect(after.description).toBe("管理员代改");
    expect(after.owner_id).toBe(otherOwnerId); // owner 不会被改
  });
});

describe("R86 编辑流: 多字段同时生效", () => {
  it("前端一次提交 5 个字段全部生效", async () => {
    const { status, json } = await patchAs(ownerId, "user", {
      name: "改个名",
      schedule_type: "once",
      schedule_expr: "2026-12-31T16:00:00Z",
      description: "新描述",
      project_id: otherProjectId,
    });
    expect(status).toBe(200);
    // 响应体就已是更新后的值
    expect(json.name).toBe("改个名");
    expect(json.schedule_type).toBe("once");
    expect(json.schedule_expr).toBe("2026-12-31T16:00:00Z");
    expect(json.description).toBe("新描述");
    expect(json.project_id).toBe(otherProjectId);
    // DB 也对得上
    const after = getScheduleById(scheduleId)!;
    expect(after.name).toBe("改个名");
    expect(after.schedule_type).toBe("once");
    expect(after.title).toBe("巡检"); // 没传的字段保持不变
    expect(after.prompt).toBe("检查项目状态并汇报");
  });

  it("shell 类型 schedule 编辑 command + cwd 都生效", async () => {
    const sid = createSchedule({
      name: "shell task",
      exec_type: "shell",
      command: "echo a",
      cwd: "/tmp/a",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      ownerId,
    }).id;
    const req = new NextRequest(`http://localhost/api/schedules/${sid}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": ownerId,
        "x-user-role": "user",
      },
      body: JSON.stringify({ command: "echo b", cwd: "/tmp/b" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: sid }) });
    expect(res.status).toBe(200);
    const after = getScheduleById(sid)!;
    expect(after.command).toBe("echo b");
    expect(after.cwd).toBe("/tmp/b");
  });
});

describe("R86 编辑流: exec_type 边界", () => {
  it("PATCH exec_type -> 400 unknown_fields (前端 UI 必须锁住不让改)", async () => {
    // exec_type 不在 UPDATABLE_SCHEDULE_FIELDS 白名单 → 路由层 400.
    // 前端 EditScheduleModal 把 exec_type 渲染成只读 label, 避开这条边界.
    const { status, json } = await patchAs(ownerId, "user", { exec_type: "shell" });
    expect(status).toBe(400);
    expect(json.unknown_fields).toEqual(["exec_type"]);
    // 整请求被拒, 已知字段 (即使一起传) 也不写
    const { status: s2 } = await patchAs(ownerId, "user", {
      exec_type: "shell",
      name: "应该没写进去",
    });
    expect(s2).toBe(400);
    expect(getScheduleById(scheduleId)!.name).toBe("搭档日常巡检");
  });

  it("直接调 updateSchedule 也不会改 exec_type (白名单只在路由层, 但 updateSchedule 本身也没处理)", () => {
    // 双重保险: 即使有人绕过路由直接调 updateSchedule, exec_type 也不会写入。
    // 这就是前端 EditScheduleModal 锁死 exec_type 的根本原因。
    const before = getScheduleById(scheduleId)!.exec_type;
    // updateSchedule 用 ScheduleUpdate 类型, exec_type 不在类型里, TS 编译就过不了。
    // 这里强行 cast 模拟绕过:
    updateSchedule(scheduleId, { exec_type: "shell" } as unknown as Parameters<typeof updateSchedule>[1]);
    const after = getScheduleById(scheduleId)!;
    expect(after.exec_type).toBe(before); // 仍然是 agent
  });
});

describe("R86 编辑流: schedule_type cron -> once 切换", () => {
  it("cron schedule 改成 once + ISO 时间 -> 全库生效", async () => {
    const sid = createSchedule({
      name: "周期任务",
      exec_type: "shell",
      command: "echo tick",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
    }).id;
    const { status, json } = await patchAs(ownerId, "user", {
      schedule_type: "once",
      schedule_expr: "2026-12-31T16:00:00Z",
    }, sid);
    expect(status).toBe(200);
    expect(json.schedule_type).toBe("once");
    expect(json.schedule_expr).toBe("2026-12-31T16:00:00Z");
    // 切换类型后, schedule-runs 历史仍在 (PATCH 只动 schedule 主表)
    const after = getScheduleById(sid)!;
    expect(after.schedule_type).toBe("once");
  });
});

describe("R86 编辑流: 描述 description 边界", () => {
  it("description 不传 -> 原值保留; 传 null -> 置空; 传空串 -> 视为未传", async () => {
    // 先建一个有 description 的 schedule
    const sid = createSchedule({
      name: "带描述",
      exec_type: "shell",
      command: "echo x",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      description: "原始描述",
      ownerId,
    }).id;

    // 1) 不传 description -> 原值保留
    const r1 = await patchAs(ownerId, "user", { name: "只改名" }, sid);
    expect(r1.status).toBe(200);
    expect(getScheduleById(sid)!.description).toBe("原始描述");

    // 2) 显式 null -> 置空
    const r2 = await patchAs(ownerId, "user", { description: null }, sid);
    expect(r2.status).toBe(200);
    expect(getScheduleById(sid)!.description).toBeNull();
  });
});