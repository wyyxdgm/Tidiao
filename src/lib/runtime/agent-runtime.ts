// AgentRuntime: central orchestrator singleton

import { ActiveSession, type RunOpts } from "./active-session";
import { TaskScheduler } from "./task-scheduler";
import {
  getTaskById,
  updateTaskStatus,
  updateTask,
  setTaskQueuedOrder,
  getDependentTaskIds,
  getDependencyTaskIds,
  areDependenciesMet,
  listTasks,
  queuePendingMessage,
  drainPendingMessages,
  peekPendingMessages,
  mutateTaskMetadata,
  getTaskTimeoutOverrideMinutes,
} from "../db/tasks";
import { insertEvent, getEventsByTaskId } from "../db/events";
import { createSession } from "../db/sessions";
import { parseDbTime } from "../datetime";
import { insertCheckpoint, getCheckpointsByTaskId } from "../db/checkpoints";
import { getProjectById, getProjectVerificationConfig } from "../db/projects";
import {
  getGlobalTaskTimeoutMinutes,
  getGlobalMaxConcurrency,
  parseTimeoutMinutes,
  resolveVerificationGloballyEnabled,
  getMaxGoalRounds,
  getGoalResumeThreshold,
  MIN_MAX_GOAL_ROUNDS,
  MAX_MAX_GOAL_ROUNDS,
} from "../db/settings";
import { runVerificationCommand } from "./verification-runner";
import {
  getMaintenanceState,
  enterMaintenance as dbEnterMaintenance,
  exitMaintenance as dbExitMaintenance,
  startMaintenanceLog,
  finishMaintenanceLog,
  getOpenMaintenanceLog,
  type MaintenanceState,
  type SuspendedTask,
} from "../db/maintenance";
import {
  getSessionMessages,
  forkSession as forkSdkSession,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Task, AgentEvent, TaskDefinition, TaskStatus } from "./types";
import { dispatchWebhook } from "../webhooks/dispatcher";
import { createTask } from "../db/tasks";
import { runRules } from "./rule-engine";
import {
  loadRunnersFromDb,
  startHeartbeatTick,
} from "../runners/registry";
import {
  notifyParentOfChildStatusChange,
  setupParentNotify,
} from "./parent-notify";
import { notifyTaskTimeout } from "../notify/task-timeout";
import { ORCHESTRATOR_HOME, CLAUDE_CONFIG_DIR } from "../constants";
import { parseStrArray } from "../json-array";
import {
  checkUserQuotaWithCurrent,
  recordQuotaExceededRuntime,
} from "../db/users";
import path from "path";

// 功能: 解析这个 task 的壁钟超时(ms). 优先级链: task 行 override (metadata.timeout_minutes)
//   → project.timeout_minutes → 全局设置 (app_settings.task_timeout_minutes) → 30min.
// 关注点:
//  - 每次 runTask 现查, **不缓存**(同 TaskScheduler.cwdLimit 的判据): 改完配置
//    下一次 start/resume 就生效, 不用重启。代价是已在跑的任务不会重挂定时器 ——
//    它按启动那一刻解析出的值超时, 想中途改要用 setTaskTimeout() 显式重挂。
//  - task override 来自 metadata JSON (snake_case `timeout_minutes`), 由
//    getTaskTimeoutOverrideMinutes() 校验后读出. 脏值 (非整数/字符串/0) 一律视为未设.
//  - project_id 为 NULL 的系统任务(intake / 定时任务派的无项目任务)走全局值。
//  - 库里的脏值(手工 SQL 写进 0 / 非整数)由 parseTimeoutMinutes 判掉并回退全局值,
//    绝不允许算出 0 或 NaN —— setTimeout(0) 等于任务一起来就被挂起。
// (export 只为回归测试 global-settings.test.ts + task-timeout-override.test.ts,
//  生产只有 runTask / emitEvent 两个调用方)
// 🆕 DAG P3 (B2/B3 拍板 2026-09-05): 把 verification 失败结果格式化成给 agent
//   看的反馈文本. 在 _approveTaskWithVerification 的失败分支被调用.
//   关注点:
//   - stdout / stderr 各自截断 2KB (反馈上下文比完整日志长, 易爆库).
//   - attempt / max_attempts 让 agent 知道还有几次机会.
//   - timed_out 单独标出, 让 agent 看到「命令逻辑 vs 单纯挂住」的区分.
function formatVerificationFailureFeedback(
  result: { exit_code: number; stdout: string; stderr: string; duration_ms: number; timed_out: boolean },
  attempt: number,
  maxAttempts: number,
): string {
  const lines: string[] = [];
  lines.push(
    `[机械验收门] 第 ${attempt}/${maxAttempts} 次尝试失败 (exit=${result.exit_code}, timed_out=${result.timed_out}, duration=${result.duration_ms}ms)。`,
  );
  if (maxAttempts - attempt > 0) {
    lines.push(`还有 ${maxAttempts - attempt} 次重试机会, 请修复后重跑, 平台会自动拉起重试。`);
  } else {
    lines.push(`已达最大重试次数, 任务将翻为 failed。请人工排查。`);
  }
  if (result.stdout.trim()) {
    lines.push(`--- stdout (前 2KB) ---`);
    lines.push(result.stdout.slice(0, 2048));
  }
  if (result.stderr.trim()) {
    lines.push(`--- stderr (前 2KB) ---`);
    lines.push(result.stderr.slice(0, 2048));
  }
  return lines.join("\n");
}

// Goal-driven loop 阶段 3 (D20, damo 2026-09-14 拍板) — 漏洞 #3 + D15:
//   机械验收失败 → task 回退 running → 注入反馈. 当 task 携 <goal> marker
//   (task.metadata.goal_text 已被 active-session 启动解析时写入) 时, 给反馈
//   文本追加 goal_history 引用 + 当前 goal, 让 agent 看到:
//   1) 上一轮 goal grader 的评判 (not_yet_met / met) + reason
//   2) 上一轮 verification 失败 + 当前 goal 重述, 避免「回退到 running 后
//      又把同一目标当新尝试」. 两层 gate (语义 + 编译) 嵌套注入, 缓解双向
//      注入循环.
// 关注点:
//   - task 没 goal_text → 原 feedback 不变, 行为 byte-identical.
//   - goal_history 是数组, 阶段 3 还没 cap (阶段 4 continueGoalLoop 加
//     20 条 cap, 见 plan §9.5 漏洞 #2). 这里防御性 slice(0, 3) 只取最近
//     3 条避免爆库 + UI 噪声.
//   - 单写者路径: 反馈拼接发生在 _approveTaskWithVerification (post-approve
//     收窄路径, 平台代理), 不与 active-session 写 goal_history 抢资源.
function appendGoalContextToFeedback(feedback: string, task: Task): string {
  let goalText: string | null = null;
  let goalHistory: Array<{ round: number; verdict: string; reason: string; at?: string }> = [];
  if (task.metadata) {
    try {
      const parsed = JSON.parse(task.metadata);
      if (typeof parsed?.goal_text === "string" && parsed.goal_text.trim().length > 0) {
        goalText = parsed.goal_text.trim();
      }
      if (Array.isArray(parsed?.goal_history)) {
        goalHistory = parsed.goal_history
          .filter(
            (e: unknown): e is { round: number; verdict: string; reason: string; at?: string } =>
              typeof e === "object" &&
              e !== null &&
              typeof (e as Record<string, unknown>).verdict === "string" &&
              typeof (e as Record<string, unknown>).reason === "string",
          )
          .slice(-3);
      }
    } catch {
      // 旧脏 metadata 不阻断, 视为无 goal context.
    }
  }
  if (!goalText) return feedback;

  const lines: string[] = [feedback];
  if (goalHistory.length > 0) {
    lines.push("");
    lines.push("[Goal history (reference only)]");
    for (const h of goalHistory) {
      lines.push(
        `- round ${h.round}: verdict=${h.verdict}, reason="${h.reason}"${h.at ? ` @ ${h.at}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("[Current goal]");
  lines.push(goalText);
  return lines.join("\n");
}

/**
 * 解析 task 的壁钟超时 (ms). 解析链: task 行 override → project 行 → app_settings 全局 → 30min 默认.
 *
 * @requirement 飞书 R40
 * @feature task-timeout
 * @module runtime
 * @see-exclusive src/lib/runtime/agent-runtime.ts:113 getTaskTimeoutOverrideMinutes
 * @see-info docs/config-resolution.md §3.5
 */
export function resolveTaskTimeoutMs(task: Task): number {
  // 1) task 行 override 最高优先级
  const taskOverride = getTaskTimeoutOverrideMinutes(task);
  if (taskOverride !== null) return taskOverride * 60 * 1000;
  // 2) project → 3) 全局
  let minutes: number | null = null;
  if (task.project_id) {
    const raw = getProjectById(task.project_id)?.timeout_minutes ?? null;
    if (raw !== null) {
      minutes = parseTimeoutMinutes(raw);
      if (minutes === null) {
        console.warn(
          `[AgentRuntime] project ${task.project_id} 的 timeout_minutes=${raw} 非法, 回退全局默认`,
        );
      }
    }
  }
  if (minutes === null) minutes = getGlobalTaskTimeoutMinutes();
  return minutes * 60 * 1000;
}

// 功能: 进程启动时的全局并发上限 = app_settings.max_concurrency, 缺省 2(见 db/settings.ts).
// 关注点: v39 起 PATCH /api/config 会把并发**落库**, 所以 pm2 restart 后回到的是
//   上次保存的值, 不再回落到 2。

// Map terminal/lifecycle task statuses to webhook events. All status
// transitions funnel through AgentRuntime.emitEvent(), so dispatching here
// covers started/completed/failed/cancelled from every origin (scheduler,
// ActiveSession, runtime methods). task.created is dispatched separately in
// createTask(). Note: a task finishing naturally lands in "reviewing", not
// "completed" - "completed" only fires after manual approve.
//   🆕 R131 (damo 2026-09-15): await_user 加进 webhook 事件表 (等用户介入 = 新
//   在飞状态, 外部订阅者可监听).
//   ⚠️ rejected 已从 in-flight 状态流转移除 (reviewing 不能再转 rejected),
//   但保留作为历史兼容: 旧 task 重启到 running 时不会发 task.rejected, 仅
//   历史数据曾触发过的事件保留接口契约.
const STATUS_TO_WEBHOOK: Partial<
  Record<
    TaskStatus,
    | "task.started"
    | "task.reviewing"
    | "task.completed"
    | "task.failed"
    | "task.cancelled"
    | "task.await_user"
  >
> = {
  running: "task.started",
  reviewing: "task.reviewing",
  completed: "task.completed",
  failed: "task.failed",
  cancelled: "task.cancelled",
  await_user: "task.await_user",
};

type EventSubscriber = (event: AgentEvent) => void;

// 功能: 兜底 next dev 进程里残余的 uncaughtException / unhandledRejection,
//   不 process.exit —— pm2 autorestart + recoverOrphanedTasks 会把 running
//   task 标 paused, 用户感知是"task 莫名其妙被暂停"。保持进程存活 + 详细 log,
//   出真问题再人工重启。
// 关注点:
//   - 必须 listener 唯一 (用 module-level boolean 守门), 否则 HMR / 模块重载会重复注册
//   - 捕获后不能 throw / 不能 async 操作 — 否则 Node 会再次 fatal
//   - 不要拦 SIGTERM / SIGINT — 那是 pm2 正常 stop 信号, 要让进程正常退出
let uncaughtHandlersInstalled = false;

function installUncaughtHandlers(): void {
  if (uncaughtHandlersInstalled) return;
  uncaughtHandlersInstalled = true;
  process.on("uncaughtException", (err) => {
    console.error(`[AgentRuntime] uncaughtException (would have exited):`, err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(
      `[AgentRuntime] unhandledRejection (would have exited):`,
      reason,
    );
  });
}

export class AgentRuntime {
  private scheduler: TaskScheduler;
  private sessions: Map<string, ActiveSession> = new Map(); // taskId → ActiveSession
  private subscribers: Map<string, Set<EventSubscriber>> = new Map(); // taskId → callbacks
  private projectSubscribers: Map<string, Set<EventSubscriber>> = new Map(); // projectId → callbacks
  private globalSubscribers: Set<EventSubscriber> = new Set(); // 全局看板: 收所有任务的 status_change/cost
  private initialized = false;
  private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Send-time overrides (model/effort/max_turns) staged by startTask/resume/
  // restart/sendUserMessage and consumed by runTask when it builds the
  // ActiveSession. Cleared on consume and on cancel. Keeps the scheduler's
  // QueueEntry {taskId, mode} untouched.
  private pendingOverrides: Map<string, RunOpts> = new Map();
  // v53: 当前维护会话对应的 maintenance_log 行 id. enter 时赋值, exit 时消费.
  //   进程重启会丢 -> 见 initialize() 里 getOpenMaintenanceLog() 兜底.
  private currentMaintenanceLogId: number | null = null;

  constructor() {
    this.scheduler = new TaskScheduler(getGlobalMaxConcurrency());
    this.scheduler.setRunner(this.runTask.bind(this));
    this.scheduler.setStatusChangeHandler((taskId, from, to, reason) => {
      this.emitEvent(taskId, {
        type: "status_change",
        task_id: taskId,
        from,
        to,
        reason,
      });
    });
    // After a task finishes and its scheduler slot is freed, drain any messages
    // that arrived during the session-teardown window (closed=true but not yet
    // removed from this.sessions). Those were routed to the durable
    // pending_messages queue; a resume here replays them as real SDK turns.
    this.scheduler.setOnTaskDone((taskId) =>
      this.maybeDrainStrandedMessages(taskId),
    );
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    // Force CLAUDE_CONFIG_DIR to match what ActiveSession.buildEnv() sets for
    // SDK subprocesses. Without this, SDK functions like getSessionMessages
    // and forkSession (which run in the server process, not a subprocess) look
    // in the wrong directory and fail with "Session not found".
    // Always override: a stale env var from a previous deployment (e.g. pm2
    // inheriting ~/.agent-orchestrator-dev/claude-config from the shell that
    // started it) is worse than no value at all — the guard `if (!…)` silently
    // accepts the wrong path, causing getSessionHistory to return 0 SDK messages
    // and forkSession to fail with "upToMessageId not found".
    if (process.env.CLAUDE_CONFIG_DIR !== CLAUDE_CONFIG_DIR) {
      if (process.env.CLAUDE_CONFIG_DIR) {
        console.warn(
          `[AgentRuntime] CLAUDE_CONFIG_DIR mismatch: env=${process.env.CLAUDE_CONFIG_DIR}, expected=${CLAUDE_CONFIG_DIR} — overriding`,
        );
      }
      process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
    }
    // v34: 重启后自己认出「我还在维护中」. 必须在 recoverOrphanedTasks 之前
    // 关闸: 后者会把残留 queued 改回 pending, 而任何后续 enqueue 都不该真的
    // 放任务出去, 直到 exitMaintenance 被显式调用.
    if (getMaintenanceState().active) {
      this.scheduler.setPaused(true);
      console.log("[AgentRuntime] 维护模式生效中 — 调度器已关闸, 不放新任务");
    }
    // v53: 重启后找回 currentMaintenanceLogId, 并兜底收尾异常中断的 log 行.
    //   正常 enter/exit 都走内存字段, 这里只覆盖 3 种异常: 1) enter 后进程死掉
    //   没 exit; 2) state 已被外部清掉 (active=0) 但 log 还 ended_at=NULL; 3) state
    //   仍 active 且 log 已 ended (极少见 —— 进程写到一半挂掉). 一律当作 'aborted'.
    const openLog = getOpenMaintenanceLog();
    if (openLog) {
      this.currentMaintenanceLogId = openLog.id;
      if (!getMaintenanceState().active || openLog.ended_at) {
        finishMaintenanceLog({
          id: openLog.id,
          ended_by: null,
          result: "aborted",
        });
        this.currentMaintenanceLogId = null;
      }
    }
    // R3: 把 DB 里所有 runner 加载到内存 Map + 启动 30s heartbeat tick
    //   (标 offline/dead). 必须在 recoverOrphanedTasks 之前, 后者会跑
    //   canUseTool; 期间如果有 task 试图走 runner, registry 必须就绪.
    // 注意: loadRunnersFromDb 在 ENCRYPTION_KEY 漂了的情况下跳过坏的行
    //   并 markRunnerDead, 不会让 server 启动失败.
    loadRunnersFromDb();
    startHeartbeatTick();
    this.recoverOrphanedTasks();
    installUncaughtHandlers();
    console.log("[AgentRuntime] Initialized");
  }

  // 功能: 当前是否处于维护模式(读库). 供 instrumentation 决定是否启动
  //   ScheduleRunner —— 维护中不启动, 否则 60s 轮询会在关停期间造新任务.
  isMaintenanceActive(): boolean {
    return getMaintenanceState().active;
  }

  // On startup, move any tasks stuck in running/queued back to paused/pending
  // (they were interrupted by a server restart)
  private recoverOrphanedTasks(): void {
    const allTasks = listTasks();
    let recovered = 0;
    for (const task of allTasks) {
      if (task.status === "running") {
        // Running tasks lost their SDK process — move to paused so user can resume
        updateTaskStatus(task.id, "paused", {
          session_id: task.session_id || undefined,
        });
        insertEvent({
          task_id: task.id,
          type: "status_change",
          data: JSON.stringify({
            from: "running",
            to: "paused",
            reason: "server_restart",
            source: "auto",
          }),
        });
        recovered++;
      } else if (task.status === "queued") {
        // Queued tasks can be re-queued. Fork tasks (forked_from_session_id
        // is set) must be re-enqueued with mode="fork" so the scheduler calls
        // session.resume() instead of session.start() — the SDK session
        // already exists from the fork.
        //
        // R155: 普通 queued 任务 (例如 sendUserMessage 推 reviewing → queued)
        // 也应按 resume 模式入队 — 否则 server_restart 把 task 降级为 pending
        // 后, task 700d5434 实测 metadata.pending_messages 里的消息永远等不到
        // 消费. 守门条件: session_id 必须存在 (没 session 可 resume 的 task 走
        // 另一条路径, 等用户手动启动).
        const isFork = !!task.forked_from_session_id;
        const hasSession = !!task.session_id;
        updateTaskStatus(task.id, "pending");
        insertEvent({
          task_id: task.id,
          type: "status_change",
          data: JSON.stringify({
            from: "queued",
            to: "pending",
            reason: "server_restart",
          }),
        });
        if (hasSession) {
          this.scheduler.enqueue(task.id, isFork ? "fork" : "resume", "server_restart");
        } else {
          // damo 2026-10-13 (GDM 4 条 pending 躺平实证): start 过但还没起
          // session 的 queued 任务, 重启翻回 pending 后原来不入队 —— 调度队列
          // 是内存态, 重启清空后无人认领 = 永久 pending. 用户显式 start 过 =
          // 意图明确, 按 start 重新入队 (DAG 未满足由 scheduler 闸门继续挡,
          // 不会误跑). 创建后从未 start 的 pending 是预期等待, 不在此分支.
          this.scheduler.enqueue(task.id, "start", "server_restart");
        }
        recovered++;
      }
    }
    if (recovered > 0) {
      console.log(
        `[AgentRuntime] Recovered ${recovered} orphaned tasks on startup`,
      );
    }
  }

  // ---- Task Lifecycle ----

  // Create a task (just saves to DB, doesn't start it)
  createTask(def: TaskDefinition): Task {
    const task = createTask(def);
    dispatchWebhook("task.created", task);
    return task;
  }

  // Start a task (enqueue for scheduling)
  // 🆕 R131 (damo 2026-09-15): await_user 加入 startTask 允许列表 (用户拍板后
  //   直接 enqueue 即可继续, 与 paused 走相同 resume 模式).
  startTask(taskId: string, opts?: RunOpts, reason?: string): void {
    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (
      task.status !== "pending" &&
      task.status !== "paused" &&
      task.status !== "failed" &&
      task.status !== "rejected" &&
      task.status !== "cancelled" &&
      task.status !== "completed" &&
      task.status !== "reviewing" &&
      task.status !== "await_user"
    ) {
      throw new Error(`Cannot start task in status: ${task.status}`);
    }
    // Check dependencies (only for pending tasks, not resumed ones)
    if (task.status === "pending" && !areDependenciesMet(taskId)) {
      const depIds = getDependencyTaskIds(taskId);
      const unmet = depIds.filter((id) => {
        const t = getTaskById(id);
        return !t || t.status !== "completed";
      });
      throw new Error(`Dependencies not met: ${unmet.join(", ")}`);
    }
    // Rejected/cancelled/completed/reviewing/paused/await_user tasks have an
    // existing session_id — resume it (preserving transcript history) rather
    // than starting a brand-new session. Use restartTask() for "清空重来"
    // (clear session_id, start fresh).
    const hasExistingSession =
      (task.status === "rejected" ||
        task.status === "cancelled" ||
        task.status === "completed" ||
        task.status === "reviewing" ||
        task.status === "paused" ||
        task.status === "await_user") &&
      task.session_id;
    const mode = hasExistingSession ? "resume" : "start";
    if (opts) this.pendingOverrides.set(taskId, opts);
    this.scheduler.enqueue(taskId, mode, reason);
  }

  // Restart a task from scratch (清空重来) — clears session_id so a brand-new
  // SDK session is created with only the original prompt, no transcript history.
  // 🆕 R131 (damo 2026-09-15): await_user 加入 restartTask 允许列表 (reviewing
  //   改走 refine 后, agent 可以走 restart 路径清空重来).
  restartTask(
    taskId: string,
    opts?: RunOpts,
    reason: string = "restart",
  ): void {
    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (
      task.status !== "failed" &&
      task.status !== "cancelled" &&
      task.status !== "completed" &&
      task.status !== "reviewing" &&
      task.status !== "rejected" &&
      task.status !== "await_user"
    ) {
      throw new Error(`Cannot restart task in status: ${task.status}`);
    }
    // Clear session_id so startTask() will use "start" mode (fresh session)
    updateTask(taskId, { session_id: null });
    if (opts) this.pendingOverrides.set(taskId, opts);
    this.scheduler.enqueue(taskId, "start", reason);
  }

  // 功能: 会话被打断时取「能给出的最好花费数」并把来源标记落进 metadata,
  //   返回给 updateTaskStatus 的 { cost_usd } 片段。
  // 关注点:
  //   🔴 恒返回带 cost_usd 的对象, 绝不返回 {} —— 旧实现是 `cost > 0 ? {...} : {}`,
  //     而 total_cost_usd 只在 result 消息上出现、被中断的会话永远走不到 result,
  //     所以那个判据在真实中断路径上恒假 = cost_usd 永久留 NULL(实测 14 天 16 条)。
  //     NULL 比估算值危险: 丢账的那些天在用量面板上会显示成「最便宜的天」。
  //   - source 落 tasks.metadata.cost_source, 不改 schema; 走 mutateTaskMetadata
  //     以免整块 JSON 覆盖抹掉别人刚写的键。
  //   - 估算值不覆盖库里已有的实测值(resume 之前那轮可能已记过真实账单)。
  private snapshotCost(
    taskId: string,
    session: {
      getCostSnapshot(): { cost: number; source: "measured" | "estimated" | "priced" };
      getTokenUsage?(): {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
    },
  ): { cost_usd: number } | Record<string, never> {
    const { cost, source } = session.getCostSnapshot();
    if (source === "estimated") {
      const existing = getTaskById(taskId);
      // 库里已有实测值就别用估算去盖它
      if (existing?.cost_usd != null && existing.cost_usd > 0) {
        const metaSource = (() => {
          try {
            return existing.metadata
              ? JSON.parse(existing.metadata).cost_source
              : null;
          } catch {
            return null;
          }
        })();
        if (metaSource !== "estimated") return {};
      }
    }
    mutateTaskMetadata(taskId, (meta) => {
      meta.cost_source = source;
      // estimated/priced 都带 token 明细 (审计可复算; measured 是 SDK 整单账单, 无明细)
      if ((source === "estimated" || source === "priced") && session.getTokenUsage) {
        meta.cost_tokens = session.getTokenUsage();
      }
    });
    return { cost_usd: cost };
  }

  // Cancel a task
  async cancelTask(
    taskId: string,
    source: "manual" | "auto" = "manual",
  ): Promise<void> {
    // Clear timeout timer
    const timer = this.timeoutTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(taskId);
    }

    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Idempotent: 已经是 cancelled 状态时, 重复 cancel 不重写 completed_at
    // (避免刷新「已取消」时间戳造成时间线反复更新). sessions 不存在时同样 no-op.
    if (task.status === "cancelled" && !this.sessions.has(taskId)) {
      return;
    }

    const session = this.sessions.get(taskId);
    // 打断前先把已累计的花费抓下来. close() / interrupt() 都不重置 costUsd,
    // 所以放在 close 之后读也拿得到, 但顺序上不依赖这点更稳妥.
    let costExtra: { cost_usd?: number } = {};
    if (session) {
      // 2026-08-22 task e43eeb0d: SDK Query.close() 只 end stdin, subprocess 在
      // sleep/bash 等长 tool 完成前还能 emit 缓冲消息甚至 result. mark 先于
      // interrupt/close 同步置位, for-await 循环下一轮迭代 drop 后续消息 —
      // 否则会继续向 SSE 推内容、且 result 分支会覆盖 cancelled 状态回 reviewing.
      session.markExternallyTerminated();
      await session.interrupt();
      await session.close();
      costExtra = this.snapshotCost(taskId, session);
      this.sessions.delete(taskId);
    }
    this.scheduler.dequeue(taskId);
    // Release the running slot + cwd lock now - don't wait for the runner to
    // finish, which may lag minutes if the SDK session doesn't interrupt
    // promptly. Without this, a cancelled task holds its cwd lock until the
    // runner winds down, blocking same-cwd tasks (e.g. a fork).
    this.scheduler.releaseSlot(taskId);
    this.pendingOverrides.delete(taskId);

    // R88 quota 双保险 (Sheet L 验收 ⑥): cancel 时 cost_usd 即将落库, 此时再
    //   算一次"含本次成本"是否触 cap. 超 cap → 改为 failed + 写 log, 而不是
    //   走 cancelled (避免"任务取消 + 已扣费"看起来像用户主动放弃).
    //   检查前 cancel 的会话已经把 cost 抓下来了, currentCost=0 表示没跑
    //   (没 session 或 session 已结束), 直接放行进 cancelled 路径.
    if (task.owner_id && (costExtra.cost_usd ?? 0) > 0) {
      const q = checkUserQuotaWithCurrent(
        task.owner_id,
        costExtra.cost_usd ?? 0,
      );
      if (!q.allowed) {
        recordQuotaExceededRuntime(
          task.owner_id,
          costExtra.cost_usd ?? 0,
          q.detail ?? "quota exceeded",
        );
        updateTaskStatus(taskId, "failed", {
          completed_at: new Date().toISOString(),
          error: `quota_exceeded: ${q.detail ?? ""}`,
          ...costExtra,
        });
        this.emitEvent(taskId, {
          type: "status_change",
          task_id: taskId,
          from: task.status,
          to: "failed",
          source,
        });
        return;
      }
    }

    updateTaskStatus(taskId, "cancelled", {
      completed_at: new Date().toISOString(),
      ...costExtra,
    });
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: task.status,
      to: "cancelled",
      source,
    });
  }

  // Dequeue a queued task — pull it OUT of scheduler.queue and flip DB back
  // to pending. 与 cancel 不同: 不删 session_id、不算终止态, 任务保留, 用户
  // 后续可以重新 start (走默认 startTask 路径). 与 R155 server_restart 恢复
  // 路径同源 (queued → pending), reason 字段标 "manual_dequeue" 区分
  // (区别于其它 queued → pending 触发源, 比如 dequeueTask vs 调度器自动拉起).
  //
  // 🆕 R162 (damo 2026-09-22): 看板拖拽支持 queued → pending, 走本方法.
  //   典型场景: 用户改变主意, 想让该 task 不要随槽位空闲自动跑, 但又不想
  //   取消 (cancel 终态; 后续需要 restart 才能再跑). dequeue 后 task 留在
  //   pending, 后续直接拖到 running 或拖回 queued 列 (走 start) 即可重跑.
  //   queued_order 主动清空, 避免 re-queue 时按旧位置插队 (用户拖它出队的
  //   那一刻就是"重新决定顺序"的信号, 让 re-queue 走 MAX+1 落到队尾更直觉).
  //   守护: 状态 ≠ queued → 抛错, 避免与 cancel/approve 等其它动作串改.
  //   Idempotency: 同 queued 状态重复调, 幂等 (scheduler.dequeue 内部 filter
  //   去重, updateTaskStatus 写同值; emitEvent 仍发, 状态变化链完整).
  //   source="manual" + reason="manual_dequeue" 遵循 types.ts:294-306 约定
  //   (source 控制 UI 响铃, reason 携带语义标签供 timeline 排查).
  dequeueTask(taskId: string): void {
    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "queued") {
      throw new Error(`Cannot dequeue task in status: ${task.status}`);
    }

    this.scheduler.dequeue(taskId);
    // 清掉手动排序 — 用户把它拖出队列 = 重新决定顺序的信号, 再入队时按
    //   MAX+1 排到队尾, 比按旧 order 插回去更符合直觉 (旧位置可能已被
    //   其它 task 占用). 与 task-scheduler.ts enqueue() 路径保持一致.
    setTaskQueuedOrder(taskId, null);
    updateTaskStatus(taskId, "pending");
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: "queued",
      to: "pending",
      source: "manual",
      reason: "manual_dequeue",
    });
  }

  // Pause a running task
  //
  // forMaintenance (R34-v128): 维护模式下的 pause 走更温和的 fallback 链.
  //   手动 pause 默认行为不变 —— session_id 尚未分配的任务 = failed(用户
  //   立即知道"这次不能续"); 维护模式则改为 pending(交给 startTask 重新入
  //   队, 状态干净, 不会留 paused + session_id 空的奇怪态). 这俩场景语义
  //   完全不同, 不能共用一条路径.
  async pauseTask(
    taskId: string,
    source: "manual" | "auto" = "manual",
    forMaintenance: boolean = false,
  ): Promise<void> {
    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const session = this.sessions.get(taskId);

    // Idempotent: 任务已经是 paused 状态, 重复点暂停是 no-op.
    // 用户刷新页面 / 重连 SSE 后点「暂停」属于这类(2026-08-22 task
    // e43eeb0d-... 反复 pause 报错根因).
    if (task.status === "paused") {
      return;
    }

    // sessions 已不在(已结束 / 服务端刚重启 / SSE 没推到位)且任务不在 running:
    // 用户的「暂停」意图对当前状态没有意义, 静默 no-op.
    // 关注点: 不抛错是因为前端按钮可能 stale —— 用户看到 running 但 SSE 没推下来
    //   时再点暂停, 不应该弹一条 red toast. warn 一行留痕便于排查.
    if (!session && task.status !== "running") {
      console.warn(
        `[AgentRuntime] pauseTask no-op: task ${taskId} status=${task.status} but no active session`,
      );
      return;
    }

    // sessions 缺失但 task.status 仍是 running —— 说明 agent SDK 已走到 finally
    // 把 sessions.delete 调了, 但 status 写入和 emitEvent 之间发生了断链 / 服务
    // 端刚重启. 这种情况下保留 session_id 把 status 直接补成 paused, 让用户能
    // resume 续上下文(不能像 cancelTask 那样一刀切).
    if (!session) {
      console.warn(
        `[AgentRuntime] pauseTask leak-fix: task ${taskId} status=running but no active session; promoting to paused`,
      );
      this.scheduler.releaseSlot(taskId);
      const preservedSessionId = task.session_id || undefined;
      if (!preservedSessionId) {
        // 维护模式兜底: session_id 未分配 → 直接回 pending, 让 exit 时
        // startTask 重新入队(状态干净);手动 pause 仍走 failed(用户场景
        // 下立即反馈"这次不能续"更重要).
        if (forMaintenance) {
          updateTaskStatus(taskId, "pending", {
            error: null,
            completed_at: null,
          });
          this.emitEvent(taskId, {
            type: "status_change",
            task_id: taskId,
            from: "running",
            to: "pending",
            source,
            reason: "maintenance_no_session",
          });
          return;
        }
        updateTaskStatus(taskId, "failed", {
          error: "Paused before SDK session_id was assigned; cannot resume.",
          completed_at: new Date().toISOString(),
        });
        this.emitEvent(taskId, {
          type: "status_change",
          task_id: taskId,
          from: "running",
          to: "failed",
          source,
        });
        return;
      }
      updateTaskStatus(taskId, "paused", { session_id: preservedSessionId });
      this.emitEvent(taskId, {
        type: "status_change",
        task_id: taskId,
        from: "running",
        to: "paused",
        source,
      });
      return;
    }

    // mark 必须在 interrupt() 之前同步置位, 否则 for-await 循环下次迭代前
    // 仍可能 dispatch 一条 buffered message, 触发 SSE 推内容 (task e43eeb0d
    // 回归实测). 详见 ActiveSession.externallyTerminated 注释.
    session.markExternallyTerminated();
    await session.interrupt();
    await session.close();
    // 同 cancelTask: 打断的会话不会再走 result 消息, 花费只能从内存里取.
    const costExtra = this.snapshotCost(taskId, session);
    this.sessions.delete(taskId);
    // Release the running slot + cwd lock now - don't wait for the runner to
    // finish (see cancelTask). Same-cwd tasks shouldn't be blocked while the
    // interrupted session winds down.
    this.scheduler.releaseSlot(taskId);

    // R88 quota 双保险 (Sheet L 验收 ⑥): pause 也走 cost_usd 落库路径, 与 cancel
    //   同套逻辑 —— 超 cap → failed 而非 paused, 避免"任务暂停 + 已扣费"被误读.
    //   session_id 缺失那种 no-op 失败下面会另外处理, 这里只挡配额.
    if (task.owner_id && (costExtra.cost_usd ?? 0) > 0) {
      const q = checkUserQuotaWithCurrent(
        task.owner_id,
        costExtra.cost_usd ?? 0,
      );
      if (!q.allowed) {
        recordQuotaExceededRuntime(
          task.owner_id,
          costExtra.cost_usd ?? 0,
          q.detail ?? "quota exceeded",
        );
        updateTaskStatus(taskId, "failed", {
          completed_at: new Date().toISOString(),
          error: `quota_exceeded: ${q.detail ?? ""}`,
          ...costExtra,
        });
        this.emitEvent(taskId, {
          type: "status_change",
          task_id: taskId,
          from: task.status,
          to: "failed",
          source,
        });
        return;
      }
    }

    // Preserve the SDK session_id if it has been assigned. If the agent
    // hadn't produced its first assistant message yet, getSessionId() returns
    // null — in that case we cannot resume later (no SDK transcript to load),
    // so we mark the task failed instead of pretending we can resume it.
    // This is much better than silently dropping the session_id and breaking
    // a later resume() with "no session_id on task".
    const liveSessionId = session.getSessionId();
    const preservedSessionId = liveSessionId || task.session_id || undefined;
    if (!preservedSessionId) {
      updateTaskStatus(taskId, "failed", {
        error: "Paused before SDK session_id was assigned; cannot resume.",
        completed_at: new Date().toISOString(),
        ...costExtra,
      });
      this.emitEvent(taskId, {
        type: "status_change",
        task_id: taskId,
        from: "running",
        to: "failed",
        source,
      });
      return;
    }
    // 功能: 把「已投给模型但模型一个字都没回」的那条指令回填进 pending_messages,
    //   下次 resume 重新投递.
    // 关注点: 必须在 updateTaskStatus 之前(只是习惯上把队列写在状态之前, 无竞态);
    //   不回填的话这条指令实际就丢了 —— transcript 里它带着
    //   [Request interrupted by user] 标记, 模型会读成「用户叫我别做了」, 而
    //   resume 侧只会补一条「继续」, 没人再提那条指令(2026-08-11 task 9b812564:
    //   发消息 19s 后 pause, 恢复后 agent 零输出干等 5min)。
    //   模型已经开口的不回填(见 takeUnansweredUserTurn), 避免重做已做的活.
    const unanswered = session.takeUnansweredUserTurn();
    if (unanswered) this.queuePendingMessage(taskId, unanswered);
    updateTaskStatus(taskId, "paused", {
      session_id: preservedSessionId,
      ...costExtra,
    });
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: "running",
      to: "paused",
      source,
    });
  }

  // Resume a paused task
  resumeTask(taskId: string, opts?: RunOpts, reason?: string): void {
    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "paused")
      throw new Error(`Cannot resume task in status: ${task.status}`);

    if (opts) this.pendingOverrides.set(taskId, opts);
    this.scheduler.enqueue(taskId, "resume", reason);
  }

  // ---- 维护模式 (v34): 部署前有序关停 -> 部署 -> 恢复 ----

  // 功能: 进入维护模式. 关调度闸门 + 停定时轮询 + 摘下排队任务 + pause 全部
  //   running(保住 session_id 以便恢复时续上下文), 最后把挂起清单落库.
  //   幂等: 已在维护中直接返回当前状态, 不重复 pause(部署脚本重跑安全).
  // 关注点:
  //   - 顺序有讲究: 必须先关闸再 pause, 否则 pause 释放的槽位会立刻被队列里
  //     的下一个任务填上, 关停永远收不了尾.
  //   - 落库放最后: 前面都做完才标记, 中途崩溃不会留下「以为已关停」的假状态.
  //   - 逐个 try/catch: 一个任务 pause 失败不阻断其余. pauseTask 在 session_id
  //     尚未分配时会把任务标成 failed(既有行为), 这类如实记进 failed 返回.
  async enterMaintenance(
    opts: { by?: string | null; reason?: string | null } = {},
  ): Promise<{
    already: boolean;
    paused: string[];
    dequeued: string[];
    failed: Array<{ task_id: string; error: string }>;
    state: MaintenanceState;
  }> {
    const existing = getMaintenanceState();
    if (existing.active) {
      return {
        already: true,
        paused: existing.suspended
          .filter((s) => s.prev_status === "running")
          .map((s) => s.task_id),
        dequeued: existing.suspended
          .filter((s) => s.prev_status === "queued")
          .map((s) => s.task_id),
        failed: [],
        state: existing,
      };
    }

    // 1. 先关闸 —— 之后 pause 释放的槽位不会被队列里的任务填上
    this.scheduler.setPaused(true);

    // 2. 停 60s 轮询, 别在关停中途 fireAgent 造出新任务
    const { stopScheduleRunner } = await import("./schedule-runner");
    stopScheduleRunner();

    // 3. 摘下排队任务, 状态从 queued 改回 pending
    const dequeued = this.scheduler.drainQueue();
    for (const taskId of dequeued) {
      const task = getTaskById(taskId);
      if (task && task.status === "queued") {
        updateTaskStatus(taskId, "pending");
        insertEvent({
          task_id: taskId,
          type: "status_change",
          data: JSON.stringify({
            from: "queued",
            to: "pending",
            reason: "maintenance_enter",
            source: "auto",
          }),
        });
      }
    }

    // 4a. 预先处理 session_id 尚未分配的任务 (R34-v128 fix):
    //     维护模式下, 还没分到 session_id 的"running"任务 = pending 而非 failed.
    //     走 pending 后, exit 时通过 startTask 重新入队, 状态干净;手动 pause
    //     仍走 failed(由 forMaintenance=false 的 pauseTask 兜底).
    //     这一类任务的 prev_status 在维护语义里也归 "queued"(原本就没真正
    //     跑起来过, 跟 dequeued 路径在恢复时走同一支 startTask).
    const preFilteredPending: string[] = [];
    for (const taskId of [...this.sessions.keys()]) {
      const session = this.sessions.get(taskId);
      const task = getTaskById(taskId);
      if (!session || !task) continue;
      const liveSessionId = session.getSessionId?.() ?? null;
      const persistedSessionId = task.session_id;
      if (!liveSessionId && !persistedSessionId) {
        // session_id 尚未分配 —— 直接 pending, 不走 pauseTask 的 failed 分支
        updateTaskStatus(taskId, "pending", {
          error: null,
          completed_at: null,
        });
        insertEvent({
          task_id: taskId,
          type: "status_change",
          data: JSON.stringify({
            from: "running",
            to: "pending",
            reason: "maintenance_enter_no_session",
            source: "auto",
          }),
        });
        this.scheduler.releaseSlot(taskId);
        this.sessions.delete(taskId);
        preFilteredPending.push(taskId);
      }
    }

    // 4b. pause 剩余的 running —— 都有 session_id 可保住,forMaintenance=true
    //     仅为防御: 万一上一步漏过,pauseTask 也不再标 failed 而是 pending.
    const paused: string[] = [];
    const failed: Array<{ task_id: string; error: string }> = [];
    for (const taskId of [...this.sessions.keys()]) {
      try {
        await this.pauseTask(taskId, "auto", true);
        // pauseTask 在 session_id 未分配时会走 forMaintenance 分支 → pending,
        // 而不是 paused/failed;以库里的实际落点为准.
        const after = getTaskById(taskId);
        if (after?.status === "paused") {
          paused.push(taskId);
        } else if (after?.status === "pending") {
          preFilteredPending.push(taskId);
        } else {
          failed.push({
            task_id: taskId,
            error:
              after?.error ||
              `pause 后状态为 ${after?.status ?? "unknown"}, 不可恢复`,
          });
        }
      } catch (err) {
        failed.push({ task_id: taskId, error: (err as Error).message });
      }
    }

    // 5. 落库(放最后)
    const suspended: SuspendedTask[] = [
      ...paused.map((task_id): SuspendedTask => ({
        task_id,
        prev_status: "running",
      })),
      ...dequeued.map((task_id): SuspendedTask => ({
        task_id,
        prev_status: "queued",
      })),
      ...preFilteredPending.map((task_id): SuspendedTask => ({
        task_id,
        prev_status: "queued",
      })),
    ];
    dbEnterMaintenance({
      by: opts.by ?? null,
      reason: opts.reason ?? null,
      suspended,
    });

    // v53: 开一条 maintenance_log, 把 id 缓存到 runtime 字段供 exit 收尾.
    //   必须放在 dbEnterMaintenance 之后: state.active=1 是 log 的「alive」前提,
    //   initialize() 里的 aborted 兜底据此判断要不要收尾 (state.active 但 log 已
    //   结束 = 异常).
    this.currentMaintenanceLogId = startMaintenanceLog({
      started_by: opts.by ?? null,
      reason: opts.reason ?? null,
      paused_count: paused.length,
      dequeued_count: dequeued.length,
      failed_count: failed.length,
    });

    console.log(
      `[AgentRuntime] 已进入维护模式: pause ${paused.length} 个 running, 摘下 ${dequeued.length} 个排队` +
        (failed.length > 0 ? `, ${failed.length} 个失败` : ""),
    );

    return {
      already: false,
      paused,
      dequeued,
      failed,
      state: getMaintenanceState(),
    };
  }

  // 功能: 退出维护模式. 开闸 + 逐个恢复关停时挂起的任务 + 重启定时轮询.
  //   恢复路径按任务「当前」状态决定: paused -> resumeTask(带 session_id 续
  //   transcript), pending -> startTask(重新入队).
  // 关注点:
  //   - 只恢复「我关停的」那批(suspended 清单), 用户自己手动 pause 的不碰.
  //   - 按当前状态而非 prev_status 分派: 关停后到恢复前进程重启过, 残留的
  //     queued 会被 recoverOrphanedTasks 扫成 pending, 死抠 prev_status 会把
  //     这类任务误判成「已被手动处理」而跳过. prev_status 只用于结果分类.
  //   - 其余状态(running/reviewing/completed/cancelled...)一律跳过: 维护期间
  //     人可能已手动处理过, 硬调 resumeTask 会撞状态机报错.
  //   - 先清库标记再恢复: 恢复中途崩溃时, 重启后不会又被当成「仍在维护」而
  //     二次挂起 —— 宁可留几个 paused 任务让人手动点, 也不要卡在维护态出不来.
  async exitMaintenance(): Promise<{
    active_before: boolean;
    resumed: string[];
    requeued: string[];
    skipped: Array<{ task_id: string; reason: string }>;
    failed: Array<{ task_id: string; error: string }>;
  }> {
    const state = getMaintenanceState();
    const suspended = state.suspended;

    // v53: 在做任何恢复动作前先固化 log id, exit 末尾收尾用. 进程重启过就重新
    //   查 open log (initialize() 已兜底过一次, 这里兜底再次: 多实例并发场景).
    const logId =
      this.currentMaintenanceLogId ?? getOpenMaintenanceLog()?.id ?? null;

    // 先清标记 + 开闸
    dbExitMaintenance();
    this.scheduler.setPaused(false);

    const resumed: string[] = [];
    const requeued: string[] = [];
    const skipped: Array<{ task_id: string; reason: string }> = [];
    const failed: Array<{ task_id: string; error: string }> = [];

    for (const entry of suspended) {
      const task = getTaskById(entry.task_id);
      if (!task) {
        skipped.push({ task_id: entry.task_id, reason: "任务已不存在" });
        continue;
      }
      try {
        if (task.status === "paused") {
          // 注入一条「继续」再 resume. 不注入的话 resume() 里
          // createMessageGenerator(initialPrompt, preMessages) 两个入参都是空的
          // (initialPrompt 只 fork 有值, preMessages 只驳回/留言有值) ->
          // SDK 连上了但没有任何 turn 可做, agent 空转不往下走, 还会在
          // 壁钟超时(默认 30min, 可配) 后被判超时. 实测: 关停一个跑 Bash 的任务再恢复,
          // 6 分钟零 event, 手动发消息才动.
          // 顺序要紧: 必须在 resumeTask 之前入队 —— scheduler 在 runTask() 里同步
          // getTaskById(), 会在本次调用返回前就读 metadata(同 sendUserMessage 的注释).
          this.queuePendingMessage(entry.task_id, "继续");
          this.resumeTask(entry.task_id, undefined, "maintenance_exit");
          resumed.push(entry.task_id);
        } else if (task.status === "pending") {
          // Fork tasks (forked_from_session_id is set) must be enqueued with
          // mode="fork" so the scheduler calls session.resume() instead of
          // session.start() — the SDK session already exists from the fork.
          if (task.forked_from_session_id) {
            this.scheduler.enqueue(entry.task_id, "fork", "maintenance_exit");
          } else {
            this.startTask(entry.task_id, undefined, "maintenance_exit");
          }
          requeued.push(entry.task_id);
        } else {
          skipped.push({
            task_id: entry.task_id,
            reason: `当前状态为 ${task.status}, 已被手动处理`,
          });
        }
      } catch (err) {
        failed.push({ task_id: entry.task_id, error: (err as Error).message });
      }
    }

    const { startScheduleRunner } = await import("./schedule-runner");
    startScheduleRunner();

    // v53: 收尾 maintenance_log. 失败任务非空 -> 'failed'; 否则 'completed'.
    //   logId 为 null (从未开 log) 时跳过 —— 防御性, 正常路径都会有 id.
    if (logId !== null) {
      finishMaintenanceLog({
        id: logId,
        ended_by: state.entered_by,
        result: failed.length > 0 ? "failed" : "completed",
      });
      this.currentMaintenanceLogId = null;
    }

    console.log(
      `[AgentRuntime] 已退出维护模式: resume ${resumed.length} 个, 重新入队 ${requeued.length} 个` +
        (skipped.length > 0 ? `, 跳过 ${skipped.length} 个` : "") +
        (failed.length > 0 ? `, ${failed.length} 个失败` : ""),
    );

    return { active_before: state.active, resumed, requeued, skipped, failed };
  }

  // Append a message to the task's pending_messages queue (in metadata).
  // Returned by sendUserMessage when the task is paused — the next resume
  // will drain this queue into the SDK session via ActiveSession.resume().
  private queuePendingMessage(taskId: string, message: string): void {
    queuePendingMessage(taskId, message);
  }

  // Read & clear the pending_messages queue. Public so ActiveSession can
  // call it directly during resume() without going through this runtime.
  drainPendingMessages(taskId: string): string[] {
    return drainPendingMessages(taskId);
  }

  // 功能: 任务结束后, 若处于终态且 pending_messages 非空, 自动 resume 排空.
  // 关注点: 由 scheduler.onTaskDone 触发(此时 running 槽位已释放, startTask 的
  //   enqueue 不会被 no-op). 只处理终态 - queued/running 会被正常流程排空.
  //   startTask 用 resume 模式(有 session_id), resume() 内的 drainPendingMessages
  //   消费并清空队列, 无递归/死循环(每次消费 >=1 条, 仅 peek 非空时才 resume).
  //   🔴 例外: failed + api_error (429 配额/鉴权等 API 层错误) 时 message 不可
  //   能被消费 (agent 起跑即挂) → 上面「无死循环」不变量被打破, 每轮 drain 都
  //   重拉一遍再挂, 无限循环 (2026-10-07 task 49c6d986 实证: 429 月配额 + 用户
  //   留言 → 每 ~3.5min 烧一轮直到配额重置). api_error 的 failed 不 drain.
  private maybeDrainStrandedMessages(taskId: string): void {
    const task = getTaskById(taskId);
    if (!task || !task.session_id) return;
    if (task.status === "failed" && task.error?.startsWith("api_error:")) return;
    const terminal =
      task.status === "reviewing" ||
      task.status === "await_user" ||
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      task.status === "rejected";
    if (!terminal) return;
    if (peekPendingMessages(taskId).length === 0) return;
    try {
      this.startTask(taskId, undefined, "drain_stranded");
    } catch (err) {
      console.warn(
        `[AgentRuntime] maybeDrainStrandedMessages: startTask failed for ${taskId}:`,
        (err as Error).message,
      );
    }
  }

  // Send a user message to a running session
  //
  // R55 B1 fix: `senderType` defaults to "user" for backwards compat.
  // Scripts (ao-session.sh transfer) and platform events (ao-platform-upgrade.sh
  // deploy notify, R107 parent-notify) declare "script" / "system" so the
  // transcript UI can render 👤你 / 🤖脚本 / ⚙️系统 instead of collapsing
  // everything to 👤 User. Persisted into events.data JSON; SDKUserMessage has
  // no metadata field so SDK JSONL doesn't carry it (known limitation, B2).
  sendUserMessage(
    taskId: string,
    message: string,
    opts?: RunOpts,
    reason?: string,
    senderType: "user" | "script" | "system" = "user",
  ): void {
    const session = this.sessions.get(taskId);
    const task = getTaskById(taskId);

    // Paused tasks: queue the message in metadata so it gets replayed on
    // resume. This unlocks the "send feedback while paused" workflow that
    // used to require the operator to wait for resume before typing.
    if (!session && task && task.status === "paused" && task.session_id) {
      this.queuePendingMessage(taskId, message);
      insertEvent({
        task_id: taskId,
        session_id: task.session_id,
        type: "message",
        data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
      });
      this.emitEvent(taskId, {
        type: "message",
        task_id: taskId,
        data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
      });
      return;
    }

    // Terminal tasks (completed/failed/cancelled/rejected/await_user) with
    // an existing session_id: auto-activate by startTask, then queue the
    // message so it gets injected when the resumed ActiveSession calls
    // drainPendingMessages(). Same pattern as the paused branch above.
    // 🆕 R131 (damo 2026-09-15): await_user 加入可 auto-start 列表 (用户投
    //   一句话即起, 与 paused 走相同 resume 模式).
    //
    // IMPORTANT: queue the message BEFORE startTask(). The scheduler calls
    // getTaskById() synchronously inside runTask(), which runs before the
    // current sendUserMessage() call returns. If we queue after startTask(),
    // the metadata won't have pending_messages yet when resume() reads it.
    if (!session && task) {
      const canAutoStart =
        (task.status === "completed" ||
          task.status === "failed" ||
          task.status === "cancelled" ||
          task.status === "rejected" ||
          task.status === "reviewing" ||
          task.status === "await_user" ||
          // R155: pending + session_id + pending_messages 非空 (= server_restart
          //   降级后的「用户在等 resume」状态) 也 auto-start. 真·未启动 task
          //   走不到这里: pending + !session_id 已被 && task.session_id 守门.
          (task.status === "pending" &&
            peekPendingMessages(taskId).length > 0)) &&
        task.session_id;
      if (canAutoStart) {
        this.queuePendingMessage(taskId, message);
        insertEvent({
          task_id: taskId,
          session_id: task.session_id,
          type: "message",
          data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
        });
        this.emitEvent(taskId, {
          type: "message",
          task_id: taskId,
          data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
        });
        // startTask may throw if the task was already enqueued by a prior
        // sendUserMessage call (status flipped to "queued" synchronously).
        // That's fine — the message is already queued.
        try {
          this.startTask(taskId, opts, reason);
        } catch {
          /* already queued/running */
        }
        return;
      }
    }

    // Queued/pending tasks without a live session: queue the message in
    // metadata so it gets drained when the session actually starts
    // (ActiveSession.start() drains pending_messages the same way resume()
    // does — damo 2026-10-31: 排队中的任务允许发消息, 启动时一次塞给 AI).
    // Covers two shapes:
    // - queued + session_id: the first message to a terminal task triggers
    //   startTask() which flips status to "queued" synchronously; a second
    //   rapid message arrives here (existing R155-era behavior).
    // - queued/pending without session_id (never started): the message caches
    //   in metadata and is delivered by start() when the task runs. Deliberately
    //   NO auto-start here — pending tasks wait for their trigger (manual /
    //   cron), same intent as the old R155 throw, just without losing the text.
    if (!session && task && (task.status === "queued" || task.status === "pending")) {
      this.queuePendingMessage(taskId, message);
      insertEvent({
        task_id: taskId,
        session_id: task.session_id,
        type: "message",
        data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
      });
      this.emitEvent(taskId, {
        type: "message",
        task_id: taskId,
        data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
      });
      return;
    }

    if (!session) {
      throw new Error(`No active session for task ${taskId}`);
    }

    // Session is tearing down (closed=true but not yet removed from the map).
    // pushMessage would land the message in the dead in-memory pendingMessages
    // queue - the generator already exited, so it'd never be drained into the
    // SDK JSONL, only into DB events -> getSessionHistory appends it at the end
    // on refresh and the agent never processes it. Route to the durable
    // metadata queue instead; maybeDrainStrandedMessages (fired by the
    // scheduler's onTaskDone once the slot frees) will resume to drain it.
    if (session.isClosed) {
      this.queuePendingMessage(taskId, message);
      insertEvent({
        task_id: taskId,
        session_id: session.getSessionId() || undefined,
        type: "message",
        data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
      });
      this.emitEvent(taskId, {
        type: "message",
        task_id: taskId,
        data: JSON.stringify({ role: "user", text: message, sender_type: senderType, queued: true, timestamp: Date.now() }),
      });
      return;
    }

    session.pushMessage(message, senderType);
    insertEvent({
      task_id: taskId,
      session_id: session.getSessionId() || undefined,
      type: "message",
      data: JSON.stringify({ role: "user", text: message, sender_type: senderType, timestamp: Date.now() }),
    });
    // Bug fix: 其他 4 个分支 (paused / terminal auto-start / queued / closed-session)
    // 都会 emit SSE `message` 事件, 只有 live running session 分支漏了. 没回声 → 任何
    // 后续 SSE 重连 / loadHistory 路径都可能让前端乐观插入的 user 消息在 SDK 还没
    // 把 user msg 落进 JSONL 的窗口里被 mergeHistory 按 text 错位冲掉, 表现 = 发送
    // 后「立马消失, 刷新可见」(R106 同款症状). 补上 emitEvent 即可, 与 closed-session
    // 分支同模板 (只 insertEvent 后多调一次 emitEvent, 不动 pushMessage).
    this.emitEvent(taskId, {
      type: "message",
      task_id: taskId,
      data: JSON.stringify({ role: "user", text: message, sender_type: senderType, timestamp: Date.now() }),
    });
  }

  // Surface a user upload on the SSE stream. Public so the upload route can
  // call it; not persisted to the events table (history rebuilds from the
  // attachments list). No-op when no subscriber is attached (e.g. uploads
  // before the task is started).
  emitAttachment(
    taskId: string,
    attachment: {
      id: string;
      filename: string;
      media_type: string;
      size_bytes: number;
    },
  ): void {
    this.emitEvent(taskId, { type: "attachment", task_id: taskId, attachment });
  }

  // Approve a task in reviewing / rejected / paused / await_user state → completed
  // R127 §3.4 洞3: skipReviewGate 二参. 仅 autoResumeParentAfterChildComplete helper
  //   可传 true, /api/tasks/[id]/approve 路由不允许传 (路由层 body schema 没这字段).
  //   true = 跳过 v56 awaiting_owner_review gate. 用于父子循环: 子完成 → 父 waiting_child_id
  //   命中 → 自动 approve 父 (不阻塞 damo 闸门最后一关). 不影响 approve 后的 status 转换,
  //   只是不检查 awaiting_owner_review.
  // 🆕 R131 (damo 2026-09-15): await_user 加入白名单, 内部先清 await_user 标记
  //   + 写 await_resolved_by metadata 再走正常 approve 路径. 对外仍是单次调用,
  //   damo 不需要先点 unwait 再点 approve.
  approveTask(taskId: string, skipReviewGate: boolean = false): void {
    const task = getTaskById(taskId);
    if (
      !task ||
      (task.status !== "reviewing" &&
        task.status !== "rejected" &&
        task.status !== "paused" &&
        task.status !== "await_user")
    ) {
      throw new Error(
        `Task ${taskId} is not in reviewing, rejected, paused, or await_user state`,
      );
    }
    // v56: gate on awaiting_owner_review. Agent (via <awaiting_review/> marker)
    // 或人工显式标过的任务, approveTask 拒绝, 让 damo 先 unset. 错误码固定
    // AWAITING_OWNER_REVIEW 便于 UI 区分 (前端弹"先 unset flag"提示) 与 catch
    // 端 retry (race 场景下 unset 已成功 -> 客户端重试一次即可).
    // R127 §3.4: skipReviewGate=true 跳过这条 (仅 auto-resume helper 可用).
    if (!skipReviewGate && task.awaiting_owner_review === 1) {
      throw new Error(
        `AWAITING_OWNER_REVIEW: Task ${taskId} is marked as awaiting owner review. ` +
          `Call POST /api/tasks/${taskId}/unset-awaiting-review first, then re-approve.`,
      );
    }

    // 🆕 R131 (damo 2026-09-15): await_user → 自动 unwait. 透明处理, 不对外暴露.
    //   先清 await_user metadata (await_requested_by / await_reason / await_note),
    //   写 await_resolved_by=approve 留痕, 再走原 approve 路径.
    if (task.status === "await_user") {
      mutateTaskMetadata(taskId, (meta) => {
        meta.await_resolved_by = "approve";
        meta.await_resolved_at = new Date().toISOString();
        delete meta.await_requested_by;
        delete meta.await_reason;
        delete meta.await_note;
      });
    }

    // 🆕 DAG P3 (B2/B3/B4/B5 拍板 2026-09-05+06): 机械验收门拦截.
    //   双重开关: L1 平台级 (resolveVerificationGloballyEnabled) / L2 项目级
    //   (projects.verification_command). 关一即停, 默认全关 (B5 默认 false +
    //   projects.verification_command 默认 null). 关 = byte-identical 行为.
    //   全开 = 翻 verifying → 跑命令 → 成功翻 completed / 失败回退 running + 注入反馈.
    const verificationEnabled = resolveVerificationGloballyEnabled();
    if (!verificationEnabled) {
      return this._approveTaskOriginal(taskId);
    }
    const project = task.project_id ? getProjectById(task.project_id) : null;
    const command = project?.verification_command ?? null;
    if (!command) {
      return this._approveTaskOriginal(taskId);
    }
    return this._approveTaskWithVerification(taskId, command, project!);
  }

  // 原 approveTask 的「agent 报完成 → 直接翻 completed」路径. P3 拆出来: 关一即停
  // 时走这里, 行为与今天 byte-identical.
  private _approveTaskOriginal(taskId: string): void {
    const task = getTaskById(taskId)!;
    const from = task.status;
    updateTaskStatus(taskId, "completed", {
      completed_at: new Date().toISOString(),
    });
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from,
      to: "completed",
    });
    // Auto-start dependent tasks whose dependencies are now all met
    this.autoStartDependents(taskId);
  }

  // 🆕 DAG P3: 跑项目级 verification_command, 按结果翻终态.
  //   失败回退 running + 注入反馈 (用 mutateTaskMetadata + queuePendingMessage
  //   两件套). 重试耗尽翻 failed. 设计稿 docs/plans/dag-verification.md §4.3.
  // 关注点:
  //   - runVerificationCommand 同步阻塞 — 走「agent 完成 → 平台同步验收 → 翻
  //     completed」串行流程, 不引入 async. 命令挂住由 execSync timeout 兜底.
  //   - mutateTaskMetadata 写 verification_attempts (单写者, post-completion
  //     收窄路径, 见知识广播 RMW 风险评估). KB §4 的 pending_messages 提独立表
  //     未在本任务范围, 不在这里做.
  //   - queuePendingMessage 走 tasks.metadata.pending_messages 已有 helper
  //     (KB §4 同根 RMW 风险, 收窄到「验证失败注入一次」窄路径).
  //   - 不发新的 status_change reason —— 复用现有 status_change 事件,
  //     UI 看到 verifying 已能区分.
  private _approveTaskWithVerification(
    taskId: string,
    command: string,
    project: ReturnType<typeof getProjectById> & object,
  ): void {
    const task = getTaskById(taskId)!;
    const config = getProjectVerificationConfig(project);
    const maxAttempts = config.maxRetries + 1; // 首次 + N 次重试 (B3 = 2 retries → 3 attempts)

    // 当前已尝试次数 (来自 metadata, 跨 resume 不丢). 0 表示首次.
    let prevAttempts = 0;
    if (task.metadata) {
      try {
        const parsed = JSON.parse(task.metadata);
        if (Number.isInteger(parsed?.verification_attempts)) {
          prevAttempts = parsed.verification_attempts;
        }
      } catch {
        // 旧脏 metadata 不阻断, 当 0 处理.
      }
    }
    const attempt = prevAttempts + 1;

    // 翻 verifying — 跑命令 — 决策
    const from = task.status;
    updateTaskStatus(taskId, "verifying");
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from,
      to: "verifying",
      reason: "verification_started",
    });

    const result = runVerificationCommand(command, task.cwd, config.timeoutSeconds);

    if (result.exit_code === 0) {
      // 验收成功 → 翻 completed
      updateTaskStatus(taskId, "completed", {
        completed_at: new Date().toISOString(),
      });
      this.emitEvent(taskId, {
        type: "status_change",
        task_id: taskId,
        from: "verifying",
        to: "completed",
        reason: "verification_passed",
      });
      // 同步 verification_attempts (成功后不增 attempts — attempts 只记失败次数)
      mutateTaskMetadata(taskId, (meta) => {
        const m = meta as Record<string, unknown>;
        // 写最终验证记录: succeeded + 总尝试次数 + 时间戳
        m.verification_attempts = prevAttempts; // 不增
        m.verification_last_result = {
          exit_code: 0,
          duration_ms: result.duration_ms,
          succeeded: true,
          at: new Date().toISOString(),
        };
      });
      this.autoStartDependents(taskId);
      return;
    }

    // 验收失败
    if (attempt < maxAttempts) {
      // 还有重试机会 → 回退 running + 注入反馈 + attempts 增 1
      const baseFeedback = formatVerificationFailureFeedback(result, attempt, maxAttempts);
      // Goal-driven loop 阶段 3 (D20, 漏洞 #3 + D15): task 携 <goal> marker
      //   时, 反馈追加 goal_history + 当前 goal, 避免两层 gate 嵌套注入循环.
      //   没 goal_text → appendGoalContextToFeedback 原样返回 baseFeedback, 行为
      //   byte-identical.
      const feedback = appendGoalContextToFeedback(baseFeedback, task);
      mutateTaskMetadata(taskId, (meta) => {
        const m = meta as Record<string, unknown>;
        m.verification_attempts = attempt;
        m.verification_last_result = {
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          duration_ms: result.duration_ms,
          succeeded: false,
          at: new Date().toISOString(),
        };
      });
      updateTaskStatus(taskId, "running");
      this.emitEvent(taskId, {
        type: "status_change",
        task_id: taskId,
        from: "verifying",
        to: "running",
        reason: "verification_failed_retry",
      });
      // 注入反馈给 agent — 走 queuePendingMessage (tasks.metadata.pending_messages)
      this.queuePendingMessage(taskId, feedback);
      return;
    }

    // 重试耗尽 → 翻 failed
    updateTaskStatus(taskId, "failed", {
      completed_at: new Date().toISOString(),
      error: `Verification failed after ${maxAttempts} attempts: exit=${result.exit_code}, timed_out=${result.timed_out}`,
    });
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: "verifying",
      to: "failed",
      reason: "verification_failed_exhausted",
    });
    mutateTaskMetadata(taskId, (meta) => {
      const m = meta as Record<string, unknown>;
      m.verification_attempts = attempt;
      m.verification_last_result = {
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        duration_ms: result.duration_ms,
        succeeded: false,
        at: new Date().toISOString(),
      };
    });
  }

  // R127 §3.4 洞3: 子 task 完成 → 检查父 task 是否 waiting_child_id 命中 → 自动 approve 父.
  //   skipReviewGate=true 是唯一允许跳过 awaiting_owner_review gate 的入口 (damo 拍板 0902:
  //   「auto-resume 可豁免, UI 不可豁免」). API 层路由 schema 不暴露 skipReviewGate 字段,
  //   任何外部 caller 都无法触发这条路径.
  //   副作用:
  //     - clearWaitingChild: 删 tasks.metadata.waiting_child_id, 防父后续 approve 时再次匹配
  //     - approveTask(parentId, true): status reviewing → completed
  //   不抛异常: 父已 completed / cancelled / 不命中 waiting_child_id 都是静默路径, 落 event.
  //   注意: 子 completed 不直接调本函数 (parent-notify.ts 加血缘判据后才会触发).
  autoResumeParentAfterChildComplete(childTaskId: string): void {
    try {
      const child = getTaskById(childTaskId);
      if (!child) return;
      const parentId = child.dispatched_by_task_id;
      if (!parentId) return;
      const parent = getTaskById(parentId, undefined, { includeDeleted: true });
      if (!parent || parent.deleted_at) return;

      // 血缘判据: 父 metadata.waiting_child_id === 子.id. 不命中 = 父没在等这个子,
      //   静默返回. (避免无关 completed 子任务触发父 approve)
      const meta: Record<string, unknown> = parent.metadata
        ? (() => {
            try {
              const parsed = JSON.parse(parent.metadata!);
              return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
            } catch {
              return {};
            }
          })()
        : {};
      const waitingChildId = (meta as Record<string, unknown>).waiting_child_id;
      if (typeof waitingChildId !== "string" || waitingChildId !== childTaskId) return;

      // 父必须是 reviewing (其他状态闸门 skipReviewGate 没意义, 也不该触发)
      if (parent.status !== "reviewing") return;

      // 清 waiting_child_id 后 approve. mutateTaskMetadata + approveTask 走同事务视角
      //   (DB 单事务保证, 无窗口). 失败不抛 — 让 caller (parent-notify.ts) 决定怎么降级.
      mutateTaskMetadata(parentId, (m) => {
        if ((m as Record<string, unknown>).waiting_child_id === childTaskId) {
          delete (m as Record<string, unknown>).waiting_child_id;
        }
        return true;
      });

      this.approveTask(parentId, /* skipReviewGate */ true);

      insertEvent({
        task_id: parentId,
        type: "parent_auto_resumed",
        data: JSON.stringify({
          child_id: childTaskId,
          child_to: "completed",
          reason: "waiting_child_id matched",
        }),
      });
    } catch (err) {
      console.warn(
        `[AgentRuntime] autoResumeParentAfterChildComplete failed for child=${childTaskId}:`,
        (err as Error).message,
      );
      try {
        insertEvent({
          task_id: childTaskId,
          type: "parent_auto_resume_failed",
          data: JSON.stringify({ error: (err as Error).message }),
        });
      } catch {
        /* events 表也写不进 — 尽力 */
      }
    }
  }

  // v56: 解开 awaiting_owner_review flag. Damo 拍板完成后调, 之后 approveTask 才放行.
  //   - 只允许在 reviewing/rejected/paused 状态解 flag (其他状态下 flag 没意义).
  //   - 解完不入任何 status transition, 仅把 flag 置 0. UI 拿更新后的 task 重渲染.
  //   - 与 approveTask 是两条独立的 API, 不耦合: damo 想重跑 (restart) 时可以
  //     先 unset 再 restart → 状态自然流转.
  unsetAwaitingOwnerReview(taskId: string): {
    ok: true;
    awaiting_owner_review: 0;
    awaiting_markers: null;
  } {
    const task = getTaskById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (
      task.status !== "reviewing" &&
      task.status !== "rejected" &&
      task.status !== "paused"
    ) {
      throw new Error(
        `Task ${taskId} is not in reviewing, rejected, or paused state (current: ${task.status})`,
      );
    }
    // v61+R39: 一次 unset 同时清 flag (v56) + markers 数组 (新). damo 拍板 = 一组
    //   标记全部解除, 不允许单独清 flag 留 markers (那样 UI 还会再弹). updateTask
    //   走全字段 UPDATE, awaiting_markers: null 显式清空.
    updateTask(taskId, { awaiting_owner_review: 0, awaiting_markers: null });
    return { ok: true, awaiting_owner_review: 0, awaiting_markers: null };
  }

  // 🆕 R131 (damo 2026-09-15): refine task from reviewing → re-enqueue
  // 取代旧 rejectTask: damo 投一条消息让 agent 接着干, 不进 rejected 终态,
  // session 保留, push message 给 agent, agent 自己接着改. metadata 写
  // refined_by (谁点的) + refined_message (用户消息, 可选).
  //
  // 🔴 Bugfix 2026-09-17 (task 5f5d90a5): 旧实现无脑 updateTaskStatus("running")
  //   + 仅在 session 不存在时 queuePendingMessage. 当 session 已被清理(task
  //   进入 reviewing 后 runTask 的 finally 块 this.sessions.delete)、但 scheduler
  //   没有重新入队时, 状态机被甩到 "running" 但永远没人跑 agent、pending message
  //   永远不被消费, UI 显示「运行中」实际后端空转 4h+. 复现路径: damo 在 reviewing
  //   状态点 refine → session 不在 → 仅排队不入队 → 卡死. 修复: no-session 分支
  //   改调 startTask(), 让 scheduler 用 mode="resume"(因为 session_id 仍在)
  //   重新拉起 ActiveSession.resume(), resume() 内部 drainPendingMessages 把
  //   排队的 finalMessage 当 preMessage 投给 SDK 跑下一轮.
  refineTask(taskId: string, message?: string, requestedBy: string = "damo"): void {
    const task = getTaskById(taskId);
    if (!task || task.status !== "reviewing") {
      throw new Error(`Task ${taskId} is not in reviewing state`);
    }
    // 🆕 R后续 damo 2026-09-15: refine 弹窗允许空 message, 接口层默认填「继续」,
    //   跟 maintenance_exit 路径 (line 971) 一致. 早期处理过: 底层 pushMessage 投
    //   空 user message 进 SDK 会让 agent 的 query() 行为不稳 (空 content) -> 默认
    //   fallback 给个具体引导词, 让 agent 知道要继续打磨已交付内容.
    const finalMessage = (message && message.trim()) || "继续";

    const session = this.sessions.get(taskId);
    if (session) {
      // Session 还在 (例如 agent 还没 finish 但状态已被外部提前翻 reviewing):
      // 直接 push message 让当前 SDK turn 接住. 状态翻 running 表示 agent 在跑.
      updateTaskStatus(taskId, "running");
      mutateTaskMetadata(taskId, (meta) => {
        meta.refined_by = requestedBy;
        meta.refined_count = ((meta.refined_count as number) || 0) + 1;
        meta.last_refined_at = new Date().toISOString();
        meta.refined_message = finalMessage;
      });
      this.emitEvent(taskId, {
        type: "status_change",
        task_id: taskId,
        from: "reviewing",
        to: "running",
        reason: "refined",
      });
      session.pushMessage(finalMessage);
      return;
    }

    // Session 已死 (runTask finally 块已 this.sessions.delete, 或 server 重启后
    //   内存 map 空). 必须经 scheduler.enqueue 重新入队 + scheduler.schedule()
    //   调度, 否则任务永远卡 "running" 但没人跑 — 上面说的 task 5f5d90a5 bug.
    // startTask 接受 reviewing 状态, hasExistingSession 分支决定 mode="resume"
    //   (session_id 仍在 DB), 进 scheduler 后会翻 queued → running, scheduler
    //   自己 emit "reviewing → queued (refined)" 事件, 这里不再手动 emit 避免重复.
    mutateTaskMetadata(taskId, (meta) => {
      meta.refined_by = requestedBy;
      meta.refined_count = ((meta.refined_count as number) || 0) + 1;
      meta.last_refined_at = new Date().toISOString();
      meta.refined_message = finalMessage;
    });
    this.queuePendingMessage(taskId, finalMessage);
    insertEvent({
      task_id: taskId,
      session_id: task.session_id || undefined,
      type: "message",
      data: JSON.stringify({ role: "user", text: finalMessage, sender_type: "user", queued: true }),
    });
    try {
      this.startTask(taskId, undefined, "refined");
    } catch (err) {
      console.warn(
        `[AgentRuntime] refineTask: startTask failed for ${taskId}:`,
        (err as Error).message,
      );
    }
  }

  // 🆕 R131 (damo 2026-09-15): await task from running → await_user
  // 等用户介入: 等派发实现 / 等拍板 / 有建议. metadata 写
  // await_requested_by (damo|agent) + await_reason (dispatch_needed|decision_pending|suggestion)
  // + await_note (可选自由文本).
  awaitTask(
    taskId: string,
    reason: "dispatch_needed" | "decision_pending" | "suggestion",
    note?: string,
    requestedBy: "damo" | "agent" = "damo",
  ): void {
    const task = getTaskById(taskId);
    if (!task || task.status !== "running") {
      throw new Error(`Task ${taskId} is not in running state`);
    }
    updateTaskStatus(taskId, "await_user");
    mutateTaskMetadata(taskId, (meta) => {
      meta.await_requested_by = requestedBy;
      meta.await_reason = reason;
      meta.await_note = note ?? null;
      meta.await_requested_at = new Date().toISOString();
    });
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: "running",
      to: "await_user",
      reason: `await:${reason}`,
    });
  }

  // 🆕 R131 (damo 2026-09-15): unawait task from await_user → running
  // 等结束了: agent 自己解决 / 用户超时 / 外部事件. metadata 清
  // await_* 字段, 写 unawait_* 留痕, 触发 emit status_change (running).
  unawaitTask(
    taskId: string,
    reason: "agent_self_resolved" | "user_timeout" | "external_event",
    note?: string,
    requestedBy: "damo" | "agent" = "agent",
  ): void {
    const task = getTaskById(taskId);
    if (!task || task.status !== "await_user") {
      throw new Error(`Task ${taskId} is not in await_user state`);
    }
    updateTaskStatus(taskId, "running");
    mutateTaskMetadata(taskId, (meta) => {
      meta.unawait_requested_by = requestedBy;
      meta.unawait_reason = reason;
      meta.unawait_note = note ?? null;
      meta.unawait_requested_at = new Date().toISOString();
      meta.await_resolved_by = `unawait:${reason}`;
      meta.await_resolved_at = new Date().toISOString();
      delete meta.await_requested_by;
      delete meta.await_reason;
      delete meta.await_note;
    });
    this.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: "await_user",
      to: "running",
      reason: `unawait:${reason}`,
    });
  }

  // Check and auto-start tasks that depend on the completed task
  private autoStartDependents(completedTaskId: string): void {
    const dependentIds = getDependentTaskIds(completedTaskId);
    for (const depTaskId of dependentIds) {
      const depTask = getTaskById(depTaskId);
      if (!depTask || depTask.status !== "pending") continue;

      if (areDependenciesMet(depTaskId)) {
        console.log(
          `[AgentRuntime] Auto-starting dependent task ${depTaskId} (all deps met)`,
        );
        this.startTask(depTaskId, undefined, "dependency_met");
      }
    }
  }

  // Fork a session — creates a new task backed by a brand-new SDK session
  // produced by standalone forkSession(). The new session shares transcript
  // history with the parent up to upToMessageId (default: end of parent),
  // with all message UUIDs remapped. Caller's prompt takes over from there.
  //
  // Returns { newTaskId, newSessionId, forkedFromSessionId } so the API
  // layer can navigate to the new task without a second round-trip.
  async forkSession(
    taskId: string,
    opts: {
      upToMessageId?: string;
      title?: string;
      prompt?: string;
      newCwd?: string;
      maxTurns?: number;
      autoApprove?: boolean;
      compactFirst?: boolean;
    } = {},
  ): Promise<{
    newTaskId: string;
    newSessionId: string;
    forkedFromSessionId: string;
  }> {
    const task = getTaskById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!task.session_id) {
      throw new Error(`Task ${taskId} has no session to fork`);
    }

    const parentSessionId = task.session_id;
    // Resolve the actual cwd the SDK used when the session was created.
    // ActiveSession falls back to ~/.agent-orchestrator/projects/{projectId}/{taskId}/
    // when task.cwd is NULL — we must pass the same path to SDK getSessionMessages/forkSession
    // or they look in the wrong directory and fail with "Session not found".
    const orchestratorBase = ORCHESTRATOR_HOME;
    const parentDir =
      task.cwd ||
      (task.project_id
        ? path.join(orchestratorBase, "projects", task.project_id, task.id)
        : path.join(orchestratorBase, "workspace", task.id));

    // Validate upToMessageId (if provided) belongs to the parent session.
    // We don't want to call SDK forkSession with a bogus UUID and get an
    // opaque error back.
    if (opts.upToMessageId) {
      let valid = false;
      try {
        const messages = await getSessionMessages(parentSessionId, {
          dir: parentDir,
        });
        valid = messages.some((m) => m.uuid === opts.upToMessageId);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new Error(
          `upToMessageId "${opts.upToMessageId}" not found in parent session`,
        );
      }
    }

    // Ask the SDK to fork the transcript. This writes a new JSONL session
    // file and returns a brand-new session_id we can persist immediately.
    const forkResult = await forkSdkSession(parentSessionId, {
      dir: parentDir,
      upToMessageId: opts.upToMessageId,
      title: opts.title,
    });
    const newSessionId = forkResult.sessionId;

    // Create the new task. Use the supplied prompt (or a sensible default
    // that tells the agent it's continuing from a fork). Tags carry "fork"
    // and the source task id for traceability.
    //
    // IMPORTANT: inherit autoApprove from the parent. Otherwise the fork
    // task would block on tool-approval UI for every Write/Bash call while
    // the operator is AWOL — fork tasks must run unattended.
    //
    // Also bump maxTurns to max(parent.maxTurns, 30). Without this, a fork
    // from a quick scratch task inherits maxTurns=5 and dies before the
    // bug-fix agent can read the file, edit, run tests, and commit.
    if (!task.project_id) {
      throw new Error(`Task ${taskId} has no project and cannot be forked`);
    }

    const inheritedMaxTurns = opts.maxTurns || task.max_turns || 200;
    const newTask = this.createTask({
      title: opts.title || `Fork of: ${task.title}`,
      auto_approve: opts.autoApprove ?? task.auto_approve === 1,
      prompt:
        opts.prompt ||
        `请从父任务 ${taskId} 的 checkpoint 继续处理（已经 fork 出新的 SDK session ${newSessionId}）。` +
          `读取父任务的 ${opts.upToMessageId ? "checkpoint 之前" : "全部"}上下文，承接后续工作。`,
      description: `Forked from task ${taskId}${opts.upToMessageId ? ` at message ${opts.upToMessageId}` : ""}`,
      cwd: opts.newCwd || parentDir,
      model: task.model || undefined,
      allowedTools: task.allowed_tools
        ? parseStrArray(task.allowed_tools)
        : undefined,
      maxTurns: inheritedMaxTurns,
      effort: (task.effort as any) || undefined,
      tags: [...parseStrArray(task.tags), "fork"],
      project_id: task.project_id!,
      version_id: task.version_id,
    });

    // Write the new task's session_id + fork lineage + commit anchor.
    // Use "queued" (not "paused") so the task survives a process restart:
    // paused tasks are not re-enqueued on recovery, but queued tasks are
    // flipped to pending and re-enqueued. A fork task is "waiting for a
    // slot", not "paused for human intervention".
    updateTaskStatus(newTask.id, "queued", {
      session_id: newSessionId,
      forked_from_session_id: parentSessionId,
    });
    updateTask(newTask.id, {
      base_commit: task.head_commit || task.base_commit || null,
      metadata: JSON.stringify({
        parent_session_id: parentSessionId,
        forked_at: new Date().toISOString(),
        fork_point: opts.upToMessageId || null,
        source_task_id: taskId,
        compact_first: opts.compactFirst === true,
      }),
    });

    // Persist the sessions row for the fork. forkSession auto-created the
    // SDK JSONL but not our DB row.
    createSession({
      id: newSessionId,
      task_id: newTask.id,
      cwd: opts.newCwd || parentDir,
      title: opts.title || newTask.title,
      forked_from: parentSessionId,
      source_message_id: opts.upToMessageId || null,
    });

    // Seed a step-0 checkpoint so the UI timeline always has at least one
    // entry for a fork task. Without this the "fork from here" UX is awkward.
    // step is a string tag (v46): "0" stays in numeric-step convention so
    // forks always anchor at the head before any agent-emitted marker.
    try {
      insertCheckpoint({
        task_id: newTask.id,
        session_id: newSessionId,
        step: "0",
        summary: opts.upToMessageId
          ? `forked from task ${taskId} at message ${opts.upToMessageId.slice(0, 8)}…`
          : `forked from task ${taskId} (head)`,
        by: null,
        status: null,
        commit_id: task.head_commit || task.base_commit || null,
        transcript_slice: null,
        up_to_message_id: opts.upToMessageId || null,
      });
    } catch (err) {
      console.warn(
        `[AgentRuntime] Failed to seed fork checkpoint:`,
        (err as Error).message,
      );
    }

    // Record the fork_created transition BEFORE enqueuing. enqueue() runs the
    // scheduler synchronously up to the status flip, which emits a
    // queued->running event (via emitEvent -> insertEvent). If this
    // pending->queued event is inserted after enqueue, it lands in the DB with
    // a higher id than queued->running, so SSE history replay (ORDER BY id ASC)
    // ends on "queued" and the UI shows wrong status for a task that is
    // actually running.
    insertEvent({
      task_id: newTask.id,
      session_id: newSessionId,
      type: "status_change",
      data: JSON.stringify({
        from: "pending",
        to: "queued",
        reason: "fork_created",
      }),
    });

    // Auto-resume with mode="fork" — scheduler will pass this to the runner
    // so session.resume(task) is called (not session.start), which is what
    // we want since the new SDK session_id is already valid and the JSONL
    // exists. resume() loads the conversation history from the session id.
    this.scheduler.enqueue(newTask.id, "fork", "fork");

    return {
      newTaskId: newTask.id,
      newSessionId,
      forkedFromSessionId: parentSessionId,
    };
  }

  // Resolve a pending tool approval request
  resolveToolApproval(
    taskId: string,
    requestId: string,
    approved: boolean,
    feedback?: string,
  ): void {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`No active session for task ${taskId}`);
    session.resolveApproval(requestId, approved, feedback);
  }

  // 功能: 把 auto_approve 变更推给正在跑的 session, 下一次工具调用生效.
  // 关注点: 任务没在跑 (queued/completed) 时静默 no-op —— 下次 start/resume 会
  // 从 task 行重新读, 不需要报错。
  setAutoApprove(taskId: string, on: boolean): void {
    this.sessions.get(taskId)?.setAutoApprove(on);
  }

  // 功能: 把正在跑的 task 的 timeout timer 重挂为新时长 (min). PATCH 后立即生效.
  // 关注点:
  //  - 必须先 clearTimeout 否则旧 timer 仍会按原时长触发 pause —— 这是 race.
  //  - 没在跑的任务静默返回 false (queued / 终态 / 不存在). DB 写入在 PATCH 路由里
  //    已做, 下次 start/resume 时 resolveTaskTimeoutMs 会现算.
  //  - 新 timer 复用同一 pause + notify 链路, source="auto" 让超时提示音照常响.
  //  - 不重置 meta.timeout_notified_at (同 task id 一辈子只发一次超时通知, 改超时
  //    不重发, 避免用户改来改去刷邮件).
  setTaskTimeout(taskId: string, newMinutes: number): boolean {
    const old = this.timeoutTimers.get(taskId);
    if (!old) return false;
    clearTimeout(old);
    const timeoutMs = newMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      console.warn(
        `[AgentRuntime] Task ${taskId} timed out after ${timeoutMs / 1000}s, pausing (resumable)`,
      );
      this.pauseTask(taskId, "auto").catch((err) => {
        console.error(
          `[AgentRuntime] Error pausing timed-out task ${taskId}, falling back to cancel:`,
          err,
        );
        this.cancelTask(taskId, "auto").catch(() => {});
      });
      void notifyTaskTimeout(taskId, timeoutMs).catch((err) => {
        console.warn(`[AgentRuntime] 超时通知发送异常 (task ${taskId}):`, err);
      });
    }, timeoutMs);
    this.timeoutTimers.set(taskId, timer);
    return true;
  }

  // Get pending approvals for a task
  getPendingApprovals(
    taskId: string,
  ): Array<{
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }> {
    const session = this.sessions.get(taskId);
    if (!session) return [];
    return session.getPendingApprovals();
  }

  // Resolve a pending user dialog (e.g. AskUserQuestion). `payload.answers`
  // is the {question -> label} map from the UI; `payload.cancelled` aborts.
  resolveUserDialog(
    taskId: string,
    requestId: string,
    payload: {
      answers?: Record<string, string>;
      cancelled?: boolean;
      feedback?: string;
    },
  ): void {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`No active session for task ${taskId}`);
    session.resolveUserDialog(requestId, payload);
  }

  // Snapshot of pending user dialogs for the task. Empty after server
  // restart — UI should fall back to SSE history replay in that case.
  getPendingUserDialogs(taskId: string): Array<{
    requestId: string;
    kind: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string; preview?: string }>;
      multi_select: boolean;
    }>;
    toolUseId?: string;
    emittedAt: number;
  }> {
    const session = this.sessions.get(taskId);
    if (!session) return [];
    return session.getPendingUserDialogs();
  }

  // Rewind files for a running task
  async rewindFiles(taskId: string, userMessageId: string, dryRun?: boolean) {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`No active session for task ${taskId}`);
    return session.rewindFiles(userMessageId, dryRun);
  }

  // ---- Event Subscriptions ----

  subscribeToEvents(taskId: string, callback: EventSubscriber): () => void {
    if (!this.subscribers.has(taskId)) {
      this.subscribers.set(taskId, new Set());
    }
    this.subscribers.get(taskId)!.add(callback);
    return () => {
      this.subscribers.get(taskId)?.delete(callback);
    };
  }

  // Subscribe to events for all tasks in a project. Only status_change and
  // cost events are forwarded (the board view only needs these).
  subscribeToProjectEvents(
    projectId: string,
    callback: EventSubscriber,
  ): () => void {
    if (!this.projectSubscribers.has(projectId)) {
      this.projectSubscribers.set(projectId, new Set());
    }
    this.projectSubscribers.get(projectId)!.add(callback);
    return () => {
      this.projectSubscribers.get(projectId)?.delete(callback);
    };
  }

  // Subscribe to all task status_change/cost events across projects. Used by
  // the global board view at /global to show cross-project activity.
  subscribeToAllEvents(callback: EventSubscriber): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  // ---- Query ----

  getActiveSession(taskId: string): ActiveSession | undefined {
    return this.sessions.get(taskId);
  }

  getCheckpoints(taskId: string) {
    return getCheckpointsByTaskId(taskId);
  }

  getScheduler(): TaskScheduler {
    return this.scheduler;
  }

  async getSessionHistory(taskId: string): Promise<SessionMessage[]> {
    const task = getTaskById(taskId);
    if (!task) return [];

    const events = getEventsByTaskId(taskId);
    const sessionId =
      task.session_id ||
      events.findLast((event) => event.session_id)?.session_id;

    // Build messages from DB events (used as fallback or as supplement).
    const eventMessages = events.flatMap((event): SessionMessage[] => {
      try {
        const data = JSON.parse(event.data);
        const uuid = `event-${event.id}`;
        const eventSessionId = event.session_id || sessionId || "";

        if (
          event.type === "message" &&
          (data.role === "user" || data.role === "assistant")
        ) {
          // R155 透传 timestamp: data.timestamp 是 sendUserMessage 写入时的真实
          //   Date.now() ms; 缺失时兜底 event.created_at (ISO 字符串). 这样前端
          //   messageTimestamp 直接拿到 ISO, 不再 fallback 到 uuidToTimestamp 对
          //   "event-${id}" 解析 NaN, 也不会因 undefined 兜底 0 把 DB event 排到
          //   第一位 (insertByTimestamp 兜底 MAX_SAFE_INTEGER 后, 这条消息按真实
          //   时间戳排在 SDK 消息之后).
          const tsMs =
            typeof data.timestamp === "number"
              ? data.timestamp
              : parseDbTime(event.created_at)?.getTime() ?? Date.now();
          const tsIso = new Date(tsMs).toISOString();
          // SessionMessage 类型是 SDK 导出, 无顶层 timestamp 字段; tsOf 同款
          // `(m as any)` 写法加字段, frontend messageTimestamp 按 string 宽松接.
          const msg: any = {
            type: data.role,
            uuid,
            session_id: eventSessionId,
            message: { role: data.role, content: data.text || "" },
            parent_tool_use_id: null,
            parent_agent_id: null,
          };
          msg.timestamp = tsIso;
          return [msg];
        }

        if (event.type === "tool_use") {
          return [
            {
              type: "assistant",
              uuid,
              session_id: eventSessionId,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: uuid,
                    name: data.name,
                    input: data.input,
                  },
                ],
              },
              parent_tool_use_id: null,
              parent_agent_id: null,
            },
          ];
        }
      } catch {
        // Ignore malformed historical rows.
      }
      return [];
    });

    if (sessionId) {
      try {
        // Resolve the actual cwd the SDK used (same fallback as ActiveSession constructor)
        const orchestratorBase = ORCHESTRATOR_HOME;
        const sessionDir =
          task.cwd ||
          (task.project_id
            ? path.join(orchestratorBase, "projects", task.project_id, task.id)
            : path.join(orchestratorBase, "workspace", task.id));
        const messages = await getSessionMessages(sessionId, {
          dir: sessionDir,
        });
        if (!task.session_id) updateTask(taskId, { session_id: sessionId });

        if (messages.length > 0) {
          // SDK messages are the primary source, but they may miss messages
          // that were queued while the task was paused OR are still in the
          // in-memory pendingMessages queue (sent mid-turn, not yet drained to
          // the SDK JSONL). Merge: interleave any DB event messages whose
          // content isn't already in the SDK transcript at their correct
          // chronological position (by timestamp) - NOT appended at the end.
          // Appending makes mid-conversation messages "jump to the end" on
          // page refresh (the live SSE view showed them at send time, but the
          // canonical JSONL order didn't include them yet).
          const userTextOf = (m: SessionMessage): string => {
            const content = (m as any).message?.content;
            return typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((b: any) => (b.type === "text" ? b.text : ""))
                    .join("")
                : "";
          };
          // Prompt 重投时间修正: fresh-start 路径 (LLM fallback / 终态复活重跑)
          //   会把 task.prompt 重新喂进新 session 当首条消息, JSONL 记录时间
          //   (uuid v7 反算) = 重投时间而非用户创建任务时间. 而后续 follow-up
          //   消息走 DB event (真实发送时间), merge 按 ts 排序 → 首条 prompt
          //   被排到最后 (2026-10-07 taoke task 实测: prompt 12:04 创建, 15:57
          //   被 fallback 重投, 排到 12:13/15:57 两条 follow-up 后面, 用户看到
          //   「第一条消息显示在最后」). 修复: 命中 prompt 文本的 SDK user 消息
          //   统一按 tasks.created_at 计时 (写 (m).timestamp 供前端显示 +
          //   tsOf 排序两处共用).
          // 关注点: 只 override 首个命中项 — 用户事后把 prompt 原文再发一遍的
          //   场景保留真实时间. combined 记录 (多消息 \n join) 不参与匹配,
          //   避免把整条 combined 拖到 created_at.
          // 匹配双形态: createTask 会把 prompt 拼成「平台注入
          //   [preflight check]…\n[task]\n + 用户 prompt」(src/lib/db/tasks.ts
          //   buildPreflightBlock), fresh-start 直接把 task.prompt 喂给 SDK,
          //   JSONL 落的就是这个全文; ChatView 建的任务 prompt 本来就是裸文本
          //   (2026-10-07 taoke task). 所以全文 + [task] 后缀两种候选都参与.
          const rawPrompt = (task.prompt || "").trim();
          const promptCandidates: string[] = [];
          if (rawPrompt) promptCandidates.push(rawPrompt);
          const taskMarkerIdx = rawPrompt.indexOf("[task]\n");
          if (taskMarkerIdx !== -1) {
            const bare = rawPrompt.slice(taskMarkerIdx + "[task]\n".length).trim();
            if (bare) promptCandidates.push(bare);
          }
          const createdMs = parseDbTime(task.created_at)?.getTime() ?? 0;
          let promptTsOverridden = false;
          if (promptCandidates.length > 0 && createdMs > 0) {
            for (const m of messages) {
              if (m.type !== "user") continue;
              const text = userTextOf(m).trim();
              if (!text || !promptCandidates.includes(text)) continue;
              (m as any).timestamp = new Date(createdMs).toISOString();
              promptTsOverridden = true;
              break;
            }
          }
          // The SDK may combine multiple consecutive user messages into one
          // JSONL entry (joined with \n) when they are drained from the
          // pendingMessages queue together. Track exact texts AND individual
          // lines so a DB event whose text is one line of a combined SDK
          // message is recognized as present, not "missing" (which would
          // duplicate it at the end).
          const sdkTexts = new Set<string>();
          const sdkLines = new Set<string>();
          for (const m of messages.filter((m) => m.type === "user")) {
            const t = userTextOf(m);
            if (!t) continue;
            sdkTexts.add(t);
            if (t.includes("\n")) {
              for (const line of t.split("\n")) if (line) sdkLines.add(line);
            }
          }
          const missing = eventMessages.filter((em) => {
            if (em.type !== "user") return false;
            const content = userTextOf(em);
            return (
              !!content && !sdkTexts.has(content) && !sdkLines.has(content)
            );
          });
          if (missing.length === 0) return messages;
          // Timestamp for ordering: event-sourced messages use their DB
          // created_at (uuid is `event-${id}`); SDK messages use the UUID v7
          // prefix (first 48 bits = unix_ms). Binary-insert each missing
          // message after existing equal-timestamp entries so SDK order is
          // preserved within a tie.
          const eventTs = new Map<string, number>();
          for (const e of events) {
            const ms = parseDbTime(e.created_at)?.getTime();
            if (ms) eventTs.set(`event-${e.id}`, ms);
          }
          const tsOf = (m: SessionMessage): number => {
            const u = (m as any).uuid || "";
            // DB event 没有可信 created_at 时排到末尾 — 与 SDK uuid 失败兜底
            // 一致. 旧实现 `?? 0` 会让这些事件插到 SDK 消息最前, 表现如
            // `[subtask-notify]` 跑到前面 (bug fix).
            if (u.startsWith("event-")) return eventTs.get(u) ?? Number.MAX_SAFE_INTEGER;
            // Prompt 重投修正: 命中 prompt 的 SDK 消息用 tasks.created_at
            //   (上面写进 (m).timestamp 的同一个值, 排序与前端显示同源).
            if (promptTsOverridden && typeof (m as any).timestamp === "string") {
              const t = new Date((m as any).timestamp).getTime();
              if (!Number.isNaN(t)) return t;
            }
            const ms = parseInt(u.replace(/-/g, "").slice(0, 12), 16);
            return !isNaN(ms) && ms > 1_000_000_000_000
              ? ms
              : Number.MAX_SAFE_INTEGER;
          };
          const merged = [...messages];
          for (const m of missing) {
            const ts = tsOf(m);
            let lo = 0,
              hi = merged.length;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (tsOf(merged[mid]) <= ts) lo = mid + 1;
              else hi = mid;
            }
            merged.splice(lo, 0, m);
          }
          return merged;
        }
      } catch {
        // Fall back to the persisted event log below.
      }
    }

    return eventMessages;
  }

  getEvents(taskId: string, limit?: number) {
    return getEventsByTaskId(taskId, limit);
  }

  // ---- Private ----

  private async runTask(
    task: Task,
    mode: "start" | "resume" | "fork",
  ): Promise<void> {
    // Consume send-time overrides staged by startTask/resume/restart/sendUserMessage.
    const opts = this.pendingOverrides.get(task.id);
    this.pendingOverrides.delete(task.id);
    const session = new ActiveSession(task, opts);

    // Subscribe session events to our subscribers
    session.onEvent((event) => {
      this.emitEvent(task.id, event);
    });

    this.sessions.set(task.id, session);

    // Set a timeout to stop tasks that run too long.
    // 功能: 挂到超时就打断, 走的是前端「暂停」按钮同一条路径 (pauseTask):
    //   interrupt + close + 保住 session_id, 状态落 paused, 之后 resume 能续上
    //   完整 transcript. 超时时长由 resolveTaskTimeoutMs 现算(项目级 → 全局默认)。
    // 关注点: 故意不区分「是否在等人审批」—— 超时本身不该让人丢上下文, 卡在
    //   Bash/长任务上超时的场景 cancel 掉同样是白烧一遍. pause 抛错才回退 cancel
    //   (会话已经没了 / session_id 还没分配, 后者由 pauseTask 自己判 failed).
    //   ⚠️ 副作用: paused 是非终态, 定时任务的防重派闸门按「非终态」算在飞,
    //   一个超时挂着的 task 会挡住后续触发, 解卡 = 恢复它或软删。把超时调长
    //   等于把这段「挡住后续触发」的窗口一起调长。
    //   📧 pause 之后异步发一封超时通知(v41): **不 await**, 不进 pause 的
    //   Promise 链 —— 邮件最坏要等 20s socket 超时, 不该压在状态机路径上;
    //   去重(同一 task 只发一次)在 notifyTaskTimeout 内部用 DB 标记做。
    const timeoutMs = resolveTaskTimeoutMs(task);
    const timer = setTimeout(() => {
      console.warn(
        `[AgentRuntime] Task ${task.id} timed out after ${timeoutMs / 1000}s, pausing (resumable)`,
      );
      this.pauseTask(task.id, "auto").catch((err) => {
        console.error(
          `[AgentRuntime] Error pausing timed-out task ${task.id}, falling back to cancel:`,
          err,
        );
        this.cancelTask(task.id, "auto").catch(() => {});
      });
      void notifyTaskTimeout(task.id, timeoutMs).catch((err) => {
        console.warn(`[AgentRuntime] 超时通知发送异常 (task ${task.id}):`, err);
      });
    }, timeoutMs);
    this.timeoutTimers.set(task.id, timer);

    try {
      // Use the mode from the scheduler, not task.status — the scheduler
      // has already flipped task.status to "running" by the time we get here,
      // so inferring from it would always pick "start".
      if (mode === "resume" || mode === "fork") {
        // Resume (or first-run after fork) reuses an existing SDK session.
        // Fork sets session_id to a brand-new SDK session via forkSession().
        await session.resume(task);
      } else {
        // Start creates a brand-new SDK session.
        await session.start(task);
      }
    } finally {
      // Clear timeout when task finishes normally
      const t = this.timeoutTimers.get(task.id);
      if (t) {
        clearTimeout(t);
        this.timeoutTimers.delete(task.id);
      }
      // Remove closed session from map so we don't leak memory across
      // long-running server lifetimes. Future sendUserMessage() will see
      // "no active session" and tell the user to start/resume first.
      this.sessions.delete(task.id);
    }
  }

  // 功能: 把事件入库 + 广播给所有订阅者 (单任务 + 项目级 + 全局看板).
  // 关注点:
  //  - status_change 会拼上 started_at / timeout_ms (task 当前实际生效值) 再广播,
  //    让前端拿到一次事件就能开始「剩余时间」倒计时. 仅 task.status === "running" 时
  //    带 timeout_ms, 其他状态不渲染倒计时.
  //  - events 表持久化的 data 字段持久化 {from, to, source?, reason?} —— 后两个是
  //    v53+ 可选字段, 让 timeline 直接显示「被谁重置」, 排查「已 approve task 被无故
  //    重置」时不用 grep 上一条 message 事件 (R33 真缺口). 旧事件无 source/reason 是
  //    正常的, 前端读取容错即可.
  //  - public 是给 PATCH /api/tasks/[id] 改完 timeout_minutes 后手动重发 status_change
  //    用 (同状态 from==to 仅用于推新 timeout_ms, runRules 的 matchingRules 不匹配
  //    任何 from==to 的 task_rule, webhook STATUS_TO_WEBHOOK 也不含 running, 都不触发).
  emitEvent(taskId: string, event: AgentEvent): void {
    // Persist status_change events to the events table so they can be
    // loaded later (e.g. by the timeline API). Other event types are
    // logged by the originating module (ActiveSession.logEvent, etc.).
    if (event.type === "status_change") {
      // 拼上 started_at + 实际生效的 timeout_ms (含 task override).
      // 仅 running 时 timeout_ms 有意义; 其他状态前端不渲染倒计时.
      const task = getTaskById(taskId);
      if (task) {
        if (task.started_at) event.started_at = task.started_at;
        if (task.status === "running") {
          event.timeout_ms = resolveTaskTimeoutMs(task);
        }
      }
      insertEvent({
        task_id: taskId,
        type: "status_change",
        // source / reason 之前只活在 SSE 直播流, events 表只落 {from,to} —
        // 排查「已 approve task 被无故重置」时只能 grep 上一条 message 事件 (见
        // docs/plans/task-completed-requeue-investigation.md §1.4). 现可选地
        // 把 source / reason 一并落库, timeline 直接显示「被谁重置」.
        data: JSON.stringify({
          from: event.from,
          to: event.to,
          ...(event.source !== undefined && { source: event.source }),
          ...(event.reason !== undefined && { reason: event.reason }),
        }),
      });

      const webhookEvent = STATUS_TO_WEBHOOK[event.to];
      if (webhookEvent) {
        const task = getTaskById(taskId);
        if (task) {
          dispatchWebhook(webhookEvent, task, {
            from: event.from,
            to: event.to,
          });
        }
      }

      // Event-triggered orchestration (workflow.md §8 v1):
      // any status transition may match a task_rule. Fire-and-forget.
      void runRules({ taskId, from: event.from, to: event.to });

      // R107 父子任务通知 (damo 0825 拍板). 子 task 进入 reviewing/failed/
      //   cancelled/await_user 时自动让父 task 知道. 内部按父状态三路分支:
      //   alive → sendUserMessage 直发; terminal + session_id → sendUserMessage
      //   (auto-resume); terminal + session_id=null → webhook 兜底. 函数本身
      //   异常已被 catch (parent-notify.ts §notifyParentOfChildStatusChange), 这里
      //   同步调用即可, 不阻塞 emitEvent 主流程.
      notifyParentOfChildStatusChange(taskId, event.from, event.to);
    }

    const callbacks = this.subscribers.get(taskId);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(event);
        } catch (err) {
          console.error("[AgentRuntime] Error in subscriber callback:", err);
        }
      }
    }

    // Forward status_change and cost events to project-level subscribers.
    // The board view only needs these two event types for real-time updates.
    if (event.type === "status_change" || event.type === "cost") {
      const task = getTaskById(taskId);
      if (task?.project_id) {
        const projCallbacks = this.projectSubscribers.get(task.project_id);
        if (projCallbacks) {
          for (const cb of projCallbacks) {
            try {
              cb(event);
            } catch (err) {
              console.error(
                "[AgentRuntime] Error in project subscriber callback:",
                err,
              );
            }
          }
        }
      }
      // Also forward to global subscribers (cross-project board view at /global).
      for (const cb of this.globalSubscribers) {
        try {
          cb(event);
        } catch (err) {
          console.error(
            "[AgentRuntime] Error in global subscriber callback:",
            err,
          );
        }
      }
    }
  }
}

// 🆕 Goal-driven loop 阶段 4 (D21, damo 2026-09-14 拍板): continueGoalLoop helper.
//   plan §9.4 接口 + 决策树 + D12 off-by-one 修复 + 漏洞 #2/#8 缓解.
//
// 接口:
//   continueGoalLoop(taskId, graderFeedback, contextUsage) →
//     { action: "continue" } | { action: "fork"; ... } | { action: "giveUp"; reason }
//
// 决策树 (D12 修复后顺序):
//   1. 读 task.metadata.goal_rounds (默认 0) + goal_history (默认 []).
//   2. 前置检查: current >= max_goal_rounds → giveUp (翻 failed).
//   3. new_rounds = current + 1.
//   4. 决策:
//      contextTokens != null && contextMax != null && contextMax > 0
//        && contextTokens / contextMax >= resumeThreshold
//        → forkSession(taskId, { compactFirst: true }) (漏洞 #8 见下方 prompt 拼接)
//        else → session.pushMessage(graderFeedback, "system") (续同 session).
//   5. 原子写 task.metadata: goal_rounds / goal_history (cap 20, 漏洞 #2)
//      / last_grader_reason.
//
// 关注点:
//   - 单写者路径: goal loop 在 active-session 单 session 内驱动, read-modify-write
//     安全; metadata 是 JSON.stringify 自由结构, 不强类型化 (同 line 1612 风格).
//   - 漏洞 #8 (P0): fork 分支必须显式把 goal_text 拼进新 task 的 prompt, 否则
//     新 task 启动时 active-session 解析 marker 失败 → 不接 goal loop. fallback
//     = 不拼 marker + console.warn, 让 fork task 当普通 task 跑 (不致命).
//   - 漏洞 #2 (P1): goal_history cap 在最近 20 条 (max_goal_rounds=20 上限对齐,
//     slice(-20) 保留最后 20 条).
//   - D12 off-by-one 修复: 前置用 current >= max 而非 new_rounds >= max, 让
//     max=5 实际允许 5 轮 (旧写法少跑一轮). 见 plan §9.4 决策树.
//   - giveUp 路径翻 failed (与 failGoalUnreachable 同口径), 写 error + completed_at
//     + cost_usd, emit status_change event. caller (active-session) 不需要重复翻.

export interface ContextUsageSnapshot {
  contextTokens: number | null;
  contextMax: number | null;
}

export type ContinueDecision =
  | { action: "continue" }
  | { action: "fork"; newTaskId: string; newSessionId: string }
  | { action: "giveUp"; reason: string };

// 历史条目结构 (与 plan §9.4 metadata 字段约定一致).
interface GoalHistoryEntry {
  round: number;
  verdict: string;
  reason: string;
  at: string;
  context_tokens: number | null;
  context_max: number | null;
}

// goal_history 数组 cap (漏洞 #2 P1). 与 max_goal_rounds 上限 20 对齐.
const GOAL_HISTORY_MAX_ENTRIES = 20;

// 功能: goal loop 续跑决策 —— grader 给 "not_yet_met" 时调, 决定是续同 session
//   还是 fork+compress 开新 task, 还是 max_rounds 兜底翻 failed.
// 关注点:
//   - task 不存在 → throw; metadata 脏值 → 视为无 goal 状态, 用默认值.
//   - giveUp 翻 failed 时 cost_usd 优先取 session.getCostUsd (流式累计), fallback
//     到 task.cost_usd (DB 落库值), 最后 0 (从未跑过).
//   - 不写 last_grader_reason 之外的字段 (goal_text 由启动时解析, 不重复写).
//   - 可选第 4 参数 runtimeOverride 仅供测试注入 — 生产路径仍走 getRuntime() 默认值.
//     设计动机: continueGoalLoop 内部要调 runtime.forkSession + runtime.emitEvent +
//     runtime.getActiveSession, 单测不想触发真实 runtime.init() (会跑 recoverOrphanedTasks
//     + startHeartbeatTick 副作用, 让测试 setup 变脆). 接口兼容 active-session caller
//     (它只传 3 个参数, runtimeOverride 走 default = getRuntime()).
export async function continueGoalLoop(
  taskId: string,
  graderFeedback: string,
  contextUsage: ContextUsageSnapshot,
  runtimeOverride?: AgentRuntime,
): Promise<ContinueDecision> {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Step 1: 读 metadata. goal_rounds 默认 0, goal_history 默认 [], 脏值降级.
  let goalRounds = 0;
  let goalHistory: GoalHistoryEntry[] = [];
  let goalText: string | null = null;
  // Per-task maxRounds 覆盖 (R143 二轮, damo 2026-09-15): POST /api/tasks 接
  //   goalRounds 写入 metadata.max_goal_rounds. 缺省 / 越界 / 非数字 → 走全局
  //   getMaxGoalRounds(). 范围 [MIN_MAX_GOAL_ROUNDS, MAX_MAX_GOAL_ROUNDS] 同
  //   settings.ts 上限, 越界裁剪 (不强 reject, 兜底回退).
  let perTaskMaxRounds: number | null = null;
  if (task.metadata) {
    try {
      const parsed = JSON.parse(task.metadata) as Record<string, unknown>;
      if (typeof parsed.goal_rounds === "number" && Number.isFinite(parsed.goal_rounds)) {
        goalRounds = parsed.goal_rounds;
      }
      if (Array.isArray(parsed.goal_history)) {
        goalHistory = parsed.goal_history.filter(
          (e: unknown): e is GoalHistoryEntry =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as Record<string, unknown>).round === "number",
        );
      }
      if (typeof parsed.goal_text === "string" && parsed.goal_text.trim().length > 0) {
        goalText = parsed.goal_text;
      }
      if (typeof parsed.max_goal_rounds === "number" && Number.isFinite(parsed.max_goal_rounds)) {
        perTaskMaxRounds = parsed.max_goal_rounds;
      }
    } catch {
      // 脏 metadata → 视为无 goal 状态, 用默认值继续.
    }
  }

  // maxRounds 解析链: per-task metadata → 全局 settings → 默认. 范围裁剪.
  //   R143 四轮 (damo 2026-09-15): maxRounds=0 是 sentinel 「不限轮次」, 此时
  //   跳过 giveUp 检查 (Step 2). 普通值 > 0 时按 D12 修复 current >= max 触发.
  const globalMax = getMaxGoalRounds();
  const rawMax = perTaskMaxRounds ?? globalMax;
  const maxRounds = Math.min(
    Math.max(rawMax, MIN_MAX_GOAL_ROUNDS),
    MAX_MAX_GOAL_ROUNDS,
  );
  const resumeThreshold = getGoalResumeThreshold();
  const runtime = runtimeOverride ?? getRuntime();

  // Step 2: 前置检查 (D12 off-by-one 修复: current >= max → giveUp, 不是 new_rounds >= max).
  //   R143 四轮: maxRounds === 0 (不限轮次 sentinel) 跳过 giveUp, 让 loop 跑到
  //   grader 判 met / impossible 才停. 防止单次填 0 误锁死.
  if (maxRounds > 0 && goalRounds >= maxRounds) {
    const reason = `reached max_goal_rounds (${maxRounds}), last grader: ${graderFeedback}`;
    const session = runtime.getActiveSession(taskId);
    const costUsd = session?.getCostUsd() ?? task.cost_usd ?? 0;
    updateTaskStatus(taskId, "failed", {
      session_id: task.session_id || undefined,
      result: null,
      error: reason,
      cost_usd: costUsd,
      completed_at: new Date().toISOString(),
    });
    runtime.emitEvent(taskId, {
      type: "status_change",
      task_id: taskId,
      from: task.status,
      to: "failed",
      cost_usd: costUsd,
      reason: "goal_unreachable_max_rounds",
    });
    return { action: "giveUp", reason };
  }

  // Step 3: 计算 new_rounds.
  const newRounds = goalRounds + 1;

  // Step 4: 决策 — fork (高 context) vs continue (低 context).
  const shouldFork =
    contextUsage.contextTokens !== null &&
    contextUsage.contextMax !== null &&
    contextUsage.contextMax > 0 &&
    contextUsage.contextTokens / contextUsage.contextMax >= resumeThreshold;

  let decision: ContinueDecision;
  if (shouldFork) {
    // 漏洞 #8 修复: fork 分支必须显式拼 goal marker, 否则新 task 不接 goal loop.
    let promptOverride: string | undefined;
    if (goalText && goalText.length > 0) {
      // 默认 prompt = 与现有 forkSession() 内部 defaultPrompt 一致 (line 1648-1649),
      //   加 goal marker 后缀. caller 仍可显式传 opts.prompt 覆盖, 但 goal loop
      //   这条路径必须确保 marker 在 → 不让 caller 绕过这个修复.
      const defaultPrompt =
        `请从父任务 ${taskId} 的 checkpoint 继续处理（已经 fork 出新的 SDK session）。` +
        `读取父任务的全部上下文，承接后续工作。`;
      promptOverride = `${defaultPrompt}\n\n<goal>\n${goalText}\n</goal>\n`;
    } else {
      // 异常: task 没 goal_text 但走到了 goal loop fork 路径 = active-session 解析
      //   出 bug. fallback = 让 forkSession 用默认 prompt (不含 marker), 让 fork
      //   task 当普通 task 跑 (不致命), + warn 让人工能看见.
      console.warn(
        `[continueGoalLoop] task ${taskId} has no goal_text in metadata; fork prompt will not include <goal> marker — fork task won't continue goal loop`,
      );
    }

    const forkResult = await runtime.forkSession(taskId, {
      compactFirst: true,
      ...(promptOverride ? { prompt: promptOverride } : {}),
    });
    decision = {
      action: "fork",
      newTaskId: forkResult.newTaskId,
      newSessionId: forkResult.newSessionId,
    };
  } else {
    // 续同 session: pushMessage 让 generator 排空, SDK 把注入消息当新一轮处理.
    //   active-session 的 createMessageGenerator while(!this.closed) 看到新消息就
    //   yield, 自动接上下一轮 query().
    const session = runtime.getActiveSession(taskId);
    if (!session) {
      throw new Error(
        `Task ${taskId} has no active session to pushMessage to (cannot continue goal loop)`,
      );
    }
    session.pushMessage(graderFeedback, "system");
    decision = { action: "continue" };
  }

  // Step 5: 原子写 task.metadata — goal_rounds / goal_history (cap 20, 漏洞 #2) /
  //   last_grader_reason.
  const newEntry: GoalHistoryEntry = {
    round: newRounds,
    verdict: "not_yet_met", // continueGoalLoop 只在 grader not_yet_met 时被调 (impossible 已翻 failed, met 不需要续)
    reason: graderFeedback,
    at: new Date().toISOString(),
    context_tokens: contextUsage.contextTokens,
    context_max: contextUsage.contextMax,
  };
  const cappedHistory = [...goalHistory, newEntry].slice(-GOAL_HISTORY_MAX_ENTRIES);

  // mutateTaskMetadata 走 JSON.parse → 脏值会 return false 不写 — 但 goal loop
  //   的写入不能因历史脏值被跳过 (会让 task 卡死). fallback = 直接 updateTask
  //   写入干净的新 metadata.
  const writeOk = mutateTaskMetadata(taskId, (meta) => {
    meta.goal_rounds = newRounds;
    meta.goal_history = cappedHistory;
    meta.last_grader_reason = graderFeedback;
  });
  if (!writeOk) {
    console.warn(
      `[continueGoalLoop] task ${taskId} metadata 脏值, 直接 updateTask 重置 goal loop 字段`,
    );
    updateTask(taskId, {
      metadata: JSON.stringify({
        goal_text: goalText,
        goal_rounds: newRounds,
        goal_history: cappedHistory,
        last_grader_reason: graderFeedback,
      }),
    });
  }

  return decision;
}

// Singleton
// 功能: 进程级唯一 AgentRuntime 实例的获取入口.
// 关注点: 不能只用模块级变量 — Next.js 的 instrumentation bundle 和 server bundle
//   是两份独立产物, 各持一份模块状态, 模块级单例会退化成「同进程两个 runtime」
//   (2026-09-18 实证: 每 boot 两次 Initialized / 两次 recover pass, 排队孤儿 +
//   僵尸 SDK 进程持 cwd 锁, 详见 docs/fixes/2026-09-18-queued-orphan-zombie-sdk-cwd-lock.md).
//   挂 globalThis + Symbol.for 跨 bundle 去重; vitest 下保留模块级 — globalThis
//   会跨测试文件泄漏已 init 的实例 (uncaught handlers / recover 扫库), 破坏按文件隔离.
let runtime: AgentRuntime | null = null;
const RUNTIME_GLOBAL_KEY = Symbol.for("agent-orchestrator.runtime");

// 功能: 真正构造 + 接线 + init 一个 AgentRuntime (getRuntime 的两分支共用).
function createRuntime(): AgentRuntime {
  const rt = new AgentRuntime();
  // R107 父子任务通知机制 (damo 0825 拍板). 注入 sendUserMessage 到 parent-notify,
  //   避免 parent-notify 反向引 runtime (循环依赖). 见 src/lib/runtime/parent-notify.ts.
  //   R127 §3.4 洞3: 同时注入 autoResume sender (this.autoResumeParentAfterChildComplete),
  //   用于血缘命中时父自动 approve 父 (skipReviewGate=true 唯一入口).
  setupParentNotify(
    (taskId, message, _reason, senderType) =>
      // R55 B1: R107 parent-notify = platform event, default senderType=system
      // (parent-notify.ts notifyViaSendUserMessage also passes "system" but
      // we default here too so a future direct caller doesn't drop the type).
      rt.sendUserMessage(taskId, message, undefined, "parent_notify", senderType ?? "system"),
    (childTaskId) => rt.autoResumeParentAfterChildComplete(childTaskId),
  );
  rt.init();
  return rt;
}

export function getRuntime(): AgentRuntime {
  // vitest: 模块级单例 (每测试文件独立 module registry, 与改前行为完全一致)
  if (process.env.VITEST) {
    if (!runtime) runtime = createRuntime();
    return runtime;
  }
  // 生产: globalThis 去重 — instrumentation bundle 先建, server bundle 后取同一个
  const holder = globalThis as { [k: symbol]: AgentRuntime | undefined };
  if (!holder[RUNTIME_GLOBAL_KEY]) holder[RUNTIME_GLOBAL_KEY] = createRuntime();
  return holder[RUNTIME_GLOBAL_KEY]!;
}
