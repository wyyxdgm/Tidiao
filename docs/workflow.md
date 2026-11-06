# 核心执行流程（交付生命周期）

> 从需求到交付的完整 task 生命周期理论框架：task 分类、阶段链、打回迭代、需求联动、通知与继续任务。
> 每条标注 ✅已实现 / ⚠️部分 / ❌待实现，并对接现有机制给出演进路径。
> 配合 [architecture.md](architecture.md) 的状态机 + [project-version.md](project-version.md) 的三层模型阅读。

## 1. task 类型维度

同一交付物可拆成不同类型 task，各有自己的"完成"与"核对"标准：

| 类型 | 完成判据 | 核对 / 打回判据 |
|------|---------|----------------|
| 设计 task | 设计稿出 | 甲方不同意 / 定稿未过 |
| 开发 task | 功能实现 | 测试有 bug / review 不过 |
| 测试 task | 用例跑完 | 用例失败 / 覆盖不足 |
| 部署 task | 上线完成 | 部署失败 / 线上核对不过 |

- **现状** ✅ (`tasks.type` 字段于 2026-07-25 落地)：新增 schema 列 `type` TEXT (migration v8)，enum: design/dev/test/deploy/null。createTask 接受 `type?`，listTasks/getTaskById 返回。Board task card 与 task-detail 头部显示配色标签（设计粉/开发蓝/测试紫/部署绿）。新建任务页可下拉选择。
- **下轮待补**（schema 已就位，规则未接）：
  - `autoStartDependents` 等调度逻辑按 type 分化（如 deploy 类型强制 paired test 完成才允许）
  - webhook payload 加 type 字段让外部系统按类型路由
  - type-based 统计看板（按版次看设计→开发→测试→部署各有多少）

## 2. 完整阶段链

```
常规设计 → 对接(甲方) → 定稿 → 开发设计 → 对接调整 ⇄ 定稿 → 开发 ⇄ 对接调整 → 测试 ⇄ 对接调整 → 交付
                                                         ↑                     ↑
                                       打回(开发不通过) ──┘   打回(测试不通过) ──┘
```

- 每个开发 / 测试 / 部署阶段核对不通过，**回调**到"对接调整 ⇄ 定稿"，重走下游。
- **现状** ⚠️：`depends_on` 表达 task 间前向依赖，无"阶段"概念，无回调编排。
- **映射**：Version 天然是"定稿"载体（`is_released` 标记交付）；设计 / 对接 / 定稿 = version 准备阶段；开发 / 测试 = version 下 task；交付 = `is_released=true`。
- **演进**：环节即 task，阶段链 = task 间状态推进链（见 §8 编排 agent）；回调 = 打回触发上游 task fork 续做（§6）。

## 3. 打回与迭代

🆕 **R131 重写 (damo 2026-09-15)**：单人协作系统下 reject 端点无意义（无"他人"接驳回），状态机改为 refine + await_user 替代。

**旧状态机** (2026-07-25 - 2026-09-15)：
```
pending → queued → running → reviewing → {approve: completed, reject: rejected}
                                                                  ↓
                                                              start 复用 session 续做
```

**新状态机** (2026-09-15+)：
```
pending → queued → running ⇄ await_user
                  running → reviewing
                  reviewing → {approve: completed, refine: running}
                  await_user → {approve: completed（自动 unwait）, message: running, unawait: running}
```

**核心改动**：
- 删除 `POST /api/tasks/[id]/reject` 端点 + `rejectTask()` 方法
- 新增 `await_user` 状态（区别 `pending`=等系统 / `await_user`=等介入）
- 新增 `/refine`（reviewing → running，投消息让 agent 接着干）/ `/await`（running → await_user，等用户介入/拍板/建议）/ `/unawait`（await_user → running，等结束了）三个端点
- `approve` 端点扩展支持 `await_user` 状态（自动 unwait 透明）
- agent SDK 暴露 `mcp__review__refine` / `mcp__review__await_user` / `mcp__review__unawait` 三个工具（薄包装 HTTP，task_id 自动取）
- DB migration v509 additive（14 列 metadata：`await_*` 5 列 + `unawait_*` 4 列 + `refined_*` 5 列）
- 历史 `rejected` 数据保留显示兼容，不删（避免破坏现有 task 历史）
- 移除 `reject-deploy-notify-dependents` 内置规则（孤儿规则，`to_status=rejected` 不会再触发）

**reason 枚举**：
- `await_reason` 3 选 1：`dispatch_needed` / `decision_pending` / `suggestion`
- `unawait_reason` 3 选 1：`agent_self_resolved` / `user_timeout` / `external_event`

**未实现**（damo 暂搁）：revert 动作（区别 cancelled 的"已撤销"状态）。

设计稿：`docs/plans/review-state-machine-refactor.md` + 决策日志 `docs/decision-log.md` §「决策记录：review 状态机改造（R131）」。

## 4. 需求联动

调整某个需求点时，遍历此前所有相关需求点，通知或一并调整，再重回开发测试交付。

- **现状** ✅ (`task.dependency_changed` webhook + 反向依赖 API 于 2026-07-25 落地)：`depends_on` 前向依赖机制已有，新增反向遍历封装。
  - `GET /api/tasks/[id]/dependents` 返回直接依赖该 task 的 task 列表（基于 task_dependencies JOIN 表，非 LIKE 扫描）。
  - `POST /api/tasks/[id]/notify-dependents` body `{message}` 触发 `task.dependency_changed` webhook，payload 含 root_task / dependents / message。
  - 自动创建"调整 task"（fork 续做）—— **未实现**；当前依赖使用者手动建 task 或外部系统(收到 webhook 后)处理。
- **下轮待补**：
  - 通知 UI（task-detail 显示"通知 dependents"按钮）
  - 自动 create-adjustment-task 选项
  - webhook UI（任务管理 UI 一直未补，详见 decision-log §未来备忘）

## 5. 通知机制

- **现状** ✅ (webhook 2026-07-25 起 8 事件；🆕 R131 2026-09-15 加 `task.await_user`)：webhook 已实现 HMAC-SHA256 签名投递，**9 事件**：`task.created/started/reviewing/completed/failed/cancelled/dependency_changed/await_user`，dispatch 集中在 `AgentRuntime.emitEvent`（见 [decision-log.md](decision-log.md) 出口审计结论）。
- ⚠️ **R131 退役**：`task.rejected` 事件从 dispatch 移除（不再有新流转进入 rejected 状态）。历史 webhook 订阅契约保留兼容。
- **语义定位**：
  - `task.reviewing` = agent 自然完成，待人审批
  - `task.completed` = 人工 approve 通过（await_user 时自动 unwait 透明）
  - `task.await_user` = 🆕 等用户介入/拍板/建议
  - 外部系统按需订阅 -- 想监听 "agent 完成" 订阅 reviewing；想监听 "已交付" 订阅 completed；想监听 "等用户拍板" 订阅 await_user。
- **下轮待补**：
  - retry / 死信队列（5s 超时失败仅记事件，不重投）
  - `/webhooks` 管理 UI（决策日志备忘里一直挂账的）

## 6. 继续任务（fork）

基于原有 task 的 session fork 出继续 task，保留上下文，用于打回迭代 / 需求调整续做。

- **现状** ✅：fork 机制已实现（`forked_from_session_id` + checkpoint），见 [agent-sdk-patterns.md](agent-sdk-patterns.md) Fork 段。

## 7. 持续重复的循环

整个流程在打回 / 需求变更下持续重复：设计 ⇄ 对接 ⇄ 开发 ⇄ 测试 多轮，每轮可能触发需求联动。

- **编排**：调度器（FIFO + 并发）+ `depends_on` 依赖 + fork 续做 + webhook 通知，组合表达循环。
- **现状** ⚠️：单轮 task 调度完整；多轮循环编排(自动触发下一轮、需求联动批量通知) **不在本期**——转交 §8 rule engine 处理。

## 8. 流程编排（规则引擎）

§1-7 的本质:**每个环节就是一个 task 的常规状态切换**, 流水线 = 一串 task 的状态推进链, 打回 / 联动 / 通知 = 状态切换触发的编排动作。

### v1 落地: 事件触发的规则引擎 (2026-07-25)

不是 meta-agent(Agent SDK + LLM), 而是一张 **`task_rules` 表** + 决策分发: `emitEvent` 的 status_change 分支在 webhook dispatch 后调用 `runRules({from, to, task})`。

**规则表 `task_rules`** (migration v9): `from_status` + `to_status` + `condition_json` + `action_type` + `action_params_json` + `enabled`。

**v1 支持的 action_type**:
- `notify_dependents` — 反向遍历依赖该 task 的所有 task, 触发 `task.dependency_changed` webhook

**v1 支持的 condition**: `{ task_type: "deploy" }` — 任务 type 等于指定值。

**内置样板规则** (instrumentation.ts 启动时幂等 seed):
- 🆕 R131 (2026-09-15) 移除：`reject-deploy-notify-dependents` 规则（孤儿规则，`to_status=rejected` 不会再触发）。seed 阶段 DELETE 兜底。

### 形态选项 (v1 选定)

| 形态 | 触发 | 适合 | 状态 |
|------|------|------|------|
| 常驻 agent | 监听事件流持续编排 | 多流程并发、实时联动 | 未采用 (YAGNI) |
| 事件触发 (rule engine) | status_change 查表执行 | 简单、无状态、易追溯 | ✅ v1 |
| 手动流程 task | 用户建"流程 task"，内部跑编排 | 单流程、可审计 | 未采用 |
| **真正的 meta-agent** (Agent SDK + LLM) | 自然语言描述规则 | 自然语言规则场景 | 远期；v1 规则已覆盖常见 case |

### 为什么要规则引擎而非 meta-agent

- 规则表可审计(谁什么时间触发了什么, events 表有 `rule_fired` 行)
- 无 LLM 成本与不稳定性, 规则确定
- 顺序简单, 出错易定位
- 与 status_change 事件流天然耦合

实装发现: meta-agent 在工程层面 ≈ "用 LLM 动态决策", 而当前业务规则确定(打回即通知 dependents), 规则引擎足够。未来真有 NL 编排场景时再升级 meta-agent。

### 下轮待补

- API + UI 管理规则 (CRUD 页面)
- 更多 action_type: `auto_create_followup`, `auto_start_pending_dependent_on_complete` 等
- condition 扩展: tag 匹配 / 时间窗 / 优先级

§1-7 的本质：**每个环节就是一个 task 的常规状态切换**，流水线 = 一串 task 的状态推进链，打回 / 联动 / 通知 = 状态切换触发的编排动作。这套编排不该散落在各 API route 手写，最好由一个**任务管理的 task（agent）**统一处理。

### 形态

一个编排 agent task，自身也是 Task 表一条，有自己的 session（Agent SDK `query()` 驱动），通过工具调用内部 API 驱动流水线：

- **监听** task 状态切换（`status_change` 事件 / webhook）
- **规则编排**：
  - 上游 task `completed` -> 启动下游 task（依赖就绪）
  - `reviewing` 打回 -> fork 上游 session 续做（§6）
  - 需求变更 -> 反向遍历 `depends_on` + 通知相关 task（§4）
  - 核对不通过 -> 按类型触发打回（§3）
- **动态通知**：调用 webhook dispatch / 创建通知 task

### 对接现有（已具备）

| 能力 | 现有机制 |
|------|---------|
| agent 驱动 | Agent SDK `query()` + ActiveSession + canUseTool |
| 事件源 | `status_change` 已汇聚 `emitEvent`（§5）|
| 续做 | fork + checkpoint（§6）|
| 通知 | webhook dispatch（§5）|
| 内部 API 调用 | 编排 agent 授权 tool 调 `/api/tasks`、`/api/feishu/sync` 等 |

### 形态选项（待定）

| 形态 | 触发 | 适合 |
|------|------|------|
| 常驻 agent | 监听事件流持续编排 | 多流程并发、实时联动 |
| 事件触发 | 每次 `status_change` 起一个编排 task | 简单、无状态、易追溯 |
| 手动流程 task | 用户建一个"流程 task"，内部跑编排 | 单流程、可审计 |

- **现状** ❌：无编排 agent，流程推进靠人工建 task + `depends_on`。
- **演进**：先事件触发形态（轻量、可追溯），验证编排规则后再考虑常驻。

## 9. 多 agent 协作与角色演化

§8 是外层（跨 task 编排）。本节处理内层（task 内多 agent）+ 角色配置 + 记忆 + 评估演化。

### 内 vs 外（别重造）

| 层 | 是什么 | 谁来做 | 现状 |
|----|--------|--------|------|
| 内层（一个 task 内）| task agent 调 subagent 做 search/设计/反思链 | Claude Code 原生 Agent tool | ✅ 已有，别造 |
| 外层（跨 task）| task 间流水线/打回/联动/通知 | §8 rule engine（v1 落地）→ 远期 meta-agent | ✅ / 部分 |

- "一人内部反思链" = 内层（已有）；"多人流程协作" = 外层（§8）。
- 内层不重建：task prompt 让 task agent 按需 spawn subagent 即可。

### 角色配置包（role）

不同侧重的 task（深度 search / 设计 / 甲方需求收集）应有可复用角色配置：

```
role = { system_prompt, memory_doc, context_budget, model, allowed_tools }
```

- task 引用 `role_id` 继承配置；role 是模板，task 可覆盖单字段。
- `memory_doc` = 该角色长期记忆 md，每次会话载入 -> "一个文档一个 agent" 的落地。
- meta-agent（§8 远期）/ rule engine（v1 落地）本身也是一个 role。

- **现状** ✅ (`roles` 表 + `tasks.role_id` 于 2026-07-25 落地)：migration v10 建 `roles` 表（id/name/description/system_prompt/model/allowed_tools/effort/max_turns/memory_doc）+ `tasks.role_id` FK。`createTask` 在 `role_id` 存在时自动继承 system_prompt（拼到 prompt 头部作 `[role: ...]` 前缀）+ model/allowed_tools/effort/max_turns defaults；task 级字段覆盖 role defaults。`/api/roles` CRUD 完成（GET/POST/GET[id]/PATCH/DELETE）。
  - 🆕 **Role 场景化四件套（2026-10-13 落地，[role-scoped-roles.md](plans/role-scoped-roles.md) P1-P5）**：v525 `roles.project_id` 项目绑定（NULL=全局，`getRolesForProject` 全局+项目专属合并，createTask 校验 `ROLE_SCOPE_MISMATCH`）+ API/CLI 接线（POST /api/tasks 透传 role_id，`ao-dispatch.sh --role`）+ v526 `channel_configs.role_id` 渠道默认角色（telegram bind 挂载，见 P3 入口实况）+ v527 `roles.feishu_writeback` 回写开关（rule-engine skip + runtime 注入 + 手动回写 403）+ **SPA 管理**（设置 → 角色 tab：新建/编辑/删除 + 项目绑定 + 回写开关；派发表单「角色预设」下拉）。
- **memory_doc 落库但未接运行时** ❌：schema 已支持，**未做**：每次会话 fresh 载入、超预算压缩、与 session 联动。
- **下轮待补**：~~UI 管理 roles~~ ✅ 2026-10-13（SPA 角色 tab）；memory_doc 真正的"外化状态"读/写/压缩闭环；评估 harness + 版本化 prompt。渠道默认角色的**管理 UI** 待补（`channel_configs` 尚无 CRUD API 与 SPA 管理页，现仅 telegram bind 路径消费 role_id）。

### 外化状态（防漂移）

- 每次会话 fresh，`memory_doc` 持久 + 会话内更新；文档为真相源，session 不囤状态。
- 超 `context_budget`（如 100k）-> 触发压缩：旧 memory 摘要归档，复用 `/compact` 思路。
- **现状** ❌：session 临时，无跨会话记忆。
- **演进**：memory_doc 读写 + 预算超限压缩。

### 评估 harness

每个 agent 产出可被使用者/测试者打分（1-5 + 备注）：

- 存 `agent_evals` 表：`role_id / task_id / score / note / round`。
- 聚合出每个 role 的效用曲线。
- **现状** ❌：无评估数据。
- **演进**：评分 API + 聚合查询。

### 版本化 prompt + 人批 A/B（科学化的"自我迭代"）

prompt 是版本化制品（`role_prompts` 表，有 version）。自反馈迭代 = **评估信号驱动 + 人在环**，不是 autonomous：

```
管理 agent 提议 prompt 改动 -> 人审批 -> A/B 跑评估集 -> 分数高才 rollout，否则回退
```

- **现状** ❌：prompt 散在 task 里，无版本。
- **演进**：role_prompts 版本表 + A/B 跑分流程。

### 路由/选举 = meta-agent 调 subagent，不另造

- "筛选目标 agent" = rule engine（v1）/ meta-agent（远期）按请求类型派一个 role。
- "多 agent 整合 + 代表回复" = meta-agent spawn N 个 subagent 读结果综合 -> "代表"即综合步骤。
- Claude Code Agent tool 已是这套，远期 §8 meta-agent 用它即可。

### 明确不做（防后人重提）

- **autonomous self-rewrite**：agent 自己改自己 prompt 并直接生效 -> 不做。自打分无 ground truth 会漂移、烧钱收益不稳。改评估驱动 + 人批。
- **复杂选举机制**：多 agent 投票选代表 -> 默认不做（N× 成本，整合还要个 agent）。仅高风险/歧义场景 opt-in。
- **内层多 agent 重造**：Claude Code 原生 subagent 已是，别造。

## 现状总结

| 要素 | 状态 | 现有机制 | 演进方向 |
|------|------|---------|---------|
| task 类型 | ✅ (2026-07-25, migration v8) | tags / prompt | `tasks.type` 字段已落地。续补：按 type 的调度规则、type 维度统计 |
| 阶段链 | ⚠️ | depends_on + version | 环节即 task，§8 编排 |
| 打回迭代 | ✅ (2026-07-25) → 🆕 重写 (2026-09-15, R131) | reviewing + await_user + refine | 🆕 R131: 删除 `reject` 端点 + `rejected` 写入路径；新增 `await_user` 状态 + `/refine` / `/await` / `/unawait` 三个端点；agent SDK 暴露对应工具。历史 `rejected` 数据保留显示兼容。设计稿：`docs/plans/review-state-machine-refactor.md` |
| 需求联动 | ✅ (2026-07-25) | depends_on（前向） | API + webhook 已落地。续补：通知 UI、自动调整 task、webhook 管理 UI |
| 通知 | ✅ (2026-07-25, 8 事件) → 🆕 9 事件 (R131 2026-09-15) | webhook | 加 `task.reviewing` / `task.dependency_changed` / 🆕 `task.await_user`。退役 `task.rejected`（不再有新流转）。续补: 重试死信队列、`/webhooks` 管理 UI |
| 继续任务 | ✅ | fork + checkpoint | — |
| 循环编排 | ✅ (2026-07-25, migration v9, v1 规则引擎) | 调度器 + 依赖 + fork | rule engine + 1 条样板规则。续补: API/UI、更多 action_type、condition 扩展 |
| 角色配置 | ✅ (2026-07-25, migration v10) | tags/model/allowed_tools 散字段 | role 创建/继承已落地，UI 待补 |
| 外化记忆 | ❌ (schema 有,运行时未接) | session 临时 | memory_doc 字段已落库，需读/写/压缩闭环 |
| 评估/Prompt 演化 | ⚠️ (2026-07-25, v1 评估 harness) | 无 | score API + 聚合 + webhook + task-detail 评分 widget 落地。**未做**：A/B 跑分、autonomous self-rewrite |

## 演进路线（建议优先级）

1. ~~**打回状态**~~：✅ 2026-07-25 落地（commit feaf832）；🆕 R131 (2026-09-15) 重写——单人协作系统下 reject 端点删除，状态机改为 `refine` + `await_user`，详见 §3。
2. ~~**需求联动遍历**~~：✅ 2026-07-25 落地（GET /api/tasks/[id]/dependents + POST .../notify-dependents + webhook task.dependency_changed）。下轮补：通知 UI、自动调整 task。
3. ~~**流程编排 agent**~~：✅ 2026-07-25 落地（v1 规则引擎 + 1 样板规则，event-trigger 不含 LLM）。下轮补 API/UI、更多 action_type。
4. ~~**角色配置包 + 外化记忆**（§9）~~：✅ 大部分落地（roles 表 + tasks.role_id + createTask 继承, 2026-07-25；项目绑定/回写开关/渠道角色/SPA 管理, 2026-10-13）。剩余: memory_doc 运行时闭环、渠道角色管理 UI（channel_configs CRUD API + SPA 页）。
5. ~~**task 类型字段**~~：✅ 2026-07-25 落地（migration v8 + tasks.type + UI labels）。下轮补：按 type 调度的规则、type 维度统计。
6. ~~**评估 harness + 版本化 prompt**（§9）~~：✅ v1 部分落地（agent_evals 表 + POST /api/tasks/[id]/evaluate + webhook task.evaluated + aggregateByRole, 2026-07-25）。**未做**：评分 UI widget、A/B 跑分、autonomous self-rewrite（明确不做：自打分无 ground truth 会漂移）。
7. ~~**`task.reviewing` 事件**~~：✅ 2026-07-25 落地（webhook 8 事件补齐）。
