// DAG P2 (2026-09-05) — projects.dag_enforced 项目级拓扑调度开关.
//
// 覆盖 5 条场景:
//   1) dag_enforced=false + 3 个 task 有依赖 → 现状保持 (B1 默认, 与老项目 byte-identical)
//   2) dag_enforced=true  + 依赖链 A→B→C + A 占 cwd → B/C 留 queued, 不进 running
//   3) dag_enforced=true  + 无依赖 task → 与 false 行为一致 (不进 dag 分支)
//   4) 跨项目: A 项目 true / B 项目 false → 各自走自己的开关, 互不影响
//   5) FIFO+拓扑: dag_enforced=true 时, 同优先级 A→B→C 入队, 出队顺序仍是 A→B→C
//
// 不变量:
//   - dag_enforced=false 行为与今天 byte-identical (现状保护, B1 拍板).
//   - dag_enforced=true 时未满足依赖的 task 留 queued, 满足后被调度器拉起.
//   - 跨项目隔离: A 项目开关不影响 B 项目.
//   - 双层防御: scheduler 跳过 + startTask 已有 throw-on-deps-not-met.
//
// 写法: 仿 task-scheduler.test.ts 的「controllableRunner」—— 每条 task 一个
//   hanging promise, 测试可以按顺序 resolve. 全程真 DB + 真 TaskScheduler,
//   只 mock runner.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject, updateProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";

let tmpDir: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dag-p2-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs migrations (including v71 dag_enforced)

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Per-task controllable runner: hangs until the test resolves it.
function makeRunner() {
  const resolvers = new Map<string, () => void>();
  const run = (_task: Task, _mode: RunMode): Promise<void> =>
    new Promise<void>((resolve) => {
      resolvers.set(_task.id, resolve);
    });
  return { run, resolvers };
}

// Complete a task the way AgentRuntime would: flip DB status to "completed"
// THEN release the runner promise. areDependenciesMet reads DB.status, so
// without this step the dependent task's dep would still look "running".
async function completeTask(taskId: string, runner: ReturnType<typeof makeRunner>): Promise<void> {
  updateTaskStatus(taskId, "completed");
  runner.resolvers.get(taskId)!();
  // Let onTaskDone -> schedule settle.
  await tick();
}

// Drain the scheduler's async tail (runTask finally -> onTaskDone -> schedule).
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TaskScheduler dag_enforced project-level toggle", () => {
  it("dag_enforced=false: keeps current behaviour (B1 default, byte-identical)", () => {
    // Project A,B,C share a cwd so they would otherwise serialize; deps make
    // B/C wait on A. With dag_enforced OFF, scheduler still doesn't honour
    // depends_on at enqueue time — B/C get dequeued and try to run; runtime
    // throw is the only guard. We just assert scheduler doesn't skip them.
    const project = createProject({ name: "no-dag", ownerId, cwd: path.join(tmpDir, "no-dag-cwd") });
    const a = createTask({ title: "A", prompt: "p", project_id: project.id });
    const b = createTask({ title: "B", prompt: "p", project_id: project.id, dependsOn: [a.id] });
    const c = createTask({ title: "C", prompt: "p", project_id: project.id, dependsOn: [a.id] });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    // Enqueue all three. dag_enforced=false (default), so they go through the
    // ordinary cwd-serialization path. A claims the cwd; B and C wait on cwd,
    // NOT on depends_on.
    scheduler.enqueue(a.id, "start");
    scheduler.enqueue(b.id, "start");
    scheduler.enqueue(c.id, "start");

    expect(getTaskById(a.id)?.status).toBe("running");
    expect(getTaskById(b.id)?.status).toBe("queued"); // cwd busy, not dep
    expect(getTaskById(c.id)?.status).toBe("queued"); // cwd busy, not dep

    // Cleanup
    runner.resolvers.get(a.id)!();
  });

  it("dag_enforced=true: B/C wait on depends_on, not just cwd", async () => {
    // Same setup as test #1, but the project opts into DAG mode. A is held
    // "running" by the controllable runner; B and C depend on A. They must
    // remain queued even if a slot is free — only when A completes do they
    // become runnable.
    const project = createProject({ name: "with-dag", ownerId, cwd: path.join(tmpDir, "with-dag-cwd") });
    updateProject(project.id, { parallel_limit: 3 }); // raise parallel_limit so cwd isn't the blocker
    // Sanity: project.dag_enforced is read from DB and writable via updateProject
    // is intentionally NOT exposed yet (P2 只读默认 + 手工 SQL 开, API 等下个 task)
    // — flip directly to assert the read path:
    getDb()
      .prepare("UPDATE projects SET dag_enforced = 1 WHERE id = ?")
      .run(project.id);

    const a = createTask({ title: "A", prompt: "p", project_id: project.id });
    const b = createTask({ title: "B", prompt: "p", project_id: project.id, dependsOn: [a.id] });
    const c = createTask({ title: "C", prompt: "p", project_id: project.id, dependsOn: [a.id] });

    const scheduler = new TaskScheduler(3); // 3 slots, plenty
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(a.id, "start");
    scheduler.enqueue(b.id, "start");
    scheduler.enqueue(c.id, "start");

    // A runs immediately. B/C must STAY queued — global slots are free, but
    // dag_enforced=true + depends_on not met → scheduler skips them.
    expect(getTaskById(a.id)?.status).toBe("running");
    expect(getTaskById(b.id)?.status).toBe("queued");
    expect(getTaskById(c.id)?.status).toBe("queued");

    // Complete A (DB status flip + runner resolve). Now B/C should both run.
    await completeTask(a.id, runner);

    // B/C should now be running (parallel_limit=3, free slots).
    expect(getTaskById(b.id)?.status).toBe("running");
    expect(getTaskById(c.id)?.status).toBe("running");

    // Cleanup
    runner.resolvers.get(b.id)!();
    runner.resolvers.get(c.id)!();
    await tick();
  });

  it("dag_enforced=true: tasks without dependencies run as usual", () => {
    // dag_enforced only blocks tasks whose depends_on isn't met. A task with
    // no deps must enter the running slot regardless of the toggle.
    const project = createProject({ name: "mixed", ownerId, cwd: path.join(tmpDir, "mixed-cwd") });
    getDb()
      .prepare("UPDATE projects SET dag_enforced = 1 WHERE id = ?")
      .run(project.id);

    const solo = createTask({ title: "solo", prompt: "p", project_id: project.id });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(solo.id, "start");
    expect(getTaskById(solo.id)?.status).toBe("running");

    runner.resolvers.get(solo.id)!();
  });

  it("dag_enforced: cross-project isolation (A true / B false)", async () => {
    // Project A opts into DAG mode and holds a dependent task. Project B stays
    // off and has its own dependent task. The scheduler must respect each
    // project's own toggle — toggling A's flag must not affect B's behaviour.
    const projA = createProject({ name: "A", ownerId, cwd: path.join(tmpDir, "A-cwd") });
    const projB = createProject({ name: "B", ownerId, cwd: path.join(tmpDir, "B-cwd") });
    updateProject(projA.id, { parallel_limit: 3 });
    updateProject(projB.id, { parallel_limit: 3 });
    getDb()
      .prepare("UPDATE projects SET dag_enforced = 1 WHERE id = ?")
      .run(projA.id);
    // projB left at dag_enforced=0 (default)

    const aRoot = createTask({ title: "a-root", prompt: "p", project_id: projA.id });
    const aDep = createTask({ title: "a-dep", prompt: "p", project_id: projA.id, dependsOn: [aRoot.id] });
    const bRoot = createTask({ title: "b-root", prompt: "p", project_id: projB.id });
    const bDep = createTask({ title: "b-dep", prompt: "p", project_id: projB.id, dependsOn: [bRoot.id] });

    const scheduler = new TaskScheduler(4);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    // Enqueue aRoot first so it's running; then aDep (dag enforced → queued).
    scheduler.enqueue(aRoot.id, "start");
    scheduler.enqueue(aDep.id, "start");
    scheduler.enqueue(bRoot.id, "start");
    scheduler.enqueue(bDep.id, "start");

    expect(getTaskById(aRoot.id)?.status).toBe("running");
    expect(getTaskById(aDep.id)?.status).toBe("queued"); // dag_enforced=true blocks

    // Project B: dag_enforced=false → cwd-free tasks with deps still enter
    // running (per current behaviour). bRoot has no deps → runs.
    expect(getTaskById(bRoot.id)?.status).toBe("running");
    // bDep depends on bRoot which is running (not completed). Without the
    // toggle the scheduler still de queues it; the runtime would later throw.
    expect(getTaskById(bDep.id)?.status).toBe("running");

    // Cleanup
    runner.resolvers.get(aRoot.id)!();
    runner.resolvers.get(bRoot.id)!();
    runner.resolvers.get(bDep.id)!();
    await tick();
  });

  it("dag_enforced=true: FIFO order preserved across the dependency chain", async () => {
    // Three tasks A→B→C all queued before any run. With DAG mode, A should
    // come out first (its deps are met trivially), then B (after A done), then
    // C (after B done). This proves the scheduler's pickIdx scan respects the
    // queue's FIFO order even when middle items are blocked.
    const project = createProject({ name: "chain", ownerId, cwd: path.join(tmpDir, "chain-cwd") });
    updateProject(project.id, { parallel_limit: 3 });
    getDb()
      .prepare("UPDATE projects SET dag_enforced = 1 WHERE id = ?")
      .run(project.id);

    const a = createTask({ title: "A", prompt: "p", project_id: project.id });
    const b = createTask({ title: "B", prompt: "p", project_id: project.id, dependsOn: [a.id] });
    const c = createTask({ title: "C", prompt: "p", project_id: project.id, dependsOn: [b.id] });

    const scheduler = new TaskScheduler(3);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    // Enqueue in chain order A→B→C.
    scheduler.enqueue(a.id, "start");
    scheduler.enqueue(b.id, "start");
    scheduler.enqueue(c.id, "start");

    // A runs first; B/C remain queued because their deps aren't met.
    expect(getTaskById(a.id)?.status).toBe("running");
    expect(getTaskById(b.id)?.status).toBe("queued");
    expect(getTaskById(c.id)?.status).toBe("queued");

    // Resolve A → B's dep met → B runs. C still queued (depends on B).
    await completeTask(a.id, runner);
    expect(getTaskById(a.id)?.status).toBe("completed");
    expect(getTaskById(b.id)?.status).toBe("running");
    expect(getTaskById(c.id)?.status).toBe("queued");

    // Resolve B → C's dep met → C runs.
    await completeTask(b.id, runner);
    expect(getTaskById(b.id)?.status).toBe("completed");
    expect(getTaskById(c.id)?.status).toBe("running");

    // Cleanup
    runner.resolvers.get(c.id)!();
    await tick();
  });
});
