# 3. 任务管理

> 任务的创建、配置、调度、状态流转与操作控制。

## 概述

任务是平台的核心工作单元，每个任务关联一个 Claude Code Agent session。本章节覆盖任务创建的各字段含义、依赖关系、调度排队机制、状态机流转，以及启动/暂停/恢复/取消/重启等操作。

### 功能点：创建任务

- **是什么**：在指定项目/版本下创建一个 Agent 任务
- **怎么用**：
  1. 点击「新建任务」进入 `/tasks/new`
  2. 选择项目（必填）和版本（可选）
  3. 三种创建模式：
     - **快速模式**：输入 prompt 即可，自动审批 + 默认配置，创建后立即启动
     - **完整配置**：填写标题、prompt，以及全部可选参数（见下方字段详解）
     - **模板配置**：管理配置快照，快速模式可一键套用（详见 [07-预设与复用](./07-presets.md)）
  4. 可选附件上传（创建后自动上传，Agent 按路径读取）：
     - 📎 按钮选择文件（多选）
     - **Cmd/Ctrl+V 粘贴**：在 prompt 输入框直接粘贴剪贴板里的图片/文件（纯文字粘贴走默认行为，不拦截）
     - **拖拽文件**：把文件拖到输入区上方即可，拖入时边框高亮提示
- **注意**：
  - 必填字段：标题（完整配置模式）或 prompt（快速模式）、项目
  - 快速模式下标题自动截取 prompt 前 60 字符
  - 完整配置模式下「创建任务」不自动启动；快速模式「创建并启动」自动启动
  - URL 参数支持预填：`?name=&prompt=&model=&effort=&maxTurns=&autoApprove=&tags=&project=&version=`
  - 防双击双提交（R114r2）：按钮虽加 `disabled={submitting}`，但 React 18 batching 下 `setSubmitting(true)` 不立即生效，连点会绕过。因此表单用 `useRef.submitLockRef.current` 做同步锁，第二下直接早退（见 [`src/app/tasks/new/page.tsx`](../../src/app/tasks/new/page.tsx) `shouldBlockClickSubmit`）

### 功能点：任务字段详解

- **是什么**：完整配置模式下各字段的含义和可选值
- **怎么用**：

  | 字段 | 说明 | 默认值 |
  |------|------|--------|
  | 标题 | 任务名称，展示在看板和详情页 | - |
  | Prompt | 传给 Agent 的实际指令 | - |
  | 描述 | 任务说明（不传给 Agent） | 空 |
  | 工作目录 | Agent 运行的 cwd，留空=自动隔离 | 继承项目 cwd |
  | 任务类型 | design / dev / test / deploy | 未分类 |
  | LLM 配置 | 从可见列表（自配 + 平台授权）选一份；留空=走默认链解析 | 走默认链 |
  | 模型 | LLM 模型名，留空=继承所选 LLM 配置；可手动覆盖 | 继承所选配置 |
  | 推理强度 | low / medium / high / xhigh / max | high |
  | 最大轮次 | Agent 最大对话轮数 | 200 |
  | 优先级 | 0(低) / 5(中) / 10(高)，影响排队顺序 | 0 |
  | 工具审核 | 自动通过 / 需要逐个审核 | 自动通过 |
  | 允许的工具 | Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch/Agent/NotebookEdit | 全开 |
  | 标签 | 逗号分隔，如 `bugfix, auth` | 空 |
  | 依赖任务 | 依赖完成后才启动本任务 | 无 |
  | 派发方 task | 记录本任务由哪个上游 task 派发（可选，仅 API/CLI 传入） | 无 |
  | 角色预设 | 挂 Role 配置包：prompt 头部加 `[role: 名称]` 前缀 + 继承 model/effort/max_turns/allowed_tools 默认（显式字段优先）。全局角色任意项目可选，项目专属角色只在该项目出现（波3 P5 SPA 下拉，设置 → 角色 维护） | 不使用 |
  | 自动验收 | reviewing 瞬间自动翻 completed（复用 approve 全部副作用）；**仅 DAG 项目可用**（波2.5 v528，非 DAG 置灰） | 关 |

  **工具预设**：提供 4 个快捷组合
  - **全开**：所有 10 个工具
  - **计划**：Read + Glob + Grep + Agent（无 Bash，防止写入）
  - **探索**：Read + Glob + Grep + WebSearch + WebFetch + Agent
  - **本地**：Read + Write + Edit + Bash + Glob + Grep + Agent + NotebookEdit（无联网）

- **注意**：
  - `effort` 控制推理深度：low 最快、max 最深入，消耗 token 随之增加
  - `auto_approve=false` 时 Agent 每次使用写入类工具都需人工审批
  - 允许的工具是**限制性**的：列表外的工具会被 `canUseTool` 拒绝
  - 「计划」预设故意排除 Bash，因为 Bash 可通过 `echo >` / `sed -i` 绕过 Write 限制

### 功能点：任务依赖

- **是什么**：设置前置任务，前置完成后才允许启动当前任务
- **怎么用**：
  1. 在完整配置模式的「依赖任务」区域搜索已有任务
  2. 点击搜索结果添加为依赖（支持多个）
  3. 创建任务后，启动时检查依赖是否满足
  4. 前置任务状态变为 `completed` 后，当前任务自动启动
  - **CLI**：`ao-dispatch.sh --depends-on uuid1,uuid2 ...`（POST 时一次性建，无需 PATCH 二次发）
  - **API**：`POST /api/tasks` body 传 `depends_on_ids: ["uuid1","uuid2"]`；`PATCH /api/tasks/[id]` 也能改（`null` 显式清空 / `[]` 等价清空 / `string[]` 替换全部；详见 `docs/fixes/2026-08-24-dispatch-pitfalls.md` §2.2）
- **注意**：
  - 依赖任务候选列表仅显示状态为 `pending` / `completed` / `queued` / `paused` 的任务
  - 依赖检查仅在任务为 `pending` 状态时执行；`paused` / `failed` 等状态恢复时不检查
  - 前置任务被驳回或取消不会自动传递，需手动处理
  - 跨 owner / 不存在 task id 当依赖时**不校验**（POST/PATCH 行为一致；dependency 不存在会让 `areDependenciesMet` 永远 false → 任务不启动。务必先查再写）

### 功能点：派发方溯源

- **是什么**：记录「本任务由哪个上游 task 派发」，形成独立于依赖链的因果链。agent 在执行任务时派子任务（尤其跨项目派到别的仓库），派发链让人能反查「这个子任务是谁要求的」。
- **怎么用**：
  1. CLI：`ao-dispatch.sh --from-task <上游task-id> ...`。agent 子进程里 `ORCHESTRATOR_TASK_ID` 已自动注入，**不写参数也会自动继承**；用 `--no-from-task` 关掉。
  2. API：`POST /api/tasks` 传 `dispatched_by_task_id`。
  3. 任务详情页右侧「详情」面板的**派发关系**区块看双向链接：「派发自（上游任务）」+「本任务派发（下游任务）」，下游落在别的项目时标「跨项目」。
- **注意**：
  - 引用只要求同 owner，**不要求同 project** —— 跨项目派发是常见场景。
  - 引用解析不到（不存在或属于其他用户）时创建任务返回 400 `DISPATCHER_NOT_FOUND`，不会静默丢弃。
  - 子任务 prompt 头会注入一行 `[dispatched by] 本任务由上游任务「…」派发（task_id=…）`，子 agent 可据此回报进展。该行不依赖 preflight 开关。
  - 与 fork 正交：fork 是同一 SDK session 分叉（共享历史），派发是两个独立 session 之间的因果关系；创建后不可通过 PATCH 修改。
  - **子任务进 reviewing / failed 会自动通知父任务**（R107）：父在终态时这条通知会把父唤醒重跑一轮。**同一「父 + 子 + 目标状态」只通知一次**，详见下方「功能点：子任务状态通知父任务（含重复抑制）」。
  - **server 侧不读 env（2026-08-26 起）**：派发方溯源只信 body 显式 `dispatched_by_task_id`。曾因 pm2 env 残留让 ao-prod 上 38 条 HTTP 创建被静默归因到 c73132be + prompt 被注入污染 prelude（详见 [`docs/fixes/2026-08-26-task-dispatch-env-pollution.md`](../fixes/2026-08-26-task-dispatch-env-pollution.md)），已删 `POST /api/tasks` 里的 env 回退。`ao-dispatch.sh` 仍读 env（在自己的进程里 → 安全），并把它转成显式 `--from-task` 写到 body；其他非 dispatch 路径请显式传 `dispatched_by_task_id`。

### 功能点：子任务状态通知父任务（含重复抑制）

- **是什么**：子任务进入 `reviewing` / `failed` / `cancelled` / `rejected`（以及父显式等待时的 `completed`）时，平台自动给派发它的父任务推一条 `[subtask-notify]` 消息。父任务在终态时这条消息会触发 auto-resume（父被重新拉起跑一轮）；父从未启动过（无 session）时走 webhook `task.parent_child_notify` 兜底。
- **怎么用**：不需要配置，`dispatched_by_task_id` 存在即生效。父任务时间线上能看到：
  - `parent_notify_dispatched` —— 通知已发（`channel` = `send_user_message` / `webhook` / `webhook_fallback`）
  - `parent_notify_suppressed` —— 重复通知被抑制（`reason=duplicate_unhandled`）
  - `parent_notify_dropped` —— 父已删 / 跨 owner / 子 completed 但父没在等它
- **重复抑制规则**（2026-09-08 起）：同一组「父 + 子 + 目标状态」**只推一次**，直到子任务被真正处置过。
  - **算处置**：approve（`reviewing → completed`）、reject、人工 resume —— 之后子任务再进 `reviewing` 属于新信息，会**再次**通知父。
  - **不算处置**：平台自己把子任务拽回 `queued`（`reason` = `parent_notify` / `drain_stranded` / `restart`）—— 这类之后重进 `reviewing` 会被抑制。
  - **逃生窗口**：上一次通知已过 24 小时且子任务仍未被处置 → 放行一次（防止父确实漏了消息被永久掐死），放行后重新进入抑制。
  - 抑制键含子任务 id 与目标状态，所以不同子任务、以及同一子任务的 `reviewing` 与 `failed` 互不影响。
- **注意**：
  - 抑制前没有这条规则时，同一组通知在 48 小时内被观测到重复 7 次，父任务被反复从 `reviewing` 拽回 `queued` 并重烧整轮 agent（实测 41 次纯冗余唤醒 ≈ $31/48h，且沿父链级联放大）。
  - 抑制只看 `events` 表已有记录，没有新增表或字段；`parent_notify_suppressed` 事件保留了每一次被拦下的通知，便于事后审计。
  - 父任务想主动等某个子任务完成 → 在父 `metadata.waiting_child_id` 写子任务 id（子 `completed` 才会推 + 触发 auto-resume）。

### 功能点：调度与排队

- **是什么**：任务调度器的排队和并发控制机制
- **怎么用**：
  - 任务启动后进入调度队列，调度器按优先级 + FIFO 顺序分配执行槽
  - 三层并发控制：
    1. **全局并发上限**（默认 2，可在设置页调整 1-5）：限制同时运行的任务总数
    2. **每 cwd 互斥**：共享同一工作目录的任务串行执行，不同 cwd 可并行
    3. **每用户并发上限**（admin 可设置，留空=不限）：限制单账号同时运行任务数
  - 队列中的任务状态显示为「排队中」
- **注意**：
  - 同优先级内按 FIFO 排队；高优先级任务可插队
  - 同 cwd 任务互斥：即使全局并发有空槽，同一 cwd 的任务也必须等待前一个完成
  - 系统重启后，`running` 状态的任务自动转为 `paused`（SDK 进程已丢失），`queued` 状态的任务回到 `pending`
  - 全局并发通过设置页「最大并发数」滑块调整
  - **内存闸门**（2026-10-31，防 WSL 低内存卡死）：出队前检查可用内存，低于阈值（env `AO_MEM_GUARD_MB`，Linux 默认 2048MB）任务留 `queued` 不派发，内存恢复后自动继续（会收到邮件预警/恢复通知各一封）。macOS 默认关闸（`os.freemem()` 不含可回收 cache，实测常年 <100MB，闸门永远不恢复）；Mac 上要启用需显式设 `AO_MEM_GUARD_MB`。排查任务卡 queued 时先看 pm2 error 日志有无「内存闸门」
  - **排队原因**（v531）：任务被上述任一闸门挡住时，原因直接写在任务上（DB 列 `tasks.queued_reason`），看板/列表的排队卡片状态徽章旁显示橙色小字（hover 看全文），不用翻日志排查。出队后自动清空
  - **排队原因精确定位**（v531 续）：同项目互斥挡住的卡片会显示**挡路任务短 id**（「同项目任务 `a1b2c3d4` 正在运行」，可直接对照看板找到占 cwd 的任务）；DAG 模式依赖未满足同理显示未完成的上游任务 id。维护模式关闸 / runner 未挂载期间入队的任务也会标出原因（此前静默）。任务详情页头部与列表/看板同款显示；任务离开排队（转 running / 取消 / 手动改状态）时原因一律自动清空

### 功能点：状态机

- **是什么**：任务的 9 种状态及其合法转换规则
- **怎么用**：

  9 种状态：

  | 状态 | 中文 | 说明 |
  |------|------|------|
  | pending | 待执行 | 新创建，未启动 |
  | queued | 排队中 | 已入队等待调度 |
  | running | 运行中 | Agent 正在执行 |
  | paused | 已暂停 | 手动暂停、超时自动暂停、或部署关停，可恢复 |
  | reviewing | 待审核 | Agent 完成工作，等待人工审核 |
  | 🆕 await_user | 等用户介入 | Agent 主动停下等用户拍板/派发/建议 |
  | completed | 已完成 | 审核通过 |
  | failed | 失败 | 出错或异常终止 |
  | rejected | 已取消（显示兼容） | 历史遗留终态，不再产生新值；2026-11-01 起读路径映射为 cancelled 显示（并入「已取消」chip 计数与看板列），UI 不再单列。此前误标「等待中」造成幽灵计数 |
  | cancelled | 已取消 | 手动取消（超时不再取消，改为暂停） |

  合法状态转换（拖拽 / API 触发）：

  | 从 | 可转到 |
  |-----|--------|
  | pending | queued, running, cancelled |
  | queued | running, cancelled |
  | running | paused, await_user, cancelled |
  | paused | running, cancelled |
  | reviewing | completed, running |
  | await_user | running, completed, cancelled |
  | completed | running（重新启动） |
  | failed | running（重新启动） |
  | rejected | running, completed（仅历史 task） |
  | cancelled | running（重新启动） |

- **注意**：
  - 任何终态（completed / failed / rejected / cancelled）都可通过发消息或重启回到 running
  - 看板拖拽受此规则约束，非法拖拽会被拒绝
  - 拖拽触发的 API 动作：`running` -> `paused` = pause，`running` -> `await_user` = await，`reviewing` -> `completed` = approve，`reviewing` -> `running` = refine，等

### 功能点：任务操作

- **是什么**：对任务的启动、暂停、恢复、取消、重启、refine、await、unawait 操作
- **怎么用**：

  | 操作 | 说明 | 适用状态 |
  |------|------|---------|
  | 启动（start） | 入队等待调度，有已有 session 则恢复 | pending, paused, failed, rejected, cancelled, completed, reviewing, await_user |
  | 暂停（pause） | 中断 Agent，保留 session 历史 | running |
  | 恢复（resume） | 从暂停态恢复执行 | paused |
  | 取消（cancel） | 停止 Agent，清理 session | running, queued, paused, await_user |
  | 重启（restart / 清空重来） | 清空 session_id，全新开始 | failed, cancelled, completed, reviewing, rejected, await_user |
  | 审核（approve） | 通过审核，标记完成（await_user 时自动 unwait 透明） | reviewing, await_user, paused |
  | 🆕 refine | reviewing→running，agent 接着干（替旧 reject） | reviewing |
  | 🆕 await | running→await_user，等用户介入 | running |
  | 🆕 unawait | await_user→running，agent 继续工作 | await_user |
  | 🆕 删除（delete） | 软删移入回收站（详情页可恢复）；非终态任务删除时前端会先自动 cancel 再删 | pending, queued, completed, failed, rejected, cancelled |

- **注意**：
  - **启动 vs 重启**：启动（start）保留已有对话历史（resume 模式）；重启（restart）清空 session_id 从头开始
  - 从 `completed` / `rejected` / `await_user` 启动时，若有 `session_id` 则自动 resume（保留对话历史）
  - 重启仅对终态（含 `await_user`）有效，`running` / `paused` 状态不能重启
  - 暂停后可发消息给 Agent（消息在恢复时注入对话）
  - 取消会清理超时定时器和待处理覆盖参数
  - 🆕 **R164 (2026-09-30)**：看板列表 / 全局看板的「待执行」「排队中」任务行直接给出「取消 + 删除」按钮（此前删除只有终态才有）。典型场景：sheetwatch 派发洪水时在列表上一键止血，不用进详情页 / 改库。删除非终态任务 = 先自动 cancel（清掉调度器内存队列）再软删；queued 任务即使直接删，调度器出队时也会自然跳过，不会跑起来
  - 🆕 **R131 (2026-09-15)**：旧 `reject` 端点已删除（单人协作系统无他人接驳回）；改用 `refine` + `await` + `unawait` 三件套

### 功能点：Agent 一键决策点（`<awaiting type="decision">`，R127）

- **是什么**：Agent 在 result 末尾写 `<awaiting type="decision" data='{question, options[], recommended, recommended_reason}'/>` 后，看板任务卡上直接出选项按钮 + 推荐项 `(推荐)`，damo 点选即落 `decision_resolved` event + 全 resolved 自动 unset `awaiting_owner_review`。无需进 task 聊天考古找当时问的选项。
- **怎么用**：
  - **Agent 端**：参考 `docs/claude-config/docs/awaiting-owner-review.md` §"Agent 怎么写 decision marker"。agent 不写 `decision_id`，server 端分配 UUID。
  - **damo 端**：看板任务卡 chip 旁多一块 amber 主题色 DecisionBanner。点选项 → 一键 resolve；hover title 看完整 description；推荐项标 `(推荐)`；多 decision 显示 N/M 已选。
  - **REST API**：`POST /api/tasks/[id]/resolve-decision { decision_id, selected_label }`
    - 权限：task owner = session user + status=reviewing
    - 副作用：mutateTaskMetadata 写 `pending_decisions[decision_id].resolved_at/resolved_label` + 落 `decision_resolved` event + 全 resolved 调 `unsetAwaitingOwnerReview`
    - 错误码：400（label 不在 options / 缺字段 / 坏 UUID）/ 401 / 404（decision_id 不在 pending_decisions）/ 409（已 resolved / task 非 reviewing）
- **注意**：
  - 校验失败（data 缺 question / options / recommended 不匹配 options.label）→ 降级为普通 marker，不影响 task 状态
  - 不复用 `resolveUserDialog`：SDK session reviewing 已 close，in-flight Promise 句柄会 console.warn 静默失效
  - 与 `<awaiting_review/>` 共存：decision 不取代 review，agent 可同时标「需要决策 + 需要拍板」两种语义

### 功能点：超时机制

- **是什么**：任务运行时长上限，防止 Agent 无限运行消耗 token
- **怎么用**：
  - 每个任务启动时按「项目级 → 全局默认」解析出一个 wall-clock 超时定时器（**缺省 30 分钟**）
  - 时长可配（v40，1-1440 分钟）：
    - 全局默认：`/settings` →「任务超时（全局默认）」，**落库，pm2 重启仍生效**（管理员）
    - 项目覆盖：项目列表 → 悬停项目 → 高级选项 →「任务超时」，留空 = 继承全局
    - 完整解析链见 [config-resolution.md §3.5](../config-resolution.md)
  - 超时时统一走「暂停」（与前端暂停按钮同一条路径 `pauseTask`）：interrupt + 保住 `session_id`，状态落 `paused`，恢复后续完整 transcript
  - 仅当暂停失败时回退取消（会话已消失；若 SDK `session_id` 还没分配，`pauseTask` 自己判 `failed`）
- **注意**：
  - 超时暂停后，用户可（按需审批/回答后）点击恢复继续运行，上下文不丢
  - 改配置**对已在跑的任务不生效**：定时器在启动那一刻挂好，按当时的值走完；下一次启动/恢复才吃到新值
  - 🔴 调长超时 = 把下面那条「挡住 schedule 后续触发」的窗口一起调长
  - ⚠️ `paused` 是**非终态**：定时任务的防重派闸门按「非终态」算在飞，一个超时挂着的任务会挡住该 schedule 的后续触发 —— 解卡 = 恢复它或软删
  - 超时定时器在任务正常结束时自动清除
  - 超时是 wall-clock 时间（包括 Agent 等待用户审批的时间），非纯 Agent 执行时间
  - `source` 字段标记触发来源：`"manual"` = 用户手动操作，`"auto"` = 系统自动（超时/重启）

### 功能点：与需求点联动（R78 闭环）

> **状态**：R78 已落地，需求点 ↔ task 双向打通。详细 6 态 + invariant + 不变量见 [14-需求点管理](./14-requirement-management.md) 与 [`docs/plans/r78-requirement-loop.md`](../plans/r78-requirement-loop.md)。

#### task 创建时挂需求点

`POST /api/tasks` body 加 `requirement_id`（可选）：

```bash
curl -X POST http://localhost/api/tasks -d '{
  "project_id": "...", "title": "...", "prompt": "...",
  "requirement_id": "<uuid>", "type": "dev"
}'
```

校验：

- 需求点必须属当前 user（不存在 / 跨 owner → 400 `REQUIREMENT_NOT_FOUND`）
- 需求点 status ≠ `closed`（已关 → 400 `REQUIREMENT_CLOSED`）

#### task 字段 `type`（R78 W1）

`type` ∈ `{design, dev, test, deploy, null}`：

| type | 需求点能否被标 `done` |
|------|---------------------|
| `design` | ❌ 调研/设计结果不计入「实现」 |
| `null`（未分类） | ❌ |
| `dev` / `test` / `deploy` | ✅ 至少一个 completed 才放行 `done` |

POST body 非法 `type` → 400 `TYPE_INVALID`（与 `status` 校验同口径，友好报错）。**关键不变量**：`task.reviewing` ≠ `requirement.done` —— task 进 reviewing 不把 requirement 自动标 done（详见 [14-需求点管理 §status→done 守卫](./14-requirement-management.md#功能点statusdone-守卫r78-w1-43-invariantdamo-痛点核心)）。

#### PATCH task 也支持改 `requirement_id`

`PATCH /api/tasks/[id]` 的 `ALLOWED_FIELDS` 含 `requirement_id`，传 `null` 解绑。`closed` requirement 仍拒收（400 `REQUIREMENT_CLOSED`）。

#### task 详情页右侧「需求点关联」面板（W3）

`/tasks/[id]` 详情页右侧详情区，如果 `task.requirement_id` 非空，渲染卡片：

- 标题 = 需求点标题 + 状态徽章，点击跳 `/requirements/[id]`
- 同一 requirement 下其他 task 列表（最多 5 条 + 「查看森林」链接

详情页跳转路径：需求点 ↔ task 双向打通，无需手动复制 id。

#### 任务列表 / 看板卡片 chip（R94）

关联需求点 status 会在三个入口透出 chip，让 reviewing 状态下的任务一眼能识别「上游需求在哪等」：

- **触发条件**：`task.status === "reviewing"` 且 `requirement.status` ∈ `{awaiting_reply, has_suggestion, blocked}`
- **入口**：Chat 左侧任务列表（标题行，紧凑样式）、`/[projectId]/[versionId]` 项目看板的 cards / kanban 卡片、`/global` 全局看板卡片
- **文案 + 配色**：

| 需求 status | chip 文案 | 配色 |
|------------|----------|------|
| `awaiting_reply` | 等回复 | cyan |
| `has_suggestion` | 有建议 | emerald |
| `blocked` | 需拍板 | amber |

chip 与已有的 `awaiting_markers` chip 是两套不同信号：前者来自关联需求点（上游），后者来自任务自身的 `<awaiting type="...">` marker（任务本身）。两者并存，不互踩。

**为什么 SQL 层 LEFT JOIN + UI 仅 reviewing 才显示**：LEFT JOIN 让 1 次 `listTasksPage` 带值，避免 N+1；UI gate 在 reviewing 是因为需求 status 变化时任务可能已经跑完/继续，仅在「任务停下来等人」时显示 chip 才有意义。

### 功能点：时间显示自动刷新（R161）

任务列表 / 看板 / 卡片 / Chat 侧栏显示的 `updated_at` 时间，每 **60 秒**自动刷新一次，无需手动 reload 页面。相对时间（如「3 分钟前」「刚刚」）会随时间过去自动跳到下一档；绝对时间（`MM-DD HH:MM`）保持不变但组件保持「活着」便于 SSE 推送即时落库。

**实现**：新增 `src/lib/hooks/use-tick.ts`（默认 60s 周期，setInterval 触发 re-render）；挂载到 6 个组件：
- `/global` 三视图：`global-board.tsx` / `global-list-view.tsx` / `global-grouped-view.tsx`
- 单版本三视图：`board-client.tsx` / `kanban-view.tsx` / `chat-task-list.tsx`

**为什么 60s 而不是 30s**：damo 明确说「目前分钟级精度就够了」，60s = 1 分钟边界与「X 分钟前」档位对齐；额外开销可忽略（每组件 1 个 setInterval，60s 触发一次 setState）。

**为什么不直接轮询服务端**：本需求是「显示刷新」不是「数据刷新」——SSE 已承担实时数据推送；强制 re-render 让 formatRelativeTime 内的 `Date.now()` 重新计算即可拿到新显示。轮询会增加服务端负担 + 触发筛选条件重算。

### 功能点：看板常驻 + 后台增量同步（R165）

版本看板 `/#/projects/<projectId>/versions/<versionId>` 可以一直开着不动：数据**每 60 秒在后台自己校准一次**，没变就**一个字节都不拉**；页面切走再切回、以及从后台标签页切回窗口时，**立刻**再校准一次。刷新页面（F5）时首屏直接由本地快照渲染，随后一次请求确认是否有新数据。

**用户能看到的变化**：
- 看板开着不动，卡片状态 / 需求 chip / checkpoint chip 会自己变新，不需要手动刷新。
- 切回标签页不再显示几小时前的旧卡片（改造前 `BoardPage` 只在 `onMounted` 拉数据 + keep-alive 缓存 = 切回**根本不刷新**）。
- 刷新页面几乎瞬出（快照首屏），网络面板里那条 `/api/tasks/page` 请求返回 **304 Not Modified**，不是全量 JSON。

**实现（4 层）**：
| 层 | 文件 | 职责 |
|----|------|------|
| 服务层 | `src/app/api/tasks/page/route.ts` + `src/lib/db/tasks.ts` | 200 响应带 `ETag: W/"<行集指纹>\|<limit>-<offset>"`；客户端带 `If-None-Match` 回来且指纹未变 → 304 空 body |
| 探测层 | `spa/src/api/http.ts` `getIfChanged()` | 发条件 GET，返回 `{changed, etag, data}`；304 → `changed:false` |
| 缓存层 | `spa/src/lib/snapshot-cache.ts` | sessionStorage 快照（LRU 12 条 / 单条 ≤512KB），刷新后首屏秒出 |
| 调度层 | `spa/src/composables/useBackgroundSync.ts` | 模块级单例：60s 节拍 + `focus`/`visibilitychange` 主动探针 + 同 key 去重 + 错误隔离 |

**指纹怎么算的**：`boot 随机串 + SQLite total_changes() + COUNT(*) + MAX(updated_at)`，与 `listTasksPage` 共用同一份 WHERE（保证筛选收窄时指纹跟着变）。`MAX(updated_at)` 是秒级精度、同秒两次写会漏判，所以掺 `total_changes()` 兜底——省下的是网络 payload，不是 DB CPU，方向是宁可多拉不可漏拉。

**给新页面接入**：调 `useBackgroundSync({ key, check })` + `useBackgroundSyncState(key)` 即可；`check` 里用 `getIfChanged(url, etag)`，返回 `false` 表示没变。约 15 行。

**已知边界**：ETag 内**不允许空格**（RFC 9110），回传会被截断导致条件拉取永不命中；页窗口（`limit-offset`）必须进 ETag，否则翻页时 304 会把上一页数据当本页返回。两条都有回归测试锁死。

**服务端聚合去重（2026-10-08 压测批次）**：压测发现单次 `/api/tasks/page` 请求会把同款 `GROUP BY status` 跑两遍（fingerprint 一遍、`listTasksPage` 的 statusCounts 一遍），terminal 段 ~4800 行扫两回。现改为 route 先跑 `runTasksPageStatusRows()` 一次，两个函数共享结果——服务端 5 条 SQL 变 4 条，terminal 列表稳态耗时约 -40%（实测 230~340ms 区间收窄）。冷进程首打慢（重启后首个 terminal 查询实测 21.7s，346MB DB 冷页缓存）由 `deploy.sh` 部署后 `wsl_warmup()` 预热兜住（见 [部署变更 2026-10-08](../deploy/2026-10-08.md)）。

方案对比（为什么没走 SSE 推送 / Service Worker）见 [`docs/plans/r165-resident-background-sync.md`](../plans/r165-resident-background-sync.md)。

### 功能点：tab 切换不重载（R165 迭代二，keep-alive 真正生效）

R165 一期上线后实测「任意 tab 点击还是转圈圈很久」——根因是 `<keep-alive :include>` 里的缓存名单存的是**路由 path**，而 include 只按**组件名**匹配，永远命中不了 → keep-alive 从未生效，每次切 tab 整页重挂载 + 全量重拉（实测切一次发 6 个请求）。

**修复（3 处配套）**：
| 位置 | 改动 |
|------|------|
| `spa/src/layouts/MainLayout.vue` | `<component :is="Component" :key="viewRoute.path" />` 进 keep-alive —— 同组件多实例（同开多个版本看板）按 path 分槽缓存 |
| `spa/src/router/index.ts` afterEach | tab 的 `name` 改为**路由组件名**（`comp.name ?? comp.__name`），缓存名单才能被 include 匹配 |
| `spa/src/views/BoardPage.vue` 等 | 驻留期守卫：keep-alive 生效后实例比路由活得久，后台探针 / SSE refetch / params watch 在「路由已走到别的页面」时会用失真参数拉数据（实测 `/api/versions/undefined` 404 一对 + 缓存看板差点被灌入全局数据）——探针和 watch 加 `route.path !== instancePath` 跳过，切回时由 `onActivated` 探针补增量 |

**修复后实测**（vite dev → :13000，GDM 版本看板 ↔ 全局看板来回切）：切回 tab 全程**只有 1 发 304**（修复前 6 发含 3×`/api/user/me`）；无 404；卡片数据无错乱。刷新页面场景不变（快照首屏 + 304 校准）。

### 功能点：激活 tab 自动滚动定位 + 滚动条细化（R173，飞书 AO-DEV R173）

1. **激活 tab 自动定位**：打开的 tab 多、横向溢出时，激活的 tab 可能被折进滚动隐藏区看不到。现在 `route.path` 变化（切 tab / 新开 / 关闭后 fallback）后自动把激活 tab 平滑滚进可视区（`TagsView.vue` watch + `scrollIntoView({ inline/block: 'nearest' })`，垂直方向已在可视区就不动，不连带页面竖向滚动）；刷新后首次挂载直接定位不做动画。
2. **全局滚动条细化**：原生 16px 实心灰条统一收窄为 8px 圆角半透明 thumb + 透明 track（`spa/src/assets/main.css` 全局 `::-webkit-scrollbar`；Firefox 走 `scrollbar-width: thin` + `scrollbar-color`），悬停加深提供反馈。内容区 / 弹窗 / tab 条 / 横向滚动全部生效。

**验证**（vite preview + 测试账号，开 10 个 tab 制造横向溢出）：切到最后一个 tab 自动滚入可视区（scrollLeft 0→271，activeVisible=true）；`getComputedStyle(content-area)` 返回 `scrollbar-width: thin`。

### 功能点：全局看板手机可滚动（R191，2026-10-04）

- **是什么**：`/global` 全局看板在手机（≤767px）上卡片/看板/列表模式整页可上下滑动。此前手机上滑不动——桌面布局是「锁视口 + `.gb-body` 内部滚动」，窄屏上 header（~190px）+ 筛选栏折行（~273px）+ sticky 分页（~97px）把 587px 的内容区吃到只剩 ~27px 可滚缝隙（2026-10-04 实测 375×667），看板模式列内滚动区只剩 16px。
- **怎么工作**：≤767px 时 `.gb-page` 解锁为文档流自然高，滚动交还 `.content-area` 全屏原生滚动；分页落回文档流不再 sticky；看板/分组列限 `max-height: 70vh` 列内滚动接管（横向滑列不变）。chat 模式豁免（保持锁视口布局）。桌面（≥768px）完全不变。
- **实现**：`spa/src/views/GlobalBoard.vue` style 末尾 `@media (max-width: 767px)` 块 + `.gb-page-chat` class 豁免。

### 功能点：全局看板版本筛选「其他版本」桶（R218，2026-10-08）

- **是什么**：`/global` 全局看板筛选栏的版本下拉，在选中项目后末尾追加「**`项目名 / 其他版本`**」选项 = 只看没挂任何版本的任务（如 `taoke / v1.0` 之外的 `taoke / 其他版本`）。
- **怎么工作**：选项 value 为 `null` 字面量；取数时映射成后端 `GET /api/tasks/page` 的 `unversioned=true`（`version_id IS NULL`，要求同时传 project）；客户端谓词同步兜一层。未选项目时不出现该选项（与后端约束一致）。
- **实现**：`spa/src/views/GlobalBoard.vue` `versionOptions` + `filterPredicate` + `buildPageParams`。

### 功能点：全局看板「收起」= header + 筛选排全收（R217v6/v7，2026-10-09）

- **是什么**：全局看板右上「⌃ 收起」按钮本来就该收起**过滤排整排**（项目/版本/状态/模型/标签/搜索两排），此前 bug 是 `gb-filter` 不受 `topHeaderOpen` 门控——点收起只藏了标题行，过滤排纹丝不动（damo「收起现在好像没啥用」）。修复后收起 = header + 过滤排全收，内容区吃满；右下不再飘 absolute FAB（收起后它正好盖住操作行「+新建」），改**文档流右上小条**「⌄ 展开」点一下全展开（过滤状态存 ref，重开不丢）。
- **v7 追加（damo「全局看板大字多余」）**：header 里大字「全局看板」h1 删除——面包屑已有「全局看板」，header 紧凑一截（~90px → 64px）。
- **实现**：`spa/src/views/GlobalBoard.vue` `gb-filter` 加 `v-if="topHeaderOpen"`；FAB 包进 `.gb-collapsed-bar`（flex 右对齐小条）；`.gb-title` 删。

### 功能点：全局看板视图模式浏览器缓存（R235，2026-10-10）

- **是什么**：裸链接 `/#/global`（不带 `?mode`）打开时，自动恢复**上次显式点选**的视图模式（kanban / cards / list / grouped / chat），不再每次都回落 viewport 缺省。优先级：URL `?mode=`（显式指定，最优先）> localStorage 缓存 > viewport 缺省（H5=cards / 桌面=kanban，从未点选过的新访客行为不变）。
- **边界**：只有用户**点选**模式按钮才写入缓存（`setViewMode`）；渲染/回落路径不写——避免纯访客被「顺手」写入 viewport 缺省，导致桌面写入 kanban 后手机打开被挤压（正是 R58.5 动态缺省想避免的场景）。URL `?mode=` 进来不写缓存（临时显式指定，不改变后续裸链接行为）。
- **实现**：`spa/src/lib/board-mode.ts`（key `ao_global_mode`，ref 响应式 + 静默降级，同 theme.ts 口径）+ `GlobalBoard.vue` `viewMode` computed / `setViewMode`。测试 `spa/src/lib/board-mode.test.ts`（6 条）。

### 功能点：全局看板「活跃/历史」chip 宏 + 全部 11 态混选（R236，2026-10-10）

- **是什么**：`/global` 筛选排的「活跃 | 历史」开关从 header 挪进**状态 chip 行头部**，语义从「切页」变成**状态分组快捷键**（chip 宏）——点「活跃」= 一键选中 7 个活跃状态、点「历史」= 选中 4 个终态；chip 行同时展示**全部 11 个状态**（此前终态 4 个只在历史页可见）。任意状态组合可自由点选，**跨组混选**（如运行中 + 已完成）双段都拉、同屏显示。
- **行为**：点 preset 且当前恰好是该组全选 → 记为 preset 亮灯；自定义混选时两个 preset 均灭。再点已亮的 preset 会**重置**回该组全选（清除自定义混选）。选中集写 URL `?statuses=`（逗号分隔），可分享/刷新保持；preset 视图写 `?statusGroup=active|terminal`（R59 行为不变，单段加载）。
- **实现**：后端 `/api/tasks/page` 新增 `statuses` 精确状态集参数（**AND 语义**——在 statusGroup 段内收窄；跨组混选时前端拉 active+terminal 两段，每段各自 AND 出组内选中子集，天然不重不漏。曾做「优先于分组」语义，实测两段返回同一份行集导致渲染重复 + total 翻倍，已废弃并用测试钉死）。前端混选时每段窗口 = `floor(pageSize/2)`（`currentPerSeg` 统一 offset/limit/翻页数学），total = 两段服务端 total 之和。测试 `src/lib/db/tasks-page-status-group.test.ts`（14 条）。

### 功能点：版本页「活跃/历史」chip 宏 + 分类视图入口（R244，2026-10-12）

- **是什么**：具体版本页对齐全局看板（R236 + 分类视图）两件套——①版本页顶部 chrome 的「活跃 | 历史」segmented **撤除**，挪进下方状态 chip 行头部改当**分组宏**（在「状态」标签与 chip 之间）：点「活跃」= 全选 7 个活跃态、点「历史」= 全选 4 个终态，亮灯判据 = 当前 chip 选择恰等于该组全集；组内自定义子集时两个都灭，再点即回全集。②视图切换器在 看板/卡片/列表/聊天 之外新增**「分类」**（文件夹图标）= 复用全局看板同一份分类视图组件（未分类池 + 自建分类卡片，拖拽入列），该模式下过滤行整行隐藏（过滤条件对分类视图全部无效，藏掉防「点了没反应」）。
- **与全局看板 R236 的差异**：版本页是服务端分页（`/api/tasks/page?statusGroup=` 必填），不支持全局看板的 11 态跨组混选——宏 = 一键切组 + 清自定义筛选（重复点击同一组也重置）；数据段随宏切换（active/terminal 单段）。
- **chat 模式（R244 反馈迭代，2026-10-12）**：chat 下宏同样生效——点「活跃」/「历史」= 显式写 `?statusGroup=`（服务端按段拉，会话列表只显示该段）；**再点已亮宏 = 清回缺省全状态**（R221 语义保留：URL 无 `statusGroup` 时 chat 拉 `all`，任务失败/完成不从会话列表消失）。缺省双灭（全状态），显式切段后对应宏亮。
- **实现**：`spa/src/views/BoardPage.vue`（filter 行插宏 segmented 复用既有 `.board-segmented`/`.seg-btn` 样式；`setStatusGroup` 宏化去早退 + `activePresetOn`/`terminalPresetOn` computed 镜像 GlobalBoard R236 `statusSetEq`；`viewMode` whitelist + `board-body` 链首挂 `CategoryBoardView`；`loadPage` category 早退省一次分页请求）+ `spa/src/views/VersionDetailView.vue`（chrome 侧 vd-segmented 与其样式删除；view-switcher 加 category）。`CategoryBoardView.vue` 组件本体零改动。
- **验证**：vite preview + chrome-devtools 实测——历史宏（URL `?statusGroup=terminal` + chips 切终态 4 个 + 宏亮灯）、分类视图渲染（未分类池 + 分类卡 + 过滤行隐藏）、组内子集两宏齐灭 + 重复点活跃回全集清 `?statuses=`。

### 功能点：分类视图拖拽排序 + 卡片放大（R245，2026-10-12）

- **是什么**：分类视图（全局看板 + 版本页共用 `CategoryBoardView`）三件套——①**分类面板左右拖动**：每个分类卡头部有 `⠿` 把手，拖把手到目标分类左/右半（边缘蓝色插入线指示落点）松手即重排，顺序 `PUT /api/pin-lists {orders:[{id,sort_key}]}` 持久化，刷新保持；未分类池固定最前不参与。②**任务上下拖动排序**：列表内拖任务卡到目标卡上/下半（box-shadow 蓝线指示插入位）落位，同列 = 纯重排、跨列 = mv + 落位插入（不再是只能追加到末尾），`PUT /api/pin-lists/{id}/items {item_ids}` 整组持久化。③**任务卡片放大**：参考看板卡片——上行程（状态点 + 项目名），标题 13px 可换行（2 行截断），data chips 底部 wrap。
- **实现**：`spa/src/components/CategoryBoardView.vue`（拖拽状态 dragListId/dragListEdge + dragOverIdx/dragOverIdxList；`moveTo(list, taskId, insertIdx?)` 支持插入索引 + 同列 reorder；把手 dragstart 挂 grip 元素防与任务拖拽冲突）+ `spa/src/api/pin-lists.ts`（新增 `reorderPinLists`，注意后端契约 body 包 `{orders}` 一层）。后端零改动（排序接口本就齐：列表 PUT + 条目 reorder）。
- **验证**：vite dev + chrome-devtools 合成 DnD 事件实测——分类拖到右半边缘线亮 + 顺序重排 + PUT 200 + 刷新保持；任务跨列插入位置正确（插目标卡前而非 append）；同列两任务拖动反转顺序 + 刷新保持；卡片 13px/padding 9px 11px/column 布局生效。

### 功能点：全局看板分类视图接入筛选（2026-10-13）

- **是什么**：修复 damo 反馈「`/global?mode=category` 下状态 chip / 搜索框不管用」——分类视图组件自拉数据（`/api/tasks?limit=500`）原本完全不感知 URL 筛选。现在全局看板把 chip 行选中集（`statuses`/`statusGroup`）+ 搜索词（`q`）传进分类视图：**未分类池**和**分类列内任务卡**按状态 + 标题过滤；missing 灰条恒显（清理入口）、idea/node 条目不参与任务筛选；分类列计数显示可见数；未分类池被筛空时文案区分「当前筛选下无任务」（滤前有料）vs「全部任务已归组」（滤前就空）。筛选只影响展示，不动 pin 关系。
- **边界**：版本页的分类模式不变（过滤行整行隐藏 + 不传 props = 不过滤，props 可选向后兼容）；project/model/tag 等其他筛选条件在分类视图下仍不生效（未接入）。
- **实现**：`spa/src/components/CategoryBoardView.vue`（新增可选 props `statusFilter`/`search` + `matchFilter`/`itemVisible`，列内条目 `v-show` 不破坏拖拽 idx 语义）+ `spa/src/views/GlobalBoard.vue`（category 分支透传 `:status-filter="selectedStatuses" :search="debouncedSearch"`）。后端零改动。
- **验证**：`npm run build` 绿；部署后 live 实测 `#/global?mode=category&statuses=pending` 未分类池只剩 pending、清筛选条目回位。

### 功能点：全局看板列表模式表头 sticky 置顶（R237，2026-10-10）

- **是什么**：`/global?mode=list` 列表模式滚动时，表头行（`标题/项目/版本/状态/类型/更新时间/操作`）钉在表格卡顶部不随行滚走，任意位置都能对上列含义；列对齐由真实 `thead` sticky 保证（非复制表头），不存在错位/丢间隔。
- **实现**：根因是 `.gb-list-table-wrap` 的 `overflow:auto` 让 thead 的 sticky 相对一个永不滚动的容器而失效（thead CSS 本来就在）。修法 = 表格卡改「长列表时内部滚动」（`.gb-list-wrap` flex:1 + wrap `flex:0 1 auto; min-height:0`，同 kanban/grouped 列的锁视口惯例）：短列表卡片保持内容高、分页仍贴底；长列表卡内滚 + 表头钉住。另 `border-collapse` collapse→separate(spacing 0)，规避 Chrome/FF sticky 表头底边线不随行的渲染怪癖。手机（≤767px）文档流行为不变（卡内横滑保留）。
- **验证**：vite dev + chrome-devtools 实测 37 行列表滚至中部表头钉住（theadTop≈wrapTop）、5 行短列表不拉伸、375px 无横向泄漏。

### 功能点：版本页 board-header 空行删除（R217v7，2026-10-09）

- **是什么**：版本页 chat 模式原来在面包屑和过滤排之间有一条 `board-header` 空行，里面只装一个「收起 chrome」按钮——而它 toggles 的状态只门控它自己和 FAB（收起自己，damo「自己还占用一行」「现在就收起自己」）。整行删除：过滤排直接跟在 vd 头部下。版本页 chrome 折叠唯一入口 = VersionDetailView 的「收起/展开」（`version-chrome-open-v1`，默认收起，折叠态面包屑行尾有 FAB 兜底展开）。
- **实现**：`spa/src/views/BoardPage.vue` 模板 header+FAB 块、`topHeaderOpen` 状态机、`.board-header` / `.board-chrome-toggle` / `.board-chrome-fab` CSS 全删。

---

### 功能点：聊天模式右侧任务操作面板 + 会话归属行（R217，2026-10-08；同日 damo 返工 v2，次日再返工 v3/v4）

- **是什么**：聊天模式（`/global?mode=chat` 与版本页 `?mode=chat` 共用 `ChatView.vue`）的**任务操作两件套** = 详情页同款组件直接复用（v2 返工：首版自制 9 行元信息面板被否；v3 再返工：右栏竖排按钮太挤被否，damo「操作按钮在聊天内容的上方一排，一行拍下来」）：
  - **操作行** = `TaskStatusBar`（v3：从右栏挪到**聊天内容上方全宽一行**，面包屑行之下，窄窗口自动换行；v6：背景铺满整行——padding/border 由 `tsb-root` 自带，不再悬浮）：状态 chip + 生命周期按钮组（LifecycleActions slot，paused 态弹 ResumeModal）+ 📜完整会话 / 视图链接 + ◨面板 / 🔍搜索 / ⭐评分 / Fork / ➕新建 / 显示模式循环。**视图链接二选一**（v6，damo「本来就是聊天视图，这个不需要」）：详情页嵌 = 💬聊天视图；聊天模式嵌 = 🗗**任务视图**（跳 `/tasks/<id>`，效果同点面包屑标题）。
  - **信息面板** = `RightDock` 4 accordion（v4：右栏 = 纯面板，标题挪面包屑；v6：标题不用推行尾，紧接 `#taskid` 自然排）：🗂详情（PROMPT / 关系图 / 元信息 / 总结）/ 🕒时间线 / 🧷Checkpoints（含 Fork from here）/ 🔗Commits，各自内部 fetch；时间等元信息展示全在面板内部 → 自动走统一 `parseDbTime` 格式化（damo「时间也需要调整格式化，统一的那个」）。
- **右栏拖拽调宽**（v3）：主区 ↔ 右栏之间有拖拽手柄（详情页 B243 同款），280~800px 可拖，localStorage `task-right-dock-width-v1` 与详情页**共用** → 两页宽度互通；默认 480px。
- **搜索/评分/显示模式接线**：🔍 直通 chat 内 transcript 搜索条（`TaskTranscriptEmbed` search v-model）；⭐ completed/rejected 态展开 `TaskEvaluationBar`；显示模式循环作用于 transcript 渲染。
- **状态互通**：4 面板折叠态（`task-right-dock-v1`）与显示模式（`task-display-mode-v1`）localStorage key 与任务详情页**共用** → 两处状态互通（详情页折叠了详情面板，chat 里也同步折叠）。
- **归属行**：左侧会话列表每项标题下显示「项目名 › 版本名」小字归属；取名顺序 = 当前 scope 上下文（BoardPage 嵌入传入）> names map > id 前 8 位兜底。版本域列表项归属行按设计隐藏（页面上文已是项目 › 版本）。
- **开合**（v4/v5 简化，damo「详情按钮可以去掉」「h5 参考详情页带 X 的面板」）：只有**一个**开关 = 操作行 ◨按钮，收 = 整个右栏收起（v2/v3 时代只隐面板留标题头，damo 反馈「收不起来」）；`task-right-dock-collapsed-v1` 与详情页**同 key 同语义**。面包屑行尾「详情」toggle 已删除，原位置改放**任务标题超链接**（点击跳任务详情页）。**右栏顶部有详情页同款「信息面板 + ×」标题行**（PC / H5 都显示，× = 收起）。**≤900px（H5）右栏改抽屉**：fixed 右滑入（宽 `min(360px, 90vw)`）+ 半透明遮罩点击关闭 + ESC 关闭，不再是完全看不到。
- **实现**：`spa/src/views/chat/ChatView.vue`（操作行 + 信息面板 + Fork/Resume 弹窗 + 归属行，单点改动两种 chat 同步生效）+ `spa/src/views/BoardPage.vue` / `VersionDetailView.vue`（传 `project-name` / `version-name` prop）。

---

### 功能点：新建聊天项目/版本选择器 + 模型/强度常显（R220，2026-10-08）

- **是什么**：聊天模式「+新建聊天」卡片顶部新增**项目 › 版本**级联选择器（均带模糊搜索），新建会话不再被外部筛选上下文锁死：global chat 没选项目筛选也能选任意项目/版本创建。
- **默认值**：当前激活上下文（global = 左侧筛选栏选中的项目/版本，联动跟随）；用户手动改过选择器后不再被筛选变化覆盖。
- **版本级联**：选项目后自动拉该项目版本列表，label 带项目名前缀消歧（跨项目版本重名常见），含「不挂版本」选项（允许建不挂版本的任务，与 TaskNew 一致）。面包屑「项目上下文」同步显示所选项目。
- **模型/强度常显**：advanced（模型 / 强度 / 最大轮次 / 自动审批）入口从纯齿轮图标改为常显「`默认模型 · high`」chip（当前值一眼可见），点击展开改。—— 此前模板用了 `<Select>` 但未 import，advanced 展开后下拉解析失败根本渲染不出来（「没法选模型、思考程度」的根因），已修。
- **实现**：`spa/src/views/chat/ChatView.vue` 单文件（import Select / ctx 状态 + 级联拉取 / createTask 用 effective 上下文 / chip 常显 / 卡片高度约束防溢出）。

---

### 功能点：chat 会话列表显示全部状态（R221，2026-10-08）

- **是什么**：聊天模式左侧会话列表不再按「活跃/历史」分段——**强制全状态**（`statusGroup=all`），任务失败/完成后**留在列表里**（状态 chip 变化，行不移除），能直接点进去看失败原因。此前 chat 模式默认只拉 active 段，任务一进终态就从会话列表消失（R221 damo 报告）。
- **分段按钮**：chat 模式下隐藏「活跃/历史」切换（该模式下切换不生效，藏按钮防「点了没反应」假死感）；其余视图（看板/卡片/列表）行为不变。
- **实现**：`spa/src/views/BoardPage.vue`（`effectiveStatusGroup` computed：chat 模式强制 `all`，`buildParams` / SSE 事件 / watch 链全切到它；`all` 下 SSE 跨段原地 patch）+ `spa/src/views/VersionDetailView.vue`（隐藏分段按钮）。服务端 `StatusGroup` 本就支持 `all`，纯前端修复。

---

### 功能点：chat 会话列表删除即时摘除（R230，2026-10-09）

- **是什么**：聊天模式左列表删除会话后，该条**立即从列表消失**，选中态清空、URL `taskId` 参数同步移除；任务详情页删除后自动退回上一页。此前删除只弹 toast，列表纹丝不动，已删会话仍挂在列表里（R230 damo 报告）。
- **根因**：删除链路全程无信号——后端 `DELETE /api/tasks/[id]` 纯软删不发 SSE 广播；`LifecycleActions` 删除分支 `return null` 不 emit 事件，父组件（chat 左列表 / 详情页）完全无感知。
- **实现**：`spa/src/components/LifecycleActions.vue` 删除成功返回 `'deleted'` 哨兵值（非 TaskStatus）照常 emit；`spa/src/views/chat/ChatView.vue` `onSideStatusChanged` 收到哨兵后写入 `locallyDeletedIds` 本地过滤层（`liveTasks` computed 摘除）+ 清选中 + 清 URL 参数；`spa/src/views/TaskDetailView.vue` 收到哨兵后 `router.back()` 退走（无历史回首页）。宿主列表下次全量拉取时后端 `deleted_at IS NULL` 过滤自然一致。

---

## 常见问题

**Q: 任务卡在「排队中」不动怎么办？**
A: 检查全局并发是否已满（设置页显示运行/排队数），或是否有同 cwd 的任务在运行（互斥）。调整并发数或取消占用槽位的任务。

**Q: 启动和重启有什么区别？**
A: 启动（start）保留已有对话历史，从上次中断处继续；重启（restart / 清空重来）清空 session_id，用原始 prompt 从头开始一个全新 session。

**Q: 超时后任务变暂停了，怎么继续？**
A: 在任务详情页处理待审批的工具或回答 Agent 提问，然后点击恢复按钮。超时定时器会重新计时。

**Q: 依赖任务被驳回了，当前任务会怎样？**
A: 不会自动触发。依赖检查仅在前置任务变为 `completed` 时通过。前置被驳回时需手动处理：修改后重新启动前置任务，或手动取消依赖关系。

### Goal-Driven Loop

在 prompt 末尾加 `<goal>...</goal>` marker + 用 `goal_report` 块自报告，agent 跑到满足条件才停。适用场景：文件检查 / 数据校验 / 代码自查 / 状态转换等有明确「完成判据」的 task。

详见 [18-goal-loop.md](./18-goal-loop.md)。CLI 用法：

```bash
scripts/ao-dispatch.sh -p creative-studio -t "fix: ..." \
  -m "...<goal>docs/foo.md 第一段第一个词是 'bar'</goal>"
```

三态判定：`met` → reviewing / `not_yet_met` → 续跑最多 5 轮 / `impossible` → failed。

### 顶栏全局任务搜索：R180

系统右上角账号区左侧有一个常驻搜索框，输入关键词（≥防抖 250ms）即在下拉中列出匹配任务，**回车或点击**任一条直接跳转该任务详情页。不用先进某个项目/看板再找。

- **搜索范围**：任务 ID（粘半段 UUID 即可）/ 任务名称 / 状态（如 `running`、`pending`）/ 标签，子串匹配、英文不区分大小写
- **结果排序**：按 `updated_at` 倒序，最多 20 条；每条显示状态圆点 + 标题 + 状态中文 + 短 ID
- **展示所属项目 / 版本**（R209）：每条结果在标题下方以弱化小字展示任务所属**项目名 · 版本名**（同名任务一眼可分）；后端 `?search=` 场景 LEFT JOIN `projects`/`versions` 取真名，未归属任务（legacy unassigned）不显示该副行
- **键盘操作**：`↑` `↓` 移动高亮，`Enter` 跳转高亮项，`Esc` 关闭下拉
- **一键清空**（R180 迭代）：有输入时输入框右侧出现 `×`，点击清空关键词/结果并关闭下拉，焦点自动回输入框
- **入口位置**：顶栏（所有页面常驻，登录后可见）；移动端（≤1023px）隐藏——H5 走各看板自带筛选
- **防浏览器自动填充**（R210）：输入框带 `name="task-search"` + `autocomplete="off"`，浏览器（Chrome autofill）不会再把保存的邮箱等资料自动填进搜索框（此前 settings 页有 email 字段上下文，裸 input 会被 Chrome 启发式误判填充）
- **实现**：`spa/src/components/TaskSearchBox.vue`（挂 `AppHeader.vue`）+ `GET /api/tasks?search=<kw>`（`listTasks` LIKE 过滤，owner 隔离由鉴权保证）；测试 `src/lib/db/tasks-search.test.ts`（8 条）+ `src/app/api/tasks/route.test.ts` search 段（2 条）

### 功能点：API 错误（429 等）正确进 failed，不再伪装成待审核（R182）

Agent SDK 在 API 层错误（429 限流 / 鉴权失败 / 周配额用完等）时**不走** result 的 error 路径，而是以 `model="<synthetic>"` 的 assistant 消息 + `subtype=success` 的 result 正常收尾。旧版只看 subtype → 零 token 消耗的报错任务进 `reviewing`，看着"正常待审"实际一个字没跑（2026-10-04 实测 7 个 glm-5.3-flash 撞周配额的任务全中招，其中 3 个标题还被 auto-rename 改写成「API Error: Request re…」）。

- **新行为**：synthetic API 错误消息 + success result → 任务翻 **`failed`**，`error` 字段带 `api_error:` 前缀 + 原始错误文本（详情页一眼看出是配额/鉴权问题，不是 agent 干砸了）
- **不误伤**：只在 `model="<synthetic>"` 且文本以 `API Error` 开头时触发——agent 正文里讨论 "API Error: …"（真模型输出）照常进 reviewing；同一会话报错后又有正常轮次，以最后的正常轮次为准
- **连带修复**：auto-rename 的 LLM 兜底档（`llm-summarize.ts`）遇到同样的假 success 时不再把错误文本截 22 字当任务标题
- **恢复方式**：failed 后等配额重置，详情页发一句「继续」或用 restart 即可重跑（会话上下文都在）
- **实现**：`src/lib/runtime/active-session.ts`（syntheticApiErrorText 打标 + result 分支守卫）+ `src/lib/runtime/llm-summarize.ts`（错误文本返 null）；测试 `src/lib/runtime/synthetic-api-error.test.ts`（3 条）+ `llm-summarize.test.ts` R182 段（1 条）

### 功能点：留言排空死循环防护（api_error failed 不再自动重拉，2026-10-07）

任务终态 + 有未消费留言时，平台会自动 resume 排空（`reason=drain_stranded`）。但当失败原因是 **API 层错误**（`error` 带 `api_error:` 前缀，如 429 月配额用完）时，agent 起跑即挂、留言永远无法被消费 → 「failed → drain_stranded 重拉 → 再 failed」每 ~3.5 分钟一轮无限循环，烧到配额重置为止（2026-10-07 task `49c6d986` 实证：429 月配额 + 用户留言「怎么失败了」→ 4 小时循环数十轮）。

- **新行为**：`failed` 且 `error` 以 `api_error:` 开头的任务**跳过**自动排空；留言保留在队列里，等配额恢复后人工 resume（详情页发消息/点启动）时照常消费。
- **不变**：普通 failed（agent 干砸）、completed / cancelled / rejected 等终态的留言排空照旧；LLM fallback 链（R175）行为不变——链上还有可用凭证时任务会在同一次 start 内换凭证重跑，不落到这条防护上。
- **实现**：`src/lib/runtime/agent-runtime.ts` `maybeDrainStrandedMessages` 首行守卫；测试 `src/lib/runtime/status-change-reason.test.ts`（+2 条：api_error 跳过 / 普通失败不回归）

### 功能点：429/配额类 API 错误同凭证不重试 + error-only turn 判 failed（R212，2026-10-07）

R182 修的是「终态判错」，但链路前后段还剩两个洞（2026-10-07 task `6af660e4` 实录：resume 后撞 ark 月配额 429，SDK 对**同一凭证**退避重试 10 次耗时 ~3min 才以 synthetic 收尾，全程零产出干等；且 R182 清标判据过宽，error-only turn 有被洗成 reviewing 的风险）。damo 2026-10-07 拍板：「同一个凭证不重试」。

- **新行为 1（配额快速失败）**：流内**首次**命中 429/配额类信号（HTTP 429 / `AccountQuotaExceeded` / `monthly usage quota`；SDK 官方 `api_retry` 与 transcript 转发的 `api_error` 两种形态都认）→ 立即 `query.close()` 终止本次 query，不等 SDK 重试耗尽。随后：零进度且 fallback 链还有下一档 → 换凭证重跑（`llm_fallback` 留痕，无中间 failed，与 R175 语义一致）；链尽 / 已有进度 → 直接 `failed`，`error` 带 `api_error:` 前缀（drain_stranded 防线自动接管）。已有进度时不换链重跑（进度丢失不可接受）。
- **新行为 2（error-only turn 判 failed）**：R182 清标判据收紧为「实质产出」= 非空文本或 tool_use（含流式 `content_block_start` 的 tool_use）；空壳 finalized 消息（includePartialMessages 下恒空）不再洗标 → synthetic 报错 + 空壳 + success = `failed(api_error:)` 而非 reviewing。**SDK canned no-op 应答（"No response requested."，整块恰好这一句）也不算实质产出**（2026-10-07 taoke `218c47dc` 实录：resume 注入轮先回了这句 no-op，随后排队消息撞 ark 月配额 429，被误判「已有进度」不换链 → 直接 failed；修复后 no-op 不挡换链）。
- **不变**：非配额类错误（网络 / 5xx / overload / 鉴权）保留 SDK 默认重试，行为不变；正常 turn 照常 reviewing；R175 链语义、R182 恢复方式（等配额重置后发「继续」/ restart）不变。
- **实现**：`src/lib/runtime/active-session.ts`（`extractQuotaSignal` 识别 + api_retry/api_error system 分支 close + start/resume 终态处理 + `hasSubstantiveOutput` 收紧 + `NOOP_REPLY_RE`）；测试 `src/lib/runtime/quota-fast-fail.test.ts`（10 条）

### 功能点：自动标题质量加固（damo 1004 二次投诉修复，回归 task 7b921e1b）

reviewing 时自动改标题（auto-rename 三档策略：checkpoint 短路 → LLM 兜底 → prompt 提取）两处质量修复：

- **第 1 档 checkpoint 短路选条优化**：多条达标（>30 字符）summary 时，优先选**含 prompt 需求编号**的那条——从 `task.prompt` 提 `/R\d{1,4}/` 编号，summary 命中任一编号者优先；都不含再按原顺序取第一条（原行为）。修的是：任务 `7b921e1b`（飞书 R176）step-2 中间步骤 summary 短路命中、step-3 含「飞书 R176」的收尾 summary 落选，标题被截成「改 3 个 SPA 视图加正向标志 + d…」且 `title_lock=auto` 后永不刷新。
- **LLM 兜底档喂 `task.result`**：`summarizeTitle` 输入新增 `taskResult`（agent 最终总结，内容最全的数据源），与 promptHead / checkpointSummaries / latestTranscript 并列（reviewing 转换时 result 已落库，直读 task 即得）；prompt 加一条标准：标题必须含需求编号（如 R176）+ 实际改动对象，不许只写实现细节。
- **不变**：`title_lock` 三态语义（manual 永不覆盖 / auto 只改一次 / 空=可改）、`CHECKPOINT_TITLE_MAX_CHARS=40`、checkpoint 捕获机制。
- **实现**：`src/lib/runtime/auto-rename.ts` + `llm-summarize.ts`（`taskResult` 入参 + prompt 标准）。
- **🔴 R200 turn2 撤档**（damo 1006 chat 反馈「checkpoints 质量不好、不可控，包括标题」）：auto-rename 收敛为**两档策略 = LLM 提炼（唯一主档，走统一 summary 模型链，见 `src/lib/runtime/summary-llm.ts`）→ prompt 提取兜底**；checkpoint summary 切片短路整档撤除（checkpoints 仍作为 LLM 输入之一），`pickCheckpointSummary` / `summarizeToTitle` / 40 字符截断逻辑随之删除。附带修复：原 `summarizeTitle` 的 systemPrompt 因 `runSingleTurnLlm` 首参被丢弃而从未到达 SDK（R144 长度硬约束一直没生效）——统一链内部拼接后修复。`title_lock` 三态语义不变；存量坏标题（lock=auto）不批量重刷，需要时在详情页手动改（=manual lock）。

### 功能点：看板运行中任务实时资源徽章（R232，2026-10-10）

- **是什么**：任务看板（cards / list / kanban 三视图 + 任务详情页）上，**运行中任务**卡片显示实时 CPU / 内存占用徽章：`CPU 5.9% · 596.6MB (5%)`。悬浮显示明细（进程数 + pid 列表、单核/全机两种 CPU 口径、采样时间）。CPU>80% 或内存>50% 徽章转橙色警示。进程退出（任务到终态）徽章自动消失。
- **怎么工作**：agent SDK 子进程 env 由 `buildEnv()` 注入 `ORCHESTRATOR_TASK_ID`（子进程树继承）→ 后端扫 `/proc/*/environ` 反查同 task 的全部进程 → 读 `/proc/<pid>/stat` 聚合 CPU jiffies（差分基线，采样窗=轮询间隔）+ RSS 页数 → `GET /api/tasks/resources` 批量返回（按 owner 过滤，只返回本人任务）。前端 `useTaskResources` 单例 composable 轮询（R234 起自适应节拍：有运行中任务 3s、空闲 10s，并经 `/api/events` status_change 去抖 1s 补采；引用计数，多视图共享一个调度链；页面隐藏暂停，详见下方 R234 功能点）。
- **口径**：CPU% 是**单核口径**（进程树合计，可 >100）；全机口径 = 单核值 ÷ 核心数（title 里给）。内存 = 进程树 RSS 合计 ÷ 全机 MemTotal。
- **🔴 只统计 running 任务**（2026-10-10 修正）：agent 在任务里起的 dev server / pm2 业务服务会继承 `ORCHESTRATOR_TASK_ID` 且任务结束后长期存活，env 反查会把它们记到**非 running 任务**头上（实证：reviewing 任务被记 206MB，实为其遗留的 vue-cli dev server）。API 现按 task status 过滤，非 running 命中的都是遗留服务进程，不出徽章；这些服务多为部署产物**不可杀**，只是不算任务占用。
- **实现**：`src/lib/runtime/task-resources.ts`（/proc 扫描 + CPU 差分）+ `src/app/api/tasks/resources/route.ts` + `spa/src/composables/useTaskResources.ts` + `spa/src/components/TaskResourceBadge.vue`；挂载点 `BoardPage.vue`（cards meta 行 / list 状态列）/ `KanbanBoard.vue`（`resources` prop）/ `TaskCard.vue`（`resource` prop）/ `TaskDetailView.vue`（状态栏下资源行）。测试 `src/lib/runtime/task-resources.test.ts`（9 条）。
- **防抖钉宽（R243，2026-10-12）**：数值每 2-3s 采样呼吸（实测 160.5↔185px）曾把 list 视图的 auto 布局表格整表重排——看板宽度每 2s 变、右列一抖一抖。修复：徽章 `min-width: 185px` + 内容居中（钉住常态宽度，数字呼吸只在内文变化）；kanban 视图豁免（列宽固定 280px 本就不受影响，豁免保 model 名空间）。验证：注入三种采样值循环，表格宽 / 右列位置全程恒定。
- **限制**：Linux-only（WSL / pulu 可用）；macOS 开发机上扫描返回空（无 /proc），徽章不渲染，无报错。

### 功能点：顶栏系统资源小块（R232 Round5 挪顶栏，2026-10-10，~~已移除~~）

> ⚠️ **2026-10-11 R235 追加移除**（damo 拍板「那两个条可以去掉了」）：顶栏只留 `HostGaugeRing`（单环/四环可切），「哪个任务占哪段」的任务级分段展示随条移除（任务级占用仍看看板卡片 badge）。以下为历史记录。

- **是什么**：**AppHeader 顶栏搜索框（「搜索任务 (ID / 名称 / 状态)」）左侧**一个 150px 紧凑小块（Round6 从 200px 压缩：padding/gap/行高收紧、bar 高 6→5px；位置 damo Round5 指定「输入框的左侧」），内含两行迷你分段条（CPU / 内存）：**整条 = 总可用资源**（CPU 条 = 全机 100%，内存条 = MemTotal），**彩色分段 = 各运行中任务占比**（hover 看任务名 + 占用值；无 running 任务时没有彩色段 = 正常），灰段 = 系统其他进程占用（Round6 起固定 `#9ca3af`——原先 `--tw-gray-300` 暗色主题下与轨道几乎同亮度，damo 实测看着像空条），底色 = 空闲/可用。行尾数值：CPU 全机已用 % / 内存已用 %。≤1023px 隐藏（对齐 TaskSearchBox 的 H5 策略，手机端顶栏 44px 放不下；H5 看任务级 badge）。普通用户看不到（服务端按 role 出数据，无权限时前端不渲染）。
- **挂载演进**（damo 两轮「没看到」教训）：Round3 挂 BoardPage filter 行 → Round4 补挂 GlobalBoard 第二过滤行 → damo 仍说没看到 → **Round5 判明真根因**：damo 说的搜索框 = 顶栏 `TaskSearchBox`（全页面常驻，placeholder「搜索任务 (ID / 名称 / 状态)」），不是看板内容区 filter 行的搜索框（placeholder「搜索标题、指令…」）；且 800px 窄视口下顶栏搜索框被 ≤1023px 规则隐藏，窄视口验证从来看不到它。Round5 挪顶栏 + 撤两处看板内挂载（顶栏全页面可见，内容区冗余）。**搜索框本身同步缩 230→200px**（damo R232 原话「差不多200px宽」）。
- **怎么工作**：`GET /api/tasks/resources` 对管理员额外返回 `host`（全机 CPU 差分 + MemAvailable）+ 全部任务样本 + `titles`；普通用户仍只返回本人任务，`host=null`。前端复用 `useTaskResources` 同一个轮询单例（单任务徽章与系统小块共用一份数据，不额外请求），节拍 R234 起自适应（运行 3s / 空闲 10s；采样间隔史：2s → 3s（damo 拍 3~5s 取下限）→ 自适应）。轮询 acquire 挂 `AppHeader`（mounted/unmounted 配对）；`BoardPage` 保留自己的 acquire/release 供列表 / kanban badge 消费。
- **实现**：`src/lib/runtime/task-resources.ts`（`scanHostSummary` + `/proc/stat` 差分）+ `route.ts`（admin 分支：`getTaskById` 不带 userId = 跨 owner 查询）+ `spa/src/components/SystemResourceBars.vue`（纯展示，段宽用剩余宽度递减 clamp 防溢出）+ 挂载点 `spa/src/components/AppHeader.vue`（搜索框左侧，44px 顶栏内收 padding/行距）。测试 `task-resources.test.ts`（13 条，含 host 真实采集 smoke）。
- **限制**：Linux-only 同单任务徽章；首次采样 CPU 全机差分无基线显示 0%，下一轮（3s 后）起正常。

### 功能点：前端常驻请求减负（R234，2026-10-11）

- **背景**：内网访问走 HTTP/1.1，浏览器**每域并发上限 6 个连接**。R232 后常驻请求 = 资源轮询 3s + Progress 页 3s 双请求 + 侧栏 counts 逐事件刷新，加上 SSE 长连接，切页时新请求一波容易把名额瞬间占满（R228 同根因，已修过 keep-alive SSE 泄漏，本轮收敛轮询/刷新侧）。
- **三处改动**：
  1. **资源轮询自适应节拍**：`useTaskResources` 从固定 3s 改 setTimeout 链式调度（对齐 `useBackendHealth`）——样本里有运行中任务（pids 非空）3s，空闲 10s；并订阅 `/api/events`（复用侧栏已开的全局流，零新增连接）`status_change` 去抖 1s 补采，任务起跑徽章 ≤1s 跟上，不吃空闲长节拍延迟。测试 `useTaskResources.test.ts`（8 条）。
  2. **Progress 实时进度页 keep-alive 感知**：该页每 3s 拉 `getStats + /api/tasks?limit=200` 双请求，此前被 `<keep-alive>` 缓存后切走**永不停**（20 次/分钟后台常驻）；现 `onDeactivated` 停表、切回按 autoRefresh 恢复，且后台 tab（document.hidden）跳过网络请求。
  3. **侧栏徽章刷新去抖**：`ProjectSidebar` 收 `status_change` 刷 `/api/stats/counts` 从逐事件改为 2s 尾随去抖——多任务并发状态翻转时事件秒级突发，合并成一次全量刷新；徽章最迟 2s 跟上。
- **效果口径**：空闲态常驻请求从 ~22 次/分钟降到 ~6 次/分钟（资源 6 + health 2 + maintenance 2）；运行态仍保持 3s 徽章精度。
- **实现**：`spa/src/composables/useTaskResources.ts` + `spa/src/views/Progress.vue` + `spa/src/components/ProjectSidebar.vue`；测试 `spa/src/composables/useTaskResources.test.ts`。

### 功能点：顶栏主机状态汇总圈 + 宝塔式四环弹层（R235，2026-10-11，仅管理员）

- **是什么**：顶栏资源条原位置一个**主机状态组件**，形态三选一（**popover 底部「顶栏形态」切换，localStorage 记忆**，damo 1011 拍板）：
  - **单环**（默认）：**迷你圆环**——弧长与颜色 = 负载 / CPU / 内存 / 磁盘 四项中**最差项**（<70 绿 / 70-90 琥珀 / ≥90 红）；**环内形态四档可切**（damo 1026，popover 底部「环内」：**无数字 / 仅数字 / 数字+% / 进度条**）——前三档环径自动适配（无数字 26px / 仅数字 29px / 数字+% 34px，环内显示最差项数值），**进度条**档整个替换为最差项 mini bar（`标签 + 微条 + 行尾 %`，如 `内存 ▓▓▓ 61%`）；
  - **四环常驻**：**迷你环 ×N**，环内文字三档可切（**无数字 / 仅数字 / 数字+%**，默认数字+%）；**环径随文字档自动三档**——无数字 26px / 仅数字 29px / 数字+% 34px（同 viewBox 等比缩放，小档描边更细；环内数字恒定 9.5px，% 符号单独 0.8 倍防贴边，damo 1011）；
  - **横条**：**微进度条 2 列**（选 4 项时 2×2：左列 负载/CPU，右列 内存/磁盘 + 行尾 %，260px 宽；**宽随指标数自适应**——≤2 项缩窄（1 项 150px 单列 / 2 项 216px 双列），3-4 项恢复 260px，damo 1011）。
  **指标自由组合**（popover 底部「指标」chips，damo 1011 拍板）：勾哪几个顶部显示哪几个——单环 = 所选指标的最差项，四环/横条 = 只渲染所选；至少保留 1 个（防头部入口消失）；popover 大圈恒显全 4 项。
  任一形态点击弹 popover（396px，H5 钳到 `vw-16`、四环自动 wrap 成 2×2），内放 4 个 **76px 宝塔式圆环**（负载 / CPU / 内存 / 磁盘，% 居中加粗着色），环下各带明细行：负载 `0.28 / 4核`、CPU `共 4 核`、内存 `6.3 / 11.7 GB`、磁盘 `300.8 / 1006.9 GB`。**窄屏强制替身**（damo 1026「350px 才强制成单个圈圈」，原 767px 阈值下 iPad/大屏手机也被压成单环，过激）：**仅 ≤350px 强制单环替身**（按「环内」配置渲染，点击同样弹 popover）；>350px 全部形态可用。**后台断开时环置灰**（半透明+去色，tooltip 前缀「后台断开」——host 数据停更，灰环=别信；连接状态本体仍由标题旁呼吸点表示，语义不混，damo 1011）。普通用户不渲染（复用 host 仅管理员口径）。
- **为什么做成可切**：宝塔原版圈圈 ~120px、圈内数字 20px+；44px 顶栏最多塞 ~36px 直径，圈内数字只剩 8-9px。damo 先拍「直接AB」（数据补齐 + 单环汇总 + popover 四环），看真机后改拍**加切换**（单环/四环都要），同时移除旧两条资源条。
- **怎么工作**：后端 `HostResourceSummary` 新增 `loadPercent`（`os.loadavg()[0] ÷ 核心数 ×100`，宝塔同口径，可 >100 = 过载）+ `disk`（`fs.statfs('/')`，used = total − bavail 含 ext4 root 保留块，**对齐宝塔显示口径**，WSL 实测 totalGB=1006.9 与宝塔完全一致）；复用 `useTaskResources` 同一个轮询单例（3s / 空闲 10s），**零新增请求**。popover 定位 / click-outside / Esc 关闭对齐 `AccountSwitcher` dropdown 模式（Teleport body + fixed，z-index 80）。
- **实现**：`src/lib/runtime/task-resources.ts`（scanHostSummary 补 load + statfs）+ `spa/src/components/HostGaugeRing.vue`（新增，含形态切换）+ 挂载点 `spa/src/components/AppHeader.vue`（`SystemResourceBars.vue` 已删）。测试 `task-resources.test.ts`（smoke 补 loadPercent + disk 断言，mac 不再 skip）。
- **手机顶栏让位（2026-11-04）**：414px 级手机上四环（数字+% 档 34px/环 = 162px）+ 用户区（名字≤80px + 头像）把顶栏固定元素合计撑到 ~394px > 可用 386px，中间 spacer 压成 0 → 左侧后台状态呼吸点贴死四环，呼吸 halo（放大 1.55 倍溢出 ~4px）与负载环视觉重叠。修法：AppHeader ≤480px 隐藏 `.user-name`（账号名在 AccountSwitcher 下拉可见，与 ≤1023px 藏 `.user-role` 同构），spacer 恢复 ~70px；375/360px 同受益，≤350px 由窄屏替身（单环）兜底。**四环/环内档不强制降级**（≤480px 仍可四环+%，damo 1026「350px 才强制单环」口径不变）。
- **限制**：Linux 走 `/proc`；macOS 开发机走 os API 兜底（R235 后续：数值 = Mac 本机真实值，5173 本地可见，CPU 首轮采样 0% 同 Linux 语义）；线上实际看 WSL/pulu 数值。磁盘 statfs 不可用时该环灰显 `--`；负载环弧 clamp 100 显示但数字保留真实值（过载可显示 150%）。

### 功能点：CPU/内存环叠「每个运行中任务」分段弧（R237，2026-10-11）

- **是什么**：主机状态圈的 **CPU 环和内存环**上叠加每个运行中任务的占用弧段——3 个任务在跑，环上就有 3 段不同色弧对应 3 个任务的资源占比（damo 1011「三段覆盖在现在的这个圈圈上面」）。**负载/磁盘不分段**（负载是系统级导出量、磁盘无进程归属）。覆盖三处圈：顶栏单环（所显指标为 CPU/内存时）、顶栏四环的 CPU/内存小环、popover 弹窗的 CPU/内存大环；横条形态不叠。
- **怎么读**：分段与底环同口径（0-100 全机 %）同路径依序累积——蓝色段 = 平台任务的占用，剩余底色弧 = 系统里其他进程的占用。段色为**冷色近邻族**（蓝→天蓝→青→靛，最多 6 段，之后合并为一枚灰色「其他 N 个」段），细微区分不刺眼（damo 1011「不用五颜六色」）；段间留细缝隙。**hover 任一段出 tooltip**：`任务「标题」· CPU 1.8% (全机口径)`。
- **怎么工作**：数据复用 `useTaskResources` 轮询单例（`taskResources` 的 `hostCpuPercent` / `memPercent`，3s 节拍，零新请求）；排序按 taskId 字典序——固定顺序保证两次采样间颜色不跳变（按值排序会导致相邻两拍颜色互换闪烁）。任务退出（pids 清空）后该段自然消失；无运行任务时环回到纯系统态。
- **实现**：`spa/src/lib/host-task-segments.ts`（纯函数：过滤 pids 非空 → 排序 → 累积 → 超量合并 + segDash 弧参数）+ 测试 `host-task-segments.test.ts`（9 条：空态/零值跳过/序稳定/无 title 兜底/超量合并/超 100 截断/clamp/dash 几何）+ `spa/src/components/HostGaugeRing.vue`（三处 svg 叠 `<circle>` 分段弧 + SVG `<title>` tooltip）。

### 功能点：任务流 SSE 共享订阅（R234 后续项，2026-10-11）

- **是什么**：任务详情页 / 看板聊天模式的任务流长连接收口到共享 hub `useTaskStream`——同页 `TaskDetailView`（头部审批/对话弹窗流处理）与内嵌 `TaskTranscript`（消息流渲染）原先**各开一条** `/api/tasks/{id}/stream`，同任务在详情页 + 聊天模式同开时甚至 3 条；收口后**每 url 恒 1 条**（引用计数 fan-out，各消费者各取所需事件），同页 SSE 从 3 条降到 2 条（全局 `/api/events` + 任务流），腾出 HTTP/1.1 每域 6 个并发名额。
- **重连语义**：1:1 移植 TaskTranscript 原实现（R20）——断线 3s 退避重连、20 次上限进 `closed`（防服务宕机无限打转）、401 探测 `/api/user/me` 命中即关停（router guard 跳登录接管）；`onopen` 归零重试计数。连接态（connecting/connected/closed + 重试计数）存 reactive registry，`TaskTranscript` 的 Spinner /「重连中 (n/20)…」UI 原样读。
- **行为统一披露**：`TaskDetailView` / `ChatView` 原先是 EventSource 原生无限重连，收口后统一 20 次上限——服务端持续宕机超 ~60s 流进 `closed`，重新激活页面（attach）才重试；换来 401 时不再无限重连（原先详情/聊天页 session 过期会无限打转）。
- **实现**：`spa/src/composables/useTaskStream.ts`（hub：单例 Map + 引用计数 + 有界重连 + reactive 连接态）+ 三消费者迁移（`TaskDetailView.vue` / `TaskTranscript.vue` / `chat/ChatView.vue` 删各自手写 EventSource 管理共 ~160 行）；测试 `spa/src/composables/useTaskStream.test.ts`（11 条：共享/fan-out/url 迁移/有界重连/401/上限后重试/分离后 timer 不触发生命）。

### 功能点：侧栏全局看板徽章「排队/运行」分段显示（2026-10-12 v2）

- **是什么**：左侧菜单栏「🌐 全局看板」右侧徽章的第一个数字后端口径一直是 running+queued 合并（排队任务也计入），看着像「都在跑」。现在**有排队任务时**显示两段拼接「**`{排队}/{运行}`**」——排队段在最左、各段纯数字，颜色按状态标签色区分（**排队=蓝、运行=青**，对齐任务状态标签 queued/running 色族）。例：2 个在跑 + 3 个排队 → 「**3/2**」；全部在排队 → 「3」；无排队 → 只显示运行数原样。hover 每段有状态提示（排队中/运行中）。
- **范围**：只改侧栏全局看板徽章（damo 指定）；项目/版本行徽章仍显示合并数字（蓝色）不变。
- **实现**：后端 `getTaskCountsByScope`（`src/lib/db/tasks.ts`）`ScopeCounts` 加 `queued` 纯排队字段——`running` 保持 running+queued 合并口径不变（master 老组件与其他消费方零影响）；前端 `ProjectSidebar.vue` `renderGlobalBadge` 把排队段插最左、运行段回纯运行数（CSS `.count-queued` + `.count-badge--global .count-running` sky 覆盖）；测试 `src/lib/db/tasks-scope-counts.test.ts`（3 条：合并口径+纯排队/无排队/多用户隔离）。（10-11 首版为括号形态「5(2)」，10-12 经 damo 反馈改两段拼接。）

### 功能点：「+」聊天式快速创建任务弹窗（R232 Round4，2026-10-10；Round7 补全）

- **是什么**：项目看板 / 全局看板右下角圆形「+」FAB、项目版本页 chrome 的圆形「+」按钮、看板空态 CTA，点击后**就地弹出对话式创建窗**（不再跳 `/tasks/new` 表单页）。弹窗形态参考聊天模式：顶部项目 / 版本两个下拉（**可切换**，项目页预选当前项目/版本，全局看板不预选），中间引导气泡，底部聊天输入框——Enter 发送（Shift+Enter 换行），发送即 `createTask` + `startTask` **立即启动**，弹窗关闭回到看板（SSE 自动把新任务插进列表，不跳转不丢上下文）。提交参数与 TaskNew quick 模式同口径（标题截 60 字 / autoApprove / effort high / maxTurns 200）。
- **Round7 补全**（damo 反馈「弹窗里没有附件和高级选项」「+ 偏下方」「刷新输入丢失」）：
  - **附件 + 高级选项回归弹窗**：输入框下方工具行加 📎 附件（chips 列表 + 可拖文件进输入区）与「高级」折叠区（配置 snapshot select + goal loop 完成条件/最大轮次）；提交口径与 TaskNew quick 模式完全同口径（snapshot 覆盖 autoApprove/effort/maxTurns/model/llm_config_id/allowedTools/tags/type + goalRounds + 附件两阶段上传）。
  - **草稿持久化**：弹窗输入 300ms 防抖写 localStorage，刷新/重开不丢，发送成功清空（附件 File 对象无法持久化，刷新后附件列表为空）。TaskNew 页快速/完整模式的 prompt 同样持久化。
  - **全局共享输入历史**：task 聊天 / 弹窗等所有 prompt 入口发送过的指令进同一份全局历史（上限 100），弹窗输入框 ↑/↓ terminal-style 召回（光标贴边才劫持，多行内部方向键仍移光标）。
  - **「+」图标居中**：三处圆形按钮的文本「+」受字体基线影响视觉偏下，换 SVG 十字几何居中。
- **实现**：`spa/src/components/TaskQuickCreate.vue`（Modal + Select×2 + 聊天输入区 + 附件/高级折叠区）+ 三个入口改造：`BoardPage.vue`（FAB 去掉 chrome 折叠隐藏 + 空态 CTA 改弹窗）/ `VersionDetailView.vue`（「+ 新建 Task」文字按钮改 34px 圆形「+」，damo 反馈「现在不是圆形」）/ `GlobalBoard.vue`（新增 46px 圆形 FAB——全局看板此前完全没有创建入口）。草稿/全局历史复用 `spa/src/lib/chat/input-history.ts`（`loadDraft`/`saveDraft` 按 key 隔离 + `loadGlobalInputHistory`/`pushGlobalInputHistory`）；`TaskMessageInput.vue` 发送时同步写全局历史。

### 功能点：SSE 订阅 keep-alive 收口 + 看板切项目流跟随（R233，2026-10-10）

- **是什么**：R228 逐组件手修了 4 处「keep-alive 切走关 SSE」，但走 `useTaskEventSource` composable 的 `BoardPage` 漏网——后台看板 tab 的项目事件流**不还名额**（HTTP/1.1 直连每域 6 个并发名额），来回切换多页后名额被吃光 → 所有接口请求（含发消息 POST）浏览器排队无限 pending，「点了不反应」。本轮把断流逻辑收口到 composable 层统一生效，另修看板切项目不换流的 bug。
- **修了什么**：① `useTaskEventSource` 加 `onDeactivated` 断流 / `onActivated` 重连（keep-alive 缓存组件切走不再漏关，所有调用方自动受益）；② url 支持 Ref/getter——`BoardPage` 是 keep-alive 复用实例，切项目时旧版传 `.value` 快照 = 订阅停留在首个项目的事件流（收不到新项目事件 + 旧流不关），现在 watch url 变化自动迁移订阅；③ url 变空串时先释放旧流再跳过（缺参不占名额）。
- **实现**：`spa/src/composables/useTaskEventSource.ts`（核心抽 `createEventSourceSubscription` 可独立测试，vue 钩子薄包装）+ `spa/src/views/BoardPage.vue`（传响应式 computed）。测试 `spa/src/composables/useTaskEventSource.test.ts`（8 条：共享计数 / 幂等 / url 迁移 / 空 url guard / 事件分发）。

### 功能点：SSE 断线重连自愈 + 侧栏兜底轮询（R245，2026-10-15）

- **是什么**：damo 实测任务 running→reviewing 翻转后侧栏「运行中」徽章不更新、手动刷新才消失。根因：`/api/events` 无 Last-Event-ID 回放，SSE 断线窗口（服务器重启 / 网络抖动 / 浏览器 tab 挂起恢复）内的 `status_change` 事件**永久丢失**，而侧栏徽章 / 看板卡片的刷新只挂「收到事件」——断线期间错过 = 状态僵死。
- **修了什么**（两层自愈，SPA only 不动服务端）：① **重连即刷**——`useTaskEventSource` 新增可选 `onReconnect` 回调，仅在「error 断线后重新 onopen」或「页面隐藏挂起后恢复重建」时触发（首次建连不触发，避免加载期多打全量接口）；② **消费方接入**——ProjectSidebar 重连时立即强刷 counts（绕过 2s 去抖）、GlobalBoard 重连刷 `loadMeta + refreshAll`、BoardPage 重连 `loadPage(true)`（自带驻留路由 guard）；③ **慢速兜底轮询**——侧栏每 60s 强刷一次 counts（`visibilitychange` 隐藏暂停 / 恢复可见立即刷一次），覆盖未知未知（如服务端漏推）。
- **实现**：`spa/src/composables/useTaskEventSource.ts`（Entry 加 `reconnecting` 标记 + `reconnectListeners` 广播）+ `ProjectSidebar.vue` / `GlobalBoard.vue` / `BoardPage.vue` 三消费方。测试 `useTaskEventSource.test.ts` R245 段 5 条（首次不触发 / error 后触发且单次 / 多订阅广播 / detach 解绑 / 挂起恢复视同重连）。

### 功能点：看板状态分组宏加「全部」+ 默认全部 + 记忆上次选择（R248，2026-10-26）

- **是什么**：全局看板 + 版本页的状态分组宏从「活跃 | 历史」两档扩成「全部 | 活跃 | 历史」三档——点「全部」= 11 个状态全集（双段同拉同屏）；**缺省组 = 「全部」**（首次访问不带 URL 参数时不再只看活跃）；三档选择**持久化到 localStorage**，下次裸链接打开看板自动恢复上次点选的组（URL 显式 `?statusGroup=` 仍最优先，如从任务详情页跳回）。
- **行为细节**：①宏 = chip 快捷键语义不变——点「活跃」= 全选 7 个活跃态、点「全部」= 全选 11 态，亮灯判据 = 当前 chip 选择恰等于该组全集，自定义混选时全部灭（再点 = 一键回该组全集）；②记忆 key 跟随看板既有的同步级别（不同步 = 按 project/version 各自记、弱同步 = 按项目共享、强同步 = 全平台共享一份），与 chip 顺序同一套 scope；③chat 模式行为等价保留——点宏写记忆生效、服务端按段拉，缺省（无记忆）= 全状态，任务失败/完成不从会话列表消失（R221）。
- **实现**：新增 `spa/src/lib/board-status-group.ts`（镜像 R235 `board-mode.ts` 模式：URL 显式 > localStorage 记忆 > 缺省 'all'；模块级 ref 缓存保 computed 依赖，写盘失败静默降级）+ `GlobalBoard.vue` / `BoardPage.vue`（`statusGroup` computed 走三级回落；`setStatusGroup` 宏 = 写记忆 + 清 `statuses`/`statusGroup` param 保 URL 干净；`toggleStatus` 恰好回到某组全集时同步写记忆；preset 亮灯加 `allPresetOn`；BoardPage 的 `statusGroupKey` 与 `chipOrderKey` 同一套 syncLevel 三级，chat 特判并入统一记忆模型删除）。
- **测试**：`spa/src/lib/board-status-group.test.ts` 7 条（无记忆回落 null / 非法值不回落野值 / 读写往返 / 多 key 隔离 / 刷新恢复 / localStorage 不可用静默降级）；全量 168 测试 + typecheck + build 通过。

### 功能点：「全部」宏反选（toggle 全不选）+ 真空态（2026-11-01）

- **是什么**：全局看板 + 版本页的「全部」宏升级为**切换开关**——已是全选态再点一次 = **全不选**（列表清空），之后再点**任意单个状态 chip = 只看该状态**，替代此前「想只看一个状态得把其余 9 个逐个点掉」的操作。再点「全部」回全选，行为对称。按钮 hover 有提示文案（"再点一次 = 全不选，然后点单个状态可只看该状态"）。
- **典型用法**：默认全选 → 点「全部」（全不选）→ 点「待审核」→ 只看审核任务；想看两个状态就再点一个 chip；点「全部」一键回全选。「活跃/历史」宏保持原语义（重复点击 = 回该组全集）。
- **真空态语义**：全不选 = URL `?statuses=`（显式空 param），刷新/分享后仍保持全不选。空列表显示「没有匹配筛选条件的任务 / 试试调整筛选条件」，不发多余请求（GlobalBoard 双段都不拉；BoardPage 客户端早退，后台 ETag 探针同步暂停）。
- **顺带修复**：版本页（BoardPage）此前把组内 chip 全点掉时，空串被当缺省回落全集 → 「点掉最后一个 chip 取消勾选失效」的隐藏 bug（GlobalBoard R236 早已支持真空态，两看板口径现已对齐）。
- **实现**：`BoardPage.vue` / `GlobalBoard.vue` 的 `setStatusGroup('all')` 加 `wasAllOn` 判定（全选态 → 写 `statuses: ''`）；BoardPage `selectedStatuses` 对 `raw === ''` 返回空 Set（对齐 GlobalBoard）+ `loadPage`/`checkIfChanged` 空集早退（省请求 + 防 total 残留全集数字出现「共 N 条 + 空列表」矛盾显示）。

