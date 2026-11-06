// tasks.value_significance + tasks.value_kind (v132, D10) 回归测试.
//
// 关注点:
//   - 列存在且默认 NULL: 新建 task 不显式传 → DB 字段 NULL (向后兼容, 存量 ~200+ task 不炸).
//   - 显式传 value_significance + value_kind → createTask 正确落库, getTaskById 回读一致.
//   - 5 选 1 枚举 value_kind 不锁 schema (damo 「保留扩展性」): 自由字符串也允许 (兜底映射在 UI).
//   - createTask 不传时仍走 INSERT ... ?? null 路径, 不报错.
//   - listTasksPage 不返这 2 个字段 (不在 TaskTrimmed): 看板详情走 getTaskById. 留 UI 角标
//     后续单独任务做 (D10 §18.5).
//
// 设计动机: D10 「派发前置问为什么」- 后置 LLM 反思 5 样本 0/5 命中, 改前置门.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createTask, getTaskById } from "./tasks";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-d10-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "d10-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tasks.value_significance + value_kind (v132, D10)", () => {
  it("新建 task 不传 → DB 字段 = NULL (向后兼容, 不阻塞存量派发)", () => {
    const t = createTask({ title: "no-value", prompt: "x", project_id: projectId });
    const row = getTaskById(t.id);
    expect(row?.value_significance).toBeNull();
    expect(row?.value_kind).toBeNull();
  });

  it("传 value_significance + value_kind → createTask 落库 + 回读一致", () => {
    const t = createTask({
      title: "with-value",
      prompt: "x",
      project_id: projectId,
      value_significance: "解锁 R92 检索能力, 不再每次从零探查",
      value_kind: "unlock_capability",
    });
    const row = getTaskById(t.id);
    expect(row?.value_significance).toBe("解锁 R92 检索能力, 不再每次从零探查");
    expect(row?.value_kind).toBe("unlock_capability");
  });

  it("只传 value_significance 不传 value_kind → kind 仍 NULL (两字段独立)", () => {
    const t = createTask({
      title: "only-significance",
      prompt: "x",
      project_id: projectId,
      value_significance: "修 bug: 邮件发送失败",
    });
    const row = getTaskById(t.id);
    expect(row?.value_significance).toBe("修 bug: 邮件发送失败");
    expect(row?.value_kind).toBeNull();
  });

  it("value_kind 接受 5 枚举外自由字符串 (应用层 getValueKindLabel 兜底映射)", () => {
    const t = createTask({
      title: "free-string",
      prompt: "x",
      project_id: projectId,
      value_significance: "探索一下",
      value_kind: "experiment_x",
    });
    const row = getTaskById(t.id);
    expect(row?.value_kind).toBe("experiment_x");
  });

  it("显式传 null → DB 字段 NULL (与「不传」同语义, 防 JSON 字符串 \"\" 入库)", () => {
    const t = createTask({
      title: "explicit-null",
      prompt: "x",
      project_id: projectId,
      value_significance: null,
      value_kind: null,
    });
    const row = getTaskById(t.id);
    expect(row?.value_significance).toBeNull();
    expect(row?.value_kind).toBeNull();
  });
});