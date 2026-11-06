// whoTouchedThis lib tests — verify against real git operations.
//
// 关注点:
//   - 用真 git fixture（tmpdir 里 git init）跑 execFileSync, 不 mock, 抓真实 diff 行为.
//   - 覆盖: 命中 / 未命中 / base==head / cwd 不可访问 / 非 git 仓 / 空字段防御 / LRU 缓存.
//   - 清理: 每个 test 一个 fresh tmpdir, afterEach rm -rf; _clearTaskHistoryCacheForTests
//     在 beforeEach/afterEach 都跑, 防止测试间缓存污染 (进程内缓存, key 含 cwd).
//   - 不连 DB: 这个 lib 是纯 git 操作, 没有 SQL 依赖.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  taskTouchedFile,
  getFilesTouchedByTask,
  _clearTaskHistoryCacheForTests,
} from "./task-history";

let tmpDir: string;

function git(cwd: string, args: string[]): string {
  // 小 helper: 跑 git 命令返 stdout. 失败抛 (测试里我们要看到错).
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-task-history-"));
  // 一次性 init 一个空 repo (committed=false 默认, 后面再 add 第一文件).
  git(tmpDir, ["init", "-q", "-b", "main"]);
  git(tmpDir, ["config", "user.email", "test@example.com"]);
  git(tmpDir, ["config", "user.name", "Test User"]);
  _clearTaskHistoryCacheForTests();
});

afterEach(() => {
  _clearTaskHistoryCacheForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("taskTouchedFile", () => {
  it("命中: base..head 间被修改的文件返 true", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", "second");
    commitFile(tmpDir, "b.ts", "new", "third");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head }, "a.ts"),
    ).toBe(true);
    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head }, "b.ts"),
    ).toBe(true);
  });

  it("未命中: 不在 diff 范围的文件返 false", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "b.ts", "new", "second");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head }, "a.ts"),
    ).toBe(false);
  });

  it("base == head: 没 diff 必返 false (不抛)", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const sha = git(tmpDir, ["rev-parse", "HEAD"]);
    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: sha, head_commit: sha }, "a.ts"),
    ).toBe(false);
  });

  it("cwd 不可访问: graceful fallback 返 false, 不抛", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", "second");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    // cwd 不存在 → git 抛 "fatal: cannot change to ...", 我们的 try/catch 应吞掉
    const deadPath = "/this/path/should/never/exist/orch-task-history-test";
    expect(
      taskTouchedFile({ id: "t1", cwd: deadPath, base_commit: base, head_commit: head }, "a.ts"),
    ).toBe(false);
  });

  it("cwd 不是 git 仓: graceful fallback 返 false, 不抛", () => {
    // tmpDir 是 git 仓, 但 cwd 指向一个不含 .git 的子目录 → git rev-parse 失败
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-task-history-notgit-"));
    try {
      commitFile(tmpDir, "a.ts", "v1", "first");
      const base = git(tmpDir, ["rev-parse", "HEAD"]);
      commitFile(tmpDir, "a.ts", "v2", "second");
      const head = git(tmpDir, ["rev-parse", "HEAD"]);
      expect(
        taskTouchedFile({ id: "t1", cwd: notARepo, base_commit: base, head_commit: head }, "a.ts"),
      ).toBe(false);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("空 cwd / head_commit / 空 file: 防御性返 false, 不抛", () => {
    // 不创建任何 commit — 直接调, 验证空字符串防御
    expect(taskTouchedFile({ id: "t", cwd: "", base_commit: "x", head_commit: "y" }, "f")).toBe(false);
    expect(taskTouchedFile({ id: "t", cwd: tmpDir, base_commit: "", head_commit: "y" }, "f")).toBe(false);
    expect(taskTouchedFile({ id: "t", cwd: tmpDir, base_commit: "x", head_commit: "" }, "f")).toBe(false);
    expect(taskTouchedFile({ id: "t", cwd: tmpDir, base_commit: "x", head_commit: "y" }, "")).toBe(false);
  });

  it("head 不可达 (commit 不存在): graceful fallback 返 false, 不抛", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    // 用一个看起来合法但实际不存在的 commit hash
    const fakeHead = "0000000000000000000000000000000000000000";
    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: fakeHead }, "a.ts"),
    ).toBe(false);
  });

  it("LRU 缓存: 第二次同 key 调用应该命中缓存 (0 git 调用)", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", "second");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    // 第一次: 走真实 git diff
    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head }, "a.ts"),
    ).toBe(true);

    // 第二次: 必须仍然 true (缓存命中, 不会因 git 错误返 false)
    expect(
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head }, "a.ts"),
    ).toBe(true);

    // 测性能: 缓存命中必须 < 1ms (vs 实测 ~10-50ms)
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      taskTouchedFile({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head }, "a.ts");
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50); // 100 次缓存读 < 50ms
  });
});

describe("getFilesTouchedByTask", () => {
  it("返完整文件列表 (git diff base..head --name-only)", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", "second");
    commitFile(tmpDir, "b.ts", "new", "third");
    commitFile(tmpDir, "c.md", "# c", "fourth");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const files = getFilesTouchedByTask({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head });
    expect(files).not.toBeNull();
    expect(files!.sort()).toEqual(["a.ts", "b.ts", "c.md"]);
  });

  it("base == head: 返空数组 (不是 null, 也不抛)", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const sha = git(tmpDir, ["rev-parse", "HEAD"]);
    const files = getFilesTouchedByTask({ id: "t1", cwd: tmpDir, base_commit: sha, head_commit: sha });
    expect(files).toEqual([]);
  });

  it("cwd 不可访问: 返 null, 不抛", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "a.ts", "v2", "second");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const deadPath = "/this/path/should/never/exist/orch-task-history-list-test";
    const files = getFilesTouchedByTask({ id: "t1", cwd: deadPath, base_commit: base, head_commit: head });
    expect(files).toBeNull();
  });

  it("空字段: 返 null", () => {
    expect(getFilesTouchedByTask({ id: "t", cwd: "", base_commit: "x", head_commit: "y" })).toBeNull();
    expect(getFilesTouchedByTask({ id: "t", cwd: tmpDir, base_commit: "", head_commit: "" })).toBeNull();
  });

  it("LRU 缓存: 第二次调必须返同一引用 (缓存命中)", () => {
    commitFile(tmpDir, "a.ts", "v1", "first");
    const base = git(tmpDir, ["rev-parse", "HEAD"]);
    commitFile(tmpDir, "b.ts", "x", "second");
    const head = git(tmpDir, ["rev-parse", "HEAD"]);

    const a = getFilesTouchedByTask({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head });
    const b = getFilesTouchedByTask({ id: "t1", cwd: tmpDir, base_commit: base, head_commit: head });
    // 缓存命中: 返的不是新数组
    expect(a).toBe(b);
  });
});