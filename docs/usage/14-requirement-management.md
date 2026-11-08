# 14. 需求点管理

> 🔴 **旧版入口**（damo 2026-10-12）：需求管理已由「列表」（任务容器）替代——需求 = 一个带 data schema 的列表。本入口数据保留可查，新用法 → [21-ideas.md](./21-ideas.md) §项目列表。

> 平台内建的需求点（**in_app source only**）——R60 推倒重建后的最小可用版本：单一数据源 + 6 态 status + 任务森林。

## 概述

需求点是平台的**一等概念**（v63+v64 落地），与 task 平行但有不同职责：

| 概念 | 角色 | 关系 |
|------|------|------|
| **需求点 (Requirement)** | "被管理的实体"——一次性需求 / 修复 / 范围变更的目标 | 一对多 |
| **任务 (Task)** | "需求点的一次执行" | 多对一 |

**关系**：一个需求点可以派多个 task（实现 v1、修复 v1、修复 v2...）。平台用 `tasks.requirement_id` FK 直接关联（**无中间表**）。

**数据源**：v63 推倒 v42 的 `feishu` / `platform` 双源镜像，新 spec 只保留 **`in_app`**。想看飞书 sheet？飞书 sheet 由 `task.tags` 的 `R{row}` tag 定位，独立维护，不与 platform 自动同步（详见 §飞书写回）。

---

## 入口

- 左侧导航栏 **📋 需求点管理** → `/requirements`（全局列表，R107 保留为「总入口」）
- 版本级入口：`/{projectId}/{versionId}/requirements` → **直渲染**（默认按 path 里的 `versionId` 过滤需求；不再 redirect）。`?clear=1` 清空 version 过滤看 project 全量，顶部条有「清空/恢复版本」+「重置」+「总入口」。
- 未发布版本入口：`/{projectId}/unversioned/requirements` → **直渲染** `version_id IS NULL` 的需求（跨版本演进/历史遗留）。

---

### R107 入口三态（项目下）

- **默认带版本**：`/{projectId}/{versionId}/requirements`（无 query）= 只显示 `version_id = path.versionId` 的需求。
- **清空版本**：`?clear=1` = 跳过 `version_id` 过滤，看该 project 全部需求。状态过滤 `?status=` 也可叠加。
- **重置**：顶部条「重置」按钮 = 跳到 `/.../requirements`（无 query），回到默认带版本的状态。
- **总入口**：顶部条「总入口」= 跳到全局 `/requirements`，不带任何项目绑定。
- 实现：渲染体抽到 `src/components/RequirementsListView.tsx`，三处入口共用同一渲染。`buildFilterHref` 在版本页内被本地版 `buildLocalHref` 替代（保留 path 上下文，R87 跟进）。

---

### R107 R 列第三轮：上下文携带（不丢项目）

从项目页面点 "+ 新建需求" / 空态"新建一个" / 详情页"← 需求点列表" 等跳转时，必须携带 `project_id` + `version_id` 上下文，否则会回到无项目状态。实现：

- `RequirementsListView` 接收 `projectContext?: { projectId, versionId | null }` prop。`buildNewRequirementHref(ctx)` 在有 context 时拼 `/requirements/new?project_id=X&version_id=Y`，无 context 时兜底 `/requirements/new`。
- `/requirements/new/page.tsx` 接受 `?project_id= + ?version_id=`，构造"← 需求点列表"回链 + 传给表单 `presetProjectId / presetVersionId / backHref`。
- `/requirements/[id]/page.tsx` 详情页接受 `?project_id= + ?version_id=`，回链优先用 query（兜底 `req` 自带）。新建表单提交后跳 `/requirements/${id}?project_id=X&version_id=Y`（`version_id="null"` sentinel 表示不挂版本）。
- 入口约定：项目页面带 `projectContext`；全局 `/requirements` 不带 → 保持原全局行为。

---

### R107 R 列第五轮：空态入口收敛到顶部按钮

damo 反馈"暂无需求点. 新建一个 这个入口**还**不对" = 空态的 inline "新建一个" 链接冗余（顶部"+ 新建需求"按钮已覆盖）。去掉 inline 链接，空态只保留文本"暂无需求点" + 提示语"点击右上角「+ 新建需求」添加"，让顶部按钮成为唯一新建入口。**R107 路径方案：damo 拍板 A（不改路径）**——R107 R 列第四轮的 `/requirements/{pid}/{vid}` 嵌套路径方案 B 不采纳（成本高 + 与现有 board/wiki 路由布局冲突）。

---

## 状态机（6 态）

```
[pending]  未开始
  ↓ 派 task
[done]     已完成（终态）

中间态（agent 主动标记，等派发人回复）：
[awaiting_reply]  等回复
[has_suggestion]  有建议
[blocked]         需拍板

内部终态：
[closed]          已关闭（软删，不可重派）
```

| status | 中文 | 含义 | 终态？ |
|--------|------|------|--------|
| `pending` | 未开始 | 默认新建态 | 否 |
| `done` | 已完成 | 任务全部 completed | ✅ |
| `awaiting_reply` | 等回复 | 等派发人回复后再继续 | 否 |
| `has_suggestion` | 有建议 | 有建议给派发人 | 否 |
| `blocked` | 需拍板 | 需要拍板才能继续 | 否 |
| `closed` | 已关闭 | 软删（DELETE 走 status='closed'，不物理删） | ✅ |

**对齐飞书 O 列四态**（`done` = 飞书 `1`，其他三个中间态一一对应）+ 一个内部终态 `closed`（飞书无）。

---

## 列表页

每条显示：

```
[状态徽章]   标题
              {项目徽章} · {版本徽章 v·name / 未挂版本} · #{tag} · P{priority} · 创建时间
```

支持 URL 参数过滤：

| 参数 | 示例 | 说明 |
|------|------|------|
| `project_id` | `?project_id=<uuid>` | 按项目过滤 |
| `version_id` | `?version_id=<uuid>` | 按版本过滤（`?version_id=null` = 只看未挂版本的需求点） |
| `status` | `?status=done,blocked` | 单值或逗号分隔多值 |
| `page` | `?page=2` | 分页（默认每页 20，max 100） |

**无"归档"视图**：软删（`status='closed'`）仍出现在列表中，前端按 status 徽章颜色区分。filter 加 `?status=closed` 即可只看已关闭。

**版本徽章**（R64）：绿底 = 已挂版本（`v·{name}`，点击跳过滤视图），黄底 = `未挂版本`（FK 漂移兜底）。

### 功能点：列表页 R74 量化 3 列（W3）

每条需求点的右侧三列量化数字，单 SQL 拿全（避免 N+1）：

| 列 | 含义 | 取数 |
|----|------|------|
| **关联 task 数** | 当前需求点关联的全部 task 数（含已完成的） | `COUNT(tasks WHERE requirement_id = ?)` |
| **完成进度** | `completed / total`，0% / 50% / 100% | `task.status IN ('completed','reviewing','done')` 视为完成段；失败/拒绝/取消不计入 |
| **最近反馈时间** | 最近一次 status/description 变更的 `created_at` | `MAX(requirement_revisions.created_at)` |

数据来源：`src/lib/db/requirements.ts` 的 `aggregateRequirementsMetrics(ids)`，列表页 `getServerSideProps` 一次调，避免每个 list item 单独查。

---

### 功能点：需求完成度量化（R196，v517）

每条需求有**完成度 %**（0-100）+ **评估依据** + **修正入口**，把"事情有没有跟踪、有没有结尾"量化成数字。三条供数通道：

| 通道 | 来源 | 说明 |
|------|------|------|
| **规则重算** | `POST /api/requirements/[id]/progress` | 按 task 聚合自动算：task 自报 progress 优先，无自报按状态折算（completed/reviewing=100%，进行中=30%）；聚合封顶 90% |
| **AI 自报** | task agent 每轮 `ao query PATCH /api/tasks/<task_id>` | agent 处理 task 时每个里程碑自报 task 完成度（见 `docs/claude-config/docs/task-progress-selfreport.md`，平台启动时自动注入必读） |
| **手动修正** | 详情页「✋ 修正」/ `PATCH /api/requirements/[id]` | 任何人/AI 可直接改，带 `progress_note` 依据 |

**口径**：**100% = status done 终态 = 部署上去并验证通过**（damo R196 拍板）。代码写完未部署 ≈ 80-90%；0-90% 由 task 聚合，剩下 10% 只能由 status=done 兑现。`progress_source` 三态：`rule`（规则算）/ `manual`（直接修正）/ `ai`（AI 评估预留）。

**二维散点视图**：列表页「完成度散点」切换 —— 横轴 = 紧急程度 P1-P5，纵轴 = 完成度 0-100%，每条需求一个点（未评估 = 空心点），**点开即进详情**（damo R196 追加："量化到二维坐标系，点开就能看"）。紧急程度复用 priority 1-5。

**task 级自报**：任务详情页显示 progress 条 + note，支持人工核实修正（`PATCH /api/tasks/[id]` 白名单含 `progress` / `progress_note`）。大需求拆多 task 时各 task 各自报，需求层聚合。

数据：migration v517（requirements + tasks 各 4 列：`progress` / `progress_source` / `progress_note` / `progress_updated_at`）；核心实现 `src/lib/db/requirements.ts` 的 `computeRuleProgress` / `applyRuleProgress`。

---

## 详情页

`/requirements/[id]`：

- 顶部：标题 + 状态徽章 + 优先级 P{1-5} + tags + 创建/更新时间
- 描述（可选，whitespace 保留）
- **状态进程条**（W3，6 态 stepper）：把 `pending → has_suggestion ↔ awaiting_reply ↔ blocked → done` 画成横向 stepper，当前态高亮；`closed` 走单独的「已关闭」分支。
- **最近反馈时间线**（W3）：从 `requirement_revisions` 表 + 关联 task 的事件拼出最近 10 条变更（status/priority/title/description/tags），底部「查看全部」链到 `/api/requirements/[id]/revisions`。
- **关联任务列表**（自动从 `tasks.requirement_id` 拉）—— 森林视图：
    - 每条 task 显示：标题、状态、`depends_on` 数量
    - 点击 → `/tasks/[id]` 详情
    - **root task 高亮**（W3）：森林中 `dispatched_by_task_id` 为空 + created_at 最早的 task 标 `root` 徽章（深色），其余标 `sub-task`（浅色）。UI 用于一眼识别派发入口。

> **W3 行为变更历史**：原 board-client 上的「同步并启动」按钮（调 `/api/feishu/sync`，R60 已删路由）已彻底移除——那是个静默 404 的 UX 死按钮，详见 `docs/plans/r78-requirement-loop.md` W0.9 段。

---

## 创建需求点

UI：`/requirements/new`

表单字段：

| 字段 | 必填 | 校验 |
|------|------|------|
| `project_id` | ✅ | 必须属当前 user |
| `title` | ✅ | 1-200 字符，trim 后非空 |
| `version_id` | ❌ | 必须属当前 project；不传 = 默认 `projects.current_version_id`；显式空字符串 = 不挂版本（详见下方 R64 说明） |
| `description` | ❌ | 多行文本 |
| `priority` | ❌ | 整数 1-5，越界 400 |
| `tags` | ❌ | 逗号分隔字符串，存为 JSON 数组 |

API：`POST /api/requirements`，新建 status 固定 `pending`。

**表单交互（R64 二轮）**：整表单是 client 组件（`src/app/requirements/new/new-requirement-form.tsx`），提交走 `POST /api/requirements`：

- **项目 → 版本级联**：改项目即刷新版本下拉（并清空已选版本，防止把 A 项目的版本提交到 B 项目），不再需要刷新页面。
- **项目下拉 = 左侧导航可见的项目**：与 `NavigationTree` 同源（`/api/projects?sort=manual` + `/api/user/me`，按 `owner_id === 当前用户` 过滤），顺序也是导航里的手动排序。
- **版本下拉三态**：留空 = 自动取项目当前版本；`(不挂版本)` = 显式不挂；选具体版本 = 指定（当前版本带 `· 当前` 标注）。

> **R64 版本字段语义**（damo 拍板）：
> - **不传 / undefined** → DB 层自动取 `projects.current_version_id`（需求点"本就挂在版本上"）
> - **传字符串** → 用入参；必须存在 + 属当前 project（否则 400 `VERSION_NOT_FOUND` / `VERSION_PROJECT_MISMATCH`）
> - **传 null** → 显式不挂版本（老数据兼容、跨版本迁移时临时态）
>
> 这套语义支持需求点**跨版本演进**：v1 没做完的需求可以 PATCH 到 v2 跟进迭代。

### 功能点：附件上传（R71）

- **是什么**：新建需求点时可同时挂多个附件；详情页可见附件列表 + 下载 + 删除。
- **怎么用**：
  - 新建表单下方有「附件」拖拽区（点击 / 拖拽 / 多选），单文件 ≤10MB，与 task attachment 复用同一套白名单（图片 / PDF / Office / OpenDocument / 文本 / 压缩包，详见 `docs/attachments.md`）。
  - 提交走**两步法**：先 `POST /api/requirements` 拿到 id，再逐文件 `POST /api/requirements/[id]/attachments`（任一文件失败不阻断创建，warn 跳过）。
  - 详情页附件区显示文件名（点跳 `/api/attachments/[id]` 下载）+ 大小 + 媒体类型 + 删除按钮。
- **API**：
  - `POST /api/requirements/[id]/attachments`（multipart `file` 字段，201 返回 `{attachment}`）
  - `GET  /api/requirements/[id]/attachments`（返回 `{attachments: [...]}`）
  - `DELETE /api/attachments/[id]`（通用端点，polymorphic — 不区分 task / requirement）
- **数据模型**：v69 migration 把 `attachments` 改成 polymorphic —— `task_id` / `requirement_id` 二选一（DB CHECK XOR）。旧 task attachment 不动；新 requirement attachment 走 `uploads/{owner}/requirements/{requirement_id}/`，不建 cwd symlink（需求点没 agent cwd）。
- **与 task attachment 的差别**：requirement attachment 没有 agent cwd symlink —— 详情页只展示 + 下载，agent 在 task 里 `Read` 不到（除非显式把路径拼进 task prompt）。这是有意为之：需求点是面向人的协作单元，不是给 agent 消费的输入。

---

## 改需求点

`PATCH /api/requirements/[id]`，**白名单字段**（其他字段返回 400 + `code: FIELDS_NOT_ALLOWED`）：

```
title / description / status / priority / tags / version_id
```

不可改：`id` / `project_id` / `source` / `created_at` / `updated_at`（防越权写）。

| 字段 | 校验 |
|------|------|
| `status` | 必须 ∈ `REQUIREMENT_STATUSES`（6 态）；非法值（如 `"BOGUS"` / `"Done"` 大小写错 / 空串）→ 400 `STATUS_INVALID` |
| `priority` | 整数 1-5，越界返回 400 |
| `tags` | `string[]`（元素非空），传 `null` 清空 |
| `version_id` | 字符串 = 必须存在 + 属当前 requirement 的 project；`null` = 显式置空；不存在 / 跨 project 静默忽略（DB trigger 兜底） |

**应用层显式拒 vs DB 层静默 ignore**：
- **POST 新建**：priority 越界 / tags 不合法 → 400（不能静默吞，让前端立刻修）
- **PATCH 改**：priority 越界 → 400；**白名单外字段** → 400（防止前端多塞 `id`/`source` 污染 DB）
- **DB 层 `updateRequirement()`**：白名单外字段 / `version_id` 跨 project 静默忽略（双保险）

### 功能点：status→done 守卫（R78 W1 §4.3 invariant，damo 痛点核心）

> **关键不变量**：requirement `status='done'` 必须在当前 requirement 下有 **至少 1 个** `type ∈ {dev, test, deploy}` **且** `status='completed'` 的关联 task，否则 PATCH 返回 **400 + `code: REQUIREMENT_DONE_GUARD`**。

实现层（`src/lib/db/requirements.ts` 的 `hasCompletedImplementationTask(requirementId, ownerId)`）：

```sql
SELECT 1 FROM tasks
 WHERE requirement_id = ?
   AND owner_id = ?
   AND type IN ('dev', 'test', 'deploy')
   AND status = 'completed'
 LIMIT 1
```

设计/调研 task（`type='design'` / `type=NULL`）即使进 `reviewing` 或 `completed` 也**不算实现**，不能把 requirement 标 `done`。这就是 R78 W0 锁死的核心契约 —— 设计态不自动翻 `done`，避免调研/建议被误标为已完成。

UI 联动（W1 §4.3 (c)）：详情页状态徽章的 dropdown 中，「已完成」项在没有 impl task 时 `disabled` + tooltip 提示「需先完成至少一个 dev/test/deploy task」。前端通过 `GET /api/requirements/[id]` 返回的 `eligible_for_done: boolean` 字段判定（一次 GET 拿全，省一次 round-trip）。

### 功能点：PATCH 短路与幂等（R78 W1 §4.4）

| 入参 | 行为 |
|------|------|
| `{status: <current.status>}`（纯 status 字段） | **200 + 不写 DB**（短路返当前行，revision 行数不变）—— 重复 polling / UI 防抖不会反复写 revision |
| `{status: <current.status>, title: '新'}`（多字段） | 走 `updateRequirement` 把 `title` 一并落库，**不会**静默丢其他字段（W1 Bug 1 修复：旧实现会因短路丢字段，commit `68a471c` 已堵） |
| `{status: <current.status>, description: null}` | 显式置空 description = 走 DB 层（`null` ≠ 不写） |

### 功能点：跨 owner = 404（R78 全周期）

所有读 / 改 / 删路径沿用 v14-v19 多租户硬约束：`owner_id` 不匹配 → **404**（`{ error: "Requirement not found" }`），**不**泄露存在性。这条覆盖：

- `GET    /api/requirements/[id]` 跨 owner → 404
- `PATCH  /api/requirements/[id]` 跨 owner → 404
- `DELETE /api/requirements/[id]` 跨 owner → 404
- `GET    /api/requirements/[id]/revisions` 跨 owner → 404
- `GET    /api/requirements/[id]/tasks` 跨 owner → 404
- `GET    /api/requirements/[id]/attachments` 跨 owner → 404
- `POST   /api/tasks` 带别人家的 `requirement_id` → 400 `REQUIREMENT_NOT_FOUND`

回归测试覆盖：`src/app/api/requirements/[id]/route.test.ts` + `tasks/route.test.ts` + `[id]/tasks/route.test.ts` + `[id]/revisions/route.test.ts`（W4 新增）。

---

## 删需求点

`DELETE /api/requirements/[id]` = 软删（`status='closed'`，不物理删）。

```
→ { "id": "<uuid>", "status": "closed" }
```

**关联 task 不级联**：FK `ON DELETE SET NULL` 只对物理删生效，软删不会解绑。task 仍属这个需求点。

---

## 一键创建关联 task（R78 W1 §4.2）

需求点详情页有「**+ 新建任务**」按钮，弹出对话框：

| 表单字段 | 必填 | 校验 / 说明 |
|----------|------|-------------|
| `title` | ✅ | 任务标题 |
| `prompt` | ✅ | 传给 Agent 的指令 |
| `type` | ❌ | `design` / `dev` / `test` / `deploy` / 不选（默认未分类）。**关键**：R78 W1 §4.3 invariant —— 只有 `dev/test/deploy` 类型的 task 完成后才能把 requirement 标 `done`，所以创建 root task 时建议明确 type |
| **启动时机** | ❌ | toggle 二选一：**「立即启动」**（默认；走 `POST /api/tasks` + 自动 `start`） / **「只创建待启动」**（仅 `POST /api/tasks`，详情页显示「未启动」徽章，自己掌控节奏） |

行为细节：

- 创建 task 必传 `requirement_id` + `project_id` + `version_id`（自动从当前 requirement 继承）
- `autoApprove=true`（R74 默认配置）的 quick-mode 风格 —— 创建即启动路径
- 校验沿用 `src/lib/db/tasks.ts` 的 `REQUIREMENT_CLOSED` 防御（closed requirement 拒收）
- `dispatched_by_task_id` 默认 `null`（requirement 不是 task，无上游 task 可挂；R107 派发血缘从父 task → 子 task 时才用）

API 等价：

```bash
# 立即启动
curl -X POST http://localhost/api/tasks -d '{
  "project_id": "...", "title": "...", "prompt": "...",
  "requirement_id": "<uuid>", "type": "dev", "autoApprove": true
}'
# → {task} + 自动 startTask() 入队

# 留待启动
curl -X POST http://localhost/api/tasks -d '{ ... 同上 ... }'
# → {task} (status=pending)，不调 startTask；详情页「未启动」徽章
```

进阶入口：`POST /api/requirements/[id]/auto-dispatch`（W1 §4.5）—— 给 W2 cron 留的接缝，行为 = 创建 root task（默认 type='dev'）+ 可选自动 start。CLI / 定时任务可调它做「需求点改动触发自动派发」（R74 Q2 范围）。当前实现已落地，未挂 cron。

---

## 关联任务（森林 API）

一个需求点可派多个 task。task 通过 `requirement_id` FK 关联。

**前端取数**：

| 入口 | 数据来源 |
|------|---------|
| 详情页 `/requirements/[id]` | 走 `getRequirementTasks(id)` 内联渲染 |
| 程序化 | `GET /api/requirements/[id]/tasks?with_deps=true` |

**森林 API 返回**（`with_deps=true`）：

```json
{
  "requirement_id": "<uuid>",
  "tasks": [
    { "id": "t1", "title": "...", "status": "completed", "depends_on": [] },
    { "id": "t2", "title": "...", "status": "running", "depends_on": ["t1"] }
  ],
  "edges": [
    { "from": "t2", "to": "t1" }
  ]
}
```

- `depends_on` 是 **1 层直接依赖**（从 `tasks.depends_on` JSON 字段读，不递归闭包）
- 客户端按需递归拉各 task 详情
- `with_deps` 缺省 = `false`，只返 tasks（省 edges）

---

## 任务侧关联

创建 task 时可带 `requirement_id`：

```
POST /api/tasks
{
  "project_id": "...",
  "title": "...",
  "requirement_id": "<uuid>"   // 可选
}
```

校验：

- 需求点必须属当前 user
- 需求点 status ≠ `closed`（closed 拒收，返回 `REQUIREMENT_CLOSED`）
- 不存在 / 跨 owner → `REQUIREMENT_NOT_FOUND`

**PATCH task 也支持改 `requirement_id`**（`null` = 解绑）。

### 任务列表 / 看板 chip（R94）

当关联 task 处于 `reviewing` 且本需求点 status ∈ `{awaiting_reply, has_suggestion, blocked}` 时，任务侧会渲染 chip 反映本需求点的状态，让 reviewer 一眼能识别「上游在哪等」：

- **触发**：`task.status === "reviewing"` && `requirement.status ∈ {awaiting_reply, has_suggestion, blocked}`
- **入口**：Chat 左侧任务列表、`/[projectId]/[versionId]` 看板 cards / kanban、`/global` 全局看板 cards
- **配色**：`awaiting_reply` → cyan「等回复」 / `has_suggestion` → emerald「有建议」 / `blocked` → amber「需拍板」

实际渲染 / SQL / 测试细节见 [03-任务 § 任务列表 / 看板卡片 chip](./03-tasks.md#任务列表--看板卡片-chipr94)。

---

## 飞书写回（独立体系）

需求点 ↔ 飞书 sheet **不再自动同步**。两套体系：

| 体系 | 用途 |
|------|------|
| **platform `requirements` 表** | in_app 数据源，本平台 UI 操作 |
| **飞书 sheet** | 跨团队展示 / damo 手动管理 |

**关联靠 `task.tags` 的 `R{row}` tag**：

- 飞书派 task → tag 自动带 `R{row}` → task 完成时平台把状态写回飞书 T/W/Z 列
- platform 手动建需求 → **不写飞书**（除非手动补 tag）

**写回时机**（`src/lib/feishu/write-back.ts`）：

| 飞书列 | 内容 | 何时写 |
|--------|------|--------|
| S | `task.id` | task 完成时 |
| T | `task.status` | task 完成时 |
| W | `task.head_commit` | task 完成时 |
| Z | `task.status`（冗余） | task 完成时 |

平台不再写飞书 `requirement.status`（v42 的 `requirement_iterations` 中转表已删）。

---

## API 速查

```
POST   /api/requirements                    新建 (status 默认 pending)
GET    /api/requirements                    列表 (project_id/status/page/page_size/source='in_app')
GET    /api/requirements/[id]               详情 + 关联 task 列表 + eligible_for_done
PATCH  /api/requirements/[id]               白名单改 (title/description/status/priority/tags/version_id/progress/progress_note)
DELETE /api/requirements/[id]               软删 (status='closed')
POST   /api/requirements/[id]/progress      规则重算完成度 (R196, source='rule')
GET    /api/requirements/[id]/tasks         森林 API (with_deps=true 返 edges, 跨 owner → 404)
GET    /api/requirements/[id]/revisions     单条字段级变更时间线 (?limit=1-500)
GET    /api/requirements/revisions          全局增量 (?since/until/actor_type/requirement_id/cursor)
GET    /api/requirements/[id]/attachments   附件列表
POST   /api/requirements/[id]/attachments   上传附件 (multipart file)
POST   /api/requirements/[id]/auto-dispatch 创建 root task (可选自动 start), W2 cron 接缝
```

**tasks 侧**：

```
POST   /api/tasks                           可带 requirement_id + type (design/dev/test/deploy); closed → 400 REQUIREMENT_CLOSED
PATCH  /api/tasks/[id]                      ALLOWED_FIELDS 含 requirement_id (null=解绑) + progress/progress_note (R196 自报)
```

**重要：跨 owner 一律 404**（不泄露存在性），全周期覆盖各端点。R78 W4 新增测试见 `src/app/api/requirements/[id]/{route.test,tasks/route.test,revisions/route.test}.ts` + `src/app/api/tasks/route.test.ts`。

---

## 常见问题

**Q: 飞书 sheet 改了会同步到 platform 吗？**
A: **不会**。R60 推倒了 v42 的弱/强同步链路，飞书 sheet 与 platform 解耦。两套独立展示，靠 task 的 `R{row}` tag 单向关联。

**Q: 飞书 sheet 想看 platform 的需求进度？**
A: 看飞书 sheet 的 T/W/Z 列 —— 平台 task 完成时自动写回（rule engine 触发）。

**Q: platform 改了 status，飞书会同步吗？**
A: **不会**。飞书 T/W/Z 只承接 task.status，platform requirements.status 不外传。

**Q: 删了需求点（closed），关联 task 还在吗？**
A: 在。软删只改 `requirements.status`，FK `ON DELETE SET NULL` 只对物理删生效。

**Q: 怎么实现"派一个新迭代"？**
A: 走 `POST /api/tasks` 带 `requirement_id` —— 平台没有 v42 的"iterate"按钮，新 spec 把 task 创建统一到一个入口。

**Q: tags 怎么传？**
A: `string[]`，逗号分隔字符串（前端表单）/ JSON 数组（API）。DB 存为 JSON 字符串，读用 `parseRequirementTags()`。

**Q: priority 是干嘛的？**
A: 1-5 整数，P1 = 最高。纯展示 + 排序参考，**不**影响调度。

---

## 实现原理（开发者参考）

- 表：`requirements`（v64）+ `tasks.requirement_id` FK（v64，索引 `(project_id,status)` / `(owner_id)` / `(requirement_id,status)`）
- DB 模块：`src/lib/db/requirements.ts`
  - `createRequirement` / `getRequirementById` / `listRequirements` / `updateRequirement` / `softDeleteRequirement`
  - `getRequirementTasks(id, withDeps=false)` —— 森林 API
  - `parseRequirementTags` / `serializeRequirementTags` helpers
- API 路由：`src/app/api/requirements/` 6 个
- 前端 page：`src/app/requirements/{page,new,[id]/page}.tsx` + 3 个版本级重定向
- 写回框架：`src/lib/feishu/write-back.ts`（T/W/Z 列）
- 测试：`src/lib/db/requirements.test.ts`（35 cases）
