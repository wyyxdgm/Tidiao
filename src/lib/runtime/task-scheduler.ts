// TaskScheduler: priority queue with concurrency control
//
// Three layers of gating prevent parallel agents from stomping each other:
//   1. Global concurrency cap (maxConcurrency) - bounds total running tasks.
//   2. Per-cwd concurrency limit - tasks sharing a working directory run at most
//      projects.parallel_limit at a time (default 1 = strict mutual exclusion),
//      so two agents never edit/git-commit in the same tree at once. Raise it
//      per project (v38) when its tasks are read-mostly and don't fight over the
//      tree. Tasks with distinct cwds (or NULL-cwd tasks, which fall back to a
//      per-task isolated workspace) still run in parallel regardless.
//   3. Per-owner concurrency cap (users.max_concurrency, v30) - bounds how many
//      tasks a single account may run at once. NULL = unlimited (bounded only
//      by the global cap). Lets an admin tighten a noisy account without
//      lowering the system-wide limit.
//
// Effective parallelism for one project = min(all three). Raising just one of
// them may change nothing.
//
// The cwd key uses resolveTaskCwd() - the same fallback chain as ActiveSession
// (task.cwd > projects/{pid}/{tid} > workspace/{tid}). Two tasks land on the
// same key only when they actually resolve to the same working directory.

import type { Task, TaskStatus } from "./types";
import {
  getTaskById,
  updateTaskStatus,
  areDependenciesMet,
  getDependencyTaskIds,
  getMaxQueuedOrder,
  setTaskQueuedOrder,
  setQueuedReason,
} from "../db/tasks";
import { resolveTaskCwd } from "../db/attachments";
import { getUserMaxConcurrency } from "../db/users";
import { getProjectById, getProjectDagEnforced } from "../db/projects";
import { MemGate, type MemCheckResult } from "./mem-guard";
import { sendNotifyToUser } from "../notify/mailer";

// RunMode tells the runner how to dispatch a task. Without this, the runner
// can't distinguish "start fresh" from "resume existing session" reliably
// because the scheduler flips task.status to "running" before invoking the
// runner — so inferring from task.status was always wrong.
export type RunMode = "start" | "resume" | "fork";

type TaskRunner = (task: Task, mode: RunMode) => Promise<void>;
// reason 是可选的「谁/为什么触发这次状态翻转」标签, 由调用方标注
// (manual_start / restart / user_message / parent_notify / ...), AgentRuntime 写入
// status_change 事件的 data 字段, 让 timeline 直接显示, 排查「已 approve task 被
// 无故重置」类问题时不用 grep 上一条 message 事件. 详见 types.ts StatusChangeEvent.reason.
type StatusChangeHandler = (
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  reason?: string,
) => void;

interface QueueEntry {
  taskId: string;
  mode: RunMode;
}

export class TaskScheduler {
  private queue: QueueEntry[] = []; // entries in priority order
  private running: Map<string, boolean> = new Map(); // taskId → true
  // cwd keys currently held by running tasks, mapped to the set of taskIds
  // holding them. A queued task whose cwd already has parallel_limit holders
  // must wait - same working directory, must not exceed that project's limit.
  // Tracking the exact holders (rather than a single owner) lets a late
  // onTaskDone (runner finishing after cancel/pause already released the slot)
  // remove only its own entry instead of wrongly freeing a cwd that newer
  // tasks still hold.
  private busyCwds: Map<string, Set<string>> = new Map();
  private maxConcurrency: number;
  private runner: TaskRunner | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  // Fired at the end of onTaskDone (after the slot is freed, before schedule()).
  // AgentRuntime uses it to drain messages stranded during a task's teardown
  // window - by this point `running` no longer holds the task, so a re-enqueue
  // to drain pending_messages succeeds instead of no-op'ing.
  private onTaskDoneCallback: ((taskId: string) => void) | null = null;
  private scheduling = false;
  // v30: per-owner accounting. runningByOwner counts running tasks per owner
  // (null/legacy owner keyed as "" - never capped); runningOwners remembers
  // each running task's owner so onTaskDone can decrement without re-reading
  // the (possibly gone) task row.
  private runningByOwner: Map<string, number> = new Map();
  private runningOwners: Map<string, string> = new Map();
  // Cached per-owner cap (NULL = unlimited). Invalidated by
  // invalidateOwnerLimit() after an admin changes a user's cap.
  private ownerLimitCache: Map<string, number | null> = new Map();
  // v34 维护模式闸门. true 时 schedule() 直接返回, 队列里的任务一律不出队.
  // 注意 enqueue() 不受影响 —— 维护期间用户点「启动」仍照常入队并翻 queued
  // 状态, 只是不出队, 恢复后自动跑起来（少一条需要向用户解释的失败路径）.
  private paused = false;
  // v510: 拖拽手动排序缓存 — taskId → queued_order (从 DB 读一次, reorderQueue
  //   时整体替换). NULL 视为 -Infinity (排到所有已设值之后, 但仍在 priority desc
  //   / created_at asc tie-break 之前, 等价于「未排序」走默认序). schedule() 起
  //   首按这个 Map 排序 this.queue, 保证拖完即刻的 dispatch 按新顺序出队.
  private queueOrderCache: Map<string, number | null> = new Map();
  // 内存闸门 (damo 2026-10-31 立): 可用内存不足时不出队, 任务留 queued 等
  //   恢复自动继续. 预警/恢复通知去重靠 MemGate 的翻转沿. 阈值 env
  //   AO_MEM_GUARD_MB, 默认 2048MB. 机制 → ./mem-guard.ts 头注释.
  private memGate = new MemGate();

  constructor(maxConcurrency: number = 2) {
    this.maxConcurrency = maxConcurrency;
  }

  setRunner(runner: TaskRunner): void {
    this.runner = runner;
  }

  setStatusChangeHandler(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  setOnTaskDone(callback: (taskId: string) => void): void {
    this.onTaskDoneCallback = callback;
  }

  setConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, n);
    this.schedule(); // Trigger scheduling with new limit
  }

  getConcurrency(): number {
    return this.maxConcurrency;
  }

  // 功能: 开/关维护闸门. 关闸(true)后队列不再出队; 开闸(false)立即重新调度.
  // 关注点: 只挡出队, 不挡入队 —— 见 `paused` 字段注释.
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.schedule();
  }

  isPaused(): boolean {
    return this.paused;
  }

  // 功能: 清空等待队列, 返回被摘下的 taskId(按原队列顺序).
  // 关注点: 只动内存队列, 不改任务状态 —— 调用方(enterMaintenance)负责把这些
  //   任务从 queued 改回 pending 并记进 maintenance_state.suspended, 否则重启
  //   后它们会以 queued 状态残留在库里而内存队列已空 = 永远不会被调度.
  drainQueue(): string[] {
    const ids = this.queue.map((e) => e.taskId);
    this.queue = [];
    return ids;
  }

  // v30: per-owner cap. null ownerId (system/legacy task) is never capped.
  // The DB read is cached per owner until invalidated.
  private getOwnerLimit(ownerId: string | null): number | null {
    if (ownerId === null) return null;
    const cached = this.ownerLimitCache.get(ownerId);
    if (cached !== undefined) return cached;
    const limit = getUserMaxConcurrency(ownerId); // null = unlimited
    this.ownerLimitCache.set(ownerId, limit);
    return limit;
  }

  /** Drop the cached cap for an owner and re-schedule. Call after an admin
   *  changes a user's max_concurrency so queued tasks see the new limit. */
  invalidateOwnerLimit(ownerId: string): void {
    this.ownerLimitCache.delete(ownerId);
    this.schedule();
  }

  // 功能: 这个 task 的 cwd 上允许几个任务同时跑 —— 取其 project.parallel_limit,
  //   缺省/无 project/项目已软删 一律回 1(= 上线前的严格串行).
  // 关注点:
  //  - 故意不缓存: schedule() 只在 enqueue / 任务结束时触发, 队列量级几十, 一次
  //    主键查询可忽略; 换来「改完设置立刻生效」, 不必像 ownerLimitCache 那样再挂
  //    一条 invalidate 链路(少一个会忘记调用的地方).
  //  - 同一个 cwd 被 parallel_limit 不同的两个 project 共用时, 判据取**候选任务
  //    自己 project 的 limit** —— 谁想进来按谁的规矩算。所以严格项目的任务可能被
  //    宽松项目已占满的 cwd 挡住, 这是有意的保守行为(它自己声明了要串行)。
  //  - Math.max(1, …) 兜住手工 SQL 写进来的 0/负数脏值(否则 limit<=0 会让该 cwd
  //    的任务永远排不上).
  private cwdLimit(task: Task): number {
    if (!task.project_id) return 1;
    return Math.max(1, getProjectById(task.project_id)?.parallel_limit ?? 1);
  }

  // Enqueue a task by priority (FIFO within the same priority).
  // mode defaults to "start" — pass "resume" or "fork" to preserve intent
  // through to the runner.
  // reason is forwarded to the status_change handler so the resulting event
  // can label itself in the timeline (see types.ts StatusChangeEvent.reason).
  //
  // v510: 翻 queued 时给 task 分配 queued_order = MAX + 1 (新任务永远排在
  //   已有手动顺序的尾部, 不会乱窜插入中间). 内存 cache 同步更新, 避免
  //   schedule() 第一次重排时再回查 DB. 用户随后在 KanbanView 拖拽 → API
  //   reorderQueuedTasks + reorderQueue() 重写 DB + 替换 cache + 重排此队列.
  enqueue(taskId: string, mode: RunMode = "start", reason?: string): void {
    if (this.queue.some((e) => e.taskId === taskId) || this.running.has(taskId))
      return;

    const task = getTaskById(taskId);
    const priority = task?.priority ?? 0;
    const insertAt = this.queue.findIndex(
      (entry) => (getTaskById(entry.taskId)?.priority ?? 0) < priority,
    );
    this.queue.splice(insertAt === -1 ? this.queue.length : insertAt, 0, {
      taskId,
      mode,
    });

    // Mark tasks as queued so the UI reflects "排队中".
    // `paused` MUST be flipped to `queued` here (R11 regression): without it,
    // resuming a paused task whose cwd is held by another running task leaves
    // the DB row at "paused" while the scheduler silently holds it in its
    // in-memory queue — the UI keeps showing "已暂停▶" with no queued signal,
    // and the user reads it as "resume did nothing". `failed` is included for
    // symmetry: a failed task that is restarted also benefits from a visible
    // "queued" window if it has to wait. Terminal statuses (rejected/cancelled/
    // completed) need the queued transition so the UI doesn't stay on a
    // terminal-state label while the task waits for a slot.
    if (
      task &&
      (task.status === "pending" ||
        task.status === "paused" ||
        task.status === "rejected" ||
        task.status === "cancelled" ||
        task.status === "completed" ||
        task.status === "reviewing" ||
        task.status === "failed")
    ) {
      const from = task.status;
      // Clear any stale failure error: a re-activated task is no longer
      // failed, so task.error must not linger in the DB (otherwise a page
      // refresh re-reads it and re-shows the "Agent finished with error"
      // banner even though the task is running again).
      updateTaskStatus(taskId, "queued", { error: null });
      // v510: 分配手动排序 — 翻 queued 时 (即使是从 reviewing/completed 回到
      //   队列) 也要写, 避免后续拖拽把「老 task 没 queued_order」和「新 task
      //   有 queued_order」混排时顺序乱跳. MAX + 1 = 永远尾部追加, 不破坏
      //   已有手动顺序. 写库前 schedule() 已基于旧 cache 排过序, 写完这里
      //   同步更新 cache + 重新排序此队列 (enqueue 内顺序, 重新调一次 sort).
      const nextOrder = getMaxQueuedOrder() + 1;
      setTaskQueuedOrder(taskId, nextOrder);
      this.queueOrderCache.set(taskId, nextOrder);
      this.sortQueueByOrder();
      // v531: 入队清掉上次的排队原因 (此刻还没被挡, 若本轮 schedule() 又被
      //   挡会立刻写新原因, UI 不会长时间停在旧值上).
      setQueuedReason(taskId, null);
      this.statusChangeHandler?.(taskId, from, "queued", reason);
    }

    this.schedule();
  }

  // Remove a task from queue
  dequeue(taskId: string): void {
    this.queue = this.queue.filter((e) => e.taskId !== taskId);
    this.queueOrderCache.delete(taskId);
  }

  // v510: 看板拖拽手动排序 — API PATCH /api/tasks/queue-order 调到这里.
  //   orders = [{id, order}, ...], 已写库 (reorderQueuedTasks); 这里只管
  //   同步内存 cache + 整体重排 this.queue. 不调 schedule() — reorder 只
  //    改顺序, 不影响可调度性 (running 槽位 / cwd lock / owner cap 都没变).
  reorderQueue(orders: Array<{ id: string; order: number | null }>): void {
    for (const item of orders) {
      // 只更新仍在队列里的 (可能在 PATCH 期间已被 dequeue / running 抢占).
      // 这样 cache 不会留死键; 已转 running 的 task 重新进队列由 enqueue
      // 重新分配 queued_order.
      if (this.queue.some((e) => e.taskId === item.id)) {
        this.queueOrderCache.set(item.id, item.order);
      }
    }
    this.sortQueueByOrder();
  }

  // v510: 按 cache 重新排序 this.queue. 比较器: queued_order ASC NULLS LAST,
  //   然后 tie-break = insertion order (Array.prototype.sort 是 stable, 显式
  //   返回 0 保留相对位置). NULL (= 系统默认序) 排到所有已设值之后, 但在
  //   cache 也没有的项 (cache miss 视为 NULL) 之前.
  private sortQueueByOrder(): void {
    this.queue.sort((a, b) => {
      const ao = this.queueOrderCache.get(a.taskId);
      const bo = this.queueOrderCache.get(b.taskId);
      // 缓存里没有 = 未走过 enqueue 路径 (例如 PATCH 时插队的), 视为
      //   "queue 末尾兜底", 与 NULL 同档.
      const aHas = ao !== undefined && ao !== null;
      const bHas = bo !== undefined && bo !== null;
      if (aHas && bHas) {
        const diff = ao - bo;
        if (diff !== 0) return diff;
        return 0; // 完全相等 (数字+同 ID 不存在) → stable 保留
      }
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return 0; // stable 保留入队先后
    });
  }

  // Release the cwd lock (only if this task still owns it), the running slot,
  // and the per-owner count. Shared by onTaskDone (runner finished) and
  // releaseSlot (cancel/pause - release early). Removing only this task's own
  // entry from the cwd holder set prevents a late onTaskDone from freeing a cwd
  // slot that another task claimed after cancel/pause released it.
  private doRelease(taskId: string): void {
    // 关注点: 必须 includeDeleted -- 任务在 running 途中被软删(2026-08-25 实测:
    // 861cf38a 04:15 删、04:25 跑完)时, 默认的 getTaskById 过滤掉 deleted_at
    // 行, cwd 锁摘不掉, busyCwds 永久泄漏 -> 同项目后续任务永远 queued 不出队.
    const task = getTaskById(taskId, undefined, { includeDeleted: true });
    if (task) {
      const cwd = resolveTaskCwd(task);
      const holders = this.busyCwds.get(cwd);
      if (holders?.delete(taskId) && holders.size === 0) {
        this.busyCwds.delete(cwd);
      }
    }
    // v510: 任务一旦转 running / 退出队列, 它的 queued_order 即视为失效 —
    //   cache 里必须清, 否则下次 dequeue + 重新入队的 task 拿到陈旧顺序.
    //   这里不能依赖 dequeue (那是队列里的清除路径), 因为 releaseSlot 在
    //   任务已转 running 之后才被调, 此时 task 不在 this.queue, 也不会再
    //   走 dequeue.
    this.queueOrderCache.delete(taskId);
    this.running.delete(taskId);
    // Read the owner from runningOwners (recorded at claim time) rather than
    // re-reading the task row, so the accounting stays correct even if the
    // row is gone.
    const ownerKey = this.runningOwners.get(taskId);
    if (ownerKey !== undefined) {
      this.runningOwners.delete(taskId);
      const c = (this.runningByOwner.get(ownerKey) ?? 0) - 1;
      if (c <= 0) this.runningByOwner.delete(ownerKey);
      else this.runningByOwner.set(ownerKey, c);
    }
  }

  // Release the running slot + cwd lock immediately (without waiting for the
  // runner to finish) and refill the slot. Used by cancel/pause so a stuck SDK
  // session (interrupt didn't take effect promptly) doesn't hold the cwd lock
  // and block same-cwd tasks for minutes. The runner's eventual onTaskDone is
  // safe: doRelease only frees the cwd if this task still owns it.
  releaseSlot(taskId: string): void {
    this.doRelease(taskId);
    this.schedule();
  }

  // Mark a running task as completed/failed (free a slot)
  onTaskDone(taskId: string): void {
    this.doRelease(taskId);
    // Notify runtime now that the slot is freed - it may re-enqueue the task
    // to drain messages that arrived during its teardown window. Done before
    // schedule() so a re-enqueued task is eligible for the freed slot.
    this.onTaskDoneCallback?.(taskId);
    this.schedule(); // Fill the freed slot
  }

  // Get current state
  getQueueSize(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getQueue(): string[] {
    return [...this.queue.map((e) => e.taskId)];
  }

  getRunning(): string[] {
    return [...this.running.keys()];
  }

  // ---- Private ----

  // 功能: 标任务排队原因 (v531). 同值跳过 —— schedule() 会被事件反复拉起
  //   (cron 触发 / owner cap 变更 / 槽位释放), 不去重的话每轮都白写一遍 DB.
  // 关注点: 只给仍在 queued 状态的行写 (gone/cancelled 残留 entry 不标);
  //   裸 UPDATE 不碰 updated_at (见 setQueuedReason 注释).
  private markQueuedReason(taskId: string, reason: string): void {
    const t = getTaskById(taskId);
    if (!t || t.status !== "queued") return;
    if (t.queued_reason === reason) return;
    setQueuedReason(taskId, reason);
  }

  // v531 续 (openbot-waiting-visibility plan 思想②): 原因精确到「挡路的那个
  //   id」—— 用户从「同项目有个任务在跑」升级到「是 abc12345 在跑」, 排查
  //   「为什么不出队」可以直接对着 id 去看板找挡路者. 只取 8 位短 id, 全量
  //   uuid 太长会挤爆 chip.
  private static shortId(id: string): string {
    return id.slice(0, 8);
  }

  private async schedule(): Promise<void> {
    // v34 维护模式: 关闸期间一律不出队. v531 续: 不再静默 return —— 队列里
    //   已有任务时逐个标「维护模式」原因 (维护期间用户点「启动」入队的任务
    //   就走这条路径, UI 能看出是关闸挡着而不是调度器坏了), 开闸后由下一轮
    //   schedule / 出队自然清掉.
    if (this.paused) {
      for (const e of this.queue)
        this.markQueuedReason(e.taskId, "维护模式开启, 队列暂停派发");
      return;
    }
    if (this.scheduling) return;
    this.scheduling = true;
    // v510: 每次 schedule() 起首按手动顺序重排此队列. enqueue / reorderQueue
    //   已经即时维护 cache, 这里只是兜底 (跨调用之间万一 cache 与 this.queue
    //   顺序不一致: 例如外部 schedule 触发). 排序代价 O(n log n), n 通常 <30.
    this.sortQueueByOrder();

    try {
      // v531: 全局并发满 → 队列全体标原因. 注意 while 不进还有 queue 空和
      //   !runner 两种, 只在「有队列且并发满」时标.
      if (
        this.queue.length > 0 &&
        this.running.size >= this.maxConcurrency &&
        this.runner
      ) {
        const detail = `全局并发已满 (${this.running.size}/${this.maxConcurrency}), 等待运行中的任务释放槽位`;
        for (const e of this.queue) this.markQueuedReason(e.taskId, detail);
      } else if (this.queue.length > 0 && !this.runner) {
        // v531 续: runner 未挂载 (runtime 还没初始化完) 时 while 也进不去,
        //   此前同样静默. 与上面并发满分支互斥 (那里要求 runner 存在).
        for (const e of this.queue)
          this.markQueuedReason(e.taskId, "调度器尚未就绪 (runner 未挂载)");
      }

      while (
        this.queue.length > 0 &&
        this.running.size < this.maxConcurrency &&
        this.runner
      ) {
        // 内存闸门: 可用内存不足时停止出队 —— 低内存对所有任务一视同仁,
        // 不用逐个 skip, 直接 break (任务全部留 queued, 恢复后自动继续).
        const mem = this.memGate.check();
        if (!mem.ok) {
          if (mem.alertJustTriggered) this.notifyMemPressure(mem, false);
          // v531: 队列全体标原因 (人话, UI 排队卡片直接显示).
          const memDetail = `可用内存 ${mem.memMb}MB 低于阈值 ${mem.thresholdMb}MB, 内存恢复后自动派发`;
          for (const e of this.queue) this.markQueuedReason(e.taskId, memDetail);
          break;
        }
        if (mem.recovered) this.notifyMemPressure(mem, true);

        // Find the first queued task whose cwd isn't held by a running task.
        // Same-cwd tasks must serialize (mutual exclusion); a task whose cwd is
        // busy stays queued and a later task with a free cwd may run first -
        // the blocked entry can't run regardless, so skipping it wastes nothing.
        let pickedIdx = -1;
        for (let i = 0; i < this.queue.length; i++) {
          const t = getTaskById(this.queue[i].taskId);
          // A gone/cancelled entry is "runnable" only so we can shift+skip it
          // below; it never claims a cwd slot.
          if (!t || t.status === "cancelled") {
            pickedIdx = i;
            break;
          }
          // Skip if this task's working directory already has as many running
          // tasks as its project allows (default 1 = mutual exclusion). A later
          // task with a free cwd may run first - the blocked entry can't run
          // regardless.
          const holders = this.busyCwds.get(resolveTaskCwd(t));
          if (holders && holders.size >= this.cwdLimit(t)) {
            // v531: 标原因 (同项目串行互斥). v531 续: 原因带挡路者短 id,
            //   排查时直接知道是哪个任务占着 cwd (plan 思想②).
            const firstHolder = holders.values().next().value;
            const detail =
              holders.size === 1 && firstHolder
                ? `同项目任务 ${TaskScheduler.shortId(firstHolder)} 正在运行 (并行上限 ${this.cwdLimit(t)}), 等待其完成`
                : `同项目已有 ${holders.size} 个任务在运行 (首个 ${firstHolder ? TaskScheduler.shortId(firstHolder) : "?"}, 并行上限 ${this.cwdLimit(t)}), 等待其完成`;
            this.markQueuedReason(t.id, detail);
            continue;
          }
          // DAG P2: when the task's project opts into DAG mode, skip queued
          // tasks whose depends_on is not yet satisfied. Default off (B1) -
          // dag_enforced=false projects keep today's byte-identical behaviour.
          // Defence-in-depth: startTask also throws on unmet deps, so even if
          // this branch is bypassed (e.g. by a manual status flip) the runtime
          // still refuses to actually run the task.
          if (
            t.project_id &&
            getProjectDagEnforced(t.project_id) &&
            !areDependenciesMet(t.id)
          ) {
            // v531: 标原因 (DAG 依赖未满足). v531 续: 带首个未满足依赖的短 id
            //   (判定口径与 areDependenciesMet 一致: 行不存在=未满足, 已删=忽略).
            const unmetDep = getDependencyTaskIds(t.id).find((d) => {
              const dep = getTaskById(d);
              return !dep || (!dep.deleted_at && dep.status !== "completed");
            });
            this.markQueuedReason(
              t.id,
              unmetDep
                ? `依赖的上游任务 ${TaskScheduler.shortId(unmetDep)} 尚未完成 (DAG 模式)`
                : "依赖的上游任务尚未完成 (DAG 模式)",
            );
            continue;
          }
          // Skip if this owner has hit their per-user cap (v30). null owner
          // (system/legacy task) is never capped.
          const ownerLimit = this.getOwnerLimit(t.owner_id);
          if (
            ownerLimit !== null &&
            (this.runningByOwner.get(t.owner_id ?? "") ?? 0) >= ownerLimit
          ) {
            // v531: 标原因 (每用户并发上限).
            this.markQueuedReason(
              t.id,
              `该账号并发已达上限 ${ownerLimit}, 等待该账号任务完成`,
            );
            continue;
          }
          pickedIdx = i;
          break;
        }
        if (pickedIdx === -1) break; // every queued task is blocked (cwd busy or owner capped)

        const entry = this.queue.splice(pickedIdx, 1)[0];
        const { taskId, mode } = entry;
        const task = getTaskById(taskId);

        if (!task || task.status === "cancelled") {
          continue; // Skip cancelled tasks
        }

        // v531: 出队成功, 清排队原因 (UI 不再显示).
        setQueuedReason(taskId, null);

        // Claim the global slot, a cwd slot, and the per-owner count.
        this.running.set(taskId, true);
        const cwd = resolveTaskCwd(task);
        let holders = this.busyCwds.get(cwd);
        if (!holders) {
          holders = new Set();
          this.busyCwds.set(cwd, holders);
        }
        holders.add(taskId);
        const ownerKey = task.owner_id ?? "";
        this.runningOwners.set(taskId, ownerKey);
        this.runningByOwner.set(
          ownerKey,
          (this.runningByOwner.get(ownerKey) ?? 0) + 1,
        );

        // Update status to running
        updateTaskStatus(taskId, "running", {
          started_at: new Date().toISOString(),
        });
        this.statusChangeHandler?.(taskId, task.status, "running");

        // Run the task (non-blocking)
        this.runTask(taskId, mode).catch((err) => {
          console.error(`[TaskScheduler] Error running task ${taskId}:`, err);
        });
      }
    } finally {
      this.scheduling = false;
    }
  }

  // 功能: 内存预警/恢复通知, 发给当前排队任务的 owner (去重; 无 owner 走
  //   mailer 的 NOTIFY_FALLBACK_TO 兜底).
  // 关注点: 去重靠 MemGate 翻转沿 (alertJustTriggered/recovered), 这里不做
  //   二次节流 —— 一次低内存事件最多一对通知; void + catch 永不阻断调度.
  private notifyMemPressure(mem: MemCheckResult, recovered: boolean): void {
    const owners = new Set<string | null>();
    for (const e of this.queue) {
      owners.add(getTaskById(e.taskId)?.owner_id ?? null);
    }
    const instance = process.env.PORT ?? "dev";
    const queued = this.queue.length;
    for (const owner of owners) {
      void sendNotifyToUser(owner, {
        subject: recovered
          ? `[内存恢复] 任务继续派发 (实例 :${instance})`
          : `[内存预警] 可用内存不足, ${queued} 个任务暂停派发 (实例 :${instance})`,
        text: recovered
          ? `可用内存已回到 ${mem.memMb}MB (阈值 ${mem.thresholdMb}MB), 队列中 ${queued} 个任务恢复派发。`
          : `可用内存 ${mem.memMb}MB 低于阈值 ${mem.thresholdMb}MB, ${queued} 个任务暂停派发(留在队列, 内存恢复后自动继续)。常见原因: 任务起了 dev server / 测试进程吃满内存。`,
      }).catch(() => {});
    }
    if (recovered) {
      console.log(
        `[TaskScheduler] 内存恢复: ${mem.memMb}MB >= ${mem.thresholdMb}MB, 恢复出队`,
      );
    } else {
      console.warn(
        `[TaskScheduler] 内存闸门: ${mem.memMb}MB < ${mem.thresholdMb}MB, ${queued} 个任务暂停出队 (通知 ${owners.size} 个 owner)`,
      );
    }
  }

  private async runTask(taskId: string, mode: RunMode): Promise<void> {
    if (!this.runner) return;

    const task = getTaskById(taskId);
    if (!task) {
      this.onTaskDone(taskId);
      return;
    }

    try {
      await this.runner(task, mode);
    } catch (err) {
      console.error(`[TaskScheduler] Task ${taskId} threw:`, err);
      const current = getTaskById(taskId);
      const from = current?.status || "running";
      updateTaskStatus(taskId, "failed", {
        error: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
      });
      // 兜底: runner 异常吞掉 → 标记 task_runner_error 便于排查
      // 区别于 SDK 自己 failTask() 写入的 running → failed (那条不带 reason).
      this.statusChangeHandler?.(taskId, from, "failed", "task_runner_error");
    } finally {
      this.onTaskDone(taskId);
    }
  }
}
