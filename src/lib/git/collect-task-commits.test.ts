// R158 (damo 2026-09-26): collect-task-commits tests. 用真 git fixture
// (tmpdir init), 覆盖: 正常区间 / 空区间 / 非 git 仓 / 无效 hash / 不可用 cwd /
// desc 截断 / base==head 短路 / --no-merges 跳过 merge commit.
//
// R228 (2026-10-09): 追加 --since 时间窗口 + backfill 先到先得去重.
//
// 关注点:
//   - 不 mock execFileSync: 真 git 行为最权威, 跨版本回归靠它.
//   - 每个 test 一个 fresh tmpdir, afterEach 清理.
//   - 纯 git 测试不连 DB; backfill 先到先得测试走 ORCHESTRATOR_DB_PATH 临时库
//     (模式与 src/lib/db/task-commits.test.ts 一致).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { collectCommitsInRange } from "./collect-task-commits";

let tmpDir: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commitFile(cwd: string, fileRelPath: string, content: string, msg: string): void {
  const abs = path.join(cwd, fileRelPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(cwd, ["add", fileRelPath]);
  git(cwd, ["commit", "-m", msg]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-collect-commits-"));
  git(tmpDir, ["init", "-q", "-b", "main"]);
  git(tmpDir, ["config", "user.email", "test@example.com"]);
  git(tmpDir, ["config", "user.name", "Test User"]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectCommitsInRange", () => {
  it("命中: 区间内每个 commit 都返回, 含全 hash + subject 作 desc", () => {
    commitFile(tmpDir, "a.ts", "v1", "first commit");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", "second");
    commitFile(tmpDir, "b.ts", "new", "third");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const commits = collectCommitsInRange(tmpDir, base, head);
    expect(commits).toHaveLength(2);
    // git log 默认逆序 (newest first). commits[0] = 后写的 third,
    // commits[1] = 先写的 second. (与 DB 层 getTaskCommitsByTaskId ORDER BY
    // created_at DESC 一致 —— 都是「最新在前」心智模型.)
    expect(commits[0].desc).toBe("third");
    expect(commits[1].desc).toBe("second");
    // 全 hash (40 字符 hex), 不截断.
    expect(commits[0].commit_id).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[1].commit_id).toMatch(/^[0-9a-f]{40}$/);
    // 文件清单永远是空数组 (设计权衡: 见 collect-task-commits.ts 文件头注释).
    expect(commits[0].files).toEqual([]);
    expect(commits[1].files).toEqual([]);
  });

  it("短路: base == head → 返回空数组, 不调 git log", () => {
    commitFile(tmpDir, "a.ts", "v1", "only commit");
    const hash = git(tmpDir, ["rev-parse", "HEAD"]);
    expect(collectCommitsInRange(tmpDir, hash, hash)).toEqual([]);
  });

  it("短路: 空字符串 cwd/base/head → 返回空数组", () => {
    expect(collectCommitsInRange("", "abc", "def")).toEqual([]);
    expect(collectCommitsInRange("/tmp", "", "def")).toEqual([]);
    expect(collectCommitsInRange("/tmp", "abc", "")).toEqual([]);
  });

  it("非 git 仓: cwd 存在但不是 git repo → 返回空数组, 不抛", () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-plain-"));
    try {
      expect(collectCommitsInRange(plainDir, "abc", "def")).toEqual([]);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("cwd 不存在: → 返回空数组, 不抛", () => {
    expect(collectCommitsInRange("/no/such/path/12345", "abc", "def")).toEqual([]);
  });

  it("desc 截断到 512 字符 (与 marker desc cap 一致)", () => {
    const longMsg = "x".repeat(800);
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", longMsg);
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const commits = collectCommitsInRange(tmpDir, base, head);
    expect(commits).toHaveLength(1);
    expect(commits[0].desc?.length).toBe(512);
  });

  it("merge commit 被跳过 (--no-merges)", () => {
    // 1. 主线 commit —— 显式记 hash 当 base (不要从 git log 推, 因为 merge 后
    //   `git log` 走 first-parent 链, feature commit 不在默认输出里).
    commitFile(tmpDir, "a.ts", "v1", "main first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    // 2. 建分支 + 分支 commit
    git(tmpDir, ["checkout", "-q", "-b", "feature"]);
    commitFile(tmpDir, "b.ts", "feat", "feature commit");
    // 3. 切回主线 + merge feature (merge commit!)
    git(tmpDir, ["checkout", "-q", "main"]);
    git(tmpDir, ["merge", "--no-ff", "-m", "merge feature into main", "feature"]);
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    // 区间 base..head 含 [feature commit, merge commit]. --no-merges 跳过
    // merge commit, 只返 feature commit.
    const commits = collectCommitsInRange(tmpDir, base, head);
    expect(commits).toHaveLength(1);
    expect(commits[0].desc).toBe("feature commit");
  });

  it("区间内 0 commit (head 与 base 紧邻, 中间无 commit) → 返回空", () => {
    // HEAD 自身就是 base, base..HEAD 是空区间.
    commitFile(tmpDir, "a.ts", "v1", "only");
    const hash = git(tmpDir, ["rev-parse", "HEAD"]);
    // head 比 base 多走一步 (空操作): 重新 reset 一下制造 base == head
    git(tmpDir, ["reset", "--hard", hash]);
    expect(collectCommitsInRange(tmpDir, hash, git(tmpDir, ["rev-parse", "HEAD"]))).toEqual([]);
  });

  // R228: --since 时间窗口 —— 共享仓库多任务并发时, base..head 区间里混着
  // 其他 task 的 commit; since 把收集窗口压回本 task 会话期间.
  it("R228 --since: 只收时间窗口之后的 commit, 窗口前的跳过", () => {
    const mk = (file: string, msg: string, date: string) => {
      const abs = path.join(tmpDir, file);
      fs.writeFileSync(abs, `${msg}\n`);
      git(tmpDir, ["add", file]);
      execFileSync("git", ["commit", "-m", msg], {
        cwd: tmpDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    };
    mk("init.txt", "init commit", "2026-09-30T08:00:00 +0800");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    mk("early.txt", "early commit", "2026-10-01T08:00:00 +0800");
    mk("late.txt", "late commit", "2026-10-09T06:00:00 +0800");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    // 无 since: 区间里 2 条都收 (旧行为)
    expect(collectCommitsInRange(tmpDir, base, head)).toHaveLength(2);
    // since 窗口从 10-05 起: early 被过滤, 只剩 late
    const filtered = collectCommitsInRange(tmpDir, base, head, 5000, {
      since: "2026-10-05T00:00:00+08:00",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].desc).toBe("late commit");
  });
});

// R228: backfillTaskCommits 先到先得 —— 同一 commit 已被其他 task 认领时跳过.
// 需要 DB (临时库 + migrations), 模式与 src/lib/db/task-commits.test.ts 一致.
describe("backfillTaskCommits 先到先得 (R228)", () => {
  let tmpDir: string;
  let testUserId: string;
  let testProjectId: string;
  let taskAId: string;
  let taskBId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-backfill-228-"));
    // git fixture: 一条 base + 一条 head
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: tmpDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "v1");
    run(["add", "a.ts"]);
    run(["commit", "-m", "base commit"]);
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "v2");
    run(["add", "b.ts"]);
    run(["commit", "-m", "shared commit"]);

    // 临时库 + migrations + FK 种子
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    const { getDb, closeDb } = await import("@/lib/db/index");
    closeDb();
    getDb();
    testUserId = crypto.randomUUID();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(testUserId, "backfill-228@example.com", "x", "admin");
    const { createProject } = await import("@/lib/db/projects");
    testProjectId = createProject({ name: "backfill-228", ownerId: testUserId }).id;
    const { createTask } = await import("@/lib/db/tasks");
    taskAId = createTask({
      title: "task-a",
      prompt: "test",
      project_id: testProjectId,
      cwd: tmpDir,
    }).id;
    taskBId = createTask({
      title: "task-b",
      prompt: "test",
      project_id: testProjectId,
      cwd: tmpDir,
    }).id;
  });

  afterEach(async () => {
    const { closeDb } = await import("@/lib/db/index");
    closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("task A 先认领后, task B backfill 同区间 → 0 条新插入", async () => {
    const { backfillTaskCommits } = await import("./collect-task-commits");
    const base = git(tmpDir, ["rev-parse", "HEAD~1"]);
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const insertedA = backfillTaskCommits(taskAId, tmpDir, base, head);
    expect(insertedA).toBe(1); // shared commit 归 A

    const insertedB = backfillTaskCommits(taskBId, tmpDir, base, head);
    expect(insertedB).toBe(0); // 已被 A 认领, B 不重复归属

    const { getDb } = await import("@/lib/db/index");
    const rows = getDb()
      .prepare(`SELECT task_id FROM task_commits WHERE commit_id = ?`)
      .all(head) as Array<{ task_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(taskAId);
  });

  it("同 task 重复 backfill 幂等 (INSERT OR IGNORE 保留首次数据)", async () => {
    const { backfillTaskCommits } = await import("./collect-task-commits");
    const base = git(tmpDir, ["rev-parse", "HEAD~1"]);
    const head = git(tmpDir, ["rev-parse", "HEAD"]);
    expect(backfillTaskCommits(taskAId, tmpDir, base, head)).toBe(1);
    expect(backfillTaskCommits(taskAId, tmpDir, base, head)).toBe(0);
  });
});