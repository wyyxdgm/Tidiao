# 架构与数据模型

## 架构

```
Next.js App Router (React)
  ├── API Routes → AgentRuntime（单例，instrumentation.ts 初始化）
  ├── AgentRuntime → ActiveSession（封装 query + streaming input）
  └── SQLite (better-sqlite3, ~/.agent-orchestrator/orchestrator.db)
```

AgentRuntime 在 `instrumentation.ts` 中作为单例初始化，API Route 通过 `getRuntime()` 直接调用。

## 数据模型

数据库位置：`~/.agent-orchestrator/orchestrator.db`（SQLite + WAL）

### Migration 历史

| 版本 | 内容 |
|------|------|
| v1 | tasks 加 `depends_on` |
| v2 | 加 `webhooks` 表 |
| v3 | 加 `checkpoints` 表 + tasks 加 base/head_commit + forked_from_session_id + `templates` 表 |
| v4 | sessions 加 forked_at + source_message_id |
| v5 | 加 `projects` + `versions` 表 + tasks 加 project_id/version_id FK |
| v6 | projects 加 `current_version_id` + versions 加 `is_released` |
| v7 | 创建“未分类”项目并回填历史 Task；新建 Task 强制归属 Project |
| v8 | tasks 加 `type` 字段（design/dev/test/deploy/null）|
| v9 | 加 `task_rules` 表（事件触发编排规则）|
| v10 | 加 `roles` 表 + tasks 加 `role_id` FK（角色配置包 §9 v1）|
| v11 | 加 `agent_evals` 表（评估 harness §9 v1）|
| v12 | projects 加 `cwd` 字段（项目级 cwd fallback，让 unversioned task 默认落在项目目录）|
| v13 | 加 `config_snapshots` 表（"模板配置"：可复用的执行配置旋钮，无 prompt；scope=global/project/version，按 version>project>global 最佳匹配自动套用）|
| v14 | 加 `users` 表（多租户 Phase 1 T1：email/password_hash/role，JWT session；首个注册用户成 admin）|
| v15 | projects + tasks 加 `owner_id` FK users.id（多租户 Phase 1 T2：tasks 冗余存 owner_id 免 JOIN，历史行回填首个 admin）|
| v16 | templates/roles/webhooks/config_snapshots 加 `owner_id`（多租户 Phase 1 T3：独立配置资源归属用户，回填首个 admin）|
| v17 | projects.name 全局 UNIQUE -> UNIQUE(owner_id, name) 重建表（多租户 Phase 1 T4：每用户各一个"未分类"）；并回填 v15/v16 遗留的 NULL owner_id |
| v18 | 加 `auth_attempts` 表（登录暴力破解防护：持久化失败日志，跨重启锁定，按 identifier 命名空间区分 login/register）|
| v19 | roles.name 全局 UNIQUE -> UNIQUE(owner_id, name) 重建表（v17 同款流程，Phase 1 follow-up：与多租户隔离一致）|
| v20 | tasks 加 `context_tokens`/`context_max`（ reviewing 状态下查看上下文占用，辅助"继续还是 fork"决策；原 v14 重编号）|
| v32 | tasks 加 `dispatched_by_task_id` FK tasks.id（派发方溯源：agent 派子任务时记录上游 task；跨项目派发也允许，只校验同 owner。与 forked_from_session_id 正交——fork 共享 session 历史，派发是独立 session 间的因果链）|
| v33 | projects/versions 加 `deleted_at` + **重建两张表**把表级 UNIQUE 换成 partial unique index（`uq_projects_live` / `uq_versions_live`，均带 `WHERE deleted_at IS NULL`）。起因：`tasks.project_id`/`version_id` 没有 ON DELETE 子句 + `foreign_keys=ON`，裸 DELETE 对任何有 task 的项目都 FK 失败 → API 500 且前端静默。改为**级联软删**（项目/版本自己 + 其下 task 全打 deleted_at，数据保留可恢复；task 是软删可恢复的，硬删会毁数据 + 留 uploads 孤儿文件）。partial index 让软删的名字不占用（删了能重建同名），同时两个**活**的同名仍被拦。重建照 v17 流程（foreign_keys OFF→copy→swap→foreign_key_check），⚠️ `DROP TABLE` 会连带删索引，`idx_projects_pinned` 已补回 |
| v34 | 加 `maintenance_state` 单行表（维护模式：部署前关停→部署→恢复）。**必须落库不能用内存标记**：pm2 restart 后是全新进程，内存标记全丢 → 新进程不知道该静默，ScheduleRunner 5s 后就开始放任务。`suspended` 存挂起清单 `[{task_id, prev_status}]` 同理——`TaskScheduler.queue` 只在内存里，光 pause running 不够，queued 任务重启后被扫成 pending 就再没人 enqueue 它们了 |
| v35 | projects 加 `wiki_extra_extensions TEXT DEFAULT '[]'`（wiki 可读的额外扩展名白名单，JSON 数组）|
| v36 | tasks 加 `resolved_model TEXT`（最近一次启动实际使用的模型快照，`resolveLlmConfig` 最终值）。与 `model`（用户偏好，null=跟随默认，会漂移）区分，UI 显示优先读此字段。ActiveSession 构造函数写入 |
| v37 | `idx_tasks_schedule` on tasks(schedule_id) —— 定时任务防重派闸门每分钟按 schedule_id 反查在飞任务，无索引就是全表扫上万行 tasks |
| v38 | projects 加 `parallel_limit INTEGER DEFAULT 1`（该项目共享同一 cwd 的任务可同时跑几个）。**只放宽 TaskScheduler 三层闸门的第二层**（per-cwd 互斥），全局并发与 per-owner 上限照旧 → 实际并行度三者取小。NULL 视作 1，存量项目零变化。判据在 `TaskScheduler.cwdLimit()`（**故意不缓存**，换改完即生效）；`busyCwds` 相应从 `Map<cwd,taskId>` 变 `Map<cwd,Set<taskId>>`。🔴 只该给「基本不写工作目录」的项目调高，否则 `git index.lock` + 同名文件互相覆盖 |
| v51 | **Runners 子系统 (R1)**：加 `runners` 表（每条 = 一台目标机上一个 daemon 实例；256-bit shared secret 用 3 列 AES-256-GCM 存同 llm_configs/user_media_keys 模式）+ projects 加 `runners` JSON 字段（`[{runner_id, purpose, cwd_mapping, command_patterns[]}]`，每项目可绑多个 runner + 命令白名单；上限 32 pattern/entry 挡滥用）。`runners` 表 UNIQUE(host, port)；status 由 heartbeat 驱动（online/offline/dead 三段式）。R2 (Go daemon) + R3 (canUseTool 拦截) + R4 (UI) 见 [`docs/plans/runners.md`](plans/runners.md) 和 [`docs/plans/runners-rollout.md`](plans/runners-rollout.md)。UI 入口 [`/runners`](../src/app/runners/page.tsx)（admin only）|
| v511 | **project_configs (per-project KV, 加密存)**：复用 `src/lib/crypto.ts` AES-256-GCM 模式（同 `user_media_keys` v48 / `llm_configs` v41 三列拆存），存每 project 自己的敏感配置（卡号 / 密钥 / API key 等）。PK `(project_id, key)` + FK `projects(id) ON DELETE CASCADE`，项目删了配置自动清。**不复用 `app_settings`**：app_settings 全局 KV 没有 project_id，per-project 卡号跟全局混会出问题。`transactional=true`（一表 + 一索引必须原子）。reuse-pool 首批 4 key 命名: `bank_account_holder` / `bank_card_no` / `bank_branch` / `payee_phone`。API 4 个（list/get/put/delete）见 [api-routes.md §Project Configs](./api-routes.md#project-configsv511-4-个per-project-kvaes-256-gcm-加密存) |

### 表结构（13 张）

- `tasks` — 任务定义 + 状态 + session + 配置 + project_id/version_id FK + base/head_commit + type + role_id + dispatched_by_task_id（派发方溯源）+ awaiting_owner_review/awaiting_markers（v56/v61 marker 机制）+ metadata JSON（pending_decisions/waiting_child_id/pending_messages 等运行时副本，0 migration 扩字段）
- `sessions` — Claude Code session 元数据（含 fork 信息）
- `events` — 事件日志（SSE 推送 + 审计 + 投递记录）
- `projects` — 项目（含 current_version_id HEAD 指针）
- `versions` — 版本（归属 project，绑定飞书 sheet）
- `task_dependencies` — 任务依赖关系（many-to-many）
- `checkpoints` — git-like commit 锚点
- `webhooks` — Webhook 订阅（name/url/events/secret/active）
- `task_rules` — 事件触发编排规则（§8 规则引擎 v1）
- `roles` — 角色配置包（§9 v1: system_prompt + 默认 model/allowed_tools/effort/max_turns/memory_doc）
- `agent_evals` — 评估记录（§9 v1: score 1-5 + note + role_id）
- `templates` — 任务模板（v3 起）
- `maintenance_state` — 维护模式单行表（v34: active + 挂起任务清单，跨进程重启保持）

> 上表只列核心表，另有 users / auth_attempts / attachments / llm_configs / admin_llm_grants /
> user_media_keys（v48）/ api_tokens / schedules / schedule_runs / intake_threads / config_snapshots 等（见 Migration 历史）。
>
> **`idx_tasks_owner_status_updated`（v49）**：`tasks(owner_id, status, updated_at, created_at)` 复合索引。给看板 `listTasksPage()` 的"按用户筛状态 + 按时间倒序"用，替代全表扫 + 内存 sort。SQLite 复合索引天然支持 `ORDER BY DESC`（反向扫描），LIMIT 提前终止。已部署 WSL ao-prod，100+ 任务库实测无显著阻塞。
>
> **`user_media_keys`（v48）**：per-user minimax mmx-cli API Key + region 配置。**AES-256-GCM 加密存**
> （`api_key_encrypted` / `api_key_iv` / `api_key_tag` 三件套），`user_id` PK + `ON DELETE CASCADE`。
> 不复用 `llm_configs` 的 `owner_type` 三态（mmx 是付费配额，不做 admin 共享），
> 不做 project 级覆盖（per-user 已足够）。`region` 列校验 `cn|global/null`（API 层抛错 → 400）。
> `buildEnv()` 注入 `MMX_CONFIG_DIR = $ORCHESTRATOR_HOME/users/<id>/.mmx` 隔离多用户，
> `MINIMAX_API_KEY`（hint，mmx-cli 不读）+ `MINIMAX_REGION`；用户未配时全部 delete 防泄漏。
> Settings「保存」由 API 端 `mmx auth login` 写到 per-user config.json（chmod 700）。

### 任务状态流转

```
pending → queued → running → reviewing → completed
                ↓              ↓            ↑
            paused/cancelled  failed      rejected (打回, 复用 session 续做)
                                            ↓
                                          startTask → running
```

> 完整交付生命周期（task 类型 / 阶段链 / 打回迭代 / 需求联动 / 通知）见 [`docs/workflow.md`](workflow.md)。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/lib/runtime/agent-runtime.ts` | 核心运行时单例，任务生命周期管理 + emitEvent dispatch webhook/rule |
| `src/lib/runtime/active-session.ts` | 封装 `query()` + Streaming Input Mode + canUseTool 审批 |
| `src/lib/runtime/task-scheduler.ts` | FIFO 队列 + 并发控制 + 维护模式闸门（`setPaused` / `drainQueue`）|
| `src/lib/runtime/types.ts` | 所有类型定义（含 Project/Version/Task/TaskTrimmed/Checkpoint/Role/Eval）|
| `src/lib/runtime/rule-engine.ts` | §8 v1 事件触发规则引擎（task_rules 查表 + action 调度）|
| `src/lib/runtime/git.ts` | 读取 cwd 的 git HEAD（base_commit/head_commit/checkpoint commit_id）|
| `src/lib/db/index.ts` | SQLite 初始化 + 迁移（v1-v49，含 v49 复合索引 `idx_tasks_owner_status_updated`）|
| `src/lib/db/tasks.ts` | Task CRUD（含 project_id/version_id + role 继承 + type 字段）。**两种列表接口**: `listTasks(filter)` 全字段（旧接口，agent-runtime 等用）+ `listTasksPage(filter)` 精简投影 + 信封（看板专用，状态分流 active/terminal/all）|
| `src/lib/db/sessions.ts` | Session CRUD |
| `src/lib/db/events.ts` | 事件日志 + getWebhookDeliveryEvents 反查 |
| `src/lib/db/checkpoints.ts` | Checkpoint CRUD（git-like commit 锚点）|
| `src/lib/db/templates.ts` | 模板 CRUD |
| `src/lib/db/projects.ts` | Project CRUD（含 JOIN current_version_name）|
| `src/lib/db/versions.ts` | Version CRUD（含 getSheetConfigFromVersion）|
| `src/lib/db/webhooks.ts` | Webhook CRUD（9 事件: created/started/reviewing/completed/failed/rejected/cancelled/dependency_changed/evaluated）|
| `src/lib/db/rules.ts` | task_rules CRUD + 匹配 + 内置 seed |
| `src/lib/db/roles.ts` | roles CRUD（§9 v1 角色包）|
| `src/lib/db/evals.ts` | agent_evals CRUD + aggregateByRole |
| `src/lib/webhooks/dispatcher.ts` | HMAC-SHA256 签名投递 + 成功/失败事件记录 + 9 事件 payload |
| `src/lib/feishu/sheets.ts` | 飞书 Sheet2 读写封装（lark-cli 包装 + 行->task prompt 映射）|
| `src/lib/import/parsers.ts` | 批量导入解析器（JSON/CSV/Markdown）|
| `src/components/NavigationTree.tsx` | 侧边导航树（Project → Version/其他任务，⭐ 当前）|
| `src/components/NavSidebar.tsx` | 侧边栏 wrapper（条件显示）|
| `instrumentation.ts` | Next.js 启动时初始化 Runtime 和 DB |

## 工作目录策略

三级 fallback 链：`task.cwd` → `version.cwd` → `project.cwd` → 默认隔离 workspace

- 默认：`~/.agent-orchestrator/workspace/{taskId}/`（隔离工作区）
- 创建任务时指定 `cwd` 可覆盖为真实项目目录
- Version 有 `cwd` 字段，作为该版本下 task 的默认 cwd
- Project 也有 `cwd` 字段（v12），让 `version_id=NULL` 的"项目级其他任务"也落在项目目录下

## Runner 远程执行子系统（v51 起）

让平台 agent 能把白名单命令转发到**非平台机器**上执行（典型: 原生 macOS 跑 `cargo tauri build`）。
架构: **每台目标机**起一个独立 daemon（`agent-orch-runner`, Go 单二进制, R2 实现, 仓在 `git@localhost:repos/agent-orch-runner.git`）——
平台通过 HTTP+SSE 协议下发命令、回收结果。

```
agent (WSL)                     platform (platform instance)                runner daemon (target machine)
   │                                  │                                          │
   │ Bash command "cargo tauri build" │                                          │
   ├──────────────────────────────────►│ canUseTool 拦截                          │
   │                                  ├─► resolveRunnerRoute(project, cmd)      │
   │                                  │   命中白名单 + runner online ───────────►│ POST /v1/exec
   │                                  │                                          │ 起 os/exec 子进程
   │                                  │◄──────── SSE stdout / stderr / exit ───│
   │                                  │ 聚合 + 截断 (head 1K + tail 64K)         │
   │◄── tool_result "deny + message" ─┤  [runner:mac-build ... req=xxxxxxxx]    │
   │                                  │ (模型看到前缀知道是伪造的远程结果)        │
   │                                  ├─► 10s/heartbeat beat ──────────────────►│ POST /api/runners/:id/heartbeat
   │                                  │   30s 无心跳 → offline; 60s → dead        │
```

**关键设计**:
- **Auth**: 256-bit shared secret, 存为 `auth_token_encrypted / _iv / _tag` 三列（沿用 `llm_configs` / `user_media_keys` 的 AES-256-GCM 模式）。
  token 明文仅在 `POST /api/runners` 响应里返回一次, GET/列表永不带; 路由层 heartbeat 用 `decrypt()` + `timingSafeEqual`, 401 body 区分 `decrypt_failed` / `token_mismatch` / `token_missing` / `header_malformed`
- **Middleware bypass**: `POST /api/runners/:id/heartbeat` 这一条公开（不带 `ao_` 前缀, 走自己的 bearer 验签）; 其它所有 runner API 仍走 JWT/admin gating
- **安全闸门三道**:
  1. middleware 守住 JWT 体系 + heartbeat 路由守住 secret
  2. PATCH `projects.runners` 字段入库前 `validateRunnerEntry` + `assertRunnerIdsExist`（应用层 FK, 避开 ALTER ADD REFERENCES 的 schema rebuild）
  3. canUseTool 命中白名单但 runner offline → deny `"runner offline"`, **绝不**本地 fallback
- **全链路调试**: `req_id` (`crypto.randomUUID()`) 贯穿 X-Req-Id header → 子进程 env `AOR_REQ_ID` → 每条 SSE event → `formatExecResult` 前缀。`grep req_id=<uuid>` 一次追 5 跳 e2e
- **abort 信号**（🔴 R3 必接）: 任务被 pause/cancel 时 `options.signal.addEventListener("abort")` → `client.cancel(run_id)`, 否则 mac 子进程孤儿化
- **输出截断**: `formatExecResult` head 1KB + tail 64KB, 中间 `... [truncated N KB] ...` —— Tauri build 输出动辄几百 KB, 不截断会撑爆 model context
- **状态机**: heartbeat 30s tick 扫 `registry` Map, 缺心跳 → offline → dead, 三档显示
- **MVP 边界**: 只做 exec, **不**做文件上传/下载/自动同步（产物靠 git 共享, cwd_mapping 提供路径语义）

**落地状态**（截至 2026-08-28）:

| Phase | 状态 |
|-------|------|
| R1 平台 DB+API+Auth | ✅ 上线三实例（commit `0b27000`） |
| R2 Go daemon | ❌ 未开始（P1 建仓已派发） |
| R3 平台客户端+canUseTool | ❌ 未开始 |
| **R4 UI+文档（本文档）**| ✅ `/runners` admin 页面 + `docs/runners.md` |
| P5 端到端 | ⏳ 等 P2-P4 |

详细协议 + 路由/匹配算法 + 9 项风险缓释见 [`docs/runners.md`](runners.md);
端到端 Phase 编排 + 派发模板见 [`docs/plans/runners-rollout.md`](plans/runners-rollout.md);
权威设计 + 任务分解见 [`docs/plans/runners.md`](plans/runners.md);
Operator 分步指南见 [`docs/usage/runners.md`](usage/runners.md)。