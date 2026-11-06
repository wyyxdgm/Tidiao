// R165 条件拉取的指纹契约: listTasksPageFingerprint(filter) 必须
//   (1) 无写入时稳定 —— 这是"没更新就不拉全量"的前提, 抖动会让 ETag 永远命中不了;
//   (2) 任务增 / 删 / 改时必变 —— 不变就是静默脏数据 (用户看到旧数据却以为是最新的);
//   (3) 覆盖 tasks 之外的写路径 —— 需求状态 / checkpoint 状态变更也要让指纹变,
//       因为看板卡片渲染 requirement_status 与 latest_checkpoint_status;
//   (4) 与 listTasksPage 共用同一份 WHERE —— 筛选收窄后指纹要跟着变.
//
// 为什么要写专门测试: 指纹是"省流量"与"数据正确"的交界处. 假阴性 (漏变) 直接
// 表现为用户投诉"数据不更新", 而且是静默的, 没有报错, 只能靠测试守住.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import {
  createTask,
  updateTaskStatus,
  listTasksPage,
  listTasksPageFingerprint,
} from "./tasks";
import { createRequirement, updateRequirement } from "./requirements";
import { insertCheckpoint } from "./checkpoints";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-page-etag-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs migrations

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "page-etag-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const all = () => ({ statusGroup: "all" as const, ownerId });
const active = () => ({ statusGroup: "active" as const, ownerId });

describe("listTasksPageFingerprint: stability", () => {
  it("returns the same value when nothing changed", () => {
    createTask({ title: "t1", prompt: "p", project_id: projectId });
    const a = listTasksPageFingerprint(all());
    const b = listTasksPageFingerprint(all());
    expect(b).toBe(a);
  });

  it("is a weak validator over 4 components", () => {
    const fp = listTasksPageFingerprint(all());
    expect(fp.startsWith('W/"')).toBe(true);
    expect(fp.endsWith('"')).toBe(true);
  });
});

describe("listTasksPageFingerprint: change detection", () => {
  it("changes when a task is created", () => {
    const before = listTasksPageFingerprint(all());
    createTask({ title: "t1", prompt: "p", project_id: projectId });
    expect(listTasksPageFingerprint(all())).not.toBe(before);
  });

  it("changes when a task status flips", () => {
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const before = listTasksPageFingerprint(all());
    updateTaskStatus(t.id, "running");
    expect(listTasksPageFingerprint(all())).not.toBe(before);
  });

  it("changes when a task row is touched without a status flip", () => {
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const before = listTasksPageFingerprint(all());
    getDb()
      .prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 5000).toISOString(), t.id);
    expect(listTasksPageFingerprint(all())).not.toBe(before);
  });

  it("changes when a requirement's status flips (watch card chip reads it)", () => {
    const req = createRequirement(projectId, { title: "r1" }, ownerId);
    const before = listTasksPageFingerprint(all());
    updateRequirement(req.id, { status: "done" }, ownerId);
    expect(listTasksPageFingerprint(all())).not.toBe(before);
  });

  it("changes when a checkpoint marker lands (watch card chip reads it)", () => {
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const before = listTasksPageFingerprint(all());
    insertCheckpoint({
      task_id: t.id,
      session_id: "sess-1",
      step: "1",
      summary: "等拍板",
      by: null,
      status: "await_user",
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: null,
    });
    expect(listTasksPageFingerprint(all())).not.toBe(before);
  });

  it("changes on two writes inside the same second (MAX(updated_at) alone would not)", () => {
    // 回归: 指纹早期版本只掺 MAX(updated_at), 而它是秒级精度 —— 同一秒内
    // 两次写入指纹不变 = 假 304 = 用户看到脏数据. 写计数兜住这一类.
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const before = listTasksPageFingerprint(all());
    getDb()
      .prepare(`UPDATE tasks SET title = ? WHERE id = ?`)
      .run("t1-renamed-same-second", t.id);
    expect(listTasksPageFingerprint(all())).not.toBe(before);
  });
});

describe("listTasksPageFingerprint: shares the WHERE with listTasksPage", () => {
  it("scopes to the same rows the page would return", () => {
    const other = createProject({ name: "other", ownerId }).id;
    createTask({ title: "mine", prompt: "p", project_id: projectId });
    createTask({ title: "theirs", prompt: "p", project_id: other });

    const fp = listTasksPageFingerprint({ ...all(), project_id: projectId });
    const page = listTasksPage({ ...all(), project_id: projectId });

    expect(page.items.map((i) => i.title)).toEqual(["mine"]);
    // 指纹里的 total 段必须等于该筛选下的真实行数 (否则 ETag 与行集脱钩).
    expect(fp).toContain(`-${page.total}-`);
  });

  it("differs between statusGroup=active and terminal once a task terminates", () => {
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    expect(listTasksPageFingerprint(active())).not.toBe(
      listTasksPageFingerprint({ statusGroup: "terminal", ownerId })
    );
    updateTaskStatus(t.id, "completed");
    // 终态任务进入 terminal 组 —— 两组指纹必须各自反映自己的行集.
    expect(listTasksPageFingerprint({ statusGroup: "terminal", ownerId })).not.toBe(
      listTasksPageFingerprint(active())
    );
  });
});

describe("listTasksPageFingerprint: entity-tag safety", () => {
  it("contains no whitespace even when rows carry a SQLite datetime stamp", () => {
    // 回归: MAX(updated_at) 的格式是 "2026-09-29 08:11:36" (中间有空格), 直接
    // 拼进 ETag 会违反 RFC 9110, 回程被截断 → 条件拉取永远命中不了.
    createTask({ title: "t1", prompt: "p", project_id: projectId });
    const fp = listTasksPageFingerprint(all());
    expect(fp).not.toMatch(/\s/);
  });
});
