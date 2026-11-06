// v60 schedule-adaptive-watcher 回归测试。
//
// 覆盖:
//   - buildAdaptivePromptHeader: 未启用返 null; 启用返含区间文案
//   - recordAdaptiveSnapshot: 多次写入累加; 触发 trigger=fire / check
//   - checkAdaptiveFrequency 三场景:
//     (1) agent 调到区间内 -> 无警告
//     (2) agent 调到区间外 -> A 警告
//     (3) agent 没调 -> B 警告
//   - 通知: 通过 mock sendFeishuWebhook / sendNotifyToUser 验证参数
//     (sendFeishuWebhook 在 watcher 内部不导出, 用 vi.mock 走测试桩)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import {
  createSchedule,
  updateSchedule,
  getScheduleById,
} from "@/lib/db/schedules";
import { createTask, updateTaskStatus } from "@/lib/db/tasks";
import { getUserById } from "@/lib/db/users";
import {
  ADAPTIVE_HEADER_MARKER,
  ADAPTIVE_SNAPSHOT_KEY,
  buildAdaptivePromptHeader,
  recordAdaptiveSnapshot,
  checkAdaptiveFrequency,
} from "@/lib/runtime/schedule-adaptive-watcher";

// Mock 飞书 + 邮件出口, 不发真通知。
vi.mock("@/lib/notify/feishu", () => ({
  sendFeishuWebhook: vi.fn().mockResolvedValue({ sent: true, status: 200 }),
}));
vi.mock("@/lib/notify/mailer", () => ({
  sendNotifyToUser: vi.fn().mockResolvedValue({ sent: false, reason: "no recipient configured" }),
}));

import { sendFeishuWebhook } from "@/lib/notify/feishu";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-adapt-watch-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerId = uuidv4();
  // 注: 配 feishu_webhook_url 让 sendFeishuWebhook 走通.
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, feishu_webhook_url)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user", "https://open.feishu.cn/open-apis/bot/v2/hook/test-token");
  projectId = createProject({ name: "watch-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildAdaptivePromptHeader", () => {
  it("未启用 (freq 都 null) -> 返 null", () => {
    const s = createSchedule({
      name: "no-adapt",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
    });
    expect(buildAdaptivePromptHeader(s)).toBeNull();
  });

  it("启用 -> 返含 [min, max] 的硬指令 + marker", () => {
    const s = createSchedule({
      name: "adapt",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
      freq_min_minutes: 60,
      freq_max_minutes: 360,
    });
    const header = buildAdaptivePromptHeader(s);
    expect(header).not.toBeNull();
    expect(header).toContain(ADAPTIVE_HEADER_MARKER);
    expect(header).toContain("[60, 360]");
    expect(header).toContain("下次 cron");
    expect(header).toContain("cron.sh update");
  });
});

describe("recordAdaptiveSnapshot", () => {
  it("fire 一次 + check 一次 -> metadata.adaptive_snapshots 长度 2", () => {
    const scheduleId = uuidv4();
    const task = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
      // owner_id set via runtime (not in TaskDefinition)
      schedule_id: scheduleId,
    });
    recordAdaptiveSnapshot(task.id, scheduleId, "0 9 * * *", "fire");
    recordAdaptiveSnapshot(task.id, scheduleId, "0 10 * * *", "check");
    const row = getDb()
      .prepare("SELECT metadata FROM tasks WHERE id = ?")
      .get(task.id) as { metadata: string | null };
    expect(row.metadata).not.toBeNull();
    const meta = JSON.parse(row.metadata!);
    const snaps = meta[ADAPTIVE_SNAPSHOT_KEY];
    expect(snaps).toHaveLength(2);
    expect(snaps[0].trigger).toBe("fire");
    expect(snaps[1].trigger).toBe("check");
    expect(snaps[0].expr_before).toBe("0 9 * * *");
  });
});

describe("checkAdaptiveFrequency: 三场景", () => {
  it("场景 1: agent 调到区间内 -> 不警告", async () => {
    const schedule = createSchedule({
      name: "in-range",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      // 12 小时一次 = 720 分钟, 落在 [60, 1440] 区间内
      schedule_expr: "0 */12 * * *",
      ownerId,
      freq_min_minutes: 60,
      freq_max_minutes: 1440,
    });
    const task = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
      // owner_id set via runtime (not in TaskDefinition)
      schedule_id: schedule.id,
    });
    // 模拟 fire 时 expr —— 是创建 task 那一刻的 schedule.schedule_expr.
    recordAdaptiveSnapshot(task.id, schedule.id, schedule.schedule_expr, "fire");
    // agent 把 expr 调成「仍是 12h 一次」的形式（语义同效），落区间内。
    updateSchedule(schedule.id, { schedule_expr: "0 0,12 * * *" });

    // 调整 last_run / next_run 让 A 校验算出来 720 分钟（区间内）。
    getDb()
      .prepare(
        "UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?"
      )
      .run(
        new Date(Date.now() - 12 * 60 * 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
        schedule.id
      );

    const { warnings } = await checkAdaptiveFrequency(task.id, schedule.id);
    expect(warnings).toHaveLength(0);
    expect(sendFeishuWebhook).not.toHaveBeenCalled();
  });

  it("场景 2: agent 调了 expr 但落到区间外 -> A 警告", async () => {
    const schedule = createSchedule({
      name: "out-of-range",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *", // fire 时 24h
      ownerId,
      freq_min_minutes: 60,
      freq_max_minutes: 120, // 区间 1-2 小时
    });
    const task = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
      // owner_id set via runtime (not in TaskDefinition)
      schedule_id: schedule.id,
    });
    recordAdaptiveSnapshot(task.id, schedule.id, schedule.schedule_expr, "fire");
    // agent 改成 7 天一次
    updateSchedule(schedule.id, { schedule_expr: "0 9 * * 0" });
    // 设 last_run 让测量值精准为 7 天 = 10080 分钟, 远超 max=120
    getDb()
      .prepare(
        "UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?"
      )
      .run(
        new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
        schedule.id
      );

    const { warnings } = await checkAdaptiveFrequency(task.id, schedule.id);
    const a = warnings.find((w) => w.kind === "A_OUT_OF_RANGE");
    expect(a).toBeDefined();
    expect(a!.actualIntervalMinutes).toBeGreaterThan(120);
    expect(sendFeishuWebhook).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendFeishuWebhook).mock.calls[0][0];
    expect(call.message).toContain("expr 出区间");
  });

  it("场景 3: agent 没调 expr -> B 警告", async () => {
    const schedule = createSchedule({
      name: "no-adjust",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
      freq_min_minutes: 60,
      freq_max_minutes: 1440,
    });
    const task = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
      // owner_id set via runtime (not in TaskDefinition)
      schedule_id: schedule.id,
    });
    recordAdaptiveSnapshot(task.id, schedule.id, schedule.schedule_expr, "fire");
    // 不调 schedule, 直接校验.

    const { warnings } = await checkAdaptiveFrequency(task.id, schedule.id);
    const b = warnings.find((w) => w.kind === "B_NO_ADJUSTMENT");
    expect(b).toBeDefined();
    expect(b!.currentExpr).toBe("0 9 * * *");
    expect(sendFeishuWebhook).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendFeishuWebhook).mock.calls[0][0];
    expect(call.message).toContain("本轮未调 expr");
    expect(call.message).toContain(`cron.sh update ${schedule.id}`);
  });

  it("schedule 未启用自适应 -> no-op, 无警告", async () => {
    const schedule = createSchedule({
      name: "no-adapt-runtime",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
    });
    const task = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
      // owner_id set via runtime (not in TaskDefinition)
      schedule_id: schedule.id,
    });
    const { warnings } = await checkAdaptiveFrequency(task.id, schedule.id);
    expect(warnings).toHaveLength(0);
    expect(sendFeishuWebhook).not.toHaveBeenCalled();
  });

  it("owner 未配 feishu webhook -> console.warn 降级, 不抛错", async () => {
    getDb()
      .prepare("UPDATE users SET feishu_webhook_url = NULL WHERE id = ?")
      .run(ownerId);

    const schedule = createSchedule({
      name: "no-webhook",
      exec_type: "agent",
      title: "x",
      prompt: "x",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId,
      freq_min_minutes: 60,
      freq_max_minutes: 1440,
    });
    const task = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
      // owner_id set via runtime (not in TaskDefinition)
      schedule_id: schedule.id,
    });
    recordAdaptiveSnapshot(task.id, schedule.id, schedule.schedule_expr, "fire");

    await expect(
      checkAdaptiveFrequency(task.id, schedule.id)
    ).resolves.toBeDefined();
    expect(sendFeishuWebhook).not.toHaveBeenCalled();
  });
});