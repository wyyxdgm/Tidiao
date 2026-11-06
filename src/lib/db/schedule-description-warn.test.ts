// 飞书 R95: cron description 缺失软告警的回归测试。
//
//   damo 0825 拍板"新加 cron 没填 description 要警告"。4 个创建入口
//   (API POST/PATCH + cron.sh + UI 新建/编辑) 全部走 service 层,
//   createSchedule / updateSchedule 各自软 warn 一次覆盖全部口子。
//
//   本测试盯 4 条语义契约:
//     1. createSchedule 不传 description → warn 命中, message 含 [schedules.create]
//     2. createSchedule 传正常 description → warn **不**命中 (不误伤)
//     3. createSchedule 传空串 / 纯空白 → warn 命中 (trim 后视为空)
//     4. updateSchedule 显式 description: null → warn 命中
//     5. updateSchedule **不**传 description 键 → warn **不**命中 (PATCH 只改 name 顺手吃警告 = 噪声)
//
//   与 schedule-update-fields.test.ts:145-159 (max_turns < 200 warn) 用同一套
//   vi.spyOn(console, "warn") 模板, 风格保持一致。
//
//   真 SQLite + 真 schedules 表; 直接调 createSchedule / updateSchedule,
//   不起 server。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import {
  createSchedule,
  updateSchedule,
  getScheduleById,
} from "./schedules";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-desc-warn-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(ownerId, `${ownerId}@example.com`, "x");
  projectId = createProject({ name: "r95-desc-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 收集 createSchedule / updateSchedule 期间 console.warn 的 message。
// vi.spyOn(console, "warn") 在并行 describe 之间会互相串, 用 filterByName 隔离。
function spyWarns(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const orig = console.warn;
  const spy = vi.fn((...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  });
  console.warn = spy as typeof console.warn;
  return {
    calls,
    restore: () => {
      console.warn = orig;
      spy.mockRestore();
    },
  };
}

describe("R95 createSchedule description 软告警", () => {
  it("不传 description -> warn 命中, message 含 [schedules.create]", () => {
    const { calls, restore } = spyWarns();
    try {
      createSchedule({
        name: "no-desc-shell",
        exec_type: "shell",
        command: "echo tick",
        schedule_type: "cron",
        schedule_expr: "0 9 * * *",
        ownerId,
      });
      expect(calls.some((m) => /\[schedules\.create\]/.test(m) && /没填 description/.test(m))).toBe(true);
    } finally {
      restore();
    }
  });

  it("传正常 description -> warn 不命中 (不误伤)", () => {
    const { calls, restore } = spyWarns();
    try {
      createSchedule({
        name: "with-desc",
        exec_type: "shell",
        command: "echo tick",
        description: "每日 9 点巡检",
        schedule_type: "cron",
        schedule_expr: "0 9 * * *",
        ownerId,
      });
      expect(calls.some((m) => /\[schedules\.create\]/.test(m) && /没填 description/.test(m))).toBe(false);
    } finally {
      restore();
    }
  });

  it("传空串 / 纯空白 -> warn 命中 (trim 后视为空)", () => {
    const { calls, restore } = spyWarns();
    try {
      // case 1: 空串
      createSchedule({
        name: "empty-string",
        exec_type: "shell",
        command: "echo tick",
        description: "",
        schedule_type: "cron",
        schedule_expr: "0 9 * * *",
        ownerId,
      });
      // case 2: 纯空白
      createSchedule({
        name: "whitespace-only",
        exec_type: "shell",
        command: "echo tick",
        description: "   \t\n  ",
        schedule_type: "cron",
        schedule_expr: "0 9 * * *",
        ownerId,
      });
      const descWarnCount = calls.filter(
        (m) => /\[schedules\.create\]/.test(m) && /没填 description/.test(m)
      ).length;
      expect(descWarnCount).toBe(2);
    } finally {
      restore();
    }
  });

  it("null / undefined 都视为空 -> warn 命中", () => {
    const { calls, restore } = spyWarns();
    try {
      // 显式 null
      createSchedule({
        name: "explicit-null",
        exec_type: "shell",
        command: "echo tick",
        description: null as unknown as string,
        schedule_type: "cron",
        schedule_expr: "0 9 * * *",
        ownerId,
      });
      // undefined (类型上等于不传, 但走的是 ?? null 路径)
      createSchedule({
        name: "undefined-desc",
        exec_type: "shell",
        command: "echo tick",
        schedule_type: "cron",
        schedule_expr: "0 9 * * *",
        ownerId,
      });
      const descWarnCount = calls.filter(
        (m) => /\[schedules\.create\]/.test(m) && /没填 description/.test(m)
      ).length;
      expect(descWarnCount).toBe(2);
    } finally {
      restore();
    }
  });
});

describe("R95 updateSchedule description 显式清空软告警", () => {
  // 准备一个带 description 的 schedule, 后续 PATCH 都改它。
  let sid: string;
  beforeEach(() => {
    const s = createSchedule({
      name: "r95-with-desc",
      exec_type: "shell",
      command: "echo tick",
      description: "原始描述",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
    });
    sid = s.id;
  });

  it("显式 description: null -> warn 命中, message 含 [schedules.update]", () => {
    const { calls, restore } = spyWarns();
    try {
      updateSchedule(sid, { description: null });
      expect(calls.some((m) => /\[schedules\.update\]/.test(m) && /把 description 清空/.test(m))).toBe(true);
      // 写库也确认: 不传 = 原值, null = 置空
      expect(getScheduleById(sid)!.description).toBeNull();
    } finally {
      restore();
    }
  });

  it("显式 description: '' -> warn 命中", () => {
    const { calls, restore } = spyWarns();
    try {
      updateSchedule(sid, { description: "" });
      expect(calls.some((m) => /\[schedules\.update\]/.test(m) && /把 description 清空/.test(m))).toBe(true);
    } finally {
      restore();
    }
  });

  it("不传 description 键 (只改 name) -> warn **不**命中 (PATCH 顺手吃警告 = 噪声)", () => {
    const { calls, restore } = spyWarns();
    try {
      updateSchedule(sid, { name: "改名不碰 description" });
      const descWarns = calls.filter(
        (m) => /\[schedules\.update\]/.test(m) && /把 description 清空/.test(m)
      );
      expect(descWarns).toEqual([]);
      // 原值保留
      expect(getScheduleById(sid)!.description).toBe("原始描述");
    } finally {
      restore();
    }
  });

  it("正常改 description -> warn **不**命中", () => {
    const { calls, restore } = spyWarns();
    try {
      updateSchedule(sid, { description: "新描述" });
      const descWarns = calls.filter(
        (m) => /\[schedules\.update\]/.test(m) && /把 description 清空/.test(m)
      );
      expect(descWarns).toEqual([]);
      expect(getScheduleById(sid)!.description).toBe("新描述");
    } finally {
      restore();
    }
  });
});
