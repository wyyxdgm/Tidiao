// v60 schedule 自适应频率的 DB + API 校验回归测试。
//
// 覆盖范围:
//   - migration v60: schedules 加 freq_min/minutes / freq_max_minutes 列
//   - createSchedule 校验: agent + cron 允许 / shell 拒 / once 拒 / 单边填拒 /
//     区间非法拒
//   - updateSchedule 校验: 单边清空走「合成校验」(existing + updates) 不允许半态
//   - PATCH 白名单: freq_min_minutes / freq_max_minutes 进入 UPDATABLE_SCHEDULE_FIELDS
//   - GET /api/schedules/[id]: 返回字段含 freq_min/max

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import {
  createSchedule,
  updateSchedule,
  getScheduleById,
  UPDATABLE_SCHEDULE_FIELDS,
} from "@/lib/db/schedules";
import type { ScheduleDefinition } from "@/lib/db/schedules";
import { PATCH } from "@/app/api/schedules/[id]/route";

let tmpDir: string;
let ownerId: string;
let projectId: string;

function newAgentSchedule(extra: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    name: "adaptive-test",
    exec_type: "agent",
    title: "自适应测试",
    prompt: "跑测试",
    project_id: projectId,
    schedule_type: "cron",
    schedule_expr: "0 9 * * *",
    ownerId,
    ...extra,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-adapt-freq-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "adaptive-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migration v60: schedules.freq_min/max 列存在", () => {
  it("schedules 表有 freq_min_minutes / freq_max_minutes 两列", () => {
    const cols = getDb()
      .prepare("PRAGMA table_info(schedules)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("freq_min_minutes");
    expect(names).toContain("freq_max_minutes");
  });

  it("createSchedule 不传 freq → 两列都是 NULL", () => {
    const s = createSchedule(newAgentSchedule());
    expect(s.freq_min_minutes).toBeNull();
    expect(s.freq_max_minutes).toBeNull();
  });
});

describe("createSchedule 校验: agent + cron 允许, 区间合法性", () => {
  it("传 freq_min=10, freq_max=60 -> 落库成功", () => {
    const s = createSchedule(
      newAgentSchedule({ freq_min_minutes: 10, freq_max_minutes: 60 })
    );
    expect(s.freq_min_minutes).toBe(10);
    expect(s.freq_max_minutes).toBe(60);
  });

  it("只传 freq_min 不传 freq_max -> throw", () => {
    expect(() =>
      createSchedule(newAgentSchedule({ freq_min_minutes: 10 }))
    ).toThrow(/必须同时设置或同时为空/);
  });

  it("只传 freq_max 不传 freq_min -> throw", () => {
    expect(() =>
      createSchedule(newAgentSchedule({ freq_max_minutes: 60 }))
    ).toThrow(/必须同时设置或同时为空/);
  });

  it("freq_min > freq_max -> throw", () => {
    expect(() =>
      createSchedule(
        newAgentSchedule({ freq_min_minutes: 100, freq_max_minutes: 50 })
      )
    ).toThrow(/不能大于/);
  });

  it("freq_min <= 0 -> throw", () => {
    expect(() =>
      createSchedule(
        newAgentSchedule({ freq_min_minutes: 0, freq_max_minutes: 60 })
      )
    ).toThrow(/integer >= 1/);
  });

  it("freq_max 是小数 -> throw", () => {
    expect(() =>
      createSchedule(
        newAgentSchedule({ freq_min_minutes: 10.5, freq_max_minutes: 60 })
      )
    ).toThrow(/integer >= 1/);
  });
});

describe("createSchedule 校验: shell/once 拒 freq_min/max", () => {
  it("shell + freq_min/max -> throw", () => {
    expect(() =>
      createSchedule({
        name: "shell-freq",
        exec_type: "shell",
        command: "echo hi",
        schedule_type: "cron",
        schedule_expr: "*/5 * * * *",
        ownerId,
        freq_min_minutes: 10,
        freq_max_minutes: 60,
      })
    ).toThrow(/agent \+ cron/);
  });

  it("agent + once + freq_min/max -> throw", () => {
    expect(() =>
      createSchedule({
        name: "agent-once-freq",
        exec_type: "agent",
        title: "x",
        prompt: "x",
        project_id: projectId,
        schedule_type: "once",
        schedule_expr: new Date(Date.now() + 3600_000).toISOString(),
        ownerId,
        freq_min_minutes: 10,
        freq_max_minutes: 60,
      })
    ).toThrow(/agent \+ cron/);
  });
});

describe("updateSchedule: 单边清空走合成校验, 防半态落库", () => {
  it("库里 min=10/max=60, PATCH 把 max 改成 null -> throw", () => {
    const s = createSchedule(
      newAgentSchedule({ freq_min_minutes: 10, freq_max_minutes: 60 })
    );
    expect(() =>
      updateSchedule(s.id, { freq_max_minutes: null })
    ).toThrow(/必须同时设置或同时为空/);
  });

  it("库里 min=null/max=null, PATCH 只设 min -> throw", () => {
    const s = createSchedule(newAgentSchedule());
    expect(() =>
      updateSchedule(s.id, { freq_min_minutes: 10 })
    ).toThrow(/必须同时设置或同时为空/);
  });

  it("同时设 min+max, 区间合法 -> 落库", () => {
    const s = createSchedule(newAgentSchedule());
    const updated = updateSchedule(s.id, {
      freq_min_minutes: 30,
      freq_max_minutes: 120,
    });
    expect(updated!.freq_min_minutes).toBe(30);
    expect(updated!.freq_max_minutes).toBe(120);
  });

  it("同时清空 (PATCH min=null max=null) -> 关闭自适应", () => {
    const s = createSchedule(
      newAgentSchedule({ freq_min_minutes: 10, freq_max_minutes: 60 })
    );
    const updated = updateSchedule(s.id, {
      freq_min_minutes: null,
      freq_max_minutes: null,
    });
    expect(updated!.freq_min_minutes).toBeNull();
    expect(updated!.freq_max_minutes).toBeNull();
  });

  it("shell schedule 不能 PATCH 设 freq_min/max", () => {
    const shell = createSchedule({
      name: "shell-no-freq",
      exec_type: "shell",
      command: "echo hi",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      ownerId,
    });
    expect(() =>
      updateSchedule(shell.id, {
        freq_min_minutes: 10,
        freq_max_minutes: 60,
      })
    ).toThrow(/agent \+ cron/);
  });
});

describe("PATCH 路由白名单: freq_min/minutes / freq_max_minutes 在列", () => {
  it("UPDATABLE_SCHEDULE_FIELDS 含两字段", () => {
    expect(UPDATABLE_SCHEDULE_FIELDS).toContain("freq_min_minutes");
    expect(UPDATABLE_SCHEDULE_FIELDS).toContain("freq_max_minutes");
  });

  it("PATCH {freq_min_minutes, freq_max_minutes} 走通 -> 落库", async () => {
    const s = createSchedule(newAgentSchedule());
    const req = new NextRequest(`http://localhost/api/schedules/${s.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": ownerId,
        "x-user-role": "user",
      },
      body: JSON.stringify({ freq_min_minutes: 10, freq_max_minutes: 60 }),
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ id: s.id }),
    });
    expect(res.status).toBe(200);
    const after = getScheduleById(s.id)!;
    expect(after.freq_min_minutes).toBe(10);
    expect(after.freq_max_minutes).toBe(60);
  });

  it("PATCH min=100/max=50 -> 400 (区间非法, 由 service throw)", async () => {
    const s = createSchedule(newAgentSchedule());
    const req = new NextRequest(`http://localhost/api/schedules/${s.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": ownerId,
        "x-user-role": "user",
      },
      body: JSON.stringify({ freq_min_minutes: 100, freq_max_minutes: 50 }),
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ id: s.id }),
    });
    expect(res.status).toBe(400);
  });
});