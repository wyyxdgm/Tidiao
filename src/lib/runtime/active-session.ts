// ActiveSession: manages a single running agent session

import { query, type Query, type SDKMessage, type SDKUserMessage, type CanUseTool, type PermissionResult, type OnUserDialog, type UserDialogRequest, type UserDialogResult, type HookCallback, type PreToolUseHookSpecificOutput, type SyncHookJSONOutput, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type {
  Task,
  AgentEvent,
  TaskResult,
  ToolApprovalRequestEvent,
  UserDialogRequestEvent,
  UserDialogTimeoutEvent,
  UserDialogKind,
  UserDialogQuestion,
} from "./types";
import { updateTaskStatus, updateTask, getTaskById, drainPendingMessages, mutateTaskMetadata } from "../db/tasks";
import { warmResultLayersForTask } from "./result-layers-store";
import { warmCardSummaryForTask } from "./card-summary-store";
import { stripRuntimeMarkers } from "./runtime-markers";
import { createSession, updateSessionCost, updateSessionStatus } from "../db/sessions";
import { insertEvent } from "../db/events";
import { insertCheckpoint } from "../db/checkpoints";
import { upsertTaskCommit } from "../db/task-commits";
import { backfillTaskCommits, gitCommitTime } from "../git/collect-task-commits";
import { getCurrentGitHead } from "./git";
import { estimateCostUsd, estimateCostWithPrices, hasAnyPrice } from "./cost-estimate";
import { checkBashDeploy, checkProcessKill } from "./deploy-guard";
import { resolveRunnerRoute } from "../runners/routing";
import { executeOnRunner } from "../runners/exec";
import { formatExecResult } from "../runners/format";
import { getConnection } from "../runners/registry";
import { cancel as cancelRunnerExec } from "../runners/client";
import { checkUserQuotaWithCurrent, recordQuotaExceededRuntime, resolveGitIdentity, resolveUserProfile } from "../db/users";
import { checkAdaptiveFrequency } from "./schedule-adaptive-watcher";
import { ALL_TOOLS, ORCHESTRATOR_HOME, CLAUDE_CONFIG_DIR } from "../constants";
import { resolveLlmConfig, planVisionSwap, getLlmPrices, type ResolvedLlmConfig } from "../db/llm-configs";
import { listAttachmentsByTaskId } from "../db/attachments";
import { getProjectById } from "../db/projects";
import { getVersionById } from "../db/versions";
import { getMediaKey } from "../db/media-keys";
import { getRoleById } from "../db/roles";
import { registerAttachmentFromPath } from "../db/attachments";
import { decrypt } from "../crypto";
import { issueSwitchToken } from "../auth-switch-token";
import { createMediaServer } from "./providers/sdk-tools";
import { createReviewServer } from "./providers/review-tools";
import type { AssetDescriptor } from "./providers/base";
import { getRuntime } from "./agent-runtime";
import { gradeGoal, type GoalVerdict, type GoalGradeResult } from "./goal-grader";
import { summarizeTranscriptForGrader } from "./llm-summarize";
import { continueGoalLoop } from "./agent-runtime";
import fs from "fs";
import path from "path";

type EventCallback = (event: AgentEvent) => void;

// Send-time overrides for a single run. All optional; absent fields fall back
// to the task row's stored values (which already carry role inheritance).
//
// `model` is tri-state (see resolveLlmConfig):
//   undefined -> use task.model (scheduled/non-interactive runs)
//   null      -> ignore task.model, use the latest default chain
//   string    -> use this specific model
export type RunOpts = {
  model?: string | null;
  effort?: string;
  max_turns?: number;
};

// Parse send-time override fields from an API request body into RunOpts.
// Returns undefined when no overrides are present (caller stays on task-row
// defaults). `model` is tri-state to match resolveLlmConfig:
//   absent/undefined -> opts.model unset -> use task.model
//   null or ""       -> opts.model = null  -> ignore task.model (latest default)
//   non-empty string -> opts.model = string -> use this model
export function parseRunOpts(body: unknown): RunOpts | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const opts: RunOpts = {};
  if ("model" in b) {
    const m = b.model;
    if (m === null) opts.model = null;
    else if (typeof m === "string") opts.model = m.length > 0 ? m : null;
  }
  if (typeof b.effort === "string" && b.effort) opts.effort = b.effort;
  if (b.max_turns != null) {
    const n = Number(b.max_turns);
    if (Number.isFinite(n) && n > 0) opts.max_turns = Math.floor(n);
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

// Tools that modify files or execute commands — require runtime approval.
// Agent 也加进来: 派出去的 subagent 会写文件/跑 bash/改 state, 语义上同
// "派生写类". buildAllowedTools 会把 Agent 从 allowedTools 过滤掉 -> SDK 不自动放行 ->
// canUseTool 必须被调到 -> 后台 Agent 调用可在 canUseTool 里被 deny.
// 拆解: 原因 2026-08-11 task 14c38246 踩的坑(SDK 默放 Agent, canUseTool 不调, 主防线失效).
const WRITE_TOOLS = new Set(["Write", "Edit", "Bash", "NotebookEdit"]);
// Configurable built-in tools (mirrors ALL_TOOLS in constants). canUseTool
// denies any tool in this set that isn't in the task's configured list.
const CONFIGURABLE_TOOLS = new Set<string>(ALL_TOOLS);

interface PendingApproval {
  resolve: (result: PermissionResult) => void;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  requestId: string;
}

// In-memory store of pending SDK `request_user_dialog` requests. The agent
// is blocked inside `onUserDialog` until the user (or close()/abort) resolves
// the matching entry. Mirrors the `pendingApprovals` shape used for canUseTool.
//
// `source` discriminates the two paths that can produce a pending dialog:
//   - "onUserDialog": SDK routed a `request_user_dialog` control request
//     through our `onUserDialog` hook (future dialog kinds). Resolved with a
//     `UserDialogResult`.
//   - "canUseTool": the built-in `AskUserQuestion` tool reached `canUseTool`
//     (the SDK in 0.3.x doesn't route it through `request_user_dialog`). We
//     intercept it here and resolve with a `PermissionResult` whose deny
//     message carries the user's answer, since `allow` would let the CLI's
//     internal handler run and return "user did not answer" in headless mode.
interface PendingUserDialog {
  resolve: (result: UserDialogResult | PermissionResult) => void;
  kind: UserDialogKind;
  source: "onUserDialog" | "canUseTool";
  requestId: string;
  toolUseId?: string;
  questions: UserDialogQuestion[];
  emittedAt: number;
}

// 功能: 波 2.5 auto_complete (docs/plans/auto-complete-dag.md D7.2#3) —
//   auto_complete=1 的 task 进 reviewing 后调这个函数, 自动翻 completed.
//   复用 getRuntime().approveTask 全部副作用 (events/webhook/父通知/
//   autoStartDependents), 不另起转换路径.
// 关注点: 调用方 (ActiveSession result 路径) 用 setTimeout 0 fire-and-forget,
//   不阻塞 result 返回; approveTask 同步执行, throw (task 不在 reviewing 等
//   终态 / awaiting_owner_review gate 的 AWAITING_OWNER_REVIEW — agent 显式
//   要人拍板的任务不该被跳过) 被 catch 记 error log, 状态保持 reviewing 等人.
//   非 auto_complete 任务调进来是 no-op (第 2 道闸, 第 1 道在调用点).
export function maybeAutoCompleteReviewing(taskId: string): void {
  try {
    const task = getTaskById(taskId);
    if (task?.auto_complete !== 1) return;
    getRuntime().approveTask(taskId);
  } catch (err) {
    console.error(
      `[ActiveSession] auto_complete approve failed for task ${taskId}: ${(err as Error).message}`
    );
  }
}

export class ActiveSession {
  private queryInstance: Query | null = null;
  private closed = false;
  // Goal-driven loop (D20, damo 2026-09-14 拍板): 启动时从 task.prompt 解析
  //   <goal>...</goal> marker (首匹配 /<goal>([\s\S]*?)<\/goal>/, D16 cap 4KB).
  //   命中 → 缓存到 this.goalText + 写 task.metadata.goal_text (启动时一次).
  //   不命中 → this.goalText = null, 原行为不变. success 路径拦截时,
  //   if (this.goalText != null) → 调 gradeGoal 决策续跑.
  // 漏洞 #1 缓解 (P1): marker 不会被 prompt 里别的 <...> 块误命中 (regex
  //   只认 <goal>...</goal> 字面), 但用户写「修改 <config> 块」之类的
  //   字面冲突仍会触发 marker 解析 → 后续 cap 4KB + 缺失字段自然降级
  //   到 not_yet_met, 不让无效 goal 把 task 干死.
  private goalText: string | null = null;
  // 2026-08-22 task e43eeb0d 回归: SDK Query.close() 只 processStdin.end() ——
  // subprocess 阻塞在 sleep/bash 等长 tool 时, 收不到 EOF 立即退出, 仍能 emit
  // 缓冲消息甚至 result message. 旧版 consumeMessages 无条件
  // updateTaskStatus("reviewing") 覆盖外部 pause/cancel 已写入的 paused/cancelled
  // 状态, 用户看到「明明点暂停, 几秒后又开始输出 + 状态回 reviewing」.
  //
  // 解法双层:
  //   1) pauseTask/cancelTask 同步置 externallyTerminated=true,
  //      for-await 循环看到后 drop 后续消息 (不 emit SSE、不写 DB 状态) —
  //      用户看不到新内容, 后端不写错状态.
  //   2) 即便 flag 没及时生效 (e.g. recoverOrphanedTasks 重启场景), result
  //      分支按 task.status 现读, 已非 running 时不再写 reviewing/failed,
  //      把 cost 落库后直接 break.
  // 两者叠加覆盖 flag 路径 (pause/cancel) + 库状态路径 (server_restart
  // recoverOrphanedTasks, 旧 SDK 兼容).
  private externallyTerminated = false;
  // R216 (damo 2026-10-08): 插话打断 (barge-in). turn 进行中用户发消息时, 消息
  //   只能在 SDK turn 边界被拉取 —— 长工具调用期间持续排队, 体感「消息进不去」.
  //   解法: pushMessage 时若 turn 在跑 → 主动 interrupt 当前 turn (等价轻量
  //   pause→resume, session 不断), CLI 放弃当前 turn 后把插话消息当新 turn 跑
  //   (SDK interrupt_receipt 的 still_queued 语义兜底已投递消息).
  // messageInterruptAt: 最近一次插话 interrupt 发起时间. consumeMessages 收到
  //   error_during_execution result 时, 窗口内命中 = 被打断 turn 的正常收尾,
  //   不得翻 failed (那是 3841 else 分支的原行为). 用完即清, 防滞留误吞.
  // turnActive: generator yield 消息 → true (turn 即将开跑), result → false.
  private messageInterruptAt: number | null = null;
  private lastBargeInAt = 0;
  private turnActive = false;
  // 连发多条消息时的 interrupt 去抖: 第一条已发起 interrupt, 2s 内的不重复发起
  // (interrupt 对已打断 turn 是 no-op, 但避免刷 API/日志).
  private static BARGE_IN_DEBOUNCE_MS = 2_000;
  // interrupt 发起到 error result 到达的最大容忍窗口. 超窗视为非插话收尾,
  // 走原失败逻辑, 防止真实错误被误吞成「插话正常收尾」.
  private static BARGE_IN_RESULT_WINDOW_MS = 30_000;
  // R56 复发 (damo 2026-10-31) 修复: 插话 interrupt 时 SDK CLI 原生注入 canned
  // tool_result「The user doesn't want to proceed with this tool use... STOP what you
  // are doing and wait for the user to tell you how to proceed.」(措辞在 native 二进制
  // 里, 平台改不了). 弱模型 (MiniMax-M3 实测: R56 7+ 例, 复发 2026-10-09 / 10-31 两例)
  // 直球当成「用户叫停」→ ack「收到，停」+ end_turn 空等, 而实际没人叫停 —— interrupt
  // 只是为了投递插话消息. 本注记随插话消息一起投递, 在 canned 文本同一上下文里纠正语义.
  // 全模型生效, 不依赖 minimax-m3.md 指针被读 (实测弱模型会跳过 Read).
  private static readonly BARGE_IN_CONTEXT_NOTE = [
    "<system-reminder>",
    "如果上一条 tool_result 出现「The user doesn't want to proceed with this tool use... STOP what you are doing」这类英文，它是插话打断的系统事件 -- 平台为了把下面的消息立即送达而中断了正在跑的工具调用，不是叫停任务，也没有人要求你停止。不要回复「收到，停」/「停了。等指示」然后 end_turn 空等；被中断的那个工具调用不要原样重跑。读完下面的消息后继续按任务目标推进。",
    "</system-reminder>",
  ].join("\n");
  // 功能: 暴露 closed 状态供 AgentRuntime.sendUserMessage 判断会话是否正在关闭.
  // 关注点: closed=true 到 session 从 runtime.sessions 移除之间有竞态窗口,
  //   此期间到达的消息若 pushMessage 进内存队列会永远排空不了 -> 改走持久化队列.
  get isClosed(): boolean {
    return this.closed;
  }
  private taskId: string;
  private userId: string | null; // task.owner_id, buildEnv 注入 MMX_CONFIG_DIR 用
  private taskTitle: string;
  private taskModel: string | null = null;       // 🆕 D26: gradeGoal 凭证解析用
  private taskLlmConfigId: string | null = null; // 🆕 D26: gradeGoal 凭证解析用
  private projectId: string | null;
  private versionId: string | null;
  // 🆕 v60: schedule_id — 任务由 schedule 派出时非空, 自适应频率 watcher 据此校验。
  private scheduleId: string | null;
  private sessionId: string | null = null;
  private sessionRowCreated = false;
  private eventCallbacks: Set<EventCallback> = new Set();
  private messageResolvers: Array<(msg: SDKUserMessage | null) => void> = [];
  private pendingMessages: string[] = []; // queue for messages arriving before the generator awaits
  private costUsd = 0;
  // 累计各轮 usage 的 token 数. total_cost_usd 只出现在 result 消息上, 被中断
  // 的会话永远走不到 result -> costUsd 恒 0; 但每条 assistant 消息都带 usage,
  // 所以 token 是可得的. 中断时用它折算出估算花费, 避免 cost_usd 留 NULL.
  private tokensIn = 0;
  private tokensOut = 0;
  private tokensCacheRead = 0;
  private tokensCacheWrite = 0;
  private cwd: string;
  private autoApprove: boolean;
  // Resolved LLM config for this task (env → user → project → task chain).
  // Computed once at construction; config changes mid-run don't affect it.
  private resolvedConfig: ResolvedLlmConfig;
  // Send-time overrides (model/effort/max_turns) captured at construction.
  // Absent fields fall back to the task row.
  private runOpts: RunOpts;
  // Tools the operator configured for this task (from allowed_tools, or 全开
  // fallback). canUseTool denies configurable tools not in this set.
  private configuredTools: Set<string>;
  private pendingApprovals: Map<string, PendingApproval> = new Map(); // requestId → pending
  private pendingUserDialogs: Map<string, PendingUserDialog> = new Map(); // requestId → pending dialog
  // Transcript slice accumulating since the last emitted checkpoint (or session
  // start). Per-step dedup is handled by the DB UNIQUE (task_id, step,
  // up_to_message_id) — same step in the same message is a replay (UPDATE),
  // same step in a different message is a distinct stage (new row). We don't
  // keep an in-memory Set anymore: it would suppress legitimate multi-stage
  // reuses of semantic step names (e.g. `step=final` in two chat turns).
  private currentSlice: Array<{ role: "user" | "assistant" | "tool_use"; text: string; uuid: string; sender_type?: "user" | "script" | "system" }> = [];
  // Streamed text for the in-progress assistant turn — needed because
  // includePartialMessages mode often emits assistant messages with empty
  // content (the real text comes via content_block_delta stream_events).
  private turnTextBuffer: string = "";
  // v61+R39: agent 在 result 末尾可写多个 marker 表达「请 damo 拍板 / 选 / 提示」.
  //   旧: <awaiting_review reason="..."/> → pendingAwaitingMarkers push
  //       {type:'review', desc:reason, data:null}
  //   新 (R39): <awaiting type="review|choice|info|..." desc="..." data='{...}'/> →
  //            pendingAwaitingMarkers push {type, desc, data}
  //   pendingAwaitingMarkers 是数组: 一个 result 可塞多个 (e.g. 同时问两个选项),
  //   all-of 收集不再 last-write-wins. running→reviewing 那笔 status update 把数组
  //   JSON.stringify 进 awaiting_markers TEXT 列, 同时只要数组非空就把
  //   awaiting_owner_review=1 (兼容 v56 的 approve gate).
  //   一次性消费: 落库后立刻清空, 防止 resume 后老 marker 复活设 flag.
  //   type 自由发挥 (damo R39 决定, schema 不锁死); desc 可选; data 可选 (JSON).
  //   Charset 限制见下面 AWAITING_MARKER_RE.
  //   R126 方案 A: 当 type="decision" 时, server 端在解析时分配 decision_id (uuid)
  //   并把 question / options / recommended / recommended_reason 提到顶层, 方便
  //   落 pending_decisions 时直接读, 不必再 JSON.parse(data).
  private pendingAwaitingMarkers: Array<{
    type: string;
    desc: string | null;
    data: unknown | null;
    decision_id?: string;
    question?: string;
    options?: Array<{ label: string; description?: string }>;
    recommended?: string;
    recommended_reason?: string;
  }> = [];
  // Tool use blocks emitted during streaming (via content_block_start).
  // When the finalized assistant message arrives, we skip re-emitting
  // these to avoid duplicate tool_use SSE events in the frontend.
  private streamingToolUseIds: Set<string> = new Set();
  // Tool ids whose complete input was already emitted via a
  // content_block_stop tool_use_update (and persisted). Used to avoid
  // re-emitting/re-logging when the finalized assistant message also
  // carries the same tool_use block.
  private streamingToolUseUpdated: Set<string> = new Set();
  // In-flight tool_use blocks keyed by streaming block index. The SDK
  // streams tool input as input_json_delta fragments; we accumulate them
  // here and emit a tool_use_update (with the full input) at
  // content_block_stop, so the frontend doesn't sit on an empty {}
  // placeholder until a manual refresh.
  private streamingToolBlocks: Map<number, { toolId: string; toolName: string; json: string }> = new Map();
  // 后台 subagent 逃逸防线. 会话内 `Agent` 工具默认 run_in_background=true, 派出的
  // subagent 活在 SDK 子进程里 —— result 一到就 closed=true 关进程, 它们被一起杀掉,
  // 报告永远回不来(2026-08-11 task 14c38246 实测: 派 2 个探索 agent, 53s 后收尾).
  // 判定按「当前 result 周期内 background Agent 派发数」, 不做 tool_use/tool_result
  // 配对 —— background 调用是立即返回 tool_result 的("已启动"), 配对判不出跑完没跑完.
  private bgAgentSpawns = 0;
  private bgAgentNudges = 0;
  // R132 升级 (damo 2026-09-07 拍板): 基于 SDK 0.3.220 task_started / task_notification
  //   系统消息维护的「真实在跑」subagent 集合 (替代单纯 spawns 计数). spawns 只统计
  //   「派了几次」, 不知道「跑完没」; task_* 信号是 SDK 报给我们的唯一权威来源. task_id
  //   在 task_started add、task_notification (completed/failed/stopped) delete. 收尾
  //   时靠这个 Set 决定 drain / nudge / stopTask.
  private inFlightSubagentIds: Set<string> = new Set();
  // 反查表: task_id → 触发它的 tool_use_id (来自 task_started.tool_use_id).
  //   暂未直接使用, 留给后续「按 tool 反向 stopTask」扩展.
  private taskIdToToolUseId: Map<string, string> = new Map();
  // 最近一次 task_updated / task_notification / task_progress 时间戳 (epoch ms).
  //   给上层观测 / 兜底逻辑用, 不直接控制流程.
  private lastBgTaskSummaryAt: number = 0;
  // 改短只方便单测加速, 不要改回大值影响线上; 写 protected 是为了让测试能 mock 时间
  // R132: 2 → 5 (damo 2026-09-07 拍板 B 兜底). task_* 主路径保证收尾时必 drain,
  //   这里只是给模型的「别主动结束」软提示, 上限放宽避免误杀: 5min drain 内每分钟一次足够.
  protected static readonly MAX_BG_AGENT_NUDGES = 5;
  // 🆕 D34: goal-self-report nudge 上限. 比 bgAgent (5) 少, 因为「prompt 末尾写
  //   个 markdown 块」是低门槛动作, 3 次仍不写 = model 真的不配合, 走 grader 兜底.
  protected static readonly MAX_GOAL_SELF_REPORT_NUDGES = 3;
  // Goal-driven loop (D20): 启动时从 task.prompt 解析 <goal>...</goal> marker.
  //   首匹配 = greedy enough 但只取首对大括号, 避免吃整段 prompt 进去.
  //   plan §9.5 漏洞 #1 (P1): marker 模式定死, 不让用户 config schema 撞上.
  //   D16 cap 4KB: 与 transcript_summary cap 同档, 避免恶意 / 手滑 prompt 撑大.
  private static readonly GOAL_MARKER_RE = /<goal>([\s\S]*?)<\/goal>/;
  private static readonly GOAL_MARKER_MAX_CHARS = 4096;
  // 🆕 D28: agent 自报告 goal_report 块提取 regex. 匹配 ```goal_report\n[内容]\n```
  //   闭包标记. 闭包 ``` 前后的 \n 必填 (防 greedy 吞掉下一个 code block).
  //   non-greedy 避免吃到下一个 ```xxx 开始.
  private static readonly GOAL_REPORT_RE = /```goal_report\n([\s\S]*?)\n```/;
  // 🆕 D34: success 路径前置 self-report 缺失检测的 nudge 计数. 独立于 goal_rounds
  //   (避免 max_goal_rounds 提前耗尽). nudge 用尽后走 grader 路径 fallback
  //   (selfReport 空 → transcriptSummary → not_yet_met → max_rounds 翻 failed).
  private goalSelfReportNudges = 0;
  // L2 注入 reminder 后, 若模型选择"我等结果"而 subagent 实际不存在, SDK 进程
  // 会被 Agent 工具的同步实现阻塞, task 永远卡在 running. 记最后一次 nudge 时间,
  // 下次 result 到达时若超过 BG_AGENT_NUDGE_TIMEOUT_MS 且模型仍在跑同一周期,
  // 主动 fail 不再 inject(否则只是续命). 实测 task 24458b91 等 20min 没人来救.
  private lastBgAgentNudgeAt: number | null = null;
  // R182: 最近一条 assistant 消息若是 SDK 的 synthetic API 错误 (model="<synthetic>"
  //   + 文本以 "API Error" 开头, 如 429 限流), 存错误文本; 正常消息到达即清空.
  //   result 收尾时据此把「SDK 报 success 但实际是 API 错误」的任务翻成 failed
  //   而不是 reviewing —— 否则零 token 消耗的报错任务会伪装成正常待审
  //   (实测 2026-10-04: 7 个 glm-5.3-flash 周配额 429 任务全进了 reviewing).
  private syntheticApiErrorText: string | null = null;
  // R175 追加 (damo 2026-10-04 反馈): 当前 attempt 之后剩余的链成员数. consumeMessages
  //   用它决定 synthetic API 错误要不要写终态 —— 还有链可试时不写 failed (避免
  //   中间态触发 task.failed webhook/父通知, 随后重试成功又变 reviewing 的双跳),
  //   由 start() 重试循环决定最终状态.
  private fallbackRemaining = 0;
  // R175 追加二 (2026-10-04 本地复现): 当前 attempt 里模型是否说过真话 (非 synthetic
  //   assistant 消息到达即置位, 每次 attempt 开头清零). catch 路径的零进度判据 ——
  //   替代旧的 !this.sessionId: synthetic 错误消息也带 session_id, 一到就把
  //   sessionId 置上, resume 任务更是本来就非空 → 旧条件永远不成立, 起跑 401/429
  //   的任务直接 failed 不进链重试 (本地 task 3c30b466 + 线上 c6d50986 双实证).
  private attemptHadModelOutput = false;
  // R212 (damo 2026-10-07 拍板「同一个凭证不重试」): quota 快速失败错误文本.
  //   consumeMessages 在 system api_retry/api_error 消息首次命中 429/配额类信号
  //   时置位并 close query (SDK 默认对同一凭证退避重试 10 次耗时 ~3min, task
  //   6af660e4 实录), 由 start()/resume() 的 quota 分支接管: 零进度且有链可试 →
  //   换凭证重跑; 已有进度或链尽 → failed(api_error:...) 终态. 每次 attempt
  //   开头清零 (与 attemptHadModelOutput 同节奏).
  private quotaFastFailError: string | null = null;
  // R227 (damo 2026-10-09 拍板, 修订 R212 口径): 429/rate_limit 允许重试 5 次.
  //   R212 把 429 和额度耗尽一起「首次命中即快速失败」, 但限流是瞬时的, SDK
  //   自带退避等一等就能过; R227 改为按信号类型分档:
  //   - rate_limit (HTTP 429 / rate_limit 枚举, 且文本无额度耗尽关键词) →
  //     放行 SDK 退避重试, 最多 5 次 (计数 api_retry/api_error 信号条数,
  //     第 6 条到来才 close 快速失败);
  //   - quota_exhausted (AccountQuotaExceeded / usage quota, 额度已耗尽,
  //     重试也没用) → 保持 R212 行为, 首次命中即 close 换链.
  //   每次 attempt 开头清零 (与 quotaFastFailError 同节奏).
  private rateLimitRetryCount = 0;
  // R212 边界修正 (2026-10-07 taoke 218c47dc 实录): SDK canned no-op 应答.
  //   resume/queue 注入轮里模型对「无需动作」的标准应答就是这句. 它进
  //   attemptHadModelOutput 后, 紧随其后的 429 快速失败会被误判成「已有进度,
  //   不换链」→ 直接 failed, fallback 链被一句垃圾应答废掉. 判据: 整块文本
  //   (trim 后) 恰好等于这句, 大小写不敏感, 句尾句号可有可无; 长文里出现
  //   这句话不命中.
  private static readonly NOOP_REPLY_RE = /^no response requested\.?$/i;
  // @internal 暴露给测试压短超时, 生产值 5min 不要改
  protected static readonly BG_AGENT_NUDGE_TIMEOUT_MS = 5 * 60 * 1000;
  // R132: result 收尾时, 等所有 in-flight subagent 自然跑完的总窗口 (含 drain + stopTask
  //   后的 grace). 5min 跟旧 BG_AGENT_NUDGE_TIMEOUT_MS 对齐 — 若所有 subagent 都没完成,
  //   走 stopTask 优雅停, 不会再 fail task. 测试可 override 压短.
  protected static readonly BG_AGENT_LIFECYCLE_DRAIN_MS = 5 * 60 * 1000;
  // R132: 调完 query.stopTask 后, 等 SDK 把 task_notification status='stopped' 落库
  //   的 grace window. stopTask 自身非阻塞 (sdk.d.ts:2562), 必须再等一会确认通知到位.
  protected static readonly BG_AGENT_STOP_GRACE_MS = 10 * 1000;
  // R132: ambient / housekeeping subagent 类型. 这些任务 skip_transcript=true, 不计入
  //   in-flight Set —— 它们就是被 SDK 静默运行不该关停的.
  //   task_type 实际取值见 SDK 0.3.220 SDKTaskStartedMessage.task_type 字段.
  private static readonly BG_AGENT_TASK_TYPES = new Set(["subagent", "bash"]);
  // 功能: 记住「已投给模型但模型一个字都还没回」的那条用户消息, 供 pauseTask 在
  //   interrupt 后回填 pending_messages, 下次 resume 重新投递.
  // 关注点: 模型一开口就清空 —— 只补投「完全没被响应」的消息, 已经开工的不重发,
  //   否则 resume 会让 agent 把做过的活再做一遍.
  private unansweredUserTurn: string | null = null;
  // resume 时无话可说的兜底 turn(见 resume() 双空分支)
  private static readonly RESUME_NUDGE = "继续";
  // 模型专属引导: 弱模型(如 MiniMax-M3)实测有「汇报口径与实际行为不一致」等问题,
  // 给它们挂一份开工前必读的引导 md. 文件放 claude-config(docs/claude-config/
  // docs/model-guidance/, sync-standards 分发到三台机器), 注入方式 = 首条 prompt
  // 前加一段 system-reminder 指路, agent 自己 Read -- 平台不把内容塞进上下文
  // (省 token, 改文件不用改代码). 文件不存在只 warn 不注入, 避免死指针.
  private static readonly MODEL_GUIDANCE: Array<{ pattern: RegExp; file: string }> = [
    { pattern: /minimax/i, file: "docs/model-guidance/minimax-m3.md" },
    // R3: 任何模型只要命中 /runner/i (大小写不敏感) 就提醒「Bash tool_result
    //   若以 [runner: 开头 = 平台伪造的远程执行结果」. 文件落
    //   docs/claude-config/docs/model-guidance/ (sync-standards 分发三台机器).
    //   pattern 不绑具体模型名 = 任何模型遇到 runner 输出都该知道;
    //   现在只 MiniMax-M3 / Anthropic Claude 等会被派任务, 后续扩模型
    //   也自动覆盖, 不必改代码.
    { pattern: /runner/i, file: "docs/model-guidance/runner-tool-result.md" },
  ];
  // R127 §3.1 方案 A: agent 写决策点依赖 <awaiting type="decision"/> 机制. v61 30 天
  //   0 用的根因就是 agent 不知道这个 marker 怎么写. 注入平台级 docs 强制所有模型
  //   首条 prompt 前读到 awaiting-owner-review.md (含 schema + 案例 + 校验规则).
  //   文件不存在只 warn 不注入, 与 MODEL_GUIDANCE 同款容错.
  //   与 MODEL_GUIDANCE 区别: MODEL_GUIDANCE 是「模型弱点引导」(针对性), 本数组是
  //   「平台机制必读」(普适). wording 也不同 (见 platformDocsReminder 注释).
  private static readonly AGENT_PLATFORM_DOCS: Array<{ file: string; reason: string }> = [
    {
      file: "docs/claude-config/docs/awaiting-owner-review.md",
      reason: "任务收尾时用 `<awaiting type=\"decision\"/>` 让 damo 在看板上一键决策, 不要让 damo 自己去聊天里考古",
    },
    {
      file: "docs/claude-config/docs/task-progress-selfreport.md",
      reason: "每个里程碑用 ao query PATCH 自报 task 完成度 (0-100 + 依据), 100% = 部署+验证通过 — 需求层完成度靠它供数 (R196)",
    },
  ];
  // Regex matches <checkpoint step=N summary="..." by="..." status="...">
  // (self-closing or not). Capture groups in order: [1]=step, [2]=summary,
  // [3]=by, [4]=status. step accepts numeric ("1", "2") or semantic
  // ("final", "milestone-1") tags — charset restricted to [A-Za-z0-9_-],
  // 1-64 chars, so the captured value can be stored verbatim in the
  // TEXT-typed step column without sanitization. summary captures any
  // quoted string (no charset cap, since it's free-form prose stored as
  // TEXT). by/status accept unicode letters/numbers + underscore/dash
  // ([\p{L}\p{N}_-]{1,64}) — R108 T6 放开, 让 damo 拍板的 4 个中文 status
  // (等回复/有建议/需拍板/卡住) 直通 parser; UI 映射走 status-display.ts.
  // by 同款 charset 支持中文 agent 标识 (e.g. "partner-agent"). step
  // 仍 ASCII — step 列语义是机器 tag, 不该夹中文.
  // All three optional attributes accept quoted or unquoted values
  // (step is required, summary/by/status all optional).
  // R108: by+status added for reviewing-card细化子状态 display
  // (等回复/有建议/需拍板/卡住). 向后兼容: 老 <checkpoint step=N
  // summary="..."/> 形态仍匹配 (by/status optional), 老 checkpoint
  // 行迁移后 by/status 为 NULL — UI 视作无细化状态.
  //
  // 🔴 R108 T4 实证: 单条顺序固定的正则**顺序敏感** — damo 拍的模板写
  //   `step,status,by,summary`, 老正则只认 `step,summary,by,status` → 整条
  //   marker NO MATCH → checkpoints 表 0 行 (4 个测试 task 全静默丢失).
  //   改为两段式: CHECKPOINT_RE 只框住 `<checkpoint ...>` 整体 + 属性串,
  //   CHECKPOINT_ATTR_RE 逐个抽属性 → 顺序无关. charset 校验移到取值处.
  //   R132: 外层 CHECKPOINT_RE 也加单引号支持 — 单引号值含空格 (e.g.
  //   step='final' summary='R108 修复完成') 老正则 [^\s"/>]+ 遇空格即停,
  //   整条 marker 匹配不到闭合 > → 静默丢失.
  private static readonly CHECKPOINT_RE =
    /<checkpoint((?:\s+[A-Za-z_]{1,16}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"/>]+))*)\s*\/?>/g;
  // 属性抽取: name="quoted value" / name='single-quoted' / name=bare_value,
  // 顺序无关. R132: 加单引号支持 — 老 [^\s"/>]+ 贪婪会吞单引号, 写
  //   step='final' 实际匹配到 step="'final'" (含两端引号), charset 拒绝
  //   → 整条 marker 静默丢失. 三组 match 形式按优先级 fallback.
  private static readonly CHECKPOINT_ATTR_RE =
    /([A-Za-z_]{1,16})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"/>]+))/g;
  // step: ASCII 机器 tag; by/status: 允许 unicode (中文 status 直通).
  private static readonly CHECKPOINT_STEP_RE = /^[A-Za-z0-9_-]{1,64}$/;
  private static readonly CHECKPOINT_BY_STATUS_RE = /^[\p{L}\p{N}_-]{1,64}$/u;

  // R113 (2026-09-07): <git commit-id="abc1234" desc="..." files="a.ts,b.ts"/>
  //   marker — 装入 task_commits 表, 供右侧 Commits Chain 面板渲染 git log 视图.
  //   严守 damo "不主动跑 git" 原则: 完全 agent 驱动, agent 写 marker 才有记录;
  //   没写的 task → Commits Chain 显示 "agent 未声明 git 提交" 提示.
  //
  //   与 CHECKPOINT_RE 的差异:
  //     - attribute name charset 扩成 `[A-Za-z_-]{1,16}` (允许连字符) — 因为
  //       commit-id 带连字符, 老 charset 会让整条 marker 静默丢失 (同根 R108 T4 教训).
  //     - commit-id 取值后单独 regex 校验 hex 7-64 (git short hash 到 full hash).
  //     - files 是逗号分隔, 解析时 split + trim + filter 空串.
  //   顺序无关 (与 CHECKPOINT_ATTR_RE 同款两段式).
  private static readonly GIT_COMMIT_RE =
    /<git((?:\s+[A-Za-z_-]{1,16}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"/>]+))*)\s*\/?>/g;
  private static readonly GIT_COMMIT_ATTR_RE =
    /([A-Za-z_-]{1,16})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"/>]+))/g;
  // git commit hash: 短 hash (7) 到 full hash (64), 全小写 hex. 不区分大小写
  //   写入 (parser 把大写转小写) — UI / git show 都接受两种.
  private static readonly GIT_COMMIT_ID_RE = /^[0-9a-f]{7,64}$/i;

  // 功能: 从 `<checkpoint ...>` 的属性串里抽出 step/summary/by/status, 顺序无关.
  // 关注点: step 缺失或不合 charset → 返回 null (整条 marker 丢弃, 与老行为一致);
  //   by/status 不合 charset → 该字段降级为 null, 不拖累整条 marker.
  private static parseCheckpointAttrs(attrText: string): {
    step: string;
    summary: string | null;
    by: string | null;
    status: string | null;
  } | null {
    const attrs: Record<string, string> = {};
    ActiveSession.CHECKPOINT_ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ActiveSession.CHECKPOINT_ATTR_RE.exec(attrText)) !== null) {
      const value =
        m[2] !== undefined
          ? m[2]
          : m[3] !== undefined
          ? m[3]
          : m[4] ?? "";
      attrs[m[1].toLowerCase()] = value;
    }
    const step = attrs.step;
    if (!step || !ActiveSession.CHECKPOINT_STEP_RE.test(step)) return null;
    const pick = (v: string | undefined) =>
      v && ActiveSession.CHECKPOINT_BY_STATUS_RE.test(v) ? v : null;
    return {
      step,
      summary: attrs.summary || null,
      by: pick(attrs.by),
      status: pick(attrs.status),
    };
  }

  // R113 (2026-09-07): 解析 <git commit-id="..." desc="..." files="..."/>
  //   marker 的属性串. commit-id 必填且必须 hex 7-64 (git short→full hash);
  //   desc/files 可选 — desc 走 free-form 文本, files 是逗号分隔字符串解析为数组.
  //   顺序无关 (同 parseCheckpointAttrs).
  //
  //   关注点: commit-id 不合规 → 返回 null (整条 marker 丢弃, 不污染 task_commits);
  //     desc 过长 (>512) → 截断防止恶意 marker 污染存储; files 解析失败 → 空数组
  //     (不阻塞 commit 记录, UI 展示时显示「无文件清单」).
  private static parseGitCommitAttrs(attrText: string): {
    commit_id: string;
    desc: string | null;
    files: string[];
  } | null {
    const attrs: Record<string, string> = {};
    ActiveSession.GIT_COMMIT_ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ActiveSession.GIT_COMMIT_ATTR_RE.exec(attrText)) !== null) {
      const value =
        m[2] !== undefined
          ? m[2]
          : m[3] !== undefined
          ? m[3]
          : m[4] ?? "";
      attrs[m[1].toLowerCase()] = value;
    }
    const commitId = attrs["commit-id"];
    if (!commitId || !ActiveSession.GIT_COMMIT_ID_RE.test(commitId)) return null;
    const descRaw = attrs.desc || "";
    const desc = descRaw ? descRaw.slice(0, 512) : null;
    const filesRaw = attrs.files || "";
    const files = filesRaw
      ? filesRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 256)
      : [];
    return {
      commit_id: commitId.toLowerCase(),
      desc,
      files,
    };
  }

  // v56: agent 在 result 末尾写 <awaiting_review reason="..."/> 来声明「这个 task
  //   虽然完成, 但请 damo 拍板再 approve」. reason 字段为可选人类可读原因, 长度
  //   限制 256 字符防止恶意 marker 污染 result 字段. 多个 marker 以最后一次为准
  //   (last-write-wins, 跟 checkpoint 同款语义).
  //   v61+R39: 扩展为 AWAITING_MARKER_RE 支持多类型 (见下). 老 <awaiting_review/>
  //   形态仍兼容, parseAwaitingMarkersInBlock 把老 marker 翻译成
  //   {type:'review', desc: reason} 推进 pendingAwaitingMarkers, 旧 agent 不用改.
  static readonly AWAITING_REVIEW_RE =
    /<awaiting_review(?:\s+reason="([^"]{1,256})")?\s*\/?>/g;
  // v61+R39: agent 在 result 末尾写 <awaiting type="..." desc="..." data='...'/> 来
  //   表达「这个 task 需要 damo 介入」. 设计 (damo R39):
  //     - type 必填, 自由发挥, 当前已知 {review, choice, info}, 后续 agent 可扩
  //       (e.g. confirm/clarify/escalate). charset [a-z_]{1,32} 防注入.
  //     - desc 可选, 256 字符内, 给 damo 看的人类可读说明.
  //     - data 可选, JSON 字面量 (单引号包裹), 2048 字符内. 用途: choice 类
  //       marker 携带选项 {options:[...]} 给 UI 弹选项卡; review 类暂不强制.
  //     - 多个 marker 允许 (g flag, all-of 收集), 一个 result 可同时挂多个
  //       (e.g. 一个 review + 一个 choice).
  //   解析: parseAwaitingMarkersInBlock 扫所有 assistant text block, 每个匹配推
  //   进 this.pendingAwaitingMarkers; running→reviewing 那笔 status update 把数
  //   组 JSON.stringify 进 awaiting_markers TEXT 列, 同时非空数组把
  //   awaiting_owner_review=1 (兼容 v56 approve gate).
  //   一次性消费: 落库后立刻清空, 防 resume 后老 marker 复活.
  static readonly AWAITING_MARKER_RE =
    /<awaiting\s+type="([a-z_]{1,32})"(?:\s+desc="([^"]{1,256})")?(?:\s+data='(\{[^']{1,2048}\})')?\s*\/?>/g;
  // R129 Plan A: clear marker — 主动清空 awaiting marker 的机制. 两种形态:
  //   <awaiting clear/>          → 清全部 pending marker (含本次 result 之前累积的)
  //   <awaiting clear type="X"/> → 只清 type=X 的 marker (X 走 [a-z_]{1,32} 复用同款 charset)
  // 语义: parser 把 clear 当删除指令. 与 add marker 一起按 document order 处理:
  //   - clear 之前的 add marker (含本块前累积的 pending) → 移除
  //   - clear 之后的 add marker → 保留 (新写的优先级最高)
  //   - 多个 clear → 都生效 (e.g. clear type="stuck" + clear type="suggestion" 都清)
  // ⚠️ 正则必须在 AWAITING_MARKER_RE 之后单独走, 因为两者 anchor 不同
  //   (<awaiting clear vs <awaiting\s+type=), 不会互吃.
  // 反例: <awaiting clearance="..."/> 不匹配 (clear 之后必须接 \s|/>|$,
  //   接 'a' 字符即 fail); <awaiting cleared/> 同样不匹配.
  static readonly AWAITING_CLEAR_RE =
    /<awaiting\s+clear(?:\s+type="([a-z_]{1,32})")?\s*\/?>/g;
  // R128: 4-section 兜底解析 — agent 不写 XML marker, 写 ## 等什么 / 卡在哪 / 建议
  //   等 section header 也能落 awaiting marker. XML marker 优先 (精确意图 = decision/
  //   choice), section 兜底 (模糊状态 = waiting_reply/stuck/suggestion/review).
  //   节内文本作为 desc, 突破旧 256 字符 cap (section 文本天然更长, 给 damo 看更有
  //   上下文). 同 type XML marker 已落库时跳过同 type section (去重, damo 拍板不限制
  //   发挥空间的语义保留: 不同 type 都保留, 同 type 只保留先到的).
  //   节内文本超 1024 字符截断加 "…" (UI hover 看 desc, 太长反而看不清).
  //   标题映射 (大小写不敏感, 容忍空格/标点变体): 等什么 → waiting_reply,
  //   卡在哪 → stuck, 建议 → suggestion, 决策点 → review.
  //   反例: 命中 ## 结论 / 流程 / 错误 / 下一步 不主动落库 (过程报告不是状态报告);
  //   例外: 任意 section body 含"拍板/审批/决策" → 升级为 review type.
  static readonly SECTION_HEADERS_RE =
    /(?:^|\n)#{1,3}\s+([^\n]+?)[ \t]*\n+?([\s\S]*?)(?=\n#{1,3}\s|\n*$)/g;
  static readonly SECTION_TYPE_MAP: Record<string, string> = {
    "等什么": "waiting_reply",
    "等什么回复": "waiting_reply",
    "等待什么": "waiting_reply",
    "waiting on": "waiting_reply",
    "卡在哪": "stuck",
    "卡住": "stuck",
    "blocked on": "stuck",
    "stuck on": "stuck",
    "建议": "suggestion",
    "有建议": "suggestion",
    "提建议": "suggestion",
    "suggestion": "suggestion",
    "suggestions": "suggestion",
    "决策点": "review",
    "decision": "review",
    "待拍板": "review",
  };
  // R3 runner 客户端: 默认 exec 总超时 = 10min. 项目级 / task 级覆盖
  //   留待后续 (R4 UI + 协议升级时加). 短于 AgentRuntime 的壁钟超时
  //   (默认 30min), 让 build 类长命令先被 runner 端拦下, 再 fallback 到
  //   AgentRuntime.pauseTask 兜底.
  private static readonly DEFAULT_RUNNER_TIMEOUT_MS = 10 * 60 * 1000;

  constructor(task: Task, opts?: RunOpts) {
    this.taskId = task.id;
    this.userId = task.owner_id || null;
    this.taskTitle = task.title;
    // D26: 把 task.model / task.llm_config_id 缓存到实例字段, gradeGoal 调用
    //   时一并传给 resolveLlmConfig — 不存 = 每轮都得从 DB 重读, 性能差.
    this.taskModel = task.model || null;
    this.taskLlmConfigId = (task as unknown as { llm_config_id?: string | null }).llm_config_id ?? null;
    this.projectId = task.project_id || null;
    this.versionId = task.version_id || null;
    this.scheduleId = task.schedule_id || null;
    // Isolated workspace fallback (when task.cwd is NULL, i.e. no explicit
    // cwd from form/version/project): $ORCHESTRATOR_HOME/projects/{projectId}/{taskId}/
    // organized by project; legacy $ORCHESTRATOR_HOME/workspace/{taskId}/ if no project.
    const orchestratorBase = ORCHESTRATOR_HOME;
    this.cwd = task.cwd || (task.project_id
      ? path.join(orchestratorBase, "projects", task.project_id, task.id)
      : path.join(orchestratorBase, "workspace", task.id));
    this.autoApprove = task.auto_approve === 1;
    this.configuredTools = new Set(
      task.allowed_tools ? JSON.parse(task.allowed_tools) : [...ALL_TOOLS]
    );
    // Resolve LLM config: env → user → project → task
    this.runOpts = opts ?? {};
    // Resolve LLM config: env -> user -> project -> task (or send-time override).
    // opts.model is tri-state: undefined=use task.model, null=ignore task.model
    // (use latest default), string=use this model.
    this.resolvedConfig = resolveLlmConfig(task, this.runOpts.model);

    // 快照实际使用的模型到 tasks.resolved_model, 供 UI 显示真实模型.
    // model 是用户偏好(null=跟随默认, 会漂移), resolved_model 是本次启动的快照.
    // 构造函数在 start/resume/fork 三条路径都会执行, 每次启动刷新为当前解析值.
    // v50: 同时快照 resolved_config_id (哪份配置解析出来的), 用于审计/回溯.
    // R175: 原地内联逻辑提取成 snapshotResolution(); vision swap 可能改写
    //   resolvedConfig, 提取后 swap 统一走「改字段 → snapshot」一条路.
    this.snapshotResolution();

    // R175 (飞书 R175) 视觉换主: 任务带图片附件 + 主模型明确不支持视觉 (显式
    //   标记 false; null=未知不换) + 链上有明确支持的成员 → 把该成员提升为主配置.
    //   图片靠 prompt 里的路径 + Read 工具读, 非视觉模型读图 = agent 白忙一轮.
    //   只在构造时判定一次 (附件后加的场景靠 resume, 不重判); swap 记录进
    //   metadata.llm_fallback 供追溯.
    if (this.taskHasImageAttachments(task.id)) {
      const swapped = planVisionSwap(this.resolvedConfig, true);
      if (swapped) {
        const to = swapped.fallback_chain[0];
        console.warn(
          `[ActiveSession] Vision swap for task ${task.id}: ${this.resolvedConfig.source_config_id} -> ${to.config_id} (${to.model})`,
        );
        this.resolvedConfig = swapped;
        this.snapshotResolution();
        try {
          mutateTaskMetadata(task.id, (meta) => {
            (meta as Record<string, unknown>).llm_fallback = {
              vision_swap: { to_config: to.name, to_model: to.model },
            };
            return true;
          });
        } catch (err) {
          console.warn(`[ActiveSession] Failed to persist vision swap note for ${task.id}:`, (err as Error).message);
        }
      }
    }

    // Goal-driven loop 阶段 3 (D20): 启动时解析 <goal>...</goal> marker.
    //   命中 → this.goalText = trimmed (D16 cap 4KB) + 写 task.metadata.goal_text.
    //   不命中 → this.goalText = null, 原行为不变. 阶段 3 success 拦截路径靠
    //   this.goalText != null 判断要不要走 goal grader 决策.
    //   不命中也写 metadata (写空串) 是为了「扫描过 / 真没 marker」可区分,
    //   但当前 caller 不依赖这个区分, 所以只命中时写.
    const goalMatch =
      typeof task.prompt === "string"
        ? task.prompt.match(ActiveSession.GOAL_MARKER_RE)
        : null;
    if (goalMatch && typeof goalMatch[1] === "string") {
      const trimmed = goalMatch[1].trim();
      if (trimmed.length > 0) {
        const capped =
          trimmed.length > ActiveSession.GOAL_MARKER_MAX_CHARS
            ? trimmed.slice(0, ActiveSession.GOAL_MARKER_MAX_CHARS)
            : trimmed;
        if (trimmed.length > ActiveSession.GOAL_MARKER_MAX_CHARS) {
          console.warn(
            `[ActiveSession] goal marker truncated for ${task.id}: ${trimmed.length} -> ${ActiveSession.GOAL_MARKER_MAX_CHARS} chars (D16 cap)`,
          );
        }
        this.goalText = capped;
        try {
          mutateTaskMetadata(task.id, (meta) => {
            (meta as Record<string, unknown>).goal_text = capped;
            return true;
          });
        } catch (err) {
          // metadata 写失败不阻断 session 启动 — 后续 gradeGoal 直接读 this.goalText.
          console.warn(
            `[ActiveSession] Failed to persist goal_text for ${task.id}:`,
            (err as Error).message,
          );
        }
      }
    }
  }

  // Subscribe to events
  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // 功能: 后台 subagent 逃逸时注入给模型的纠正指令(包 system-reminder, 非用户发言).
  // 关注点: R132 重写 (damo 2026-09-07 拍板 B 兜底层). 旧文案「再派就杀」已不准 —
  //   SDK 0.3.220 已暴露 task_* 生命周期信号, 平台会主动 drain (5min) + 优雅 stopTask,
  //   不会再「无脑杀」. 这里是给模型的「别主动结束本轮」软提示.
  // 参数:
  //   - spawned: 本 result 周期内累计派发数 (沿用旧统计, 给模型「我派了几个」体感)
  //   - inFlightIds: 当前 in-flight Set 列表 (slice 前 3 个, 避免塞爆 reminder)
  //   - nudgeIndex: 第几次提醒 (1-based)
  private bgAgentNudgeText(spawned: number, inFlightIds: string[], nudgeIndex: number): string {
    const ids = inFlightIds.slice(0, 3).join(", ") + (inFlightIds.length > 3 ? "…" : "");
    const idLine = inFlightIds.length > 0 ? `（in-flight task_id: ${ids}）` : "";
    return [
      "<system-reminder>",
      `⚠️ 检测到本轮派了 ${spawned} 个后台 subagent${idLine}，SDK 会在它们全部跑完（或主动 stopTask）后才安全关闭本轮。`,
      `当前是第 ${nudgeIndex} / ${ActiveSession.MAX_BG_AGENT_NUDGES} 次提醒。请继续处理 subagent 报告或做该做的事；不要主动结束本轮。`,
      "5min 内仍未跑完会主动 stopTask，不会丢报告（会发 task_notification status=stopped 落库）。",
      // R132: 保留 ao-dispatch.sh 旁路提示 — 这些活本就该异步跑的话, 改派独立 task
      //   (跨进程, 不受本会话生命周期影响).
      "若这些活本就该异步跑，改用 `ao-dispatch.sh` 派独立 task 跨进程执行，并说明已改派。",
      "</system-reminder>",
    ].join("\n");
  }

  // 功能: 后台 subagent 逃逸的告警留痕(DB event + SSE), 让 UI 不静默.
  // 关注点: resumed = 已注入指令续跑; gave_up = 提醒用尽仍收尾, subagent 确定被杀;
  //         blocked = canUseTool 层拦下, 模型连"派完就收尾"的机会都没有(主防线).
  private warnBackgroundAgentEscape(spawned: number, action: "resumed" | "gave_up"): void {
    const message =
      action === "resumed"
        ? `检测到 ${spawned} 个后台 subagent 未回收，已注入等待指令续跑（第 ${this.bgAgentNudges}/${ActiveSession.MAX_BG_AGENT_NUDGES} 次提醒）`
        : `仍有 ${spawned} 个后台 subagent 未回收，提醒已用尽 —— 本轮收尾会杀掉它们，报告拿不到`;
    this.logEvent(
      "warning",
      JSON.stringify({ kind: "background_agent_escape", spawned, action, nudges: this.bgAgentNudges, message })
    );
    this.emitEvent({ type: "warning", task_id: this.taskId, kind: "background_agent_escape", message });
  }

  // Goal-driven loop 阶段 3 (D20): 最近一次 goal grader 的 reason, 用于
  //   - failGoalUnreachable 写 last_error
  //   - pushMessage feedback 文案补充
  //   - 留个口给后续阶段 4 continueGoalLoop 读 goal_history
  // 不持久化 (阶段 4 用 mutateTaskMetadata 写 goal_history 数组).
  private lastGoalGraderReason: string | null = null;

  // 🆕 D34: 替换 D29 拼 head 方案. D29 bug = agent 第一轮拿 hint 后每轮 result
  //   都附 self-report 块, 污染中间轮输出 (用户 2026-09-17 实证). D34 新设计:
  //   - agent 自由跑, 不再被首轮 hint 绑架.
  //   - success 路径前置检查 resultText 是否含 goal_report 块 → 缺失才 nudge.
  //   - nudge 注入 pushMessage + continue (复用 bgAgentNudge 同款模式),
  //     让 agent 再跑一轮补写.
  //   - nudge 用尽 (MAX_GOAL_SELF_REPORT_NUDGES=3) → 走原 grader 路径兜底
  //     (selfReport 空 → transcriptSummary fallback → not_yet_met → continueGoalLoop
  //     max_goal_rounds 翻 failed).
  // 关注点:
  //   - 措辞关键: 文本不含完整 ```goal_report\n...\n``` fence 范例. 否则
  //     runGoalGate 的 GOAL_REPORT_RE 会把 nudge 自己匹配出来当 self-report,
  //     grader 拿到 nudge 文本 → 误判 met. 只描述三态首词 + 字段顺序.
  //   - nudge 计数独立于 goal_rounds: 避免 max_goal_rounds 提前耗尽 (D29 隐 bug).
  //   - 复用 pushMessage(msg, "system"): senderType=system 让 checkpoint 重渲染
  //     时 icon 是"平台注入"不是真人.
  //   - 不设 closed=true: 触发 sendUserMessage 持久化路径会让消息进 DB events
  //     不进 SDK JSONL, 续跑失灵.
  private goalSelfReportNudgeText(nudgeIndex: number): string {
    return [
      "<system-reminder>",
      "⚠️ 你即将结束本轮但 result 里没有 Goal-Loop self-report 块. 请在最终回复末尾追加:",
      " - 首行三态之一: done / not_done / impossible",
      " - 后续行依次列出: 你做了哪些动作 / 每个产物的路径 + 完整内容 / 是否达成 goal",
      " - 用三个反引号 + 单词 goal_report 开头 + 三个反引号闭包包住整个块",
      `当前是第 ${nudgeIndex} / ${ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES} 次提醒. ` +
        "用尽后将不再提醒, 由 grader 依据对话历史自动判定.",
      "</system-reminder>",
    ].join("\n");
  }

  // 🆕 D34: 留痕 self-report 缺失 audit. kind=missing_goal_self_report (独立 kind,
  //   跟 bgAgentEscape 同款分桶). UI / DB audit 可筛"哪些 task agent 没按契约写块".
  private warnMissingGoalSelfReport(nudges: number): void {
    this.logEvent(
      "warning",
      JSON.stringify({
        kind: "missing_goal_self_report",
        nudges,
        task_id: this.taskId,
      }),
    );
    this.emitEvent({
      type: "warning",
      task_id: this.taskId,
      kind: "missing_goal_self_report",
      message: `goal-self-report 缺失, 已 nudge ${nudges}/${ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES} 次`,
    });
  }

  // 🆕 D34: success 路径前置 self-report 缺失检测 (抽函数便于单测).
  //   返 "nudge" = 已 pushMessage, caller 应 continue; "proceed" = 走 grader.
  //   三个早退出条件按顺序: 无 goal_text / nudge 用尽 / 含 goal_report 块.
  protected checkGoalSelfReportOrNudge(resultText: string): "nudge" | "proceed" {
    if (!this.goalText) return "proceed";
    if (this.goalSelfReportNudges >= ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES) return "proceed";
    if (ActiveSession.GOAL_REPORT_RE.test(resultText)) return "proceed";
    this.goalSelfReportNudges++;
    this.warnMissingGoalSelfReport(this.goalSelfReportNudges);
    this.logEvent("cost", JSON.stringify({ cost_usd: this.costUsd }));
    if (this.sessionId) updateSessionCost(this.sessionId, this.costUsd);
    this.pushMessage(this.goalSelfReportNudgeText(this.goalSelfReportNudges), "system");
    return "nudge";
  }

  // 功能: success 路径拦截器 —— 调 gradeGoal 评判 goal 是否达成.
  // 关注点:
  //   - this.goalText 必须非空 (caller 已在 success 路径前判 this.goalText).
  //   - 🆕 D28 latestResultText: 来自 consumeMessages 的 resultText 累计, 用于
  //     提取 agent 自报告 ```goal_report ... ``` 块. grader 主依据是 self-report,
  //     不再依赖 transcript 截断 (D27 实证: Write/Bash content 字段在截断范围外,
  //     grader 看不到写文件证据).
  //   - transcript 从 SDK JSONL 拿 (getSessionMessages) + 拼成 "[role]: text" 行
  //     格式, 然后调 summarizeTranscriptForGrader 截到 ≤4KB —— 仅作 fallback,
  //     当 self-report 缺失时用.
  //   - gradeGoal 抛错 (SDK fail / JSON 解析失败 / goalText 空) → 视为
  //     not_yet_met, 不阻断 task. 这是 plan §4.3 已定的兜底.
  //   - verdict 越界 (D14) → gradeGoal 内部已收窄到 not_yet_met, 这里
  //     直接读 result.verdict 即可.
  //   - 写入 this.lastGoalGraderReason 供 caller (continueGoalLoop / failGoalUnreachable) 用.
  //   - 漏洞 #4 (P1, 阶段 4 修): grader 调小模型 = 新增 cost_usd, 累加到
  //     this.costUsd (session 累计 cost) + logEvent cost_attribution=goal_grader.
  //     这样 session close 时落库的 cost_usd 已含 grader 调用, 审计链完整.
  private async runGoalGate(latestResultText: string = ""): Promise<GoalVerdict> {
    if (!this.goalText) return "met"; // 防御: caller 应该已经判过.
    // 🆕 D28: 从 agent 最新 result 提取 goal_report 块. 主依据替代 transcript.
    let selfReport = "";
    const m = latestResultText.match(ActiveSession.GOAL_REPORT_RE);
    if (m && m[1]) selfReport = m[1].trim();
    let transcript = "";
    try {
      if (this.sessionId) {
        const messages = await getSessionMessages(this.sessionId, { dir: this.cwd });
        transcript = messages
          .map((m) => {
            const role = m.type || "unknown";
            let body = "";
            try {
              body = JSON.stringify(m.message ?? "");
            } catch {
              body = "[unserializable]";
            }
            return `[${role}] ${body}`;
          })
          .join("\n");
      }
    } catch (err) {
      console.warn(
        `[ActiveSession] getSessionMessages failed for goal grader (task=${this.taskId}):`,
        (err as Error).message,
      );
      // 拿不到 transcript 仍走 grader —— self-report 主依据还在, 不阻断.
    }
    const summary = summarizeTranscriptForGrader(transcript, 4096);
    try {
      // 阶段 4: 改用 GoalGradeInput 对象入参 (跟 plan §9.2 D6 接口签名一致).
      // 阶段 3 写错用 positional args (this.goalText, summary) → production
      // gradeGoal 必抛 grader_goal_text_empty → 走 catch 当 not_yet_met.
      // mock 测试没发现是因为 mock 不读参数, 测的只是 verdict/reason 返回值.
      // 🆕 D28: selfReport 替代 transcriptSummary 作主依据. transcriptSummary
      //   仍传 (作 fallback, 当 selfReport 缺失时 grader 仍能基于 transcript 判).
      const r: GoalGradeResult = await gradeGoal({
        goalText: this.goalText,
        selfReport,
        transcriptSummary: selfReport ? undefined : summary,
        taskId: this.taskId,
        // D26: 把 task 的 LLM 凭证字段透传给 gradeGoal, 让 resolveLlmConfig
        //   能解析到正确的 api_key/base_url. 不传 = SDK 子进程走 process.env 真
        //   Anthropic endpoint → "Not logged in" → grader_json_parse_failed.
        taskModel: this.taskModel,
        taskOwnerId: this.userId,
        taskProjectId: this.projectId,
        llmConfigId: this.taskLlmConfigId,
      });
      this.lastGoalGraderReason = r.reason;
      // 漏洞 #4 cost 归因: grader 调小模型 = 新增 cost. 阶段 2 gradeGoal 留 0 占位,
      //   但接口契约 (GoalGradeResult.costUsd) 已就位 — 累计 + 留痕, 等阶段 2 把
      //   真成本接进来也能无缝升级. logEvent 走 cost 类型 + cost_attribution 字段,
      //   便于 audit 面板筛「哪笔 cost 是 grader 花的」.
      if (r.costUsd && r.costUsd > 0) {
        this.costUsd += r.costUsd;
        if (this.sessionId) updateSessionCost(this.sessionId, r.costUsd);
      }
      this.logEvent(
        "cost",
        JSON.stringify({
          cost_usd: r.costUsd,
          cost_attribution: "goal_grader",
          model: r.model,
          duration_ms: r.durationMs,
          task_id: this.taskId,
          self_report_chars: selfReport.length,
          transcript_summary_chars: selfReport ? 0 : summary.length,
        }),
      );
      return r.verdict;
    } catch (err) {
      // gradeGoal 抛错 (SDK fail / JSON 解析失败 / goalText 空) → 视为 not_yet_met.
      this.lastGoalGraderReason = `grader_error: ${(err as Error).message}`;
      console.warn(
        `[ActiveSession] gradeGoal failed (task=${this.taskId}):`,
        (err as Error).message,
      );
      return "not_yet_met";
    }
  }

  // 功能: 阶段 4 续跑入口 —— 调 continueGoalLoop 智能分流 (pushMessage / fork /
  //   giveUp). 替换阶段 3 continueGoalStub. 漏洞 #2/#8/#13 都由 continueGoalLoop
  //   内部处理, 这里只负责把 grader feedback + context snapshot 传过去 + 落
  //   cost log.
  // 关注点:
  //   - continueGoalLoop 内部已原子写 task.metadata (goal_rounds / goal_history
  //     cap 20 / last_grader_reason), 这里不再重复写.
  //   - fork 路径: continueGoalLoop 内部调 forkSession + enqueue, 新 task 自动
  //     进调度; 这里不需要翻 status (新 task 接管).
  //   - giveUp 路径: continueGoalLoop 内部翻 failed + emit status_change,
  //     这里不需要重复翻.
  //   - 落 cost log: 兜底 (continueGoalLoop 不写 cost 事件), 跟 placeholder 时
  //     阶段的「cost + goal_grader_reason」 logEvent 保持对得上, 便于 audit.
  private async continueGoalLoopDispatch(
    feedback: string,
    contextUsage: { contextTokens: number | null; contextMax: number | null },
  ): Promise<void> {
    this.logEvent(
      "cost",
      JSON.stringify({
        cost_usd: this.costUsd,
        goal_grader_reason: this.lastGoalGraderReason,
      }),
    );
    if (this.sessionId) updateSessionCost(this.sessionId, this.costUsd);
    const decision = await continueGoalLoop(this.taskId, feedback, contextUsage);
    if (decision.action === "fork") {
      // fork 接管路径必须关停父 session: 新 task 已入队, 但父 session 挂着 =
      // 父仍占 cwd 锁 (projects.parallel_limit 默认 1), fork 永远排队 = 死锁
      // (2026-10-14 实证: 0955d855 round 7 fork 后父子互等 49min, 父进程空闲
      // 但 status=running). 对齐 pauseTask 顺序: mark → interrupt → 翻 paused
      // (保 session_id 可 resume) → emit → close (resolvers 全 null →
      // generator 退出 → runTask/scheduler onTaskDone 释放 cwd → fork 出队).
      this.markExternallyTerminated();
      await this.interrupt();
      updateTaskStatus(this.taskId, "paused", {
        session_id: this.sessionId || undefined,
        cost_usd: this.costUsd,
      });
      this.logEvent(
        "warning",
        JSON.stringify({ kind: "goal_fork_parent_paused", task_id: this.taskId }),
      );
      this.emitEvent({
        type: "status_change",
        task_id: this.taskId,
        from: "running",
        to: "paused",
        reason: "goal_forked",
        cost_usd: this.costUsd,
      });
      await this.close();
    }
    // continueGoalLoop 内部已完成对应动作 (pushMessage / fork / 翻 failed).
    // 决策结果通过返回值给 caller (consumeMessages success 拦截块) 知晓, 但
    // 目前 caller 不依赖返回值, 只靠 continue/break 的副作用 (session 不关闭 →
    // generator 继续供料) 来推进.
    void decision;
  }

  // 功能: 翻 failed (goal_unreachable) — goal grader 判 impossible 的终点.
  // 关注点: 与 verification 失败路径同口径 (updateTaskStatus failed + emitEvent
  //   status_change). error 文案带 grader reason 让人工能定位. 不注入
  //   反馈 (与 verification 失败穷尽重试一致, 终点 = 翻 failed).
  private failGoalUnreachable(reason: string): void {
    this.logEvent(
      "warning",
      JSON.stringify({ kind: "goal_unreachable", reason, task_id: this.taskId }),
    );
    updateTaskStatus(this.taskId, "failed", {
      session_id: this.sessionId || undefined,
      result: null,
      error: reason,
      cost_usd: this.costUsd,
      completed_at: new Date().toISOString(),
    });
    this.recordHeadCommit();
    this.emitEvent({
      type: "status_change",
      task_id: this.taskId,
      from: "running",
      to: "failed",
      cost_usd: this.costUsd,
      reason: "goal_unreachable",
    });
  }

  // 功能: 取出并清空「未被响应的用户消息」, 由 AgentRuntime.pauseTask 调用.
  // 关注点: 一次性语义 —— 取过即清, 同一条消息不会被回填两次.
  takeUnansweredUserTurn(): string | null {
    const msg = this.unansweredUserTurn;
    this.unansweredUserTurn = null;
    return msg;
  }

  // 功能: pauseTask/cancelTask 调用, 同步标记会话已外部终止.
  // 关注点: 必须在 session.interrupt() + session.close() 之前调用, 这样
  //   for-await 循环下一轮迭代就 drop 消息. close() 之后才调用的话, 已
  //   在 handler 里 dispatch 的消息无法撤回, status 仍可能被覆盖.
  markExternallyTerminated(): void {
    this.externallyTerminated = true;
  }

  // R132: 等 inFlightSubagentIds 清空或超时. 用于 result 收尾时 drain —
  //   期间 SDK 仍会 emit task_notification 系统消息 (consumeMessages 同步处理,
  //   delete 出 Set), 所以这里只需 setInterval 轮询 size.
  // 关注点:
  //   - 必须让出事件循环 (await sleep), 否则 SDK 持续 emit 的 task_notification
  //     进不了 consumeMessages — 但实际 SDK 在 result 已到达后不再 emit 新消息,
  //     所以这里的 sleep 仅是 timer 触发, 不会丢消息.
  //   - 返回 true = drain 干净, false = 超时仍有未完成 (调用方需 stopTask).
  //   - 测试可传入极小 ms + override POLL_MS 加速.
  protected static readonly DRAIN_POLL_MS = 250;
  private async waitForSubagentsOrTimeout(ms: number): Promise<boolean> {
    if (this.inFlightSubagentIds.size === 0) return true;
    const POLL_MS = ActiveSession.DRAIN_POLL_MS;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.inFlightSubagentIds.size === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return this.inFlightSubagentIds.size === 0;
  }

  // Push a user message into the running session. If the generator isn't
  // currently awaiting, queue the message — the next waitForUserMessage()
  // round will drain it.
  //
  // R55 B1 fix: `senderType` is recorded in currentSlice metadata for
  // checkpoint reconstruction. SDKUserMessage has no metadata field, so the
  // SDK JSONL itself does not carry it (known limitation; historical transcript
  // exports fall back to role=user for that reason).
  pushMessage(message: string, senderType: "user" | "script" | "system" = "user"): void {
    // R216 插话打断: turn 进行中收到的消息要等 turn 边界才被 SDK 拉取, 长工具
    //   调用期间持续排队. 主动 interrupt 让消息立即被看到 (damo: 「最好走一下
    //   暂停再恢复, 不然消息进不去」). turn 已结束 (generator 正挂着等) 时不
    //   需要打断 —— 消息 resolve/generator 回拉即达.
    this.scheduleBargeInInterrupt();
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    } as SDKUserMessage;

    // Track for checkpoint slicing. UUID is empty because pushMessage doesn't
    // produce an SDK message we can read back; downstream forks ignore it.
    // sender_type lets forks re-render the right icon.
    this.currentSlice.push({ role: "user", text: message, uuid: "", sender_type: senderType });

    const resolver = this.messageResolvers.shift();
    if (resolver) {
      resolver(msg);
    } else {
      // Queue for the generator to pick up on its next waitForUserMessage().
      this.pendingMessages.push(message);
    }
  }

  // 功能: R216 插话打断 —— turn 进行中收到用户消息时主动 interrupt 当前 turn,
  //   让消息在下一个 turn 立即被处理 (等价轻量 pause→resume, session 不断).
  // 关注点: 仅 turnActive 时发起; 2s debounce 防连发消息重复 interrupt;
  //   异步 fire-and-forget, interrupt 失败不阻断消息投递 (消息仍在队列, 最多
  //   退回旧行为 = turn 边界才被看到). 被打断 turn 以 error_during_execution
  //   result 收尾, 由 shouldSwallowBargeInResult 防止误翻 failed.
  private scheduleBargeInInterrupt(): void {
    if (!this.turnActive || !this.queryInstance || this.externallyTerminated) return;
    const now = Date.now();
    if (now - this.lastBargeInAt < ActiveSession.BARGE_IN_DEBOUNCE_MS) return;
    this.lastBargeInAt = now;
    this.messageInterruptAt = now;
    this.logEvent(
      "barge_in_interrupt",
      JSON.stringify({ queued: this.pendingMessages.length }),
    );
    void Promise.resolve(this.queryInstance.interrupt()).catch(() => {});
  }

  // 功能: 判断一条非成功 result 是否为「插话打断」的正常收尾 (是 → 吞掉不翻
  //   failed, 让 generator 续跑排空队列). 纯判定便于单测.
  // 关注点: 仅认 error_during_execution (被打断 turn 的标准收尾 subtype);
  //   error_max_turns / error_max_budget_usd / synthetic API 错误不在窗口豁免内,
  //   照旧走失败分支. messageInterruptAt 用完由调用方清, 这里只读.
  private shouldSwallowBargeInResult(subtype: unknown): boolean {
    if (subtype !== "error_during_execution") return false;
    if (this.messageInterruptAt === null) return false;
    return Date.now() - this.messageInterruptAt <= ActiveSession.BARGE_IN_RESULT_WINDOW_MS;
  }

  // 功能: 判断最近是否发起过插话 interrupt (BARGE_IN_RESULT_WINDOW_MS 窗口内),
  //   命中则投递插话消息时附 BARGE_IN_CONTEXT_NOTE 纠正 canned STOP 文本语义.
  // 关注点: 用 lastBargeInAt (永不清零) 而非 messageInterruptAt —— 后者在被吞
  //   result 处「用完即清」, 到消息投递点已经是 null. 窗口外投递不附注 (罕见;
  //   即便误附也只是多一行提醒, 无害).
  private wasRecentBargeIn(): boolean {
    return (
      this.lastBargeInAt > 0 &&
      Date.now() - this.lastBargeInAt <= ActiveSession.BARGE_IN_RESULT_WINDOW_MS
    );
  }

  // 功能: generator 侧统一出口 —— yield 前置 turnActive=true (turn 即将开跑),
  //   构造标准 SDKUserMessage.
  private yieldUserMessage(text: string): SDKUserMessage {
    this.turnActive = true;
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  // Resolve a pending tool approval request
  resolveApproval(requestId: string, approved: boolean, feedback?: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      console.warn(`[ActiveSession] No pending approval for request ${requestId}`);
      return;
    }

    this.pendingApprovals.delete(requestId);

    if (approved) {
      pending.resolve({ behavior: "allow", toolUseID: pending.toolUseId });
    } else {
      // R56 复发 (damo 2026-10-31): 拒绝语义写清楚「仅本次调用被拒, 不是叫停整个任务」,
      // 防弱模型 (MiniMax-M3 实测) 读成叫停 → 「收到，停」+ end_turn 空等.
      // 与 minimax-m3.md 红线 7 同口径; UI 带反馈 (feedback) 时用原话.
      pending.resolve({
        behavior: "deny",
        message:
          feedback ||
          "用户拒绝了这一次工具调用 (仅本次调用被拒, 不是叫停整个任务). 不要回复「收到，停」/「等指示」然后 end_turn 空等; 不要原样重跑同一调用. 有替代路径就继续按任务目标推进, 没有就简短说明现状 + 建议下一步.",
        toolUseID: pending.toolUseId,
      });
    }

    // Emit response event for UI
    this.emitEvent({
      type: "tool_approval_response",
      task_id: this.taskId,
      request_id: requestId,
      approved,
      feedback,
    });
  }

  // Get all pending approval requests
  getPendingApprovals(): Array<{ requestId: string; toolName: string; toolInput: Record<string, unknown> }> {
    return Array.from(this.pendingApprovals.values()).map((p) => ({
      requestId: p.requestId,
      toolName: p.toolName,
      toolInput: p.toolInput,
    }));
  }

  // 功能: 运行中切换自动审批, 下一次工具调用即生效 (canUseTool 每次都读这个字段).
  // 关注点: 只改内存, 落库由调用方 (PATCH /api/tasks/[id]) 负责; 已经在等待
  // 审批的请求不会被追认 —— 开启后仍需人工点一次, 之后的才自动放行。
  setAutoApprove(on: boolean): void {
    this.autoApprove = on;
  }

  // The canUseTool callback — intercepts write-class tools for runtime approval
  private createCanUseTool(): CanUseTool {
    return async (toolName: string, input: Record<string, unknown>, options: {
      signal: AbortSignal;
      suggestions?: any[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
      requestId: string;
    }): Promise<PermissionResult> => {
      // Built-in AskUserQuestion: the SDK in 0.3.x doesn't route this through
      // `request_user_dialog`/`onUserDialog` -- it runs the CLI's internal
      // handler which, in headless mode, immediately returns "user did not
      // answer". Intercept it here and route through the same user-dialog UI
      // as `onUserDialog`, then return the answer as a `deny` message (the
      // only way to inject text into the tool_result via canUseTool). This
      // runs BEFORE the autoApprove check so the question is always asked even
      // when auto_approve is on (AskUserQuestion is interactive, not a write).
      if (toolName === "AskUserQuestion") {
        return this.handleAskUserQuestion(input, options);
      }

      // ExitPlanMode: SDK 在 headless 模式下, allow 后内部 sendRequest() 会因
      //   inputClosed 状态机冲突抛 "AbortError: Stream closed" → 包成
      //   "Tool permission request failed" deny 返回 → agent 死循环重试(实测
      //   task cde3b5a9 在 113s 内重试 3 次, 见 plan rippling-fluttering-iverson).
      //   PermissionResult 类型只支持 allow/deny(没 behavior:"plan"), 且平台
      //   没接 plan-approval UI, 唯一可控的处置是 deny 并给 agent 替代方案.
      //   关注点: 必须在 autoApprove 检查之前(同 AskUserQuestion), 否则 auto_approve
      //   任务仍会卡死.
      if (toolName === "ExitPlanMode") {
        return {
          behavior: "deny",
          message:
            "ExitPlanMode 在 headless 模式下不可用（SDK 基础设施限制：plan-mode transition 与 inputClosed 状态机冲突，会无限报 AbortError: Stream closed）。" +
            "请把 plan 写到 docs/plans/<name>.md（git 跟踪、跨机器可见），然后暂停等待用户审阅；" +
            "如需用户决策，可用 AskUserQuestion 询问。",
          toolUseID: options.toolUseID,
        };
      }

      // Enforce the task's configured tool set: deny built-in tools the
      // operator deselected (e.g. a "计划" preset task trying to run Bash).
      // This makes the UI tool list / presets actually restrictive rather
      // than advisory. Tools outside CONFIGURABLE_TOOLS (internal/SDK tools
      // like AskUserQuestion) are not gated here.
      if (CONFIGURABLE_TOOLS.has(toolName) && !this.configuredTools.has(toolName)) {
        return {
          behavior: "deny",
          message: `工具 ${toolName} 未在当前任务的允许列表中（可在任务设置的工具预设中开启）。`,
          toolUseID: options.toolUseID,
        };
      }

      // Deploy guard: 拦截「本实例部署到自身」和「pulu 上发起任何部署」,
      // 以及「会杀掉/重启平台自身进程」的裸 pm2 / pkill 命令 (2026-08-21
      // weishu 后端排障事故: `pm2 delete all` + `pkill -9 node` 把 ao-pulu 全杀,
      // ao.example.com 502 数小时).
      // 必须在 autoApprove 之前: auto_approve 任务也会拦, 因为这是结构性硬约束
      // (不是审批决策), 哪怕 operator 开了全 auto, 也不允许自毁. 详见
      // src/lib/runtime/deploy-guard.ts 决策矩阵.
      if (toolName === "Bash") {
        const cmd = typeof input?.command === "string" ? input.command : "";
        const deployDecision = checkBashDeploy(cmd);
        if (deployDecision && !deployDecision.allowed) {
          return {
            behavior: "deny",
            message: deployDecision.reason,
            toolUseID: options.toolUseID,
          };
        }
        // 第二道防线: 进程级自杀拦截 (pm2 kill / <verb> all / <verb> <本机实例>
        //   / pkill node 等). 与 deploy guard 互不重叠, 任一拦截即拒.
        const killDecision = checkProcessKill(cmd);
        if (killDecision && !killDecision.allowed) {
          return {
            behavior: "deny",
            message: killDecision.reason,
            toolUseID: options.toolUseID,
          };
        }
        // 第三道防线: 白名单命令走 runner (R3 平台客户端 + canUseTool 拦截).
        //   2026-08-28 调研: SDK CLI 子进程默认不为 Bash 发 can_use_tool 控制
        //   请求(P5 实测 factory 调 1 次, inner 闭包 0 次触发), 整条链
        //   canUseTool→executeOnRunner→deny 跑不通. 修复 = 把 Bash 拦截
        //   从 canUseTool 改到 PreToolUse hook (hook 对每个工具调用必触发,
        //   不受 CLI 内部 allowlist 影响). canUseTool 这条对 Bash 不再管,
        //   让 hook 接管; deploy-guard / process-kill 仍留 canUseTool (其他
        //   写类工具 — Write/Edit/NotebookEdit — 不受 hook 影响, 必须在
        //   canUseTool 里拦).
        //   兼容性: keep 此分支空 = 「canUseTool 看见 Bash 就放过」, hook
        //   会处理. fallback 路径 = hook 漏触发时 (e.g. SDK 旧版本) Bash
        //   仍走本地 SDK (跟 R3 部署前一致).
      }

      // Auto-approve read-only tools and if task has auto_approve enabled
      if (this.autoApprove || !WRITE_TOOLS.has(toolName)) {
        return { behavior: "allow", toolUseID: options.toolUseID };
      }

      // For write-class tools, emit approval request and wait
      const requestId = options.requestId;

      const approvalEvent: ToolApprovalRequestEvent = {
        type: "tool_approval_request",
        task_id: this.taskId,
        tool_name: toolName,
        tool_input: input,
        tool_use_id: options.toolUseID,
        request_id: requestId,
      };

      this.emitEvent(approvalEvent);
      this.logEvent("tool_approval_request", JSON.stringify({
        tool_name: toolName,
        tool_input: input,
        request_id: requestId,
      }));

      // Return a promise that will be resolved when the user approves/rejects via API
      return new Promise<PermissionResult>((resolve) => {
        this.pendingApprovals.set(requestId, {
          resolve,
          toolName,
          toolInput: input,
          toolUseId: options.toolUseID,
          requestId,
        });

        // Handle abort signal (e.g., task cancelled while waiting for approval)
        options.signal.addEventListener("abort", () => {
          if (this.pendingApprovals.has(requestId)) {
            this.pendingApprovals.delete(requestId);
            resolve({
              behavior: "deny",
              message: "Task was cancelled while waiting for approval",
              toolUseID: options.toolUseID,
            });
          }
        });
      });
    };
  }

  // 功能: PreToolUse hook 拦截 Bash 调用的白名单命令走 runner 远程执行.
  //   2026-08-28 调研 (sdk-canuse-tool-deep-dive.md): SDK CLI 子进程默认不
  //   为 Bash 发 can_use_tool 控制请求, canUseTool 闭包对 Bash 触发 0 次,
  //   所以原本放在 canUseTool 里的 R3 拦截跑不通. 修复 = 把 Bash 拦截从
  //   canUseTool 移到 PreToolUse hook: hook 对每个工具调用必触发, 不受 CLI
  //   内部 allowlist 影响. canUseTool 这条对 Bash 不再管 (deploy-guard /
  //   process-kill / ExitPlanMode / AskUserQuestion 仍走 canUseTool, 不受
  //   影响 = Write / Edit / NotebookEdit 仍由 canUseTool 拦截, Bash 让 hook 接管).
  //
  //   命中白名单 → runner 在线 → executeOnRunner → 返回 permissionDecision:
  //   'deny' + permissionDecisionReason = formatExecResult(...) → CLI 把
  //   permissionDecisionReason 作为 tool_result 文本送达模型, 模型看到
  //   "[runner:mac-build ...] hello-from-mac" 这种带前缀的远程结果.
  //   命中但 runner offline/dead → deny + 显式 error (不静默 fallback).
  //   不命中 → { continue: true, hookSpecificOutput: { permissionDecision:
  //   'allow' } } = 透传, CLI 自己跑 Bash (本地 SDK 默认).
  //
  //   红线: 不静默 fallback; abort 信号必接; req_id 贯穿到 SSE; formatExecResult
  //   截断保留. 跟原 canUseTool Bash 分支共享同一套子函数.
  //
  // 关注点:
  //   - hook 在 task 启动时通过 query({ hooks }) 注册到 SDK, hook callbackId
  //     在 ActiveSession 内复用 (this.runnerHookRef).
  //   - 信号透传: options.signal 是 CLI 的 abort, task pause/cancel 时让
  //     runner 也收 cancel, 避免 mac 上子进程孤儿化.
  //   - deploy-guard / process-kill **不**在这里检查: 它们是结构性硬约束
  //     (auto_approve 也得拦), 留 canUseTool 对 Write/Edit 等同样生效.
  //     Bash 白名单 + runner 路由走本 hook 是另一层: 即使 Bash 命中白名单,
  //     deploy-guard 在 canUseTool 也会先拦 (但 canUseTool 对 Bash 现在
  //     让 hook 接管, 顺序就反过来 = hook 先拦). 这与原意一致: 白名单命中的
  //     是 build 类命令, deploy-guard 只拦「部署自己」, 不冲突.
  //   - 不挂 pendingApprovals (审批是 AskUserQuestion 的活, 这里只 deny).
  private createBashRunnerHook(): HookCallback {
    return async (input, toolUseID, options): Promise<SyncHookJSONOutput> => {
      // 只拦 Bash, 其他工具透传.
      if (input.hook_event_name !== "PreToolUse") {
        return { continue: true };
      }
      if (input.tool_name !== "Bash") {
        return { continue: true };
      }
      const toolInput = (input.tool_input ?? {}) as { command?: unknown };
      const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
      if (!cmd) {
        return { continue: true };
      }

      const reqId = crypto.randomUUID();
      const project = this.projectId ? getProjectById(this.projectId) : null;
      const route = project ? resolveRunnerRoute(project, cmd) : null;
      if (!route) {
        // 不命中白名单 = 走本地 SDK Bash (默认). 不静默 fallback 到 runner.
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
          },
        };
      }

      // 🟡 调试性: 命中前必打决策日志, 不改行为, 纯 console.log.
      console.log(
        JSON.stringify({
          req_id: reqId,
          type: "runner_route_resolved",
          source: "PreToolUse_hook",
          project_id: this.projectId,
          command_head: cmd.slice(0, 200),
          matched_runner_id: route.runner ? route.runner.runner.id : null,
          cwd_mapping: "cwdMapping" in route ? route.cwdMapping : undefined,
        }),
      );

      const preToolUseOutput: PreToolUseHookSpecificOutput = {
        hookEventName: "PreToolUse",
      };

      // 候选命中但 runner offline/dead → deny (不静默 fallback).
      if (!route.runner) {
        preToolUseOutput.permissionDecision = "deny";
        preToolUseOutput.permissionDecisionReason = route.reason;
        return { continue: true, hookSpecificOutput: preToolUseOutput };
      }

      // 🔴 abort 信号必接: task 被 pause/cancel 时让 runner 也收 cancel.
      const chosenRunner = route.runner;
      const cwdMapping = route.cwdMapping;
      const abortHandler = () => {
        const live = getConnection(chosenRunner.runner.id);
        if (live && route.runId) {
          cancelRunnerExec(live, route.runId, { reqId }).catch(() => {});
        }
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });

      try {
        const result = await executeOnRunner(
          chosenRunner,
          cmd,
          cwdMapping,
          await this.buildEnv(),
          {
            reqId,
            timeoutMs: ActiveSession.DEFAULT_RUNNER_TIMEOUT_MS,
            signal: options.signal,
          },
        );
        preToolUseOutput.permissionDecision = "deny";
        preToolUseOutput.permissionDecisionReason = formatExecResult(
          chosenRunner,
          result,
          reqId,
        );
        return { continue: true, hookSpecificOutput: preToolUseOutput };
      } finally {
        options.signal.removeEventListener("abort", abortHandler);
      }
    };
  }

  // Intercept the built-in AskUserQuestion tool when it reaches canUseTool.
  // Emits a `user_dialog_request` event (same as `onUserDialog`), stores the
  // pending dialog, and returns a Promise<PermissionResult> that resolves when
  // the user answers via `resolveUserDialog`. The answer is encoded as a `deny`
  // message because canUseTool can only inject text into the tool_result via
  // the deny path -- `allow` would let the CLI's internal handler run, which
  // returns "user did not answer" in headless mode.
  private handleAskUserQuestion(
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string; requestId: string },
  ): Promise<PermissionResult> {
    const requestId = options.requestId;
    const questions = this.normalizeDialogQuestions("ask_user_question", input);

    const event: UserDialogRequestEvent = {
      type: "user_dialog_request",
      task_id: this.taskId,
      dialog_kind: "ask_user_question",
      request_id: requestId,
      tool_use_id: options.toolUseID,
      questions,
      emitted_at: new Date().toISOString(),
    };

    this.emitEvent(event);
    this.logEvent(
      "user_dialog_request",
      JSON.stringify({
        dialog_kind: "ask_user_question",
        tool_use_id: options.toolUseID,
        questions,
        request_id: requestId,
        source: "canUseTool",
      }),
    );

    return new Promise<PermissionResult>((resolve) => {
      this.pendingUserDialogs.set(requestId, {
        resolve: resolve as (result: UserDialogResult | PermissionResult) => void,
        kind: "ask_user_question",
        source: "canUseTool",
        requestId,
        toolUseId: options.toolUseID,
        questions,
        emittedAt: Date.now(),
      });

      options.signal.addEventListener("abort", () => {
        if (this.pendingUserDialogs.has(requestId)) {
          this.pendingUserDialogs.delete(requestId);
          this.emitEvent({
            type: "user_dialog_timeout",
            task_id: this.taskId,
            request_id: requestId,
            reason: this.closed ? "session_closed" : "abort",
          });
          this.emitEvent({
            type: "user_dialog_response",
            task_id: this.taskId,
            request_id: requestId,
            dialog_kind: "ask_user_question",
            cancelled: true,
          });
          resolve({
            behavior: "deny",
            message: "Task was cancelled while waiting for user input.",
            toolUseID: options.toolUseID,
          });
        }
      });
    });
  }

  // The onUserDialog callback — registered with `query({onUserDialog, supportedDialogKinds})`
  // so the SDK routes `request_user_dialog` control requests (e.g. AskUserQuestion)
  // through this hook. Without both options the SDK "fails closed" and dialogs are
  // answered as cancelled by default. The agent blocks inside this promise until
  // the matching `resolveUserDialog` call (or close()/abort) settles it.
  private createOnUserDialog(): OnUserDialog {
    return async (request: UserDialogRequest, options: { signal: AbortSignal }): Promise<UserDialogResult> => {
      // The SDK issues the control request id at the protocol layer; for now we
      // synthesize a local key from toolUseID + kind. tools/dialog kinds with no
      // toolUseID fall back to a UUID-ish key.
      const requestId = `${request.toolUseID ?? "dialog"}-${request.dialogKind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const questions = this.normalizeDialogQuestions(request.dialogKind, request.payload);

      const event: UserDialogRequestEvent = {
        type: "user_dialog_request",
        task_id: this.taskId,
        dialog_kind: request.dialogKind,
        request_id: requestId,
        tool_use_id: request.toolUseID,
        questions,
        emitted_at: new Date().toISOString(),
      };

      this.emitEvent(event);
      this.logEvent(
        "user_dialog_request",
        JSON.stringify({
          dialog_kind: request.dialogKind,
          tool_use_id: request.toolUseID,
          questions,
          request_id: requestId,
        }),
      );

      return new Promise<UserDialogResult>((resolve) => {
        this.pendingUserDialogs.set(requestId, {
          resolve: resolve as (result: UserDialogResult | PermissionResult) => void,
          kind: request.dialogKind,
          source: "onUserDialog",
          requestId,
          toolUseId: request.toolUseID,
          questions,
          emittedAt: Date.now(),
        });

        // Handle abort — task cancelled, session closed, or agent interrupted.
        // Resolve as cancelled so the SDK promise settles and the agent gets a
        // clean answer rather than a hanging promise.
        options.signal.addEventListener("abort", () => {
          if (this.pendingUserDialogs.has(requestId)) {
            this.pendingUserDialogs.delete(requestId);
            const reason: UserDialogTimeoutEvent["reason"] = this.closed
              ? "session_closed"
              : "abort";
            this.emitEvent({
              type: "user_dialog_timeout",
              task_id: this.taskId,
              request_id: requestId,
              reason,
            });
            this.emitEvent({
              type: "user_dialog_response",
              task_id: this.taskId,
              request_id: requestId,
              dialog_kind: request.dialogKind,
              cancelled: true,
            });
            resolve({ behavior: "cancelled" });
          }
        });
      });
    };
  }

  // Resolve a pending user dialog. `payload.answers` is the user-selected
  // {question -> label} map (single answer string per question, with
  // multi-select values joined by ", "). `payload.cancelled` aborts cleanly.
  //
  // The resolve shape depends on `source`: `onUserDialog` dialogs resolve
  // with a `UserDialogResult`; `canUseTool` dialogs (built-in AskUserQuestion)
  // resolve with a `PermissionResult` whose deny message carries the answer.
  resolveUserDialog(
    requestId: string,
    payload: { answers?: Record<string, string>; cancelled?: boolean; feedback?: string },
  ): void {
    const pending = this.pendingUserDialogs.get(requestId);
    if (!pending) {
      console.warn(`[ActiveSession] No pending user dialog for request ${requestId}`);
      return;
    }
    this.pendingUserDialogs.delete(requestId);

    if (payload.cancelled) {
      if (pending.source === "onUserDialog") {
        pending.resolve({ behavior: "cancelled" });
      } else {
        // canUseTool path: deny so the model sees the cancellation.
        pending.resolve({
          behavior: "deny",
          message: payload.feedback || "User cancelled the question.",
          toolUseID: pending.toolUseId,
        });
      }
      this.emitEvent({
        type: "user_dialog_response",
        task_id: this.taskId,
        request_id: requestId,
        dialog_kind: pending.kind,
        cancelled: true,
        feedback: payload.feedback,
      });
      this.logEvent("user_dialog_response", JSON.stringify({ request_id: requestId, cancelled: true, feedback: payload.feedback }));
      return;
    }

    const answers = payload.answers ?? {};

    if (pending.source === "onUserDialog") {
      const result = this.buildDialogResult(pending, answers);
      pending.resolve({ behavior: "completed", result });
    } else {
      // canUseTool path: deny with the answers encoded as the message so the
      // model sees the user's choices as the tool_result. We format it as
      // readable text the model can parse, since `deny` produces a text
      // tool_result rather than a structured one.
      const answerText = pending.questions
        .map((q) => {
          const a = answers[q.question] || "(no answer)";
          return `${q.question} -> ${a}`;
        })
        .join("\n");
      pending.resolve({
        behavior: "deny",
        message: `User answered:\n${answerText}`,
        toolUseID: pending.toolUseId,
      });
    }

    this.emitEvent({
      type: "user_dialog_response",
      task_id: this.taskId,
      request_id: requestId,
      dialog_kind: pending.kind,
      cancelled: false,
      answers,
      feedback: payload.feedback,
    });
    this.logEvent(
      "user_dialog_response",
      JSON.stringify({ request_id: requestId, answers, feedback: payload.feedback }),
    );
  }

  // Snapshot of pending dialogs for the runtime to expose via API.
  getPendingUserDialogs(): Array<{
    requestId: string;
    kind: UserDialogKind;
    questions: UserDialogQuestion[];
    toolUseId?: string;
    emittedAt: number;
  }> {
    return Array.from(this.pendingUserDialogs.values()).map((p) => ({
      requestId: p.requestId,
      kind: p.kind,
      questions: p.questions,
      toolUseId: p.toolUseId,
      emittedAt: p.emittedAt,
    }));
  }

  // Convert the opaque SDK payload for a given dialog kind into the
  // normalized question list our UI uses. Today only `ask_user_question`
  // is wired; other kinds fall through with an empty question set and the
  // UI just shows a fallback card.
  private normalizeDialogQuestions(kind: UserDialogKind, payload: Record<string, unknown>): UserDialogQuestion[] {
    if (kind === "ask_user_question") {
      const raw = (payload?.questions ?? []) as Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string; preview?: string }>;
        multiSelect?: boolean;
      }>;
      return raw.map((q) => ({
        question: q.question ?? "",
        header: q.header ?? "",
        options: (q.options ?? []).map((o) => ({
          label: o.label,
          description: o.description,
          preview: o.preview,
        })),
        multi_select: !!q.multiSelect,
      }));
    }
    return [];
  }

  // Build the structured `result` payload handed back to the SDK. Mirrors
  // AskUserQuestionOutput for `ask_user_question` so the model sees a
  // coherent answer (own question text + chosen option labels).
  private buildDialogResult(pending: PendingUserDialog, answers: Record<string, string>): unknown {
    if (pending.kind === "ask_user_question") {
      return {
        questions: pending.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options
            .filter((o) => {
              const chosen = answers[q.question] ?? "";
              return chosen
                .split(",")
                .map((s) => s.trim())
                .includes(o.label);
            })
            .map((o) => ({ label: o.label })),
        })),
      };
    }
    return answers;
  }

  // 功能: 给 SDK 创建 media MCP server (image_gen / video_gen 工具) 用的 ctx.
  //   - outputDir 落在 $ORCHESTRATOR_HOME/uploads/{owner}/{task}/ 子树,
  //     registerAttachmentFromPath 白名单接受 (见 attachments.ts:303-315).
  //   - registerAttachment 直接调同进程 DB 函数, 不走 HTTP (避免多一层 roundtrip);
  //     落完调 getRuntime().emitAttachment 推 SSE 让 chat timeline 立刻刷.
  // 关注点:
  //   - 该函数每次 query() 时调一次, 同一个 ActiveSession 多次 start/resume 内部
  //     sdk-tools.ts 的 createMediaServer 缓存同一 instance (ctx 不变就复用);
  //     ctx 变了 (e.g. userId 切换) 自动重起.
  //   - emitAttachment 通过当前 AgentRuntime 单例推 SSE, 见 agent-runtime.ts:1078.
  // 🆕 R131 (damo 2026-09-15): buildReviewToolsContext 同模式 — 给 review MCP
  //   server 用, 把 taskId/userId/baseUrl 注入. 走同进程 HTTP, baseUrl 从 request
  //   头推断 (NEXTAUTH_URL 或 fallback 到 localhost:13000).
  private buildReviewToolsContext() {
    const userId = this.userId || "_unknown";
    return {
      taskId: this.taskId,
      userId,
      baseUrl: process.env.NEXTAUTH_URL || process.env.ORCHESTRATOR_BASE_URL || "http://localhost:13000",
    };
  }

  private buildMediaToolsContext() {
    const ownerId = this.userId || "_unknown";
    const outputDir = path.join(ORCHESTRATOR_HOME, "uploads", ownerId, this.taskId);
    return {
      taskId: this.taskId,
      userId: this.userId,
      cwd: this.cwd,
      outputDir,
      emitAttachment: (info: { id: string; filename: string; media_type: string; size_bytes: number }) => {
        getRuntime().emitAttachment(this.taskId, info);
      },
      registerAttachment: async (
        descriptor: AssetDescriptor,
        tool: string,
      ): Promise<{ ok: true; attachmentId: string } | { ok: false; reason: string }> => {
        if (!this.userId) {
          return { ok: false, reason: "task has no owner_id; cannot register attachment" };
        }
        const task = getTaskById(this.taskId);
        if (!task) {
          return { ok: false, reason: `task ${this.taskId} not found` };
        }
        // attachments.metadata 命名空间 (plan §"解耦设计"): 顶层 provider /
        // tool / created_via, 命名空间 provider_refs[provider] 存 vendor 字段.
        // 换 vendor 时顶层 schema 不动, 只往 provider_refs 加新 key.
        const metadata = JSON.stringify({
          provider: descriptor.provider,
          provider_refs: { [descriptor.provider]: descriptor.providerRefs },
          tool,
          created_via: "agent_sdk",
        });
        const result = registerAttachmentFromPath(
          task,
          this.userId,
          descriptor.storagePath,
          {
            filename: descriptor.filename,
            mediaType: descriptor.mediaType,
            source: descriptor.source,
            metadata,
          },
        );
        if (!result.ok) return { ok: false, reason: result.reason };
        return { ok: true, attachmentId: result.attachment.id };
      },
    };
  }

  // 功能: 若当前模型命中 MODEL_GUIDANCE 且引导文件存在, 返回拼在首条 prompt 前
  //   的指路 system-reminder; 否则 null.
  // 关注点: 只在 start()(全新会话)注入, resume 会带完整历史, 提醒已在里面.
  private modelGuidanceReminder(): string | null {
    const model = this.resolvedConfig.model || process.env.ANTHROPIC_MODEL || "";
    if (!model) return null;
    for (const g of ActiveSession.MODEL_GUIDANCE) {
      if (!g.pattern.test(model)) continue;
      const abs = path.join(CLAUDE_CONFIG_DIR, g.file);
      if (!fs.existsSync(abs)) {
        console.warn(`[ActiveSession] Model guidance for ${model} configured but file missing: ${abs}`);
        return null;
      }
      return [
        "<system-reminder>",
        `当前任务运行在模型 ${model} 上。开工前必须先 Read ${abs} 并严格遵守其中约定（针对该模型的已知弱点的加强约束），读完再执行下面的任务。\n只读一次：Read 后内容已进上下文，后续 turn 复用历史即可，无需再次 Read；除非对话被压缩导致内容丢失才重新 Read。`,
        "</system-reminder>",
      ].join("\n");
    }
    return null;
  }

  // R127 §3.1: 平台级 docs 注入, 对所有模型生效. 区别于 modelGuidanceReminder 的
  //   「模型弱点」(只命中特定 model) — 本函数是「平台机制」(普适). wording 也不同,
  //   不写「该模型的已知弱点」避免误导 agent.
  private platformDocsReminder(): string | null {
    const items = ActiveSession.AGENT_PLATFORM_DOCS;
    if (items.length === 0) return null;
    const blocks: string[] = [];
    for (const d of items) {
      const abs = path.join(CLAUDE_CONFIG_DIR, d.file);
      if (!fs.existsSync(abs)) {
        console.warn(`[ActiveSession] Platform doc configured but file missing: ${abs}`);
        continue;
      }
      blocks.push(`<system-reminder>\n平台机制必读：开工前请 Read ${abs}（${d.reason}）。只读一次：Read 后内容已进上下文，后续 turn 复用历史即可，除非对话被压缩导致内容丢失才重新 Read。\n</system-reminder>`);
    }
    return blocks.length > 0 ? blocks.join("\n\n") : null;
  }

  // v518 (飞书 R222): 用户身份注入 —— 让 agent 知道「用户是谁、喜好是什么」.
  //   需求背景: 项目 cwd / CLAUDE.md 里常出现 damo 等名字, agent 容易误称用户.
  //   注入的是内容本身而不是指路文件 —— 昵称+简介总共几行, 多一次 Read turn
  //   反而亏 (与 MODEL_GUIDANCE「省 token 指路」的取舍相反: 那些是长文档).
  //   解析规则 (R222 原文): 配置了就用配置的; 昵称没配默认「用户」;
  //   自我介绍没配省略整行. owner 缺失 (理论不可能) → 注入默认身份, 不静默跳过.
  //   关注点: 只在 start() 注入 (resume 带完整历史, 提醒已在里面),
  //   与 modelGuidanceReminder 同款 —— 每 task 会话一次, 不是每轮对话都嵌.
  private userProfileReminder(): string | null {
    if (!this.userId) return null;
    const profile = resolveUserProfile(this.userId);
    const lines = [
      "<system-reminder>",
      "当前用户身份（本平台账号，派任务给你的人）：",
      `- 称呼：${profile.nickname}（对话与汇报中用这个称呼指代用户，不要从邮箱前缀 / 文件路径里的名字猜）`,
    ];
    if (profile.bio) {
      lines.push(`- 自我介绍：${profile.bio}`);
    }
    lines.push("涉及用户偏好与称呼时以上述为准。", "</system-reminder>");
    return lines.join("\n");
  }

  // Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): role feishu_writeback=0
  //   时注入的软约束. 飞书回写三层通道里「agent shell 直写」平台拦不住 (无运行时
  //   钩子), 只能明示 —— 注入内容本身 (几行, 不指路文件). 开关=1 或 role 缺失
  //   (task.role_id NULL / 查不到) → 不注入, 行为不变.
  //   关注点: 只在 start() 路径拼 head 注入一次 (resume 带完整历史, 提醒已在
  //   里面), 与 userProfileReminder 同款.
  private roleWritebackReminder(task: Task): string | null {
    if (!task.role_id) return null;
    const role = getRoleById(task.role_id);
    if (!role || role.feishu_writeback !== 0) return null;
    return [
      "<system-reminder>",
      "本角色已关闭飞书回写（feishu_writeback=0）：不要把本任务结果写入飞书表格 —— 不要运行 feishu.sh 的写操作、feishu-board.ts write、lark-cli 的 cell/row 写类命令；结果只落平台（commit / checkpoint / 收尾总结）与本地文档。",
      "</system-reminder>",
    ].join("\n");
  }

  // Build env for the SDK subprocess
  private async buildEnv(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = { ...process.env };

    // Inject per-user/per-project LLM config.
    // If user/project has a self-configured API key, use it.
    // If NOT (user hasn't configured their own key), CLEAR the env key
    // so the SDK subprocess cannot use the system fallback — users must
    // self-configure their API Key in the settings page.
    if (this.resolvedConfig.api_key) {
      env.ANTHROPIC_API_KEY = this.resolvedConfig.api_key;
      // 平台已解析出明确配置时, 环境残留的 AUTH_TOKEN 必须清掉 —— CLI 认证
      //   优先级 AUTH_TOKEN(Bearer) > API_KEY, 不清则配置 key 永远不生效
      //   (实测 2026-10-04: Mac dev 会话 env 带占位 AUTH_TOKEN, 配置 bigmodel
      //   base_url + 有效 key 照样 401「令牌已过期」, 本地复现 fallback 链踩到).
      //   无配置 key 时保留 (代理链路/集成测试故意用, 见下方 0824 注释).
      delete env.ANTHROPIC_AUTH_TOKEN;
    } else {
      // No user/project key — remove env key to prevent silent fallback
      delete env.ANTHROPIC_API_KEY;
    }
    if (this.resolvedConfig.base_url) {
      env.ANTHROPIC_BASE_URL = this.resolvedConfig.base_url;
    } else if (!this.resolvedConfig.api_key) {
      // No key and no base_url — clear base_url too to avoid routing to
      // the wrong endpoint with no credentials
      delete env.ANTHROPIC_BASE_URL;
    }

    // Force a portable, isolated config dir for the claude subprocess so it
    // doesn't load the user's global ~/.claude (conflicting endpoints/plugins).
    // Resolve from os.homedir() so it works on both macOS (/Users) and Linux
    // (/home). A hardcoded /home/user path in .env.local broke on macOS, where
    // /home is an autofs mount point and mkdir fails with ENOTSUP.
    env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;

    // Remove Orchestrator's own env vars that must NOT leak into agent
    // subprocesses.  PORT is the most harmful: agent tasks that run
    // `npm run start:dev` (or any server) inherit this value and bind to the
    // wrong port instead of their project's default.
    delete env.PORT;
    delete env.NEXT_PUBLIC_APP_URL;

    // NODE_ENV 同理 —— 平台自身由 pm2 以 NODE_ENV=production 启动, 泄漏给 agent
    // 子进程后 npm 的 `omit` 默认值变成 `dev`: agent 跑 `npm install <pkg>` 会
    // 静默裁掉 devDependencies (typescript/vitest/eslint 全被 prune, 已实测踩过,
    // 见 docs/phase-1-progress.md). 删掉而不是设 development: next dev/build、
    // deploy.sh 都会自己设正确的值, 交给它们判断。
    delete env.NODE_ENV;

    // §0824 修复 - 跨实例 ao_ token 黑名单(只删跨实例 token,别的不动)
    // 之前 `{...process.env}` 会继承平台 next-server 进程的所有 env,包括本机
    // shell source 进来的 .env.tokens 里的跨实例 token(WSL_ADMIN_TOKEN /
    // PULU_*_TOKEN / MAC_*_TOKEN). agent SDK 子进程拿到后能跨实例污染(实测:
    // agent 0824 用 WSL_ADMIN_TOKEN 往 dao.example.com POST 派"测试任务").
    // 判断依据(0824 damo 澄清):
    //   - login.sh 的 ao_resolve_auth 优先级是 AO_TOKEN > AO_EMAIL+AO_PASSWORD >
    //     环境检测,**不走** WSL_/PULU_/MAC_*_TOKEN -- agent 派子任务用下方
    //     issueSwitchToken 注入的 env.AO_TOKEN,删这些不影响派发链路.
    //   - ANTHROPIC_AUTH_TOKEN(mac 上 PROXY_MANAGED 占位)/OLLAMA_* / QWEN_API_KEY
    //     等第三方凭据是 agent 可能故意用的(LLM 代理链路 / 集成测试),**不删**.
    delete env.WSL_ADMIN_TOKEN;
    delete env.WSL_USER_TOKEN;
    delete env.WSL_DEV_ADMIN_TOKEN;
    delete env.PULU_ADMIN_TOKEN;
    delete env.PULU_USER_TOKEN;
    delete env.PULU_AO_TOKEN;
    delete env.MAC_ADMIN_TOKEN;
    delete env.MAC_USER_TOKEN;
    delete env.AO_TOKEN; // 防御性先删,稍后 issueSwitchToken 会设;和 line 940 同义(此处兜底)

    // Inject task metadata so agent subprocesses (e.g. dispatch scripts)
    // can discover their own project/version and dispatch sub-tasks to the
    // same version without hardcoding IDs.
    env.ORCHESTRATOR_TASK_ID = this.taskId;
    if (this.projectId) env.ORCHESTRATOR_PROJECT_ID = this.projectId;
    if (this.versionId) env.ORCHESTRATOR_VERSION_ID = this.versionId;

    // ---- 账号级 git 提交身份注入 (v515, 飞书 R178) ----
    // 关注点:
    //   - GIT_AUTHOR_*/GIT_COMMITTER_* env 在 git 里优先级高于任何 config,
    //     agent 子进程 git commit 的作者/提交者 = task owner 的账号身份,
    //     git log 直接可见; 不写 .git/config —— 同机多账号并发跑 task,
    //     写共享仓 config 会互相踩 (账号级身份也不该污染仓库文件).
    //   - 无条件注入 (不只显式配置时): 多租户下不注入 = 提交全部冒名机器全局
    //     config 的身份. 默认 email=账号邮箱, name=邮箱前缀 (resolveGitIdentity).
    //   - 必须 **先 delete 再 set**: 平台进程 env 若残留 GIT_* (极少见但 CI /
    //     脚本环境会有), 不显式 delete 会被透传 = 静默错身份.
    //   - resolve 失败不炸任务: 身份注入是增强, 不是闸门.
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    try {
      if (this.userId) {
        const git = resolveGitIdentity(this.userId);
        if (git) {
          env.GIT_AUTHOR_NAME = git.name;
          env.GIT_AUTHOR_EMAIL = git.email;
          env.GIT_COMMITTER_NAME = git.name;
          env.GIT_COMMITTER_EMAIL = git.email;
        }
      }
    } catch (err) {
      console.warn(`[ActiveSession] Failed to resolve git identity for ${this.userId}:`, (err as Error).message);
    }

    // 当前使用的模型(resolved 链最终值) -- agent 可感知自己在什么模型上跑,
    // 弱模型引导等场景直接 env 查, 不用猜.
    // resolvedModel 跟 resolved_model (v36) 同源同值, 空时显式 delete 是为了让
    // 平台 env 残留值不污染 agent 感知(否则平台进程 ORCHESTRATOR_MODEL=MiniMax-M3
    // 会通过 {...process.env} 泄漏, agent 误判自己在该模型上跑).
    const resolvedModel = this.resolvedConfig.model || process.env.ANTHROPIC_MODEL;
    if (resolvedModel) env.ORCHESTRATOR_MODEL = resolvedModel;
    else delete env.ORCHESTRATOR_MODEL;

    // 飞书 sheet 绑定注入: 任务所属 version(缺省回落 project 的 current version)
    // 若绑了飞书表, 把 URL/sheet 名传下去 -- scripts/feishu.sh 原生读这俩 env,
    // agent 提到「飞书 E2」这类格号指称时不再靠猜(2026-08-16 task 75d4f0ad:
    // agent 拿 feishu.sh 曾有的硬编码默认表读了别的项目的 1.6期 表).
    // 没绑就主动删掉: 平台进程 env 里若残留 FEISHU_*, 泄漏下去同样是静默错表.
    try {
      const versionId = this.versionId
        || (this.projectId ? getProjectById(this.projectId)?.current_version_id : null);
      const version = versionId ? getVersionById(versionId) : null;
      if (version?.feishu_url) {
        env.FEISHU_SHEET_URL = version.feishu_url;
        if (version.feishu_sheet) env.FEISHU_SHEET_NAME = version.feishu_sheet;
        else delete env.FEISHU_SHEET_NAME;
      } else {
        delete env.FEISHU_SHEET_URL;
        delete env.FEISHU_SHEET_NAME;
      }
    } catch (err) {
      console.warn(`[ActiveSession] Failed to resolve feishu sheet binding for ${this.taskId}:`, (err as Error).message);
      delete env.FEISHU_SHEET_URL;
      delete env.FEISHU_SHEET_NAME;
    }

    // ---- AO_TOKEN 自动注入: 让 agent SDK 子进程自带「当前账号」的不过期 bearer token ----
    // 关注点:
    //   - 复用 issueSwitchToken(this.userId) 拿 task owner 的「switch-account」token
    //     (无则建 / 有则复用, 永远不会越权拿其他账号的 token, 更不会拿管理员 token).
    //   - 注入后 agent 子进程可直接 `curl -H "Authorization: Bearer $AO_TOKEN" ...`
    //     调平台 API, session/cookie/refresh 全免 —— 省去手动调 scripts/login.sh.
    //   - login.sh 的 `ao_resolve_auth` 优先级 AO_TOKEN > AO_EMAIL+AO_PASSWORD >
    //     环境检测, 注入 AO_TOKEN 会接管 env 内置凭据.
    //   - 必须先 delete 再 set: 平台进程 env 里若残留 AO_TOKEN (极少见但防御),
    //     不显式 delete 会被原样透传 = 静默错配.
    try {
      delete env.AO_TOKEN;
      if (this.userId) {
        env.AO_TOKEN = await issueSwitchToken(this.userId);
      }
    } catch (err) {
      console.warn(`[ActiveSession] Failed to issue AO_TOKEN for ${this.userId}:`, (err as Error).message);
      delete env.AO_TOKEN;
    }

    // ---- minimax mmx-cli 多模态 API key 注入 ----
    // 关注点:
    //   - mmx-cli **不读** MINIMAX_API_KEY env (mmx 只看 --api-key flag 或
    //     $MMX_CONFIG_DIR/config.json 明文). 平台做法: buildEnv 注入 per-user
    //     MMX_CONFIG_DIR (隔离多用户), MINIMAX_API_KEY 作为 hint env
    //     (agent 可拼 --api-key flag); settings「保存」时 API 端已 mmx auth login
    //     把明文落到 MMX_CONFIG_DIR/config.json. 用户没配 / 解密失败 → 一律
    //     delete 平台进程可能带的同名 env, 防止泄漏 (同 ANTHROPIC_API_KEY 政策).
    //   - 必须 **先 delete 再 set**: platform 进程残留的 env 若被 spread 进来,
    //     不显式 delete 会被原样透传给 agent 子进程 = 静默错配置 (跟 ANTHROPIC
    //     block 的「if (!env.X) delete」反着写, 因为这里 X 是 hint env,
    //     空值比残留值安全).
    delete env.MINIMAX_API_KEY;
    delete env.MMX_CONFIG_DIR;
    delete env.MINIMAX_REGION;
    try {
      if (this.userId) {
        const mediaRow = getMediaKey(this.userId);
        if (
          mediaRow?.api_key_encrypted &&
          mediaRow.api_key_iv &&
          mediaRow.api_key_tag
        ) {
          try {
            const plaintext = decrypt(
              mediaRow.api_key_encrypted,
              mediaRow.api_key_iv,
              mediaRow.api_key_tag,
            );
            env.MINIMAX_API_KEY = plaintext; // hint env (mmx-cli 不读, agent 拼 flag 用)
            env.MMX_CONFIG_DIR = path.join(
              ORCHESTRATOR_HOME,
              "users",
              this.userId,
              ".mmx",
            );
            if (mediaRow.region) env.MINIMAX_REGION = mediaRow.region;
          } catch (err) {
            console.warn(
              `[ActiveSession] Failed to decrypt media API key for user ${this.userId}:`,
              (err as Error).message,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `[ActiveSession] Failed to resolve media key for ${this.taskId}:`,
        (err as Error).message,
      );
    }

    return env;
  }

  // 功能: 构建 allowedTools 列表 — 写类工具一律排除, 让它们落到 canUseTool.
  // 关注点: 写类工具进了 allowedTools 就会被 SDK 在咨询回调前直接放行, 而
  // allowedTools 只在 query() 时传一次、之后改不了 —— 所以这里不能按
  // autoApprove 分叉, 否则运行中把「自动审批」关掉将无效。自动放行的判断放在
  // canUseTool 里 (每次工具调用都读 this.autoApprove), 代价是自动审批开着时
  // 每个写工具多一次进程间往返。
  //   PR-3 修订: MCP 工具名 (`mcp__<server>__<tool>`) SDK 不会从 mcpServers 自动
  //   加入 agent 工具集 —— 必须显式列在 allowedTools 里, agent 才能看到并调
  //   (实测 2026-09-02 task 15e1572f: 装上 mcpServers 后 agent 报"工具集里没有
  //   mcp__media__image_gen"). 写类过滤对 MCP 工具不生效 (image_gen/video_gen
  //   不在 WRITE_TOOLS 集合), 所以追加在过滤之后.
  private buildAllowedTools(task: Task): string[] {
    const base: string[] = task.allowed_tools
      ? JSON.parse(task.allowed_tools)
      : [...ALL_TOOLS];

    const filtered = base.filter((t) => !WRITE_TOOLS.has(t));
    // 永远带上 PR-3 media MCP 工具. 加新 MCP server 在这里同步加一行.
    filtered.push("mcp__media__image_gen", "mcp__media__video_gen");
    return filtered;
  }

  // Start a new agent session
  async start(task: Task): Promise<void> {
    // Pre-check: user must have a self-configured API Key to run tasks.
    // Without it, the SDK subprocess will fail with an opaque auth error.
    // Give a clear message upfront instead.
    if (!this.resolvedConfig.api_key) {
      throw new Error(
        "未配置 API Key。请在「设置」页面配置个人 LLM API Key，或在项目页配置项目级 API Key。"
      );
    }

    // Ensure workspace directory exists
    if (!fs.existsSync(this.cwd)) {
      fs.mkdirSync(this.cwd, { recursive: true });
    }

    // Snapshot the repo state at task start so base_commit anchors the
    // "before" state for any future fork.
    this.recordBaseCommit();

    const allowedTools = this.buildAllowedTools(task);

    // R175 fallback 链: [0] 号成员即本次主配置 (constructor 里 vision swap 后
    //   chain[0] 已是换主结果). 起跑失败 (模型没说过一句话 = sessionId 仍空) 且
    //   非外部终止时, 换下一个链成员 (不同凭证才有意义) 整体重跑 query;
    //   模型已开口后的中途失败不重试 (进度丢失不可接受, 留待真实痛点).
    const chain = this.resolvedConfig.fallback_chain.length
      ? this.resolvedConfig.fallback_chain
      : [{
          config_id: this.resolvedConfig.source_config_id,
          name: "(primary)",
          model: this.resolvedConfig.model,
          base_url: this.resolvedConfig.base_url,
          api_key: this.resolvedConfig.api_key,
          same_credentials: true,
          supports_vision: null,
        }];

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < chain.length; attempt++) {
      const entry = chain[attempt];
      // R175 追加: consumeMessages 在 synthetic API 错误且还有链可试时不写终态,
      //   判断依据就是这里设置的剩余数 (必须在 query 启动前写好).
      this.fallbackRemaining = chain.length - attempt - 1;
      this.attemptHadModelOutput = false;
      this.quotaFastFailError = null;
      this.rateLimitRetryCount = 0;
      // 换凭证成员: 更新 resolvedConfig (buildEnv/model 快照都读它), 重快照 DB.
      if (attempt > 0) {
        this.resolvedConfig = {
          ...this.resolvedConfig,
          api_key: entry.api_key,
          base_url: entry.base_url,
          model: entry.model,
          source_config_id: entry.config_id,
        };
        this.snapshotResolution();
        this.logEvent(
          "llm_fallback",
          JSON.stringify({
            attempt,
            from_config: chain[0].name,
            to_config: entry.name,
            model: entry.model,
            reason: String((lastErr as Error)?.message || lastErr || "unknown"),
          }),
        );
        console.warn(
          `[ActiveSession] LLM fallback for task ${this.taskId}: attempt ${attempt} -> ${entry.name} (${entry.model})`,
        );
      }

      // 模型命中引导配置时, 首条 prompt 前拼指路 reminder(全新会话才走 start(),
      // resume 带完整历史不需要重拼). 平台级 docs (R127 §3.1 awaiting marker) 也走这里,
      // 对所有模型注入, 保证每个 agent 都学到 decision marker 的 schema.
      // 🆕 D34: 删 goal-self-report reminder 拼 head (D29 旧实现导致中间轮被提醒污染输出).
      //   reminder 改在 success 路径前置注入 (见 consumeMessages success 拦截块
      //   checkGoalSelfReportOrNudge). 中间轮 result 不带 block = 不污染.
      // R175: 每次 fallback 重试都重算 — guidance 按当前模型 pattern 匹配.
      const guidance = this.modelGuidanceReminder();
      const platformDoc = this.platformDocsReminder();
      // v518 (R222): 用户身份 (昵称+自我介绍) 也走 head, 每 task 会话注入一次.
      const userProfile = this.userProfileReminder();
      // P4 (D4): role 关了飞书回写 → 注入「本角色不回写」软约束 (head 同款一次注入).
      const roleWriteback = this.roleWritebackReminder(task);
      const head = [guidance, platformDoc, userProfile, roleWriteback]
        .filter((s): s is string => !!s)
        .join("\n\n");
      // damo 2026-10-31: 任务在 pending/queued (从未启动) 期间收到的用户消息被
      //   sendUserMessage 缓存进 metadata.pending_messages. start() 在这里排空,
      //   按 resume() 同一份契约投递 —— prompt 在前 (先答原始指令), 攒下的消息
      //   逐条跟在后面. 红线 (resume-contract.md §2): 消费记录放在 query 之前,
      //   中途崩了宁可丢一次投递, 也不要留着无限重放. 空 drain 是 no-op
      //   (drainPendingMessages 内部无变化不写库), 全新任务零开销.
      const queuedBeforeStart = drainPendingMessages(this.taskId);
      const messageGenerator = this.createMessageGenerator(
        head ? `${head}\n\n${task.prompt}` : task.prompt,
        queuedBeforeStart,
      );

      // R175: SDK 原生 fallbackModel — 与当前成员同凭证 (同 key+base_url) 的
      //   后续链成员模型名. SDK 在 overloaded/不可用时凭证内自动切换, 每 user
      //   turn 回试主模型; 跨凭证场景由外层重试循环兜.
      const sdkFallbackModels = chain
        .slice(attempt + 1)
        .filter(
          (e) =>
            e.model &&
            e.model !== entry.model &&
            !!e.api_key &&
            e.api_key === entry.api_key &&
            (e.base_url || undefined) === (entry.base_url || undefined),
        )
        .map((e) => e.model!)
        .filter((m, i, arr) => arr.indexOf(m) === i);

      this.queryInstance = query({
        prompt: messageGenerator,
        options: {
          cwd: this.cwd,
          model: entry.model || process.env.ANTHROPIC_MODEL,
          fallbackModel:
            sdkFallbackModels.length > 0 ? sdkFallbackModels.join(",") : undefined,
          allowedTools,
          maxTurns: this.runOpts.max_turns ?? task.max_turns ?? 200,
          effort: (this.runOpts.effort ?? task.effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max",
          includePartialMessages: true,
          enableFileCheckpointing: true,
          canUseTool: this.createCanUseTool(),
          onUserDialog: this.createOnUserDialog(),
          supportedDialogKinds: ["ask_user_question"],
          // R3 runner 拦截改走 PreToolUse hook (见 createBashRunnerHook):
          //   canUseTool 对 Bash 不触发 (P5 实测 inner 0 次), hook 必触发.
          //   只拦 Bash (matcher=Bash), 其他工具不受影响; deploy-guard /
          //   process-kill 仍走 canUseTool 对 Write/Edit 等生效.
          hooks: { PreToolUse: [{ hooks: [this.createBashRunnerHook()] }] },
          // PR-3: image_gen / video_gen (capability 语义, 不绑 vendor).
          //   默认走 mmx Provider (registry.get('mmx')); 换 vendor 改 registry + 新
          //   文件, 本行不动. 见 docs/plans/projects/asset-gallery-and-chat-media.md §"解耦设计".
          mcpServers: {
            media: createMediaServer(this.buildMediaToolsContext()),
            // 🆕 R131 (damo 2026-09-15): review MCP server — refine/await_user/unawait
            //   三个工具, task_id 自动从 session 取. 同 ctx 复用同 server instance.
            review: createReviewServer(this.buildReviewToolsContext()),
          },
          env: await this.buildEnv(),
        },
      });

      // Start consuming (session_id is set on the first assistant message)
      // — the consumeMessages loop will create the sessions row idempotently
      // when it observes msg.session_id, so we don't race with a fixed delay.
      const consumePromise = this.consumeMessages();

      // Now wait for the agent to actually finish before returning
      try {
        await consumePromise;
        // R212 (damo 2026-10-07「同一个凭证不重试」): quota 快速失败 ——
        //   consumeMessages 首次命中 429/配额信号时已 close query, for-await 即刻
        //   收尾 (无 result), 走到这里. 零进度 (信号先于模型产出, 配额耗尽时必
        //   然) 且链上还有成员 → 换凭证重跑 (同 R175/R182 synthetic 语义, lastErr
        //   带 quota 文本供 llm_fallback reason); 已有进度 (中途配额断供, 重跑 =
        //   进度丢失) 或链尽 → failed(api_error:...) 终态, error 前缀与
        //   maybeDrainStrandedMessages 的 api_error 防线约定一致.
        if (this.quotaFastFailError && !this.externallyTerminated) {
          lastErr = new Error(this.quotaFastFailError);
          if (!this.attemptHadModelOutput && attempt + 1 < chain.length) {
            continue;
          }
          this.writeQuotaFastFailTerminal();
          return;
        }
        // R175 追加 (damo 2026-10-04 反馈「配置了fallback链了，但是模型错误了，
        //   不会自动切换」): synthetic API 错误 (429/401 以 subtype=success 伪装
        //   收尾, result 即错误文本) 时 consumeMessages 正常 resolve 不抛错,
        //   原版这里直接 return —— fallback 循环永远不触发, 实测 363f0c90 两轮
        //   都这样. 该形态 = 零真实进度 (错误文本非模型产出, checkpoint/正文
        //   皆无), 按链换凭证重跑与起跑失败同语义. 链尽 / 外部终止 → return
        //   (终态已由 consumeMessages 落).
        if (
          this.syntheticApiErrorText &&
          !this.externallyTerminated &&
          attempt + 1 < chain.length
        ) {
          lastErr = new Error(this.syntheticApiErrorText);
          continue;
        }
        return;
      } catch (err) {
        // R212: close() 收尾时 SDK 可能以 throw 结束 for-await (process exit /
        //   aborted 类噪声). 优先按 quota 快速失败处理, 不让 abort 噪声盖住真因.
        if (this.quotaFastFailError && !this.externallyTerminated) {
          lastErr = new Error(this.quotaFastFailError);
          if (!this.attemptHadModelOutput && attempt + 1 < chain.length) {
            continue;
          }
          this.writeQuotaFastFailTerminal();
          return;
        }
        lastErr = err;
        // R175: 零进度 (本 attempt 模型没说过真话) + 非外部终止 + 链上还有成员 →
        //   换凭证重试. 判据用 attemptHadModelOutput 而非 !sessionId —— synthetic
        //   错误消息也带 session_id, 一到就置上; resume 任务 sessionId 更是本来就
        //   非空 → 旧条件在「起跑即 API 错误」场景永远不成立 (2026-10-04 本地
        //   3c30b466 + 线上 c6d50986 双实证). 模型已开口 = 已有进度, 重试会丢
        //   对话历史, 不换 (交给上层 reject/retry).
        if (
          !this.attemptHadModelOutput &&
          !this.externallyTerminated &&
          attempt + 1 < chain.length
        ) {
          continue;
        }
        console.error(`[ActiveSession] Error consuming messages for task ${this.taskId}:`, err);
        this.emitEvent({
          type: "error",
          task_id: this.taskId,
          error: (err as Error).message || String(err),
        });
        // Ensure task is moved to failed state if consumeMessages threw
        // (e.g., API connection error before any messages were received)
        const currentTask = getTaskById(this.taskId);
        if (currentTask && currentTask.status === "running") {
          // R182 对齐: throw 形态 (result subtype=error → SDK 抛 "Claude Code
          //   returned an error result: ...") 与假 success 形态同样属 API 层错误,
          //   带 api_error: 前缀落库, 详情页/巡检一眼识别.
          const rawErrMsg = (err as Error).message || String(err);
          const isApiError =
            rawErrMsg.includes("API Error") || rawErrMsg.includes("Failed to authenticate");
          updateTaskStatus(this.taskId, "failed", {
            error: isApiError ? `api_error: ${rawErrMsg}` : rawErrMsg,
            completed_at: new Date().toISOString(),
          });
          this.emitEvent({
            type: "status_change",
            task_id: this.taskId,
            from: "running",
            to: "failed",
          });
        }
        return;
      }
    }
  }

  // 功能: R212 — quota 快速失败落终态 failed, error 带 api_error: 前缀 (与
  //   agent-runtime.maybeDrainStrandedMessages 的 api_error 防线约定一致:
  //   failed+api_error 不自动 drain, 防留言触发「每 3.5min 烧一轮配额」循环).
  //   result 字段保留原始错误文本, 详情页一眼看出是配额问题.
  // 关注点: 仅当前状态仍是 running 时写 (pause/cancel 的外部终态不覆盖);
  //   start()/resume() 多处调用, 幂等 —— 首写后状态非 running, 重复调用 no-op.
  private writeQuotaFastFailTerminal(): void {
    const currentTask = getTaskById(this.taskId);
    if (!currentTask || currentTask.status !== "running") return;
    updateTaskStatus(this.taskId, "failed", {
      session_id: this.sessionId || undefined,
      result: this.quotaFastFailError,
      error: `api_error: ${this.quotaFastFailError}`,
      cost_usd: this.costUsd,
      completed_at: new Date().toISOString(),
    });
    this.recordHeadCommit();
    this.emitEvent({
      type: "status_change",
      task_id: this.taskId,
      from: "running",
      to: "failed",
      cost_usd: this.costUsd,
    });
  }

  // 功能: 把当前 resolvedConfig 快照进 tasks.resolved_model / resolved_config_id
  //   (constructor 里原有逻辑提取成方法, fallback 换凭证重试时复用).
  // 关注点: 写失败只 warn 不抛 — 快照是观测字段, 不阻断任务执行.
  private snapshotResolution(): void {
    const task = getTaskById(this.taskId);
    if (!task) return;
    const resolvedModel = this.resolvedConfig.model || process.env.ANTHROPIC_MODEL || null;
    if (resolvedModel && resolvedModel !== task.resolved_model) {
      try {
        updateTask(task.id, { resolved_model: resolvedModel });
      } catch (err) {
        console.warn(`[ActiveSession] Failed to snapshot resolved_model for ${task.id}:`, (err as Error).message);
      }
    }
    if (this.resolvedConfig.source_config_id !== task.resolved_config_id) {
      try {
        updateTask(task.id, { resolved_config_id: this.resolvedConfig.source_config_id });
      } catch (err) {
        console.warn(`[ActiveSession] Failed to snapshot resolved_config_id for ${task.id}:`, (err as Error).message);
      }
    }
  }

  // 功能: R175 — 查任务附件里有没有图片 (media_type 以 image/ 开头).
  // 关注点: 附件表查询失败 (极端: 表未建/任务未落库) 视为无图, 不阻断启动.
  private taskHasImageAttachments(taskId: string): boolean {
    try {
      return listAttachmentsByTaskId(taskId).some((a) =>
        (a.media_type || "").startsWith("image/"),
      );
    } catch (err) {
      console.warn(`[ActiveSession] Failed to list attachments for ${taskId}:`, (err as Error).message);
      return false;
    }
  }

  // Resume an existing session
  async resume(task: Task): Promise<void> {
    if (!this.resolvedConfig.api_key) {
      throw new Error(
        "未配置 API Key。请在「设置」页面配置个人 LLM API Key，或在项目页配置项目级 API Key。"
      );
    }
    if (!task.session_id) {
      throw new Error("Cannot resume: no session_id on task");
    }

    this.sessionId = task.session_id;

    const allowedTools = this.buildAllowedTools(task);

    // For fork: metadata.parent_session_id means this is a fork resume,
    // and task.prompt should be sent as the first message — but only on
    // the *first* resume (not when re-resuming after a reject). On reject
    // resume the agent already has the full transcript; only the reject
    // feedback (in pending_messages) should be injected.
    let initialPrompt = "";
    let preMessages: string[] = [];
    let needCompactPhase = false;
    // fork 的 initialPrompt / 消费掉的 reject_reason 都要在 resume 末尾从 metadata
    // 里销掉, 否则下一次 resume 会再投一遍. 收集在这里, 统一走 mutateTaskMetadata.
    let forkPromptDelivered = false;
    let consumedRejectReason = false;
    if (task.metadata) {
      try {
        const meta = JSON.parse(task.metadata);
        // 🔴 判据是「这条 fork prompt 投过没有」, 不是「有没有被驳回」.
        // parent_session_id 是 fork 的永久标记, 从不清除; 早先只用 reject_count>0
        // 挡, 于是「给 reviewing/completed 的 fork 任务发消息」这条路(走的是同一个
        // resume()) 每次都把原始 task.prompt 重投一遍, 还排在用户新消息前面 ——
        // 模型先答旧的, 表现为「新消息发不进去、旧消息一直重复」(2026-08-12 task
        // 5d6efbf3 实测重放 3 次, agent 自己都在说「第三次说了」).
        // fork_prompt_sent 落在 metadata 里 = 跨进程持久, 覆盖所有 resume 路径
        // (驳回重放 / 给终态发消息 / pause-resume / 退维护).
        const forkPromptSent = meta.fork_prompt_sent === true;
        if (meta.parent_session_id && !forkPromptSent) {
          if (meta.compact_first) {
            // 压缩 fork: 需要先触发 SDK 原生 compaction（物理压缩 transcript
            // 为摘要），然后 agent 基于压缩后上下文继续。/compact 必须作为
            // string prompt 传给 query() 才能被 SDK 解析为斜杠命令——
            // AsyncIterable<SDKUserMessage> 中的消息不经过斜杠命令解析。
            // 所以分两步：先 query("/compact") 触发压缩，再 query(generator) 继续。
            needCompactPhase = true;
            initialPrompt = task.prompt || `请从父任务继承上下文，承接后续工作。`;
          } else {
            initialPrompt = task.prompt || "";
          }
          if (initialPrompt) forkPromptDelivered = true;
        }
        if (Array.isArray(meta.pending_messages) && meta.pending_messages.length > 0) {
          preMessages = meta.pending_messages as string[];
        }
        // Fallback: if reject_reason exists but wasn't queued (e.g. from
        // an older version of rejectTask), inject it as a preMessage so
        // the agent still sees the feedback.
        // 🔴 去重按「裸 feedback」比 —— rejectTask 入队的是裸串, 而这里 push 的是
        // 带 [驳回反馈] 前缀的, 两边格式不一样, 所以只有「驳回后紧接那次 resume」
        // 能命中 includes. 之后队列里换成用户的新消息, 守卫就失效, 旧反馈会被追加
        // 到新消息「后面」= 成为最后一个 user turn, 模型优先答它. 所以消费完必须
        // 从 metadata 里删掉(下面 consumedRejectReason), 不能只靠 includes.
        const rejectReason = meta.reject_reason as string | undefined;
        if (rejectReason) {
          if (!preMessages.includes(rejectReason)) {
            preMessages.push(`[驳回反馈] ${rejectReason}`);
          }
          consumedRejectReason = true;
        }
      } catch {}
    }
    // Clear pending_messages BEFORE resume — if anything goes wrong the
    // messages are lost, but otherwise they'd replay on every subsequent
    // resume and spam the agent with stale instructions.
    if (preMessages.length > 0) {
      try {
        drainPendingMessages(this.taskId);
      } catch (err) {
        console.warn(`[ActiveSession] Failed to drain pending_messages for ${this.taskId}:`, (err as Error).message);
      }
    }

    // 功能: 销掉本次已消费的一次性 metadata(fork prompt 标记 / 旧驳回反馈),
    //   下一次 resume 不再重投.
    // 关注点: 和上面 drain 同一个取舍 —— 放在 resume 之前, 中途崩了宁可丢一次投递,
    //   也不要留着无限重放. fork_prompt_sent 只置不删(fork 血缘 parent_session_id
    //   仍要留给 UI/lineage 看, 不能靠删它来止重放).
    if (forkPromptDelivered || consumedRejectReason) {
      try {
        mutateTaskMetadata(this.taskId, (meta) => {
          if (forkPromptDelivered) meta.fork_prompt_sent = true;
          if (consumedRejectReason) delete meta.reject_reason;
        });
      } catch (err) {
        console.warn(`[ActiveSession] Failed to clear one-shot metadata for ${this.taskId}:`, (err as Error).message);
      }
    }

    // 功能: 把 fork 的续接 prompt 作为一条真实用户消息落库 + 推 SSE.
    // 关注点: initialPrompt 只经 message generator 交给 SDK, 而 SDK 要等
    //   /compact 阶段跑完(实测可达 3 分钟)才把它写进 session JSONL —— 在那之前
    //   UI 无处可读, 操作者看到的是「fork 之后一条自己的话都没有」. 这里提前
    //   写一条 message 事件补上; getSessionHistory 按文本与 JSONL 去重, 之后
    //   不会出现第二条.
    if (initialPrompt) {
      const payload = JSON.stringify({ role: "user", text: initialPrompt });
      this.logEvent("message", payload);
      this.emitEvent({ type: "message", task_id: this.taskId, data: payload });
    }

    // Phase 1: compact (if compactFirst was requested)
    // /compact must be sent as a string prompt so the SDK recognizes it as a
    // slash command. AsyncIterable<SDKUserMessage> bypasses slash-command
    // parsing, so the old approach of yielding "/compact" as a user message
    // just sent literal text to the model without triggering compaction.
    if (needCompactPhase) {
      this.emitEvent({
        type: "assistant_message",
        task_id: this.taskId,
        text: "⏳ 正在压缩上下文（/compact）…",
        uuid: "",
      });
      const compactQuery = query({
        prompt: "/compact",
        options: {
          cwd: this.cwd,
          resume: task.session_id,
          model: this.resolvedConfig.model || process.env.ANTHROPIC_MODEL,
          // R175: 同凭证 fallback 模型列表 (resume 场景链信息仍在)
          fallbackModel:
            this.resolvedConfig.fallback_models.length > 0
              ? this.resolvedConfig.fallback_models.join(",")
              : undefined,
          allowedTools,
          maxTurns: 1,
          effort: (this.runOpts.effort ?? task.effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max",
          includePartialMessages: true,
          enableFileCheckpointing: true,
          canUseTool: this.createCanUseTool(),
          onUserDialog: this.createOnUserDialog(),
          supportedDialogKinds: ["ask_user_question"],
          env: await this.buildEnv(),
        },
      });
      // Drain the compact query — we only care that it completes; the
      // compact_boundary / local_command_output messages are internal to
      // the SDK and don't need to be forwarded to the UI.
      let compactOk = false;
      try {
        for await (const msg of compactQuery) {
          // compact_result is on SDKStatusMessage (type=system, subtype=status),
          // not on the final result message.
          if ((msg as any).type === "system" && (msg as any).subtype === "status") {
            if ((msg as any).compact_result === "success") {
              compactOk = true;
            }
          }
          if ((msg as any).type === "result") {
            const result = msg as any;
            // Also treat a successful result as compact ok (covers edge cases
            // where the status message wasn't emitted)
            if (result.subtype === "success") compactOk = true;
            if (result.session_id) this.sessionId = result.session_id;
            if (result.total_cost_usd) this.costUsd = result.total_cost_usd;
          }
        }
      } catch (err) {
        console.warn(`[ActiveSession] /compact phase failed for task ${this.taskId}:`, (err as Error).message);
      }
      this.emitEvent({
        type: "assistant_message",
        task_id: this.taskId,
        text: compactOk ? "✅ 上下文压缩完成，继续工作…" : "⚠️ 上下文压缩未执行（上下文可能太小），继续工作…",
        uuid: "",
      });
      // Clear compact_first from metadata so reject-replay doesn't re-compact.
      // 🔴 必须走 mutateTaskMetadata 重新读库 —— 早先这里用的是进 resume() 时的
      // task.metadata 快照, 而上面 drainPendingMessages 已经改过库了, 整块写回
      // 等于把刚排空的 pending_messages 又复活一次(接着被 maybeDrainStrandedMessages
      // 当成「还有留言」再 resume 一遍, 用户看到同一条消息被重放).
      try {
        mutateTaskMetadata(this.taskId, (meta) => {
          delete meta.compact_first;
        });
      } catch {}
    }

    // 功能: 双空兜底 —— 没有任何话要说时补一条「继续」, 保证 resume 后模型至少有
    //   一个 turn 可做.
    // 关注点: initialPrompt 只 fork 有值, preMessages 只驳回/留言有值, 所以普通
    //   pause->resume 两个都空 -> generator 一条不 yield -> SDK 连上了却干等,
    //   零 event 直到 壁钟超时(默认 30min, 可配) 判超时(实测: 关停跑 Bash 的任务再恢复,
    //   6min 零 event, 手动发消息才动). exitMaintenance 早就单独注入「继续」绕过
    //   这个坑, 手动 pause->resume 那条路没人管 —— 兜底放这里, 两条路一起覆盖.
    if (!initialPrompt && preMessages.length === 0) {
      preMessages = [ActiveSession.RESUME_NUDGE];
    }

    // Phase 2: normal resume with the continuation prompt
    const messageGenerator = this.createMessageGenerator(initialPrompt, preMessages);

    this.queryInstance = query({
      prompt: messageGenerator,
      options: {
        cwd: this.cwd,
        resume: task.session_id,
        model: this.resolvedConfig.model || process.env.ANTHROPIC_MODEL,
        // R175: 同凭证 fallback 模型列表 (SDK overloaded 时自动切, 每 turn 回试主模型)
        fallbackModel:
          this.resolvedConfig.fallback_models.length > 0
            ? this.resolvedConfig.fallback_models.join(",")
            : undefined,
        allowedTools,
        maxTurns: this.runOpts.max_turns ?? task.max_turns ?? 200,
        effort: (this.runOpts.effort ?? task.effort ?? "high") as "low" | "medium" | "high" | "xhigh" | "max",
        includePartialMessages: true,
        enableFileCheckpointing: true,
        canUseTool: this.createCanUseTool(),
        onUserDialog: this.createOnUserDialog(),
        supportedDialogKinds: ["ask_user_question"],
        // R3 runner 拦截改走 PreToolUse hook (见 createBashRunnerHook):
        //   canUseTool 对 Bash 不触发 (P5 实测 inner 0 次), hook 必触发.
        //   只拦 Bash (matcher=Bash), 其他工具不受影响; deploy-guard /
        //   process-kill 仍走 canUseTool 对 Write/Edit 等生效.
        hooks: { PreToolUse: [{ hooks: [this.createBashRunnerHook()] }] },
        mcpServers: {
          media: createMediaServer(this.buildMediaToolsContext()),
          // 🆕 R131 (damo 2026-09-15): review MCP server — refine/await_user/unawait
          //   三个工具, task_id 自动从 session 取. 同 ctx 复用同 server instance.
          review: createReviewServer(this.buildReviewToolsContext()),
        },
        env: await this.buildEnv(),
      },
    });

    try {
      await this.consumeMessages();
    } catch (err) {
      // R212: quota 快速失败优先 —— close() 后 for-await 可能以 throw 收尾
      //   (aborted / process exit 噪声), 按配额快速失败落终态 (api_error: 前缀 +
      //   原始错误文本进 result), 不让 abort 噪声文本进 error 字段.
      if (this.quotaFastFailError && !this.externallyTerminated) {
        this.writeQuotaFastFailTerminal();
      } else {
        console.error(`[ActiveSession] Error resuming session for task ${this.taskId}:`, err);
        this.emitEvent({
          type: "error",
          task_id: this.taskId,
          error: (err as Error).message || String(err),
        });
        // Ensure task is moved to failed state if consumeMessages threw
        const currentTask = getTaskById(this.taskId);
        if (currentTask && currentTask.status === "running") {
          updateTaskStatus(this.taskId, "failed", {
            error: (err as Error).message || String(err),
            completed_at: new Date().toISOString(),
          });
          this.emitEvent({
            type: "status_change",
            task_id: this.taskId,
            from: "running",
            to: "failed",
          });
        }
      }
    }
    // R212: for-await 正常收尾 (无 throw —— close 杀 subprocess 后静默结束) 时也
    //   要落 quota 终态: resume 无链循环, 同凭证不重试 (damo 2026-10-07), 换凭证
    //   交给上层重新 start/drain 流程. writeQuotaFastFailTerminal 幂等
    //   (status!==running 即 no-op), 与 catch 分支双写安全.
    if (this.quotaFastFailError && !this.externallyTerminated) {
      this.writeQuotaFastFailTerminal();
    }
  }

  // Interrupt the running query
  async interrupt(): Promise<void> {
    if (this.queryInstance) {
      await this.queryInstance.interrupt();
    }
  }

  // Capture git HEAD as head_commit. Called when a task ends (success,
// failure, or cancel) so subsequent forks can anchor to the right commit.
// Returns null silently when cwd isn't a git repo.
//
// R158 (damo 2026-09-26): head_commit 落库后立即跑 `git log base..head`
// 自动收集区间内未入 DB 的 commit (INSERT OR IGNORE, marker 声明的保留).
// 5 个 callsite 不动, 函数内追加. 自动收集失败 (cwd 非 git 仓 / 命令超时)
// 静默返回空数组, 不阻断 head_commit 落库.
  private recordHeadCommit(): void {
    const head = getCurrentGitHead(this.cwd);
    if (!head) return;
    // R228: 先读旧 head_commit 再更新 —— 它是上次 auto-collect 的终点锚,
    // 传给 autoCollectCommits 作 --since 增量下界 (先更新就拿不到了).
    let prevHead: string | null = null;
    try {
      prevHead = getTaskById(this.taskId)?.head_commit ?? null;
    } catch {
      /* 读不到就退 created_at 兜底 */
    }
    try {
      updateTask(this.taskId, { head_commit: head });
    } catch (err) {
      console.warn(`[ActiveSession] Failed to record head_commit for task ${this.taskId}:`, (err as Error).message);
    }
    this.autoCollectCommits(head, prevHead);
  }

  // R158: 自动收集 base..head 区间内未声明的 commit. 失败 (DB 取不到 base/
  // git log 抛错/超时) 全静默, 仅 console.warn 给运维看.
  private autoCollectCommits(head: string, prevHead: string | null): void {
    try {
      const task = getTaskById(this.taskId);
      const base = task?.base_commit;
      if (!base || base === head) return;
      // R228: since = 上次收集终点 (旧 head_commit 的提交时刻), 无则退
      // task 创建时刻. 不用本轮 started_at —— 多轮 resume 时上一轮收尾提交
      // 的 commit 会落在 started_at 之前被漏收; 旧 head_commit 时刻紧贴
      // 真实增量窗口, 且共享仓库里其他 task 在上次收集之后的 commit 也被
      // 排除 (先到先得兜底剩下的互认).
      // SQLite datetime('now') 是 UTC 无时区标记串, git --since 按本地时区
      // 解释会偏 8 小时 —— 无 TZ 标记时补 Z.
      let since = task?.created_at ?? null;
      if (since && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(since)) since = `${since}Z`;
      if (prevHead && prevHead !== head) {
        const prevTime = gitCommitTime(this.cwd, prevHead);
        if (prevTime) since = prevTime;
      }
      const inserted = backfillTaskCommits(this.taskId, this.cwd, base, head, {
        since,
      });
      if (inserted > 0) {
        console.log(`[ActiveSession] R158 auto-collected ${inserted} commit(s) for task ${this.taskId}`);
      }
    } catch (err) {
      console.warn(`[ActiveSession] Failed to auto-collect commits for task ${this.taskId}:`, (err as Error).message);
    }
  }

  // Capture git HEAD as base_commit. Called when a new task starts so
  // forks (if any) can anchor to "what the repo looked like when this task
  // first ran". Silent no-op when cwd isn't a git repo.
  private recordBaseCommit(): void {
    const head = getCurrentGitHead(this.cwd);
    if (!head) return;
    try {
      updateTask(this.taskId, { base_commit: head });
    } catch (err) {
      console.warn(`[ActiveSession] Failed to record base_commit for task ${this.taskId}:`, (err as Error).message);
    }
  }

  // Close the session
  async close(): Promise<void> {
    this.closed = true;
    // Resolve any pending message resolvers with null to unblock the generator
    for (const resolver of this.messageResolvers) {
      resolver(null);
    }
    this.messageResolvers = [];

    // Drain any in-flight user dialogs so the SDK promise doesn't hang after
    // the query closes (e.g. pause/cancel path). The UI also gets a
    // `user_dialog_response{cancelled:true}` event so it drops the widget.
    for (const [requestId, pending] of this.pendingUserDialogs) {
      if (pending.source === "onUserDialog") {
        pending.resolve({ behavior: "cancelled" });
      } else {
        pending.resolve({
          behavior: "deny",
          message: "Session closed while waiting for user input.",
          toolUseID: pending.toolUseId,
        });
      }
      this.emitEvent({
        type: "user_dialog_timeout",
        task_id: this.taskId,
        request_id: requestId,
        reason: this.closed ? "session_closed" : "task_cancelled",
      });
      this.emitEvent({
        type: "user_dialog_response",
        task_id: this.taskId,
        request_id: requestId,
        dialog_kind: pending.kind,
        cancelled: true,
      });
    }
    this.pendingUserDialogs.clear();

    // Snapshot git HEAD as head_commit whenever the session ends — covers
    // pause/cancel paths that don't go through the result message handler.
    // Safe to call repeatedly: updateTask only writes if the column differs
    // and head_commit is null on most tasks.
    this.recordHeadCommit();

    if (this.queryInstance) {
      this.queryInstance.close();
      this.queryInstance = null;
    }
  }

  getTaskId(): string {
    return this.taskId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getCwd(): string {
    return this.cwd;
  }

  // 功能: 暴露累计花费, 供 cancel/pause 路径在会话被打断时把部分花费落库.
  // 关注点: 这是流式过程中的「部分值」(handleMessage 在任意带 total_cost_usd
  //   的消息上都会更新它), 不是最终账单; interrupt()/close() 都不会重置它,
  //   所以 close() 之后读到的仍是打断那一刻的累计值。
  getCostUsd(): number {
    return this.costUsd;
  }

  // 功能: 累计一条消息里的 token usage. 任何形态的消息都试着读, 读不到就跳过.
  // 关注点: 各轮 usage 是「本轮」增量, 累加即全程用量; cache_read 单价远低于
  //   input, 分开存以便估算时按不同单价折算。
  private accumulateUsage(message: unknown): void {
    const m = message as any;
    const u = m?.usage || m?.message?.usage;
    if (!u) return;
    this.tokensIn += u.input_tokens || 0;
    this.tokensOut += u.output_tokens || 0;
    this.tokensCacheRead += u.cache_read_input_tokens || 0;
    this.tokensCacheWrite += u.cache_creation_input_tokens || 0;
  }

  // 功能: 返回打断那一刻能给出的最好花费数 + 它的来源标记.
  //   source='priced' = 本任务配置了 per-model 单价, 按累计 token × 配置单价折算
  //     (v519/R239). 优先级最高 —— SDK 的 total_cost_usd 对非 Anthropic 模型
  //     (Ark/glm 代理) 按 Anthropic 价目算, 配置价永远比它准.
  //   source='measured' = SDK 给的 total_cost_usd(权威账单, 未配价时仍是首选);
  //   source='estimated' = 拿不到账单, 用累计 token × 折中单价折算出来的.
  // 关注点: 🔴 调用方必须把 source 一起落库, 别让估算值假装实测值 —— 但更别
  //   因为拿不到实测值就留 NULL: NULL 会让丢账的那些天在用量面板上显示成
  //   「最便宜的天」, 比一个标着「估算」的数危险得多。
  //   估算恒 >0(哪怕 token 为 0 也给个极小值), 因为返回 0 会被上游的
  //   `cost > 0` 判据当成「没数据」而重新退回 NULL。
  getCostSnapshot(): { cost: number; source: "measured" | "estimated" | "priced" } {
    const priced = this.getPricedCost();
    if (priced != null) return { cost: priced, source: "priced" };
    if (this.costUsd > 0) return { cost: this.costUsd, source: "measured" };
    const est = estimateCostUsd({
      input: this.tokensIn,
      output: this.tokensOut,
      cacheRead: this.tokensCacheRead,
      cacheWrite: this.tokensCacheWrite,
    });
    return { cost: est, source: "estimated" };
  }

  // 功能: 按本任务解析出的 llm_config 单价折算累计 token; 未配价返 null.
  // 关注点: 每次调用现查 DB —— 管理员中途改价, 打断记账按新价走, 这是期望行为
  //   (改价只影响之后的记账, 不回溯历史行). 配置不存在/全空价 → null.
  private getPricedCost(): number | null {
    const prices = getLlmPrices(this.resolvedConfig?.source_config_id ?? null);
    if (!hasAnyPrice(prices)) return null;
    return estimateCostWithPrices(
      {
        input: this.tokensIn,
        output: this.tokensOut,
        cacheRead: this.tokensCacheRead,
        cacheWrite: this.tokensCacheWrite,
      },
      prices,
    );
  }

  // 功能: 暴露累计 token, 供估算与排查用.
  getTokenUsage(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    return {
      input: this.tokensIn,
      output: this.tokensOut,
      cacheRead: this.tokensCacheRead,
      cacheWrite: this.tokensCacheWrite,
    };
  }

  // Rewind files to a specific user message state
  async rewindFiles(userMessageId: string, dryRun?: boolean) {
    if (!this.queryInstance) {
      throw new Error("No active query instance for rewind");
    }
    return this.queryInstance.rewindFiles(userMessageId, { dryRun });
  }

  // ---- Private ----

  private async *createMessageGenerator(
    initialPrompt: string,
    preMessages: string[] = [],
  ): AsyncGenerator<SDKUserMessage> {
    // 每次 yield 前记为「未被响应」—— 模型一开口 consumeMessages 就清掉;
    // 若在此之前被 pause 打断, pauseTask 会把它回填进 pending_messages 补投.
    // Send initial prompt if provided
    if (initialPrompt) {
      this.unansweredUserTurn = initialPrompt;
      yield this.yieldUserMessage(initialPrompt);
    }
    // Drain messages queued via sendUserMessage while the task was paused.
    // Each becomes its own user turn so the model sees them as distinct
    // instructions rather than concatenated into one blob.
    for (const msg of preMessages) {
      this.unansweredUserTurn = msg;
      yield this.yieldUserMessage(msg);
    }

    // Wait for subsequent user messages. Drain any messages that arrived
    // before the generator started awaiting (queued via pushMessage).
    while (!this.closed) {
      if (this.pendingMessages.length > 0) {
        // R216 (damo 2026-10-08): live 连发的多条消息合并为一条投递 —— 不再
        //   逐条占 turn (每条一个独立 API 轮次, agent 逐条回答很慢). 空行连接
        //   保留各条边界, 模型当一份指令读. 与上方 preMessages 的「逐条投递」
        //   是有意差异: 那是 resume 场景停过任务攒下的指令 (历史语义, 不动).
        const merged = this.pendingMessages.splice(0).join("\n\n");
        this.unansweredUserTurn = merged;
        // R56 复发修复: 窗口内有插话 interrupt → 附纠正注记 (unansweredUserTurn
        // 保持纯消息文本, 不掺注记 -- pause 回填 / goal 评分口径不变).
        const note = this.wasRecentBargeIn() ? `${ActiveSession.BARGE_IN_CONTEXT_NOTE}\n\n` : "";
        yield this.yieldUserMessage(`${note}${merged}`);
        continue;
      }
      const msg = await this.waitForUserMessage();
      if (msg === null) break; // Session closed
      this.unansweredUserTurn = typeof msg.message.content === "string" ? msg.message.content : null;
      yield msg;
    }
  }

  private waitForUserMessage(): Promise<SDKUserMessage | null> {
    return new Promise((resolve) => {
      this.messageResolvers.push(resolve);
    });
  }

  // Scan a full assistant text block for <checkpoint step=... summary="...">
  // markers. For each marker, write a row into the checkpoints table,
  // emit a CheckpointEvent, and reset the current transcript slice so the
  // next checkpoint only captures deltas from here on. step is a string
  // tag (numeric or semantic, e.g. "final"); identical (task, step,
  // up_to_message_id) is collapsed to one row by the DB UNIQUE index —
  // see insertCheckpoint for the contract.
  private parseCheckpointsInBlock(blockText: string, assistantUuid: string): void {
    if (!blockText || !this.sessionId) return;
    const sessionId = this.sessionId!; // narrow to string for the closure
    // Reset the regex's lastIndex state since CHECKPOINT_RE is static.
    ActiveSession.CHECKPOINT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ActiveSession.CHECKPOINT_RE.exec(blockText)) !== null) {
      // R108 T4: 属性顺序无关解析. step 非法/缺失 → 整条 marker 丢弃;
      //   by/status 不合 charset → 该字段 null, UI 视作无细化归属/状态.
      const parsed = ActiveSession.parseCheckpointAttrs(match[1] || "");
      if (!parsed) continue;
      const { step, summary, by, status } = parsed;

      try {
        const row = insertCheckpoint({
          task_id: this.taskId,
          session_id: sessionId,
          step,
          summary,
          by,
          status,
          commit_id: getCurrentGitHead(this.cwd),
          transcript_slice: JSON.stringify(this.currentSlice),
          up_to_message_id: assistantUuid || null,
        });
        // Snapshot the slice we just persisted, then reset for the next
        // checkpoint. Resetting here (not after the marker text) keeps the
        // marker itself inside this checkpoint's slice.
        this.currentSlice = [];

        this.emitEvent({
          type: "checkpoint",
          task_id: this.taskId,
          session_id: sessionId,
          checkpoint_id: row.id,
          step,
          summary,
          by,
          status,
          commit_id: row.commit_id,
          up_to_message_id: row.up_to_message_id,
        });
        this.logEvent(
          "checkpoint",
          JSON.stringify({
            checkpoint_id: row.id,
            step,
            summary,
            by,
            status,
            commit_id: row.commit_id,
            up_to_message_id: row.up_to_message_id,
          }),
        );
      } catch (err) {
        console.warn(`[ActiveSession] Failed to insert checkpoint step=${step}:`, (err as Error).message);
      }
    }
  }

  // R113 (2026-09-07): 扫一个 assistant text block 收集所有 <git commit-id=... desc=...
  //   files=.../> marker, 每个 upsert 进 task_commits 表. 与 parseCheckpointsInBlock 同位置
  //   (扫整个 block text), 但不参与 checkpoint slice 重置 — git marker 是纯元数据,
  //   不该影响 transcript 切分. 重复 marker (同一 task+commit) → 覆盖 desc/files + bump
  //   created_at (跟 checkpoint 同款 upsert 语义, 但没 emit SSE event — git commit 不是
  //   任务状态节点, 不需要触发客户端 UI 闪烁).
  private parseGitCommitsInBlock(blockText: string): void {
    if (!blockText) return;
    ActiveSession.GIT_COMMIT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ActiveSession.GIT_COMMIT_RE.exec(blockText)) !== null) {
      const parsed = ActiveSession.parseGitCommitAttrs(match[1] || "");
      if (!parsed) continue;
      try {
        upsertTaskCommit({
          task_id: this.taskId,
          commit_id: parsed.commit_id,
          desc: parsed.desc,
          files: parsed.files,
        });
      } catch (err) {
        console.warn(
          `[ActiveSession] Failed to upsert task_commit id=${parsed.commit_id}:`,
          (err as Error).message,
        );
      }
    }
  }

  // v56+v61+R39: 扫一个 assistant text block 收集所有 awaiting marker. 多 marker
  //   允许 (g flag, all-of), 一个 result 可挂多个 (e.g. 一个 review + 一个 choice).
  //   老 <awaiting_review reason="..."/> 仍兼容 — 翻译成 {type:'review', desc:reason}
  //   推 pendingAwaitingMarkers, 旧 agent 不用改. 新形态 <awaiting type="..."
  //   desc="..." data='{...}'/> 走 AWAITING_MARKER_RE.
  //   解析结果存 this.pendingAwaitingMarkers (数组); running→reviewing 那笔
  //   status update 把数组 JSON.stringify 进 awaiting_markers TEXT 列.
  //   一次性消费: 落库后清空, 防 resume 后老 marker 复活.
  //   data 字段是 JSON 字面量 (写在 marker attribute 里), 这里用 try/catch 包
  //   JSON.parse, 解析失败存 null + console.warn (不让一个坏 marker 毒化整次 task).
  //   同 type 重复 marker 不去重 (damo 拍板: 不限制发挥空间, 重复就让 UI 自己渲染).
  // R129 Plan A: 新增 clear marker 处理 — 主动清空机制. 流程:
  //   1. 先扫 AWAITING_CLEAR_RE 拿到所有 clear 事件 (position + type|null).
  //   2. 应用 clear 到 pendingAwaitingMarkers: clear-all 直接清空数组, clear-type
  //      过滤掉同 type 的项. (前置 block 累积的 marker 视为 position=-∞, 任何
  //      本块 clear 事件都在它们之后发生, 一律受影响.)
  //   3. 扫 new/old marker 时, 若该 marker position 之后有匹配它的 clear 事件,
  //      则跳过 (此 marker 被「写完又被后续 clear 反悔」).
  //   4. section markers 不参与 document order (extractSectionMarkers 不暴露 position,
  //      且与 clear 共存场景罕见) — 按现有 dedup 走.
  private parseAwaitingMarkersInBlock(blockText: string): void {
    if (!blockText) return;
    // R129 Plan A: 第一步 — 收集 clear 事件.
    type ClearEvent = { pos: number; type: string | null };
    const clearEvents: ClearEvent[] = [];
    ActiveSession.AWAITING_CLEAR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ActiveSession.AWAITING_CLEAR_RE.exec(blockText)) !== null) {
      clearEvents.push({ pos: match.index, type: match[1] || null });
    }
    // R129: 应用 clear 到 pendingAwaitingMarkers (前序 block 累积的 marker 视为
    //   早于本块所有事件发生, 任何 clear 都能命中).
    for (const ce of clearEvents) {
      if (ce.type === null) {
        // clear-all: 直接清空.
        this.pendingAwaitingMarkers = [];
      } else {
        // clear-type: 过滤掉同 type.
        this.pendingAwaitingMarkers = this.pendingAwaitingMarkers.filter((m) => m.type !== ce.type);
      }
    }
    // R129: shouldSkip 谓词 — 给定 marker 位置 + type, 判断是否被本块后续 clear 反悔.
    //   clear 在 marker 之后 (ce.pos > pos) → marker 被清除.
    const shouldSkipMarker = (pos: number, type: string): boolean => {
      for (const ce of clearEvents) {
        if (ce.pos <= pos) continue;
        if (ce.type === null || ce.type === type) return true;
      }
      return false;
    };
    // 新形态: <awaiting type="..." desc="..." data='...'/>
    ActiveSession.AWAITING_MARKER_RE.lastIndex = 0;
    while ((match = ActiveSession.AWAITING_MARKER_RE.exec(blockText)) !== null) {
      if (shouldSkipMarker(match.index, match[1])) continue;
      const type = match[1];
      const desc = match[2] || null;
      let data: unknown = null;
      if (match[3]) {
        try {
          data = JSON.parse(match[3]);
        } catch (err) {
          console.warn(`[ActiveSession] awaiting marker data='${match[3]}' 解析失败, 存 null:`, (err as Error).message);
        }
      }
      const entry: {
        type: string;
        desc: string | null;
        data: unknown | null;
        decision_id?: string;
        question?: string;
        options?: Array<{ label: string; description?: string }>;
        recommended?: string;
        recommended_reason?: string;
      } = { type, desc, data };
      // R126 方案 A: type="decision" 时 server 端分配 decision_id + 提字段.
      //   data shape 校验: question (string), options (Array<{label, description?}>),
      //   recommended (string, ∈ options.label). 校验失败 → 降级为普通 marker
      //   (无 decision_id), 不让一个坏 decision 毒化整次 task.
      if (type === "decision" && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const question = typeof d.question === "string" ? d.question : null;
        const optsRaw = Array.isArray(d.options) ? d.options : null;
        const recommendedRaw = typeof d.recommended === "string" ? d.recommended : null;
        const recommendedReason = typeof d.recommended_reason === "string" ? d.recommended_reason : null;
        const optsClean: Array<{ label: string; description?: string }> = [];
        let valid = !!question && !!optsRaw;
        if (valid && optsRaw) {
          for (const o of optsRaw) {
            if (!o || typeof o !== "object") { valid = false; break; }
            const obj = o as Record<string, unknown>;
            const label = typeof obj.label === "string" ? obj.label : null;
            if (!label) { valid = false; break; }
            optsClean.push({
              label,
              description: typeof obj.description === "string" ? obj.description : undefined,
            });
          }
        }
        const recommendedValid = !!recommendedRaw && optsClean.some((o) => o.label === recommendedRaw);
        if (valid && recommendedValid) {
          entry.decision_id = crypto.randomUUID();
          entry.question = question!;
          entry.options = optsClean;
          entry.recommended = recommendedRaw!;
          entry.recommended_reason = recommendedReason || undefined;
        } else {
          console.warn(
            `[ActiveSession] awaiting decision data 校验失败 (question=${!!question} options=${!!optsRaw} recommended_valid=${recommendedValid}), 降级为普通 marker:`,
            data,
          );
        }
      }
      this.pendingAwaitingMarkers.push(entry);
    }
    // 老形态: <awaiting_review reason="..."/> → {type:'review', desc:reason}
    // 老形态里 type 固定为 'review', reason 转 desc 字段. 新旧形态允许共存 (老
    // agent 暂时发老 marker, 同时也想用新 marker 也行), 都进同一数组.
    ActiveSession.AWAITING_REVIEW_RE.lastIndex = 0;
    while ((match = ActiveSession.AWAITING_REVIEW_RE.exec(blockText)) !== null) {
      if (shouldSkipMarker(match.index, "review")) continue;
      this.pendingAwaitingMarkers.push({ type: "review", desc: match[1] || null, data: null });
    }
    // R128: 4-section 兜底 — 提取 section markers (XML 已落库 type 通过
    //   existingTypes 传入, 同 type 去重保留先到的). section marker 不参与
    //   R129 clear doc-order 处理 (extractSectionMarkers 不暴露 position, 且
    //   section + clear 共存是边缘场景 — agent 写 XML 优先, section 是兜底).
    const existingTypes = new Set(this.pendingAwaitingMarkers.map((m) => m.type));
    for (const sm of ActiveSession.extractSectionMarkers(blockText)) {
      if (existingTypes.has(sm.type)) continue;
      this.pendingAwaitingMarkers.push({ type: sm.type, desc: sm.desc, data: null });
      existingTypes.add(sm.type);
    }
  }

  // R129 Plan B: 纯函数 — 决定 running→reviewing 时 awaiting_markers 列的写入值.
  //   三态: string=新 JSON, null=显式清空 (R129 Plan B 新增), undefined=不动.
  //   逻辑:
  //     - pendingAwaitingMarkers 非空 (hasMarkers=true) → 写新 JSON.
  //     - pendingAwaitingMarkers 为空 + DB 旧值非空 → 显式传 null 清空 (兜底防滞留).
  //     - pendingAwaitingMarkers 为空 + DB 旧值已 null → 不写 (UPDATE 跳过, 保持 DB 干净).
  //   抽出成 static 方便单测 — 内联逻辑在 consumeMessages 跑得通但不易触发.
  static computeAwaitingMarkersWriteValue(
    hasMarkers: boolean,
    pendingMarkersJson: string | null,
    dbOldValue: string | null,
  ): string | null | undefined {
    if (hasMarkers) return pendingMarkersJson;
    if (dbOldValue !== null) return null; // R129 Plan B 兜底清空.
    return undefined; // 不动 — DB 已干净, UPDATE 跳过此列.
  }

  // R128: 纯函数 — 扫 ## <header>\n<body> 结构, 把映射表里的状态型 header 转
  //   awaiting marker. XML marker 优先 (传入 existingTypes 同 type 去重). body
  //   含"拍板/审批/决策"语义升级 review, 覆盖映射默认值. desc 超 1024 字符截断.
  //   抽出成 static 方法方便单测 (parseAwaitingMarkersInBlock 是 private, 直接
  //   测要走 ActiveSession 实例化 + mock SDK 太重).
  static extractSectionMarkers(blockText: string): Array<{ type: string; desc: string }> {
    if (!blockText) return [];
    const out: Array<{ type: string; desc: string }> = [];
    const seen = new Set<string>();
    ActiveSession.SECTION_HEADERS_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ActiveSession.SECTION_HEADERS_RE.exec(blockText)) !== null) {
      const rawHeader = match[1].trim().toLowerCase();
      // 容忍标题尾部标点: ?？！!.,;: 等
      const cleanHeader = rawHeader.replace(/[？?!！.,;:：]+$/g, "").trim();
      const mappedType = ActiveSession.SECTION_TYPE_MAP[cleanHeader];
      if (!mappedType) continue; // 命中非状态型 header (## 结论 / 流程 / 错误 / 下一步 等) → 跳过
      // 同 raw type 已落库 → 跳过 (R128 §不变量: 同 raw type 去重, 保留先到的).
      //   注意: 用 raw type 而非升级后的 type 去重, 避免 ## 等什么 + 拍板 / ##
      //   卡在哪 + 决策 两个不同 raw type (waiting_reply / stuck) 都被升级为
      //   review 后互吃. 两个 section 表达不同 concern, 都应保留.
      if (seen.has(mappedType)) continue;
      seen.add(mappedType);
      const body = match[2].trim();
      if (!body) continue; // 空段跳过 (R128 §不变量: 节内无内容不落 marker)
      // 语义升级: body 含"拍板/审批/决策" → review (覆盖映射默认值, 不影响去重)
      const type = /拍板|决策|审批/.test(body) ? "review" : mappedType;
      // desc = 节内文本, 截断 1024 字符 + "…" 后缀
      const desc = body.length > 1024 ? body.slice(0, 1024) + "…" : body;
      out.push({ type, desc });
    }
    return out;
  }

  // 功能: R227 (修订 R212) — 从 system api_retry/api_error 消息提取 429/配额类
  //   信号, 命中返回 { text, kind }: kind=quota_exhausted (额度耗尽, 重试无用,
  //   首次命中即快速失败换链) / rate_limit (HTTP 429 限流, 瞬时, 允许 SDK 退避
  //   重试最多 5 次). 非配额类返回 null (保留 SDK 默认重试, 行为不变).
  // 关注点: 判定优先级 —— 额度耗尽关键词 (AccountQuotaExceeded / usage quota)
  //   优先于 429 状态码 (ark 月配额 429 实录 6af660e4: 状态码 429 但文本是月
  //   配额用完, 重试 10 次也没用, 必须归 exhausted); rate_limit 判据 = HTTP 429
  //   (api_retry.error_status / api_error.error.status) 或 error 枚举为
  //   'rate_limit' 且无数字状态 (Anthropic 语义 rate_limit 即 429 族).
  //   overloaded / 5xx / 网络 / 鉴权 → null, 不快速失败.
  static extractQuotaSignal(sysMsg: {
    error_status?: number | null;
    error?: { status?: number; formatted?: string; message?: string } | string;
  }): { text: string; kind: "rate_limit" | "quota_exhausted" } | null {
    const status =
      typeof sysMsg?.error_status === "number"
        ? sysMsg.error_status
        : typeof (sysMsg?.error as { status?: number })?.status === "number"
          ? (sysMsg.error as { status: number }).status
          : null;
    const enumErr =
      typeof sysMsg?.error === "string" ? sysMsg.error : undefined;
    const formatted = (sysMsg?.error as { formatted?: string })?.formatted;
    const message = (sysMsg?.error as { message?: string })?.message;
    const text = [formatted, message]
      .filter((s): s is string => typeof s === "string")
      .join(" ");
    const asText =
      formatted || message || `API Error: HTTP ${status ?? 429}${enumErr ? ` (${enumErr})` : ""}`;
    if (/AccountQuotaExceeded|usage quota/i.test(text)) {
      return { text: asText, kind: "quota_exhausted" };
    }
    if (status === 429) {
      return { text: asText, kind: "rate_limit" };
    }
    if (status === null && enumErr === "rate_limit") {
      return {
        text: `API Error: rate limit (429-class, ${enumErr})`,
        kind: "rate_limit",
      };
    }
    return null;
  }

  private async consumeMessages(): Promise<void> {
    if (!this.queryInstance) return;

    let resultText = "";
    let structuredOutput: string | null = null;

    for await (const message of this.queryInstance) {
      // pause/cancel 后 drop 缓冲消息. SDK Query.close() 只 end stdin, subprocess
      // 在 sleep/bash 等长 tool 完成前还能 emit 消息; 不 drop 的话会继续向 SSE 推
      // 内容并写库 (assistant_message / tool_use 等). cost token 等仍可累计, 因为
      // 它们对账有价值且不会改 status. flag 由 pauseTask/cancelTask 在 interrupt()
      // 之前同步置位, 一旦设置就锁死不重置.
      if (this.externallyTerminated && message.type !== "result") {
        continue;
      }
      // 模型开口了 -> 这一轮的用户消息不再算「未被响应」, pause 时不补投, 避免
      // resume 重发指令让 agent 把已经做过的活重做一遍. 两种形态都要认:
      // includePartialMessages 下文本走 stream_event, finalized assistant 内容恒空.
      if (message.type === "assistant" || (message as { type: string }).type === "stream_event") {
        this.unansweredUserTurn = null;
      }
      // Handle different message types
      // R132: SDK 0.3.220 task_* 系统消息分支 (R132 plan §3.1). 老代码一律吞掉
      //   (consumeMessages 默认 case), 现按 subtype 维护 inFlightSubagentIds Set.
      //   - task_started → add + 反查表 + 写 events
      //   - task_notification → delete + 写 events (status + summary + usage)
      //   - task_updated → 仅更新时间戳 (status=running 仍 in-flight, 不动 Set)
      //   - task_progress → 仅更新时间戳 (高频, 不写 events 避免 noise)
      //   - background_tasks_changed → REPLACE 语义 (sdk.d.ts 全量对账),
      //     只保留 subagent/bash 类型, ambient / housekeeping 任务 (skip_transcript)
      //     不计入, 防止被 drain 卡住.
      if (message.type === "system") {
        const sysMsg = message as any;
        const subtype = sysMsg.subtype;
        if (subtype === "task_started") {
          // skip_transcript 的 ambient 任务 (housekeeping / monitor) 不计入 in-flight.
          const skipTranscript = sysMsg.skip_transcript === true;
          const taskType: string | undefined = sysMsg.task_type;
          if (!skipTranscript && taskType && ActiveSession.BG_AGENT_TASK_TYPES.has(taskType)) {
            const taskId = String(sysMsg.task_id);
            const toolUseId = String(sysMsg.tool_use_id ?? "");
            this.inFlightSubagentIds.add(taskId);
            if (toolUseId) this.taskIdToToolUseId.set(taskId, toolUseId);
          }
          this.lastBgTaskSummaryAt = Date.now();
          this.logEvent(
            "task_started",
            JSON.stringify({
              task_id: sysMsg.task_id,
              tool_use_id: sysMsg.tool_use_id ?? null,
              subagent_type: sysMsg.subagent_type ?? null,
              task_type: sysMsg.task_type ?? null,
              description: sysMsg.description ?? null,
              skip_transcript: skipTranscript,
            }),
          );
        } else if (subtype === "task_notification") {
          // 无论 skip_transcript / status, 都从 Set 里 delete (防御 task_started 被吞
          //   的极端情况, 至少保证 notification 走完 Set 被清).
          const taskId = String(sysMsg.task_id);
          this.inFlightSubagentIds.delete(taskId);
          this.taskIdToToolUseId.delete(taskId);
          this.lastBgTaskSummaryAt = Date.now();
          this.logEvent(
            "task_notification",
            JSON.stringify({
              task_id: sysMsg.task_id,
              tool_use_id: sysMsg.tool_use_id ?? null,
              status: sysMsg.status ?? null,
              summary: sysMsg.summary ?? null,
              output_file: sysMsg.output_file ?? null,
              usage: sysMsg.usage ?? null,
            }),
          );
        } else if (subtype === "task_updated") {
          // patch.status=running 仍 in-flight (不动 Set); patch.is_backgrounded=true
          //   表示模型已把前景切后台, 我们在 task_started 阶段已 add, 无需再 add.
          this.lastBgTaskSummaryAt = Date.now();
        } else if (subtype === "task_progress") {
          // 高频事件, 只更新心跳, 不写 events (避免 noise 淹没 UI).
          this.lastBgTaskSummaryAt = Date.now();
        } else if (subtype === "background_tasks_changed") {
          // REPLACE 语义: 用 msg.tasks 全量重建 Set. 老任务若不在列表 → 删除
          //   (可能已完成但 notification 丢了); 新任务若不在 Set → 添加 (notification
          //   漏了但确实在跑). 只保留 subagent/bash 类型.
          const tasks: Array<{ task_id: string; task_type?: string }> = Array.isArray(
            sysMsg.tasks,
          )
            ? sysMsg.tasks
            : [];
          const next = new Set<string>();
          for (const t of tasks) {
            if (!t.task_id) continue;
            const tt = t.task_type ?? "";
            if (tt && ActiveSession.BG_AGENT_TASK_TYPES.has(tt)) {
              next.add(t.task_id);
            }
          }
          // 保留 taskIdToToolUseId 中仍然存在的反查 (避免误删); 不在新 Set 里的 task_id
          //   视为已结束, 一并清掉反查.
          for (const tid of [...this.taskIdToToolUseId.keys()]) {
            if (!next.has(tid)) this.taskIdToToolUseId.delete(tid);
          }
          this.inFlightSubagentIds = next;
          this.lastBgTaskSummaryAt = Date.now();
          this.logEvent(
            "background_tasks_changed",
            JSON.stringify({ count: tasks.length, in_flight: next.size }),
          );
        } else if (subtype === "api_retry" || subtype === "api_error") {
          // R212 (damo 2026-10-07 拍板「同一个凭证不重试」) + R227 (2026-10-09
          //   修订口径「429 允许重试 5 次」): 429/配额类 API 错误按类型分档.
          //   背景 task 6af660e4 实录: ark 月配额 429, SDK 对同一凭证退避重试
          //   10 次耗时 ~3min (jsonl 10 条 subtype=api_error 行) 才以 synthetic
          //   消息收尾, 期间任务干等 —— 这是 quota_exhausted 首次命中即 close
          //   的依据 (额度没了, 重试无用, 由 start()/resume() 的 quota 分支
          //   接管换链); 但纯限流 (rate_limit) 是瞬时的, 等一等就能过, R212
          //   一刀切导致可恢复的任务被过早换链, R227 改为放行 SDK 退避重试
          //   最多 5 次, 第 6 条信号才 close 快速失败. 流内两种形态都认:
          //   - api_retry: SDK 官方重试通知 (sdk.d.ts SDKAPIRetryMessage,
          //     error_status 带数字 + error 为枚举串)
          //   - api_error: transcript 重试行被部分 CLI 直接转发 (error 为对象,
          //     error.status 带数字)
          if (this.quotaFastFailError === null && !this.externallyTerminated) {
            const signal = ActiveSession.extractQuotaSignal(sysMsg);
            if (signal) {
              if (
                signal.kind === "rate_limit" &&
                this.rateLimitRetryCount < 5
              ) {
                // R227: 前 5 条限流信号放行, SDK 继续自带退避重试.
                this.rateLimitRetryCount++;
                this.logEvent(
                  "api_error_rate_limit_retry",
                  JSON.stringify({
                    subtype,
                    attempt_no: this.rateLimitRetryCount,
                    signal: signal.text.slice(0, 300),
                  }),
                );
              } else {
                // quota_exhausted 首次命中, 或 rate_limit 已重试满 5 次.
                this.quotaFastFailError = signal.text;
                this.logEvent(
                  "api_error_quota_fast_fail",
                  JSON.stringify({
                    subtype,
                    kind: signal.kind,
                    rate_limit_retries: this.rateLimitRetryCount,
                    signal: signal.text.slice(0, 300),
                  }),
                );
                console.warn(
                  `[ActiveSession] ${signal.kind === "quota_exhausted" ? "Quota-exhausted" : "Rate-limit (retries exhausted)"} API error on task ${this.taskId}, fast-failing without same-credential retry`,
                );
                // 杀 subprocess 让 for-await 立即结束. 不置 this.closed /
                //   externallyTerminated —— session 生命周期仍由 attempt 循环收尾
                //   (换凭证重跑时还要起新 query).
                try {
                  this.queryInstance?.close();
                } catch {
                  // close 失败不阻断: for-await 最迟在 SDK 重试耗尽后自然收尾.
                }
              }
            }
          }
        }
        // 其他 system subtype (init / etc.) 沿用原默认吞掉, 不需特殊处理.
        // 继续下一轮 for-await (不计入 usage 累加 —— accumulateUsage 在 loop 末尾对
        //   任何 message 形状都会执行, 含 system 消息里的 usage 字段, 这是想要的).
      } else if (message.type === "assistant") {
        // Full assistant message
        const msg = message as any;
        // Capture session_id BEFORE parsing checkpoints — the parser
        // requires sessionId to be set, but the assistant text block is
        // processed before msg.session_id is normally assigned below.
        if (msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id;
          updateTask(this.taskId, { session_id: msg.session_id });
        }

        // Persist the sessions row the first time we observe a session_id.
        // Idempotent via sessionRowCreated. We do this inside the assistant
        // branch because that's where msg.session_id reliably arrives.
        if (msg.session_id && !this.sessionRowCreated) {
          const sid = this.sessionId!;
          try {
            createSession({
              id: sid,
              task_id: this.taskId,
              cwd: this.cwd,
              title: this.taskTitle,
            });
            this.sessionRowCreated = true;
          } catch (err) {
            if (!String((err as Error).message).includes("UNIQUE")) {
              console.warn(`[ActiveSession] Failed to create session row for task ${this.taskId}:`, (err as Error).message);
            } else {
              this.sessionRowCreated = true;
            }
          }
        }

        // includePartialMessages mode often arrives with empty msg.content —
        // the real text was already streamed via content_block_delta
        // stream_events and accumulated in turnTextBuffer. Synthesize a
        // text block from the buffer when content is missing.
        let blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
        if (blocks.length === 0 && this.turnTextBuffer) {
          blocks = [{ type: "text", text: this.turnTextBuffer }];
        }

        // Reset turn text buffer for the next turn. Streaming tool-use
        // state (streamingToolUseIds / streamingToolUseUpdated) is cleared
        // after the block loop below so the has()/updated checks can still
        // see this turn's tool ids.
        this.turnTextBuffer = "";

        // R182: 识别 SDK 的 synthetic API 错误消息. 429 限流 / 鉴权失败等 API 层
        //   错误不走 result 的 error subtype, 而是以 model="<synthetic>" 的
        //   assistant 消息 + success result 收尾 (resultText 即错误文本). 这里
        //   打标, result 收尾分支据此翻 failed. 正常 (非 synthetic) 消息到达
        //   即清标 —— 同一 session 后续轮次成功时不会被上一轮的报错误伤.
        //   🔴 model 在 msg.message.model (SDKAssistantMessage wraps BetaMessage,
        //   sdk.d.ts:2854), 不在顶层 —— 实测只读 msg.model 永远 undefined,
        //   检测全空转 (2026-10-04 首版翻车点). msg.error (SDKAssistantMessageError,
        //   如 'rate_limit'/'authentication_failed') 是更权威的信号, 与文本前缀
        //   ("API Error" / "Failed to authenticate" 两种实测形态) 三者任一命中
        //   且 model 是 synthetic 即算 API 错误.
        {
          const inner = (msg.message ?? {}) as { model?: string; content?: unknown };
          const synth = inner.model === "<synthetic>" || msg.model === "<synthetic>";
          // 文本优先取 blocks (顶层 content / turnTextBuffer 合成), 空则回退嵌套的
          //   message.content (BetaMessage 的正文在里层, 部分场景顶层不重复带).
          const blockText =
            (blocks.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "";
          const innerContent = Array.isArray(inner.content) ? inner.content : [];
          const innerText =
            (innerContent.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "";
          const firstText = (blockText || innerText).trim();
          const looksLikeApiError =
            firstText.startsWith("API Error") ||
            firstText.startsWith("Failed to authenticate") ||
            typeof msg.error === "string";
          // R212: 实质产出 = 非空文本块或 tool_use 块. includePartialMessages 下
          //   finalized assistant 常是零 content 空壳 (真文本走 stream_event, 已
          //   由 turnTextBuffer 合成进 blocks; 纯 tool_use 轮由流式分支计数),
          //   空壳不算产出. SDK canned no-op 应答 ("No response requested.")
          //   同样不算 —— 它是非空文本但零信息, 算产出会挡住 R212 的零进度
          //   换链判据 (218c47dc 实录, 见 NOOP_REPLY_RE 注释).
          const hasSubstantiveOutput = blocks.some(
            (b) =>
              (b.type === "text" &&
                !ActiveSession.NOOP_REPLY_RE.test(
                  ((b as { text?: string }).text ?? "").trim(),
                )) ||
              b.type === "tool_use",
          );
          if (synth && looksLikeApiError) {
            this.syntheticApiErrorText = firstText || `api error (${msg.error})`;
          } else if (hasSubstantiveOutput) {
            // R212 (damo 2026-10-07「error-only turn 判 failed」): 只有实质产出
            //   (非空文本 / tool_use) 才清 synthetic 错误标 + 记 attempt 进度.
            //   空壳消息不清 —— 否则「synthetic 错误 + 空壳消息 + success」的
            //   零产出 turn 被洗成正常 reviewing, llm_fallback 链形同虚设.
            this.syntheticApiErrorText = null;
            // 实质产出到达 = 本 attempt 有真实输出 (catch 路径零进度判据, 见字段注释)
            this.attemptHadModelOutput = true;
          }
          // 其余 (synthetic 非错误形态 / 无实质内容的空壳) 不动标, 保持原判.
        }

        for (const block of blocks) {
          if (block.type === "text") {
            resultText += block.text;
            this.emitEvent({
              type: "assistant_message",
              task_id: this.taskId,
              text: block.text,
              uuid: msg.uuid || "",
            });
            this.logEvent("message", JSON.stringify({ role: "assistant", text: block.text, timestamp: Date.now() }));

            // Track for checkpoint slice. We push AFTER the live emit so
            // downstream consumers see the message event first.
            this.currentSlice.push({
              role: "assistant",
              text: block.text,
              uuid: msg.uuid || "",
            });

            // Parse <checkpoint step=N summary="..."> markers. We do this
            // on the full block text (not stream deltas) so we never have
            // to handle markers split across token boundaries.
            this.parseCheckpointsInBlock(block.text, msg.uuid || "");
            // R113: 扫描 <git commit-id="..."/> marker, upsert 进 task_commits 表.
            //   与 checkpoint 解析同位置 (扫整个 block text), 但不参与 slice 重置.
            this.parseGitCommitsInBlock(block.text);
            // v56+v61: 扫描 <awaiting .../> + 老 <awaiting_review/> marker. 多 marker
            // 允许 (g flag, all-of). 在 status transition 那里消费.
            this.parseAwaitingMarkersInBlock(block.text);
          } else if (block.type === "tool_use") {
            // AskUserQuestion is rendered as a structured user dialog by the
            // `onUserDialog` path. Skip the generic tool_use event so the
            // collapsed "AskUserQuestion({...})" card doesn't double-render
            // next to the live dialog widget — but keep it in the checkpoint
            // slice so the transcript still has the question for forks.
            if (block.name === "AskUserQuestion") {
              this.logEvent("tool_use", JSON.stringify({ name: block.name, input: block.input }));
              this.currentSlice.push({
                role: "tool_use",
                text: `AskUserQuestion(${JSON.stringify(block.input).slice(0, 200)})`,
                uuid: block.id || "",
              });
            } else if (this.streamingToolUseIds.has(block.id || "") || this.streamingToolUseUpdated.has(block.id || "")) {
              // Streaming path: content_block_start already emitted the
              // tool_use card with an empty placeholder, and content_block_stop
              // normally emitted a tool_use_update with the complete input
              // (and persisted it). If so, skip the duplicate emit/logEvent
              // and only record the checkpoint slice. If content_block_stop
              // was missed (e.g. a partial message arriving before stop),
              // emit the update now as a fallback.
              if (!this.streamingToolUseUpdated.has(block.id || "")) {
                this.emitEvent({
                  type: "tool_use_update",
                  task_id: this.taskId,
                  tool_name: block.name,
                  tool_input: block.input,
                  uuid: block.id || "",
                });
                this.logEvent("tool_use", JSON.stringify({ name: block.name, input: block.input }));
              }
              this.currentSlice.push({
                role: "tool_use",
                text: `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`,
                uuid: block.id || "",
              });
              this.streamingToolUseIds.delete(block.id || "");
              this.streamingToolUseUpdated.delete(block.id || "");
            } else {
              this.emitEvent({
                type: "tool_use",
                task_id: this.taskId,
                tool_name: block.name,
                tool_input: block.input,
                uuid: block.id || "",
              });
              this.logEvent("tool_use", JSON.stringify({ name: block.name, input: block.input }));
              this.currentSlice.push({
                role: "tool_use",
                text: `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`,
                uuid: block.id || "",
              });
            }
          }
        }

        // Reset streaming tool-use state for the next turn. Done after the
        // block loop so the has()/updated checks above can still resolve
        // this turn's tool ids.
        this.streamingToolUseIds.clear();
        this.streamingToolUseUpdated.clear();

      } else if (message.type === "result") {
        // Final result
        const result = message as any;
        // R216: turn 结束 (无论正常/被打断), 插话判据复位
        this.turnActive = false;
        this.sessionId = result.session_id || this.sessionId;
        this.costUsd = result.total_cost_usd || this.costUsd;
        // 记账来源标记. 配置了 per-model 单价 = priced 优先 (v519/R239: SDK 的
        //   total_cost_usd 对非 Anthropic 模型按 Anthropic 价目算, 配置价更准).
        // 没配价走到 result 说明 SDK 给了账单 = 实测; 万一 result 没带
        // total_cost_usd 且流式过程也没带过(实测存在这种消息形态), 就退回按
        // 累计 token 估算 —— 宁可落一个标注为估算的数, 也不给用量面板留 NULL。
        if (this.getPricedCost() != null) {
          this.costUsd = this.getPricedCost()!;
          mutateTaskMetadata(this.taskId, (meta) => {
            meta.cost_source = "priced";
            meta.cost_tokens = this.getTokenUsage();
          });
        } else if (this.costUsd > 0) {
          mutateTaskMetadata(this.taskId, (meta) => {
            meta.cost_source = "measured";
            delete meta.cost_tokens;
          });
        } else {
          const est = this.getCostSnapshot();
          this.costUsd = est.cost;
          mutateTaskMetadata(this.taskId, (meta) => {
            meta.cost_source = "estimated";
            meta.cost_tokens = this.getTokenUsage();
          });
        }

        if (result.structured_output) {
          structuredOutput = JSON.stringify(result.structured_output);
        }

        // R216 插话打断收尾防护: 我们刚为投递用户消息 interrupt 过当前 turn,
        //   被打断 turn 以 error_during_execution result 收尾. 这是插话的正常
        //   结束, 不是任务失败 → 吞掉这条 result, 让 generator 续跑 (排空队列
        //   或处理 CLI still_queued 的插话消息). 判据收窄见 shouldSwallowBargeInResult.
        //   两种窗口形态都复位 flag: 命中 = 已消费; 未命中 = 过窗/非打断错误,
        //   清掉防止后续真实失败被误吞.
        if (this.shouldSwallowBargeInResult(result.subtype)) {
          this.messageInterruptAt = null;
          this.logEvent(
            "barge_in_result_swallowed",
            JSON.stringify({ pending: this.pendingMessages.length }),
          );
          resultText = "";
          structuredOutput = null;
          continue;
        }
        this.messageInterruptAt = null;

        // 状态守卫: 覆盖外部已写入的 status. recoverOrphanedTasks (server_restart)、
        // pauseTask、cancelTask 都可能把 task.status 从 running 改成 paused/
        // cancelled/failed. SDK subprocess 在这些写入之后还能 emit result (因为
        // close() 只 end stdin, 不杀阻塞中的 tool). 不查 status 直接写 reviewing
        // 等于静默覆盖——用户点暂停后看到状态又回 reviewing (实测 task e43eeb0d
        // 反复出现). result 是 subprocess 的最后一条消息, 这里直接 break 让 for-await
        // 退出, 不再处理后续事件.
        //
        // 只拦「外部已结束」的状态集 (paused/cancelled/failed), 不拦 pending/queued
        // (scheduler 还没翻状态, 测试也常见). reviewing/completed/rejected 是
        // 终态, 也不会被这条路径触发 (consumeMessages 处理完 result 就退出).
        const liveTask = getTaskById(this.taskId);
        const liveStatus = liveTask?.status;
        const externallyDecided = liveStatus === "paused" || liveStatus === "cancelled" || liveStatus === "failed";
        if (liveTask && externallyDecided) {
          this.logEvent(
            "warning",
            JSON.stringify({
              kind: "result_after_status_change",
              current_status: liveStatus,
            }),
          );
          this.logEvent("cost", JSON.stringify({ cost_usd: this.costUsd }));
          if (this.sessionId) updateSessionCost(this.sessionId, this.costUsd);
          this.closed = true;
          for (const resolver of this.messageResolvers) resolver(null);
          this.messageResolvers = [];
          break;
        }

        // R182: SDK 在 API 层错误 (429 / 鉴权) 时 result subtype 仍是 success,
        //   错误以 synthetic assistant 消息到达 (consumeMessages 已打标
        //   syntheticApiErrorText). 命中时走 failed 分支, 不进 reviewing —
        //   否则零消耗的报错任务伪装成正常待审 + 触发 auto-rename 把标题
        //   改写成错误文本截断.
        if (result.subtype === "success" && !this.syntheticApiErrorText) {
          // 功能: resume bootstrap 空转伪 result 守卫 —— resume 注入消息到达 CLI 时若
          //   初始化未完成, CLI 会先回一条 synthetic "No response requested." 伪轮
          //   (num_turns=0, 零 API 轮) + success result, 紧接着才把排队的真消息作为
          //   新一轮跑. 若把伪 result 当正常收尾 (写 reviewing + closed=true), 真轮
          //   会在 query teardown 中途跑 → 其工具调用被 CLI 以 abort canned 文本拒绝
          //   ("The user doesn't want to take this action right now", 二进制内
          //   toolDenialKind=cancelled 路径), 弱模型 (glm-5.3-flash 实测 task
          //   cee8c410, 2026-11-05) 把拒绝读成「用户叫停」→「收到，我停下」+ end_turn,
          //   任务原地进 reviewing 等人工. 命中 num_turns=0 → 视为 bootstrap 噪声,
          //   不写状态不关 session, 继续消费真轮的 result (与下面 pendingMessages
          //   保活同款 continue 模式).
          // 关注点: num_turns 缺失/undefined 按 >0 处理 (保守不吞, 只吞确凿的 0);
          //   吞掉后若 CLI 再无输出, iterator 自然结束或 task timeout 兜底, 不会
          //   永久 running (降级 = 现有挂死同款, 超时 auto-pause 可恢复).
          if (result.num_turns === 0) {
            this.logEvent(
              "warning",
              JSON.stringify({
                kind: "bootstrap_result_swallowed",
                num_turns: result.num_turns,
                result_text_head: String(result.result || "").slice(0, 120),
              }),
            );
            resultText = "";
            structuredOutput = null;
            continue;
          }
          // 功能: 成功结果且 pendingMessages 非空时不关闭 session, 让 generator 排空队列,
          //       SDK 会把每条遗留消息作为新一轮处理并写入 JSONL.
          // 关注点: 用户在 SDK 生成回复期间连发消息时, pushMessage 因无 resolver 把消息
          //   塞进 pendingMessages 内存队列. 若此处直接关闭(closed=true), generator 的
          //   while(!closed) 退出, 队列永远不会被排空 -> 消息只进 DB events 不进 SDK
          //   JSONL -> getSessionHistory 合并时被追加到末尾 -> 刷新后顺序错乱.
          if (this.pendingMessages.length > 0) {
            this.logEvent("cost", JSON.stringify({ cost_usd: this.costUsd }));
            if (this.sessionId) updateSessionCost(this.sessionId, this.costUsd);
            resultText = "";
            structuredOutput = null;
            continue;
          }

          // Snapshot context-window usage before the session closes so the
          // reviewing-state UI can show how full the context was - informs
          // the "keep this session or fork/compress" decision. Best-effort:
          // getContextUsage() may throw if the session is tearing down; fall
          // back to result.usage.input_tokens (last request's input size, a
          // close proxy for context size).
          let contextTokens: number | null = null;
          let contextMax: number | null = null;
          try {
            if (this.queryInstance?.getContextUsage) {
              const cu = await this.queryInstance.getContextUsage();
              contextTokens = cu.totalTokens ?? null;
              contextMax = cu.maxTokens ?? null;
            }
          } catch (err) {
            console.warn(`[ActiveSession] getContextUsage failed for ${this.taskId}:`, (err as Error).message);
          }
          if (contextTokens == null && result.usage?.input_tokens) {
            contextTokens = result.usage.input_tokens;
          }

          // 关注点: 上面的 await getContextUsage() 让出过事件循环, 用户可能
          //   在此期间发消息 (pushMessage -> pendingMessages 内存队列). 1323
          //   的检查已过, 若不复检, 消息会随 closed=true 永远留在内存队列,
          //   不进 SDK JSONL 只进 DB events -> getSessionHistory 追加到末尾
          //   -> 刷新后顺序错乱 + agent 未处理. 复检命中则同 1323 排空.
          if (this.pendingMessages.length > 0) {
            this.logEvent("cost", JSON.stringify({ cost_usd: this.costUsd }));
            if (this.sessionId) updateSessionCost(this.sessionId, this.costUsd);
            resultText = "";
            structuredOutput = null;
            continue;
          }

          // 功能: 本轮派了后台 subagent 却直接收尾时, 注入纠正指令续跑而不关 session.
          // 关注点: R132 (damo 2026-09-07 拍板). 复用上面 pendingMessages 的 continue
          //   机制(不置 closed -> generator 继续供料 -> SDK 把注入消息当新一轮).
          //   触发条件改为「spawns > 0 但 in-flight 空」 — 表示 SDK 已把 task_started /
          //   task_notification 都报完(content_block_stop 计数已发生但 SDK 报告 subagent
          //   已收尾), 模型依然想结束 → nudge 提示「你派了 subagent, 确认收尾了吗?」
          //   反之 in-flight 非空 = SDK 报告有 subagent 还在跑 → 不 nudge, 直接走下面
          //   drain + stopTask 路径等 SDK 自己收尾. 这样新老 SDK 都覆盖: 老 SDK 没
          //   task_* 信号走 spawns+nudge; 新 SDK 走 in-flight+drain+stopTask.
          if (
            this.bgAgentSpawns > 0 &&
            this.inFlightSubagentIds.size === 0 &&
            this.bgAgentNudges < ActiveSession.MAX_BG_AGENT_NUDGES
          ) {
            const spawned = this.bgAgentSpawns;
            this.bgAgentSpawns = 0;
            this.bgAgentNudges++;
            this.lastBgAgentNudgeAt = Date.now();
            this.warnBackgroundAgentEscape(spawned, "resumed");
            this.logEvent("cost", JSON.stringify({ cost_usd: this.costUsd }));
            if (this.sessionId) updateSessionCost(this.sessionId, this.costUsd);
            this.pushMessage(
              this.bgAgentNudgeText(spawned, [], this.bgAgentNudges),
              "system",
            );
            resultText = "";
            structuredOutput = null;
            continue;
          }
          // 超时兜底: 上一轮注入 reminder 后超过 BG_AGENT_NUDGE_TIMEOUT_MS, 模型
          // 仍卡在同 result 周期没正常收尾(Agent 工具同步实现把 SDK 进程挂住, subagent
          // 实际不存在, task 永远 running). 主动 fail 落 failed 状态, 不再 inject.
          // 不要求 spawns>0: nudge 之后模型空转也算(测试 batch 2 不派 subagent 也触达).
          if (
            this.lastBgAgentNudgeAt != null &&
            Date.now() - this.lastBgAgentNudgeAt > ActiveSession.BG_AGENT_NUDGE_TIMEOUT_MS
          ) {
            this.bgAgentSpawns = 0;
            this.warnBackgroundAgentEscape(0, "gave_up");
            updateTaskStatus(this.taskId, "failed", {
              session_id: this.sessionId || undefined,
              result: resultText || null,
              error: `注入等待指令 ${ActiveSession.BG_AGENT_NUDGE_TIMEOUT_MS / 60000}min 后模型仍无法收尾, 主动 fail 防止 task 永远卡 running`,
              cost_usd: this.costUsd,
              completed_at: new Date().toISOString(),
            });
            this.recordHeadCommit();
            this.emitEvent({
              type: "status_change",
              task_id: this.taskId,
              from: "running",
              to: "failed",
              cost_usd: this.costUsd,
            });
            this.closed = true;
            for (const resolver of this.messageResolvers) resolver(null);
            this.messageResolvers = [];
            resultText = "";
            structuredOutput = null;
            continue;
          }
          if (this.bgAgentSpawns > 0) {
            // 提醒已用尽仍带着未回收的 subagent 收尾 —— 不再拦, 但必须留痕(不静默).
            this.warnBackgroundAgentEscape(this.bgAgentSpawns, "gave_up");
            this.bgAgentSpawns = 0;
          }

          // 关注点: goal-driven loop 阶段 3 (D20) success 路径拦截. this.goalText
          //   命中 (启动时从 prompt 解析) → 调 gradeGoal 评判 (走 Haiku 4.5, ~$0.002).
          //   met → 走原路径 (verification → completed); impossible → 翻 failed;
          //   not_yet_met → 阶段 4 替换为 continueGoalLoop 智能分流 (pushMessage /
          //   fork+compress / giveUp).
          //   放置位置: getContextUsage 快照之后 (line 2898-2911), 还没到
          //   「Task completed successfully」块. 这样 context snapshot 不会被
          //   session 关闭清掉 (坑 2 红线), grader 调完上下文还在.
          //   调用 grader 失败 / throw → 视为 not_yet_met 续跑, 不阻断 task.
          //   🆕 D29: 不再 success 后 pushMessage (D28 旧路径) —— 提醒已在 start()
          //     通过 goalSelfReportPromptPrefix() 拼到首轮 prompt 头部, agent
          //     第一轮就看到 self-report 格式要求, 收尾 resultText 自带
          //     ```goal_report``` 块 → runGoalGate 直接拿到 selfReport.
          //     D28 旧路径失灵根因: success 时 session 已收尾, push 进 pendingMessages
          //     的 reminder 没人读, gradeGoal 拿到 success resultText 找不到 goal_report
          //     块 → selfReport 空 → fallback transcriptSummary → 仍判 not_yet_met
          //     (case1 D28 实证: 5 轮 → failed, cost=$1.04).
          if (this.goalText) {
            // 🆕 D34: success 路径前置 self-report 缺失检测 (替换 D29 拼 head 方案).
            //   D29 bug: agent 第一轮拿 hint 后每轮 result 都附 self-report 块, 中间轮
            //     也被要求写 → 污染输出 (用户 2026-09-17 实证).
            //   D34: agent 自由跑, success 时 resultText 不含 goal_report 块才 nudge.
            //     nudge 用尽 → 走原 grader 路径 (selfReport 空 → transcriptSummary
            //     fallback → 大概率 not_yet_met → continueGoalLoop max_goal_rounds 兜底).
            const nudgeAction = this.checkGoalSelfReportOrNudge(resultText);
            if (nudgeAction === "nudge") {
              // 复用 bgAgentNudge 同款 pushMessage + continue 模式 (line 3072-3091).
              //   不设 closed=true (避免触发 sendUserMessage 持久化路径),
              //   generator 继续供料 → SDK 把 reminder 当新一轮 query → agent 再跑一轮.
              resultText = "";
              structuredOutput = null;
              continue;
            }
            // proceed → 走原 grader 路径
            const goalResult = await this.runGoalGate(resultText);
            if (goalResult === "not_yet_met") {
              // 阶段 4: 调 continueGoalLoop 智能分流 (pushMessage / fork+compress /
              //   giveUp). continueGoalLoop 内部已完成所有副作用 (fork 翻 status /
              //   giveUp 翻 failed), 这边不需要重复翻; 关键是 session 不关闭,
              //   让 generator 继续供料 (fork / pushMessage 路径都靠这点推进).
              await this.continueGoalLoopDispatch(
                "[goal grader] 目标尚未达成, 请根据以上反馈继续推进。",
                { contextTokens, contextMax },
              );
              resultText = "";
              structuredOutput = null;
              continue;
            }
            if (goalResult === "impossible") {
              // 翻 failed (goal_unreachable) — 与 verification 失败路径同口径, 不再 inject.
              this.failGoalUnreachable(
                `goal_unreachable: ${this.lastGoalGraderReason || "(no reason)"}`,
              );
              resultText = "";
              structuredOutput = null;
              continue;
            }
            // met → 走下面原路径 (reviewing → verification → completed).
          }

          // Task completed successfully - move to reviewing state
          // v56+v61+R39: 若 agent 在 result text 里写过 awaiting marker, 在同一笔
          // status update 里把 awaiting_markers (JSON 数组) + awaiting_owner_review
          // (兼容 v56 单一标记, 只要 markers 非空就置 1) 一起落库. agent-runtime.
          // approveTask 看到 awaiting_owner_review=1 会拒绝, 提示 damo 先 unset.
          // 落库后立刻清空 pendingAwaitingMarkers, 防止 resume (restart 重跑 → 自然
          // 又到 reviewing) 时老 marker 复活. 写入走 updateTaskStatus 的 extra
          // 字段, 单事务同 status 一起, 不会发生「status=reviewing 已写但 flag 漏写」
          // 的窗口.
          // R129 Plan B 增改: awaiting_markers 列三态写入 — 新 JSON / 显式 null
          //   (清空) / undefined (不动). 旧逻辑 "没传就不动" 导致 resume 后老 marker
          //   滞留 (agent 写了 stuck marker → resume → 新一轮没写 marker →
          //   running→reviewing 时 DB 的 stuck 还在, UI 继续显示旧 chip). 现在
          //   hasMarkers=false 且 DB 旧值非空 → 显式传 null 清空.
          //   computeAwaitingMarkersWriteValue 是纯函数, 单测覆盖三态.
          const hasMarkers = this.pendingAwaitingMarkers.length > 0;
          const awaitingOwnerReview = hasMarkers ? 1 : 0;
          const awaitingMarkersJson = hasMarkers ? JSON.stringify(this.pendingAwaitingMarkers) : null;
          if (hasMarkers) {
            this.pendingAwaitingMarkers = [];
          }

          // R129 Plan B: 兜底清空 — 当 pendingAwaitingMarkers=[] 但 DB 旧值非空时,
          //   显式传 awaiting_markers: null 清空. 旧逻辑 (v61+R39) 为了避免覆盖
          //   "已 unset 的旧值" 选择 "没传就不动", 但这导致 resume 重跑后老 marker
          //   滞留: 例如 agent 写了 stuck marker → resume → 新一轮没写 marker →
          //   running→reviewing 时 DB 的 stuck 还在, UI 继续显示旧 chip.
          //   现在 hasMarkers=false 且 DB 旧值非空 → 显式清空. awaiting_owner_review
          //   上一段已无条件置 0, 这里只补 awaiting_markers 列.
          //   computeAwaitingMarkersWriteValue 是纯函数, 抽出来便于单测验证三态.
          const dbTask = !hasMarkers ? getTaskById(this.taskId) : null;
          const awaitingMarkersWriteValue = ActiveSession.computeAwaitingMarkersWriteValue(
            hasMarkers,
            awaitingMarkersJson,
            dbTask?.awaiting_markers ?? null,
          );

          // R88 quota 双保险 (Sheet L 验收 ⑥): 自然完成路径 (SDK result 消息)
          //   cost_usd 即将落库, 在落库前再 check 一次"含本次成本"是否触 cap.
          //   超 cap → 改写为 failed + quota_exceeded + 写 log, 不让"超 cap 任务
          //   自然完成"被审计面板误读成"正常完成已扣费".
          //   用 quotaBlockedThisTurn 局部 flag 控制后面的 reviewing/failed 分支:
          //   quota 已写 failed, 下面的 success 分支不能再写 reviewing (会覆盖).
          //   - this.userId 来自 task.owner_id (line 249), 不存在 = 不拦截.
          //   - costUsd > 0 才需要二次检查, 0 cost 不可能超 cap.
          //   - checkUserQuotaWithCurrent 内已包含 party_a + expire 短路,
          //     不会重复触发前置入口已判过的情况.
          let quotaBlockedThisTurn = false;
          if (this.userId && this.costUsd > 0) {
            const q = checkUserQuotaWithCurrent(this.userId, this.costUsd);
            if (!q.allowed) {
              recordQuotaExceededRuntime(this.userId, this.costUsd, q.detail ?? "quota exceeded");
              updateTaskStatus(this.taskId, "failed", {
                session_id: this.sessionId || undefined,
                error: `quota_exceeded: ${q.detail ?? ""}`,
                cost_usd: this.costUsd,
                completed_at: new Date().toISOString(),
                context_tokens: contextTokens,
                context_max: contextMax ?? undefined,
              });
              this.recordHeadCommit();
              this.emitEvent({
                type: "status_change",
                task_id: this.taskId,
                from: "running",
                to: "failed",
                cost_usd: this.costUsd,
                context_tokens: contextTokens,
                context_max: contextMax ?? undefined,
              });
              quotaBlockedThisTurn = true;
            }
          }

          if (!quotaBlockedThisTurn) {
            // v61+R39: awaiting_markers 列只在接受 marker 时写 (非空 JSON),
            //   避免覆盖已 unset 的旧值. updateTaskStatus 走 UPDATE 语义, 没传
            //   awaiting_markers 不动, 传 null 显式清空 (这里不传 = 已有旧 marker
            //   不被冲掉). 实际场景: agent 一次完成只会 push markers 一次, 不存在
            //   "老 marker 不被冲掉" 问题, 但写代码谨慎点好.
            updateTaskStatus(this.taskId, "reviewing", {
              session_id: this.sessionId || undefined,
              // 1007: result 落库前剥运行时标记 (<checkpoint .../> 等) — 它们是
              //   管线符号 (解析在活文本上早已完成), 不该进面向用户的汇报原文
              //   (概览兜底/卡片提取/导出都吃这列). 剥完为空回退 SDK result.
              result:
                stripRuntimeMarkers(resultText) ||
                stripRuntimeMarkers(result.result) ||
                null,
              cost_usd: this.costUsd,
              completed_at: new Date().toISOString(),
              context_tokens: contextTokens,
              context_max: contextMax ?? undefined,
              awaiting_owner_review: awaitingOwnerReview,
              ...(awaitingMarkersWriteValue !== undefined
                ? { awaiting_markers: awaitingMarkersWriteValue }
                : {}),
            });
            // R200: 结果分层后台预热 — fire-and-forget, 与浏览器无关 (damo
            //   「关页面也继续在后台处理」). checkpoints 优先 (0 LLM 成本),
            //   不足时 LLM 兜底, 结果写 metadata 缓存 → 弹窗打开即显.
            warmResultLayersForTask(this.taskId);
            // 1007: 卡片摘要 (干啥/有啥用) 同款完成后预热 — 画布卡片打开即显,
            //   不再进前端 3 并发慢队列. result 空由 store 的 pending 闸门兜住.
            warmCardSummaryForTask(this.taskId);
            // R127 §3.1 方案 A: decision marker 的运行时副本落到 tasks.metadata.pending_decisions
            //   (Map<decision_id, {question, options, recommended, recommended_reason, emitted_at,
            //    resolved_at?, resolved_label?}>). resolve-decision 路由读这里改 resolved_*
            //   字段, 不直接编辑 awaiting_markers 列 (那列是落库快照, 改它会污染语义).
            //   走 mutateTaskMetadata 走 read-modify-write, 与 resume-contract 红线一致,
            //   不扩 updateTaskStatus metadata 字段 (避免全字段覆盖把别人刚写的键抹掉).
            //   只在有 decision marker 时才写, review/choice/info 不占这里.
            const decisionMarkers = this.pendingAwaitingMarkers.filter(
              (m): m is typeof m & { decision_id: string } => typeof m.decision_id === "string",
            );
            if (decisionMarkers.length > 0) {
              const emittedAt = new Date().toISOString();
              mutateTaskMetadata(this.taskId, (meta) => {
                const pd = meta.pending_decisions && typeof meta.pending_decisions === "object"
                  ? (meta.pending_decisions as Record<string, unknown>)
                  : {};
                for (const dm of decisionMarkers) {
                  // 覆盖语义: 同 decision_id 重写以刷新 emitted_at. agent 重跑或 restart 不该
                  // 留下半截决策历史. 全 resolved 才 unset flag (resolve-decision 路由 §3.3).
                  pd[dm.decision_id!] = {
                    question: dm.question,
                    options: dm.options,
                    recommended: dm.recommended,
                    recommended_reason: dm.recommended_reason ?? null,
                    emitted_at: emittedAt,
                    resolved_at: null,
                    resolved_label: null,
                  };
                }
                meta.pending_decisions = pd;
              });
            }
            this.recordHeadCommit();
            // 🆕 v60: 自适应频率 watcher —— 任务进 reviewing 时跑 A/B 校验 + 警告。
            //   fire-and-forget: 通知可能等网络, 不该卡 SDK 收尾流程。
            //   schedule_id 缺失（手动 task） → no-op。
            if (this.scheduleId) {
              void checkAdaptiveFrequency(this.taskId, this.scheduleId).catch((err) => {
                console.warn(
                  `[ActiveSession] adaptive freq check failed for task ${this.taskId}: ${(err as Error).message}`
                );
              });
            }
            this.emitEvent({
              type: "status_change",
              task_id: this.taskId,
              from: "running",
              to: "reviewing",
              cost_usd: this.costUsd,
              context_tokens: contextTokens,
              context_max: contextMax ?? undefined,
            });
            // 波 2.5 (docs/plans/auto-complete-dag.md D7.2#3): auto_complete=1 →
            //   reviewing 瞬间自动翻 completed. fire-and-forget (setTimeout 0)
            //   不阻塞 result 返回路径, 细节见 maybeAutoCompleteReviewing.
            const acTask = getTaskById(this.taskId);
            if (acTask?.auto_complete === 1) {
              setTimeout(() => maybeAutoCompleteReviewing(this.taskId), 0);
            }
          }
        } else {
          // Task failed (SDK result 自带失败, 或 R182 synthetic API 错误). 跟 quota
          //   双保险正交: 即使 quotaBlockedThisTurn=true, 这里 SDK result 也是失败,
          //   落库 failed 时如果上面 quota 已经写过, 后写会覆盖 error 文案, 但 status
          //   一致, 不会让 task 出现"成功完成"假象. 这里故意不检查 quotaBlockedThisTurn.
          // R182: syntheticApiErrorText 非空 = SDK 报 success 但实际是 API 层错误
          //   (429 / 鉴权等), 错误文本优先于 result.error 落库, 详情页一眼能看出
          //   是配额/鉴权问题而不是 agent 干砸了.
          // R175 追加: 还有链成员可试 (fallbackRemaining > 0) 时**不写终态** ——
          //   外层 start() 会换凭证重跑; 中间态写 failed 会触发 task.failed
          //   webhook / R107 父通知, 重试成功又翻 reviewing = 双跳噪声. 状态保持
          //   running, 由重试循环的最终 attempt 决定落点.
          const willRetryChain =
            this.syntheticApiErrorText !== null &&
            this.fallbackRemaining > 0 &&
            !this.externallyTerminated;
          if (!willRetryChain) {
            updateTaskStatus(this.taskId, "failed", {
              session_id: this.sessionId || undefined,
              result: this.syntheticApiErrorText || resultText || null,
              error: this.syntheticApiErrorText
                ? `api_error: ${this.syntheticApiErrorText}`
                : result.error || "Agent finished with error",
              cost_usd: this.costUsd,
              completed_at: new Date().toISOString(),
            });
            this.recordHeadCommit();
            this.emitEvent({
              type: "status_change",
              task_id: this.taskId,
              from: "running",
              to: "failed",
              cost_usd: this.costUsd,
            });
          }
        }

        this.logEvent("cost", JSON.stringify({ cost_usd: this.costUsd }));
        if (this.sessionId) {
          updateSessionCost(this.sessionId, this.costUsd);
          updateSessionStatus(this.sessionId, "completed");
        }

        // R132 (damo 2026-09-07 拍板): SDK 0.3.220 已暴露 task_started / task_notification
        //   生命周期信号 + Query.stopTask(taskId) 控制面 API. result 收尾时:
        //   1. 若 inFlightSubagentIds 非空 → 等 drain (默认 5min). 期间 consumeMessages
        //      仍能处理新到的 task_notification (同步 delete 出 Set), 所以这里靠
        //      waitForSubagentsOrTimeout 轮询即可.
        //   2. drain 超时仍有 in-flight → 调 query.stopTask(taskId) 优雅停每个.
        //      SDK 文档明示 stopTask 不会阻塞 (sdk.d.ts:2562), 发完停止指令就返回.
        //   3. stopTask 后再等 grace (默认 10s), 让 task_notification status='stopped'
        //      落库 —— 否则 SDK subprocess close 时这些状态会被截断.
        //   4. 走到这里 in-flight 必空 (或已 stopped) → safe close.
        // 关注点: Query.close() (sdk.d.ts:2577-2584) doc 明文 "terminate the underlying
        //   process ... cleaning up ... and the CLI subprocess" → 整个 SDK subprocess
        //   必杀. 所以不 drain + stopTask 直接 close = 杀掉所有 in-flight subagent.
        if (this.inFlightSubagentIds.size > 0 && this.queryInstance) {
          const inFlightBeforeDrain = this.inFlightSubagentIds.size;
          const drained = await this.waitForSubagentsOrTimeout(
            ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS,
          );
          if (!drained && this.inFlightSubagentIds.size > 0 && this.queryInstance) {
            // Drain 超时 → 优雅 stopTask 每个未完成 subagent.
            const stuckIds = [...this.inFlightSubagentIds];
            for (const taskId of stuckIds) {
              try {
                await this.queryInstance.stopTask(taskId);
              } catch (err) {
                // 已停 / 不存在 / SDK 异常 — 都吞, 不能阻断 close 流程.
                this.logEvent(
                  "warning",
                  JSON.stringify({
                    kind: "stop_task_failed",
                    task_id: taskId,
                    error: (err as Error).message,
                  }),
                );
              }
            }
            // 等 grace 让 stopped 通知落地 (清出 Set).
            await this.waitForSubagentsOrTimeout(ActiveSession.BG_AGENT_STOP_GRACE_MS);
            this.warnBackgroundAgentEscape(
              stuckIds.length,
              "gave_up",
            );
            this.logEvent(
              "subagent_lifecycle",
              JSON.stringify({
                phase: "drain_timeout_stopped",
                initial: inFlightBeforeDrain,
                stuck: stuckIds.length,
                remaining_after_grace: this.inFlightSubagentIds.size,
              }),
            );
          } else if (drained) {
            this.logEvent(
              "subagent_lifecycle",
              JSON.stringify({
                phase: "drained_clean",
                count: inFlightBeforeDrain,
              }),
            );
          }
        }

        // Close the session after result — this unblocks the messageGenerator
        // so the query() iterator ends and consumeMessages() returns
        this.closed = true;
        for (const resolver of this.messageResolvers) {
          resolver(null);
        }
        this.messageResolvers = [];
      } else if ((message as any).type === "stream_event") {
        // Streaming token delta + tool_use block detection
        const event = (message as any).event;
        if (
          event?.type === "content_block_delta" &&
          event?.delta?.type === "text_delta"
        ) {
          // Accumulate into the per-turn buffer so that includePartialMessages
          // mode (where the corresponding assistant message has empty
          // content) still lets us detect checkpoint markers and build the
          // transcript slice.
          this.turnTextBuffer += event.delta.text;
          this.emitEvent({
            type: "stream_delta",
            task_id: this.taskId,
            text: event.delta.text,
          });
        } else if (
          event?.type === "content_block_start" &&
          event?.content_block?.type === "tool_use"
        ) {
          // Real-time tool_use detection: emit as soon as the agent decides
          // to call a tool, rather than waiting for the full assistant
          // message. This lets the frontend show the tool call while it's
          // executing (or pending approval). Input is {} here - the real
          // input arrives via input_json_delta and is filled at
          // content_block_stop (and persisted then, not now, so the DB
          // stores the complete input instead of an empty placeholder).
          const toolName = event.content_block.name || "";
          const toolId = event.content_block.id || "";
          const idx = event.index;
          if (toolName && toolId && toolName !== "AskUserQuestion") {
            this.streamingToolUseIds.add(toolId);
            this.streamingToolBlocks.set(idx, { toolId, toolName, json: "" });
            // R212: 流式 tool_use 也是实质产出 (includePartialMessages 下 finalized
            //   assistant 常为空壳, 纯 tool_use 轮的产出只在这里可见) —— 清
            //   synthetic 错误标 + 记 attempt 进度, 与 assistant 分支的
            //   hasSubstantiveOutput 同语义.
            this.syntheticApiErrorText = null;
            this.attemptHadModelOutput = true;
            this.emitEvent({
              type: "tool_use",
              task_id: this.taskId,
              tool_name: toolName,
              tool_input: {},
              uuid: toolId,
            });
          }
        } else if (
          event?.type === "content_block_delta" &&
          event?.delta?.type === "input_json_delta"
        ) {
          // Accumulate tool input fragments. The SDK streams tool input as
          // a sequence of input_json_delta events; the complete input is
          // only known once content_block_stop fires.
          const idx = event.index;
          const block = this.streamingToolBlocks.get(idx);
          if (block) {
            block.json += event.delta.partial_json || "";
          }
        } else if (event?.type === "content_block_stop") {
          // Tool input is complete. Emit a tool_use_update with the full
          // input so the frontend replaces the empty {} placeholder, and
          // persist the complete input to the DB. Under
          // includePartialMessages the finalized assistant message often
          // has empty content, so without this the real input would never
          // reach the frontend (only visible after a refresh via the SDK
          // session JSONL).
          const idx = event.index;
          const block = this.streamingToolBlocks.get(idx);
          if (block) {
            this.streamingToolBlocks.delete(idx);
            let input: Record<string, unknown> = {};
            try {
              input = block.json ? JSON.parse(block.json) : {};
            } catch {
              // Malformed JSON - leave input empty
            }
            this.emitEvent({
              type: "tool_use_update",
              task_id: this.taskId,
              tool_name: block.toolName,
              tool_input: input,
              uuid: block.toolId,
            });
            this.logEvent("tool_use", JSON.stringify({ name: block.toolName, input }));
            this.streamingToolUseUpdated.add(block.toolId);
            // 后台 subagent 逃逸计数. 只认 Agent 工具, run_in_background 缺省即后台.
            // 必须放流式路径: includePartialMessages 下 SDKAssistantMessage 的内容在
            // message.message.content, 而 finalized 分支读的是 msg.content(恒空) ->
            // 那里的 tool_use 分支生产环境根本走不到, 计数放那里等于不设防.
            if ((block.toolName === "Agent" || block.toolName === "Task") && input.run_in_background !== false) {
              this.bgAgentSpawns++;
            }
          }
        }
      }

      // Accumulate token usage from ANY message shape that carries it.
      // 必须独立于下面的 total_cost_usd 分支: 被中断的会话拿不到
      // total_cost_usd, 但 assistant 消息的 usage 是有的 —— 这是估算的唯一数据源。
      this.accumulateUsage(message);

      // Check for cost updates in any message
      if ((message as any).total_cost_usd) {
        this.costUsd = (message as any).total_cost_usd;
        this.emitEvent({
          type: "cost",
          task_id: this.taskId,
          cost_usd: this.costUsd,
          input_tokens: (message as any).input_tokens || 0,
          output_tokens: (message as any).output_tokens || 0,
        });
      }
    }
  }

  private emitEvent(event: AgentEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (err) {
        console.error("[ActiveSession] Error in event callback:", err);
      }
    }
  }

  private logEvent(type: string, data: string): void {
    insertEvent({
      task_id: this.taskId,
      session_id: this.sessionId || undefined,
      type,
      data,
    });
  }
}
