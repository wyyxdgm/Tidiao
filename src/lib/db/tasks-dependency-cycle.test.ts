// DAG P1 (2026-09-05) — depends_on 环检测 (createTask + replaceTaskDependencies).
//
// 覆盖 6 条场景:
//   1) 自环: X depends_on [X] → DEPENDENCY_CYCLE
//   2) 2-node 环: 已存在 X→A, 让 A→[X] 形成 X→A→X → DEPENDENCY_CYCLE
//   3) 3-node 环: A→B→C, C 试图加依赖 [A] 形成 A→B→C→A → DEPENDENCY_CYCLE
//   4) 合法 DAG: A→B, A→C, B→D, C→D 都建得进去, 后续可继续加 E→D
//   5) 空 deps / null → null (跳过检查)
//   6) replaceTaskDependencies 路径: 撞环抛 TaskLocationError + 旧 deps 不动
//
// 不变量:
//   - 撞环时 DB 无脏行 (task_dependencies 行不写).
//   - 撞环时 TaskLocationError.code === "DEPENDENCY_CYCLE".
//   - 合法依赖正常写入, 后续 detectDependencyCycle / replaceTaskDependencies 不报错.
//   - 复杂图 (>=4 节点 + 多条边) 检测正确, visited Set 防重复扫.
//
// 写法: 用最简化的 INSERT INTO tasks + task_dependencies 直接造图 (不依赖被
//   测代码自身). createTask / replaceTaskDependencies 的入口集成测试单独两条
//   (场景 4 + 场景 6), 其余场景直接调 detectDependencyCycle (纯函数).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import {
  createTask,
  replaceTaskDependencies,
  detectDependencyCycle,
  TaskLocationError,
} from "./tasks";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dep-cycle-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs migrations

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "dep-cycle-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 工具: 直接往 tasks 表插一行 (不依赖 createTask). createTask 也会调
//   detectDependencyCycle, 所以要测纯函数必须绕开.
function insertTaskBare(id: string, title: string): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, prompt, project_id, owner_id, auto_approve)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(id, title, "", title, projectId, ownerId);
}

// 工具: 直接往 task_dependencies 表插一行 (不依赖 replaceTaskDependencies).
function insertDepBare(fromId: string, toId: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
    )
    .run(fromId, toId);
}

describe("detectDependencyCycle (pure function)", () => {
  it("1) 自环: X depends_on [X] 直接返回 X (不查表)", () => {
    const xId = uuidv4();
    expect(detectDependencyCycle(xId, [xId])).toBe(xId);
  });

  it("2) 2-node 环: X→A 已存, 让 A→[X] 形成 X→A→X", () => {
    const xId = uuidv4();
    const aId = uuidv4();
    insertTaskBare(xId, "X");
    insertTaskBare(aId, "A");
    insertDepBare(xId, aId); // X 依赖 A
    // A 试图依赖 X — 走 detect: A→X? BFS from X: X.deps=[A] → 入队 A → cur=A !== X. OK 不会被这条击穿.
    //    但反过来从 A 的新 dep X 出发: X.deps=[A] → 入队 A → cur=A === taskId(A) → 撞环 via X.
    expect(detectDependencyCycle(aId, [xId])).toBe(xId);
  });

  it("3) 3-node 环: A→B→C 已存, C 试图加依赖 [A] 形成 A→B→C→A", () => {
    const aId = uuidv4();
    const bId = uuidv4();
    const cId = uuidv4();
    insertTaskBare(aId, "A");
    insertTaskBare(bId, "B");
    insertTaskBare(cId, "C");
    insertDepBare(bId, aId); // B 依赖 A
    insertDepBare(cId, bId); // C 依赖 B
    // C 试图加依赖 [A]: C 现有 dep=[B]; 新 dep=A 形成 C→A→B→C? A.deps=[]. 不会.
    //    但仔细想: 想要的是 A→B→C→A 环. 这意味着 C→A. 此时 C.deps=[B, A],
    //    B.deps=[A], A.deps=[]. 无环? 等等, 我哪里错了?
    // 重新画: A→B 是 B 依赖 A. B→C 是 C 依赖 B. A→B→C 是链.
    //    要 A→B→C→A 环, 需要 A 依赖 C. 让我换 taskId:
    //    detectDependencyCycle(taskId=A, newDeps=[C]):
    //      - 自环? 否
    //      - BFS from C: C.deps=[B] → 入队 B; B.deps=[A] → 入队 A → cur=A === taskId → return C
    expect(detectDependencyCycle(aId, [cId])).toBe(cId);
  });

  it("4) 合法 DAG: A→B, A→C, B→D, C→D 都建得进去, 后续 E→D 合法", () => {
    const aId = uuidv4();
    const bId = uuidv4();
    const cId = uuidv4();
    const dId = uuidv4();
    insertTaskBare(aId, "A");
    insertTaskBare(bId, "B");
    insertTaskBare(cId, "C");
    insertTaskBare(dId, "D");
    insertDepBare(bId, aId);
    insertDepBare(cId, aId);
    insertDepBare(dId, bId);
    insertDepBare(dId, cId);
    // 4 节点链/汇. E 想依赖 D:
    const eId = uuidv4();
    expect(detectDependencyCycle(eId, [dId])).toBeNull();
    // D 想再加依赖 E 也合法 (此时 D→E, 不形成环, E→D 还没建):
    expect(detectDependencyCycle(dId, [eId])).toBeNull();
  });

  it("5) 空 deps → null (跳过检查)", () => {
    const xId = uuidv4();
    expect(detectDependencyCycle(xId, [])).toBeNull();
  });

  it("6) replaceTaskDependencies: PATCH 路径撞环抛 TaskLocationError + 旧 deps 不动", () => {
    const xId = uuidv4();
    const aId = uuidv4();
    insertTaskBare(xId, "X");
    insertTaskBare(aId, "A");
    insertDepBare(xId, aId); // X 依赖 A
    // 现在试图让 A 依赖 X (会形成 X→A→X 环).
    expect(() => replaceTaskDependencies(aId, [xId])).toThrow(TaskLocationError);
    try {
      replaceTaskDependencies(aId, [xId]);
    } catch (err) {
      expect((err as TaskLocationError).code).toBe("DEPENDENCY_CYCLE");
      expect((err as Error).message).toMatch(/Dependency cycle detected via/);
    }
    // 旧 deps 不动: A 此时还没有任何 dep, DB 里 A 不在 task_dependencies 表里.
    const aRows = getDb()
      .prepare("SELECT * FROM task_dependencies WHERE task_id = ?")
      .all(aId);
    expect(aRows).toEqual([]);
    // X 的原 deps 也未受影响 (replaceTaskDependencies 的事务整体跑都没跑).
    const xRows = getDb()
      .prepare("SELECT * FROM task_dependencies WHERE task_id = ?")
      .all(xId);
    expect(xRows.length).toBe(1);
    expect((xRows[0] as { depends_on_task_id: string }).depends_on_task_id).toBe(aId);
  });
});

describe("createTask 入口集成", () => {
  // 理论上 createTask  一次调用内不可能形成环 — 新 task 的 id 由 createTask 内部
  // 生成, 调用方不可能预知并把它放进 dependsOn. 但要确认 createTask 不会把
  // detectDependencyCycle 跳过 (即不检测). 构造合法路径: 已有 X→A, 现在建新
  // task B 依赖 X, 应合法; 同时测一条 deps 自包含重复的边界.
  it("createTask 带 dependsOn 时走 detectDependencyCycle: 合法依赖 + 重复 dep id 都通过", () => {
    const xId = uuidv4();
    const aId = uuidv4();
    insertTaskBare(xId, "X");
    insertTaskBare(aId, "A");
    insertDepBare(xId, aId); // X 依赖 A

    // 合法: 新 task B 依赖 X (链路 B→X→A, 无环)
    // createTask 从 project 继承 owner_id (tasks.ts:169), TaskDefinition 没这个字段.
    const b = createTask({
      title: "B",
      prompt: "b",
      project_id: projectId,
      dependsOn: [xId],
    });
    expect(b.depends_on).toBe(JSON.stringify([xId]));

    // 边界: 重复 dep id (X 出现两次) — INSERT OR IGNORE 会去重, createTask 应不报错
    const c = createTask({
      title: "C",
      prompt: "c",
      project_id: projectId,
      dependsOn: [xId, xId, aId], // X 重复, A 也存在, 链路 C→X→A, 无环
    });
    expect(c.depends_on).toBe(JSON.stringify([xId, xId, aId]));
  });
});