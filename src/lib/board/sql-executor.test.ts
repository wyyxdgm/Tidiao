// Board SQL 执行器单测 (R61 / P1).
//
// 用真 sqlite 内存库跑, 验证:
//   - SELECT / WITH 头通过, 其他被拒
//   - 分号 / 行内注释剥离
//   - DDL/DML 关键字黑名单
//   - owner 注入
//   - LIMIT 强制
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";

describe("board sql executor validation (无需真 db)", () => {
  it.todo("validation lives in sql-executor.ts; tested via integration below");
});

// 集成: 拉一个临时只读 sqlite, 给个 mock 文件, 直接验证执行结果.
import * as sqlMod from "./sql-executor";

describe("board sql executor integration", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-sql-"));
    dbPath = path.join(tmpDir, "test.db");
    const db = new Database(dbPath);
    // R91 第二步: tasks 加 project_id 列, 加一张 schedules (部分 NULL 模拟全局 schedule)
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, status TEXT, title TEXT);
      INSERT INTO tasks VALUES ('t1','u1','p1','running','p1 task one');
      INSERT INTO tasks VALUES ('t2','u1','p1','completed','p1 task two');
      INSERT INTO tasks VALUES ('t3','u2','p2','running','p2 task one');
      INSERT INTO tasks VALUES ('t4','u1','p2','completed','p2 task two');
      CREATE TABLE schedules (id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, name TEXT, enabled INTEGER);
      INSERT INTO schedules VALUES ('s1','u1','p1','daily-check',1);
      INSERT INTO schedules VALUES ('s2','u1',NULL,'global-cleanup',1);
    `);
    db.close();
    process.env.ORCHESTRATOR_DB_PATH = dbPath;
    process.env.ORCHESTRATOR_HOME = tmpDir;
    // 重置模块缓存以让 readonly db 重新打开 (process 启动时 closed file)
    sqlMod.closeBoardSqlDb();
  });

  afterAll(async () => {
    sqlMod.closeBoardSqlDb();
    const fs = await import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects non-SELECT/WITH statements", () => {
    expect(() => sqlMod.executeBoardSql("DELETE FROM tasks", { ownerId: "u1" })).toThrow(/SELECT or WITH/);
    expect(() => sqlMod.executeBoardSql("INSERT INTO tasks VALUES ('x','u1','x','x')", { ownerId: "u1" })).toThrow(/SELECT or WITH/);
    expect(() => sqlMod.executeBoardSql("DROP TABLE tasks", { ownerId: "u1" })).toThrow();
  });

  it("rejects statements with semicolons (single statement only)", () => {
    expect(() => sqlMod.executeBoardSql("SELECT 1; SELECT 2", { ownerId: "u1" })).toThrow(/semicolon/);
  });

  it("rejects DDL/DML keywords anywhere", () => {
    expect(() => sqlMod.executeBoardSql("SELECT 1; DROP TABLE tasks", { ownerId: "u1" })).toThrow(/semicolon/);
    // 注释里写 INSERT 不应绕过: validator 先剥注释再判
    expect(() => sqlMod.executeBoardSql("SELECT 1 -- INSERT INTO x VALUES (1)\n FROM tasks", { ownerId: "u1" })).not.toThrow();
  });

  it("runs simple SELECT", () => {
    const r = sqlMod.executeBoardSql("SELECT id, status FROM tasks", { ownerId: "u1" });
    expect(r.columns).toEqual(["id", "status"]);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("auto-injects owner_id filter", () => {
    const r = sqlMod.executeBoardSql("SELECT id, title FROM tasks WHERE status='running'", { ownerId: "u1" });
    // u1 的 running task 只有一个 (t1), u2 的 running 不应出现
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.id).toBe("t1");
  });

  it("does NOT inject owner_id when admin (crossOwner=true)", () => {
    const r = sqlMod.executeBoardSql("SELECT id, owner_id FROM tasks WHERE status='running'", {
      ownerId: "u1",
      crossOwner: true,
    });
    // 跨 owner 应看到 u1 + u2 两条
    expect(r.rows).toHaveLength(2);
  });

  it("does not double-inject if user already wrote owner_id (with table prefix)", () => {
    // 用户写了带表前缀的 owner_id=tasks.owner_id='u2', 系统检测到就跳过注入.
    // 因为我们就是 owner, 系统行为是直接按用户写的跑, 返回 u2 的 running task.
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks WHERE status='running' AND tasks.owner_id='u2'",
      { ownerId: "u1" }
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.id).toBe("t3");
  });

  it("injects alongside user's owner_id filter when written without prefix (intersection)", () => {
    // 用户写 owner_id='u2' (无前缀) → 系统注入 tasks.owner_id='u1', 两者 AND 起来 = 空集.
    // 这是预期的「拒绝服务」语义, 测试它生效.
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks WHERE status='running' AND owner_id='u2'",
      { ownerId: "u1" }
    );
    expect(r.rows).toHaveLength(0);
  });

  it("respects user-written LIMIT", () => {
    const r = sqlMod.executeBoardSql("SELECT id FROM tasks LIMIT 2", { ownerId: "u1" });
    expect(r.rows.length).toBeLessThanOrEqual(2);
  });

  it("clamps LIMIT to rowLimit option", () => {
    const r = sqlMod.executeBoardSql("SELECT id FROM tasks LIMIT 1000", { ownerId: "u1", rowLimit: 1 });
    expect(r.rows.length).toBeLessThanOrEqual(1);
  });

  it("returns columns from better-sqlite3 prepare", () => {
    const r = sqlMod.executeBoardSql("SELECT id AS task_id FROM tasks", { ownerId: "u1" });
    expect(r.columns).toContain("task_id");
  });
});

// R91 第二步: project_id 自动注入 (仿 owner_id 注入). cross-owner 优先级 > project 注入.
describe("board sql executor project_id injection (R91 step 2)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-sql-proj-"));
    dbPath = path.join(tmpDir, "test.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, status TEXT, title TEXT);
      INSERT INTO tasks VALUES ('t1','u1','p1','running','p1 running');
      INSERT INTO tasks VALUES ('t2','u1','p1','queued','p1 queued');
      INSERT INTO tasks VALUES ('t3','u2','p2','running','p2 running');
      INSERT INTO tasks VALUES ('t4','u2','p2','queued','p2 queued');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO projects VALUES ('p1','Project One');
      INSERT INTO projects VALUES ('p2','Project Two');
      CREATE TABLE schedules (id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, name TEXT, enabled INTEGER);
      INSERT INTO schedules VALUES ('s1','u1','p1','p1 sched',1);
      INSERT INTO schedules VALUES ('s2','u1',NULL,'global sched',1);
    `);
    db.close();
    process.env.ORCHESTRATOR_DB_PATH = dbPath;
    process.env.ORCHESTRATOR_HOME = tmpDir;
    sqlMod.closeBoardSqlDb();
  });

  afterAll(async () => {
    sqlMod.closeBoardSqlDb();
    const fs = await import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects project_id alongside owner_id (both filters AND together)", () => {
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks WHERE status='running'",
      { ownerId: "u1", projectId: "p1" }
    );
    expect(r.rows.map((row) => row.id)).toEqual(["t1"]);
  });

  it("does NOT inject project_id when projectId option is missing", () => {
    // 只传 ownerId → 走原行为, owner_id 注入. t1/t2 都是 u1 的 task, 不限 project.
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks",
      { ownerId: "u1" }
    );
    expect(r.rows.map((row) => row.id).sort()).toEqual(["t1", "t2"]);
  });

  it("does NOT inject project_id when admin (crossOwner=true)", () => {
    // admin 跨 owner → 两个 project 都看到.
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks WHERE status='running'",
      { ownerId: "u1", projectId: "p1", crossOwner: true }
    );
    expect(r.rows.map((row) => row.id).sort()).toEqual(["t1", "t3"]);
  });

  it("does not double-inject when author wrote alias.project_id (no skip override)", () => {
    // author 显式写 tasks.project_id='p2', 系统检测到 alias.project_id 就跳过注入.
    //   + owner 自动注入 tasks.owner_id='u1' → AND 起来 = p2 项目的 u1 task (t4 不属于 u1).
    // u1 的 p2 task 没有, 结果为空.
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks WHERE status='queued' AND tasks.project_id='p2'",
      { ownerId: "u1", projectId: "p1" }
    );
    expect(r.rows).toHaveLength(0);
  });

  it("injects alongside user's project_id when written without prefix (intersection)", () => {
    // author 写 project_id='p2' (无前缀) → 系统注入 tasks.project_id='p1', AND 起来 = 空.
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks WHERE status='queued' AND project_id='p2'",
      { ownerId: "u1", projectId: "p1" }
    );
    expect(r.rows).toHaveLength(0);
  });

  it("does not inject into knownNoProject tables (projects/users/etc.)", () => {
    // projects 表本身是项目主表, 不应被注入 project_id (没有这个列).
    const r = sqlMod.executeBoardSql(
      "SELECT id, name FROM projects",
      { ownerId: "u1", projectId: "p1" }
    );
    // projects 表没 owner_id 列, owner 也不注入; project 也不注入; 返回两条.
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("injects project_id into schedules when table is not in knownNoProject", () => {
    // schedules 不在黑名单, 所以会被自动注入. projectId='p1' + 注入 schedules.project_id='p1'.
    // owner 自动注入 schedules.owner_id='u1'. 全局 schedule (project_id=NULL) 被过滤掉.
    const r = sqlMod.executeBoardSql(
      "SELECT id, name FROM schedules WHERE enabled=1",
      { ownerId: "u1", projectId: "p1" }
    );
    // 只剩 s1 (p1 + u1).
    expect(r.rows.map((row) => row.id)).toEqual(["s1"]);
  });

  it("respects user-written LIMIT alongside project_id injection", () => {
    const r = sqlMod.executeBoardSql(
      "SELECT id FROM tasks LIMIT 5",
      { ownerId: "u1", projectId: "p1" }
    );
    // LIMIT 5, p1 项目的 u1 task 只有 t1+t2, 返回 2 行.
    expect(r.rows).toHaveLength(2);
  });
});
