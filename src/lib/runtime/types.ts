// Runtime type definitions for Agent Task Orchestrator

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  // 🆕 DAG P3 (B4 拍板 2026-09-05): 机械验收门瞬态. agent SDK 报完成 → 翻 verifying
  //   → 跑项目级 verification_command → 成功翻 completed / 失败回退 running + 注入反馈
  //   (重试 N 次后失败翻 failed). 与 running 等价的「在飞」语义:
  //     - 调度器视为在飞 (后续依赖可拉起)
  //     - M 模式波次闸门不挡 (M 关心 depends_on 终态)
  //     - UI 蓝色 chip 展示 (与 paused 颜色一致 — 借鉴 P2 测试已有模式)
  //   L1 平台级开关 / L2 项目级 command 双关任一关 = 此状态根本不进, 行为与今天
  //   byte-identical (B5 拍板默认全关). 设计稿 docs/plans/dag-verification.md §4.3.
  | "verifying"
  | "paused"
  | "reviewing"
  // 🆕 R131 (damo 2026-09-15): 等用户介入 / 拍板 / 派发 / 建议. 区别 pending
  //   (= 等系统) / awaiting_owner_review (= reviewing 内 flag 细化). 设计稿
  //   docs/plans/review-state-machine-refactor.md.
  | "await_user"
  | "completed"
  | "failed"
  | "cancelled"
  // ⚠️ 历史兼容: 旧 task 可能仍是 "rejected" 状态 (单人系统前时代遗留). 不再
  //   写入新值, 但 DB 既有行保留, 前端映射到 cancelled 显示. 见 review-state-
  //   machine-refactor.md 决策日志「历史 rejected 数据保留显示兼容, 不删」.
  | "rejected";

export type TaskType = "design" | "dev" | "test" | "deploy" | null;

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// 与 src/lib/db/requirements.ts RequirementStatus 同源, 这里再声明一份避免循环依赖.
// 实际值固定: 'pending' | 'done' | 'awaiting_reply' | 'has_suggestion' | 'blocked' | 'closed'.
export type RequirementStatus =
  | "pending"
  | "done"
  | "awaiting_reply"
  | "has_suggestion"
  | "blocked"
  | "closed";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  prompt: string;
  status: TaskStatus;
  priority: number;
  session_id: string | null;
  parent_session_id: string | null;
  cwd: string | null;
  auto_approve: number; // 0 = need approval, 1 = auto-approve writes
  auto_complete: number; // v528 (波 2.5): 0 = 默认人审, 1 = reviewing 瞬间自动翻 completed (仅 DAG 项目)
  model: string | null;
  resolved_model: string | null; // v36: 最近一次启动实际使用的模型快照（resolveLlmConfig 最终值）
  llm_config_id: string | null; // v50: 创建时显式选定的 LLM 配置 FK (NULL=走默认链)
  resolved_config_id: string | null; // v50: 最近一次启动实际使用的配置 id (运行时快照)
  allowed_tools: string | null; // JSON array
  max_turns: number | null;
  effort: EffortLevel | null;
  result: string | null;
  structured_output: string | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  tags: string | null; // JSON array
  metadata: string | null; // JSON object
  depends_on: string | null; // JSON array of task IDs
  base_commit: string | null; // git HEAD when task started
  head_commit: string | null; // git HEAD when task ended
  forked_from_session_id: string | null; // SDK session_id this task was forked from (null for originals)
  project_id: string | null; // FK to projects.id
  version_id: string | null; // FK to versions.id
  type: TaskType; // workflow stage: design / dev / test / deploy (null = uncategorized)
  role_id: string | null; // FK to roles.id (workflow.md §9 v1)
  owner_id: string | null; // FK users.id (T2); redundant w/ project.owner_id
  context_tokens: number | null; // tokens in use when task last stopped (from getContextUsage)
  context_max: number | null; // model context-window size (from getContextUsage)
  deleted_at: string | null; // soft-delete: NULL = active, datetime = deleted
  schedule_id: string | null; // FK schedules.id; set when task was created by a schedule trigger
  preflight_result: string | null; // v29: 系统执行的 preflight 结果 (cwd/remote/commit), 注入 prompt 头供 dispatcher 核对
  dispatched_by_task_id: string | null; // v32: 派发方 task id (可选溯源, 跨项目派发也允许; 与 forked_from_session_id 正交)
  requirement_id: string | null; // v64: 关联需求点 (FK, R78 W3 §4.2 + page.tsx local Task 用). null = 未挂需求点.
  awaiting_owner_review: number; // v56: 1=等人工拍板 (即使 auto_approve=true 也保持 reviewing); agent 用 <awaiting_review/> marker 触发, 人工调 POST /api/tasks/[id]/unset-awaiting-review 解除
  awaiting_markers: string | null; // v61+R39: JSON 数组 (来自 <awaiting type="..."/> 多 marker). null = 无 marker / 老数据 (回退到 awaiting_owner_review=1 时显"等拍板"). 与 awaiting_owner_review 同事务落库, 只要非空后者也置 1.
  // v129 (R112 续): reviewing 状态下的细化「子终态」标签. AI 设计阶段完成
  //   上下文不够, 派发实施/部署出去单独做时, 当前 task 标 awaiting_reason 标识
  //   waiting on 子 task. 自由字符串 (damo 第 3 tag 允许 AI 自主定义); 常用 2 个
  //   alias: 'design_pending' → 「待实施」蓝 / 'deploy_pending' → 「待部署」紫,
  //   其他字符串走兜底「待<原值>」+ 灰 (前端 chip 映射). 不影响调度器闸门,
  //   task 仍按 reviewing 在飞. NULL = 老 task / 无细化标签, UI 不渲染 chip.
  awaiting_reason: string | null;
  // v517 (飞书 R196): task 完成度自报. progress 0-100 (null = 未报);
  //   progress_source 'manual' (agent/人工经 API 报) | 'ai' (预留);
  //   progress_note = 自报依据; progress_updated_at = 最近一次更新.
  progress: number | null;
  progress_source: string | null;
  progress_note: string | null;
  progress_updated_at: string | null;
  // join 出来的名字 — LEFT JOIN projects/versions 才有 (只在 getTaskById /
  // /api/tasks/[id] 返回). project_id/version_id 为空时为 null. 其他查询
  // 路径 (getTasksByShortId / 列表 / trim) 不带, 字段是 undefined — 标记
  // optional 让所有消费者不必改.
  project_name?: string | null;
  version_name?: string | null;
  // v510 (damo 2026-09-17): 看板拖拽手动排序顺序. NULL = 系统默认排序
  //   (priority desc + created_at asc); 非 NULL = 用户在 KanbanView 里上下拖动
  //   调整过的顺序, 调度器 (TaskScheduler.schedule) 也按这个顺序出队. 全局
  //   整数 (不按 project 切) — 调度器是单进程全局队列. enqueue 时 = MAX + 1;
  //   拖拽时一次性写一列可见 task 全部连续整数 (10/20/30…), 留空位给将来插入.
  //   不暴露给 TaskTrimmed: 看板前端在内存里根据 user-local order 渲染, 无
  //   需把这个 raw 整数传给每张 card; 真正消费方只有 scheduler + reorder API.
  queued_order: number | null;
  // v531 (damo 2026-10-31): 排队原因人话串 — 调度器挡出队时写入 (内存闸门 /
  //   并发满 / cwd 互斥 / DAG 依赖 / 用户上限), 出队即清 NULL。UI 排队卡片直接
  //   显示, 排查不用翻 pm2 日志。NULL = 不在队列或无阻塞。
  queued_reason: string | null;
  // v132 (D10): dispatcher 派发时前置填的「为什么派这个任务」—— 自由文本答案
  //   (e.g. "解锁后续 R92 检索能力, 不再每次从零探查"). 后置 LLM 反思 5 样本 0/5
  //   命中, 改前置门: 派发那一瞬 dispatcher 知道为什么, 不需要从 transcript 挖.
  //   API optional, 不传 = NULL, UI 角标显示「⚠ 未填价值」. 设计稿见
  //   docs/plans/requirement-as-entity.md §18.
  value_significance: string | null;
  // v132 (D10): value_kind 5 选 1 枚举 (unlock_capability / fix_bug /
  //   document_knowledge / advance_requirement / investigate). 不在 DB 加 CHECK
  //   (保留扩展性, 加枚举免改 schema), 应用层 getValueKindLabel() 兜底映射.
  //   forkTask 时子 task 自动继承父 value_kind.
  value_kind: string | null;
  // v521 (idea-canvas): 构思层弱引用 (docs/plans/idea-canvas.md §3). 可空;
  //   归属一致性由 API 层校验, 任务本体结构不受 idea 删除影响 (弱引用 D3).
  idea_id: string | null;
  node_id: string | null;
  work_class: string | null;
}

export interface TaskDefinition {
  title: string;
  prompt: string;
  description?: string;
  priority?: number;
  cwd?: string;
  auto_approve?: boolean;
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  // 平台派发不再限制 max_turns（默认不限, 落库默认 200）。想保留低值时设 true。
  force_max_turns?: boolean;
  effort?: EffortLevel;
  tags?: string[];
  dependsOn?: string[]; // task IDs this task depends on
  project_id: string;
  version_id?: string | null;
  type?: TaskType;
  role_id?: string; // §9 v1: optional FK to roles; inherits system_prompt + defaults
  schedule_id?: string; // optional FK to schedules; set when created by a scheduled trigger
  dispatched_by_task_id?: string | null; // 可选: 派发方 task id (同 owner 即可, 允许跨项目)
  llm_config_id?: string | null; // v50: 创建任务时选定的 LLM 配置 (FK). 解析时优先于默认链.
  template_id?: string | null; // v50: 任务从模板继承时记录, resolveLlmConfig 用它回查 template.llm_config_id
  requirement_id?: string | null; // v64: 关联的需求点 (FK requirements.id). 同 owner + 未软删校验由 createTask 兜底.
  // v132 (D10): 前置门字段. dispatcher 派发时填 — 后置反思不靠谱 (5 样本 0/5 命中).
  //   CLI ao-dispatch.sh 缺 --why/--kind 时打反思提示; API 不传 = NULL 不阻塞.
  //   详见 docs/plans/requirement-as-entity.md §18.
  value_significance?: string | null;
  value_kind?: string | null;
  // idea-canvas P0 (docs/plans/idea-canvas.md §3 v521): 构思层弱引用 — 可空, 无 FK 约束.
  //   归属校验在 API 层做 (idea/node 必须属于任务 owner); createTask 只落库.
  idea_id?: string | null;
  node_id?: string | null;
  work_class?: string | null;
  // 波 2.5 (docs/plans/auto-complete-dag.md D7.1): 任务级自动验收. true = 进 reviewing
  //   的瞬间自动调 approveTask 翻 completed (复用全部副作用). 硬限定 DAG 项目
  //   (createTask 校验, 违反抛 AUTO_COMPLETE_REQUIRES_DAG). 与 auto_approve (工具
  //   审批) 正交. agent 显式写 awaiting_owner_review marker 的任务 approveTask 会拒
  //   → 保持 reviewing 等人 (安全兜底).
  auto_complete?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  current_version_id: string | null;
  current_version_name: string | null;
  owner_id: string | null; // FK users.id (T2)
}

export interface Version {
  id: string;
  project_id: string;
  name: string;
  feishu_url: string | null;
  feishu_sheet: string | null;
  cwd: string | null;
  created_at: string;
  is_released: number;
}

export interface Session {
  id: string;
  task_id: string | null;
  status: "active" | "completed" | "forked";
  forked_from: string | null;
  cwd: string | null;
  title: string | null;
  tags: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  forked_at: string | null;
  source_message_id: string | null;
}

export interface Checkpoint {
  id: number;
  task_id: string;
  session_id: string;
  // Step is a tag, not a sequence number: accepts numeric (1, 2, 3) or
  // semantic names (final, milestone-1). Ordering in the UI is by
  // created_at, not by step value.
  step: string;
  summary: string | null;
  // R108: 写这个 checkpoint 的 agent / 上游标识 (e.g. "ao-dev"). charset
  //   [A-Za-z0-9_-]{1,64} 由 regex 强约束; NULL = 老 checkpoint 行 (UI 视作
  //   无细化归属).
  by: string | null;
  // R108: reviewing 卡片的细化子状态 (e.g. "waiting_reply" / "has_suggestion"
  //   / "blocked"). 不在 DB 层限定 enum, UI 渲染层做 enum→chip 颜色映射.
  //   NULL = 老 checkpoint 行 或 agent 没写 status 属性 (UI 视作默认).
  status: string | null;
  commit_id: string | null;
  transcript_slice: string | null; // JSON array of {role, text, uuid} since last checkpoint
  up_to_message_id: string | null;
  created_at: string;
}

// A user-uploaded file attached to a task. The agent never receives the file
// inline; it gets the absolute path (symlinked into the task cwd) and decides
// how to read it. source is 'upload' for browser uploads.
export interface Attachment {
  id: string;
  /**
   * v69 polymorphic attachments (飞书 R71): 附件挂在 task 或 requirement 上, 二选一
   * (DB 层 CHECK XOR 兜底). 读时拿到的对象形如:
   *   - 老 task attachment: task_id = "uuid", requirement_id = null
   *   - 新 requirement attachment: task_id = null, requirement_id = "uuid"
   * 调用方按 source 行处理 (vs 老代码默认 task_id 一定有值).
   */
  task_id: string | null;
  requirement_id: string | null;
  owner_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  storage_path: string;
  source: string;
  /**
   * R121: agent-generated 附件的可选元数据 (JSON 字符串).
   * 仅 source="agent_generated" (或 mmx 之类子 agent 上报) 时有值;
   * 老 upload/fork attachment 此字段 NULL —— 兼容.
   * 形状由 agent 端传, 见 docs/plans/r121-agent-generated-attachments-design.md §3.2.
   */
  metadata: string | null;
  created_at: string;
}

export interface TaskEvent {
  id?: number;
  task_id: string;
  session_id?: string | null;
  type: string; // message | tool_use | tool_result | status_change | error | cost
  data: string; // JSON
  created_at?: string;
}

// Parsed event data types for SSE
export interface AgentMessageEvent {
  type: "assistant_message";
  task_id: string;
  text: string;
  uuid: string;
}

export interface AgentToolUseEvent {
  type: "tool_use";
  task_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  uuid: string;
}

export interface AgentToolUseUpdateEvent {
  type: "tool_use_update";
  task_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  uuid: string;
}

export interface AgentToolResultEvent {
  type: "tool_result";
  task_id: string;
  tool_name: string;
  result: string;
  uuid: string;
}

export interface StatusChangeEvent {
  type: "status_change";
  task_id: string;
  from: TaskStatus;
  to: TaskStatus;
  // 终态转换 (reviewing/failed) 时携带, 让前端无需刷新页面即可显示最新花费/上下文.
  // 非终态转换不带这些字段.
  cost_usd?: number;
  context_tokens?: number | null;
  context_max?: number | null;
  // 触发来源: "manual" = 用户点按钮 (pause/cancel); "auto"/undefined = 系统自动 (超时/重启/调度).
  // 前端提示音据此区分: 人为操作不响铃 (用户正看页面), 自动变更才提醒.
  source?: "manual" | "auto";
  // 谁/为什么触发了这次 status 转换. 让 timeline 一眼看到「为什么 task 状态变了」,
  // 排查「已 approve task 被无故重置」类问题时不用 grep 上一条 message 事件.
  // 已知值 (新增请同步更新此处 + 写回 README):
  //   - user_message       终态 task 收到人工/甲方消息 -> canAutoStart 自动 resume
  //   - parent_notify      R107 父子通知唤醒父 task (parent-notify.ts:47)
  //   - restart            /api/tasks/[id]/restart 点「清空重来」(agent-runtime.ts:265)
  //   - manual_start       /api/tasks/[id]/start 点「启动」(agent-runtime.ts:239)
  //   - manual_resume      /api/tasks/[id]/resume 点「恢复」(agent-runtime.ts:541)
  //   - dependency_met     autoStartDependents: 依赖 task 进入 completed 自动起下一个 (agent-runtime.ts:961)
  //   - drain_stranded     maybeDrainStrandedMessages: 终态 + pending_messages 非空 (agent-runtime.ts:770)
  //   - maintenance_exit   exitMaintenance 收尾后批量恢复 (agent-runtime.ts §exitMaintenance)
  //   - server_restart     recoverOrphanedTasks: 进程重启救活 (agent-runtime.ts:191)
  //   - fork               forkTask: 派生新 task (agent-runtime.ts §forkTask)
  //   - task_runner_error  TaskScheduler.runTask() 内部 try-catch 兜底 (task-scheduler.ts §runTask)
  //   - manual_dequeue     R162 看板拖拽 queued → pending (agent-runtime.ts §dequeueTask)
  reason?: string;
  // task 进入 running 时携带 started_at (ISO) + 实际生效的 timeout_ms (含 per-task override),
  //   让前端无需额外请求即可显示「剩余 H:MM:SS」倒计时.
  //   to !== running 时不携带 (前端不会渲染倒计时).
  //   PATCH /api/tasks/[id] 改 timeout_minutes 后也会发同状态事件推新 timeout_ms.
  started_at?: string;
  timeout_ms?: number | null;
}

export interface CostEvent {
  type: "cost";
  task_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ErrorEvent {
  type: "error";
  task_id: string;
  error: string;
}

export interface StreamEvent {
  type: "stream_delta";
  task_id: string;
  text: string;
}

export interface ToolApprovalRequestEvent {
  type: "tool_approval_request";
  task_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  request_id: string;
}

export interface ToolApprovalResponseEvent {
  type: "tool_approval_response";
  task_id: string;
  request_id: string;
  approved: boolean;
  feedback?: string;
}

export interface CheckpointEvent {
  type: "checkpoint";
  task_id: string;
  session_id: string;
  checkpoint_id: number;
  step: string;
  summary: string | null;
  // R108: by / status 透传给 SSE 订阅者, 前端 reviewing 卡片拿来直接渲染.
  by: string | null;
  status: string | null;
  commit_id: string | null;
  up_to_message_id: string | null;
}

// 平台侧告警(非 agent 报错): 运行时发现了 agent 自己看不见的问题, 留痕给人看.
// kind 是开放字符串, 现有值: background_agent_escape(后台 subagent 未回收就收尾).
export interface WarningEvent {
  type: "warning";
  task_id: string;
  kind: string;
  message: string;
}

// Open string union — SDK may add new dialog kinds without a protocol bump.
// Hosts must answer unrecognized kinds with `behavior: "cancelled"`.
export type UserDialogKind = string;

export interface UserDialogOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface UserDialogQuestion {
  question: string;
  header: string;
  options: UserDialogOption[];
  multi_select: boolean;
}

// Emitted when the SDK hands us a `request_user_dialog` control request.
// `request_id` is the SDK-issued control request id used to route the
// resolve back to the right promise. `tool_use_id` correlates to the
// tool_use block the SDK streams into the transcript (when present).
export interface UserDialogRequestEvent {
  type: "user_dialog_request";
  task_id: string;
  dialog_kind: UserDialogKind;
  request_id: string;
  tool_use_id?: string;
  questions: UserDialogQuestion[];
  emitted_at: string;
}

// Emitted when the user submits or cancels the dialog. `answers` is the
// structured payload passed back to the SDK; for `ask_user_question` it
// is `{questions: [{question, header, options: [{label}]}]}` mirroring
// AskUserQuestionOutput. `cancelled` is true when the user opted out.
export interface UserDialogResponseEvent {
  type: "user_dialog_response";
  task_id: string;
  request_id: string;
  dialog_kind: UserDialogKind;
  cancelled: boolean;
  answers?: Record<string, string>;
  feedback?: string;
}

// Emitted when the dialog is auto-resolved due to abort/cancel/close.
// The UI uses this to drop the widget if it missed the response event.
export interface UserDialogTimeoutEvent {
  type: "user_dialog_timeout";
  task_id: string;
  request_id: string;
  reason: "abort" | "session_closed" | "task_cancelled";
}

// Emitted when a user upload lands (POST /api/tasks/[id]/attachments). Not
// persisted to the events table - the chat history rebuilds the upload
// timeline from GET /attachments (created_at) on load.
export interface AttachmentEvent {
  type: "attachment";
  task_id: string;
  attachment: {
    id: string;
    filename: string;
    media_type: string;
    size_bytes: number;
  };
}

// User message pushed via SSE when sent from a terminal/paused state
// (reviewing, completed, failed, cancelled, rejected, paused, queued, closed session).
// Not emitted for live sessions — those go through ActiveSession's event loop.
export interface UserMessageEvent {
  type: "message";
  task_id: string;
  data: string; // JSON: { role: "user", text: string, queued?: boolean }
}

export type AgentEvent =
  | AgentMessageEvent
  | AgentToolUseEvent
  | AgentToolUseUpdateEvent
  | AgentToolResultEvent
  | StatusChangeEvent
  | CostEvent
  | ErrorEvent
  | StreamEvent
  | ToolApprovalRequestEvent
  | ToolApprovalResponseEvent
  | CheckpointEvent
  | UserDialogRequestEvent
  | UserDialogResponseEvent
  | UserDialogTimeoutEvent
  | AttachmentEvent
  | WarningEvent
  | UserMessageEvent;

export interface TaskResult {
  result: string | null;
  structured_output: string | null;
  cost_usd: number;
  error: string | null;
  session_id: string;
}

// 精简投影：listTasksPage() 返回的看板列表字段。目的: RSC payload 从 MB 级降到
// KB 级(剔除 prompt/result/error/metadata 全文, 替换为 150-200 字符的 preview)。
// 看板只读这 20 个字段; 详情页仍走 /api/tasks/[id] 取全字段 Task。
//
// 关于 prompt_preview: DB 里 prompt 已是「用户输入 + preflight/dispatcher/role
// preamble」增强版(tasks.ts:235 resolvedPrompt), 头部 ~300 字符是系统噪音,
// 用 SUBSTR(prompt, -150) 取尾部 150 字符才能拿到用户的实际诉求。客户端拿到
// 后永远可以 task.prompt_preview.slice(0, 60) 或 .includes() 搜索, 不会被 preflight
// 文本污染。
//
// 兼容性: TaskTrimmed 与 Task 字段重叠但**不互相 extend**——前者是后者的精简
// 投影, 关系是单向的(详情页可以拿全字段, 列表只能拿精简)。前端若需要 Task
// 全字段请用 getTaskById。
export interface TaskTrimmed {
  id: string;
  title: string;
  description: string | null;
  // COALESCE(prompt, '') 兜底, 永远是字符串. SSE patch 后客户端 .slice() 不会崩.
  prompt_preview: string;
  result_preview: string;
  error_preview: string;
  status: TaskStatus;
  priority: number;
  type: TaskType;
  model: string | null;
  resolved_model: string | null;
  tags: string | null; // JSON array string (与 Task 保持一致, 客户端解析)
  project_id: string | null;
  version_id: string | null;
  owner_id: string | null;
  deleted_at: string | null;
  cost_usd: number | null;
  updated_at: string;
  auto_approve: number;
  auto_complete: number; // v528 (波 2.5): 同 Task
  context_tokens: number | null;
  context_max: number | null;
  awaiting_owner_review: number; // v56: 同 Task. UI 角标显示 (兼容旧数据, 新 UI 优先读 awaiting_markers)
  awaiting_markers: string | null; // v61+R39: 同 Task. JSON 数组, 多 marker 渲染按 type 分色 (review=amber/choice=blue/info=gray/其他=紫色)
  dispatched_by_task_id: string | null; // v32+R39: 派发方 task id. 非空时显示 [by]<短id> 角标 + 点击跳转父任务 (Q2)
  // R94: 关联需求点的 status (派生自 LEFT JOIN requirements). 仅三种中间态 (has_suggestion /
  //   awaiting_reply / blocked) 渲染 chip — 与飞书 O 列四态子集对齐. UI 应只在 task.status ===
  //   "reviewing" 时显示, 但字段值始终带回以便后续扩展 (例如看板筛选). 任务无关联 / 需求已
  //   软删 / 需求 owner 不匹配时为 null, 不渲染.
  requirement_status: RequirementStatus | null;
  // R99: 由定时任务（cron / once）派发时非空。UI 在任务卡片「任务状态」同一行显示「定时」标签,
  //   帮用户在列表里一眼看出哪些是脚本/agent 周期触发 (而非人手发起)。FK schedules.id;
  //   shell 类定时任务自建 task 时也走这个字段关联回 schedule (防重派闸门)。
  schedule_id: string | null;
  // R109: 任务最新 checkpoint 的 status (派生自 LEFT JOIN checkpoints latest_cp).
  //   子查询取 (task_id, status IS NOT NULL) 下 rowid 最大的 checkpoint —
  //   "最新有状态的 cp", 跳过中间老 marker 形态 (status=NULL) 的 cp.
  //   UI 拿原始字符串 → 走 getStatusDisplay() 4 色映射 → null 时不渲染 chip.
  //   任务无 cp / cp 全 status=NULL 时此字段为 null, UI 视作无细化子状态.
  latest_checkpoint_status: string | null;
  // v129 (R112 续): task-level 子终态标签 (reviewing 下的细化, 不影响调度器).
  //   原值带回, 由前端 AwaitingReasonChip 映射 label + 颜色. NULL 不渲染.
  awaiting_reason: string | null;
  // v510 (damo 2026-09-17): 看板拖拽手动排序 — 与 Task 同名字段同语义. 看板
  //   按这个 ASC NULLS LAST 排序列内 card. 拖拽后 server 已写库, 下次
  //   /api/tasks/page 拉回 (SSE 不推此字段, 避免 patch 风暴).
  queued_order: number | null;
  // v531: 排队原因人话串 — 与 Task.queued_reason 同语义, 排队卡片副标题显示.
  queued_reason: string | null;
}
