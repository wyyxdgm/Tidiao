// 排队原因 (queued_reason, v531 + v531 续) 的缺口用例 —— 补齐
// openbot-waiting-visibility plan §8 七条用例中 task-scheduler.test.ts 未覆盖
// 的部分 (那边已有: cwd 互斥含挡路者短 id / 全局并发满 / 内存闸门).
//
// 这里覆盖:
//   2. deps_unmet      — DAG 依赖未满足, 原因带未满足依赖的短 id; 上游完成后清空
//   3. owner_cap       — owner 限额挡出队; invalidateOwnerLimit 提额后清空
//   5. maintenance     — 维护闸门关闸时队列标原因; 开闸后出队清空
//   6. 不变量          — 离开 queued 的翻转 (cancel 旁路) 一律清空 queued_reason
//                        (updateTaskStatus 中央清理, 不依赖调度器 dequeue 记得清)
//   7. compare-then-write — 同挡因下重复 schedule() 不产生多余 UPDATE (同值跳过)
//   附加: runner 未挂载分支标「调度器尚未就绪」(此前静默)
//
// 写法: 仿 task-scheduler.test.ts / task-scheduler-dag-enforced.test.ts 的
// controllableRunner —— 每条 task 一个 hanging promise, 测试按序 resolve.
// 全程真 DB + 真 TaskScheduler; 仅 setQueuedReason 被 vi.fn 包一层数调用次数.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// spy setQueuedReason (其余 db/tasks 导出保持原样) —— case 7 数写次数用.
vi.mock("../db/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/tasks")>();
  return {
    ...actual,
    setQueuedReason: vi.fn(
      (...args: Parameters<typeof actual.setQueuedReason>) =>
        actual.setQueuedReason(...args),
    ),
  };
});

import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject, updateProject } from "../db/projects";
import {
  createTask,
  getTaskById,
  updateTaskStatus,
  setQueuedReason,
} from "../db/tasks";
import { createUser, setUserMaxConcurrency } from "../db/users";

const reasonSpy = vi.mocked(setQueuedReason);

let tmpDir: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-blocked-reason-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs migrations (incl. v531 queued_reason)

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  reasonSpy.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Per-task controllable runner: hangs until the test resolves it.
function makeRunner() {
  const resolvers = new Map<string, () => void>();
  const run = (task: Task, _mode: RunMode): Promise<void> =>
    new Promise<void>((resolve) => {
      resolvers.set(task.id, resolve);
    });
  return { run, resolvers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Complete a task the way AgentRuntime would: flip DB status first, then
// release the runner (areDependenciesMet reads DB.status).
async function completeTask(
  taskId: string,
  runner: ReturnType<typeof makeRunner>,
): Promise<void> {
  updateTaskStatus(taskId, "completed");
  runner.resolvers.get(taskId)!();
  await tick();
}

describe("TaskScheduler blocked reason gaps (v531 续)", () => {
  it("DAG 依赖未满足: 原因带未满足依赖短 id, 上游完成后清空", async () => {
    const project = createProject({ name: "dag-reason", ownerId, cwd: path.join(tmpDir, "dag-cwd") });
    updateProject(project.id, { parallel_limit: 3 }); // 抬高 cwd 上限, 让 deps 成为唯一挡因
    getDb().prepare("UPDATE projects SET dag_enforced = 1 WHERE id = ?").run(project.id);

    const a = createTask({ title: "A", prompt: "p", project_id: project.id });
    const b = createTask({ title: "B", prompt: "p", project_id: project.id, dependsOn: [a.id] });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(a.id, "start");
    scheduler.enqueue(b.id, "start");

    expect(getTaskById(a.id)?.status).toBe("running");
    expect(getTaskById(b.id)?.status).toBe("queued");
    expect(getTaskById(b.id)?.queued_reason).toMatch(
      new RegExp(`依赖的上游任务 ${a.id.slice(0, 8)} 尚未完成`),
    );

    // A 完成 → B 出队转 running, 原因清空.
    await completeTask(a.id, runner);
    expect(getTaskById(b.id)?.status).toBe("running");
    expect(getTaskById(b.id)?.queued_reason ?? null).toBeNull();

    runner.resolvers.get(b.id)!();
    await tick();
  });

  it("owner 限额: 原因写账号并发上限, invalidateOwnerLimit 提额后清空", async () => {
    const user = await createUser("cap-reason@test", "pw", "user");
    setUserMaxConcurrency(user.id, 1);
    const project = createProject({ name: "cap-reason-proj", ownerId: user.id });
    const t1 = createTask({ title: "t1", prompt: "p", project_id: project.id, cwd: path.join(tmpDir, "oc1") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: project.id, cwd: path.join(tmpDir, "oc2") });

    const scheduler = new TaskScheduler(5); // 全局远高于 owner 上限, 唯一挡因 = owner cap
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");

    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("queued");
    expect(getTaskById(t2.id)?.queued_reason).toContain("该账号并发已达上限 1");

    // 提额 + 失效缓存 → t2 出队, 原因清空.
    setUserMaxConcurrency(user.id, 2);
    scheduler.invalidateOwnerLimit(user.id);
    expect(getTaskById(t2.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.queued_reason ?? null).toBeNull();

    runner.resolvers.get(t1.id)!();
    runner.resolvers.get(t2.id)!();
    await tick();
  });

  it("维护闸门: 关闸时队列任务标维护原因, 开闸后出队清空", async () => {
    const project = createProject({ name: "maint-proj", ownerId });
    const t1 = createTask({ title: "t1", prompt: "p", project_id: project.id });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    // 关闸后再入队: enqueue 正常翻 queued, schedule() 在 paused 早退分支标原因.
    scheduler.setPaused(true);
    scheduler.enqueue(t1.id, "start");

    expect(getTaskById(t1.id)?.status).toBe("queued");
    expect(getTaskById(t1.id)?.queued_reason).toContain("维护模式");

    // 开闸 → 自动调度 → t1 出队转 running, 原因清空.
    scheduler.setPaused(false);
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t1.id)?.queued_reason ?? null).toBeNull();

    runner.resolvers.get(t1.id)!();
    await tick();
  });

  it("runner 未挂载: 队列任务标「调度器尚未就绪」而非静默", () => {
    const project = createProject({ name: "no-runner-proj", ownerId });
    const t1 = createTask({ title: "t1", prompt: "p", project_id: project.id });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    // 故意不 setRunner.

    scheduler.enqueue(t1.id, "start");
    expect(getTaskById(t1.id)?.status).toBe("queued");
    expect(getTaskById(t1.id)?.queued_reason).toContain("调度器尚未就绪");
  });

  it("不变量: 离开 queued 的旁路翻转 (cancel) 一律清空 queued_reason", async () => {
    const project = createProject({ name: "invariant-proj", ownerId });
    const shared = path.join(tmpDir, "inv-cwd");
    const t1 = createTask({ title: "t1", prompt: "p", project_id: project.id, cwd: shared });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: project.id, cwd: shared });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    expect(getTaskById(t2.id)?.queued_reason).toBeTruthy();

    // 旁路: 不经过调度器 dequeue, 直接把 queued 行翻 cancelled (cancel API 的
    // 底层动作). 中央清理必须在同一条 UPDATE 里清掉原因.
    updateTaskStatus(t2.id, "cancelled");
    expect(getTaskById(t2.id)?.status).toBe("cancelled");
    expect(getTaskById(t2.id)?.queued_reason ?? null).toBeNull();

    // scheduler 内存队列里的残留 entry 也不再有 DB 写 (markQueuedReason 对
    // 非 queued 行是 no-op), 直接收尾 t1.
    runner.resolvers.get(t1.id)!();
    await tick();
  });

  it("compare-then-write: 同挡因重复 schedule() 不产生多余 UPDATE", async () => {
    const project = createProject({ name: "ctw-proj", ownerId });
    const t1 = createTask({ title: "t1", prompt: "p", project_id: project.id, cwd: path.join(tmpDir, "ctw1") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: project.id, cwd: path.join(tmpDir, "ctw2") });

    const scheduler = new TaskScheduler(1); // 全局并发 1, t2 被 global_cap 挡
    scheduler.setStatusChangeHandler(() => {});
    const runner = makeRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    const firstReason = getTaskById(t2.id)?.queued_reason;
    expect(firstReason).toContain("全局并发已满");
    // 只数「标因写」(reason 非 null); enqueue 自己那次 setQueuedReason(t2, null)
    // (入队清旧因) 是独立口径, 不算.
    const markWrites = () => reasonSpy.mock.calls.filter(([id, reason]) => id === t2.id && reason !== null).length;
    expect(markWrites()).toBe(1);

    // 反复触发 schedule() (状态无变化): setConcurrency 同值也会拉起一轮.
    scheduler.setConcurrency(1);
    scheduler.setConcurrency(1);
    expect(markWrites()).toBe(1); // 同值跳过, 零新增写

    // 挡因真变化时才写: t1 完成 → t2 出队 → 清空写一次.
    await completeTask(t1.id, runner);
    expect(getTaskById(t2.id)?.status).toBe("running");
    const clearCalls = reasonSpy.mock.calls.filter(([id, reason]) => id === t2.id && reason === null);
    expect(clearCalls.length).toBeGreaterThanOrEqual(1);

    runner.resolvers.get(t2.id)!();
    await tick();
  });
});
