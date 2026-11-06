// Tests for listTasks({search}) filter (飞书 R180 顶栏全局任务搜索).
//
// 覆盖:
//   1) 关键词命中 title 子串 (大小写不敏感)
//   2) 关键词命中 task id 前缀 (用户粘半段 UUID 也能搜到)
//   3) 关键词命中 status / tags
//   4) 不命中关键词的 task 被排除; 空/纯空白关键词 = 不过滤
//   5) ownerId 隔离: 别的 owner 的 task 搜不到
//   6) LIKE 通配符 %/_ 转义: 标题含字面 % 时不被当通配符放大命中面
//
// 模式与 tasks-favorite.test.ts 同款: 真 SQLite 临时库 + 直接调 lib 层.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import { createProject } from "./projects";
import { createVersion } from "./versions";
import { createTask, listTasks } from "./tasks";

let tmpDir: string;

function makeUser(prefix: string): string {
  const id = `${prefix}-${uuidv4()}`;
  getDb()
    .prepare(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
    )
    .run(id, `${prefix}-${id}@example.com`, "test-hash", "user");
  return id;
}

function makeTask(
  ownerId: string,
  title: string,
  tags?: string[]
): { id: string; title: string } {
  const project = createProject({
    name: `p-${uuidv4().slice(0, 8)}`,
    description: "test",
    ownerId,
  });
  const task = createTask({
    project_id: project.id,
    title,
    prompt: "p",
    type: "dev",
    owner_id: ownerId,
    tags,
  } as any);
  return { id: task.id, title };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-task-search-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("listTasks({search}) — R180 顶栏全局搜索", () => {
  it("title 子串命中 (大小写不敏感)", () => {
    const owner = makeUser("o1");
    const hit = makeTask(owner, "修复登录页 404");
    makeTask(owner, "部署 nginx vhost");
    const rows = listTasks({ ownerId: owner, search: "登录" });
    expect(rows.map((r) => r.id)).toEqual([hit.id]);
    // 英文大小写不敏感 (SQLite LIKE 默认 ASCII case-insensitive)
    const rows2 = listTasks({ ownerId: owner, search: "NGINX" });
    expect(rows2.length).toBe(1);
    expect(rows2[0].title).toBe("部署 nginx vhost");
  });

  it("task id 前缀命中 (粘半段 UUID 可搜)", () => {
    const owner = makeUser("o2");
    const t = makeTask(owner, "随便什么标题");
    const prefix = t.id.slice(0, 8);
    const rows = listTasks({ ownerId: owner, search: prefix });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(t.id);
  });

  it("status / tags 命中", () => {
    const owner = makeUser("o3");
    const tagged = makeTask(owner, "任务一", ["infra", "pulu"]);
    makeTask(owner, "任务二");
    const byTag = listTasks({ ownerId: owner, search: "infra" });
    expect(byTag.map((r) => r.id)).toEqual([tagged.id]);
    const byStatus = listTasks({ ownerId: owner, search: "pending" });
    expect(byStatus.length).toBe(2); // 新建默认 pending, 两条都命中
  });

  it("空/纯空白关键词 = 不过滤, 返回 owner 全量", () => {
    const owner = makeUser("o4");
    makeTask(owner, "a");
    makeTask(owner, "b");
    expect(listTasks({ ownerId: owner, search: "" }).length).toBe(2);
    expect(listTasks({ ownerId: owner, search: "   " }).length).toBe(2);
    expect(listTasks({ ownerId: owner }).length).toBe(2);
  });

  it("ownerId 隔离: 搜不到别人的 task", () => {
    const ownerA = makeUser("oa");
    const ownerB = makeUser("ob");
    makeTask(ownerA, "独占关键词XYZ");
    const rows = listTasks({ ownerId: ownerB, search: "独占关键词XYZ" });
    expect(rows.length).toBe(0);
  });

  it("LIKE 通配符 % _ 按字面量处理 (ESCAPE 转义)", () => {
    const owner = makeUser("o6");
    makeTask(owner, "100%覆盖率"); // 字面 %
    makeTask(owner, "普通任务甲");
    // 搜索字面 "%" 只命中标题真含 % 的那条, 不放大成通配符匹配所有
    const rows = listTasks({ ownerId: owner, search: "100%" });
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("100%覆盖率");
    // 搜索 "_" 不命中任何标题 (没有字面下划线)
    expect(listTasks({ ownerId: owner, search: "_" }).length).toBe(0);
  });

  // 飞书 R209: 搜索下拉展示任务所属项目 / 版本 — search 场景 LEFT JOIN 取真名.
  it("search 场景返回 project_name / version_name (R209)", () => {
    const owner = makeUser("o7");
    const project = createProject({
      name: "编排平台",
      description: "test",
      ownerId: owner,
    });
    const version = createVersion({ project_id: project.id, name: "v2.0" });
    const task = createTask({
      project_id: project.id,
      version_id: version.id,
      title: "搜索展示项目版本",
      prompt: "p",
      type: "dev",
      owner_id: owner,
    } as any);

    const rows = listTasks({ ownerId: owner, search: "搜索展示项目版本" });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(task.id);
    // 额外字段 (不在 Task 类型上, 但 search 场景运行时带上)
    const hit = rows[0] as unknown as {
      project_name?: string;
      version_name?: string;
    };
    expect(hit.project_name).toBe("编排平台");
    expect(hit.version_name).toBe("v2.0");
  });

  it("非 search 场景不带 project_name (保持 SELECT * 原样)", () => {
    const owner = makeUser("o8");
    const task = makeTask(owner, "无搜索");
    const rows = listTasks({ ownerId: owner });
    const hit = rows.find((r) => r.id === task.id) as unknown as {
      project_name?: string;
    };
    expect(hit).toBeTruthy();
    expect(hit.project_name).toBeUndefined();
  });
});
