# 定时任务 API 接口规范

> Base path: `/api/schedules`
> 认证: `Authorization: Bearer <token>` 或 session cookie（middleware 注入 `x-user-id`，所有数据按 owner 隔离）
> **admin 例外**: `[id]` 系列（GET/PATCH/DELETE + `/runs`）对 admin 不按 owner 过滤；`GET /api/schedules?all=true` 列出所有人的（admin only，非 admin 传了静默忽略）
> 内容类型: `application/json`

## 总览

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/schedules` | 列出当前用户的定时任务（`?all=true` admin 列全部）|
| POST | `/api/schedules` | 创建定时任务 |
| GET | `/api/schedules/[id]` | 任务详情 |
| PATCH | `/api/schedules/[id]` | 更新（启停/改表达式/改命令等）|
| DELETE | `/api/schedules/[id]` | 删除（级联删历史）|
| GET | `/api/schedules/[id]/runs` | 触发历史 |
| POST | `/api/schedules/[id]/runs` | 手动触发（立即执行一次）|

---

## 数据模型

### Schedule

```
{
  "id": "uuid",
  "name": "每5分钟巡检",           // 必填，显示名
  "exec_type": "shell" | "agent",  // 执行体类型
  "schedule_type": "cron" | "once",// 调度类型
  "schedule_expr": "*/5 * * * *",  // cron 表达式 / once 的 ISO 时间
  "timezone": "Asia/Shanghai",     // 默认 Asia/Shanghai
  "enabled": true,                 // 启停开关
  "next_run": "2026-08-05T00:05:00Z", // 下次触发（UTC ISO，只读，系统维护）
  "skip_if_running": true,         // 上次还在跑就跳本次（默认 true）

  // agent 执行体字段（exec_type=agent 时必填）
  "title": "巡检",
  "prompt": "检查项目状态并汇报",
  "description": null,
  "project_id": "uuid",            // 必填，任务归属项目
  "version_id": null,              // 可选
  "priority": 0,
  "auto_approve": false,
  "model": null,                   // null=继承项目配置
  "allowed_tools": null,           // null=不限制，JSON array
  "max_turns": null,
  "effort": null,                  // low|medium|high|xhigh|max
  "tags": null,

  // 🆕 v60 自适应频率（仅 exec_type=agent + schedule_type=cron 时有效）
  "freq_min_minutes": null,        // 整数分钟, 都填或都不填, 都填时 min<=max
  "freq_max_minutes": null,        // 启用后 agent 每轮自选下次 cron, 必须落在 [min, max] 内

  // shell 执行体字段（exec_type=shell 时必填）
  "command": "echo tick && date",
  "cwd": null,                     // null=ORCHESTRATOR_HOME

  // 运行态（只读，系统维护）
  "last_run": "2026-08-05T00:00:00Z",
  "last_task_id": null,            // agent: 上次创建的 task id
  "last_exit_code": null,          // shell: 上次退出码（null=进行中）
  "owner_id": "uuid",
  "created_at": "...",
  "updated_at": "..."
}
```

### ScheduleRun（触发历史）

```
{
  "id": 5,                          // 自增
  "schedule_id": "uuid",
  "exec_type": "shell" | "agent",
  "task_id": null,                  // agent 触发时记录
  "command": "echo tick",           // shell 触发时记录
  "exit_code": 0,                   // null=进行中
  "output": "tick\n...",            // shell stdout（截断 64KB）
  "error": "",                      // shell stderr（截断 64KB）
  "started_at": "...",
  "completed_at": null              // null=进行中
}
```

---

## 字段规则

### 创建（POST）必填字段

| exec_type | 必填字段 |
|-----------|---------|
| **shell** | `name`、`command`、`exec_type`、`schedule_type`、`schedule_expr` |
| **agent** | `name`、`title`、`prompt`、`project_id`、`exec_type`、`schedule_type`、`schedule_expr`、`freq_min_minutes`?、`freq_max_minutes`?（自适应频率, 都填或都不填） |

共用必填：`name`、`exec_type`、`schedule_type`、`schedule_expr`。

> **校验**：`exec_type` 必须是 `agent`/`shell`；`schedule_type` 必须是 `cron`/`once`；agent 的 `project_id` 必须属于当前用户（不存在或无权访问返回 400）。

### `schedule_expr` 取值

| schedule_type | schedule_expr 示例 | 说明 |
|---------------|--------------------|------|
| `cron` | `*/5 * * * *` | 标准 5 段：分 时 日 月 周 |
| `cron` | `0 9 * * *` | 每天 9 点（Asia/Shanghai）|
| `cron` | `0 0 * * 0` | 每周日凌晨 |
| `once` | `2026-08-06T03:00:00Z` | ISO 8601 时间，触发后自动 `enabled=false` |

cron 表达式由 [`cron-parser`](https://www.npmjs.com/package/cron-parser) v5 解析，支持标准 5 段语法及 `*/N`、范围 `1-5`、列表 `1,3,5`。timezone 默认 `Asia/Shanghai`。

### PATCH 可更新字段

| 字段 | 说明 |
|------|------|
| `name`、`enabled`、`skip_if_running` | 基础 |
| `title`、`prompt`、`command`、`cwd` | 执行内容 |
| `timezone` | 时区 |
| `schedule_type`、`schedule_expr` | **改后自动重算 `next_run`** |
| `freq_min_minutes`、`freq_max_minutes` | 🆕 v60 自适应频率（agent + cron only; 都填或都不填; 传 `null` = 关闭） |

PATCH 只写 `!== undefined` 的字段：未传的跳过，传 `false`/`0` 正常生效。改 `schedule_type`/`schedule_expr`/`timezone` 任一会触发 `next_run` 重算。

---

## 接口详情

### GET `/api/schedules`

列出当前用户的定时任务。

**Query**:
- `project=<projectId>` — 按项目过滤（可选）

**Response** `200`
```json
[ { "id": "...", "name": "...", ... } ]
```

---

### POST `/api/schedules`

创建定时任务。创建时自动算好 `next_run` 存入。

**Request body**（shell 示例）:
```json
{
  "name": "每5分钟巡检",
  "exec_type": "shell",
  "command": "echo tick && date",
  "schedule_type": "cron",
  "schedule_expr": "*/5 * * * *"
}
```

**Request body**（agent 示例）:
```json
{
  "name": "每日巡检",
  "exec_type": "agent",
  "title": "巡检",
  "prompt": "检查项目状态并汇报",
  "project_id": "<projectId>",
  "schedule_type": "cron",
  "schedule_expr": "0 9 * * *"
}
```

**Response** `201` — 完整 Schedule 对象（见数据模型）

**Errors**:
- `400` — 必填缺失 / `exec_type`/`schedule_type` 非法 / agent 的 project 不属于当前用户 / 🆕 v60 自适应频率校验失败
  ```json
  { "error": "agent schedule requires title and prompt" }
  { "error": "freq_min/max 只允许 agent + cron schedule; shell/once 频率区间无意义" }
  { "error": "freq_min_minutes 与 freq_max_minutes 必须同时设置或同时为空" }
  { "error": "freq_min_minutes (10) 不能大于 freq_max_minutes (5)" }
  { "error": "invalid freq_min_minutes: 0 (need integer >= 1)" }
  ```

---

### GET `/api/schedules/[id]`

**Response** `200` — 完整 Schedule 对象
**Errors**: `401` 未认证 · `404` 不存在或无权访问

---

### PATCH `/api/schedules/[id]`

部分更新。只写传入的字段。

**可更新字段**（= `UPDATABLE_SCHEDULE_FIELDS`，`src/lib/db/schedules.ts` 导出）：
`name` `enabled` `schedule_type` `schedule_expr` `timezone` `skip_if_running`
`title` `prompt` `command` `cwd` `description` `project_id` `version_id`
`priority` `auto_approve` `model` `allowed_tools` `max_turns` `effort` `tags`

🔴 **未知字段 → 400，不静默丢弃**（2026-08-13 修）。修之前 `updateSchedule` 只认前 10 个，
其余（`max_turns`/`effort`/`model`/`tags`...）既不写库也不报错，且 `fields` 为空时原样返回旧对象
= HTTP 200 + 完整 JSON，调用方分不清「改成功」和「整个请求被忽略」。`cron.sh` 的这批 flag
因此空转还每次打 ✅。根因：PATCH 对未变更字段的处理曾静默吞参（已修）。

🔴 **`null` ≠ 键不存在**：键不存在/`undefined` = 不改；显式 `null` = 置空。
`{"max_turns": null}` = 不限轮次（运行时回落默认 200）。`0`/`false`/`""` 是正常值不是「没传」。

**Request body**（任意子集）:
```json
{ "enabled": false }
```

改表达式会自动重算 `next_run`：
```json
{ "schedule_expr": "0 0 * * *" }
```

放开轮次限制（CLI 等价写法 `cron.sh update <id> --max-turns 0`）：
```json
{ "max_turns": null }
```

**Response** `200` — 更新后的 Schedule 对象
**Errors**: `401` · `404` · `400` 未知字段（响应含 `unknown_fields` + `updatable_fields`）/ 脏值（`max_turns` 需 `>=1` 整数或 null；`effort` 需 `low|medium|high|xhigh|max` 或 null）

---

### DELETE `/api/schedules/[id]`

级联删除 `schedule_runs`（外键 `ON DELETE CASCADE`）。

**Response** `200`
```json
{ "ok": true }
```
**Errors**: `401` · `404`

---

### GET `/api/schedules/[id]/runs`

触发历史，按 `started_at DESC`。

**Query**:
- `limit=<n>` — 默认 20

**Response** `200`
```json
[
  {
    "id": 5,
    "schedule_id": "...",
    "exec_type": "shell",
    "task_id": null,
    "command": "echo tick && date",
    "exit_code": 0,
    "output": "tick\n2026年...",
    "error": "",
    "started_at": "2026-08-04T23:23:50.413Z",
    "completed_at": "2026-08-04T23:23:50.531Z"
  }
]
```

agent 触发的 run：`task_id` 非空，`command`/`output`/`error`/`exit_code` 为 null（详情看 task）。

**Errors**: `401` · `404`

---

### POST `/api/schedules/[id]/runs`

**手动触发**：立即执行一次。

**核心语义**：不影响正常节奏。
- **不推进 `next_run`** — 下次自动触发时间不变
- **不禁用 once schedule** — once 仍按原计划触发
- **不改 `enabled`** — 暂停的 schedule 也能手动触发
- `skip_if_running` 仍生效 — 上次还在跑则返回 409

**Request body**: 无（空 body 即可）

**Response** `200`
```json
{ "ok": true, "task_id": "uuid" }
```
`task_id`：agent 触发时为创建的 task id；shell 触发时为 `null`。

**Response** `409` — 该 schedule 派出的任务还没走完（`skip_if_running` 阻止重叠）
```json
{ "error": "上一次派出的任务还没走完（<task-id> 状态 reviewing）" }
```
shell 命令进程自身还在跑时是 `{ "error": "上一次触发的命令仍在执行" }`。

**Errors**: `401` · `404`

---

## 统一错误格式

所有错误响应：
```json
{ "error": "<错误描述>" }
```

| 状态码 | 含义 |
|--------|------|
| `400` | 请求参数错误（必填缺失、类型非法、校验失败）|
| `401` | 未认证（缺少 `Authorization` / cookie）|
| `404` | 资源不存在或无权访问（不泄露存在性）|
| `409` | 冲突（手动触发时上次运行仍在进行）|

---

## 触发机制与行为约定

| 项 | 说明 |
|----|------|
| **轮询精度** | 60s `setInterval`，分钟级 |
| **自动触发** | `next_run <= now` 即触发；触发前 `claimSchedule()` 原子推进 `next_run`，防重触发 |
| **cron 推进** | 每次自动触发后 `next_run` 推到下一个未来点 |
| **once 触发** | 自动触发后 `enabled` 自动置 false |
| **手动触发** | 不推进 `next_run`、不禁用、不改 `enabled`，纯粹"额外跑一次" |
| **防重派** | `skip_if_running`（默认 true）：按 `tasks.schedule_id` 反查该 schedule 派出的 task，只要不在 `completed/failed/cancelled` 就跳过本次（`reviewing`/`paused`/`rejected` 都算在飞）。shell 类另有进程级内存追踪。🔴 shell 脚本自建 task 必须传 `schedule_id`，否则平台看不见 = 闸门无效 |
| **重启补跑** | 重启后 `next_run <= now` 的会补跑一次，然后恢复节奏 |
| **shell 超时** | 10 分钟，超时 `exit_code=124` |
| **shell 输出** | stdout/stderr 各截断 64KB 存 `schedule_runs` |
| **agent 执行** | 复用 `createTask()` + `startTask()`，进 TaskScheduler 队列，受并发/per-cwd 互斥约束（核心零改动）|

---

## curl 示例

```bash
# 环境变量（见 docs/testing-tokens.md）
source scripts/.env.tokens

# 创建 shell 定时（每 5 分钟）
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"每5分钟巡检","exec_type":"shell","command":"echo tick && date","schedule_type":"cron","schedule_expr":"*/5 * * * *"}'

# 创建 agent 定时（每天 9 点）
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"每日巡检","exec_type":"agent","title":"巡检","prompt":"检查项目状态并汇报","project_id":"<pid>","schedule_type":"cron","schedule_expr":"0 9 * * *"}'

# 创建一次性（指定时间跑一次，触发后自动停用）
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"延时备份","exec_type":"shell","command":"/path/backup.sh","schedule_type":"once","schedule_expr":"2026-08-06T03:00:00Z"}'

# 创建带自适应频率的 agent 定时（v60；agent 每轮自选 [3, 30] 分钟内下次 cron）
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI 自调频巡检",
    "exec_type": "agent",
    "title": "巡检",
    "prompt": "巡检并自选下次 cron 表达式",
    "project_id": "<pid>",
    "schedule_type": "cron",
    "schedule_expr": "*/5 * * * *",
    "freq_min_minutes": 3,
    "freq_max_minutes": 30
  }'

# PATCH 启用 / 关闭自适应频率（v60）
# 启用：
curl -X PATCH -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"freq_min_minutes": 5, "freq_max_minutes": 60}' \
  http://localhost:13000/api/schedules/<id>
# 关闭（两个字段都显式置 null；只传一个 = 400）：
curl -X PATCH -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"freq_min_minutes": null, "freq_max_minutes": null}' \
  http://localhost:13000/api/schedules/<id>

# 列表
curl -H "Authorization: Bearer $MAC_ADMIN_TOKEN" http://localhost:13000/api/schedules

# 详情
curl -H "Authorization: Bearer $MAC_ADMIN_TOKEN" http://localhost:13000/api/schedules/<id>

# 启停
curl -X PATCH -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}' http://localhost:13000/api/schedules/<id>

# 手动触发
curl -X POST -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  http://localhost:13000/api/schedules/<id>/runs

# 触发历史
curl -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  http://localhost:13000/api/schedules/<id>/runs

# 删除
curl -X DELETE -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  http://localhost:13000/api/schedules/<id>
```

---

## 相关文档

- 功能说明: [`docs/schedules.md`](schedules.md)
- 路由总表: [`docs/api-routes.md`](api-routes.md)
