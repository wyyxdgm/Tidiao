// createTask() prompt prelude: preflight self-check. The orchestrator runs
// pwd / git remote -v / git log -1 server-side at createTask time, stores
// the 4-line result in tasks.preflight_result, and injects it at the top of
// the prompt (before any role preamble). This lets the dispatcher (watching
// the right dock / SSE) spot mis-dispatched tasks early and cancel before
// the agent touches anything - without costing the agent a Bash round.
//
// Why a dedicated test file: roles-unique.test.ts and the runtime tests only
// assert structural / behavioral fields, never the prompt string. Without
// this file, a future refactor of resolvedPrompt could silently drop the
// preflight block and dispatcher protection would vanish with no test
// failure.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createRole } from "./roles";
import { setUserPreflightEnabled } from "./users";
import { createTask, getTaskById, getDispatchedTasks } from "./tasks";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-prelude-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // migrations

  // createTask inherits owner_id from the project, so seed a user + project.
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "prelude-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createTask prompt prelude: preflight self-check", () => {
  it("starts with the preflight marker and preserves the user prompt", () => {
    const created = createTask({
      title: "t",
      prompt: "do the actual work",
      project_id: projectId,
    });
    const stored = getTaskById(created.id)!;

    expect(stored.prompt.startsWith("[preflight check]")).toBe(true);
    expect(stored.prompt).toContain("do the actual work");
  });

  it("places preflight BEFORE the role preamble when role_id is given", () => {
    const role = createRole({
      name: "reviewer",
      system_prompt: "ROLE_CONTEXT_MARKER",
      ownerId,
    });
    const created = createTask({
      title: "t",
      prompt: "do the actual work",
      project_id: projectId,
      role_id: role.id,
    });
    const stored = getTaskById(created.id)!;

    const preflightIdx = stored.prompt.indexOf("[preflight check]");
    const roleIdx = stored.prompt.indexOf("ROLE_CONTEXT_MARKER");
    const taskIdx = stored.prompt.indexOf("do the actual work");

    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeGreaterThan(preflightIdx);
    expect(taskIdx).toBeGreaterThan(roleIdx);
  });

  it("emits the 4 dispatcher-grep-able field names into preflight_result", () => {
    const created = createTask({
      title: "t",
      prompt: "x",
      project_id: projectId,
    });
    const stored = getTaskById(created.id)!;

    // These four prefixes are what the dispatcher greps for in the
    // preflight_result field (and the injected prompt block). Dropping any
    // one breaks the watch flow.
    expect(stored.preflight_result).toContain("preflight.cwd:");
    expect(stored.preflight_result).toContain("preflight.remote:");
    expect(stored.preflight_result).toContain("preflight.last_commit:");
    expect(stored.preflight_result).toContain("preflight.is_correct:");
    // The injected prompt block also carries the result verbatim.
    expect(stored.prompt).toContain("preflight.cwd:");
  });

  it("instructs the agent to halt on wrong cwd (don't write code)", () => {
    const created = createTask({
      title: "t",
      prompt: "x",
      project_id: projectId,
    });
    const stored = getTaskById(created.id)!;

    expect(stored.prompt).toContain("不要做任何代码改动");
  });

  it("skips preflight when user.preflight_enabled = 0 (v27 toggle)", () => {
    setUserPreflightEnabled(ownerId, false);
    const created = createTask({
      title: "t",
      prompt: "do the actual work",
      project_id: projectId,
    });
    const stored = getTaskById(created.id)!;

    // Toggle off -> no preflight block, prompt is the user's verbatim text
    // (or role preamble + user text if a role is attached), and
    // preflight_result is NULL. Verifies the dispatcher-side cost saving is
    // real, not a no-op flag.
    expect(stored.prompt).not.toContain("[preflight check]");
    expect(stored.prompt).toBe("do the actual work");
    expect(stored.preflight_result).toBeNull();
  });

  it("skips preflight but keeps role preamble when toggle is off", () => {
    const role = createRole({
      name: "reviewer",
      system_prompt: "ROLE_CONTEXT_MARKER",
      ownerId,
    });
    setUserPreflightEnabled(ownerId, false);
    const created = createTask({
      title: "t",
      prompt: "do the actual work",
      project_id: projectId,
      role_id: role.id,
    });
    const stored = getTaskById(created.id)!;

    expect(stored.prompt).not.toContain("[preflight check]");
    expect(stored.prompt).toContain("ROLE_CONTEXT_MARKER");
    expect(stored.prompt).toContain("do the actual work");
    expect(stored.preflight_result).toBeNull();
  });

  it("reports isolated workspace when cwd is null (no project/version cwd)", () => {
    const created = createTask({
      title: "t",
      prompt: "x",
      project_id: projectId,
    });
    const stored = getTaskById(created.id)!;

    // task.cwd=NULL -> agent runs in an isolated workspace dir with no git;
    // runPreflight must report that without executing any command.
    expect(stored.preflight_result).toContain("isolated workspace");
    expect(stored.preflight_result).toContain("no git repo");
  });

  it("runs preflight server-side and captures real git info when cwd is a repo", () => {
    // Turn tmpDir into a real git repo with one commit + a remote.
    const git = (cmd: string) => execSync(cmd, { cwd: tmpDir, stdio: "ignore" });
    git("git init");
    git('git config user.email "t@t.com"');
    git('git config user.name "t"');
    git("git commit --allow-empty -m init-commit");
    git("git remote add origin https://example.com/test.git");

    const created = createTask({
      title: "t",
      prompt: "x",
      project_id: projectId,
      cwd: tmpDir,
    });
    const stored = getTaskById(created.id)!;

    // pwd resolves symlinks (macOS /var -> /private/var), so compare against
    // the real path. Key signals: remote shows origin, last_commit is non-empty.
    const realTmp = fs.realpathSync(tmpDir);
    expect(stored.preflight_result).toContain(`preflight.cwd: ${realTmp}`);
    expect(stored.preflight_result).toContain("preflight.remote: origin");
    expect(stored.preflight_result).toContain("init-commit");
    expect(stored.preflight_result).not.toMatch(/preflight\.last_commit: no git repo/);
  });
});

// v32: 派发方溯源. createTask 记录上游 task id 并在 prompt 注入一行, 让子 agent
// 知道自己被谁派发（可回报进展）. 跨项目派发合法（子任务常落在别的仓库的
// project）, 所以校验只按 owner 收窄, 不按 project.
describe("createTask: dispatched_by_task_id (v32 派发方溯源)", () => {
  it("stores the reference and injects the [dispatched by] line", () => {
    const upstream = createTask({ title: "上游任务", prompt: "u", project_id: projectId });
    const created = createTask({
      title: "t",
      prompt: "do the actual work",
      project_id: projectId,
      dispatched_by_task_id: upstream.id,
    });
    const stored = getTaskById(created.id)!;

    expect(stored.dispatched_by_task_id).toBe(upstream.id);
    expect(stored.prompt).toContain("[dispatched by]");
    expect(stored.prompt).toContain(upstream.id);
    expect(stored.prompt).toContain("上游任务");
    // preflight 仍在最前 — 派发行插在它之后, 不破坏 dispatcher 的 grep 起点.
    expect(stored.prompt.startsWith("[preflight check]")).toBe(true);
    expect(stored.prompt.indexOf("[dispatched by]")).toBeLessThan(
      stored.prompt.indexOf("do the actual work")
    );
  });

  it("omits the line entirely when no dispatcher is given", () => {
    const created = createTask({ title: "t", prompt: "x", project_id: projectId });
    const stored = getTaskById(created.id)!;

    expect(stored.dispatched_by_task_id).toBeNull();
    expect(stored.prompt).not.toContain("[dispatched by]");
  });

  it("still injects the line when preflight is disabled", () => {
    const upstream = createTask({ title: "上游", prompt: "u", project_id: projectId });
    setUserPreflightEnabled(ownerId, false);
    const created = createTask({
      title: "t",
      prompt: "work",
      project_id: projectId,
      dispatched_by_task_id: upstream.id,
    });
    const stored = getTaskById(created.id)!;

    // 派发溯源不依赖 preflight 开关（两者是独立的 prompt 段）.
    expect(stored.prompt.startsWith("[dispatched by]")).toBe(true);
    expect(stored.preflight_result).toBeNull();
  });

  it("accepts a cross-project reference (same owner, different project)", () => {
    const otherProjectId = createProject({ name: "downstream-proj", ownerId }).id;
    const upstream = createTask({ title: "上游", prompt: "u", project_id: projectId });
    const created = createTask({
      title: "t",
      prompt: "x",
      project_id: otherProjectId,
      dispatched_by_task_id: upstream.id,
    });

    expect(getTaskById(created.id)!.dispatched_by_task_id).toBe(upstream.id);
  });

  it("throws when the dispatcher belongs to another owner", () => {
    const strangerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(strangerId, `${strangerId}@example.com`, "x", "user");
    const strangerProject = createProject({ name: "stranger-proj", ownerId: strangerId }).id;
    const strangerTask = createTask({ title: "别人的", prompt: "u", project_id: strangerProject });

    expect(() =>
      createTask({
        title: "t",
        prompt: "x",
        project_id: projectId,
        dispatched_by_task_id: strangerTask.id,
      })
    ).toThrow(/not found/);
  });

  it("lists downstream tasks via getDispatchedTasks", () => {
    const upstream = createTask({ title: "上游", prompt: "u", project_id: projectId });
    const a = createTask({ title: "下游 A", prompt: "a", project_id: projectId, dispatched_by_task_id: upstream.id });
    const b = createTask({ title: "下游 B", prompt: "b", project_id: projectId, dispatched_by_task_id: upstream.id });
    createTask({ title: "无关", prompt: "c", project_id: projectId });

    const ids = getDispatchedTasks(upstream.id, ownerId).map((t) => t.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });
});

// 0826 P1 (撞同根第 3 次): dispatcher 不存在时降级为 warn + 跳过 block, 而不是
// 抛 DISPATCHER_NOT_FOUND 让任务创建失败. 跨 owner 仍抛 (安全红线) — 已在上面
// v32 describe 块的 "throws when the dispatcher belongs to another owner" 测了.
// 此处只覆盖 "上游 task 在任何 owner 下都查不到" 这一档.
describe("createTask: dispatched_by_task_id 不存在 → 降级 (0826 P1, 撞同根第 3 次)", () => {
  it("创建成功, prompt 不含 [dispatched by] block, dispatched_by_task_id 落 NULL", () => {
    const ghostId = "00000000-0000-0000-0000-000000000000"; // 合法 UUID 但 DB 里不存在
    const created = createTask({
      title: "t",
      prompt: "do the actual work",
      project_id: projectId,
      dispatched_by_task_id: ghostId,
    });
    const stored = getTaskById(created.id)!;

    expect(stored).not.toBeNull();
    // 派发链断裂时, dispatched_by_task_id 落 NULL (与 "omits the line entirely
    // when no dispatcher is given" v32 测过的口径一致 — 不留 dangling reference).
    expect(stored.dispatched_by_task_id).toBeNull();
    expect(stored.prompt).not.toContain("[dispatched by]");
    // preflight 仍在最前 (派发方溯源块跳过不影响 preflight 的位置).
    expect(stored.prompt.startsWith("[preflight check]")).toBe(true);
    expect(stored.prompt).toContain("do the actual work");
  });

  it("console.warn 一次, 含 dispatcher ID + 降级提示", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ghostId = "deadbeef-dead-beef-dead-beefdeadbeef"; // 另一个真不存在的合法 UUID
    try {
      createTask({
        title: "t",
        prompt: "x",
        project_id: projectId,
        dispatched_by_task_id: ghostId,
      });
      // 至少一次 warn 含此 UUID + "falling back"
      const calls = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(calls).toContain(ghostId);
      expect(calls).toContain("falling back");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("跨 owner 仍抛 DISPATCHER_NOT_FOUND (安全红线保留, 不放开)", () => {
    // 上面 v32 describe 块已经覆盖 "createTask 找不到但 getTaskById(anyOwner) 找到"
    // 这条 — 即 "上游存在但属另一个 owner". 此处再独立测一遍: 显式确认降级逻辑
    // 不会误把跨 owner 当成 "不存在" 放过. 用 fresh stranger owner 拿真实存在的
    // upstream task id 重复校验.
    const strangerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(strangerId, `${strangerId}@example.com`, "x", "user");
    const strangerProject = createProject({ name: "stranger-proj-2", ownerId: strangerId }).id;
    const strangerTask = createTask({ title: "别人的", prompt: "u", project_id: strangerProject });

    // 模拟有 warn 但抛错 — 同时验证抛错路径不会走降级 warn
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        createTask({
          title: "t",
          prompt: "x",
          project_id: projectId,
          dispatched_by_task_id: strangerTask.id,
        })
      ).toThrow(/not found/);
      // 跨 owner 路径应走 throw 分支, 不应再额外触发 "falling back" warn
      const calls = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(calls).not.toContain("falling back");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
