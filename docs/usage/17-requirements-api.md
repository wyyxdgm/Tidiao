# 17. 需求点 API（AI 编程用接口）

> **受众**：agent / 自动化脚本。**作用**：程序化操作 in_app 需求点（新建、查询、改、派 task、看时间线、上传附件）。
>
> **与飞书无关** — 飞书写回（task 完成 → 飞书 T/W/Z 列）另见 [docs/usage/14-requirement-management.md §飞书写回](./14-requirement-management.md#飞书写回独立体系) 和 `src/lib/feishu/write-back.ts`。本章**不重复**飞书接口。
>
> **对照**：与「派发任务」一样，所有需求点操作都有 HTTP 端点（`/api/requirements/*`）+ 在 buildEnv 自动注入 AO_TOKEN 的 agent session 中可直接调用。本章是这份契约的速查表。

---

## 0. 入口与认证

| 项 | 值 |
|----|----|
| Base URL | `http://localhost:13000`（dev）/ `https://dao.example.com`（prod：13000）/ `https://ao.example.com`（pulu：13000） |
| 认证方式 | 浏览器走 cookie；agent 子进程由 buildEnv 注入 `AO_TOKEN`（`ao_xxx`）到 shell env；CLI 调用走 `bash scripts/login.sh` |
| 用户标识 | header `x-user-id`（cookie session 也算） |
| Actor 标识（agent 调时建议带） | header `x-actor-type: agent` + `x-task-id: <本 task id>` → 时间线能追溯来源 |
| 通用状态码 | `200` 成功 / `201` 创建 / `400` 入参错（带 `code` 字段）/ `401` 未鉴权 / `403` quota / `404` 不存在或跨 owner / `413` 文件过大 / `415` 媒体类型不在白名单 / `500` 服务端错 |

**🔴 多租户硬约束**：所有读/写路径都按 `owner_id` 过滤；跨 owner / 不存在 = **404**（不泄露存在性，no existence leak）。这条覆盖全部端点，不是建议是硬规则。

---

## 1. 端点速查（按动词分组）

### 1.1 读

| 用途 | Method + Path | 入参 | 出参 | 错误码 |
|------|---------------|------|------|--------|
| 列需求点 | `GET /api/requirements` | query: `project_id` / `version_id`（`?version_id=null` 过滤无版本需求点）/ `status`（逗号分隔多值）/ `source`（固定 `in_app`）/ `page` / `page_size`（1-100，默认 20） | `{items: Requirement[], total, has_more, page, page_size}` | 400 `STATUS_INVALID`/`SOURCE_INVALID`/`PAGE_INVALID`/`PAGE_SIZE_INVALID` / 401 |
| 单条详情 | `GET /api/requirements/[id]` | — | `Requirement` + `tasks: Task[]` + `eligible_for_done: boolean` | 404 |
| 关联 task 森林 | `GET /api/requirements/[id]/tasks` | query: `with_deps=true\|1`（带 edges）/ 缺省只返 tasks | `{requirement_id, tasks: [{id,title,status,depends_on[],created_at,dispatched_by_task_id}], edges?: [{from,to}]}` | 404 |
| 单条字段变更时间线 | `GET /api/requirements/[id]/revisions` | query: `limit` 1-500（默认 100） | `{requirement_id, revisions: [{id, requirement_id, field, old_value, new_value, actor_type, actor_id, task_id, created_at}, ...]}` | 404 |
| 全局增量变更流 | `GET /api/requirements/revisions` | query: `since` / `until`（ISO 8601 或 sqlite datetime，半开区间 [since, until)）/ `actor_type` (`user`/`agent`/`system`) / `requirement_id` / `limit` 1-500 / `cursor`（上一页的 `next_cursor` 透传） | `{items: Revision[], next_cursor, has_more}` | 400 `SINCE_INVALID`/`UNTIL_INVALID`/`ACTOR_TYPE_INVALID`/`LIMIT_INVALID` |
| 附件列表 | `GET /api/requirements/[id]/attachments` | — | `{attachments: Attachment[]}` | 404 |

### 1.2 写

| 用途 | Method + Path | 入参 | 出参 | 错误码 |
|------|---------------|------|------|--------|
| 新建 | `POST /api/requirements` | JSON: `project_id`（必填）/ `title`（必填，1-200，trim）/ `version_id`（可选；不传=自动取 `projects.current_version_id`；传 `null`=显式不挂；传字符串=必须存在且同 project）/ `description`（可选）/ `priority`（整数 1-5）/ `tags`（`string[]`，元素非空） | 201 + `Requirement`（`status` 固定 `pending`，`source` 固定 `in_app`） | 400 `PROJECT_REQUIRED`/`TITLE_REQUIRED`/`PRIORITY_OUT_OF_RANGE`/`TAGS_INVALID`/`VERSION_ID_INVALID`/`VERSION_PROJECT_MISMATCH` / 404 `PROJECT_NOT_FOUND`/`VERSION_NOT_FOUND` / 401 |
| 改（白名单 PATCH） | `PATCH /api/requirements/[id]` | JSON: `title` / `description` / `status` / `priority` / `tags` / `version_id` / `progress`（0-100 整数或 null；R196 v517，写时后端固定 `progress_source='manual'`）/ `progress_note`（**8 个**；其他字段显式 400 防越权写，`progress_source` 不可直接改） | `Requirement` | 400 `FIELDS_NOT_ALLOWED`（带 `allowed: [白名单]`）/ `STATUS_INVALID` / `PRIORITY_OUT_OF_RANGE` / `TAGS_INVALID` / `PROGRESS_INVALID` / `REQUIREMENT_DONE_GUARD`（想做 done 但没 impl task）/ `VERSION_ID_INVALID` / `VERSION_PROJECT_MISMATCH` / 404 |
| 规则重算完成度 | `POST /api/requirements/[id]/progress` | body 可选 `{action: "recalc"}`；按 task 聚合重算并落库（`progress_source='rule'`，note 自动生成） | `Requirement` | 400 `ACTION_INVALID` / 404 |
| 软删 | `DELETE /api/requirements/[id]` | — | `{id, status: "closed"}` | 404（不存在或已 closed） |
| 上传附件 | `POST /api/requirements/[id]/attachments` | `multipart/form-data`: `file` 字段 | 201 + `{attachment}` | 400 `file is required` / `Invalid multipart form data` / 404 / 413 `File too large (max 10MB)` / 415 `Unsupported file type` |
| 删附件（通用） | `DELETE /api/attachments/[attachmentId]` | — | — | — |

### 1.3 派 task（与需求点联动）

| 用途 | Method + Path | 入参 | 出参 | 关键点 |
|------|---------------|------|------|--------|
| 在需求点下创建 task | `POST /api/tasks` | JSON: `project_id`（必）/ `title`（必）/ `prompt`（必）/ `requirement_id`（可选）/ `type`（可选 `design`/`dev`/`test`/`deploy`，默认未分类）/ `autoApprove`（默认 true）/ `effort`（`low`/`medium`/`high`/`max`，默认 `high`）/ `maxTurns`（默认 200）/ `allowedTools`（默认全开） | 201 + `Task`（`requirement_id` 已绑） | closed 需求点 → 400 `REQUIREMENT_CLOSED`；不存在/跨 owner → 400 `REQUIREMENT_NOT_FOUND` |
| 自动派发（W2 cron 接缝） | `POST /api/requirements/[id]/auto-dispatch` | JSON: `title`（可选，默认 `[auto] <需求点标题前 80 字>`）/ `prompt`（可选，默认自动拼）/ `type`（默认 `dev`）/ `effort` / `autoApprove` / `maxTurns` / `allowedTools` / `start`（**默认 true 自动入队；传 `false` 仅创建不启动**） | `{task: {id, title, status, type}, started: boolean, requirement_id}` | closed 拒收 / quota 拦截返 403 `QUOTA_BLOCKED` / project 缺失 → 400 `PROJECT_REQUIRED` / type 非法 → 400 `TYPE_INVALID` |
| 列 task | `GET /api/tasks` | query: `project_id` / `requirement_id` / `status` / `type` / `page` / `page_size` | **`Task[]` 数组**（⚠️ 不是 `{items,total,has_more}` 信封） | 不带过滤返回**全平台 task**——务必加 `requirement_id`/`status` 缩小范围 |

---

## 9. CLI 封装：`scripts/requirements.sh`

> **2026-09-05 补**：本节对应需求已落地。直接调上面 HTTP 端点之外，仓库提供了 **统一 CLI 封装**（仿 `scripts/ao-dispatch.sh` + `scripts/feishu.sh` 风格），agent 不必记 HTTP 路径 / 拼鉴权 header / 处理 4xx 错误码。

### 9.1 子命令

| 子命令 | 等价 HTTP | 说明 |
|--------|----------|------|
| `create` | `POST /api/requirements` | 新建需求点 |
| `get` | `GET /api/requirements/[id]` | 单条详情 + 关联 task + `eligible_for_done` |
| `list` | `GET /api/requirements` | 列表（按 project/status/version 过滤，分页） |
| `patch` | `PATCH /api/requirements/[id]` | 白名单改（title/description/status/priority/tags/version_id） |
| `delete` | `DELETE /api/requirements/[id]` | 软删（`status='closed'`） |
| `revisions` | `GET /api/requirements/[id]/revisions` | 单条字段级时间线 |
| `revisions-stream` | `GET /api/requirements/revisions` | 全局增量流（since/until/actor_type） |
| `attach` | `POST /api/requirements/[id]/attachments` | 上传附件（multipart） |
| `dispatch` | `POST /api/requirements/[id]/auto-dispatch` | 在需求点下创建 task（默认自动启动，`--no-start` 仅创建） |
| `tasks` | `GET /api/requirements/[id]/tasks` | 关联 task 列表（森林 API，`--with-deps` 带 edges） |
| `list-tasks` | `GET /api/tasks` | 全平台 task 列表（按 requirement/status/type 过滤，**默认 page_size=50 避免刷屏**） |

### 9.2 通用参数

| 参数 | 说明 |
|------|------|
| `--base URL` | 平台地址（默认按环境检测 localhost:13000） |
| `--token AO_XXX` | 不过期 bearer（`Authorization: Bearer`）—— 优先于密码 |
| `--email EMAIL` / `--password PASS` | 登录凭据（fallback） |
| `--json` | 原始 JSON 输出（默认走 `python3 json.dumps` 漂亮打印） |
| `--quiet` | 只输出关键 id（供脚本管道） |
| `help <subcommand>` | 子命令详细帮助 |

### 9.3 鉴权

复用 `scripts/login.sh` 的 `ao_resolve_auth`：
1. 优先 `AO_TOKEN` env（或 `--token`）→ `Authorization: Bearer ao_xxx`
2. 否则密码登录 → `Cookie: session=...`

agent 子进程由 buildEnv 注入 `AO_TOKEN`，**零配置可用**。

### 9.4 用法示例

```bash
# 1. 全局帮助
scripts/requirements.sh help

# 2. 创建 + 改 + 派 task + 看时间线
scripts/requirements.sh create --project-id 080af705-... --title "实现导出" --priority 2 \
  | jq -r .id | xargs -I{} scripts/requirements.sh get --id {}
scripts/requirements.sh patch --id <req-uuid> --status awaiting_reply
scripts/requirements.sh dispatch --requirement-id <req-uuid> --title "fix: xxx" --prompt "..."
scripts/requirements.sh tasks --requirement-id <req-uuid> --with-deps
scripts/requirements.sh revisions --id <req-uuid>

# 3. 批量看需求点改动流（agent self-monitoring）
scripts/requirements.sh revisions-stream --since $(date -u -d "1 hour ago" +%FT%TZ) \
  --actor-type agent | jq '.items[].field' | sort | uniq -c

# 4. 只创建不启动（避免 agent SDK 占用资源，跑 CI / dry-run）
scripts/requirements.sh dispatch --requirement-id <req-uuid> \
  --title "no-op smoke" --prompt "..." --no-start

# 5. 按 requirement 列 task（替代 GET /api/tasks 自己拼分页）
scripts/requirements.sh list-tasks --requirement-id <req-uuid> \
  --status completed --json | jq '[.[] | {id, status, type}]'
```

### 9.5 端到端验证

CLI 已 2026-09-05 在本仓 dev 实例（localhost:13000）真调 API 跑通：
- `create` → `get` → `patch`（status + description 多字段）→ `dispatch`（默认自动启动 + `--no-start` 两种）→ `tasks` → `revisions` → `revisions-stream` → `list-tasks` → `delete`
- 全程验证 HTTP 响应体结构；`--no-start` 经 fix 后正确传 `body.start=false`（首版漏传导致 task 误启动，详见脚本 commit message）
- 端到端清理流程：cancel 误启动的 task → `delete` 软删 requirement → `get` 验证 status=closed

### 9.6 与「派发任务」对照

| 类比 | 派发任务 | 操作需求点（**含派发**） |
|------|---------|------------------------|
| 入口 API | `POST /api/tasks` | `POST /api/requirements/*` + `POST /api/tasks` |
| CLI 封装 | `scripts/ao-dispatch.sh` | **`scripts/requirements.sh`**（新增，2026-09-05） |
| 上位设计 | `docs/usage/03-tasks.md` | 本章 + `docs/usage/14-requirement-management.md` |
| DB 模块 | `src/lib/db/tasks.ts` | `src/lib/db/requirements.ts` |
| 飞书关联 | `task.tags` 含 `R{row}` | `task.requirement_id` FK |

**结论**：本节 §9 之前写的「CLI 缺口」状态于 2026-09-05 起关闭。

---

## 2. 状态机（6 态）

| status | 中文 | 含义 | 终态？ | 飞书 O 列对应 |
|--------|------|------|--------|--------------|
| `pending` | 未开始 | 默认新建态 | 否 | 空 |
| `awaiting_reply` | 等回复 | 等派发人回复后再继续 | 否 | `等回复` |
| `has_suggestion` | 有建议 | 有建议给派发人 | 否 | `有建议` |
| `blocked` | 需拍板 | 需要拍板才能继续 | 否 | `卡住` |
| `done` | 已完成 | 至少 1 个 dev/test/deploy task completed | ✅ | `1` |
| `closed` | 已关闭 | 软删（不可重派） | ✅ | （飞书无对应） |

**对齐飞书 O 列四态** + 1 个内部终态 `closed`。

---

## 3. 关键不变量（patch 前必看）

### 3.1 R78 W1 §4.3 — `status='done'` 守卫（damo 痛点核心）

> **`status='done'` 必须在当前 requirement 下有 ≥1 个 `type ∈ {dev, test, deploy}` 且 `status='completed'` 的关联 task**，否则 PATCH 返回 **400 + `code: REQUIREMENT_DONE_GUARD`**。

**反模式**：agent 拿到 design task 完成就试图把 requirement 标 done → 400。

**正确流程**：
1. `GET /api/requirements/[id]` 看响应里 `eligible_for_done: boolean`
2. 若 `true` → PATCH `status: 'done'`
3. 若 `false` → 先创建 `type='dev'`（或 test/deploy）task 并等它 `completed`

### 3.2 R78 W1 §4.4 — PATCH 短路（防 polling 死循环）

| 入参 | 行为 |
|------|------|
| `{status: <current.status>}`（纯 status 字段） | **200 + 不写 DB**（短路返当前行，revision 行数 +0）—— 防重复 polling / UI 防抖 |
| `{status: <current.status>, title: '新'}`（多字段） | 走 `updateRequirement` 把 `title` 一并落库，**不**静默丢字段（W1 Bug 1 修复，commit `68a471c`） |
| `{status: <current.status>, description: null}` | 显式置空 description = 走 DB 层（`null` ≠ 不写） |

### 3.3 白名单硬隔离（防越权写）

- **POST 新建**：priority 越界 / tags 不合法 → 400（**不能静默吞**，让调用方立刻修）
- **PATCH 改**：priority 越界 → 400；**白名单外字段** → 400 `FIELDS_NOT_ALLOWED`（防止前端多塞 `id`/`source` 污染 DB）
- **DB 层**：`updateRequirement()` 二次校验白名单外字段 / `version_id` 跨 project 静默忽略（应用层 + DB 双保险）

### 3.4 跨 owner = 404（no existence leak）

全周期覆盖（每个端点都跑这条）：
- `GET    /api/requirements/[id]` / `[/id]/revisions` / `[/id]/tasks` / `[/id]/attachments`
- `PATCH  /api/requirements/[id]`
- `DELETE /api/requirements/[id]`
- `POST   /api/tasks` 带别人的 `requirement_id` → 400 `REQUIREMENT_NOT_FOUND`

回归测试：`src/app/api/requirements/[id]/{route.test,tasks/route.test,revisions/route.test}.ts` + `src/app/api/tasks/route.test.ts`。

---

## 4. Actor（谁在改）/ 时间线

每条 PATCH / DELETE / 创建会写一条 `requirement_revisions` 字段级 diff（`recordRevision(requirementId, field, oldValue, newValue, actor)`）：

| `actor_type` | 何时 | `actor_id` | `task_id` |
|--------------|------|-----------|-----------|
| `user` | 浏览器/手动操作 | 当前 user id | null |
| `agent` | agent SDK 通过 API 调用（推荐带 `x-actor-type: agent` header） | agent 名或 user id | 推荐带来源 task id |
| `system` | 平台内部（future 批量 reconcile 等） | 系统标识 | — |

**agent 调用建议**：在 header 里带 `x-actor-type: agent` + `x-task-id: <本 task id>`，平台 `parseActorFromRequest(request, userId)` 自动捕获，写入 `actor_type='agent'` + `task_id=<你传的>`。后续能在需求点详情页时间线追溯到「这个 status 变更来自哪个 task」。

---

## 5. 反模式（必避清单）

| 行为 | 后果 | 怎么修 |
|------|------|--------|
| 不知道 requirement 是否 closed 就调 `POST /api/tasks` 带 `requirement_id` | 400 `REQUIREMENT_CLOSED` | 先 `GET /api/requirements/[id]` 看 status |
| PATCH `status='done'` 没先调 GET 看 `eligible_for_done` | 400 `REQUIREMENT_DONE_GUARD` | 走 §3.1 三步流程 |
| PATCH body 里塞 `id` / `project_id` / `source` / `created_at` / `updated_at` | 400 `FIELDS_NOT_ALLOWED`（带 `allowed: [...]`） | 只传白名单 6 字段 |
| priority 越界 / 非整数 | 400 `PRIORITY_OUT_OF_RANGE` | 1-5 整数 |
| tags 传 `string\|object\|null` | 400 `TAGS_INVALID` | 必须是 `string[]` 元素非空 |
| `version_id` 字符串但不存在 | 404 `VERSION_NOT_FOUND` | 先 `GET /api/versions` 拿有效 id |
| `version_id` 与当前 requirement 跨 project | 400 `VERSION_PROJECT_MISMATCH` | 取该 requirement 的 project 下的 version |
| 上传文件 > 10MB | 413 | 压缩 / 切分 |
| 上传 Office/音视频（白名单不含） | 415 | 转 PDF 或图片；白名单见 `docs/attachments.md` |
| **以为 `GET /api/feishu/sync` 能从飞书 sheet 拉需求点进 platform** | 该路由 **R60 已删**，静默 404 | R60 起飞书与 platform **解耦**（无同步链路），不要走这条路 |
| 不带 `x-user-id` / cookie 调 API | 401 `unauthorized` | 浏览器走 cookie；agent 走 buildEnv 注入的 `AO_TOKEN`（自动 `login.sh`） |
| quota 用尽时硬调派发 | 403 `QUOTA_BLOCKED` | 走 `GET /api/user/me` 看 quota；超限等窗口 |

---

## 6. 飞书关系（一图理清 platform vs 飞书）

R60 起两套**独立**体系，靠 `task.tags` 的 `R{row}` tag 单向关联：

| 维度 | platform `requirements`（**本章**） | 飞书 sheet（**另见 14 章 §飞书写回**） |
|------|-------------------------------------|-----------------------------------|
| 数据源 | SQLite `requirements` 表（`source='in_app'`） | 飞书云端 |
| 主键 | UUID | 物理行号 `R{row}`（一版一表后格式 `v{name}-R{row}`） |
| status | 6 态（见 §2） | 飞书 O 列四态 + 空 |
| 改的方式 | 本章 API | lark-cli / `scripts/feishu.sh` |
| 关联 task | `tasks.requirement_id` FK | `task.tags` 含 `R{row}` tag |
| 写回触发 | 用户 PATCH / 自动派 task | task 完成 → rule engine 调 `writeBackFeishu()` → 飞书 T/W/Z 列 |

**结论**：本章描述的是 platform 一侧；飞书写回接口见 `src/lib/feishu/write-back.ts` 的 `writeBackFeishu(taskId, ownerId?)`，**不在本章**。

---

## 7. 完整 curl 示例（agent 复制改 ID 即可用）

> 假设已在 `bash scripts/login.sh` 拿到 cookie 或 buildEnv 注入了 `AO_TOKEN`，且 `BASE` 是平台域名。

```bash
BASE=http://localhost:13000
COOKIE='Cookie: ao_session=<your-token>'

# 1) 列当前 user 的所有需求点（只看 in_progress）
curl "$BASE/api/requirements?status=pending,awaiting_reply,has_suggestion" \
  -H "$COOKIE" | jq '.items[] | {id, title, status, priority}'

# 2) 新建一个需求点
curl -X POST "$BASE/api/requirements" \
  -H "$COOKIE" -H 'Content-Type: application/json' \
  -d '{
    "project_id": "37c28ff5-...",
    "title": "实现订单导出按钮",
    "description": "在订单列表页加导出按钮，支持 CSV/XLSX",
    "priority": 2,
    "tags": ["ui", "order"]
  }'

# 3) 拉单条详情（含关联 task + eligible_for_done）
curl "$BASE/api/requirements/<id>" -H "$COOKIE" | jq

# 4) 改 status 为「等回复」
curl -X PATCH "$BASE/api/requirements/<id>" \
  -H "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"status": "awaiting_reply"}'

# 5) 拉时间线
curl "$BASE/api/requirements/<id>/revisions?limit=20" -H "$COOKIE" | jq

# 6) 自动派一个 dev task 并启动（在需求点下创建）
curl -X POST "$BASE/api/requirements/<id>/auto-dispatch" \
  -H "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"title": "实现订单导出", "type": "dev", "effort": "high"}'

# 7) 等 dev task completed 后标 done（先看 eligible_for_done）
curl "$BASE/api/requirements/<id>" -H "$COOKIE" | jq '.eligible_for_done'
# → true 后才能：
curl -X PATCH "$BASE/api/requirements/<id>" \
  -H "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"status": "done"}'

# 8) 软删
curl -X DELETE "$BASE/api/requirements/<id>" -H "$COOKIE"
# → {"id":"<id>","status":"closed"}

# 9) 上传附件（两步法：先建 → 再逐文件 POST attachments）
curl -X POST "$BASE/api/requirements/<id>/attachments" \
  -H "$COOKIE" \
  -F 'file=@./spec.pdf'

# 10) 全局增量变更流（看板 / webhook 用）
curl "$BASE/api/requirements/revisions?since=2026-09-03T00:00:00Z&actor_type=agent&limit=50" \
  -H "$COOKIE" | jq '{items: [.items[] | {field, actor_type, task_id, created_at}], next_cursor, has_more}'
```

---

## 8. 实现原理（开发者参考）

- **表**：`requirements`（v64）+ `requirement_revisions`（v63）+ `attachments`（v69 polymorphic）
- **DB 模块**：
  - `src/lib/db/requirements.ts` —— `createRequirement` / `getRequirementById` / `listRequirements` / `updateRequirement` / `softDeleteRequirement` / `getRequirementTasks` / `getRequirementAggregates` / `hasCompletedImplementationTask`
  - `src/lib/db/requirement-revisions.ts` —— `recordRevision` / `listRevisions` / `listRevisionsByTimeRange` / `encodeRevisionCursor` / `decodeRevisionCursor` / `getLatestRevisions`
- **API 路由**（共 7 个 `route.ts`）：
  - `src/app/api/requirements/route.ts`（POST + GET）
  - `src/app/api/requirements/[id]/route.ts`（GET + PATCH + DELETE）
  - `src/app/api/requirements/[id]/revisions/route.ts`（GET）
  - `src/app/api/requirements/revisions/route.ts`（GET）
  - `src/app/api/requirements/[id]/tasks/route.ts`（GET）
  - `src/app/api/requirements/[id]/attachments/route.ts`（GET + POST）
  - `src/app/api/requirements/[id]/auto-dispatch/route.ts`（POST）
- **关联 task 创建**：`POST /api/tasks`（`src/app/api/tasks/route.ts`）+ `POST /api/requirements/[id]/auto-dispatch`（W2 cron 接缝）
- **前端 page**：`src/app/requirements/{page,new,[id]/page}.tsx`
- **上位设计**：[`docs/usage/14-requirement-management.md`](./14-requirement-management.md)
- **飞书写回（独立体系）**：`src/lib/feishu/write-back.ts`（任务完成 → 飞书 T/W/Z 列）

---

## 9. 与「派发任务」的对照

| 类比 | 派发任务 | 操作需求点 |
|------|---------|----------|
| 入口 API | `POST /api/tasks` | `POST /api/requirements` |
| CLI 封装 | `scripts/ao-dispatch.sh` | （暂无 CLI，agent 直接调 HTTP） |
| 上位设计 | `docs/usage/03-tasks.md` | 本章 + `docs/usage/14-requirement-management.md` |
| DB 模块 | `src/lib/db/tasks.ts` | `src/lib/db/requirements.ts` |
| 飞书关联 | `task.tags` 含 `R{row}` | `task.requirement_id` FK |

**🔴 CLI 缺口**：当前需求点操作**没有**专门的 CLI 封装（对照 `ao-dispatch.sh`）。agent 通常直接调 HTTP；如需 CLI 化（仿 `ao-dispatch.sh` 形态），可基于 `scripts/login.sh` + `ao_curl` 模板扩展，留作后续优化项。
