// ScheduleRunner: polls due schedules every 60s and fires them.
//
// Agent schedules -> createTask + startTask (reuses the TaskScheduler queue,
// per-cwd mutual exclusion, the full lifecycle). Shell schedules ->
// child_process.spawn (detached, process-group leader) so a timeout can
// SIGTERM the whole group instead of leaving the child orphaned
// (damo 0906 P0 — fixes 295 条 sheetwatch 误派事故根因之一)。
// Tracked in an in-memory Set for skip_if_running; on timeout (exit 124)
// we additionally push next_run forward as a cooldown so the next tick
// can't immediately re-fire the same still-dead shell.
//
// Single-process today: the 60s tick + better-sqlite3 synchronous reads make
// the poll trivial. claimSchedule() advances next_run atomically BEFORE firing,
// so a crash mid-fire won't re-fire on restart (next_run is already at the
// future point). Missed fires while down are caught up on the first post-startup
// tick (next_run <= now); one catch-up fire per schedule, then it resumes cadence.

import { spawn } from "child_process";
import { getRuntime } from "./agent-runtime";
import {
  getUnfinishedTaskBySchedule,
  getTaskById,
  getStaleReviewingScheduledTasks,
} from "../db/tasks";
import {
  listDueSchedules,
  claimSchedule,
  computeNextRun,
  computeNextRunWithNight,
  recordRun,
  finishRun,
  updateSchedule,
  pushScheduleNextRun,
  markFired,
  purgeOldRuns,
  type Schedule,
} from "../db/schedules";
import {
  getGlobalScheduleRunsTtlDays,
  getGlobalScheduleRunsKeepLastN,
} from "../db/settings";
import { ORCHESTRATOR_HOME } from "../constants";
import { sendFeishuWebhook } from "../notify/feishu";
import {
  buildAdaptivePromptHeader,
  recordAdaptiveSnapshot,
} from "./schedule-adaptive-watcher";

const TICK_MS = 60_000;
const SHELL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const SHELL_MAX_BUFFER = 1024 * 1024; // 1 MB
const OUTPUT_TRUNCATE = 64 * 1024; // 64 KB stored per run
// 🆕 damo 0906 P0: shell schedule timeout 后冷却窗口(timeout → 立刻又 timeout 自激阻断)。
// 推 next_run 到 now + COOLDOWN_MS, 下 tick 自然不会再选中。
// 2h 是经验值:大多数 cron (5min/15min/1h) 推后到 2h 后足够让挂了的 sheetwatch 自己被 flock 互斥替代；
// 真的需要更激进可降低,但需谨慎 —— cooldown 期间该 schedule 完全不 fire。
const SHELL_TIMEOUT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h
// C 逻辑阈值: reviewing 卡 N 小时自动转 damo。
const REVIEWING_STALE_MS = 4 * 60 * 60 * 1000;
// B 逻辑注入上轮 result 时截断长度, 避免 prompt 爆栈。
const PREV_RESULT_INJECT_CHARS = 4000;

// In-flight shell executions, for skip_if_running (进程级)。task 级的闸门是
// unfinishedTask() —— 两类 schedule 都走它, 判据是 tasks.schedule_id 反查。
const runningShells = new Set<string>();

// 🆕 飞书 R86: SSE 流式日志用 in-memory buffer —— fireShell 每收到一段 stdout/stderr
//   同步写入 (子进程数据 → Map); finalize 写 completed:true, 5 分钟后清理(让前端能拿到
//   刚结束的状态+有出错时的 exit_code)。liveRuns 是单进程假设, 多实例需升级到 DB 写入。
//   - getLiveRun(runId): SSE 路由每 1s 轮询拉 snapshot。
//   - deleteLiveRun(runId): finalize 时 schedule 5min cleanup, 也可手动删(测试用)。
export interface LiveRunEntry {
  stdout: string;
  stderr: string;
  completed: boolean;
  exitCode: number | null;
  updatedAt: number;
}
const liveRuns = new Map<number, LiveRunEntry>();
const LIVE_RUN_TTL_MS = 5 * 60 * 1000;

export function getLiveRun(runId: number): LiveRunEntry | null {
  return liveRuns.get(runId) ?? null;
}
export function deleteLiveRun(runId: number): void {
  liveRuns.delete(runId);
}
// 测试用: 重置全部 in-memory state (含 runningShells / notifiedStaleReviewing / liveRuns)。
//   vitest beforeEach 调一次,避免上一个 case 的状态泄漏。
export function _resetRunnerStateForTest(): void {
  runningShells.clear();
  notifiedStaleReviewing.clear();
  liveRuns.clear();
  tickCounter = 0;
  // 清 global timer: 上个测试文件 start 过没 stop 时, interval + global 会跨文件
  // 泄漏 (tick 继续打日志/扫库), reset 一并兜掉.
  const g = globalTimer();
  if (g) {
    clearInterval(g);
    (globalThis as { [k: symbol]: unknown })[TIMER_GLOBAL_KEY] = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// C 逻辑去重: 已通知过的 stale reviewing taskId 记录下来, 避免每 tick 重发。
// Set 不清理: task 离开 reviewing 后 Set 里的 id 不会再被扫到（DB 已无该行）,
// 但为防极端情况（同一 taskId 反复进出 reviewing）加个 cap, 超了清空。
const notifiedStaleReviewing = new Set<string>();
const NOTIFIED_CAP = 5000;

// 功能: 60s tick 的 interval 句柄, 挂 globalThis 跨 bundle 去重.
// 关注点: 不能只用模块级变量 — instrumentation bundle 和 server bundle 各持一份
//   模块状态, 各自的 idempotent start 守卫互不可见 → maintenance enter/exit 后
//   两个副本同时 tick (同 schedule 双触发 + 维护期间照常造任务, 2026-09-18 双实例
//   实证的连带风险, 详见 docs/fixes/2026-09-18-queued-orphan-zombie-sdk-cwd-lock.md).
//   stop 两处都清, start 只看 global (global 清了就允许重启, 模块级 stale 值无害 —
//   真正的 interval 由新 start 重建).
let timer: ReturnType<typeof setInterval> | null = null;
const TIMER_GLOBAL_KEY = Symbol.for("agent-orchestrator.schedule-runner.timer");

function globalTimer(): ReturnType<typeof setInterval> | null {
  return (globalThis as { [k: symbol]: ReturnType<typeof setInterval> | null })[TIMER_GLOBAL_KEY] ?? null;
}

// 🆕 飞书 R79: schedule_runs 清理节流 —— 每 PURGE_EVERY_N_TICKS (=60) 次 tick 跑一次,
//   即每 60min. 与 schedule 60s tick 对齐, 既不挡 tick, 又不会高频清理 (高频
//   锁表即便很短也拖慢其它 DB 写入). counter 在 process 内有效, 重启清零 →
//   startScheduleRunner 启动后会先跑一次兜底 (避免 1h 窗口被快速灌满).
const PURGE_EVERY_N_TICKS = 60;
let tickCounter = 0;

// 功能: 按全局设置跑一次 schedule_runs 清理; 失败只 console.warn, 绝不拖垮 tick.
// 关注点:
//   - 走读 settings getter (而非 inject), 保证 PATCH 改值后下个 tick 即生效.
//   - 两个阈值都可 0 (=关闭该层). 都 0 时 skip, 不打空跑日志.
//   - 用 schedule_runner 同进程 (不另起 cron / 进程), 与 task_timeout_minutes
//     落库同模式, 无新依赖.
function maybePurgeScheduleRuns(): void {
  const ttlDays = getGlobalScheduleRunsTtlDays();
  const keepN = getGlobalScheduleRunsKeepLastN();
  if (ttlDays === 0 && keepN === 0) return;
  try {
    const r = purgeOldRuns({ olderThanDays: ttlDays || null, keepLastN: keepN || null });
    if (r.total > 0) {
      console.log(
        `[ScheduleRunner] Purged ${r.total} runs (byAge=${r.byAge}, byCount=${r.byCount}, ` +
        `ttlDays=${r.applied.olderThanDays}, keepLastN=${r.applied.keepLastN})`
      );
    }
  } catch (err) {
    // 兜底: 清理失败绝不让 tick 中断; 下个 tick 再试. 但要 warn, 否则用户看不到.
    console.warn(`[ScheduleRunner] purgeOldRuns failed:`, (err as Error).message);
  }
}

function truncate(s: string | Buffer): string {
  const str = typeof s === "string" ? s : s.toString("utf8");
  return str.length > OUTPUT_TRUNCATE ? str.slice(0, OUTPUT_TRUNCATE) + "\n...[truncated]" : str;
}

// 功能: 找出该 schedule 派出的、还没了结的 task（没有则 null）。防重派闸门的判据。
// 关注点: ① 判据是 tasks.schedule_id 反查, 不再是 schedule.last_task_id —— shell 类的
//   task 由脚本自己走 POST /api/tasks 建, runner 从不写 last_task_id, 以前这道闸门对
//   shell 等于不存在（v2-p0-loop 事故: 5 天重派 604 次、$206）；
//   ② 前提是脚本建 task 时传了 schedule_id, 没传的 shell 定时任务仍只有 runningShells
//   那道进程级闸门；
//   ③ 口径见 TERMINAL_TASK_STATUSES: reviewing/paused/rejected 都算「在飞」, 所以
//   一个干完等验收的任务会挡住下一次触发 —— 这正是事故要防的。要无条件每次都派的
//   schedule 把 skip_if_running 关掉。
function unfinishedTask(schedule: Schedule): { id: string; status: string } | null {
  const task = getUnfinishedTaskBySchedule(schedule.id);
  return task ? { id: task.id, status: task.status } : null;
}

// 功能: B 逻辑 —— 拼上轮 reviewing 任务的 result 进新 task prompt, 让新 agent
//   带着上下文接。若上轮没 result（agent 半途而废）则不拼, 避免误导。
// 关注点: ① 只查「该 schedule 派出的 + status=reviewing」的 task,
//   与 unfinishedTask 同源数据；② 截断 result 防止 prompt 爆炸。
function buildInheritedPrompt(
  schedule: Schedule,
  basePrompt: string
): string {
  const prev = unfinishedTask(schedule);
  if (!prev || prev.status !== "reviewing") return basePrompt;
  const prevTask = getTaskById(prev.id);
  if (!prevTask?.result) return basePrompt;
  const truncated =
    prevTask.result.length > PREV_RESULT_INJECT_CHARS
      ? prevTask.result.slice(0, PREV_RESULT_INJECT_CHARS) + "\n...[truncated]"
      : prevTask.result;
  return (
    `${basePrompt}\n\n---\n` +
    `# 上轮 reviewing 任务（task_id=${prev.id}, title="${prevTask.title}"）\n` +
    `上轮已停在 reviewing 等候。本轮请基于上轮结论继续推进：\n` +
    `- 若上轮已实质完成 → 调 POST /api/tasks/${prev.id}/approve 自动 approve；\n` +
    `- 若仍需 damo 决定 → 收尾说明清楚后停下, 报给 damo。\n\n` +
    `## 上轮 result（前 ${PREV_RESULT_INJECT_CHARS} 字）\n${truncated}\n`
  );
}

function fireAgent(
  schedule: Schedule,
  now: string,
  promptOverride?: string
): string {
  const runtime = getRuntime();
  // 🆕 v60: 自适应频率头部 —— schedule 启用 freq_min/max 时拼到 prompt 头部。
  //   拼在 inheritedPrompt 之前, 让硬指令先于 B 逻辑（继承上轮 result）,
  //   避免被上轮 result 段挤到末尾被 agent 忽略。
  const basePrompt = promptOverride ?? schedule.prompt!;
  const adaptiveHeader = buildAdaptivePromptHeader(schedule);
  const finalPrompt = adaptiveHeader
    ? `${adaptiveHeader}\n${basePrompt}`
    : basePrompt;
  const task = runtime.createTask({
    title: schedule.title!,
    prompt: finalPrompt,
    description: schedule.description ?? undefined,
    project_id: schedule.project_id!,
    version_id: schedule.version_id,
    priority: schedule.priority,
    cwd: schedule.cwd ?? undefined,
    // 🔴 第二道防线：写死 true, 即便 DB 行 schedule.auto_approve=0（历史数据 / SQL
    //   直接改 / 绕过路由）也不会让 agent task 卡 canUseTool 等审。damo 0829 拍板:
    //   "auto_approve 这个旋钮本身就不该存在, 直接内置为开"。
    auto_approve: true,
    model: schedule.model ?? undefined,
    allowedTools: schedule.allowed_tools ?? undefined,
    maxTurns: schedule.max_turns ?? undefined,
    effort: schedule.effort ?? undefined,
    tags: schedule.tags ?? undefined,
    schedule_id: schedule.id,
  });
  // 🆕 v60: 记 fire 时 expr 快照, 供 watcher 校验 B (本轮调了没) 对照。
  if (adaptiveHeader) {
    recordAdaptiveSnapshot(task.id, schedule.id, schedule.schedule_expr, "fire");
  }
  runtime.startTask(task.id);
  recordRun({ schedule_id: schedule.id, exec_type: "agent", task_id: task.id, started_at: now });
  markFired(schedule.id, { last_run: now, last_task_id: task.id });
  return task.id;
}

// 功能: shell 类型 schedule 执行入口 —— 用 spawn detached 让子进程成为进程组 leader,
//       timeout 时杀整个进程组(非单 pid),并推 next_run 冷却避免立刻又触发。
// 关注点:
//   - 0906 事故: 原版 exec 不带 detached → Node 只持 wrapper pid → SIGTERM 只杀 wrapper
//     → wrapper fork 的 python sheetwatch 变孤儿继续跑 → 下 tick skip_if_running 失效 → 再 fire →
//     多个孤儿并发跑 26 分钟误派 295 条 task。
//   - 修复: detached:true 让 shell 启动后子进程组 pgid = child.pid → process.kill(-pid, SIGTERM)
//     发到整个组。grace 2s 后 SIGKILL 兜底。
//   - buffer 截断: 原 exec 的 maxBuffer 由 Node 截断; spawn 没有, 自己用 stdout/stderr listener 累加
//     并按 SHELL_MAX_BUFFER 截断(防止内存爆)。
//   - 冷却: 仅在 timeout (124) 时设, 正常 exit 不动 next_run, 避免错过正常调度。
//   - 不影响 exec_type=agent 路径(走 createTask + startTask, 不在这)。
function fireShell(schedule: Schedule, now: string): void {
  const runId = recordRun({
    schedule_id: schedule.id,
    exec_type: "shell",
    command: schedule.command,
    started_at: now,
  });
  runningShells.add(schedule.id);
  markFired(schedule.id, { last_run: now, last_exit_code: null }); // null = "in progress"
  const cwd = schedule.cwd ?? ORCHESTRATOR_HOME;

  const child = spawn(schedule.command!, {
    cwd,
    shell: true,
    detached: true, // 新进程组 leader, pgid === child.pid
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 手动累加 stdout/stderr, 超 SHELL_MAX_BUFFER 立即停止写入。
  let stdoutStr = "";
  let stderrStr = "";
  let stdoutOverflowed = false;
  let stderrOverflowed = false;
  child.stdout?.on("data", (c: Buffer) => {
    if (stdoutOverflowed) return;
    const s = c.toString();
    const remaining = SHELL_MAX_BUFFER - stdoutStr.length;
    if (remaining <= 0) {
      stdoutOverflowed = true;
      // 🆕 R86: 即使不再追加, 也要写一次 liveRuns 让前端看到「已截断」标记
      //   (entry 里有 stdoutStr, 长 = SHELL_MAX_BUFFER = 暗示已满)。
      liveRuns.set(runId, {
        stdout: stdoutStr,
        stderr: stderrStr,
        completed: false,
        exitCode: null,
        updatedAt: Date.now(),
      });
      return;
    }
    if (s.length > remaining) {
      stdoutStr += s.slice(0, remaining);
      stdoutOverflowed = true;
      // 🆕 R86: 截断时也得写一次 (同上, 否则前端永远看不到这一帧)。
      liveRuns.set(runId, {
        stdout: stdoutStr,
        stderr: stderrStr,
        completed: false,
        exitCode: null,
        updatedAt: Date.now(),
      });
      return;
    }
    stdoutStr += s;
    // 🆕 飞书 R86: 同步写入 liveRuns —— SSE 路由每 1s 读一次推给前端,
    //   自动滚动到最新需要看 on('data') 的频率; 同步写没引入额外异步/锁,
    //   只是 Map.set 单调操作, 不影响 child_process 内部。
    liveRuns.set(runId, {
      stdout: stdoutStr,
      stderr: stderrStr,
      completed: false,
      exitCode: null,
      updatedAt: Date.now(),
    });
  });
  child.stderr?.on("data", (c: Buffer) => {
    if (stderrOverflowed) return;
    const s = c.toString();
    const remaining = SHELL_MAX_BUFFER - stderrStr.length;
    if (remaining <= 0) {
      stderrOverflowed = true;
      // 🆕 R86: 截断时也得写一次 liveRuns (与 stdout 同步, 避免前端漏帧)。
      liveRuns.set(runId, {
        stdout: stdoutStr,
        stderr: stderrStr,
        completed: false,
        exitCode: null,
        updatedAt: Date.now(),
      });
      return;
    }
    if (s.length > remaining) {
      stderrStr += s.slice(0, remaining);
      stderrOverflowed = true;
      liveRuns.set(runId, {
        stdout: stdoutStr,
        stderr: stderrStr,
        completed: false,
        exitCode: null,
        updatedAt: Date.now(),
      });
      return;
    }
    stderrStr += s;
    liveRuns.set(runId, {
      stdout: stdoutStr,
      stderr: stderrStr,
      completed: false,
      exitCode: null,
      updatedAt: Date.now(),
    });
  });

  // 进程组 pgid === child.pid (因 detached:true)。timeout → SIGTERM 整个组 → grace 2s → SIGKILL 兜底。
  let killGraceTimer: NodeJS.Timeout | null = null;
  let killed = false;
  const killGroup = (signal: NodeJS.Signals): void => {
    if (killed) return;
    killed = true;
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // ESRCH = no such process(已退出),忽略;其他(EPERM 等)打 warn 不阻断。
      if (e.code !== "ESRCH") {
        console.warn(
          `[ScheduleRunner] kill(-${pid}, ${signal}) failed: ${e.code ?? e.message}`
        );
      }
    }
  };
  const timeoutTimer = setTimeout(() => {
    killGroup("SIGTERM");
    killGraceTimer = setTimeout(() => killGroup("SIGKILL"), 2000);
  }, SHELL_TIMEOUT_MS);

  const finalize = (exitCode: number): void => {
    clearTimeout(timeoutTimer);
    if (killGraceTimer) clearTimeout(killGraceTimer);
    finishRun(runId, {
      exit_code: exitCode,
      output: truncate(stdoutStr),
      error: truncate(stderrStr),
      completed_at: new Date().toISOString(),
    });
    // 🆕 飞书 R86: 标记 completed + 5min 后清 map —— 让前端拿到 exit_code 后能切到「累积完整」视图;
    //   5min 是经验值: 用户开 modal 看一眼到关闭, 期间能拉到稳定 snapshot; 真要看历史走 DB 兜底。
    liveRuns.set(runId, {
      stdout: stdoutStr,
      stderr: stderrStr,
      completed: true,
      exitCode,
      updatedAt: Date.now(),
    });
    setTimeout(() => liveRuns.delete(runId), LIVE_RUN_TTL_MS);
    markFired(schedule.id, { last_run: now, last_exit_code: exitCode });
    // 🆕 damo 0906 P0: timeout 后强制冷却,推 next_run 到 now + COOLDOWN_MS,避免下 tick 立刻又 fire。
    if (exitCode === 124) {
      const cooldownUntil = new Date(Date.now() + SHELL_TIMEOUT_COOLDOWN_MS).toISOString();
      try {
        pushScheduleNextRun(schedule.id, cooldownUntil);
        console.error(
          `[ScheduleRunner] Shell schedule ${schedule.name} (${schedule.id}) timed out, cooldown until ${cooldownUntil}`
        );
      } catch (err) {
        console.error(
          `[ScheduleRunner] cooldown pushScheduleNextRun failed for ${schedule.id}:`,
          err
        );
      }
    }
    runningShells.delete(schedule.id);
  };

  child.on("exit", (code, signal) => {
    // signal 出现表示被我们(或外部)杀了 → 走 124 路径。
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      finalize(124);
    } else {
      finalize(code ?? 0);
    }
  });
  child.on("error", (err) => {
    // spawn 阶段就失败(命令不存在 / cwd 找不到 / EACCES)。
    finalize(1);
    console.error(
      `[ScheduleRunner] spawn error for ${schedule.name} (${schedule.id}):`,
      err
    );
  });
}

// Manual trigger (POST /api/schedules/[id]/runs): fire now without advancing
// next_run or disabling a once schedule - the normal cadence is untouched,
// this is purely an extra run. skip_if_running still applies (returns a reason
// so the caller can surface a 409). Works regardless of `enabled` - manual is
// explicit and should fire even a paused/disabled schedule.
export function triggerSchedule(schedule: Schedule): {
  fired: boolean;
  reason?: string;
  task_id?: string;
} {
  const now = new Date().toISOString();
  if (schedule.skip_if_running) {
    if (schedule.exec_type === "shell" && runningShells.has(schedule.id)) {
      return { fired: false, reason: "上一次触发的命令仍在执行" };
    }
    const pending = unfinishedTask(schedule);
    if (pending) {
      return {
        fired: false,
        reason: `上一次派出的任务还没走完（${pending.id} 状态 ${pending.status}）`,
      };
    }
  }
  try {
    if (schedule.exec_type === "agent") {
      const task_id = fireAgent(schedule, now);
      return { fired: true, task_id };
    }
    fireShell(schedule, now);
    return { fired: true };
  } catch (err) {
    return {
      fired: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// 功能: C 逻辑 —— 扫所有「由 schedule 派出 + 卡 reviewing 超 4h」的 task,
//   通过飞书 webhook 通知 owner 转 damo 拍板。已通知过的不再重发。
// 关注点: ① 直查 DB 拿 (task, schedule, owner) 三方信息, 不用 ORM 防 SQL 散落;
//   ② 防重靠内存 Set, 重启进程后已通知状态会丢, 但代价是同 task 多发一次,
//      可接受; ③ cap=5000 防极端情况下 Set 无限增长。
async function notifyStaleReviewingTasks(): Promise<void> {
  if (notifiedStaleReviewing.size > NOTIFIED_CAP) {
    notifiedStaleReviewing.clear();
  }
  const nowMs = Date.now();
  const stale = listStaleReviewingScheduledTasks(REVIEWING_STALE_MS);
  for (const { task, schedule, owner } of stale) {
    if (notifiedStaleReviewing.has(task.id)) continue;
    const hoursIdle = ((nowMs - new Date(task.updated_at + "Z").getTime()) / 3600_000).toFixed(1);
    const subject = `[ScheduleRunner] schedule "${schedule.name}" 上轮 task 卡 reviewing ${hoursIdle}h`;
    const lines = [
      `task_id: ${task.id}`,
      `title: ${task.title}`,
      `schedule: ${schedule.name} (${schedule.id})`,
      `schedule expr: ${schedule.schedule_expr}`,
      `last update: ${task.updated_at}`,
      `idle: ${hoursIdle} 小时（阈值 ${REVIEWING_STALE_MS / 3600_000}h）`,
      "",
      "下轮 schedule 触发时, 新 agent 会读上轮 result 拼进 prompt, 但 task 仍卡 reviewing 阻塞闸门.",
      "请到 UI 处理: approve / reject / fork, 或调 POST /api/tasks/" + task.id + "/cancel 软删.",
    ];
    const message = `⚠️ ${subject}\n` + lines.join("\n");
    const sent = await sendToOwner(owner, subject, message);
    notifiedStaleReviewing.add(task.id);
    console.log(
      `[ScheduleRunner] notified stale reviewing task ${task.id} (schedule ${schedule.id}) to owner ${owner?.id ?? "?"} sent=${sent}`
    );
  }
}

// 功能: 拿 schedule owner 的飞书 webhook URL 并发送（无 webhook 则降级 console）。
// 关注点: sendFeishuWebhook 永不抛错, 这里也吞所有错误并 console.warn, 避免 C 逻辑拖垮 tick。
async function sendToOwner(
  owner: { id: string; feishu_webhook_url: string | null; notify_email: string | null } | null,
  subject: string,
  message: string
): Promise<boolean> {
  const webhook = owner?.feishu_webhook_url;
  if (webhook) {
    const r = await sendFeishuWebhook({ webhookUrl: webhook, message });
    if (r.sent) return true;
    console.warn(`[ScheduleRunner] feishu notify failed: ${r.reason ?? "?"}`);
  }
  // 兜底: 即便没 webhook 也打一行, pm2 log 能看到。
  console.warn(`[ScheduleRunner] STALE REVIEWING | ${subject}\n${message}`);
  return false;
}

// 功能: 直查 DB 拿「reviewing + 由 schedule 派出 + idle 超阈值」的任务三方信息。
// 关注点: 实现放在 src/lib/db/tasks.ts, 这里只调用; SQL 端算 idle (毫秒级),
//   避免 JS 端时区/字符串解析坑。owner 没拿到时返 null, 调用方降级 console。
function listStaleReviewingScheduledTasks(
  staleMs: number
): ReturnType<typeof getStaleReviewingScheduledTasks> {
  return getStaleReviewingScheduledTasks(staleMs);
}

/**
 * ScheduleRunner 每 60s 一次的轮询主循环 — 拉 due schedules, 按 exec_type 派发.
 *
 * @requirement 飞书 R10
 * @feature schedule-tick
 * @module runtime
 * @see-exclusive src/lib/runtime/schedule-runner.ts:120 unfinishedTask
 * @see-info docs/schedules.md
 */
async function tick(): Promise<void> {
  const now = new Date().toISOString();

  // 🆕 飞书 R79: 每 60 tick (=1h) 跑一次 schedule_runs 清理, 失败仅 warn 不阻断 tick.
  //   放在 tick 入口最前面, 让高频 schedule 的清理开销不阻塞 due-fire 路径;
  //   即便 purge 慢一拍, 也没数据正确性问题 (最差只是多保留一段时间).
  tickCounter++;
  if (tickCounter >= PURGE_EVERY_N_TICKS) {
    tickCounter = 0;
    maybePurgeScheduleRuns();
  }

  // C 逻辑: 先扫 stale reviewing 转 damo, 再跑正常 due 触发。
  await notifyStaleReviewingTasks();

  const due = listDueSchedules(now);
  for (const schedule of due) {
    // Compute next run and atomically claim by advancing next_run BEFORE firing.
    // A crash after this line won't re-fire: next_run is already in the future.
    // 🆕 飞书 R96: 启用了 night_* 智能降频的 schedule 走带 night 的版本，
    //   跨午夜时按当前时段选 expr 计算 next_run；其它 schedule 行为不变。
    const next = schedule.night_schedule_expr != null
      ? computeNextRunWithNight({
          schedule_type: schedule.schedule_type,
          schedule_expr: schedule.schedule_expr,
          timezone: schedule.timezone,
          night_start_hour: schedule.night_start_hour,
          night_end_hour: schedule.night_end_hour,
          night_schedule_expr: schedule.night_schedule_expr,
        })
      : computeNextRun(schedule);
    const newNextRun = next ?? "9999-12-31T23:59:59Z";
    if (!claimSchedule(schedule.id, schedule.next_run, newNextRun)) continue;

    // 'once' schedules have no recurrence -> disable after claiming.
    if (schedule.schedule_type === "once") {
      updateSchedule(schedule.id, { enabled: false });
    }

    // skip_if_running: don't pile up overlapping runs of the same schedule.
    // 跳过必须打日志: 否则「schedule 到点没触发」在外面完全看不出原因。
    //
    // 0830 hotfix (damo 拍板按 7d6ebfb6 建议方案 B):skip 时回退 next_run 到原值,
    // 避免「claimSchedule 推进 next_run → skip → 永久不再被选中」的永久死锁。
    // 即使 agent task 卡 reviewing(无人 unset-awaiting-review),schedule 仍每 tick
    // 重新尝试,而不是一 skip 就再也不会 fire。
    //
    // 0901 改动 (damo 拍板 B+C):reviewing 不再算「在跑」——
    //   agent 干完停在 reviewing 是常态, 不该挡下一轮。reviewing 的 task 会通过
    //   B 逻辑（buildInheritedPrompt）把 result 拼进新 task prompt, 让新 agent 接着干。
    //   只有 running/pending/queued 这类「真正还在执行中」的 task 才会 skip。
    if (schedule.skip_if_running) {
      if (schedule.exec_type === "shell" && runningShells.has(schedule.id)) continue;
      const pending = unfinishedTask(schedule);
      if (pending && pending.status !== "reviewing") {
        console.log(
          `[ScheduleRunner] Skip ${schedule.name} (${schedule.id}): task ${pending.id} still ${pending.status}`
        );
        // 回退 next_run,让下个 tick 重新选中
        claimSchedule(schedule.id, newNextRun, schedule.next_run);
        continue;
      }
      // pending=null 或 pending.status=reviewing → 放行 fire
    }

    // B 逻辑: 拼上轮 reviewing result 进 prompt（如果存在）。
    const inheritedPrompt = buildInheritedPrompt(schedule, schedule.prompt!);

    try {
      if (schedule.exec_type === "agent") {
        fireAgent(schedule, now, inheritedPrompt);
      } else {
        fireShell(schedule, now);
      }
    } catch (err) {
      console.error(
        `[ScheduleRunner] Error firing schedule ${schedule.id} (${schedule.name}):`,
        err
      );
    }
  }
}

// 测试用: 让 vitest 能直接调一次 tick 验证回退逻辑, 不依赖 60s 定时器。
export { tick as _tickForTest };

export function startScheduleRunner(): void {
  if (timer) return; // idempotent (本 bundle 副本)
  if (globalTimer()) return; // idempotent (另一 bundle 副本已在跑)
  timer = setInterval(() => {
    tick().catch((err) => console.error("[ScheduleRunner] tick error:", err));
  }, TICK_MS);
  (globalThis as { [k: symbol]: unknown })[TIMER_GLOBAL_KEY] = timer;
  // First tick shortly after startup so a due schedule doesn't wait 60s.
  setTimeout(() => {
    tick().catch((err) => console.error("[ScheduleRunner] initial tick error:", err));
  }, 5_000);
  // 🆕 飞书 R79: 启动时立刻跑一次 purge, 兜住「1h 窗口被快速灌满」的情况
  //   (e.g. 之前没清理过, schedule 一天堆 MB). 同步执行, 不阻断启动 (purge 是
  //   DELETE 操作, 失败仅 warn). counter 仍从 0 开始, 60 tick 后再清一次.
  try {
    maybePurgeScheduleRuns();
  } catch {
    // maybePurgeScheduleRuns 内部已 swallow; 这里再包一层防御性 no-op.
  }
  console.log("[ScheduleRunner] Started (60s interval)");
}

export function stopScheduleRunner(): void {
  const g = globalTimer();
  if (g) {
    clearInterval(g);
    (globalThis as { [k: symbol]: unknown })[TIMER_GLOBAL_KEY] = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
