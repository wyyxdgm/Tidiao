// PATCH /api/schedules/[id] 静默丢弃 agent 执行参数的回归测试（2026-08-13 bug）。
//
// 事故: 想把定时任务的 max_turns 放开, 三条路径（cron.sh / curl / 传数字）全部
//   HTTP 200 + 完整 JSON, DB 里的值一点没变。根因两条叠加 ——
//     ① ScheduleUpdate 只声明 9 个字段, updateSchedule 也只写那 9 个,
//        max_turns/effort/model/priority/auto_approve/allowed_tools/tags/
//        project_id/version_id 一个都不处理;
//     ② fields.length === 0 时原样 return existing -> 200 + 旧对象, 调用方
//        无法区分「改成功」和「整个请求被忽略」。
// 所以下面每条断言都盯着这两点: 写进去要读得回来（含 null=置空）, 未知键必须
//   得到一个不像成功的响应。
//
// 真 SQLite + 真 schedules 表; 路由层用 NextRequest 直接调, 不起 server。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { PATCH } from "@/app/api/schedules/[id]/route";

let tmpDir: string;
let ownerId: string;
let projectId: string;
let scheduleId: string;

function makeSchedule() {
  return createSchedule({
    name: "搭档日常巡检",
    exec_type: "agent",
    title: "巡检",
    prompt: "检查项目状态并汇报",
    project_id: projectId,
    max_turns: 250,
    effort: "medium",
    model: "sonnet",
    tags: ["inspect"],
    schedule_type: "cron",
    schedule_expr: "0 9,14,20 * * *",
    // 🆕 v60 自适应频率预填两个字段, 让 samples 循环里单边 PATCH 通过合成校验。
    freq_min_minutes: 60,
    freq_max_minutes: 360,
    ownerId,
  }).id;
}

// 直接调路由 handler, 带上 middleware 会注入的身份头。
async function patch(body: unknown, role = "user") {
  const req = new NextRequest(`http://localhost/api/schedules/${scheduleId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-user-id": ownerId,
      "x-user-role": role,
    },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: scheduleId }) });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-update-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "sched-update-proj", ownerId }).id;
  scheduleId = makeSchedule();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("updateSchedule: agent 执行参数真的写库", () => {
  it("max_turns 改成数字 -> 读回是那个数字", () => {
    updateSchedule(scheduleId, { max_turns: 300 });
    expect(getScheduleById(scheduleId)!.max_turns).toBe(300);
  });

  // 本 bug 的关键语义: null 不是「没传」, 是「置空 = 不限轮次」。
  it("max_turns 显式传 null -> 库里是 NULL", () => {
    updateSchedule(scheduleId, { max_turns: null });
    expect(getScheduleById(scheduleId)!.max_turns).toBeNull();
    const raw = getDb()
      .prepare("SELECT max_turns FROM schedules WHERE id = ?")
      .get(scheduleId) as { max_turns: number | null };
    expect(raw.max_turns).toBeNull();
  });

  it("undefined / 键不存在 -> 不动原值", () => {
    updateSchedule(scheduleId, { max_turns: undefined, name: "改个名" });
    const s = getScheduleById(scheduleId)!;
    expect(s.max_turns).toBe(250);
    expect(s.name).toBe("改个名");
  });

  it("其余 agent 执行参数同样写得进去", () => {
    // 🔴 auto_approve 已从 ScheduleUpdate 移除（2026-08-31 GDM 事故：agent schedule
    //   必须开, 不接受外部关）。auto_approve 的强制语义见 schedule-auto-approve-forced.test.ts。
    updateSchedule(scheduleId, {
      effort: "max",
      model: "opus",
      priority: 7,
      allowed_tools: ["Read", "Grep"],
      tags: ["a", "b"],
      description: "说明",
    });
    const s = getScheduleById(scheduleId)!;
    expect(s.effort).toBe("max");
    expect(s.model).toBe("opus");
    expect(s.priority).toBe(7);
    // schedule 在 beforeEach 是 agent + 未传 auto_approve, createSchedule 强制 true。
    expect(s.auto_approve).toBe(true);
    expect(s.allowed_tools).toEqual(["Read", "Grep"]);
    expect(s.tags).toEqual(["a", "b"]);
    expect(s.description).toBe("说明");
  });

  it("effort/model/tags 也能置空", () => {
    updateSchedule(scheduleId, { effort: null, model: null, tags: null });
    const s = getScheduleById(scheduleId)!;
    expect(s.effort).toBeNull();
    expect(s.model).toBeNull();
    expect(s.tags).toBeNull();
  });

  it("低 max_turns 不抛错: console.warn + clamp 到 200 (平台规则)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      updateSchedule(scheduleId, { max_turns: 0 });
      expect(getScheduleById(scheduleId)!.max_turns).toBe(200);
      updateSchedule(scheduleId, { max_turns: -1 });
      expect(getScheduleById(scheduleId)!.max_turns).toBe(200);
      updateSchedule(scheduleId, { max_turns: 50 });
      expect(getScheduleById(scheduleId)!.max_turns).toBe(200);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((c) => /max_turns/.test(String(c[0])))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("非整数 max_turns 仍 throw (malformed, 不是「太低」)", () => {
    expect(() => updateSchedule(scheduleId, { max_turns: 1.5 })).toThrow(/max_turns/);
    expect(() => updateSchedule(scheduleId, { max_turns: "abc" as unknown as number })).toThrow(/max_turns/);
    expect(getScheduleById(scheduleId)!.max_turns).toBe(250);
  });

  it("force_max_turns:true 保留原值不 clamp (内部 flag, 不进路由白名单)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      updateSchedule(scheduleId, { max_turns: 50, force_max_turns: true });
      expect(getScheduleById(scheduleId)!.max_turns).toBe(50);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("白名单与 updateSchedule 实际处理的字段不脱节（新增字段忘记登记会红）", () => {
    // 逐个字段真写一遍: 白名单里的每个键都必须能改动库里的值或被明确接受。
    // 🔴 auto_approve 已从白名单/ScheduleUpdate 移除（2026-08-31）, 不在此处测试。
    const samples: Record<string, unknown> = {
      name: "n2", enabled: false, schedule_type: "cron", schedule_expr: "0 1 * * *",
      timezone: "UTC", skip_if_running: false, title: "t2", prompt: "p2",
      command: "echo hi", cwd: "/tmp", description: "d2", project_id: projectId,
      version_id: null, priority: 3, model: "m2",
      allowed_tools: ["Read"], max_turns: 300, effort: "low", tags: ["x"],
      // 🆕 v60 自适应频率。schedule 是 agent + cron 风格, 区间合法。
      freq_min_minutes: 60, freq_max_minutes: 360,
    };
    for (const k of UPDATABLE_SCHEDULE_FIELDS) {
      expect(Object.keys(samples)).toContain(k);
      const before = JSON.stringify(getScheduleById(scheduleId));
      updateSchedule(scheduleId, { [k]: samples[k] });
      const after = JSON.stringify(getScheduleById(scheduleId));
      // updated_at 一定变 -> 说明 UPDATE 真的发生了（而不是 fields 为空原样返回）
      expect(after, `字段 ${k} 没有触发任何写入`).not.toBe(before);
    }
  });
});

describe("PATCH 路由: 静默失败变可见", () => {
  it("正向: PATCH max_turns=300 -> 200 且响应体与 DB 都是 300", async () => {
    const { status, json } = await patch({ max_turns: 300 });
    expect(status).toBe(200);
    expect(json.max_turns).toBe(300);
    expect(getScheduleById(scheduleId)!.max_turns).toBe(300);
  });

  it("正向: PATCH max_turns=null -> 200 且 DB 是 NULL", async () => {
    const { status, json } = await patch({ max_turns: null });
    expect(status).toBe(200);
    expect(json.max_turns).toBeNull();
    expect(getScheduleById(scheduleId)!.max_turns).toBeNull();
  });

  // 反测: 这是本 bug 里最贵的部分 —— 后端不认识的键必须有声音。
  it("反向: 未知键 -> 400 + 列出键名, 绝不是长得像成功的 200", async () => {
    const { status, json } = await patch({ maxTurns: 300, nope: 1 });
    expect(status).toBe(400);
    expect(json.unknown_fields).toEqual(["maxTurns", "nope"]);
    expect(json.id).toBeUndefined(); // 不能返回一个完整 schedule 冒充成功
  });

  it("反向: 已知键 + 未知键混传 -> 整个请求拒掉, 已知键也不写（不半成功）", async () => {
    const { status } = await patch({ max_turns: 300, bogus: true });
    expect(status).toBe(400);
    expect(getScheduleById(scheduleId)!.max_turns).toBe(250);
  });

  it("反向: 空 body {} 是合法 no-op -> 200, 值不变, 不报错", async () => {
    const { status, json } = await patch({});
    expect(status).toBe(200);
    expect(json.max_turns).toBe(250);
    expect(json.name).toBe("搭档日常巡检");
  });

  it("反向: 脏值 -> 400 而不是 500", async () => {
    // 非整数仍 throw (malformed)
    expect((await patch({ max_turns: 1.5 })).status).toBe(400);
    expect((await patch({ effort: "insane" })).status).toBe(400);
    expect(getScheduleById(scheduleId)!.effort).toBe("medium");
  });

  it("API: max_turns:0 不再是 400, 改成 200 + clamp (平台规则)", async () => {
    const { status, json } = await patch({ max_turns: 0 });
    expect(status).toBe(200);
    expect(json.max_turns).toBe(200);
    expect(getScheduleById(scheduleId)!.max_turns).toBe(200);
  });

  it("API: force_max_turns 是内部 flag, 走白名单 -> 400 unknown_fields, max_turns 也不写", async () => {
    const { status, json } = await patch({ max_turns: 50, force_max_turns: true });
    expect(status).toBe(400);
    expect(json.unknown_fields).toContain("force_max_turns");
    // 整请求被拒, max_turns:50 也不写, schedule 保持原值 250
    expect(getScheduleById(scheduleId)!.max_turns).toBe(250);
  });
});
