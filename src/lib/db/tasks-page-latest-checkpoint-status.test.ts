// listTasksPage() 返回的 latest_checkpoint_status 字段 (R109) 回归测试.
//
// 关注点:
//   - 子查询取 "最新有 status 的 cp" (MAX(rowid) + status IS NOT NULL), 跳过老 marker
//     形态 (status=NULL) 的 cp. 这是 SQL 语义保证, 改 listTasksPage 实现必须保持.
//   - 任务无 cp / cp 全 status=NULL → 字段 null, UI 不渲染 chip (向后兼容).
//   - 多 cp + 中间 cp status=NULL → 取最新有 status 的 cp (不取最新 cp).
//   - COUNT 不走 cp JOIN (同 requirement JOIN 口径, 任务总数 ≠ checkpoint 数).
//   - rowid 是 SQLite 隐式主键, 在 checkpoints 表 (INTEGER PK AUTOINCREMENT) 上等价
//     于 id 列. 用 rowid 而非 id 是为了跨表场景通用, 也避免 id 字段在 ON CONFLICT 后
//     变化引起歧义 (本次 schema 没这问题, 留作防御).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createTask, listTasksPage } from "./tasks";
import { insertCheckpoint } from "./checkpoints";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-page-cp-status-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "page-cp-status-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 给 task 插入一个 cp (绕过 session_id 必填 — 测试环境无 SDK, 直接走 insert API).
function seedCp(
  taskId: string,
  step: string,
  status: string | null,
  upToMsg = `msg-${step}`
): void {
  insertCheckpoint({
    task_id: taskId,
    session_id: uuidv4(),
    step,
    summary: `cp step=${step}`,
    by: status ? "tester" : null, // 老 marker 形态: status=null → by 也 null
    status,
    commit_id: null,
    transcript_slice: null,
    up_to_message_id: upToMsg,
  });
}

describe("listTasksPage: latest_checkpoint_status (R109)", () => {
  it("任务无 cp → latest_checkpoint_status = null (UI 不渲染 chip)", () => {
    const t = createTask({ title: "no-cp", prompt: "x", project_id: projectId });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.latest_checkpoint_status).toBeNull();
  });

  it("任务有 cp 但 status=NULL (老 marker) → latest_checkpoint_status = null", () => {
    const t = createTask({ title: "null-cp", prompt: "x", project_id: projectId });
    seedCp(t.id, "1", null);
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.latest_checkpoint_status).toBeNull();
  });

  it("单 cp 带 status → latest_checkpoint_status = 该字符串", () => {
    const t = createTask({ title: "one-cp", prompt: "x", project_id: projectId });
    seedCp(t.id, "1", "等回复");
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.latest_checkpoint_status).toBe("等回复");
  });

  it("多 cp: 取最新 cp 的 status (rowid 最大)", () => {
    const t = createTask({ title: "multi-cp", prompt: "x", project_id: projectId });
    seedCp(t.id, "1", "等回复");
    seedCp(t.id, "2", "有建议");
    seedCp(t.id, "3", "需拍板");
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.latest_checkpoint_status).toBe("需拍板");
  });

  it("多 cp + 最新 cp status=NULL → 跳过, 取倒数第二个有 status 的 cp", () => {
    // 子查询语义: "最新有 status 的 cp", 不是 "最新 cp". 老 marker 形态 (status=NULL)
    // 出现在最后时, 不应挡住前面有 status 的 cp. 这是 R108 老 marker 迁移期常见的
    // 场景 — agent 重写 step 1 但没收 by/status 字段, 又写了一行 step 2 拿 status.
    const t = createTask({ title: "newer-null", prompt: "x", project_id: projectId });
    seedCp(t.id, "1", "等回复");
    seedCp(t.id, "2", null);
    seedCp(t.id, "3", "卡住");
    seedCp(t.id, "4", null);
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.latest_checkpoint_status).toBe("卡住");
  });

  it("英文 status alias 也原样带回 (映射由前端 getStatusDisplay 负责)", () => {
    // 后端只负责把字符串带回, 不做语义映射 — 同 requirement_status 设计. 测试覆盖
    // 至少一个英文 alias, 防回归.
    const t = createTask({ title: "en-cp", prompt: "x", project_id: projectId });
    seedCp(t.id, "1", "waiting");
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.latest_checkpoint_status).toBe("waiting");
  });

  it("不同 task 的 cp 互不串 (LEFT JOIN 是 per-task 子查询)", () => {
    const t1 = createTask({ title: "t1", prompt: "x", project_id: projectId });
    const t2 = createTask({ title: "t2", prompt: "x", project_id: projectId });
    seedCp(t1.id, "1", "等回复");
    seedCp(t2.id, "1", "卡住");
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row1 = items.find((x) => x.id === t1.id);
    const row2 = items.find((x) => x.id === t2.id);
    expect(row1?.latest_checkpoint_status).toBe("等回复");
    expect(row2?.latest_checkpoint_status).toBe("卡住");
  });

  it("COUNT 不受 LEFT JOIN checkpoints 影响 (任务总数 ≠ checkpoint 数)", () => {
    // 1 个 task + 3 个 cp → total 应该是 1 不是 3.
    const t = createTask({ title: "count-test", prompt: "x", project_id: projectId });
    seedCp(t.id, "1", "等回复");
    seedCp(t.id, "2", "有建议");
    seedCp(t.id, "3", "需拍板");
    const { total } = listTasksPage({ statusGroup: "all", ownerId });
    expect(total).toBe(1);
    // sanity: 直接查 cp 表确认 3 行真的进了
    const cpCount = (getDb()
      .prepare("SELECT COUNT(*) as n FROM checkpoints WHERE task_id = ?")
      .get(t.id) as { n: number }).n;
    expect(cpCount).toBe(3);
  });
});