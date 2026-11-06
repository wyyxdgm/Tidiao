// R113 (2026-09-07) GET /api/tasks/[id]/commits 路由层测试.
//
// 关注点:
//   - 未登录 -> 401
//   - task 不存在 -> 404
//   - 没写 marker 的 task -> entries=[] (严守"不主动跑 git"原则)
//   - 多 task commits 合并 + 按 created_at DESC 排序
//   - 派生 task 的 commits 也合并进来 (CTE forked_from_session_id)
//   - 跨用户访问 -> 404 (owner 隔离, 同 checkpoints API)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET } from "./route";
import { upsertTaskCommit } from "@/lib/db/task-commits";

let tmpDir: string;
let userAId: string;
let userBId: string;
let projectAId: string;
let taskAId: string;
let taskBId: string;

function makeReq(taskId: string, userId: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers["x-user-id"] = userId;
  return [
    new NextRequest(`http://localhost/api/tasks/${taskId}/commits`, { headers }),
    { params: Promise.resolve({ id: taskId }) },
  ];
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-commits-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  userAId = uuidv4();
  userBId = uuidv4();
  for (const [id, role] of [
    [userAId, "user"],
    [userBId, "user"],
  ] as const) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", role);
  }

  const { createProject } = await import("@/lib/db/projects");
  projectAId = createProject({ name: "commits-test", ownerId: userAId }).id;

  const { createTask } = await import("@/lib/db/tasks");
  const taskA = createTask({
    title: "task-a",
    prompt: "test a",
    project_id: projectAId,
    cwd: tmpDir,
  });
  taskAId = taskA.id;

  const taskB = createTask({
    title: "task-b",
    prompt: "test b",
    project_id: projectAId,
    cwd: tmpDir,
  });
  taskBId = taskB.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/tasks/[id]/commits (R113)", () => {
  it("未登录 -> 401", async () => {
    const res = await GET(...makeReq(taskAId, null));
    expect(res.status).toBe(401);
  });

  it("task 不存在 -> 404", async () => {
    const res = await GET(...makeReq(uuidv4(), userAId));
    expect(res.status).toBe(404);
  });

  it("别人的 task -> 404 (owner 隔离)", async () => {
    const res = await GET(...makeReq(taskAId, userBId));
    expect(res.status).toBe(404);
  });

  it("空 commits -> entries=[] (严守不主动跑 git)", async () => {
    const res = await GET(...makeReq(taskAId, userAId));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.root_task_id).toBe(taskAId);
    expect(data.entries).toEqual([]);
    // descendant_tasks includes the root task itself (depth=1).
    expect(data.descendant_tasks.length).toBe(1);
    expect(data.descendant_tasks[0].task_id).toBe(taskAId);
    expect(data.depth).toBe(1);
  });

  it("单个 task 多 commit: 按 created_at DESC 返回", async () => {
    upsertTaskCommit({ task_id: taskAId, commit_id: "1111111", desc: "oldest" });
    await new Promise((r) => setTimeout(r, 1100));
    upsertTaskCommit({ task_id: taskAId, commit_id: "2222222", desc: "middle" });
    await new Promise((r) => setTimeout(r, 1100));
    upsertTaskCommit({ task_id: taskAId, commit_id: "3333333", desc: "newest" });

    const res = await GET(...makeReq(taskAId, userAId));
    const data = await res.json();
    expect(data.entries.map((e: { commit_id: string }) => e.commit_id)).toEqual([
      "3333333",
      "2222222",
      "1111111",
    ]);
    expect(data.entries[0].desc).toBe("newest");
  });

  it("commits 含 files 数组 (DB 解析 files_json)", async () => {
    upsertTaskCommit({
      task_id: taskAId,
      commit_id: "abc1234",
      desc: "with files",
      files: ["src/foo.ts", "src/bar.ts"],
    });
    const res = await GET(...makeReq(taskAId, userAId));
    const data = await res.json();
    expect(data.entries[0].files).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("派生 task (fork) 的 commits 合并到 root 视图", async () => {
    // 模拟 fork: 创建 taskB 然后把 taskB.session_id 写到 taskB.forked_from_session_id
    // 这里简化: 直接让 taskA 有 1 commit, taskB 有 1 commit (没真实 fork 关系),
    // 然后单独构造一个 forked 关系验证 CTE.
    upsertTaskCommit({ task_id: taskAId, commit_id: "aaaa111", desc: "from A" });
    upsertTaskCommit({ task_id: taskBId, commit_id: "bbbb222", desc: "from B (no fork link)" });

    // 先验证没 fork 关系时 — taskA 视图只看到自己的 commits
    let res = await GET(...makeReq(taskAId, userAId));
    let data = await res.json();
    expect(data.entries.map((e: { commit_id: string }) => e.commit_id)).toEqual([
      "aaaa111",
    ]);

    // 现在构造 fork 关系: 让 taskB.forked_from_session_id = taskA.session_id
    const db = getDb();
    db.prepare("UPDATE tasks SET session_id = ? WHERE id = ?").run(
      "session-A",
      taskAId,
    );
    db.prepare("UPDATE tasks SET session_id = ?, forked_from_session_id = ? WHERE id = ?").run(
      "session-B",
      "session-A",
      taskBId,
    );

    res = await GET(...makeReq(taskAId, userAId));
    data = await res.json();
    expect(data.depth).toBe(2); // A + B
    expect(data.descendant_tasks.length).toBe(2);
    // Both commits present, B (more recent) comes first because
    // getTaskCommitsByTaskId orders by created_at DESC and B was inserted later.
    const ids = data.entries.map((e: { commit_id: string }) => e.commit_id);
    expect(ids).toContain("aaaa111");
    expect(ids).toContain("bbbb222");
  });
});
