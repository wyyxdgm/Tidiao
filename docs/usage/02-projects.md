# 2. 项目与版本

> 任务的归属层次：项目 -> 版本 -> 任务，类比 Git 仓库 -> 分支 -> 工单。

## 概述

项目（Project）是任务的必填归属，每个项目绑定一个工作目录（cwd），Agent 在此目录下执行操作。版本（Version）是项目下的可选分组，可绑定飞书 sheet，用于按迭代或功能线组织任务。本章节覆盖项目创建、版本管理、看板视图和导航操作。

### 功能点：创建项目

- **是什么**：创建一个独立的项目，作为任务的容器和工作目录的绑定对象
- **怎么用**：
  1. 在首页（`/`）点击「新建项目」
  2. 填写项目名称（必填）和描述（可选）
  3. 填写工作目录 cwd（可选，留空则自动隔离）
  4. 提交后项目出现在首页列表
- **注意**：
  - 名称是唯一必填字段
  - 创建后项目无 `current_version_id`，需创建版本后自动设为当前版本
  - 项目按 `owner_id` 隔离，每个用户只看到自己的项目；**admin 例外**：列表和详情都能看到全部项目（board 2026-08-19「operator sees every project」）
  - 项目列表支持按创建时间或最近活跃排序

### 功能点：admin 跨 owner 读项目（写不放行）

- **是什么**：项目默认严格按 `owner_id` 隔离，但 **admin 账号能读所有人的项目**——列表里能看到、点进去也能打开，不会 404。
- **怎么用**：用 admin 账号登录即可，无需额外开关。普通用户行为不变：读别人的项目仍返 404（不暴露存在性）。
- **注意**：
  - 🔴 **只有读放行**。admin 改别人的项目（PATCH）/ 删别人的项目（DELETE）**仍返 404**，防止误改误删。要放开写权限需单独评估。
  - 同样口径也适用于定时任务（`docs/usage/05-scheduling.md` §admin 跨 owner 管定时任务）与 `GET /api/tasks/who-touched`。
- **实现原理（开发者参考）**：
  - 列表放行：`src/app/api/projects/route.ts:30` — `listProjects(role === "admin" ? undefined : userId, sort)`，传 `undefined` 跳过 owner 过滤。
  - 详情放行：`src/app/api/projects/[id]/route.ts` GET — `getProjectById(id, role === "admin" ? undefined : userId)`。两处必须同步，否则出现「列表看得见、点进去 404」（2026-09-29 修复的真实 bug）。
  - 回归测试：`src/app/api/projects/[id]/admin-bypass.test.ts`（6 条：admin 读 200 / 普通用户读 404 / owner 读 200 / admin 读不存在 404 / admin PATCH 404 / admin DELETE 404）。

### 功能点：项目工作目录（cwd）

- **是什么**：Agent 执行任务时的文件系统根目录，Agent 的 Read/Write/Bash 等工具均在此目录下操作
- **怎么用**：
  - 创建项目时填写 cwd（如 `/home/user/workspace/my-project`）
  - Agent 启动后以该目录为工作根，可读写文件、执行 git 命令等
  - 若项目 cwd 指向一个 Git 仓库，Agent 可直接操作该仓库
- **注意**：
  - cwd 留空时，系统使用 fallback 链自动隔离：`task.cwd > $ORCHESTRATOR_HOME/projects/{projectId}/{taskId} > $ORCHESTRATOR_HOME/workspace/{taskId}`
  - **同一 cwd 的任务互斥执行**：调度器确保同一工作目录下同时只有一个任务在运行，防止多个 Agent 冲突修改文件（可按项目放宽，见下）
  - 不同 cwd 的任务可并行运行
  - 项目 cwd 可在项目根目录放置 `INDEX.md` 作为 Wiki 入口，访问 `/{projectId}/wiki` 查看（详见 [09-Wiki](./09-wiki.md)）
  - 0 数据库字段：Wiki 复用 cwd，无需额外 migration

### 功能点：同目录并发上限（v38）

- **是什么**：放宽上面那条 cwd 互斥 —— 让本项目共享同一个工作目录的任务同时跑多个（`projects.parallel_limit`，默认 1 = 串行，上限 10）
- **怎么用**：
  - 项目列表 → 鼠标悬停项目 → **高级选项** → 「同目录并发上限」填 N → 保存
  - 或 API：`PATCH /api/projects/{id}` body `{"parallel_limit": 3}`
  - 设置生效后项目列表会显示 `⚡ 同目录并发 N` 标记
- **适用场景**：以只读为主、基本不写工作目录的项目 —— 定时巡检、代码研究、问答类
- **注意**：
  - 🔴 **会写文件或 `git commit` 的项目不要调高**：同一棵树里两个 Agent 同时跑会撞 `git index.lock`，同名文件的读-改-写也会互相覆盖（后写的抹掉先写的）
  - **实际并行度 = min(全局并发, 本项目 parallel_limit, 账号 max_concurrency)**，三层闸门取小，只调一层可能看不到变化
  - 全局并发缺省 2，在设置页或 `PATCH /api/config` 调整（v39 起落库，pm2 重启仍生效）
  - 存量项目为 NULL，等同 1，行为与上线前一致

### 功能点：任务超时（v40）

- **是什么**：本项目任务的 wall-clock 超时上限（`projects.timeout_minutes`，1-1440 分钟）。**留空 = 继承全局默认**（设置页「任务超时」，缺省 30 分钟）
- **怎么用**：
  - 项目列表 → 鼠标悬停项目 → **高级选项** → 「任务超时（分钟）」填 N → 保存（清空后保存 = 恢复继承）
  - 或 API：`PATCH /api/projects/{id}` body `{"timeout_minutes": 180}`（`null` = 继承全局）
  - 设置生效后项目列表会显示 `⏱ 超时 Nmin` 标记
- **适用场景**：跑长活的项目（大规模迁移、批量巡检）调长；跑短活、想快点暴露卡死的项目调短
- **注意**：
  - 到点后走「暂停」而不是取消：打断当前一轮但**保留上下文**，可恢复续跑
  - 🔴 **调长的代价**：`paused` 是非终态，定时任务的防重派闸门按「非终态算在飞」→ 一个超时挂着的任务会挡住同一个 schedule 的后续触发，调长等于把这段窗口一起调长
  - 改动**对已在跑的任务不生效**（下一次启动/恢复才吃到新值）
  - 存量项目为 NULL，等同继承全局 30 分钟，行为与上线前一致

### 功能点：版本管理

- **是什么**：项目下的可选分组层，用于按迭代/功能线组织任务，每个版本可绑定飞书 sheet
- **怎么用**：
  1. 在项目页面创建版本（填写版本名称，可选填飞书 sheet URL 和 sheet 名）
  2. 首个版本创建后自动设为项目的 `current_version`（类似 `git HEAD`）
  3. 在项目列表页展开项目卡片，非当前版本的版本行有「设为当前」按钮，点击切换 current version
  4. 版本绑定的飞书 sheet 用于双向同步：飞书行导入为任务，任务状态回写飞书
- **注意**：
  - 版本是可选的：任务可不关联版本（`version_id=NULL`），显示为项目级「其他任务」
  - 每个版本独立的 feishu_url + feishu_sheet + cwd，多个版本互不干扰
  - 切换 current version 不影响已有任务，只影响 `/[projectId]` 的默认跳转目标
  - 版本 URL 使用 UUID 而非 name slug，避免编码转换问题

### 功能点：新建版本 AI 解析输入（v513）

- **是什么**：「+ 新建版本」表单顶部有一个 AI 解析输入框——粘贴一段自由文本（飞书 sheet URL / sheet 名或 id / 版本用途描述），点「AI 解析填表」后自动填好版本名、描述、飞书 URL 和 sheet，手动调整后保存
- **怎么用**：
  1. 展开某项目的「+ 新建版本」表单，在最上方输入框粘贴信息（例如：`表在 https://xxx.feishu.cn/wiki/abc?sheet=885c32，用于追踪 GDM 需求`）
  2. 点「AI 解析填表」→ 建议值自动填入下方表单，来源标注显示在勾选框旁（哪些是 AI 生成 / URL 来自文本 / sheet id 已转 name）
  3. 手动微调后点「创建」保存
- **注意**：
  - sheet 名与 id 兼容：填 sheet id（URL `?sheet=` 参数里的短码）会自动查该表的子表列表转成 sheet name 落库；落库值永远是 name
  - AI 不可用（项目没配 LLM）时降级为纯确定性解析（URL 抽取 + sheet id→name 映射），其余字段留空手动填
  - 「版本干啥的」是版本的一等字段（description），版本列表小字展示，编辑表单可随时改
  - 后端入口：`POST /api/versions/ai-parse`（不落库，只返回建议值）；落库仍走 `POST /api/versions`（新增 `description` 字段，PATCH 同步支持）
  - 表单本体在共用组件 `spa/src/components/NewVersionForm.vue`，项目列表页和项目详情页两处接入（R172 迭代：详情页原 stub toast 换真表单）
  - 项目详情页右上「+ 版本」点击即在页头下方内联展开表单；「新建任务」与「+ 版本」按钮间距已拉开

### 功能点：看板视图

- **是什么**：以状态列为维度的任务看板，支持拖拽改变任务状态
- **怎么用**：
  1. 访问 `/{projectId}/{versionId}` 进入版本看板
  2. 看板按任务状态分列：待执行、排队中、运行中、已暂停、待审核、驳回、结束
  3. 拖拽任务卡片到另一列即改变状态
  4. 每列顶部显示任务计数
- **注意**：
  - 拖拽状态转换受 `VALID_STATUS_TRANSITIONS` 约束，非法转换会被拒绝
  - 列的显示和顺序可通过 `useBoardConfig` 持久化到 localStorage
  - 看板数据服务端加载，按 `project_id` + `version_id` + `owner_id` 过滤
  - 拖拽触发的 API 动作：start / pause / cancel / approve / reject / resume / restart

### 功能点：SPA 看板拖拽模式（R48）

- **是什么**：SPA 版本（`/{projectId}/{versionId}` 与 `/global`）新增「看板」视图模式（与既有的「卡片」模式并列）。HTML5 原生拖拽改 status，**仅跨列改 status，不重排**。
- **怎么用**：
  1. 进入版本看板或全局看板，顶部右侧点「看板」按钮（与既有的「活跃 / 历史」切换器并排）。
  2. 11 个 status 各占一列横向排列，每列顶部显示任务数；卡片显示状态、标题、归属项目/版本、模型、更新时间等。
  3. 拖一张卡到另一列即改 status；非法 transition 弹 toast 拒绝（不调 API）；失败 toast 报错。
  4. 拖完自动 reload 当前视图拿到新 status / updated_at，无需手动刷新。
  5. URL 持久化：`?mode=kanban` 进入即回到看板模式。
- **实现细节**：
  - 组件：`spa/src/views/kanban/KanbanBoard.vue`（含 CSS 色板），无外部拖拽库（HTML5 原生 API）。
  - 跨列动作映射复刻 master `src/lib/constants.ts getStatusDragAction`（11 状态对 1 张表）。
  - 后端仍走 `POST /api/tasks/[id]/{action}` 改 status，与卡片视图既有的 lifecycle 操作同口径（不引 PATCH `/api/tasks/[id]` 改 status 路径）。
  - 不引 dnd-kit / SortableJS；不做乐观本地 state，依赖服务器响应后父组件 reload。
  - **同列内手动排序**（v510，R51/B107 移植）：仅 running / queued 列可拖动重排（`REORDERABLE_STATUSES`），drop 时把目标列可见 task 全部写连续 `queued_order`（10/20/30…）→ `POST /api/tasks/queue-order`，调度器按它派发。列内显示顺序由 `spa/src/views/kanban/sort-tasks.ts` 的 `sortTasksForKanban` 决定：🆕 **2026-11-05（damo）改「默认时间倒序，定制的除外」**——`queued_order` ASC 只在 running / queued 两列生效（定制排序仅存在于这两列），其余列一律纯 `updated_at DESC` 忽略 `queued_order`。此前全列 queued_order 优先，但该值是终身残留（每次入队都写 MAX+1，仅 dequeue 清空），任务转 completed/failed 后被几周前的拖拽残留劫持列序（实证 completed 顶部是 10-31 老任务、11-04 新任务沉底）。⚠️ 2026-10-26 修复：SPA 移植时漏了列内排序这步 → 拖拽写库成功 + toast「已排序」但 reload 后列序不变；修复后拖完 reload 即见新顺序。单测 `sort-tasks.test.ts`（8 例）。
- **覆盖范围**：
  - `/{projectId}/{versionId}` 版本看板（R25）— BoardPage 接 kanban mode。
  - `/{projectId}/unversioned` 未挂版本任务（R29）— 同 BoardPage。
  - `/global` 全局看板（R5）— GlobalBoard 接第 4 个模式（卡片 / 列表 / 分组 / 看板）。
- **不在 MVP 范围**（后续 R+ task）：
  - 列头排序 / 展开更多 / 移动端 tab 视图（master 有）。
  - ChatView 模式（G6 R 范畴拆后续 R49）。

### 功能点：聊天模式上方信息栏折叠 / 展开（R126；R217v7 收敛为 vd 单一入口）

- **是什么**：版本页（`/{projectId}/{versionId}?mode=chat`）顶部 chrome（GDM / v1.0 大标题 + cwd + 状态/模型/标签/搜索过滤排）默认**收起**，只留面包屑一行；点右上「收起 / 展开」toggle 切换，腾出聊天空间。
- **怎么用**：
  1. 进入 `/{projectId}/{versionId}?mode=chat` → chrome 默认收起（面包屑行尾有「⌄ 展开」小条）。
  2. 点「展开」→ 大标题 + 过滤排出现，同时 view-switcher（看板/卡片/列表/聊天）在 header 右侧。
  3. 再点「收起」→ 折回面包屑。
  4. 偏好持久化 localStorage `version-chrome-open-v1`（1=展开 / 0=收起，默认收起）。
- **注意**：
  - **R217v7（damo「收起按钮现在就收起自己，这个空行不需要了」）**：BoardPage 自己的 `board-header` 行（只装一个只收自己的 chrome-toggle）+ FAB + `chat-top-header-open-v1` 状态机**整体删除**。版本页 chrome 折叠只剩 vd 一份入口（`version-chrome-open-v1`），全局看板的同名 key 各管各不受影响。
  - SPA 实现：`spa/src/views/VersionDetailView.vue`（`CHROME_OPEN_KEY` + `vd-chrome-toggle` + 折叠态 `vd-chrome-fab` 面包屑末尾兜底）+ `spa/src/views/BoardPage.vue`（`board-filter` 随 `chromeCollapsed` 折叠）。

### 功能点：未版本化任务

- **是什么**：不关联任何版本的任务，显示在项目级「其他任务」分组中
- **怎么用**：
  - 创建任务时不选择版本，或选择「其他任务（无版本）」
  - 访问 `/{projectId}/unversioned` 查看该项目的未版本化任务
  - 查询 API：`GET /api/tasks?project=<project-id>&unversioned=true`
  - **cwd 行**：header 标题行下方显示项目 `cwd`（mono/muted 样式，镜像版本页 `vd-cwd`；项目无 cwd 时不渲染）。SPA 端 `ProjectUnversioned.vue`。
  - **header 单行标题（2026-10-20 damo）**：原「项目名 · 未挂版本任务 + 副标题」收敛成一行「**项目名 · 其他任务**」（tab 标题同步，与建任务页「其他任务（无版本）」同叫法）。
- **R51 SPA header 入口（R51.2-R51.5，2026-10-31 已被 chrome 对齐改版取代）**：原一排按钮（💬聊天视图 / + 新建任务表单跳转 / 📖 Wiki / 📋 需求点 / 🎬 控制台 / ← 返回项目）—— 见下条。
- **chrome 对齐版本页（2026-10-31 damo「其他任务下的按钮筛选逻辑直接参考具体版本」）**：header 整体换成版本页 `VersionDetailView` `.vd-chrome` 同款结构（`puv-` 前缀本地副本，仓库 convention = 每页自持 chrome 视觉互相镜像，同 GlobalBoard `gb-` 前缀）：
  - **面包屑行**：`项目上下文` + `项目 › 其他任务` + `(id…)` 短 ID 复制按钮 + 折叠态面包屑末尾「展开」FAB。返回项目 = 点面包屑「项目」段（跳 `/{projectId}` 项目详情，承接原「← 返回项目」）。
  - **五档视图切换器**（看板/卡片/列表/分类/聊天）+ **收起/展开 toggle**：URL `?mode=` 口径与版本页完全一致（viewport 缺省 H5=cards / 桌面=kanban，切到缺省删 param）。此前本页只有「💬聊天视图/📋卡片视图」二元切换，且 BoardPage 自带切换器已随 R217v7 删除——list/kanban/category 在本页切不到，与版本页能力不一致；现五档齐全。
  - **入口按钮组**：圆形「+」（TaskQuickCreate 对话式弹窗，预选当前项目，版本下拉可切「不挂版本」）+ 📖 Wiki（项目级 `/{projectId}/wiki`）+ 🗂 列表（全局看板分类视图按项目过滤 `/global?mode=category&project=`，版本页同款）+ 📋 需求点(旧)（`/{projectId}/unversioned/requirements`，锁死 version_id=null）。原「🎬 控制台」入口随对齐撤除（版本页无此入口）。
  - **chrome 折叠**：`chromeOpen` 与版本页**共用** localStorage key `version-chrome-open-v1`（两页折叠状态同步）；折叠透传 BoardPage `:chrome-collapsed` 隐藏 filter bar。
  - SPA 实现：`spa/src/views/ProjectUnversioned.vue`。
- **Board 行为（嵌入 R14 BoardPage，R51.6-R51.10 收口）**：
  - **删除任务**：每张卡片右上角 hover 浮现 🗑 按钮 → 点击弹 `ConfirmDialog`（type=danger）二次确认 → 确认走 `DELETE /api/tasks/{id}` → 本地乐观 patch `deleted_at`。
  - **URL ?taskId**：挂载时读 `route.query.taskId`，非空即 `router.replace(/tasks/{id})`（chat 模式分支留 R52）。
  - **状态 chip 拖拽重排**：顶部 status chip 行 HTML5 原生 drag/drop，drop 时 splice 重排，持久化到 `localStorage[ao-board-column-order-{scope}]`。`dragging` 用 opacity 0.5、`dragover` 用 amber ring。
  - **同步配置齿轮**：chip 行末尾齿轮按钮 → 下拉 3 radio（不同步/弱同步/强同步）→ 写入 `localStorage[ao-board-sync-level]`，影响 `chipOrderKey` 解析（account → 全平台共享 key、project → 同项目跨版本共享、scope → 当前 scope 单 key）。click-outside 自动关菜单。
  - **DecisionBanner**：卡片内嵌 awaiting_markers 中 type=decision 走 DecisionBanner，点击 → `POST /api/tasks/{id}/resolve-decision` body `{decision_id, selected_label}` → 本地 patch markers 标 resolved。失败 toast.error，pending 防重复点击。
  - **60s 时间刷新**：`useTick(60_000)` 强制每分钟重渲，卡片 `formatUpdatedAt(updated_at, tick)` 自动取新值。
  - **Kanban 同列内排序**：KanbanBoard 同列拖拽时计算 `dragOverIdx`（clientY 与卡片中线比）→ splice 重排 → `POST /api/tasks/queue-order` body `{orders: [{id, order: 10/20/30…}]}`。box-shadow 蓝色 2px 高亮显示插入位置。
  - **状态面板排序与隐藏（R56-A0）**：版本页 chip 行拖拽重排 + 隐藏 = 看板列同步跟随，与 master `board-client.tsx` + `kanban-view.tsx` 1:1 对齐。
    1. **chip 行拖动排序**：顶部 status chip 用 `chipOrder` 渲染（持久化到 `localStorage[ao-board-column-order-{scope}]`，scope 由同步齿轮决定），HTML5 原生 drag/drop 改顺序后即写。chip 是否「选中」(`selectedStatuses`) 与「位置」(`chipOrder`) 互不影响 —— 取消勾选某 chip 后**位置仍保留**，再勾选直接恢复原位，不被丢。
    2. **看板列跟随**：切到 `?mode=kanban` 后，列顺序 = `chipOrder`（用户拖出的顺序），隐藏的 status 对应的列**完全不渲染**（与 master `kanban-view.tsx:196-206` 的 `columnOrder.filter(selectedStatuses.has)` 同口径），不会出现「隐藏后还显示空列 (暂无)」的情况。
    3. **global board 暂未启用 chip 拖拽**：R51.2 仅覆盖版本页 BoardPage；`/global` GlobalBoard 走同一 `KanbanBoard.vue` 但**不传** `columnOrder` / `selectedStatuses`，列顺序回退到 `ALL_TASK_STATUSES` 默认顺序、全 11 列都展示（保留 R51.2 之前的旧行为，不破坏）。
  - **实现**：`spa/src/views/kanban/KanbanBoard.vue`（新增可选 prop `columnOrder?: TaskStatus[]` + `selectedStatuses?: Set<TaskStatus>`）+ `BoardPage.vue` 传 chipOrder/selectedStatuses。

### 功能点：全局看板状态面板排序与同步齿轮（R56-A1）

- **是什么**：`/global` 全局看板顶部 status chip 行加上与版本页同款的「拖拽重排 + 同步齿轮」体验。拖完 chip 顺序立即写到 localStorage；切到 `?mode=kanban` 时列顺序与版本页一致地跟随；齿轮可在「不同步 / 弱同步 / 强同步」间切换。命名空间与 BoardPage 完全分开（`ao-global-*` vs `ao-board-*`），互不污染。
- **怎么用**：
  1. 进入 `/global`（任意视图模式），顶部「状态」chip 行可拖拽重排；拖动时 opacity 0.5，目标位 amber ring 高亮，drop 后即写 localStorage。
  2. 取消勾选某 chip → 仍占位（`chipOrder` 不变）、仅变灰 + 删除线；再勾选直接恢复原位。
  3. 切到 `?mode=kanban` → 列顺序 = chipOrder；隐藏的 status 列**完全不渲染**（不会出现「暂无」空列）。
  4. 点 chip 行末尾齿轮 → 下拉 3 radio（不同步/弱同步/强同步）→ 切换即时改 `chipOrderKey` 并重读 localStorage。
- **实现细节**：
  - **`spa/src/views/GlobalBoard.vue`** — 加 `chipOrder` / `draggingChip` / `dragOverChip` refs + `syncLevel` / `showSyncMenu` / `syncMenuRef` refs；`loadSyncLevel` / `loadChipOrder` / `saveChipOrder` / `onChipDrag*` / `onDocMouseDown` 全套函数（与 BoardPage R51.2/R51.3 镜像）；`onBeforeUnmount` 清理 mousedown listener；`watch(chipOrderKey)` 重新解析偏好。
  - **localStorage 命名空间**：
    - chip 顺序默认：`ao-global-chip-order-v1`
    - 强同步模式：`ao-global-chip-order-account`
    - 同步级别配置：`ao-global-sync-level`（与 BoardPage 的 `ao-board-sync-level` 独立）
  - **`spa/src/views/kanban/KanbanBoard.vue`** — 已在 R56-A0 接入 `columnOrder` / `selectedStatuses` 可选 prop；本次无需改。
  - **`KanbanBoard`** 调用方传 `:column-order="chipOrder"` + `:selected-statuses="selectedStatuses"`，与 BoardPage 同口径。
- **注意**：
  - global board 没有 project 维度，「弱同步」与「不同步」实际等价（hint 文案已说明）。如有跨 project 同步需求后续再说。
  - `chipOrder` 在切 active ↔ terminal 时**不会自动重读**（与 BoardPage 同款既有行为，不在本 R 修复范围）；如未来要支持，需加 `watch([statusGroup, visibleStatuses]) → loadChipOrder`。
  - 同步级别菜单是 BoardPage R51.3 的 SPA 镜像版（master 端 `board-client.tsx:1211-1262`），不是新增设计。
- **注意**：
  - 历史遗留的 `project_id=NULL` 任务在 Migration v7 中被迁移到自动创建的「未分类」项目
  - `/uncategorized` 路径仅保留为旧书签兼容重定向，正常查询使用 `unversioned` 参数
  - 未版本化任务仍受项目 cwd 约束
  - R51.11 kanban reorder 的 endpoint body 是 `{orders: [{id, order}, ...]}`（master route 实际定义），spec 提到的 `{task_id, before_task_id, status}` 不存在，已纠正。

### 功能点：Chat 视图模式（R53）

- **是什么**：在版本页 / 全局看板 / 未版本化页均可切换到「聊天」视图模式，把任务列表以 chat 形式重新组织：左侧为当前 scope 内的任务列表（可拖拽调宽），右侧为「新建聊天」输入区或选中任务的预览，输入区支持粘贴/拖拽/选取文件附件 + 高级配置（Effort / 最大轮次 / 自动审批）。MVP 单会话版：同 scope 的所有 task 视为一个会话，不支持 chat list 多会话切换、不支持 opencode 模型单独选择（R55+ 留）。
- **怎么用**：
  1. **进入 chat 模式**：版本页 `/{projectId}/{versionId}?mode=chat`、全局看板 `/global?mode=chat`、未版本化页 `/{projectId}/unversioned?mode=chat` —— URL 即状态，可直接收藏/分享。
  2. **ViewSwitcher**：每个 board header 右侧有「卡片/看板/聊天」（未版本化页 / 卡片/列表/分组/看板/聊天）/「卡片/看板/聊天」（版本页）/「卡片/列表/分组/看板/聊天」（全局看板）等视图切换按钮，点「聊天」即切。
  3. **新建聊天**：左栏顶部「+ 新建聊天」按钮 → 右栏切到输入面板 → 输入指令 → 拖入附件或 Cmd/Ctrl+V 粘贴截图/文件 → 点「发送」或 Cmd+Enter → 后端 POST /api/tasks + 上传附件 + POST /api/tasks/{id}/start → 新 task 自动选中。
  4. **切换 project/version**：右栏顶部 pill 点开 → picker（原生 `<select>`）→ 选新项目/版本 → URL filter 同步刷新。
  5. **顶部 chrome 折叠**（仅版本页）：header 右侧「收起 / 展开」toggle → 大标题 + 过滤排收起/展开，偏好持久化 `localStorage['version-chrome-open-v1']`（默认收起；R217v7 起 BoardPage 自带 toggle 已删，只剩这一份入口）。
  6. **移动端**：`md` 以下断点左栏/右栏切换成上下叠层，「返回列表」按钮回到左栏选 task。
- **关键实现**：
  - `spa/src/views/chat/ChatView.vue`（MVP 1649 行；粘贴/拖拽/附件/输入/Picker 全包，scoped CSS）。
  - `spa/src/views/GlobalBoard.vue`：ViewMode 加 `'chat'`，5 模式（cards/list/grouped/kanban/chat）；`chatActiveProject` / `chatActiveVersion` 派生自 filter state；`chatInitialTaskId` 读 URL `?taskId`（B351），`onChatTaskCreated` 按 status 落 active/terminal 数组（B367），`onChatProjectChange` / `onChatVersionChange` 同步 filter URL（B366）。
  - `spa/src/views/BoardPage.vue`：ViewMode 加 `'chat'`，3 模式（cards/kanban/chat）；`topHeaderOpen` 本组件持有 + localStorage 持久化（R53.5 B089/B090）；onMounted URL `?taskId` 跳转守门：chat 模式不跳 /tasks/{id}（B104 chat 分支）；`onChatVersionChange` 走 `router.push` 跳新版本 URL（master board-client.tsx:1397-1401 同款，URL 锁死场景）。
  - `spa/src/views/ProjectUnversioned.vue`：嵌入 `<BoardPage :project-name="projectName" />`；新增「💬 聊天视图 / 📋 卡片视图」切换按钮（mode=chat ↔ mode=undefined），ProjectUnversioned 加载的 project.name 透传到 BoardPage → ChatView pill 显真名。
- **注意**：
  - ChatView 选中任务后右侧显示标题 + 状态 + prompt_preview + 「打开完整对话 →」链接，未嵌入完整 transcript（master chat-view.tsx 嵌 TaskDetailClient；SPA 留 R55+ 接 TaskDetailView 嵌入或同等）。
  - chat list 多会话切换 / opencode 模型单独选 留 R55+ 范畴，本轮不做。
  - ChatView 不挂 SSE（与 GlobalBoard / BoardPage 一致，跨视图 SSE 在 R54 统一接）。
  - 跳过的 R53 子任务（披露）：`B361` GlobalBoard SSE 事件订阅 → R54；`B351` 在 BoardPage 的同源实现 → R51.5 已包含非 chat 部分，chat 部分仅动 GlobalBoard（ProjectUnversioned 走 BoardPage 继承）。

### 功能点：聊天模式行尾任务指标 chips（R236）

- **是什么**：chat 模式选中任务后，面包屑行（`项目上下文 › 项目 #id 标题`）行尾常驻一组小字指标 chips：`模型 · 上下文用量/上限 (百分比) · 累计成本`。上下文占用带阈值配色（≥85% 红 / ≥60% 橙 / 其余灰，与任务详情页元信息行同口径）；无数据的 chip 自动隐藏（如成本为 0、无上下文数据）。窄屏放不下时整组折到面包屑第二行右对齐，不与标题挤压。
- **怎么用**：无需操作 — 进入 chat 模式（版本页 / 全局看板 / 未版本化页）选中任意任务即显示。任务运行中数值经父级 SSE（`context` / `context_update` / `cost` 事件）实时刷新，与任务详情页元信息行同步。
- **关键实现**：`spa/src/components/TaskMetaChips.vue`（新组件，纯展示）+ `spa/src/views/chat/ChatView.vue`（面包屑行尾挂载 + `liveContext` ref + SSE 事件分支）；详情页完整指标行仍是 `TaskMetaRow`（模型/强度/最大轮次/创建/上下文/剩余/成本全量），chips 是其窄空间子集。
- **注意**：同轮修复 H5（≤900px）右侧「信息面板」抽屉出画 bug — 桌面拖宽残留的内联 `width/min-width`（`task-right-dock-width-v1`，280-800px）在 resize 到 H5 后压过抽屉 CSS，480px 抽屉在 390px 屏上 left=-90 整体出画。修复双保险：抽屉 media query 里 `width/min-width` 加 `!important` + 断口判断改走响应式 `useMediaQuery`（`spa/src/composables/useMediaQuery.ts`，matchMedia 非 Vue 响应式依赖是根因）。任务详情页（`side-col`）与 chat 页（`cv-side`）同款同修。

### 功能点：实时事件订阅（R54.2 — GlobalBoard SSE 接入）

- **是什么**：全局看板（`/global`）订阅后端 SSE `/api/events`，跨项目实时接收 `status_change` / `cost` 事件，本地 patch 任务状态或 cost 字段（不再走 `refetchAll` 全量刷新）。与 Next `global-board.tsx:371-435` handler **1:1 复刻**，行为/边界/未知 event 处理完全对齐 master。
- **怎么用**：
  1. 打开 `/global`（任意视图模式都生效：cards / list / grouped / kanban / chat）。
  2. 后端任意 task 状态变化（如某 task 从 `running` → `completed`）→ 全局看板对应任务卡片**原地更新状态徽标**，并自动从「活跃」段移到「历史」段（无需手动刷新）。
  3. 跨集合移动（active ↔ terminal）走 splice（filter + prepend），单集合内 patch 走 map；未知 task（不在当前 active/terminal 数组）按方向只 refetch 一个集合（不全量 refetchAll）。
  4. cost 事件（后端 `CostEvent`，每条 SSE 推送）原地 patch `cost_usd` 字段，UI 立即刷新。
- **4 路 status_change 分发逻辑**（与 master `global-board.tsx:371-435` 一致）：
  | 当前所在 | 目标状态 | 行为 |
  |---|---|---|
  | `terminal` | `terminal` | 原地 patch `status` + `updated_at` |
  | `active` | `active` | 原地 patch `status` + `updated_at` |
  | `active` | `terminal` | 从 active filter 出去 → prepend 到 terminal，`terminalTotal + 1` |
  | `terminal` | `active` | 从 terminal filter 出去 → prepend 到 active，`terminalTotal - 1`（最小 0） |
  | 不在两者 | 任意 | 按 `toIsTerminal` 只 refetch 一个集合（`loadTerminal(0, true)` 或 `loadActive()`） |
- **实现细节**：
  - **Composable**：`spa/src/composables/useTaskEventSource.ts`（R54.1）。
    - 模块级单例 `Map<url, Entry>` + 引用计数 + 回调集合，与 master `use-global-event-source.ts` 同款；多组件共享一条 EventSource，避免同域并发名额占满（浏览器每域 6 个 HTTP/1.1 长连接上限）。
    - URL 参数化（默认场景调用方传 `/api/events`），方便未来其他 SSE 流复用。
    - `onerror` 时探测 `/api/user/me` 401 → 主动 close EventSource + 清 map 条目，避免服务端 401 后 EventSource 默认无限重连（与 master 同款）。
    - `JSON.parse` 失败静默，单条脏数据不阻断整条流。
    - 用 `onBeforeUnmount` 注册清理（Vue 3 等价于 React useEffect cleanup）。
  - **Handler**：`spa/src/views/GlobalBoard.vue` 的 `onGlobalEvent` 函数（~75 行）。直接闭包读 setup() 的 `activeTasks` / `terminalTasks` / `terminalTotal` ref，**无需 cbRef**——Vue 3 setup 每组件实例只跑一次，函数引用稳定（与 React useRef 每 render 重写机制不同）。
  - **不引新依赖**：用原生 `EventSource`（与 master 同款），不引入 `eventsource-parser` 等 polyfill。
- **注意**：
  - 只覆盖 `/global` 全局看板。`/{projectId}/{versionId}` 版本看板与 `/{projectId}/unversioned` 未版本化页的 SSE 走项目级（`/api/projects/[id]/events`）由 R14 BoardPage 负责，与本节独立。
  - 后端 `/api/events` 是 R53 之前已就位的全局流（详见 `src/app/api/events/route.ts` + `src/lib/runtime/agent-runtime.ts:2100 subscribeToAllEvents`），本任务纯前端接入，不动后端。
  - 未知 event 类型静默忽略（与 master 同款），不触发 refetchAll 兜底——信任服务端 event 类型收敛。
  - R5 阶段（v2.0-spa 初版）SSE 未接入，走 `refetchAll` 兜底；R54.2 起改 SSE patch，refetchAll 仅保留给筛选条件变化等显式触发场景。

### 功能点：导航树

- **是什么**：侧边栏的项目-版本树形导航组件
- **怎么用**：
  - 侧栏展示当前用户的所有项目，展开后显示版本列表
  - **展开状态 sticky（2026-10-31）**：进入某项目/任务页时，该项目若未被手动折叠过则自动展开并**记住**——之后导航到别处**不会自动收起**；收起只能由用户显式操作（点 ▼/▶ 或点项目名）。旧版口径「未动过的项目 = 展开当且仅当是当前路由项目」会在每次切页时把路过自动展开的项目收起，表现为侧栏项目反复自动展开/收起（2026-10-31 damo 报告，headless 实证后修复）
  - 当前版本（current version）旁有 ⭐ 标记
  - 项目列表页（SPA `ProjectsView.vue`）展开的版本行：非当前版本有「设为当前」按钮，点击即切换为当前版本（飞书 AO-DEV R6 补，此前 SPA 缺入口只能调 API）
  - 侧栏（`ProjectSidebar.vue`）版本行仅显示 ⭐ 标记，不提供切换入口
  - 每个项目下有虚拟「其他任务」节点，点击进入未版本化任务看板
  - 项目行**整行可拖动**重排（整行 `draggable=true`，拖项目名即可；R169 删掉了原先名字左侧的 `⋮⋮` 拖拽手柄图标）
  - **拖拽虚影 = 项目行本身**（R170）：拖动时跟随鼠标的虚影是克隆的项目行（含名称/徽章/置顶星，样式与真行一致），不再是浏览器默认的「地球」小图标。实现：ghost 克隆行挂到 body 视口外（`position:fixed; top:-9999px`）后 `setDragImage` —— Chromium 只给文档树内元素做快照，detached 元素会静默回退到默认拖拽图标（R170 根因）
  - 置顶星 ★/☆ 在项目行**最右侧**（数字徽章右边，R169 从名字左侧移到行尾）；未置顶时 hover 显形，置顶时常驻琥珀色
  - 仅在非根路径显示侧栏（根路径显示项目列表）
- **注意**：
  - 切换 current version 调用 `PATCH /api/projects/[id]`，更新 `current_version_id`
  - 访问 `/{projectId}` 时自动 307 重定向到 current version；无版本时重定向到 `unversioned`
  - 导航树组件位于 `src/components/NavigationTree.tsx`

### 功能点：侧栏项目右键菜单（v532 — SPA）

- **是什么**：侧栏项目行（展开态项目行 / 折叠态圆头像 / 归档行）右键弹出操作菜单：置顶（附收藏）、收藏 / 取消收藏、重命名、归档、删除；归档行的菜单是恢复 / 删除。左键点别处 / Esc / 滚动即关闭。
- **三档项目生命周期（归档 vs 删除的区别）**：
  | 状态 | 数据 | 主列表/侧栏 | 入口 |
  |------|------|------------|------|
  | 活跃 | 完整 | 显示 | 正常 |
  | **归档** | 完整不动 | **隐藏**，但 URL 仍可访问、agent 仍可跑 | 侧栏底部「🗂 已归档」折叠分组 / 项目列表页归档区块，一键**恢复** |
  | **删除** | 级联软删（项目+版本+任务全打 `deleted_at`） | 一切视图消失 | 只能手工 SQL 恢复；ConfirmDialog 二次确认 |
- **置顶与收藏的联动**（不变量 `pin ⇒ star`）：置顶自动附带收藏；取消收藏时若项目还置顶着会联动取消置顶。侧栏排序 = 置顶 ★ 段 → 收藏 ♥ 段 → 其余。行尾 hover 显示 ☆/♥ 两个 toggle（★ 琥珀=置顶，♥ 玫红=收藏），与菜单双入口一致。
- **重命名**：菜单点「重命名」→ 项目名变行内输入框，Enter / 失焦确认、Esc 取消；撞同名活项目回 409 `DUPLICATE_NAME`（toast 提示，原名不动）。
- **API**：`GET /api/projects?archived=1` 返回归档列表；归档/恢复/收藏走 `PATCH /api/projects/[id]` `{ archived: 0|1 }` / `{ starred: 0|1 }`；重命名走 `{ name }`。
- **测试**：`src/lib/db/projects-starred-archived.test.ts`（11 条：过滤/排序/规范化/URL 可访问/route 409/软删同名回收）。

### 功能点：机械验收门（v72 — DAG P3，damo 2026-09-06 B5 拍板）

- **是什么**：项目级 `verification_command`，agent 报完成 → 平台跑命令 → 成功翻 `completed` / 失败回退 `running` + 注入反馈（重试 N 次）。
- **三层字段**（项目级，PATCH `/api/projects/[id]`）：
  - `verification_command` (string | null)：要跑的命令。null = 关（默认）。
  - `verification_timeout_seconds` (10-3600，默认 600)：单次命令超时。
  - `verification_max_retries` (0-5，默认 2)：失败重试次数（B3 拍板）。
- **双重开关**（设计稿 §6）：
  - L1 平台级 `app_settings.verification_globally_enabled`（默认 **false**，B5 拍板）—— PATCH `/api/config`。
  - L2 项目级 `projects.verification_command`（默认 null）。
  - 关一即停，默认全关 = 与今天 byte-identical 行为。
- **状态机**（B4 拍板）：新增 `verifying` 瞬态。`reviewing → verifying → completed/running/failed/cancelled`。任务详情页显示蓝色 chip「正在跑机械验收...」。
- **典型用法**：
  - 「希望 agent 改完后跑 npm test 验一遍」→ 项目设置填 `npm test`，L1 设 true。
  - 「项目太多命令不一样，先关着」→ 啥也不配（L1 默认 false + L2 默认 null）。
- **注意**：
  - 命令产生的副作用（临时文件、临时 DB）由命令自己清理，平台不保证隔离（设计稿 §4.3）。
  - 反馈注入走 `tasks.metadata.pending_messages`（已有 KB §4 的 RMW 风险在 P3 收窄到「验证失败注入一次」窄路径，未做独立表）。
  - 命令 cwd = task.cwd，env 透传 `process.env`（不注入 session vars，沿用 R128 deploy 干净标准）。

### 功能点：项目卡片交互（R49 — SPA 行为收口）

- **是什么**：SPA `/projects` 页面（R17 已挂路由）项目卡片补齐 master `src/app/projects-client.tsx` 缺失的交互 — 排序、模板、端口自动选、置顶、删除、版本 CRUD。Next 端 master 全部已实现，本节是 SPA 端的对齐收口。
- **怎么用**：
  - **排序**（B003/B048）：卡片右上角「排序」Select，两档（按创建时间 / 按最近活跃）。选择后写 `localStorage['ao-projects-sort']` 持久化，重新加载页面保留偏好；切换触发 `GET /api/projects?sort=xxx` 重拉。
  - **从模板建**（B004/B049）：新建项目按钮旁「📦 从模板建 ▾」。点开拉 `GET /api/project-templates`（失败降级空数组，按钮不显示），列表展示模板 name + 描述 + 预计耗时。选中套用预填 name / description / cwd，弹 toast 提示，部分模板（如 requirement-collab / long-running-dev）替换默认 v1.0 提示为针对性提示。
  - **自动选端口**（B009）：新建项目 modal 端口输入框旁「🎯 自动选可用」按钮。点击调 `GET /api/port-pool/available?n=5`，拿前 5 个端口池内未占用端口回填。失败 / 空池均弹 toast。
  - **项目置顶**（B012/B060）：卡片右上角 hover 显示「📌 置顶」按钮。点击 PATCH `/api/projects/{id}` `{pinned: 0|1}` — **乐观更新**：UI 立即翻转 pinned 状态，请求失败回滚原值并弹 toast；成功 refetch 让 pinned DESC 顺序跟上。pinned=1 时卡片加 amber 边框 + 📌 徽章 + 按钮变 amber 高亮。
  - **删除项目**（B013/B061）：卡片右上角 hover 显示「删除」按钮。点击 → ConfirmDialog 二次确认（警告「数据保留在数据库中，可通过数据库恢复」）→ DELETE `/api/projects/{id}`。成功后 refetch，失败 toast 报错。
  - **快捷入口**（B043/B044）：顶部右侧新增「⚙️ 设置」和「批量导入」两个 router-link 入口，与 Next 端同款。
  - **版本编辑**（B016/B053/B017）：每条版本行 hover 显示「编辑」按钮。点击 → 折叠面板展开：飞书 URL + Sheet name 两个 Input + 「开启 sheetwatch 自动派发」Checkbox + 「保存」/「取消」按钮 + 「留空保存即清除绑定」提示。保存 → PATCH `/api/versions/{id}` `{feishu_url, feishu_sheet, enable}`（trim + 空串 → null）。成功后 toast + 关闭面板 + refetch。
  - **版本删除**（B018/B063）：版本行 hover 显示「删除」按钮。点击 → ConfirmDialog 二次确认 → DELETE `/api/versions/{id}`。成功后从列表移除 + refetch。
  - **新建版本**（B021/B022/B053/B054/B023）：版本列表底部「+ 新建版本」按钮 → 展开 blue 背景表单：版本名 Input（必填）+ 飞书 URL Input + Sheet name Input + 「开启自动派发」Checkbox + 「创建」/「取消」按钮。提交 → POST `/api/versions`；若项目 `current_version_id` 为空（首个版本）自动 PATCH 设当前版本。成功后 toast + 关闭表单 + refetch。
  - **项目搜索**（客户端 includes 过滤）：页头下方独立搜索 Input。匹配范围 = 项目 name / description / cwd / 各版本 name（卡片上所有可见文本字段，大小写不敏感）。无 debounce / 无 URL 同步 / 无持久化（与 sort 持久化相反 —— sort 是偏好，search 是瞬时动作）。搜索态下计数显示「匹配 X / Y」，空态分「没项目」vs「搜索无结果 + 清除搜索链接」。header-meta 控件过多易挤压标题，搜索框挪到独立行 + header 改 column 方向默认，保证标题独占一行不被折行。
- **实现原理（开发者参考）**：
  - API 入口：`spa/src/api/projects.ts` — `updateProject`/`updateVersion`/`deleteProject`/`deleteVersion`/`createVersion`/`listProjectTemplates`/`listAvailablePorts`。
  - Store：`spa/src/stores/projects.ts` — `loadAllVersions()` 一次性拉所有版本并按 project_id 分组（master line 909 projectVersions 同款 filter）。
  - 视图：`spa/src/views/ProjectsView.vue` — 17 个 handler + 模板内联渲染。
  - 状态机：`editingVersion: ref<string|null>`（哪条 version 在编辑态）/ `newVersionProjectId: ref<string|null>`（哪条项目在新建表单态）。null = 全关闭。

### 功能点：项目详情页创建任务入口（R171 — SPA）

- **是什么**：SPA `/{projectId}` 项目详情页新增两个创建任务的快捷入口，不必先点进版本再新建。
- **怎么用**：
  - **页头「新建任务」**：项目详情页右上角（与「+ 版本」并排，新建任务为主操作蓝填充、+ 版本改灰描边次操作）。点击跳 `/tasks/new?project=<id>&version=<current_version_id>` — 项目设了默认版本（current）时自动预填该版本；没设默认版本则只预填项目，版本由用户在新建任务页自选。
  - **版本行「+ 任务」**：版本列表每一行 hover 时行尾浮现「+ 任务」mini 按钮（ghost 弱化，hover 前隐藏不抢视线）。点击跳 `/tasks/new?project=<id>&version=<该版本id>`，事件 `stop` 冒泡不触发整行跳版本详情。
- **实现细节**：
  - 视图：`spa/src/views/ProjectDetailView.vue` — `goNewTask(versionId?)` 一个 handler 两处复用；query 传参口径与 TaskNew 的 URL prefill（`?project=&version=`）一致。
  - 版本行按钮用通用 `Button`（`variant=ghost` + `size=mini`），hover 显隐走 `.version-item:hover/:focus-within .version-newtask` CSS（`opacity 0→1`），无新组件。

### 功能点：cwd 本机校验（damo 2026-10-31 拍板）

**规则**：项目/版本的 `cwd` 字段在**写入时**（POST/PATCH `/api/projects`、`/api/projects/{id}`、`/api/versions`、`/api/versions/{id}`）由服务端校验：必须是**本机真实存在的目录**，否则 400 拒绝。

**背景**：四套实例（WSL/Mac/Air/pulu）的 DB 互相抄过快照，跨机路径形态互串（Mac 的 `/Users/user/...` 传到 WSL）会让 agent 启动 `mkdir EACCES` 秒挂（2026-10-31 task `8c104f7d` 实证）。此校验只拦**新写入**，历史脏数据读取不受影响。

**两条放行通道**（默认都不传 = 严格拒绝；`ao-create-project.sh` 默认参数也不带）：

| 参数 | 行为 |
|------|------|
| `git_remote: "<url>"` | 路径不存在时服务端 `git clone` 到该路径（120s 超时） |
| `create_if_missing: true` | 路径不存在时服务端 `mkdir -p`（真新建项目用） |

**400 响应结构**（`code: "CWD_NOT_FOUND"`）：`error` 是一句人话结论；`hint` 含结构化核查信息——`host`/`home`（本机是谁）、`under_home`（前缀是否家目录形态）、`home_prefixed`+`home_prefixed_exists`（跨机前缀换算后的本机对应路径及其存在性）、`candidates`（家目录下同名/对应目录）、`actions`（四步处置指引）。按提示依次核实：① 路径前缀是否和本机家目录匹配 ② 家目录下是否已有该项目（改用候选路径）③ 真要新建 → `create_if_missing` ④ 项目在远端 → `git_remote`。

**校验器**：`src/lib/cwd-validate.ts`（`validateCwdFromBody` 供路由复用，通过时会剥掉放行参数再进 DB 层）；单测 `src/lib/cwd-validate.test.ts`（12 条）。

### 功能点：项目详情页版本行编辑（R176 — SPA）

- **是什么**：SPA `/{projectId}` 项目详情页版本列表行新增「编辑」按钮 + 内联编辑面板 — 之前版本编辑只在 `/projects` 项目卡片有，damo 从项目详情页 URL 看不到编辑入口（飞书 AO-DEV R176 追加）。
- **怎么用**：版本行点「编辑」→ 行下方展开面板：版本名（必填）+ 飞书 sheet URL（留空保存即清除绑定）+ Sheet 名或 id + 版本描述 + 「开启 sheetwatch 自动派发」Checkbox → 「保存」/「取消」。保存 → PATCH `/api/versions/{id}` `{name, description, feishu_url, feishu_sheet, enable}`（trim + 空串 → null），成功 toast + 收起面板 + 重拉版本列表（「飞书 · 监听中/已关」标签跟着 enable 刷新）。
- **实现细节**：`spa/src/views/ProjectDetailView.vue` — `editingVersionId` ref 表达哪条在编辑态（null = 全关）；面板 `@click.stop` + `@keydown.stop` 防触发整行 `goVersion` 跳详情。`UpdateVersionBody` 加 `name`（后端 `updateVersion` db 层早已支持，PATCH 路由无白名单拦截）。

### 功能点：项目概览看板（单文件 markdown）

- **是什么**：每个项目一份 markdown 看板，放**当前状态 + 常用链接 + 凭据备注**，人读的。项目详情页（`/projects/{projectId}`）第一个 tab「概览」就是它，**默认显示**；旁边还有「元数据」「版本」两个 tab（原有内容不变）。
- **怎么用**：
  1. 打开项目详情页 → 点右上「✏️ 编辑」→ 在文本框里写 markdown → 「保存」。
  2. 顶部「常用链接」区自动给出项目内入口（🎬 控制台 / 📚 Wiki / 📋 需求点 / ➕ 新建任务），不用手写。
  3. 命令行读写同一个文件（给人用也 agent 用）：
     ```bash
     ao overview show ao-dev              # 读，stdout = 纯 markdown
     ao overview edit ao-dev /tmp/x.md    # 用文件覆盖
     ao overview append ao-dev /tmp/y.md  # 追加（不覆盖原文）
     ao overview clear ao-dev             # 删掉
     ao overview url ao-dev               # 打印页面 URL
     ```
- **能写什么**：markdown 全部语法（链接 / 表格 / 代码块 / 列表）。链接规则：
  | 写法 | 跳到 |
  |------|------|
  | 裸 URL（如飞书 sheet 链接） | 外部，新窗口打开 |
  | `task:2c364593`（任务 ID 或 8 位短前缀） | 平台任务详情页 |
  | `project:{UUID}?path=docs/a.md` | 另一个项目的 Wiki |
  | `docs/a.md`（相对路径） | 本项目 Wiki 里的那篇 |
- **🔴 凭据可以放心写**：概览存在 DB 里并用 **AES-256-GCM 加密**（`project_configs` 表，`key = overview_md`），**不进 git、不落 cwd 文件** —— 所以密码、卡号、密钥这类东西放这里不会被 `git commit` 带进版本库。
- **注意**：
  - 大小上限 **64 KiB**，超了保存返 400（不截断 —— 截断会让人以为存全了）。
  - **owner 隔离**：只有项目 owner 能读写，别人的项目一律 404（不暴露项目存在性）。admin 也不豁免写。
  - 与项目 Wiki **不是一回事**：Wiki 读的是 cwd 里的文件（`INDEX.md` 等，进 git），概览存在 DB（不进 git）。两者链接互通（概览里可链到 Wiki 的某篇）。
  - `overview_md` 这个 key **只能走专用接口** `/api/projects/{id}/overview` 读写；通用 KV 接口 `/api/projects/{id}/config/overview_md` 返 409（避免两条写路径大小限制不一致）。
- **实现原理（开发者参考）**：
  - 后端：`src/lib/db/project-overview.ts`（加密 CRUD）+ `src/app/api/projects/[id]/overview/route.ts`（GET/PUT/DELETE，owner 校验）；测试 `src/app/api/projects/[id]/overview/route.test.ts`（13 条）。
  - 前端：`spa/src/components/ProjectOverviewPanel.vue`（面板）+ `spa/src/views/ProjectDetailView.vue`（tab 容器）；链接规则共享 `spa/src/lib/wiki-markdown.ts`（与 Wiki 页同一份真相，改一处两边生效），单测 `spa/src/lib/wiki-markdown.test.ts`（28 条）。
  - CLI：`scripts/ao-overview.sh`（`ao overview` 子命令已注册进 `scripts/ao` 的 COMMANDS 表）。

## 常见问题

**Q: 怎么让某个版本不再自动派发任务？**
A: 版本行点「编辑」→ 取消勾选「开启 sheetwatch 自动派发」→ 保存。保存后该版本行显示琥珀色「自动派发已关」徽章，版本详情页元数据「自动派发」一行显示「已关闭」。

**Q: 哪里能看到某版本飞书自动派发是否激活？（R176）**
A: 三处都有常显标志（2026-10-03 R176 起，之前只有关闭态才有标记、激活态无标志导致"看不到"）：
- **项目详情页**（`/{projectId}`）版本列表行：`飞书 · 监听中`（绿字，enable=1）或 `飞书 · 已关`（琥珀胶囊，enable=0），hover title 显示飞书 URL + sheetwatch 语义。
- **项目列表页**（`/projects`）项目卡片版本行：绿色「自动派发中」小胶囊（enable=1）或琥珀「自动派发已关」（enable=0），与 🔗 徽章并排。
- **版本详情页**（`/{projectId}/versions/{versionId}`）面包屑行：`飞书 · 监听中` / `飞书 · 已关` chip，短 ID 按钮右侧 — 面包屑不受「收起上方面板」折叠影响，一进页面即可见（元数据卡片默认折叠看不见的问题由此绕开）。
- enable 字段缺省（老 DB 行）按 1（激活）显示，与 partner sheetwatch 口径一致。

生效链路与生效延迟（2026-09-29 crazygames 事故后明确）：
- `versions.enable=0` → partner `scripts/sheetwatch` 的 `load_projects()` 过滤掉该 version 的 binding → 日志打 `⏭️ <项目>/<版本>: enable=0,跳过 sheetwatch`。
- ⚠️ **最长 30 分钟才生效**：`var/sheetwatch/projects.json` 项目绑定缓存 TTL = `PROJECTS_CACHE_TTL` 1800 秒。改完 `enable` 后若要立即生效，删掉该缓存文件（下次 tick 自动重建）：
  ```bash
  rm -f /home/user/workspace/partner/var/sheetwatch/projects.json
  ```
  下一 tick（sheetwatch cron `*/5`）重新拉 `/api/versions` → 拉到新 `enable`。
- 关闭只挡**新**派发，**已在队列里的任务不会自动消失** —— 需要手动 cancel。
- API：`PATCH /api/versions/{id}` `{"enable": false}`。仅接受布尔；传 `0` / `1` / `"true"` 返 400（避免 `1` 被静默当真）。不传 `enable` = 该列不动。
- 默认值：`createVersion` 不传 `enable` → `1`（老调用方 / 老 DB 行兼容）；字段缺失也按启用处理。

**Q: 项目创建后能改 cwd 吗？**
A: 可以。通过项目设置或 API 修改项目 cwd，但已完成的任务不受影响。

**Q: 版本和飞书 sheet 是什么关系？**
A: 每个版本可绑定一个飞书 sheet（feishu_url + feishu_sheet）。绑定后，飞书行可批量导入为该版本下的任务，任务状态变更可回写飞书。详见 [08-批量导入与飞书同步](./08-import-sync.md)。

**Q: 一个项目能有多个 current version 吗？**
A: 不能。每个项目只有一个 `current_version_id`，类似 Git 的 HEAD 指针，但可随时切换。
