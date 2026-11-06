# 设计决策日志

按 Phase 组织的关键决策。

## Phase 7 — 多项目/版本 + URL 路由（2026-07-24，最新）

| 决策 | 原因 |
|------|------|
| 项目/版本分两层 + current_version_id | 单 sheet 硬编码不能支持多项目；类比 git HEAD 让"当前版本"可切换 |
| URL 用 UUID 而非 name slug | 避免 name 编码转换开销，UUID 通用且稳定 |
| 侧边导航树只在非根路径显示 | `/` 项目列表全宽更清爽，看板才需要树 |
| 历史 task 迁入普通“未分类” Project | 所有 Task 都有项目归属，避免全局特殊 bucket |
| `version_id=NULL` 映射为每个项目的“其他任务” | 预研、运维、文档等项目级工作并不属于发布 Version，无需创建假 Version |
| Project 必填、Version 可选且校验同项目 | 防止新 orphan Task 和跨项目 Version 组合 |
| `/uncategorized` 只做兼容重定向 | 旧书签可用，同时导航统一为 Project → Version/其他任务 |
| 飞书 sync 优先用 version_id 查配置 | 解耦硬编码，每个 version 独立 sheet |

## Phase 6 — git-like fork/checkpoint + 飞书 sync（2026-07-23）

| 决策 | 原因 |
|------|------|
| Phase 6 fork/checkpoint 设计 | 解决"AI 跑错方向想重试"+"上下文复用"痛点；session 当 git branch |
| canUseTool 回调拦截写操作 | 解决"AI 在生产环境乱改文件"的安全问题 |
| Streaming Input Mode 而非单向 prompt | 支持运行中发消息（人工反馈 / 动态纠正）|
| lark-cli shim 用于 demo 测试 | 真实 lark-cli 需企业应用权限，本地用 shim 验证链路 |
| checkpoint 解析在完整 text block 而非 stream_event | `includePartialMessages` 模式下空 content 必须累积 buffer |
| fork autoApprove/maxTurns 继承 | 避免 fork 后权限丢失 |
| ActiveSession 修复 session_row 100ms race | resume 时 SDK 还没写回 session_id |
| 修复 pushMessage 丢消息 | messageGenerator 在 message 状态时 push 被丢弃 |

## Phase 5 — 任务依赖 + 模板

| 决策 | 原因 |
|------|------|
| dependsOn 用 join table 而非 JSON 数组 | SQL JOIN 查依赖关系更直接 |
| templates 与 tasks 解耦（独立表） | 模板不消耗资源，可复用 |
| Session 转录支持 markdown/JSON | markdown 给人看，JSON 给程序解析 |

## Phase 4 — UI 优化

| 决策 | 原因 |
|------|------|
| 看板 5 列（待执行/运行中/暂停/待审核/结束）| 状态合并而非 1:1，避免看板过宽 |
| 工具调用默认折叠 | 流式输出时太长，折叠后看更高层次对话 |

## Phase 3 — 批量导入

| 决策 | 原因 |
|------|------|
| 三种格式独立解析器（JSON/CSV/MD）| 不同格式边界差异大，统一抽象难维护 |

## Phase 2 — 运行时工具审批

| 决策 | 原因 |
|------|------|
| canUseTool 而非前置 hook | SDK 原生拦截，更稳定，跨 SDK 版本兼容 |
| auto_approve 字段加在 task 上 | 不是全局配置，按 task 控制更灵活 |

## Phase 1 — 基础任务调度

| 决策 | 原因 |
|------|------|
| FIFO + 优先级 + 并发控制 | 简单可预测；优先级倒序排，相同优先级按创建时间倒序 |
| SQLite + WAL | 嵌入式部署足够，单实例并发安全 |
| AgentRuntime 单例 | 避免多个实例竞争同一个 task queue |

---

## 未来方向（TODO）

- 离线 Excel 数据源（version 加 `data_source` 字段切数据源）
- 多用户/权限（当前无 auth）
- Task 历史归档（数量大时的性能问题）

---

## Webhook 备忘

> 调研于 2026-07-24，dispatch 补齐于 2026-07-24，管理 UI 落地于 2026-07-25。完整生命周期 + 投递历史。

### 已实现

- DB 表 + CRUD：`src/lib/db/webhooks.ts`
- 签名投递：`src/lib/webhooks/dispatcher.ts`
  - HMAC-SHA256 签名 -> `X-Signature` 头，body 为 JSON payload
  - 5s 超时（`WEBHOOK_TIMEOUT_MS`）
  - **成功**记 `webhook_delivered` 事件（status_code + duration_ms），失败记 `webhook_delivery_failed` 事件，均入 events 表
  - 不重投
- 定义 **8 事件**：`task.created / started / reviewing / completed / failed / rejected / cancelled / dependency_changed`
  - `task.reviewing` = agent 自然完成待审（2026-07-25 加）
  - `task.rejected` = 驳回（2026-07-25 加，**🆕 R131 2026-09-15 退役**：单人协作系统无他人接驳回，状态保留仅作历史兼容）
  - `task.dependency_changed` = 依赖联动通知（2026-07-25 加）
  - 🆕 R131 (2026-09-15)：新增 `task.await_user` 事件，等用户介入/拍板/建议

### 决策记录：review 状态机改造（R131，damo 2026-09-15 拍板）

**背景**：单人协作系统（damo + agent）下 reject 端点无意义（无"他人"接驳回）。已驳回任务 = 没有数据（无人接），该动作对 task 无意义。reviewing 状态下 AI 倾向 reject / approve 二选一，缺"投一句话接着干"路径（类比聊天模式继续输入）。

**决策**：
- 删除 `POST /api/tasks/[id]/reject` 端点 + `rejected` 终态写入路径
- 新增 `await_user` 状态（区别 `pending`=等系统 / `await_user`=等介入）
- 新增 `/refine` / `/await` / `/unawait` 三个端点
- agent SDK 暴露对应工具（薄包装 HTTP，task_id 自动取）
- `approve` 端点扩展支持 `await_user` 状态（自动 unwait 透明）
- canUseTool 白名单加这三个工具
- 调研所有 reject / rejected 相关代码并替换（grep 全仓业务代码 0 命中）

**配套拍板**：
- `await_reason` 3 个枚举值（`dispatch_needed` / `decision_pending` / `suggestion`）
- `unawait_reason` 3 个枚举值（`agent_self_resolved` / `user_timeout` / `external_event`）
- 历史 `rejected` 数据保留显示兼容，不删（避免破坏现有 task 历史）
- 暂搁：revert 动作（区别 cancelled 的"已撤销"状态）—— 先不管

**实施参考**：`docs/plans/review-state-machine-refactor.md` + `docs/deploy/2026-09-15-review-state-machine.md`

### 决策记录：历史 rejected UI 显示成「等待中」（R后续，damo 2026-09-15 拍板）

**背景**：R131 把 reject 端点删除后，历史遗留的 `rejected` 状态任务 UI 默认显示成「已驳回（历史）」。但「驳回」语义跟单人系统语义不符（无他人接驳回），用户看到「驳回」会困惑。

**决策**：历史 `rejected` 状态 UI **统一显示成「等待中」**（替代之前的「已驳回（历史）」）。
- 文案差异：`await_user` = 「等用户介入」（新流程）；`rejected`（历史）= 「等待中」（历史遗留）
- 颜色：保持橙色系（暖色 = 等待），不动
- DB schema：保留 `rejected` enum 兼容（历史数据不动）
- 行为：start 重启按钮保留（`STATUS_BUTTONS.rejected` 不动），webhook `task.rejected` 事件类型保留

**为什么这样**：用户感知 = 等待中（中性、不带"被打回"的负面情绪）。技术细节（status 字段）保留做兼容层。

**改动文件**：
- `src/lib/constants.ts` / `src/app/progress/page.tsx` / `src/app/usage/page.tsx` / `src/app/tasks/[id]/right-dock.tsx`
- `docs/usage/03-tasks.md`（状态表 label 同步）
- `docs/deploy/2026-09-15-review-state-machine.md`（风险段同步）

**实施参考**：`docs/deploy/2026-09-15-history-rejected-display.md`
- API：`GET/POST /api/webhooks` + `PATCH/DELETE /api/webhooks/[id]`
- 管理 UI（2026-07-25）：
  - `/webhooks` 列表 + 新建 + 编辑 events/active + 删除
  - `/webhooks/[id]` 详情 + 投递历史（最近 100 条 success/fail）

### 事件分发已全部接通

- `task.created` -> `agent-runtime.ts` `createTask()` 直接 dispatch（created 无 from/to）
- `task.started / reviewing / completed / failed / rejected / cancelled` -> 统一在 `AgentRuntime.emitEvent()` 的 `status_change` 分支，通过 `STATUS_TO_WEBHOOK` 映射 dispatch
- `task.dependency_changed` -> `dispatchDependencyChangeWebhook(root_task, dependents, message)`，手动调 /api/tasks/[id]/notify-dependents

### 语义定位

- `task.reviewing` = agent 自然完成
- `task.completed` = 人工 approve
- `task.rejected` = 人工驳回
- 外部系统按需订阅

### 出口审计结论

所有状态转换出口都流经 `AgentRuntime.emitEvent(taskId, {type:"status_change", from, to})`：
- `task.started`：`task-scheduler.ts:126` -> emitEvent
- `task.failed`：`active-session.ts:267/348/660` + `task-scheduler.ts:157` + `pauseTask` -> emitEvent
- `task.cancelled`：`cancelTask` -> emitEvent
- `task.completed` / `task.reviewing` / `task.rejected`：`approveTask` / `ActiveSession 自然完成` -> emitEvent
  - 🆕 R131 (2026-09-15)：rejectTask 移除；新增 `await_user` / `refined` 经由 `awaitTask` / `refineTask` / `unawaitTask` 走 `status_change` 事件 (`to_status` 不同)
- 不经 emitEvent：`recoverOrphanedTasks`（启动恢复，合理）

### 后续演进（下轮）

1. 重试 / 死信队列（当前失败仅记事件，不重投）
2. `webhook_deliveries` 独立表（events 表 LIKE 扫描当前可接受，量大时需要）
3. dispatcher 表重试的 exponential backoff
