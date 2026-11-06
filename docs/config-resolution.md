# 运行时配置解析

任务执行时，多个配置项按 fallback 链逐级解析。本文档记录所有 fallback 链、解析时机、以及前端显示逻辑。

---

## 1. cwd（工作目录）

### Fallback 链

```
task.cwd → version.cwd → project.cwd → 隔离工作区
```

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `task.cwd` | 创建任务时手动指定（新建任务表单的"工作目录"字段） |
| 2 | `version.cwd` | Version 记录上的 cwd（`PATCH /api/versions/[id]`） |
| 3 | `project.cwd` | Project 记录上的 cwd（`PATCH /api/projects/[id]`） |
| 4 | 隔离工作区 | `$ORCHESTRATOR_HOME/projects/{projectId}/{taskId}/`（有 project）或 `$ORCHESTRATOR_HOME/workspace/{taskId}/`（无 project） |

### 解析时机

- **创建任务时**（`createTask`）：`task.cwd || versionRow?.cwd || projectRow?.cwd || null`，结果存入 tasks 表的 `cwd` 列。后续不再重新解析。
- **运行时**（`ActiveSession` 构造函数）：`task.cwd || 隔离工作区`。此时只看 task 表已存的值，不再查 version/project。
- **附件/消息等 API**（`resolveTaskCwd`）：同 ActiveSession 逻辑，`task.cwd || 隔离工作区`。

### 关键代码

| 位置 | 作用 |
|------|------|
| `src/lib/db/tasks.ts:66-70` | 创建时 fallback 链，结果写入 DB |
| `src/lib/runtime/active-session.ts:117-119` | 运行时解析（task.cwd → 隔离工作区） |
| `src/lib/db/attachments.ts:63-67` | `resolveTaskCwd()`，附件/消息等 API 用 |
| `src/lib/runtime/agent-runtime.ts:379,432,463,645` | fork/checkpoint 路径解析 |

### 前端显示

- **Version 看板**（`board-client.tsx`）：显示 `version?.cwd || project.cwd`，继承自 project 时标注「(继承自项目)」
- **任务详情**（`right-dock.tsx:404-407`）：显示 `task.cwd`
- **新建任务表单**（`tasks/new/page.tsx`）：cwd 字段为空时，后端自动走 fallback 链

> ℹ️ 曾有「project 有 cwd 但 version 没设时前端不显示 cwd」的显示缺口（`/unversioned` 页面 version 为 null 时整行隐藏），已于 2026-08-09 修为前端 fallback。

### 隔离工作区说明

当 task.cwd 为 NULL 时，ActiveSession 自动创建隔离目录：

```
$ORCHESTRATOR_HOME/
  projects/
    {projectId}/
      {taskId}/     ← 有 project 的隔离目录
  workspace/
    {taskId}/       ← 无 project 的隔离目录（历史遗留）
```

隔离目录是空目录，agent 在里面从零开始工作。设了 cwd 的任务则直接在目标仓库里工作，CLAUDE.md 自动加载（见 [agent-sdk-patterns.md](agent-sdk-patterns.md#claudemd-自动加载)）。

---

## 2. LLM 配置（API Key / Base URL / Model）

### Fallback 链

```
admin → user → project → task.model → env（仅系统任务）
```

| 优先级 | 来源 | scope | 说明 |
|--------|------|-------|------|
| 0 | admin 配置 | `scope="admin"` | 管理员配置的共享 key，需用户被授权（`isUserGrantedAdminLlm`） |
| 1 | user 配置 | `scope="user"` | 用户自配 key，覆盖 admin |
| 2 | project 配置 | `scope="project"` | 项目级 key，覆盖 user |
| 3 | task.model | — | 任务级 model 覆盖（task 创建时已含 role 继承） |
| 4 | 环境变量 | — | 仅 `owner_id=NULL` 的系统任务才 fallback 到 `ANTHROPIC_API_KEY` env |

**注意**：api_key 和 base_url 逐级覆盖（高优先级非空则替换）；model 也逐级覆盖，但 env `ANTHROPIC_MODEL` 作为最低默认值。

### 发送时覆盖（send-time override）

任务详情页发送消息时，可通过输入框左侧的 ⚙️ 按钮覆盖 model / effort / max_turns。`resolveLlmConfig(task, modelOverride)` 的 `modelOverride` 是三态：

| `modelOverride` | 含义 | 何时产生 |
|-----------------|------|---------|
| `undefined` | 沿用 `task.model`（现状不变） | 定时任务、非交互运行、初始 start 按钮（未开高级面板） |
| `null` | **忽略 `task.model`**，用 env->admin->user->project 链默认 | 交互式发送、高级面板选「默认」 |
| `string` | 用该模型（最高优先级） | 交互式发送、高级面板选具体模型 |

- **model 始终随发送提交**：高级面板关闭时也发 `model=null`（用最新默认，不用 task 快照）--这是"换供应商后旧 model 名失效"的修复。
- **effort / max_turns 仅在打开高级面板时提交**（opt-in）；面板关闭则沿用 task 行存储值（它们不会像 model 名那样失效）。
- **SDK 约束**：model/effort/max_turns 在 `query()` 调用时锁定（start/resume）。覆盖仅在新一轮 start/resume 生效：终态任务发消息自动 start（主路径，✅）；运行中任务发消息仅 pushMessage，覆盖下次恢复时生效（UI 有提示）。
- **定时任务不受影响**：不传 `modelOverride`（undefined）-> 仍用 `task.model`，保留 pin 模型能力。

### 解析时机

- **ActiveSession 构造时**（`resolveLlmConfig`）：一次性解析，结果缓存在 `this.resolvedConfig`
- **创建任务时**：model 单独走 role 继承链（`task.model ?? role.model ?? null`），不涉及 api_key/base_url

### 关键代码

| 位置 | 作用 |
|------|------|
| `src/lib/db/llm-configs.ts:257-332` | `resolveLlmConfig()` 完整实现 |
| `src/lib/runtime/active-session.ts:125` | 调用入口 |
| `src/lib/db/tasks.ts:87-88` | model 的 role 继承 |

### 前端管理

- **设置页**（`/settings`）：admin 配置 + 用户自配
- **项目设置**：project 级配置
- **新建任务表单**：model 字段可手动覆盖

---

## 3. 其他配置项的继承

### allowed_tools

```
task.allowed_tools → role.allowed_tools → ALL_TOOLS（默认全集）
```

- `ALL_TOOLS` 定义在 `active-session.ts`：`Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Agent, NotebookEdit`
- 创建时解析：`def.allowedTools ?? role?.allowedTools ?? null`，存入 tasks 表

### max_turns / effort

```
task.max_turns → role.max_turns → 200（默认）
task.effort → role.effort → "high"（默认）
```

### auto_approve

```
task.auto_approve → 0（默认，需人工审批写操作）
```

无 role 继承，纯 task 级配置。

---

## 3.5 壁钟超时（任务最长运行时长，v40）

### Fallback 链

```
project.timeout_minutes → app_settings.task_timeout_minutes → 30 分钟
```

| 优先级 | 来源 | 持久性 | 说明 |
|--------|------|--------|------|
| 1 | `projects.timeout_minutes` | 落库 | 项目级覆盖，NULL = 继承全局。UI：项目列表 → 「高级选项」，留空 = 继承 |
| 2 | `app_settings.task_timeout_minutes` | 落库（**重启仍在**）| 全局默认。UI：`/settings` →「任务超时（全局默认）」；API `PATCH /api/config { task_timeout_minutes }`（admin only）|
| 3 | `30` | 硬编码 | 本特性上线前的行为，什么都不配时完全一致 |

> 🚫 曾有一层 `ORCHESTRATOR_TASK_TIMEOUT_MIN` env 种子，**2026-08-13 删除**（同时删了 `ORCHESTRATOR_MAX_CONCURRENCY`）。env 的语义只能是「库里没值时的种子」（做成更高优先级 → 「UI 改了但 env 写着旧值」没人猜得到哪个生效），而种子的价值只覆盖「新实例第一次启动到有人打开设置页」这一小段，却要求每个读文档的人记住这条规则。新实例要非默认值，起来后 PATCH 一次即可。理由留档在 `src/lib/db/settings.ts` 文件头。

边界：1-1440 分钟（整数）。非法值一律**抛错回 400**，不静默夹取到边界 —— 静默会让人以为超时调长了，而任务照旧按旧值被挂起。

### 解析时机

- **每次 `runTask` 现算**（`agent-runtime.ts` 的 `resolveTaskTimeoutMs`），**不缓存 project 行**（同 `TaskScheduler.cwdLimit()` 的判据）→ 改完配置下一次 start/resume 就生效，不用重启。
- **对已在跑的任务不生效**：定时器只在任务启动那一刻挂一次，按当时解析出的值走完。
- `project_id` 为 NULL 的系统任务（intake / 无项目的定时任务）直接走全局值。
- 库里的脏值（手工 SQL 写进 `0` / 非整数）会被判掉并回退到全局值 —— 绝不允许算出 `0` 或 `NaN`，`setTimeout(0)` 等于任务一启动就被挂起，而 DB 里看不出任何异常。

### 关键代码

| 位置 | 作用 |
|------|------|
| `src/lib/runtime/agent-runtime.ts` `resolveTaskTimeoutMs()` | 解析链；`runTask()` 里挂 `setTimeout` 的唯一取值处 |
| `src/lib/db/settings.ts` | `app_settings` KV 读写 + 校验（`parseTimeoutMinutes` / `getGlobalTaskTimeoutMinutes` / `setGlobalTaskTimeoutMinutes`）|
| `src/lib/db/projects.ts` `updateProject()` | 项目级值的校验（非法抛错 → PATCH 路由 400）|
| `src/lib/runtime/global-settings.test.ts` | 21 条回归：优先级、落库、脏值降级、清空恢复继承（并发上限同在此文件）|

### 🔴 调长的代价

超时走 `pauseTask`（保上下文可恢复），而 `paused` 是**非终态** —— 定时任务的防重派闸门按「非终态算在飞」，一个超时挂着的 task 会挡住同一个 schedule 的后续触发。把超时从 30min 调到 4h，等于把这段「挡住后续触发」的窗口一起调到 4h。

---

## 3.6 全局并发上限（v39 起落库）

### Fallback 链

```
app_settings.max_concurrency → 2
```

只有全局一层（**没有**项目级覆盖 —— 项目级是另一个闸门 `projects.parallel_limit`，管的是「同 cwd 能并行几个」，不是全局槽位数）。边界 1-10 整数。

> `app_settings` 是 KV 表（v39 建）：**加一条全局设置 = 插一行，不用 migration**；现住户 `task_timeout_minutes` + `max_concurrency`。

### 解析时机

- **进程启动时读一次**：`AgentRuntime` 构造函数 → `getGlobalMaxConcurrency()` → `new TaskScheduler(n)`。
- 运行中改值走 `PATCH /api/config { concurrency }`（admin），路由**两件事都做**：
  1. `setGlobalMaxConcurrency()` 落库 → pm2 重启后仍是这个值
  2. `scheduler.setConcurrency()` 改内存 → 立即影响后续调度
  只做第 1 步 = 要重启才生效；只做第 2 步 = pm2 重启回落到 2（v39 之前就是这个毛病）。
- 落库失败时**不动运行时**（先落库再改内存），免得出现「跑着的值和库里不一致」。

> 实际并行度 = min(全局并发, `projects.parallel_limit`, `users.max_concurrency`)，三层闸门取小 —— 只调这一层可能看不到变化。同 cwd 并发（v38 `parallel_limit`）的判据 `cwdLimit()` 故意不缓存（改完即生效）；只给基本不写工作目录的项目调高（会 `git commit` 的项目调高 = `index.lock` 撞车）。回归测试 `task-scheduler.test.ts`「per-cwd parallel limit (v38)」。

---

## 4. 配置解析总览图

```
创建任务 (POST /api/tasks)
  │
  ├─ cwd:        task → version → project → NULL（存入 DB）
  ├─ model:      task → role → NULL
  ├─ tools:      task → role → ALL_TOOLS
  ├─ max_turns:  task → role → 200
  ├─ effort:     task → role → "high"
  └─ auto_approve: task → 0

运行任务 (ActiveSession)
  │
  ├─ cwd:        task.cwd → 隔离工作区（不再查 version/project）
  ├─ api_key:    admin → user → project → env（仅系统任务）
  ├─ base_url:   admin → user → project → env（仅系统任务）
  ├─ model:      admin → user → project → task → env
  │               ↑ 交互式发送可覆盖（modelOverride: null=用最新默认 / string=指定）
  │                 定时/非交互不传 -> 沿用 task.model
  └─ 壁钟超时:   project.timeout_minutes → app_settings → env → 30min
                  ↑ 每次启动现算, 不缓存; 已在跑的任务不重挂定时器
```

> **设计原则**：创建时一次性解析并固化到 tasks 表（cwd/model/tools 等），运行时不再重新查上游。LLM 配置（api_key/base_url）是例外——运行时解析，因为 key 可能被管理员轮换。model 的发送时覆盖（`modelOverride` 三态）是另一个例外——交互式发送默认用最新默认模型，避免旧 task.model 快照在换供应商后失效（详见上方「发送时覆盖」）。
