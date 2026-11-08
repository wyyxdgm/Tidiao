# 多租户改造计划（路线 A：控制面 + Worker 协议）

> **本文档用途**：让一个没有对话上下文的新 CLI 会话能独立接手并推进多租户改造。
> 读这一篇 + [`architecture.md`](architecture.md) 即可开工。
> **最后更新**：2026-07-29

> **本副本是 bt 模式执行目录**（`agent-orchestrator-bt`，:15000，`~/.agent-orchestrator-bt`）。
> bt 模式 = 第 1 期 + 单机部署（见 §1.4），不走路线 A 的 worker 改造；§2-§5 路线 A 内容仅作参考。
> 路线 A 的独立副本在 `agent-orchestrator-mt`。

---

## 1. 背景

### 1.1 这是什么项目

提调（Tidiao）：多 Claude Code Agent 任务调度平台（Web UI + Agent SDK + SQLite + 飞书同步）。
核心能力：创建 task -> 调度器排队 -> `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动 Claude Code 子进程执行 -> SSE 流式输出 -> canUseTool 审批 -> fork/checkpoint 续做。

详细架构见 [`architecture.md`](architecture.md)，任务生命周期见 [`workflow.md`](workflow.md)。

### 1.2 为什么要做这次改造

项目要**对外提供服务**，需求：

1. **账号体系**：提供注册/登录，用户登录后创建自己的项目
2. **自动初始化**：用户无需关心路径，自动初始化 git/claude 环境
3. **数据隔离**：每个用户只能看到自己的项目和任务（现有功能照搬，加 owner 过滤）
4. **管理员视角**：多账号隔离 + 执行环境隔离 + 主机列表维护 + 端口资源管理（总范围 10000~50000）

### 1.3 三种模式

按执行隔离强度排列：

| | bt 模式（共享单机） | 主机模式 | 端口模式 (Docker) |
|---|---|---|---|
| 形态 | 1 机跑所有账号 | 1 账号 ↔ 1 主机 | 1 主机跑多个容器化账号 |
| 执行隔离 | ❌ 无（共享 OS/FS） | 网络边界（强） | 容器（配置对才强） |
| 部署复杂度 | 最低（宝塔一键） | 中 | 高 |
| 资源效率 | 好（多号一机） | 差（闲号=闲机） | 好（多号一机） |
| 密钥收口 | 最差（互相可见） | 差（用户占有主机） | 好（key 留宿主/代理） |
| 单号成本 | 低 | 高 | 低 |
| 用户上手 | 注册即用 | 需 admin 分配主机 | 需分配端口/容器 |

### 1.4 选型：按信任边界选模式

选哪种模式只看一个问题：**用户之间互相信任吗？**

| 信任边界 | 选什么 | 改造量 |
|---|---|---|
| 信任（小团队 / 内部） | **bt 模式** | 仅第 1 期 + 单机部署 |
| 不信任、用户少 | 主机模式 | 路线 A 第 1-3 期 |
| 不信任、用户多 | 端口模式 | 路线 A 第 1-4 期 |

**bt 模式** = 现有单机应用 + 第 1 期（认证 + 多租户 DB 过滤），部署到一台 VPS（宝塔面板一键部署那种）即上线。不需要 worker 拆分，是验证期的最快 MVP。用户注册即用，无需 admin 分配主机/端口。

风险：用户 A 的 agent 有 Bash 权限，能读 B 的 workspace、env 里的 API key、改 B 的 git--**只适合信任边界内**。对公开放注册不能用。

主机/端口模式需要执行隔离，触发下文的路线 A。

### 1.5 为什么选路线 A（执行隔离场景）

**核心瓶颈**：当前执行层是"本地进程 + 本地文件系统"紧耦合。`ActiveSession` 调 SDK 的 `query()`，SDK 在**本机** fork Claude Code 子进程：
- `query({ cwd })` 的 cwd 是本地路径（`active-session.ts` start/resume）
- `env.CLAUDE_CONFIG_DIR` 指本地目录
- session JSONL 写本地磁盘
- `forkSession()` / `getSessionMessages()` / `rewindFiles()` 读本地 JSONL
- `getCurrentGitHead` 跑本地 `git`

**编排器进程必须和 Claude Code 子进程、workspace 在同一台机器上。** SDK 没有"远程 cwd"口子。所以"给账号分配远程主机"不能靠配置远程 cwd 实现--必须引入**远程执行边界**。

**路线选择**：
- 路线 C（每主机跑一份完整应用 + 薄控制面）：主机模式最低成本，最大化复用现有代码。但端口模式要做时仍要重做执行边界。
- **路线 A（控制面 + Worker daemon 协议）**：把 `ActiveSession` 抽成跑在各主机上的 worker daemon，控制面通过 HTTP/WS 协议驱动。**这是两种模式的共同地基**，选定此路线。

> 决策依据：用户确认端口模式是确定要做的未来需求，故直接投路线 A，避免 C->A 迁移。bt 模式不触发执行隔离，无需路线 A，做完第 1 期即可交付。

---

## 2. 目标架构：控制面 + Worker

```
浏览器 ──SSE──> 控制面 (Next.js) ──HTTP/WS──> Worker daemon (各主机)
                    │                            │
                    │                            ├── ActiveSession (现有, 套 HTTP 壳)
                    │                            ├── @anthropic-ai/claude-agent-sdk query()
                    │                            ├── 本地 workspace / git
                    │                            └── 本地 session JSONL
                    │
                    ├── 元数据 DB (users/hosts/assignments + 任务元数据)
                    └── 认证 / 反向代理 / 管理面板
```

### 2.1 控制面（control plane）

职责：
- 账号认证（注册/登录/session）
- 主机/端口资源管理（admin）
- 按 `user -> host` 分配，反向代理任务请求到对应 worker
- 元数据 DB
- 对浏览器的 SSE 流（worker 事件流转发）

### 2.2 Worker daemon

跑在各执行主机上的长驻进程，封装现有 `ActiveSession`，通过 HTTP 暴露：

| 方法 | 路径 | 对应现有 ActiveSession/Runtime 方法 |
|------|------|-----------------------------------|
| 启动 | `POST /sessions` | `start(task)` |
| 恢复 | `POST /sessions/:id/resume` | `resume(task)` |
| 中断 | `POST /sessions/:id/interrupt` | `interrupt()` |
| 关闭 | `POST /sessions/:id/close` | `close()` |
| 发消息 | `POST /sessions/:id/messages` | `pushMessage()` |
| 工具审批 | `POST /sessions/:id/approvals/:reqId` | `resolveApproval()` |
| 用户对话 | `POST /sessions/:id/dialogs/:reqId` | `resolveUserDialog()` |
| 回退 | `POST /sessions/:id/rewind` | `rewindFiles()` |
| fork | `POST /sessions/fork` | `forkSession()` |
| 历史 | `GET /sessions/:id/history` | `getSessionHistory()` |
| 事件流 | `GET /sessions/:id/events` (SSE) | `subscribeToEvents()` |

### 2.3 关键洞察：worker 侧改动小，控制面侧改动大

`ActiveSession` 内部的进程内状态（`pendingApprovals` 的 resolve callback、`messageResolvers` Promise、`queryInstance.interrupt/close/rewindFiles`）搬过网络边界后：

- **Worker 侧**：`ActiveSession` 实例仍在 worker 内存里活着，内部逻辑**基本不用改**。只是套一层 HTTP server，把现有方法暴露成 endpoint；resolve 的触发源从"同进程方法调用"变成"HTTP 请求"。
- **控制面侧**：`AgentRuntime.runTask` 从 `new ActiveSession(task)` 变成"选 worker -> HTTP POST start -> 代理事件流"。`sessions: Map<taskId, ActiveSession>` 变成 `Map<taskId, WorkerClient>`，所有方法改成 HTTP 调用 + SSE 转发。

**这降低了路线 A 的风险**：最复杂的流式/审批/Promise 逻辑留在 worker 进程内不动，控制面只是个 HTTP client + 事件转发器。

---

## 3. 分期计划

每期独立可验证。前期不碰远程，在 localhost 跑通后再上远程主机。

### 第 1 期：认证 + 多租户 DB 隔离（本地执行，不碰执行层）

**目标**：让现有单机应用变多用户，仍本地执行。这是地基，和执行层解耦。

> **bt 模式 = 第 1 期成果 + 单机部署**：信任边界内的场景做完本期即可上线（见 §1.4），无需进入第 2 期 worker 改造。

**改造点**：
- 新建 `users` 表（id/email/password_hash/role[user|admin]/created_at）
- `projects` 加 `owner_id` FK；`tasks` 经 project 间接归属 owner（查询过滤用 JOIN，或冗余 owner_id）
- `src/middleware.ts`：Next.js middleware 校验 session cookie，保护所有 `/api` 和页面路由
- `/api/auth/register`、`/api/auth/login`、`/api/auth/logout` 路由
- 密码哈希：bcrypt 或 argon2（加依赖）
- session：signed cookie（JWT 或 server-side session 表）
- 所有现有 db 查询模块（`projects.ts`/`tasks.ts`/`sessions.ts`/`events.ts` 等）加 `userId` 过滤
- 46 个 API 路由从 session 取 userId，不信任前端传入的 owner
- "未分类"项目改为每用户一个

**验证标准**：
- 注册两个账号 A/B，A 建的项目 B 看不到（API 返回 404 或空）
- 未登录访问任意 `/api/tasks` 返回 401
- 现有单用户功能全部不被破坏（跑 `task-scheduler.test.ts` + 手动冒烟）

### 第 2 期：引入 Worker 边界（localhost，单 worker）

**目标**：把执行层从控制面进程里拆出来，localhost 跑通控制面↔worker 协议。不碰远程主机。

**改造点**：
- 新建 `src/worker/` 目录：worker daemon 入口（独立进程，如 `worker/server.ts`，用 Node http 或轻量框架）
- Worker 暴露 §2.2 的 HTTP API，内部 `new ActiveSession(task)` 不变
- 新建 `src/lib/runtime/worker-client.ts`：`ActiveSession` 的 HTTP client 替身，实现同样的方法签名
- `AgentRuntime.runTask`：`new ActiveSession(task)` -> `new WorkerClient(task, workerUrl)`
- `AgentRuntime.sessions: Map<taskId, WorkerClient>`
- SSE 转发：worker `GET /sessions/:id/events` -> 控制面 SSE -> 浏览器（两级流）
- 控制面元数据 DB 存任务元数据；worker 本地 DB 存 session JSONL 路径 + 运行时状态（或仍由控制面持久化事件，worker 只回传事件流）
- Worker 鉴权：控制面->worker 用共享 token / mTLS

**验证标准**：
- 控制面和 worker 分两个进程起，创建 task 能跑通完整生命周期（start -> 流式输出 -> 审批 -> reviewing -> approve）
- canUseTool 审批、pushMessage、onUserDialog、fork、rewind 全部经网络边界正常工作
- 中断/暂停/恢复正常
- 现有测试通过（可能要调整测试启动方式：先起 worker 再跑）

### 第 3 期：管理员主机管理 + 远程 Worker（主机模式落地）

**目标**：1 主机 ↔ 1 用户，BYOK，主机可重建。真正的多机。

**改造点**：
- `hosts` 表（id/name/agent_url/agent_token/status/metadata）
- `host_assignments` 表（user_id/host_id/mode[host|port]/allocated_at）
- Admin UI：主机列表 CRUD、分配、状态监控
- 注册时/创建项目时：按分配的 host 选 workerUrl
- Worker 远程部署方案：镜像化（Docker 镜像或系统服务），主机可随时重建
- `~/.agent-orchestrator-mt`（worker 侧）状态视作可丢弃/可从 git 重建
- Worker 健康检查（控制面定期 ping）

**验证标准**：
- 两台机器（或一台机器两个端口模拟）：账号 A 的 task 跑在 worker-1，账号 B 跑在 worker-2
- 一个 worker 挂了不影响另一个
- Admin 能在 UI 分配/回收主机
- 主机重建后 task 可重新发起（session JSONL 丢失视为可接受，因为 workspace 在 git 里）

### 第 4 期（后续）：端口模式（Docker）

**目标**：1 主机跑多个容器化 worker + 端口池。

**改造点**：
- `port_pool` 表（host_id/port/status/allocated_to_user）
- Worker 容器化：每账号一个容器，宿主分配连续端口
- 端口分配器：注册时分配端口范围，容器映射
- API Key 代理：宿主跑 API 代理，容器 `ANTHROPIC_BASE_URL` 指向代理，真 key 不落地容器
- 容器生命周期管理（启停/回收）

**验证标准**：
- 一台主机跑 2+ 账号，各自容器隔离
- 端口池分配/回收正确，无冲突
- 容器内 agent 拿不到真 API key（只能走代理）

---

## 4. 数据模型变更预览

基于现有 11 张表（见 architecture.md），新增/修改：

```
users (新)
  id, email UNIQUE, password_hash, role[user|admin], created_at

projects (改)
  + owner_id FK users

hosts (新, 第3期)
  id, name, agent_url, agent_token, status, metadata, created_at

host_assignments (新, 第3期)
  user_id FK users, host_id FK hosts, mode[host|port], allocated_at

port_pool (新, 第4期)
  host_id FK hosts, port, status[free|allocated], allocated_to_user, allocated_at
```

> `tasks` 是否冗余 `owner_id`：第 1 期实现时决定。JOIN projects 查 owner 可行但每查询都 JOIN；冗余 owner_id 查询简单但需保证和 project.owner 一致。倾向冗余 + 创建时从 project 继承。

---

## 5. 安全张力 & 前置决策点

这些是主机模式相对端口模式**更难**的地方，推进时必须先定：

### 5.1 API Key 策略（第 3 期前必须定）

Worker 上要有 `ANTHROPIC_API_KEY` 才能跑 Claude Code，而主机模式下用户/agent 有 Bash 权限能拿到 key。选项：

| 方案 | 说明 | 适合 |
|------|------|------|
| **BYOK** | 用户自带 key，平台不保管 | 主机模式最干净，推荐起步 |
| 平台 key + 限额 | 接受"专用主机的 key 等于归该用户" | 有被盗刷风险 |
| API 代理 | worker 的 BASE_URL 指向平台代理，代理注入真 key + 配额 | 平台计费正解，第 4 期必做 |

### 5.2 主机是牲口不是宠物

agent 跑 Bash 能把 OS 搞坏、装恶意软件、写满磁盘。主机必须可随时重建（镜像化），worker 上 `~/.agent-orchestrator-mt` 状态视作可丢弃/可从 git 重建。

### 5.3 横向移动隔离

各 worker 主机要和控制面 DB、彼此网络隔离；控制面->worker 链路 mTLS/共享 token；被攻破的主机不能读到别的账号任务。端口模式（Docker）在这点反而更省心。

---

## 6. 当前进度

### 已完成

- [x] 从原项目 `agent-orchestrator @ 85fd28c` clone 分叉到 `agent-orchestrator-bt`（保留完整 git 历史，无 remote，独立 fork）
- [x] 数据/端口隔离（cherry-pick `-mt` 的 `35da6bb` + bt 化）：
  - `ORCHESTRATOR_HOME` / `CLAUDE_CONFIG_DIR` 常量（`src/lib/constants.ts`），4 处硬编码 `~/.agent-orchestrator` 统一收口，缺省回退原路径
  - `.env.local`：`ORCHESTRATOR_HOME=/Users/user/.agent-orchestrator-bt`、`PORT=15000`
  - `package.json` dev 端口 15000、name `agent-orchestrator-bt`
  - `ecosystem.config.cjs` pm2 进程名 `agent-orchestrator-bt`
  - 与原项目（:13000）、`-mt`（:14000）三者隔离，可并行运行

### 进行中

（bt 模式 Phase 1 已完成，见下）

### 已完成（Phase 1）

- [x] **第 1 期：认证 + 多租户 DB 隔离**（bt 模式即此期 + 单机部署，见 §1.4）— 2026-07-29 完成
  - T1 users 表 + 注册/登录 + session 中间件（commit b6c1d18）
  - T2 projects/tasks owner_id 归属隔离（commit 909ef08）
  - T3 46 个 API 路由收口 userId（commit fc214b0）
  - T4 每用户「未分类」+ NULL owner 回收 + 服务端组件页面收口 + 回归测试（本任务）
  - 验证：两账号 A/B 数据全隔离、未登录 401、task-scheduler.test.ts 通过、完整生命周期冒烟通过、tsc 通过

### 三个目录的关系

- 原项目 `/Users/user/workspace/agent-orchestrator`（`master`、:13000、`~/.agent-orchestrator`）：单租户基座，持续迭代
- `-mt` `/Users/user/workspace/agent-orchestrator-mt`（`multi-tenant/route-a`、:14000、`~/.agent-orchestrator-mt`）：路线 A（执行隔离）的独立副本
- 本副本 `agent-orchestrator-bt`（`master`、:15000、`~/.agent-orchestrator-bt`）：bt 模式（Phase 1 + 单机部署）的独立副本
- 三者独立 git 历史，物理隔离，可同时运行。bt 与 `-mt` 的 Phase 1（认证+多租户DB）是同一份代码，分叉要到 Phase 2（worker）才出现

---

## 7. 给接手者的提示

1. **先跑起来**：`cd /Users/user/workspace/agent-orchestrator-mt && npm run dev` -> http://localhost:14000
2. **读架构**：[`architecture.md`](architecture.md) + 本文档 §2
3. **开工第 1 期**：从本文档 §3 第 1 期开始，先建 `users` 表 + middleware + auth 路由
4. **每期都有验证标准**，完成前对照检查
5. **执行层改造（第 2 期起）**：先读 `src/lib/runtime/active-session.ts` + `agent-runtime.ts` 理解现有进程内状态，再按 §2.3 的洞察设计 worker 协议
6. **不要在原项目目录改多租户的东西**，两个项目物理隔离
7. **决策点**（§5）在对应期次前必须先定，别跳过
