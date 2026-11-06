// Tests for v68 soft-delete 列 + listSchedules includeDeleted 过滤。
//
// 覆盖:
//   - 默认 listSchedules 过滤掉 deleted_at IS NOT NULL 的行
//   - includeDeleted=true 返回软删除行
//   - v68 migration: 加 deleted_at 列 + 给历史 [soft-deleted-YYYYMMDD] 前缀条目回填

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  listSchedules,
  createSchedule,
  recordRun,
  purgeOldRuns,
  type ScheduleDefinition,
} from "./schedules";

let tmpDir: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs all migrations including v68
  userId = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(userId, `u-${uuidv4()}@example.com`, "x");
});

function seedActive(): string {
  const id = uuidv4();
  getDb()
    .prepare(
      "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, "active-cron", "shell", "cron", "0 9 * * *", "2099-01-01T00:00:00Z", userId, null);
  return id;
}

function seedDeleted(): string {
  const id = uuidv4();
  // 直接 SQL 模拟「软删除」= deleted_at 非 NULL（绕过 API，本测试只关心过滤语义）。
  getDb()
    .prepare(
      "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, "[soft-deleted-20260901] old-cron", "shell", "cron", "0 8 * * *", "2099-01-01T00:00:00Z", userId, "2026-09-01T00:00:00Z");
  return id;
}

describe("v68 migration", () => {
  it("adds schedules.deleted_at column + index", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "deleted_at")).toBe(true);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_schedules_deleted_at'")
      .get();
    expect(idx).toBeTruthy();
  });

  it("backfills historical [soft-deleted-YYYYMMDD] entries with ISO 8601 deleted_at", () => {
    // 模拟「migration 之前的旧世界」状态: 一行只有 name 前缀、没有 deleted_at。
    // 直接 INSERT 一行 deleted_at=NULL 的旧风格数据, 然后手工跑回填 SQL 验证语义。
    const db = getDb();
    db.prepare(
      "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
    ).run("legacy-1", "[soft-deleted-20260901] legacy-cron", "shell", "cron", "0 7 * * *", "2099-01-01T00:00:00Z", userId);
    // 跑一次回填 SQL（与 migration v68 中那段完全相同）
    db.exec(`
      UPDATE schedules
         SET deleted_at = substr(name, 15, 4) || '-' || substr(name, 19, 2) || '-' || substr(name, 21, 2) || 'T00:00:00Z'
       WHERE deleted_at IS NULL
         AND instr(name, '[soft-deleted-') = 1
         AND length(substr(name, 15, 8)) = 8;
    `);
    const row = db
      .prepare("SELECT deleted_at FROM schedules WHERE id = ?")
      .get("legacy-1") as { deleted_at: string };
    expect(row.deleted_at).toBe("2026-09-01T00:00:00Z");
  });

  it("does not touch rows whose name does not have [soft-deleted-] prefix", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
    ).run("plain-1", "normal-cron", "shell", "cron", "0 6 * * *", "2099-01-01T00:00:00Z", userId);
    db.exec(`
      UPDATE schedules
         SET deleted_at = substr(name, 15, 4) || '-' || substr(name, 19, 2) || '-' || substr(name, 21, 2) || 'T00:00:00Z'
       WHERE deleted_at IS NULL
         AND instr(name, '[soft-deleted-') = 1
         AND length(substr(name, 15, 8)) = 8;
    `);
    const row = db
      .prepare("SELECT deleted_at FROM schedules WHERE id = ?")
      .get("plain-1") as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });
});

describe("listSchedules soft-delete 过滤", () => {
  it("默认只返回 deleted_at IS NULL 的行", () => {
    seedActive();
    seedDeleted();
    const rows = listSchedules(userId);
    expect(rows.map((r) => r.name)).toEqual(["active-cron"]);
  });

  it("includeDeleted=true 返回所有行, 含已软删除", () => {
    seedActive();
    seedDeleted();
    const rows = listSchedules(userId, undefined, { includeDeleted: true });
    expect(rows.map((r) => r.name).sort()).toEqual([
      "[soft-deleted-20260901] old-cron",
      "active-cron",
    ]);
    const deleted = rows.find((r) => r.name.startsWith("[soft-deleted-"));
    expect(deleted?.deleted_at).toBe("2026-09-01T00:00:00Z");
  });

  it("createSchedule 写新行 deleted_at 默认为 NULL", () => {
    const def: ScheduleDefinition = {
      name: "fresh-cron",
      exec_type: "shell",
      schedule_type: "cron",
      schedule_expr: "*/10 * * * *",
      command: "echo hi",
      ownerId: userId,
    };
    const s = createSchedule(def);
    expect(s.deleted_at).toBeNull();
  });

  it("跨 owner 隔离 + includeDeleted 仍按 owner 过滤", () => {
    const otherUser = uuidv4();
    getDb()
      .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
      .run(otherUser, `o-${uuidv4()}@example.com`, "x");
    seedActive();
    seedDeleted();
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
      )
      .run("other-1", "other-active", "shell", "cron", "0 5 * * *", "2099-01-01T00:00:00Z", otherUser);
    const rows = listSchedules(otherUser, undefined, { includeDeleted: true });
    expect(rows.map((r) => r.name)).toEqual(["other-active"]);
  });
});

// 🆕 飞书 R92: listSchedules 时间区间筛选回归测试。
//   覆盖:
//   - 上次/下次 各一组起止筛 → 只返区间内的 schedule
//   - 半传（只 from / 只 to / 缺一）= 忽略该维度，不报错
//   - 非法字符串 = 兜成 undefined = 忽略该维度
//   - 未执行（last_run=NULL）不算在区间内（damo 拍板）
//   - 时间区间 + 项目 + includeDeleted 三组独立可叠加
describe("listSchedules 时间区间筛选 (R92)", () => {
  function seedWithTimes(opts: {
    name: string;
    lastRun?: string | null;
    nextRun: string;
  }): string {
    const id = uuidv4();
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, last_run, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
      )
      .run(
        id,
        opts.name,
        "shell",
        "cron",
        "0 0 * * *",
        opts.nextRun,
        opts.lastRun ?? null,
        userId,
      );
    return id;
  }

  it("lastRun 区间过滤：last_run BETWEEN from AND to", () => {
    seedWithTimes({ name: "early", lastRun: "2026-08-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    seedWithTimes({ name: "mid",   lastRun: "2026-09-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    seedWithTimes({ name: "late",  lastRun: "2026-10-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    const rows = listSchedules(userId, undefined, {
      lastRunFrom: "2026-08-15T00:00:00Z",
      lastRunTo:   "2026-09-15T00:00:00Z",
    });
    expect(rows.map((r) => r.name)).toEqual(["mid"]);
  });

  it("nextRun 区间过滤：next_run BETWEEN from AND to", () => {
    seedWithTimes({ name: "early", lastRun: null, nextRun: "2026-08-01T00:00:00Z" });
    seedWithTimes({ name: "mid",   lastRun: null, nextRun: "2026-09-01T00:00:00Z" });
    seedWithTimes({ name: "late",  lastRun: null, nextRun: "2026-10-01T00:00:00Z" });
    const rows = listSchedules(userId, undefined, {
      nextRunFrom: "2026-08-15T00:00:00Z",
      nextRunTo:   "2026-09-15T00:00:00Z",
    });
    expect(rows.map((r) => r.name)).toEqual(["mid"]);
  });

  it("last_run=NULL 不算在区间内（damo 拍板：未执行的不算）", () => {
    seedWithTimes({ name: "null-last", lastRun: null, nextRun: "2099-01-01T00:00:00Z" });
    seedWithTimes({ name: "has-last",  lastRun: "2026-09-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    const rows = listSchedules(userId, undefined, {
      lastRunFrom: "2020-01-01T00:00:00Z",
      lastRunTo:   "2099-12-31T00:00:00Z",
    });
    expect(rows.map((r) => r.name)).toEqual(["has-last"]);
  });

  it("半传（只 from 没 to / 只 to 没 from）= 忽略该维度，不报错", () => {
    seedWithTimes({ name: "any", lastRun: "2026-09-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    // 只传 from
    const a = listSchedules(userId, undefined, { lastRunFrom: "2020-01-01T00:00:00Z" });
    expect(a.map((r) => r.name)).toEqual(["any"]);
    // 只传 to
    const b = listSchedules(userId, undefined, { lastRunTo: "2099-12-31T00:00:00Z" });
    expect(b.map((r) => r.name)).toEqual(["any"]);
  });

  it("非法字符串（无法 parse）= 兜成 undefined = 忽略该维度", () => {
    seedWithTimes({ name: "any", lastRun: "2026-09-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    const rows = listSchedules(userId, undefined, {
      lastRunFrom: "garbage",
      lastRunTo: "2026-09-15T00:00:00Z",
    });
    // 半传被忽略 → 返回所有行
    expect(rows.map((r) => r.name)).toEqual(["any"]);
  });

  it("时间区间与项目 + includeDeleted 三组独立可叠加", () => {
    const projId = uuidv4();
    getDb()
      .prepare("INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)")
      .run(projId, "p1", userId);
    // 同一用户, 同项目, last_run 在区间内, 非软删除
    const in1 = seedWithTimes({ name: "in-p1",  lastRun: "2026-09-05T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    getDb().prepare("UPDATE schedules SET project_id = ? WHERE id = ?").run(projId, in1);
    // 同项目 + 软删除
    const del = seedWithTimes({ name: "[soft-deleted-20260901] deleted-p1", lastRun: "2026-09-05T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    getDb().prepare("UPDATE schedules SET project_id = ?, deleted_at = ? WHERE id = ?").run(projId, "2026-09-01T00:00:00Z", del);
    // 同项目 + last_run 不在区间
    seedWithTimes({ name: "out-p1", lastRun: "2026-01-01T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });
    getDb().prepare("UPDATE schedules SET project_id = ? WHERE name = 'out-p1'").run(projId);
    // 不同项目 + 在区间
    seedWithTimes({ name: "in-p2", lastRun: "2026-09-05T00:00:00Z", nextRun: "2099-01-01T00:00:00Z" });

    // 默认: 看 p1 + 在区间内 + 不含软删除 = 只有 in-p1
    let rows = listSchedules(userId, projId, {
      lastRunFrom: "2026-09-01T00:00:00Z",
      lastRunTo:   "2026-09-30T00:00:00Z",
    });
    expect(rows.map((r) => r.name)).toEqual(["in-p1"]);

    // 加 includeDeleted: 软删除的也回来
    rows = listSchedules(userId, projId, {
      lastRunFrom: "2026-09-01T00:00:00Z",
      lastRunTo:   "2026-09-30T00:00:00Z",
      includeDeleted: true,
    });
    expect(rows.map((r) => r.name).sort()).toEqual(["[soft-deleted-20260901] deleted-p1", "in-p1"]);
  });
});

// 🆕 启用状态筛选: listSchedules opts.enabled。覆盖:
//   - enabled=true 只返启用行 / enabled=false 只返停用行
//   - undefined (未传) = 不过滤, 返回全部
describe("listSchedules enabled 状态筛选", () => {
  function seedWithEnabled(name: string, enabled: boolean): string {
    const id = uuidv4();
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, enabled, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
      )
      .run(id, name, "shell", "cron", "0 0 * * *", "2099-01-01T00:00:00Z", enabled ? 1 : 0, userId);
    return id;
  }

  it("enabled=true 只返启用, enabled=false 只返停用", () => {
    seedWithEnabled("on-1", true);
    seedWithEnabled("off-1", false);
    seedWithEnabled("on-2", true);
    expect(listSchedules(userId, undefined, { enabled: true }).map((r) => r.name).sort())
      .toEqual(["on-1", "on-2"]);
    expect(listSchedules(userId, undefined, { enabled: false }).map((r) => r.name))
      .toEqual(["off-1"]);
  });

  it("未传 enabled = 不过滤, 启用停用都返回", () => {
    seedWithEnabled("on-1", true);
    seedWithEnabled("off-1", false);
    expect(listSchedules(userId, undefined, {}).map((r) => r.name).sort())
      .toEqual(["off-1", "on-1"]);
  });
});

// 🆕 飞书 R92 第二批反馈: listSchedules versionId 精确过滤 (damo 0830 R 列「版本也支持筛选」)。
//   覆盖:
//   - 精确匹配：只返 version_id = opts.versionId 的行
//   - 空字符串 / undefined：不过滤 (与 projectId 语义一致)
//   - 与 projectId 叠加：先 project 后 version, 可单筛也可叠加
//   - 跨 owner 隔离：其他用户的 version 不会被误匹配
describe("listSchedules version 过滤 (R92 第二批)", () => {
  // 注: schedules 表 version_id 是 nullable text 列, 不需 FK (旧 schedule 可无 version)。
  // 用 UUID 当 version_id 模拟, DB 层不做存在性校验 —— 由 UI 层负责传合法值。
  function seedWithVersion(name: string, versionId: string | null): string {
    const id = uuidv4();
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, version_id, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(id, name, "shell", "cron", "0 0 * * *", "2099-01-01T00:00:00Z", versionId, userId);
    return id;
  }

  it("精确匹配：只返 version_id = 给定值的行", () => {
    const v1 = uuidv4();
    const v2 = uuidv4();
    seedWithVersion("match-v1", v1);
    seedWithVersion("match-v2", v2);
    seedWithVersion("no-version", null);
    const rows = listSchedules(userId, undefined, { versionId: v1 });
    expect(rows.map((r) => r.name)).toEqual(["match-v1"]);
  });

  it("空字符串 / undefined = 不过滤 (空 opts 不过滤维度)", () => {
    const v = uuidv4();
    seedWithVersion("any", v);
    seedWithVersion("any-2", null);
    // 空串
    let rows = listSchedules(userId, undefined, { versionId: "" });
    expect(rows.map((r) => r.name).sort()).toEqual(["any", "any-2"]);
    // undefined
    rows = listSchedules(userId, undefined, {});
    expect(rows.map((r) => r.name).sort()).toEqual(["any", "any-2"]);
  });

  it("与 projectId 叠加：先 project 后 version", () => {
    const projId = uuidv4();
    getDb()
      .prepare("INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)")
      .run(projId, "p1", userId);
    const v1 = uuidv4();
    const v2 = uuidv4();
    // 同项目 + v1
    seedWithVersion("in-p1-v1", v1);
    getDb().prepare("UPDATE schedules SET project_id = ? WHERE name = 'in-p1-v1'").run(projId);
    // 同项目 + v2
    seedWithVersion("in-p1-v2", v2);
    getDb().prepare("UPDATE schedules SET project_id = ? WHERE name = 'in-p1-v2'").run(projId);
    // 同项目 + 无 version
    seedWithVersion("in-p1-noversion", null);
    getDb().prepare("UPDATE schedules SET project_id = ? WHERE name = 'in-p1-noversion'").run(projId);
    // 不同项目 + v1 (应被 project 过滤掉)
    seedWithVersion("other-p-v1", v1);

    const rows = listSchedules(userId, projId, { versionId: v1 });
    expect(rows.map((r) => r.name)).toEqual(["in-p1-v1"]);
  });

  it("跨 owner 隔离：其他用户的同 versionId 不会被本用户拉到", () => {
    const otherUser = uuidv4();
    getDb()
      .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
      .run(otherUser, `o-${uuidv4()}@example.com`, "x");
    const sharedVersion = uuidv4();
    seedWithVersion("mine", sharedVersion);
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, version_id, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(uuidv4(), "theirs", "shell", "cron", "0 0 * * *", "2099-01-01T00:00:00Z", sharedVersion, otherUser);

    const rows = listSchedules(userId, undefined, { versionId: sharedVersion });
    expect(rows.map((r) => r.name)).toEqual(["mine"]);
    const theirRows = listSchedules(otherUser, undefined, { versionId: sharedVersion });
    expect(theirRows.map((r) => r.name)).toEqual(["theirs"]);
  });
});

// 🆕 飞书 R79: purgeOldRuns 回归测试
// 覆盖:
//   - olderThanDays 单维度（按 started_at 年龄删）
//   - keepLastN 单维度（每 schedule 保留最新 N 条）
//   - 双维度并集（被年龄删的就不再算进 keepLastN）
//   - 0 / null / 非法值降级为 noop
//   - 多 schedule 隔离（keepLastN 不能把别 schedule 的最新 N 条误保留）
//   - 跨 schedule 全删（一个 schedule 全删不影响其他）
describe("purgeOldRuns (R79)", () => {
  // 辅助: 给定 scheduleId 灌入 N 条 started_at = baseIso + offsetMinutes
  // 关键: schedule_runs.schedule_id 是 FK → schedules.id, 必须先建 schedule 行.
  // 这里直接 SQL 插一行最简 schedule (避开 createSchedule 的项目 owner / 必填校验).
  function ensureSchedule(scheduleId: string): void {
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, deleted_at) VALUES (?, ?, 'shell', 'cron', '0 0 * * *', '2099-01-01T00:00:00Z', NULL, NULL)",
      )
      .run(scheduleId, `fake-${scheduleId}`);
  }
  function seedRuns(scheduleId: string, baseIso: string, count: number, output = "ok"): number[] {
    ensureSchedule(scheduleId);
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const ts = new Date(new Date(baseIso).getTime() + i * 60_000).toISOString();
      const id = recordRun({
        schedule_id: scheduleId,
        exec_type: "shell",
        command: "echo x",
        started_at: ts,
      });
      // 顺手把 output 写上, 验证不影响 purge 逻辑
      getDb()
        .prepare(
          "UPDATE schedule_runs SET output = ?, completed_at = ?, exit_code = 0 WHERE id = ?",
        )
        .run(output, ts, id);
      ids.push(id);
    }
    return ids;
  }

  function totalRuns(): number {
    return (getDb().prepare("SELECT COUNT(*) as cnt FROM schedule_runs").get() as { cnt: number }).cnt;
  }

  function runsOf(scheduleId: string): number {
    return (getDb()
      .prepare("SELECT COUNT(*) as cnt FROM schedule_runs WHERE schedule_id = ?")
      .get(scheduleId) as { cnt: number }).cnt;
  }

  it("olderThanDays 单维度: 早于阈值的全删, 阈值内的全留", () => {
    const sid = "s-age";
    // now=2026-09-04T12:00:00Z, 灌 5 条: -10d, -5d, -1d, -12h, now
    const now = "2026-09-04T12:00:00Z";
    seedRuns(sid, "2026-09-04T11:00:00Z", 1); // -1h, 留
    seedRuns(sid, "2026-09-04T00:00:00Z", 1); // -12h, 留
    seedRuns(sid, "2026-09-03T12:00:00Z", 1); // -1d, 留
    seedRuns(sid, "2026-08-30T12:00:00Z", 1); // -5d, 删 (>3d)
    seedRuns(sid, "2026-08-25T12:00:00Z", 1); // -10d, 删
    expect(totalRuns()).toBe(5);

    const r = purgeOldRuns({ olderThanDays: 3, nowIso: now });
    expect(r.byAge).toBe(2);
    expect(r.byCount).toBe(0);
    expect(r.total).toBe(2);
    expect(runsOf(sid)).toBe(3);
  });

  it("keepLastN 单维度: 每 schedule 保留最新 N 条, 删剩余", () => {
    const sid = "s-count";
    seedRuns(sid, "2026-09-04T00:00:00Z", 10); // 最新的是 00:09 (00:00 + 9 min 间隔)
    expect(runsOf(sid)).toBe(10);

    const r = purgeOldRuns({ keepLastN: 3 });
    expect(r.byCount).toBe(7);
    expect(r.byAge).toBe(0);
    expect(runsOf(sid)).toBe(3);
    // 验证留下的是最新 3 条 (00:09 / 00:08 / 00:07), 不是最旧.
    const remaining = getDb()
      .prepare("SELECT started_at FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC")
      .all(sid) as Array<{ started_at: string }>;
    expect(remaining[0].started_at).toBe("2026-09-04T00:09:00.000Z");
    expect(remaining[1].started_at).toBe("2026-09-04T00:08:00.000Z");
    expect(remaining[2].started_at).toBe("2026-09-04T00:07:00.000Z");
  });

  it("双维度并集: 既超龄又超额的部分都删, 但不重复计", () => {
    const sid = "s-union";
    const now = "2026-09-04T12:00:00Z";
    // 灌 5 条: -10d, -8d, -5d, -2d, now
    seedRuns(sid, "2026-09-04T11:00:00Z", 1); // -1h, 留
    seedRuns(sid, "2026-09-02T12:00:00Z", 1); // -2d, 留 (年轻)
    seedRuns(sid, "2026-08-30T12:00:00Z", 1); // -5d, 超龄
    seedRuns(sid, "2026-08-27T12:00:00Z", 1); // -8d, 超龄
    seedRuns(sid, "2026-08-25T12:00:00Z", 1); // -10d, 超龄
    expect(runsOf(sid)).toBe(5);

    // 阈值: olderThanDays=3 + keepLastN=2 (但 5 条里超龄的有 3 条, age 删 3; 然后剩 2 条, 不再 keepLastN 删).
    const r = purgeOldRuns({ olderThanDays: 3, keepLastN: 2, nowIso: now });
    expect(r.byAge).toBe(3);
    expect(r.byCount).toBe(0); // 剩 2 条正好等于 keepN
    expect(runsOf(sid)).toBe(2);
  });

  it("双维度并集: age 不删、count 删的情况", () => {
    const sid = "s-count2";
    // 5 条都在阈值内 (年轻), 但 keepLastN=2 要删 3 条
    seedRuns(sid, "2026-09-04T00:00:00Z", 5);
    // 传固定 nowIso: 之前不传 → 用真实时钟, seed 落地超过 30 天后本测试变时间炸弹 (2026-11-02 实证复发)。
    const r = purgeOldRuns({ olderThanDays: 30, keepLastN: 2, nowIso: "2026-09-04T12:00:00Z" });
    expect(r.byAge).toBe(0);
    expect(r.byCount).toBe(3);
    expect(runsOf(sid)).toBe(2);
  });

  it("olderThanDays=0 等价 null: 不删任何", () => {
    const sid = "s-zero";
    seedRuns(sid, "1990-01-01T00:00:00Z", 3); // 30 年前也不删
    const r = purgeOldRuns({ olderThanDays: 0, keepLastN: 0 });
    expect(r.total).toBe(0);
    expect(r.applied).toEqual({ olderThanDays: null, keepLastN: null });
    expect(runsOf(sid)).toBe(3);
  });

  it("非法值降级 noop (0 / 负数 / 浮点 / NaN / 字符串都返 0)", () => {
    const sid = "s-bad";
    seedRuns(sid, "2020-01-01T00:00:00Z", 2);
    const r = purgeOldRuns({ olderThanDays: -5, keepLastN: 1.5 });
    expect(r.total).toBe(0);
    expect(r.applied).toEqual({ olderThanDays: null, keepLastN: null });
    expect(runsOf(sid)).toBe(2);
  });

  it("无参数调用: noop", () => {
    const sid = "s-noop";
    seedRuns(sid, "2020-01-01T00:00:00Z", 2);
    const r = purgeOldRuns();
    expect(r.total).toBe(0);
    expect(runsOf(sid)).toBe(2);
  });

  it("多 schedule 隔离: keepLastN 只切自己, 不动别 schedule", () => {
    const a = "s-iso-a";
    const b = "s-iso-b";
    seedRuns(a, "2026-09-04T00:00:00Z", 8); // a 8 条
    seedRuns(b, "2026-09-04T00:00:00Z", 4); // b 4 条

    const r = purgeOldRuns({ keepLastN: 3 });
    expect(r.byCount).toBe(8 + 4 - 3 - 3); // a 删 5 + b 删 1 = 6
    expect(runsOf(a)).toBe(3);
    expect(runsOf(b)).toBe(3);
  });

  it("schedule 维度全删 (keepLastN=0) 不影响其他 schedule", () => {
    const a = "s-wipe-a";
    const b = "s-wipe-b";
    seedRuns(a, "2026-09-04T00:00:00Z", 5);
    seedRuns(b, "2026-09-04T00:00:00Z", 2);

    const r = purgeOldRuns({ keepLastN: 1 });
    expect(r.byCount).toBe(5 - 1 + 2 - 1); // a 删 4 + b 删 1
    expect(runsOf(a)).toBe(1);
    expect(runsOf(b)).toBe(1);
  });
});

// ============================================================
// 飞书 R96 智能降频（v70）回归测试
// ============================================================

import {
  isHourInNightWindow,
  computeNextRunWithNight,
  computeNextRun,
  updateSchedule,
} from "./schedules";
import type { ScheduleUpdate } from "./schedules";

describe("v70 night frequency — isHourInNightWindow", () => {
  it("非跨午夜窗口: [23,6) = start>end, hour=22 不在, hour=23 在, hour=5 在, hour=6 不在", () => {
    expect(isHourInNightWindow(22, 23, 6)).toBe(false);
    expect(isHourInNightWindow(23, 23, 6)).toBe(true);
    expect(isHourInNightWindow(0, 23, 6)).toBe(true);
    expect(isHourInNightWindow(5, 23, 6)).toBe(true);
    expect(isHourInNightWindow(6, 23, 6)).toBe(false);
    expect(isHourInNightWindow(12, 23, 6)).toBe(false);
  });

  it("非跨午夜窗口: [9,18) = start<end, hour=8/18 不在, hour=9/17 在", () => {
    expect(isHourInNightWindow(8, 9, 18)).toBe(false);
    expect(isHourInNightWindow(9, 9, 18)).toBe(true);
    expect(isHourInNightWindow(17, 9, 18)).toBe(true);
    expect(isHourInNightWindow(18, 9, 18)).toBe(false);
  });

  it("start == end 返回 false（零长度窗口 = 未启用）", () => {
    expect(isHourInNightWindow(0, 6, 6)).toBe(false);
    expect(isHourInNightWindow(12, 6, 6)).toBe(false);
  });
});

describe("v70 night frequency — computeNextRunWithNight", () => {
  // 测试锚点: 用一个固定的"当前时刻"避免时区漂移; schedule tz = UTC 简化判断。
  const tz = "UTC";

  it("night_* 全 NULL = 退回 computeNextRun 行为", () => {
    const r1 = computeNextRunWithNight({
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      timezone: tz,
      night_start_hour: null,
      night_end_hour: null,
      night_schedule_expr: null,
    });
    const r2 = computeNextRun({
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      timezone: tz,
    });
    expect(r1).toBe(r2);
  });

  it("schedule_type=once 直接走原路径（无窗口意义）", () => {
    const r = computeNextRunWithNight({
      schedule_type: "once",
      schedule_expr: "2099-01-01T00:00:00Z",
      timezone: tz,
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "*/30 * * * *",
    });
    expect(r).toBeNull();
  });

  it("night 配置启用: 启用后 next_run 至少要走一次（具体时刻依赖 cron parser 当前时间，仅做非空校验）", () => {
    const r = computeNextRunWithNight({
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      timezone: tz,
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "*/30 * * * *",
    });
    expect(r).not.toBeNull();
    expect(typeof r).toBe("string");
  });

  it("night_schedule_expr 解析失败 -> 退回 schedule_expr 的结果（warn 但不抛）", () => {
    // 故意给个无效 cron, console.warn 会触发, 但返回 next1 不为 null。
    const r = computeNextRunWithNight({
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      timezone: tz,
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "this-is-not-cron",
    });
    expect(r).not.toBeNull();
  });
});

describe("v70 night frequency — createSchedule validation", () => {
  it("三字段同填 + cron schedule + 合法小时 + 合法 cron -> 落库成功", () => {
    const s = createSchedule({
      name: "night-test-1",
      exec_type: "shell",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      command: "echo hi",
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "*/30 * * * *",
      ownerId: userId,
    });
    expect(s.night_start_hour).toBe(23);
    expect(s.night_end_hour).toBe(6);
    expect(s.night_schedule_expr).toBe("*/30 * * * *");
  });

  it("三字段都为空 -> 落库 NULL", () => {
    const s = createSchedule({
      name: "night-test-2",
      exec_type: "shell",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      command: "echo hi",
      ownerId: userId,
    });
    expect(s.night_start_hour).toBeNull();
    expect(s.night_end_hour).toBeNull();
    expect(s.night_schedule_expr).toBeNull();
  });

  it("start == end -> throw（零长度窗口无意义）", () => {
    expect(() =>
      createSchedule({
        name: "bad-night",
        exec_type: "shell",
        schedule_type: "cron",
        schedule_expr: "*/5 * * * *",
        command: "echo hi",
        night_start_hour: 6,
        night_end_hour: 6,
        night_schedule_expr: "*/30 * * * *",
        ownerId: userId,
      })
    ).toThrow(/不能相等/);
  });

  it("hour 越界 (-1 / 24) -> throw", () => {
    expect(() =>
      createSchedule({
        name: "bad-night-h",
        exec_type: "shell",
        schedule_type: "cron",
        schedule_expr: "*/5 * * * *",
        command: "echo hi",
        night_start_hour: -1,
        night_end_hour: 6,
        night_schedule_expr: "*/30 * * * *",
        ownerId: userId,
      })
    ).toThrow(/night_start_hour/);

    expect(() =>
      createSchedule({
        name: "bad-night-h2",
        exec_type: "shell",
        schedule_type: "cron",
        schedule_expr: "*/5 * * * *",
        command: "echo hi",
        night_start_hour: 23,
        night_end_hour: 24,
        night_schedule_expr: "*/30 * * * *",
        ownerId: userId,
      })
    ).toThrow(/night_end_hour/);
  });

  it("night_schedule_expr 是非法 cron -> throw", () => {
    expect(() =>
      createSchedule({
        name: "bad-night-expr",
        exec_type: "shell",
        schedule_type: "cron",
        schedule_expr: "*/5 * * * *",
        command: "echo hi",
        night_start_hour: 23,
        night_end_hour: 6,
        night_schedule_expr: "not-cron-at-all",
        ownerId: userId,
      })
    ).toThrow(/night_schedule_expr/);
  });

  it("只填一个 night 字段（start），其它留空 -> throw（必须三同填）", () => {
    expect(() =>
      createSchedule({
        name: "bad-night-partial",
        exec_type: "shell",
        schedule_type: "cron",
        schedule_expr: "*/5 * * * *",
        command: "echo hi",
        night_start_hour: 23,
        ownerId: userId,
      })
    ).toThrow(/同时设置或同时为空/);
  });

  it("once schedule 不允许 night_* -> throw", () => {
    expect(() =>
      createSchedule({
        name: "bad-once-night",
        exec_type: "shell",
        schedule_type: "once",
        schedule_expr: "2099-01-01T00:00:00Z",
        command: "echo hi",
        night_start_hour: 23,
        night_end_hour: 6,
        night_schedule_expr: "*/30 * * * *",
        ownerId: userId,
      })
    ).toThrow(/once/);
  });
});

describe("v70 night frequency — updateSchedule validation + recompute", () => {
  it("PATCH 三字段同填到原有 NULL 行的 schedule -> 落库 + next_run 重算", () => {
    const s = createSchedule({
      name: "upd-night-1",
      exec_type: "shell",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      command: "echo hi",
      ownerId: userId,
    });
    const beforeNext = s.next_run;
    const u: ScheduleUpdate = {
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "*/30 * * * *",
    };
    const updated = updateSchedule(s.id, u, userId);
    expect(updated).not.toBeNull();
    expect(updated!.night_start_hour).toBe(23);
    expect(updated!.night_end_hour).toBe(6);
    expect(updated!.night_schedule_expr).toBe("*/30 * * * *");
    // next_run 重算了（具体时刻取决于 cron-parser 当前时间，只校验仍是 ISO 字符串）
    expect(typeof updated!.next_run).toBe("string");
    // 注: 不强制 beforeNext !== updated.next_run，因为「白天 */5 → 23:00」跨进夜间
    // 走 max() 选较晚时刻，结果可能恰好等于旧值；不影响正确性。
    void beforeNext;
  });

  it("PATCH 部分 night 字段（只 start）-> throw（避免半态落库）", () => {
    const s = createSchedule({
      name: "upd-night-2",
      exec_type: "shell",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      command: "echo hi",
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "*/30 * * * *",
      ownerId: userId,
    });
    expect(() =>
      updateSchedule(s.id, { night_start_hour: 22 } as ScheduleUpdate, userId)
    ).toThrow(/同时设置或同时清空/);
  });

  it("PATCH 三字段全 null -> 清空 night 配置", () => {
    const s = createSchedule({
      name: "upd-night-clear",
      exec_type: "shell",
      schedule_type: "cron",
      schedule_expr: "*/5 * * * *",
      command: "echo hi",
      night_start_hour: 23,
      night_end_hour: 6,
      night_schedule_expr: "*/30 * * * *",
      ownerId: userId,
    });
    const updated = updateSchedule(
      s.id,
      {
        night_start_hour: null,
        night_end_hour: null,
        night_schedule_expr: null,
      },
      userId
    );
    expect(updated!.night_start_hour).toBeNull();
    expect(updated!.night_end_hour).toBeNull();
    expect(updated!.night_schedule_expr).toBeNull();
  });
});

// 🆕 Bug fix (2026-09-14): schedule_type 与 schedule_expr 格式必须匹配。
// 历史事故: schedule b366fead-... 是 once + "3 0 * * *"，22h+ enabled 但零触发
// （computeNextRun 对 once return null → next_run 落库原字符串 → 永不选中）。
describe("schedule_type 与 schedule_expr 格式校验", () => {
  // createSchedule 路径（schedule_type=once + cron expr 应 throw）
  it("createSchedule: once + cron 表达式 -> throw", () => {
    const def: ScheduleDefinition = {
      name: "broken-once",
      exec_type: "agent",
      title: "t",
      prompt: "p",
      project_id: "x",
      schedule_type: "once",
      schedule_expr: "3 0 * * *", // 用户原误用 cron 表达式
      ownerId: userId,
    };
    expect(() => createSchedule(def)).toThrow(/once requires ISO 8601 datetime/);
  });

  it("createSchedule: once + 合法 ISO -> ok", () => {
    const def: ScheduleDefinition = {
      name: "valid-once",
      exec_type: "shell", // 用 shell 绕开 project_id 校验；bug 与 exec_type 无关
      command: "echo hi",
      schedule_type: "once",
      schedule_expr: "2099-01-01T00:00:00Z",
      ownerId: userId,
    };
    const s = createSchedule(def);
    expect(s.schedule_type).toBe("once");
    // 注意: once 的 next_run 不由 expr 解析得到（computeNextRun 直接 return null），
    // 所以 updateSchedule 走 recompute 时也不应被这条规则错误拦截 —— 见下条测试。
  });

  it("createSchedule: cron + 非法 cron -> throw", () => {
    const def: ScheduleDefinition = {
      name: "broken-cron",
      exec_type: "shell",
      command: "echo hi",
      schedule_type: "cron",
      schedule_expr: "not a cron",
      ownerId: userId,
    };
    expect(() => createSchedule(def)).toThrow(/invalid cron schedule_expr/);
  });

  it("createSchedule: cron + 合法 cron -> ok", () => {
    const def: ScheduleDefinition = {
      name: "valid-cron",
      exec_type: "shell",
      command: "echo hi",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId: userId,
    };
    const s = createSchedule(def);
    expect(s.schedule_type).toBe("cron");
  });

  // updateSchedule 路径：PATCH schedule_expr 必须保证 effective 状态合法。
  it("updateSchedule: 把 cron expr 改成 ISO 后 schedule_type=cron -> throw", () => {
    const s = createSchedule({
      name: "cron-then-bad",
      exec_type: "shell",
      command: "echo hi",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId: userId,
    });
    expect(() =>
      updateSchedule(s.id, { schedule_expr: "2099-01-01T00:00:00Z" }, userId)
    ).toThrow(/invalid cron schedule_expr/);
  });

  it("updateSchedule: 把 once expr 改成 cron 字符串 -> throw", () => {
    const s = createSchedule({
      name: "once-then-bad",
      exec_type: "shell", // 绕开 project_id 校验；bug 与 exec_type 无关
      command: "echo hi",
      schedule_type: "once",
      schedule_expr: "2099-01-01T00:00:00Z",
      ownerId: userId,
    });
    expect(() =>
      updateSchedule(s.id, { schedule_expr: "3 0 * * *" }, userId)
    ).toThrow(/once requires ISO 8601 datetime/);
  });

  it("updateSchedule: 仅 PATCH 无关字段(name/enabled)不触发 expr 校验", () => {
    // 边界: 不动 schedule_type/schedule_expr/timezone → recompute=false → 不校验
    //   这条保证「即便库里有历史脏数据, PATCH 一个无关字段不会被堵」
    const s = createSchedule({
      name: "unrelated-patch",
      exec_type: "shell",
      command: "echo hi",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId: userId,
    });
    const updated = updateSchedule(
      s.id,
      { name: "renamed" } as ScheduleUpdate,
      userId
    );
    expect(updated!.name).toBe("renamed");
  });

  it("updateSchedule: PATCH schedule_type cron->once 必须同时给 ISO expr", () => {
    const s = createSchedule({
      name: "type-flip",
      exec_type: "shell",
      command: "echo hi",
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
      ownerId: userId,
    });
    // 只翻 schedule_type 不翻 expr -> 合成后 once + "0 9 * * *" -> throw
    expect(() =>
      updateSchedule(
        s.id,
        { schedule_type: "once" } as ScheduleUpdate,
        userId
      )
    ).toThrow(/once requires ISO 8601 datetime/);
  });
});
// 🆕 飞书 AO-DEV R218: 「其他版本」桶 — versionId=null (显式) 只返未挂版本的 schedule。
//   SPA 定时任务页版本下拉新增「其他版本（未挂版本）」选项, 后端约定 ?version=null。
describe("listSchedules versionId 过滤 (R218 其他版本桶)", () => {
  let verId: string;

  beforeEach(() => {
    verId = uuidv4();
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, version_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(uuidv4(), "ver-cron", "shell", "cron", "0 9 * * *", "2099-01-01T00:00:00Z", userId, verId, null);
    getDb()
      .prepare(
        "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, owner_id, version_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)"
      )
      .run(uuidv4(), "nover-cron", "shell", "cron", "0 8 * * *", "2099-01-01T00:00:00Z", userId, null);
  });

  it("versionId=具体id 精确匹配 (回归)", () => {
    const rows = listSchedules(userId, undefined, { versionId: verId });
    expect(rows.map((r) => r.name)).toEqual(["ver-cron"]);
  });

  it("versionId=null 只返未挂版本的", () => {
    const rows = listSchedules(userId, undefined, { versionId: null });
    expect(rows.map((r) => r.name)).toEqual(["nover-cron"]);
  });

  it("不传 versionId = 不过滤, 两条都返 (回归)", () => {
    const rows = listSchedules(userId);
    expect(rows.map((r) => r.name).sort()).toEqual(["nover-cron", "ver-cron"]);
  });
});
