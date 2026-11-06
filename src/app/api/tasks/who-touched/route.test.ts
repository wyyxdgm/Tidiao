// GET /api/tasks/who-touched 路由层测试.
//
// 关注点:
//   - 未登录 -> 401
//   - 缺 file/project_id -> 400
//   - lookback/limit 越界 -> 400
//   - project 不存在 / 跨 owner -> 404 (不暴露存在性)
//   - admin role bypass owner 隔离
//   - 命中真 git diff 出的 task
//   - 没命中的文件 -> results=[]
//   - 软删 / failed / reviewing task 不进结果 (验证 C: SQL 硬约束)
//   - cwd 不可访问 / 非 git 仓 -> graceful fallback (不抛, results 不含)
//   - LRU 缓存: 重复调用跨测试不污染 (process 共享, afterEach 清)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET } from "./route";
import { _clearTaskHistoryCacheForTests } from "@/lib/git/task-history";

let tmpDir: string;
let userAId: string;
let userBId: string;
let adminId: string;
let projectAId: string;

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/tasks/who-touched");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { headers });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commitFile(cwd: string, fileRelPath: string, content: string): void {
  const abs = path.join(cwd, fileRelPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(cwd, ["add", fileRelPath]);
  git(cwd, ["commit", "-m", `add ${fileRelPath}`]);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-whotouched-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  // 三个用户: userA (project 拥有者), userB (跨 owner 测试), admin (admin bypass)
  userAId = uuidv4();
  userBId = uuidv4();
  adminId = uuidv4();
  for (const [id, role] of [
    [userAId, "user"],
    [userBId, "user"],
    [adminId, "admin"],
  ] as const) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", role);
  }

  const { createProject } = await import("@/lib/db/projects");
  projectAId = createProject({ name: "whotouched-test", ownerId: userAId }).id;

  // 真 git 仓 for task.cwd
  git(tmpDir, ["init", "-q", "-b", "main"]);
  git(tmpDir, ["config", "user.email", "test@example.com"]);
  git(tmpDir, ["config", "user.name", "Test User"]);
  commitFile(tmpDir, "seed.ts", "// seed");

  _clearTaskHistoryCacheForTests();
});

afterEach(() => {
  closeDb();
  _clearTaskHistoryCacheForTests();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/tasks/who-touched", () => {
  it("未登录 -> 401", async () => {
    const res = await GET(makeReq({ file: "a.ts", project_id: projectAId }));
    expect(res.status).toBe(401);
  });

  it("缺 file -> 400", async () => {
    const res = await GET(makeReq({ project_id: projectAId }, { "x-user-id": userAId }));
    expect(res.status).toBe(400);
  });

  it("缺 project_id -> 400", async () => {
    const res = await GET(makeReq({ file: "a.ts" }, { "x-user-id": userAId }));
    expect(res.status).toBe(400);
  });

  it("lookback 越界 (0) -> 400", async () => {
    const res = await GET(
      makeReq(
        { file: "a.ts", project_id: projectAId, lookback: "0" },
        { "x-user-id": userAId },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("lookback 越界 (366) -> 400", async () => {
    const res = await GET(
      makeReq(
        { file: "a.ts", project_id: projectAId, lookback: "366" },
        { "x-user-id": userAId },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("limit 越界 (0) -> 400", async () => {
    const res = await GET(
      makeReq(
        { file: "a.ts", project_id: projectAId, limit: "0" },
        { "x-user-id": userAId },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("limit 越界 (51) -> 400", async () => {
    const res = await GET(
      makeReq(
        { file: "a.ts", project_id: projectAId, limit: "51" },
        { "x-user-id": userAId },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("project 不存在 -> 404", async () => {
    const res = await GET(
      makeReq({ file: "a.ts", project_id: uuidv4() }, { "x-user-id": userAId }),
    );
    expect(res.status).toBe(404);
  });

  it("跨 owner 访问 project -> 404 (owner 隔离)", async () => {
    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userBId }),
    );
    expect(res.status).toBe(404);
  });

  it("admin role bypass owner 隔离: 看到 project", async () => {
    const res = await GET(
      makeReq(
        { file: "a.ts", project_id: projectAId },
        { "x-user-id": adminId, "x-user-role": "admin" },
      ),
    );
    // 200 不是 404 (project 看到了), results=[]
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project_id).toBe(projectAId);
    expect(data.results).toEqual([]);
  });

  it("命中真 git diff: 改过 a.ts 的 completed task 出现在 results", async () => {
    // 准备: seed + 改 a.ts + 拿到 head, 建 task 标 completed
    commitFile(tmpDir, "a.ts", "v1");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const db = getDb();
    const taskId = uuidv4();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      taskId,
      "touched-a",
      "p",
      userAId,
      projectAId,
      tmpDir,
      base,
      head,
    );

    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results.length).toBe(1);
    expect(data.results[0].task_id).toBe(taskId);
    expect(data.results[0].title).toBe("touched-a");
    expect(data.results[0].base_commit).toBe(base);
    expect(data.results[0].head_commit).toBe(head);
  });

  it("未命中: task 改过 b.ts 但查 a.ts -> results=[]", async () => {
    commitFile(tmpDir, "a.ts", "v1");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "b.ts", "v1");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), "touched-b", "p", userAId, projectAId, tmpDir, base, head);

    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
  });

  it("软删 task 不进结果 (验证 C: deleted_at IS NULL 是硬约束)", async () => {
    commitFile(tmpDir, "a.ts", "v1");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at, deleted_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(uuidv4(), "soft-deleted", "p", userAId, projectAId, tmpDir, base, head);

    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }),
    );
    const data = await res.json();
    expect(data.results).toEqual([]);
    expect(data.candidate_count).toBe(0);
  });

  it("failed / reviewing task 不进结果 (验证 C: status='completed' 硬约束)", async () => {
    commitFile(tmpDir, "a.ts", "v1");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const db = getDb();
    for (const status of ["failed", "reviewing", "pending"]) {
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(uuidv4(), `${status}-touched-a`, "p", status, userAId, projectAId, tmpDir, base, head);
    }

    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }),
    );
    const data = await res.json();
    expect(data.results).toEqual([]);
    expect(data.candidate_count).toBe(0);
  });

  it("cwd 不可访问: graceful fallback, 不抛 5xx, task 不进结果", async () => {
    commitFile(tmpDir, "a.ts", "v1");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const db = getDb();
    const deadPath = "/this/path/does/not/exist/orch-whotouched-test";
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), "dead-cwd", "p", userAId, projectAId, deadPath, base, head);

    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    // cwd 不可达 → taskTouchedFile 返 false → 不进 results, 不抛 5xx
    expect(data.results).toEqual([]);
  });

  it("limit cap: 3 个命中 task, limit=2 只返 2 条", async () => {
    // 1 个 seed commit 拿到 base
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    // 改 3 次 a.ts (每次 git commit), 每次拿 head 建一个 completed task
    const db = getDb();
    for (let i = 0; i < 3; i++) {
      commitFile(tmpDir, "a.ts", `v${i + 1}`);
      const head = git(tmpDir, ["rev-parse", "HEAD"]);
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, datetime('now', ?))`,
      ).run(uuidv4(), `touch-${i}`, "p", userAId, projectAId, tmpDir, base, head, `-${i} minutes`);
      // 用 minutes offset 保证 completed_at 顺序倒序 (touch-0 最新, touch-2 最旧)
    }

    const res = await GET(
      makeReq(
        { file: "a.ts", project_id: projectAId, limit: "2" },
        { "x-user-id": userAId },
      ),
    );
    const data = await res.json();
    expect(data.candidate_count).toBe(3);
    expect(data.results.length).toBe(2);
    // 倒序: touch-0 (0 minutes ago) 优先
    expect(data.results[0].title).toBe("touch-0");
    expect(data.results[1].title).toBe("touch-1");
  });

  it("base_commit == head_commit 的 task 不进候选 (验证: 没 diff)", async () => {
    const sha = git(tmpDir, ["rev-parse", "HEAD"]);
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cwd, base_commit, head_commit, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), "no-diff", "p", userAId, projectAId, tmpDir, sha, sha);

    const res = await GET(
      makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }),
    );
    const data = await res.json();
    expect(data.candidate_count).toBe(0);
    expect(data.results).toEqual([]);
  });

  it("instrumentation: console.info 输出 task_history_query JSON", async () => {
    const lines: string[] = [];
    const orig = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await GET(makeReq({ file: "a.ts", project_id: projectAId }, { "x-user-id": userAId }));
    } finally {
      console.info = orig;
    }
    const evtLine = lines.find((l) => l.includes('"evt":"task_history_query"'));
    expect(evtLine).toBeTruthy();
    const data = JSON.parse(evtLine!);
    expect(data.file).toBe("a.ts");
    expect(data.project_id).toBe(projectAId);
    expect(data.caller_role).toBe("user");
    expect(typeof data.elapsed_ms).toBe("number");
  });
});