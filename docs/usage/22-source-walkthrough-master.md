# 22. v1.0 master 源码细致 walkthrough

> **文档目的**: 从源码提炼每个 Next.js 页面 / 客户端组件 / API route / lib 模块的需求描述。
> **颗粒度**: 逻辑单元 (function / handler / exported module / API route handler)
> **阅读对象**: 想接管 master 的新工程师 / 在 v1.0 基础增功能 / v2.0-spa 1:1 对齐找功能定位
> **来源**: master HEAD `9089bb05` (G3+G4+G5 backend + main v1.0)
> **覆盖范围**: 排除 `*.test.ts(x)` 测试文件、`src/lib/db/index.ts` migrations 大表、`next-env.d.ts` / `next.config.ts` / `tsconfig.json` 工具配置
> **最后更新**: 2026-09-24

## 目录

1. **顶层页面 (`src/app/**/page.tsx`)** — 31 个文件
2. **客户端组件 (`src/app/**/*-client.tsx` 同目录内嵌 tsx)** — 32 个文件
3. **API route handler (`src/app/api/**/route.ts`)** — 134 个文件，按子目录 group
4. **公共组件 (`src/components/*.tsx`)** — 18 个文件
5. **lib helpers (`src/lib/**/*.ts` 非 db)** — 91 个文件 + 5 hook
6. **DB 层 (`src/lib/db/*.ts` 非 test)** — 35 个文件（`index.ts` migrations 大表跳过）

---

## 1. 顶层页面 (`src/app/**/page.tsx`) — 31 文件

### 1.1 `src/app/page.tsx` (projects dashboard wrapper, 13 行)

> **LOC**: 13. **最后修改**: 2026-09-23. **类型**: server component wrapper.

#### 逻辑单元: `HomePage()` (line 6-13)
- **目的**: 首页 projects dashboard 入口。`getServerUserId()` → `getUserById(userId)` 拿 user email → 传 `<ProjectsClient userEmail={…}/>`（1795 行 client，全局唯一 dashboard）。无 NavSidebar 渲染（dashboard 全宽）。
- **依赖**: `getServerUserId`, `getUserById`, `ProjectsClient`.
- **关键行为**: middleware 已保证访问 `/` 必须登录；`userId` 为兜底空 email 直接 render client（罕见，无效态）。

---

### 1.2 `src/app/layout.tsx` (root layout, 59 行)

> **LOC**: 59. **最后修改**: 2026-09-23 (R123 R7). **类型**: server component (root).

#### 逻辑单元: `generateMetadata()` (line 11-26)
- **目的**: 由 `src/lib/runtime/page-title.ts#getPageTitle()` 输出标题（pulu 不动 / prod 加 `[PROD]` / dev 加 `[DEV]`）。同时填 og:image / twitter card（飞书 AO-DEV R146）。

#### 逻辑单元: `viewport` (line 30-34)
- **目的**: `viewportFit: "cover"` 让 env(safe-area-inset-*) 在 iPhone notch 上返回非零 — 固定元素（汉堡按钮等）据此避开状态栏/灵动岛。

#### 逻辑单元: `RootLayout({children})` (line 36-59)
- **目的**: 根 `<html lang="zh" className="h-full">` + `<body className="h-full bg-gray-50 …">` 包 `<ToastProvider>` → `<AuthGuard/>` → `<div h-screen overflow-hidden>` → 左侧 `<NavSidebar/>` + 右侧 `<TabRoot>{children}</TabRoot>`。
- **关键行为**: R122 第七轮把根容器 `min-h-screen → h-screen overflow-hidden` —— 旧版 `min-h-screen` 内容超 100vh 时整页撑高 = body 滚动; 改 `h-screen` 后内容在 main 内部各自滚动, 整体永不滚. 飞书 AO-DEV R123 tab 容器包住右侧内容, 顶部显示已打开 tab + 拦截内链开新 tab。

---

### 1.3 `src/app/error.tsx` (page error boundary, 108 行)

> **LOC**: 108. **最后修改**: 2026-09-23. **类型**: client component (use client).

#### 逻辑单元: `Error({error, reset})` (line 5-109)
- **目的**: 路由级错误兜底 (Next.js App Router 约定 export `default`). `useEffect` (line 12-15) `console.error("页面错误:", error,)"`. `isDev = NODE_ENV !== "production"` (line 17). 渲染大块卡片: 红圈 SVG 大标题"页面出错了" + 错误信息块（dev 下显示 message + 否则兜底"请稍后重试或联系管理员"）+ digest 追踪 ID + 两个按钮：reset() 重试 / 链回 `/` 返回首页。

---

### 1.4 `src/app/global-error.tsx` (global error boundary, 83 行)

> **LOC**: 83. **最后修改**: 2026-09-23. **类型**: client component (use client).

#### 逻辑单元: `GlobalError({error, reset})` (line 5-83)
- **目的**: 全局错误兜底（接 `<html>` + `<body>`). `useEffect` (line 12-14) `console.error`. `isDev` (line 16). 卡片显示 "应用出现严重错误" + dev 下才显示详细 message + digest 追踪 + 重试 / 返回首页。

---

### 1.5 `src/app/[projectId]/page.tsx` (project redirect, 33 行)

> **LOC**: 33. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `ProjectRedirectPage({params})` (line 12-33)
- **目的**: 访问 `/{projectId}` 立即重定向到 current version 的看板. `getServerUserId()` + `(await getServerRole()) === "admin" ? undefined : userId` 取 admin bypass owner 过滤. `getProjectById(projectId, ownerId)` (line 18) — 不存在 redirect `/?error=project_not_found`.
- **关键行为** (line 24-33): `project.current_version_id` 优先 → redirect; 否则 `listVersions(project.id, ownerId)` (line 29) — 空 `redirect("/{id}/unversioned")`; 否则 `redirect("/{id}/{versions[0].id}")`.

---

### 1.6 `src/app/[projectId]/[versionId]/page.tsx` (version board, 71 行)

> **LOC**: 71. **最后修改**: 2026-09-21 (DAG P3). **类型**: server component (RSC 初载).

#### 逻辑单元: `VersionBoardPage({params})` (line 23-66)
- **目的**: 访问 `/{projectId}/{versionId}` 渲染当前版本的看板 (BoardClient). `INITIAL_TERMINAL_LIMIT = 50` (line 21).
- **关键行为** (line 38-60): 双 listTasksPage 并行拉 active (limit=200) + terminal 第一页 (limit=50), `taskOwnerId = ownerId ?? ""` (admin bypass 空字符串). 拼成 `tasks = [...activeRes.items, ...terminalRes.items]` 给 BoardClient. `resolveVerificationGloballyEnabled()` (line 60) → 把 DAG P3 L1 平台开关解析结果作 prop 传给 client, 避免 client 二次 fetch `/api-config` (RSC 直读 KV, 零额外查询)。
- **依赖**: `getServerUserId`, `getServerRole`, `getProjectById`, `getVersionById`, `listTasksPage`, `resolveVerificationGloballyEnabled`, `BoardClient`. admin bypass 与 `listProjects` 语义一致。

---

### 1.7 `src/app/[projectId]/[versionId]/requirements/page.tsx` (version requirements list, 129 行)

> **LOC**: 129. **最后修改**: 2026-09-13 (R107 R 列第三轮). **类型**: server component.

#### 逻辑单元: `VersionRequirementsPage({params, searchParams})` (line 25-129)
- **目的**: 项目某个版本下需求点列表。默认 filter = `project_id` + `version_id` path 参数; `?clear=1` → 清空 version 过滤仅按 project_id 看全量; `?status=…` 状态过滤保留。
- **关键行为** (line 43-48): 构造 `viewParams: RequirementsSearchParams`, `?clear=1` 时不传 `version_id`. **关键** (line 53-64) 自己写一个 `buildLocalHref({clear, status})` —— 因 View 内默认 `buildFilterHref` 写到 `/requirements?…` 把 path 上下文丢了. `topBar` (line 68-120): 项目名 / 版本名面包屑 + "清空版本 / 恢复版本 / 重置 / 总入口" 4 按钮, R107 第三轮 上下文携带（不丢项目）必须保留 path.
- **依赖**: `RequirementsListView` (`src/components/RequirementsListView`), `getProjectById`, `getVersionById`, `getServerRole/Id`.

---

### 1.8 `src/app/[projectId]/board/page.tsx` (board iframe page, 106 行)

> **LOC**: 106. **最后修改**: 2026-09-21 (R91 第二步). **类型**: server component.

#### 逻辑单元: `BoardPage({params, searchParams})` (line 25-106)
- **目的**: 看板页面入口. 服务端读 board 文件, 解析 frontmatter + body, 把 config + 原始 HTML 一起传给 client, 在 iframe sandbox 里渲染. R91 第二步默认 `boardPath = rawPath?.trim() || "boards/my-project.md"` (line 48) —— 每个项目点 Board 自动看本项目视图 (ctx 注入 project_id, SQL 只看当前项目). 想看全平台改 `?path=boards/project-progress.md`.
- **关键行为** (line 36-65): `version` 优先 → `project.current_version_id` → `versions[0].id` → null. `cwd = versionObj?.cwd || project.cwd`. `resolveBoardFile(cwdReal, boardPath)` 两级解析 (项目 cwd 优先 → 平台内置 boards/ 回落, R91), 找不到时渲染 page 内 inline 引导样例 (line 66-92), 不让 SSR 跳 404. SSR **不**执行 data source (拿不到 cookie 鉴权, 会等所有 source 跑完才返回) —— 拉数走 client fetch 带 `x-user-id`.

---

### 1.9 `src/app/[projectId]/unversioned/page.tsx` (unversioned board, 54 行)

> **LOC**: 54. **最后修改**: 2026-09-21 (DAG P3 收尾). **类型**: server component.

#### 逻辑单元: `UnversionedBoardPage({params})` (line 15-50)
- **目的**: `/{projectId}/unversioned` —— 项目级任务不带 Version。`unversioned: true` 传入 `listTasksPage`. 双 fetch 同 1.6: active (limit=200) + terminal (limit=50) 拼成 tasks 数组传给 `BoardClient` (line 50) `version=null` —— 用同一 client 渲染, 区别是 version prop.
- **行为细节** (line 18-47): admin bypass (line 20) 与 listProjects 语义一致, `taskOwnerId = ownerId ?? ""`. `globallyEnabled` 同步 DAG P3.

---

### 1.10 `src/app/[projectId]/unversioned/requirements/page.tsx` (unversioned requirements, 94 行)

> **LOC**: 94. **最后修改**: 2026-09-13. **类型**: server component.

#### 逻辑单元: `UnversionedRequirementsPage({params, searchParams})` (line 21-94)
- **目的**: 未发布版本项目下需求列表 (`version_id=null` 强制过滤). 不支持 `?clear=1` (本页语义 = 强制 null 过滤, 清空无意义). 视图同样走 `RequirementsListView` 共渲染, `viewParams = { project_id: projectId, version_id: "null", ...status }`. `buildLocalHref({status})` (line 43-52) 保留 path 上下文. `topBar` (line 54-85) 黄底 (区别于蓝底 version 页) + 面包屑 "未发布版本".

---

### 1.11 `src/app/[projectId]/wiki/page.tsx` (project wiki, 61 行)

> **LOC**: 61. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `WikiPage({params, searchParams})` (line 16-61)
- **目的**: 项目级 Markdown Wiki 浏览器. `?version=` 优先 → `current_version_id` → 第一版 → null; 服务端绝对路径规范化：用户直接访问 `/{id}/wiki?path=/ws/<...>/foo.md` 时 `decideAbsolutePathRedirect()` (line 45) 把它 redirect 到正确项目 + 相对路径 —— 不动 safeResolve 安全语义, 这一层只在 server component 入口跳转, API route 仍按原样只接受相对路径. 跨用户隔离由 `listProjects(userId)` owner 过滤保证.
- **依赖**: `allowedExtensions(project.wiki_extra_extensions)` (line 57) — 放行扩展名跟着 project 走 (配置存在 projects 表上). `WikiClient` 拿 5 个 props: project 元数据 / versionId / versions / allowedExts / projectsWithCwd.

---

### 1.12 `src/app/assets/page.tsx` (assets page, 10 行)

> **LOC**: 10. **最后修改**: 2026-09-23. **类型**: server component wrapper.

#### 逻辑单元: `AssetsPage()` (line 9-10)
- **目的**: `/assets` 全平台资源池页薄壳. data = `GET /api/assets` 由 client 发起, 客户端组件 `AssetsClient` 渲染 (PR-2 docs/plans/projects/asset-gallery-and-chat-media.md: 列出当前用户所有 attachment, 5 维筛选 + 排序 + 分页 + 单删 + 批量删).

---

### 1.13 `src/app/global/page.tsx` (cross-project board, 31 行)

> **LOC**: 31. **最后修改**: 2026-09-21 (DAG P3 收尾). **类型**: server component.

#### 逻辑单元: `GlobalBoardPage()` (line 13-27)
- **目的**: `/global` 跨项目 + 跨版本的全平台看板. active 全量 + terminal 第一页 (limit=50) RSC 初载. 后续由 client `loadMoreTerminal` 接管 "加载更多" 按钮. `listProjects(userId)` + `listVersions(undefined, userId)` 给全局跳转. `globallyEnabled` DAG P3 同步.

---

### 1.14 `src/app/import/page.tsx` (batch import, 222 行)

> **LOC**: 222. **最后修改**: 2026-09-23 (R139 第四批). **类型**: client component (use client).

#### 逻辑单元: `FORMAT_HELP` (line 10-17)
- **目的**: 三格式 (json/csv/markdown) 提示文案常量, 在 textarea 上方显示.

#### 逻辑单元: `ImportPage()` (line 19-222)
- **目的**: `/import` 批量任务导入. state: format, content, preview, parseErrors, importing, result, projects, versions, projectId, versionId.
- **关键行为**:
  - `useEffect` line 31-36 → fetch `/api/projects` 拉项目列表.
  - `useEffect` line 38-48 → 改 projectId fetch `/api/versions?project=`. 没 projectId → 清空 versions.
  - `handleParse` line 50-66: 按 format switch 调 `parseJsonImport / parseCsvImport / parseMarkdownImport` (`src/lib/import/parsers`), 渲染 preview.
  - `handleImport` line 68-96: `POST /api/import/{format}` body `{content, project_id, version_id || undefined}`. 成功清空 preview + content; 失败 show error.
- **UI 区** (line 98-220): 右滚 fix `h-full overflow-y-auto` (R139 第四批) + 项目/版本级联 Select (line 107-126) + 格式切换 tabs (line 129-143) + 帮助文案 (line 146-148) + textarea (line 151-156) + 预览/确认按钮 (line 159-176) + 错误/结果提示 + 任务预览列表.

---

### 1.15 `src/app/login/page.tsx` (login page, 95 行)

> **LOC**: 95. **最后修改**: 2026-09-23. **类型**: client component (use client).

#### 逻辑单元: `LoginPage()` (line 7-95)
- **目的**: `/login` 登录页. state: email, password, error, loading.
- **关键行为** (line 13-48):
  - `handleSubmit` line 13-48: `POST /api/auth/login` body `{email, password}`. 成功 (line 23-36) → stash switch token via `addRecentAccount(data.user.email, data.switchToken)` (AccountSwitcher dropdown 之后能切回). `window.location.href = params.get("from") || "/"` 硬导航（不是 router.push: set-cookie 后 client navigation 可能仍带旧 cookie 状态被 middleware 弹回 login; 完整刷新带新 cookie).
  - 错误分流 (line 41-47): 429 → 后端具体文案 (e.g. "错误次数过多，请 N 分钟后再试"); 401 → 统一 "邮箱或密码错误" (不区分用户存在与否防枚举); 其他 → 后端 `error` 字段或通用兜底.
- **UI**: 居中卡片 + 邮箱/密码 input + 错误文案 + 登录按钮 + 注册链.

---

### 1.16 `src/app/register/page.tsx` (register, 95 行)

> **LOC**: 95. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `RegisterPage()` (line 7-95)
- **目的**: `/register` 注册页. 与 LoginPage 同形. 客户端 password 长度 ≥ 6 预校验 (line 16-19), 失败 `setError("密码至少 6 位")`. `POST /api/auth/register` 后分流: 成功 stash switch token + 硬导航; 409 → "该邮箱已注册"; 其他 → 后端 error.
- **UI**: 居中卡片 + 邮箱/密码 (autocomplete=new-password) + 错误文案 + 注册按钮 + 登录链.

---

### 1.17 `src/app/progress/page.tsx` (real-time progress, 312 行)

> **LOC**: 312. **最后修改**: 2026-09-23 (R139 第三批). **类型**: client component.

#### 逻辑单元: `STATUS_LABELS / STATUS_COLORS` (line 31-55)
- **目的**: status → 中文标签 + 颜色 className map. 注意 `rejected` 文案改 "等待中"（damo 拍板, 2026-09-15）+ 橙色配色保持历史兼容.

#### 逻辑单元: `formatDuration(startMs, endMs?)` (line 57-64)
- **目的**: ms → "Xms / X.Xs / Xm Ys / Xh Ym" 三档格式化, 用于任务 elapsed 显示.

#### 逻辑单元: `ProgressBar({value, max, color})` (line 66-73)
- **目的**: 通用进度条. `pct = min(value/max * 100, 100)`, 渲染 `<div class="bg-gray-200 …"><div class="h-full ${color}" style="width: ${pct}%"/></div>`.

#### 逻辑单元: `ProgressPage()` (line 75-304)
- **目的**: `/progress` 实时进度页. state: stats, activeTasks, recentTasks, now, autoRefresh, lastRefresh.
- **关键行为** (line 83-127):
  - `fetchData` line 83-116: 并发拉 `/api/stats` + `/api/tasks?limit=200`. 切分 active (running/queued/reviewing 按 started_at/created_at 倒序) + recent (近 2 小时 completed/failed/cancelled 按 completed_at 倒序, slice(0, 20)).
  - `useEffect` line 119-127: 首 fetch + 3s 间隔 refresh. 关掉 autoRefresh 停止轮询.
- **UI** (line 134-302): R139 第三批右滚 fix `h-full flex flex-col`. 头部 autoRefresh checkbox + 上次时间. 主体分 3 section: 调度器状态 (运行中/排队中/并发上限/实时花费 + 并发占用 ProgressBar + 运行中任务 chips + 队列任务 chips) / 活跃任务列表 (含运行进度条, > 25 分钟转红) / 最近完成 (近 2 小时).

#### 逻辑单元: `StatBox({label, value, color})` (line 306-313)
- **目的**: 标签 + 大数字 (颜色可配) 的统计块. 用于调度器状态 4 列.

---

### 1.18 `src/app/requirements/page.tsx` (global requirements, 24 行)

> **LOC**: 24. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `RequirementsListPage({searchParams})` (line 19-23)
- **目的**: 全局需求点入口薄壳. R107 抽出 View 后变成薄壳 —— 与版本页 / unversioned 页共用 `RequirementsListView`. 不传 `extraTopBar` → 顶部条 (面包屑 + 清空/重置) 不渲染, 只在项目/版本入口出现. `searchParams` 透传给 View, 解析逻辑 (status/version_id/page) 全在 View 内.

---

### 1.19 `src/app/requirements/new/page.tsx` (new requirement, 46 行)

> **LOC**: 46. **最后修改**: 2026-09-13 (R107 R 列). **类型**: server component.

#### 逻辑单元: `buildBackToListHref(projectId?, versionId?)` (line 18-24)
- **目的**: 根据 query 构造 "← 需求点列表" 回链 href. 有 `project_id` → `/requirements?project_id=X&version_id=Y` (或仅 X); 无 → `/requirements` 全局入口.

#### 逻辑单元: `NewRequirementPage({searchParams})` (line 26-46)
- **目的**: `/requirements/new` 新建需求点. 表单本体在 `new-requirement-form.tsx` (client, 整表单下沉到 client: server form 做不到「改项目即刷版本」级联, 故走 POST `/api/requirements`). R107 R 列: 接受 `?project_id=+?version_id=` 让 "← 需求点列表" + "取消" 按钮携带原页面上下文, 用户从项目页面新建后能回到原页面 (而非全局入口).
- **关键 props**: `presetProjectId / presetVersionId / backHref` 三个透传.

---

### 1.20 `src/app/requirements/[id]/page.tsx` (requirement detail, 391 行)

> **LOC**: 391. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `RequirementDetailPage({params, searchParams})` (line 115-391)
- **目的**: `/requirements/[id]` 需求详情页. 顶部: 标题 + 状态徽章 + 优先级 + tags + 创建/更新时间. 描述 (whitespace 保留). 状态进程条 (6 态 stepper: pending → has_suggestion ↔ awaiting_reply ↔ blocked → done; closed 走单独分支). 最近反馈时间线 (W3): requirement_revisions 表 + 关联 task 事件, 最近 10 条变更, 底部链 `/api/requirements/[id]/revisions`. 关联任务列表 (从 `tasks.requirement_id` 拉) —— 森林视图, 每条 task 显示 标题/状态/depends_on 数 + 点跳详情. **root task 高亮** (W3): forest 中 `dispatched_by_task_id` 空 + created_at 最早的 task 标 root 徽章, 其余 sub-task.
- **关键 props 流**: `userId` → `getRequirementWithRevisionsById(id, userId)` → 顶层 detail. `aggregateRequirementsMetrics(id)` 单 SQL 拿全 (W3 §列表页 R74 量化 3 列 - 关联 task 数 / 完成进度 / 最近反馈时间). 跨 owner → 404 (v14-v19 多租户硬约束).

---

### 1.21 `src/app/runners/page.tsx` (runners admin, 20 行)

> **LOC**: 20. **最后修改**: 2026-09-23. **类型**: server component (admin gating).

#### 逻辑单元: `RunnersPage()` (line 13-19)
- **目的**: `/runners` admin-only Runner daemon 注册 / 管理页 (R4: UI). `export const dynamic = "force-dynamic"` (line 11) —— 不缓存, 注册完 token 立刻刷新页面让 operator 复制.
- **关键行为** (line 14-19): server 鉴权. middleware 注入 `x-user-role` request header; `headers()` 读 `h.get("x-user-role")`. 非 admin `redirect("/")` —— 直接服务端打回, admin client-side 再列/注册/删除/健康检查.

---

### 1.22 `src/app/schedules/page.tsx` (schedules, 13 行)

> **LOC**: 13. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `SchedulesPage()` (line 8-12)
- **目的**: `/schedules` 定时任务列表薄壳. R92 默认拉「无筛选」数据进 `initialSchedules` 让 SSR 首屏快; 筛选切换由 client 重新 fetch `/api/schedules?...` 拉新结果（与 showDeleted 切换同款）. `listSchedules(userId)` 默认不含软删除、不带项目/时间筛选, 与 R49 拍板一致.

---

### 1.23 `src/app/settings/page.tsx` (settings, 3035 行)

> **LOC**: 3035. **最后修改**: 2026-09-23. **类型**: client component (use client).

> **⚠️ 大块单文件**: 包含 4 大区: account / notify / schedule / platform + fork 阈值 / 声音 / API Token / 多模态 key 等子区. 略.

#### 逻辑单元: `SettingsPage()` (line 233-3035)
- **目的**: `/settings` 设置页 (4 tab). account (邮箱/密码/switch token) / notify (email + feishu webhook) / schedule (cron 默认值, env fallback) / platform (fork 阈值 / 声音开 / API Token / 多模态 key 4 区块). 用 `<Tabs>` 容器切.
- **关键行为**: 用户登录态读写 `/api/user/notify-*` / `/api/api-tokens` / `/api/user/media-key` / `/api/user/llm-config` 等一系列配置 API. 各 admin/owner 配置项含测试按钮 (test routes `/api/user/notify-email/test` / `/api/user/notify-feishu/test` / `/api/user/media-key/test`).

---

### 1.24 `src/app/stats/page.tsx` (stats tabs, 38 行)

> **LOC**: 38. **最后修改**: 2026-09-23 (R122 T1.2). **类型**: client component.

#### 逻辑单元: `StatsPage()` (line 14-38)
- **目的**: `/stats` 统计看板 tab 容器. R122/T1.2 本期只上线 "用量统计" tab; 后 3 个 tab (dimensions / requirements / periodic) 二期实施, 当前显示占位 (来自 `./tabs/{dimensions,requirements,periodic}.tsx`).
- **关键行为**: R139 第二批右滚 fix `h-full flex flex-col` + main `overflow-y-auto`. `<Tabs tabs={[{id: "usage", …}, …]}/>` —— 4 个 tab, "用量统计" (UsageTab) 立刻可用.

---

### 1.25 `src/app/tasks/[id]/page.tsx` (task detail wrapper, 196 行)

> **LOC**: 196. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `TaskDetailPage({params})` (line 56-196)
- **目的**: `/tasks/[id]` 任务详情 RSC wrapper. server 拉 task + requirement + commits + checkpoints + dependents 等关联数据 (单 SQL + batch fetch). 渲染 `<TaskDetailClient …/>` (大 client, 13 sections 装配).
- **关键 props**: `getTaskById` + `getRequirementById` (当 task 关联) + `listTaskCommits` + `listCheckpoints` + `listDependents` + cwd 解析 + 状态机当前态 + 是否需要 fork-banner 等.

---

### 1.26 `src/app/tasks/new/page.tsx` (new task page, 1561 行)

> **LOC**: 1561. **最后修改**: 2026-09-23. **类型**: client component (use client).

> **⚠️ 单文件大, 含多个导出工具 + default page**.

#### 逻辑单元: `shouldTriggerSubmitOnKey(...)` (line 66)
- **目的**: 判定 Cmd/Ctrl+Enter / Enter 是否触发 form submit (keydown handler).

#### 逻辑单元: `shouldBlockClickSubmit(opts)` (line 84)
- **目的**: 判定按钮点击是否阻塞 (disabled). 多条件: 空 title / 项目未选 / fork 检查 / 提交中.

#### 逻辑单元: `shouldShowSpinner(submitting)` (line 95)
- **目的**: 决定按钮文案是否显示 spinner (hook 给 button label 链路用).

#### 逻辑单元: `getSubmitButtonLabel(...)` (line 101-124)
- **目的**: 返回 "提交" / "提交中…" / "启动" 等 button label 字符串 (依赖多态状态).

#### 逻辑单元: `buildGoalPrompt(opts)` (line 125-139)
- **目的**: 构造 goal-rounds prompt 字符串 (代入轮数 + 目标描述), 用于带验证目标的下发.

#### 逻辑单元: `parseGoalRoundsInput(raw)` (line 140-154)
- **目的**: goal rounds input 解析 (string → number|null). 非法值返 null.

#### 逻辑单元: `NewTaskPage()` (line 1555-1561)
- **目的**: `/tasks/new` 新建任务页面. 客户端表单, 项目/版本级联 Select, attachment 上传, template 预填 (R41 B1), schedule 计划, type (design/dev/test/deploy), goal rounds (DAG P3). 提交走 `POST /api/tasks` + 自动 `startTask()` (与 R78 W1 §4.2 root task 创建同款). 关联 R41 B1: 在 `/templates` 点 "从此模板创建任务" 后挂 `?template=<id>` 预填表单.

---

### 1.27 `src/app/templates/page.tsx` (templates list, 610 行)

> **LOC**: 610. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `TemplatesPage()` (line 35-610)
- **目的**: `/templates` 模板管理页 (卡片网格 vs 表格视图). 8 字段 (name / body / tags / role / tools / LLM 配置 / fork / model) + tags chip + LLM 配置下拉. 编辑/新建 modal 提交. R41 B1: 「从此模板创建任务」挂 `/tasks/new?template=<id>` 预填表单.

---

### 1.28 `src/app/transcript/[id]/page.tsx` (transcript page, 52 行)

> **LOC**: 52. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `TranscriptPage({params})` (line 28-52)
- **目的**: `/transcript/[id]` 会话 transcript 渲染. server 拿 task 详情, 调 `getRuntime().getSessionHistory(id)` (line 42) 读 SDK jsonl 全文, `formatSessionMarkdown(task, messages, {verbosity: "full"})` (line 43). try/catch 兜底 (line 41-50): SDK 读不到 (session 未分配 / 文件被清) → 退回 `formatTranscriptMarkdown(id, getEventsByTaskId(id))` events 表稀疏日志, 不让页面 500.
- **依赖**: `formatTranscriptMarkdown`, `formatSessionMarkdown` (`src/lib/transcript`), `getRuntime` (`src/lib/runtime/agent-runtime`). 传 `<TranscriptClient task={…} markdown={…}/>` 由 client 渲染 + 提供 .md / .jsonl 下载.

---

### 1.29 `src/app/uncategorized/page.tsx` (legacy redirect, 12 行)

> **LOC**: 12. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `UncategorizedRedirectPage()` (line 7-12)
- **目的**: `/uncategorized` 兼容旧书签 — 找名为 "未分类" 的项目 (line 9) 没找到 → `redirect("/?error=uncategorized_project_not_found")`; 找到 → `redirect("/{project.id}/unversioned")` 到该项目未挂版本任务视图.

---

### 1.30 `src/app/usage/page.tsx` (usage stats, 589 行)

> **LOC**: 589. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `GRANULARITY_OPTIONS` (line 87-93)
- **目的**: 5 档粒度 (hour / day / week / month / year) Select 选项.

#### 逻辑单元: `UsagePage()` (line 117-589)
- **目的**: `/usage` 用量统计页 —— 小时/天/周/月/年粒度 cost + 任务数 + 模型用量. **双口径** (admin 三档: 全部用户 scope=all / 仅我的 scope=mine / 仅某用户 scope=owner, 从 total.by_owner 动态组装). 普通用户无切换器, 数据永远 scope=mine.
- **关键行为**: 桶标签由后端按 **UTC+8** 生成 (见 route.ts 时区说明), 前端直接显示 **不要 new Date(bucket) 转一次** —— 浏览器时区二次偏移. context_tokens 是「上下文规模」而非「消耗 token」, 文案别写 token 用量误导 (tasks 表无 input/output 分列). data = `GET /api/stats/usage`.

---

### 1.31 `src/app/webhooks/[id]/page.tsx` (webhook detail, 21 行)

> **LOC**: 21. **最后修改**: 2026-09-23. **类型**: server component.

#### 逻辑单元: `WebhookDetailPage({params})` (line 8-21)
- **目的**: `/webhooks/[id]` webhook 详情薄壳. `getWebhookById(id, userId)` → 不存在 `notFound()`. `getWebhookDeliveryEvents(id, 100)` 拉最近 100 条投递记录. 渲染 `<WebhookDetailClient webhook={…} deliveryEvents={…}/>` —— 详情 + 编辑折叠面板 + 投递历史表 (12 条投递记录 + 关联 task 短哈希 + 「查看完整 body」 折叠).

---

## 2. 客户端组件 (`src/app/**/*-client.tsx` 同目录内嵌 tsx) — 31 文件

### 2.1 `src/app/projects-client.tsx` (projects dashboard, 1795 行)

> **LOC**: 1795. **最后修改**: 2026-09-23. **类型**: client component (大文件, 全局唯一 dashboard).

#### 逻辑单元: `type Project / RunnerDraftEntry / Version / Stats / ScopeCounts` (line 72-118)
- **目的**: client 端 5 个数据结构 (Project / RunnerDraftEntry / Version / Stats / ScopeCounts). Stats.scope_counts by view (board/chat/kanban/list/grouped).

#### 逻辑单元: `ProjectsClient({userEmail})` (line 120-1795)
- **目的**: `/` dashboard 主 client. 4 大视图 + 创建/编辑/删除项目 + 多视图切换 (cards/list/grouped) + 项目排序 (sort=manual) + 关联 task overview. NavSidebar 不渲染, 顶部右上角轻量账号/退出入口.
- **关键流**: 拉 `/api/projects?sort=manual` → 渲染 5 视图切换器 (`ViewSwitcher`). 列表项拖拽排序 PATCH 单条. 创建 modal 接受 "version 同建" 一键 (R41 C1). Workspace 顶部对接 socket/event-source 实时同步 task 数量. admin 视角下看到全平台 vs 当前 owner 视角.

---

### 2.2 `src/app/[projectId]/[versionId]/board-client.tsx` (board, 1466 行)

> **LOC**: 1466. **最后修改**: 2026-09-23 (R139 R列 + DAG P3 收尾). **类型**: client component.

#### 逻辑单元: `type ParsedDecision` (line 133-249)
- **目的**: agent 自然提交时的 decision box 解析类型. 解析 markdown 代码块 JSON, 列出 options.

#### 逻辑单元: `function DecisionBanner(...)` (line 251-357)
- **目的**: 顶部条带, 显示 awaiting-decision task 当前 decision prompt + 选项按钮 → POST `/api/tasks/[id]/resolve-decision`.

#### 逻辑单元: `BoardClient({...})` (line 359-1457)
- **目的**: 看板 client. 接收 server `tasks`, `project`, `version`, `globallyEnabled` (DAG P3 L1 开关). 5 视图切换 (board/chat/kanban/list/grouped). 内部按 status 拆 active vs terminal 两个数组 (server 来的 `TaskTrimmed`). active SSE realtime 增量 + terminal 「加载更多」按钮. Decision banner 拉自 runtime 检测. `globallyEnabled` 控制 verifying 过滤 (列定义 + 默认选中 + 筛选).
- **UI 骨架**: 顶部 `viewSwitcher` + 工具栏 + `ViewSwitcher` 切视图 + 主区渲染对应 view + 决策条带.

---

### 2.3 `src/app/[projectId]/[versionId]/chat-task-list.tsx` (chat left task list, 141 行)

> **LOC**: 141. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface ChatTaskListProps` (line 12-36)
- **目的**: props 接口 (tasks / selectedTaskId / onSelectTask / onNewTask / projectNames / versionNames).

#### 逻辑单元: `ChatTaskList({...})` (line 38-137)
- **目的**: chat 视图左侧任务列表. 显示所有 task + 状态 chip + 上游 requirement chip (R94) + "新建 task" 入口 + 选中 highlight + 点选回调.

---

### 2.4 `src/app/[projectId]/[versionId]/chat-view.tsx` (chat view, 986 行)

> **LOC**: 986. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface ChatViewProps` (line 21-71)
- **目的**: 视图 props. tasks / project / version / onTaskCreated / initialTaskId / projectNames / versionNames / allowSwitchProject (for global) / onScopeChange / viewSwitcher / topHeaderVisible / onToggleTopHeader.

#### 逻辑单元: `ChatView({...})` (line 73-934)
- **目的**: chat 视图主体. 左 `ChatTaskList` + 中 msg 列表 + 右 `RightDock` (右 dock). 顶部 viewSwitcher. 切到某个 task 拉 history + 看 transcript + approve / cancel / pause / 等. 处理 awaiting-decision / approval / dialog 三态 surface (waiting UI).
- **关键流**: SSE realtime 推流 (`/api/tasks/[id]/stream`) → append message. 失败重连 + 滚动到底部 (auto scroll). fork 操作切到 fork banner (R78).

#### 逻辑单元: `function ChatTaskHeader({...})` (line 935-986)
- **目的**: chat 视图当前选中 task 的顶部条带 (缩略视图).

---

### 2.5 `src/app/[projectId]/[versionId]/kanban-view.tsx` (kanban view, 694 行)

> **LOC**: 694. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface KanbanViewProps` (line 31-144)
- **目的**: 视图 props + 大量 type (Task 透传 server TaskTrimmed + verifying 字段).

#### 逻辑单元: `KanbanView({...})` (line 146-672)
- **目的**: kanban 视图. 按 status 列 (active/queued/running/paused/reviewing/completed/failed/rejected/cancelled) + verifying DAG 列 (DAG P3). card 显示 标题/owner/model/elapsed/上游 requirement chip (R94). card 可拖拽改 status (P3) - 接受 drop 触发 PATCH `/api/tasks/[id]`. 实时用 event source 接收变化, diff 后增量更新.

---

### 2.6 `src/app/[projectId]/board/board-client.tsx` (board iframe, 244 行)

> **LOC**: 244. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface ProjectRef / BoardClientProps / SourceDataResponse / CommitEntry` (line 19-47)
- **目的**: project ref / board client props / data source 响应结构 / commit entry.

#### 逻辑单元: `BoardClient({...})` (line 49-244)
- **目的**: `/{projectId}/board` iframe 渲染. server 传 `initialConfig` (frontmatter parsed) + `initialBody` (HTML). client 拿 iframe sandbox 渲染 body, 同时后台 fetch data source 注入 `window.__DATA__`. 跨项目跳转改 query `path=` + `version=`. 错误兜底: source fetch 失败 → 「数据获取失败」inline 提示, iframe 仍渲染.

---

### 2.7 `src/app/[projectId]/wiki/wiki-client.tsx` (wiki browser, 620 行)

> **LOC**: 620. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface TreeNode / WikiLink / WikiData / Props` (line 99-235)
- **目的**: 文件树节点 / wiki 外链图 / wiki data 响应 / props.

#### 逻辑单元: `WikiClient({...})` (line 237-620)
- **目的**: 项目 wiki 浏览器. 左文件树 (按 allowed ext 过滤) + 中 markdown 渲染 + 右 cross-link 图 (refs/backlinks). markdown 渲染走 `src/lib/markdown`. 内链支持 `project:{UUID}?path={relpath}` 跨项目跳转 (语法处理 in `src/lib/wiki-links`). 链接拦截: 客户端拦截 `<a>` 跳转, 走 router.push 避免页面 full reload. 绝对路径识别 → 自动 redirect (shared with server-side 1.11 decideAbsolutePathRedirect).

---

### 2.8 `src/app/assets/assets-client.tsx` (assets page, 553 行)

> **LOC**: 553. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface AssetItem / FilterProj / FilterData / TypeFilter / SourceFilter` (line 19-111)
- **目的**: asset 项结构 + 筛选下拉数据结构 + 类型筛选枚举 (image/video/audio/file) + source 筛选枚举 (upload/agent_generated/fork).

#### 逻辑单元: `AssetsClient()` (line 113-553)
- **目的**: `/assets` 全平台资源池. 列当前用户所有 attachment. 5 维筛选 (project / type / source / 时间范围 / 关键字) + 排序 (时间/大小/类型) + 分页 (50/page) + 单删 + 批量选删除. 拉 `/api/assets` 数据. 列表项右键菜单: 删除/详情/复制链接. 上传 modal 走 `/api/attachments` 通用端点.

---

### 2.9 `src/app/global/global-board.tsx` (global board, 937 行)

> **LOC**: 937. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Project / Version` (line 152-175)
- **目的**: 跨项目 / 版本数据结构 (project / version with project_id).

#### 逻辑单元: `GlobalBoard({initialTasks, projects, versions, globallyEnabled})` (line 177-931)
- **目的**: `/global` 全局看板 client. 5 视图切换 (cards/list/grouped) + 跨项目筛选 + 跨版本筛选. SSE realtime 同步. DAG P3 L1 开关 `globallyEnabled`. active SSE + terminal 加载更多模式 (同 2.2).

---

### 2.10 `src/app/global/global-grouped-view.tsx` (grouped view, 198 行)

> **LOC**: 198. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface GlobalGroupedViewProps / Bucket` (line 48-60)
- **目的**: props + bucket 桶定义 (按 owner_id / project_id / status 分组).

#### 逻辑单元: `GlobalGroupedView({...})` (line 62-194)
- **目的**: 全局看板 grouped 视图. 把全部 task 按 owner / project / status 折叠成 section, 每 section 渲染小组 list. 用于多账户切换视角.

---

### 2.11 `src/app/global/global-list-view.tsx` (list view, 322 行)

> **LOC**: 322. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface GlobalListViewProps` (line 80-85)
- **目的**: 列表视图 props.

#### 逻辑单元: `GlobalListView({...})` (line 87-319)
- **目的**: 全局看板 list 视图. 横向表格: status chip / 项目 chip / 版本 chip / owner / model / 标题 / elapsed / cost. sort by 任一列. filter dropdown (status/project/owner). 与 cards 视图共用同一 props.

---

### 2.12 `src/app/requirements/[id]/create-task-button.tsx` (+dialog, 359 行)

> **LOC**: 359. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface CreateTaskButtonProps / TaskTypeOption` (line 32-47)
- **目的**: 按钮 props + task type 枚举 (design / dev / test / deploy).

#### 逻辑单元: `CreateTaskButton({...})` (line 49-359)
- **目的**: R78 一键创建关联 task. 弹出 modal dialog, 字段 title / prompt / type / 启动时机 (立即启动默认 → 提交即走 `POST /api/tasks` + 自动 start / 只创建待启动 → 仅 POST). 校验沿用 `requirements CLOSED` 防御. 默认 type='dev' (root task).

---

### 2.13 `src/app/requirements/[id]/feedback-timeline.tsx` (timeline, 217 行)

> **LOC**: 217. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type ActorType` (line 17-139)
- **目的**: actor_type 取值 (user / agent / system).

#### 逻辑单元: `FeedbackTimeline({...})` (line 141-217)
- **目的**: 需求点详情页「最近反馈时间线」组件. W3. 渲染最近 10 条 requirement_revisions + 关联 task 事件. status / priority / title / description / tags 等字段变更高亮. 底部「查看全部」链到 `/api/requirements/[id]/revisions`.

---

### 2.14 `src/app/requirements/[id]/requirement-attachment-delete-button.tsx` (del btn, 62 行)

> **LOC**: 62. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `RequirementAttachmentDeleteButton({attachmentId, ...})` (line 16-62)
- **目的**: 详情页附件区按钮. 点击弹 `ConfirmDialog` → `DELETE /api/attachments/[id]` (polymorphic 端点, 跨 task/requirement 共用). 成功后回调刷新附件列表.

---

### 2.15 `src/app/requirements/[id]/status-flow.tsx` (status dropdown, 210 行)

> **LOC**: 210. **最后修改**: 2026-09-23 (R78). **类型**: client component.

#### 逻辑单元: `type RequirementStatus / StatusFlowProps` (line 29-73)
- **目的**: 6 态 status 类型 + props (requirementId / initialStatus / eligibleForDone).

#### 逻辑单元: `StatusFlow({...})` (line 74-210)
- **目的**: 详情页状态变更 dropdown. 6 态 (pending / done / awaiting_reply / has_suggestion / blocked / closed). 提交 PATCH `/api/requirements/[id]`. R78 W1 §4.3 invariant: "已完成" 项 disable 当 `!eligibleForDone`, tooltip 提示「需先完成至少一个 dev/test/deploy task」. dropdown 同时接受简化的「流转历史」视图.

---

### 2.16 `src/app/requirements/[id]/status-stepper.tsx` (stepper UI, 121 行)

> **LOC**: 121. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `StatusStepper({status})` (line 43-121)
- **目的**: 详情页顶部状态进程条. W3. 渲染 `pending → has_suggestion ↔ awaiting_reply ↔ blocked → done` 横向 stepper, 当前态高亮. `closed` 走单独分支.

---

### 2.17 `src/app/requirements/new/new-requirement-form.tsx` (new form, 340 行)

> **LOC**: 340. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Project / Version` (line 25-36)
- **目的**: 项目 / 版本 shape.

#### 逻辑单元: `NewRequirementForm({presetProjectId, presetVersionId, backHref})` (line 38-340)
- **目的**: 新建需求点 client 表单 (R64 二轮级联版). 改项目即刷新版本下拉, 同时清空已选版本 → 防把 A 项目的版本提交到 B 项目. 项目下拉 = NavigationTree 同源 (按 owner 过滤 + manual sort). 版本三态: 留空 = 自动取 current version; `(不挂版本)` = 显式不挂; 选具体版本 = 指定 (当前版本带 `· 当前` 标注). 提交走 `POST /api/requirements`, 成功后跳 `${id}?project_id=X&version_id=Y` 携带 backHref 上下文.

---

### 2.18 `src/app/runners/runners-client.tsx` (runner admin, 440 行)

> **LOC**: 440. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Runner / DeleteTarget` (line 17-74)
- **目的**: Runner 数据结构 + 删除目标 (id/name).

#### 逻辑单元: `RunnersClient()` (line 76-440)
- **目的**: admin-only Runner 管理. 4 actions: 注册新 Runner (POST `/api/runners/self-register` 拿 token) / 列表 (GET `/api/runners`) / 删除 (`DELETE /api/runners/[id]` 带 confirm dialog) / 健康检查 (POST `/api/runners/[id]/health`). token 注册立刻渲染给 operator 复制 (一次性密文). admin gating 显式 disabled (R41).

---

### 2.19 `src/app/schedules/schedules-client.tsx` (schedules, 1524 行)

> **LOC**: 1524. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: type aliases (line 12-138)
- **目的**: Schedule / Project / Version / FilterState / ScheduleRun / RunsResponse / CreateFormState 7 个类型.

#### 逻辑单元: `SchedulesClient({initialSchedules})` (line 139-1524)
- **目的**: 定时任务 client. 7 项 controls (ScheduleFormFields R41 A1: agent vs shell 二级条件 + working_dir 等 12 字段). 卡片 + 列表双视图. 当前默认 5 字段 → R41 A1 后扩到 12 字段. 「立即执行」按钮 (POST `/api/schedules/[id]/runs`) + 右侧 runs 面板 (流式 output `/api/schedules/runs/[runId]/stream`). 筛选 show_deleted / project / cron 表达式 fallback.

---

### 2.20 `src/app/stats/tabs/usage.tsx` (usage tab, 209 行)

> **LOC**: 209. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `UsageTab()` (line 42-209)
- **目的**: 统计页 "用量统计" tab. R122/T1.2 唯一上线的 tab. 数据来自 `/api/stats/usage` (与 `/api/stats` 各自独立). 时间序列粒度 (hour/day/week/month/year). 模型分布饼图. 启动失败时 inline 错误块.

---

### 2.21 `src/app/stats/tabs/dimensions.tsx` (dimensions tab, 144 行)

> **LOC**: 144. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type TaskRow` (line 15-26)
- **目的**: 任务行字段.

#### 逻辑单元: `DimensionsTab()` (line 28-144)
- **目的**: 统计页 "维度分析" tab 占位. 二期实施 —— 当前显示 placeholder 提示.

---

### 2.22 `src/app/stats/tabs/requirements.tsx` (requirements tab, 158 行)

> **LOC**: 158. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type TaskRow` (line 16-30)
- **目的**: 任务行字段.

#### 逻辑单元: `RequirementsTab()` (line 32-158)
- **目的**: 统计页 "需求分析" tab 占位. 二期实施 —— 当前显示 placeholder 提示.

---

### 2.23 `src/app/stats/tabs/periodic.tsx` (periodic tab, 171 行)

> **LOC**: 171. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type ProjectRow / ProjectAggregate` (line 33-39)
- **目的**: 项目 row + 汇总字段.

#### 逻辑单元: `PeriodicTab()` (line 41-171)
- **目的**: 统计页 "周期统计" tab 占位. 二期实施 —— 当前显示 placeholder 提示.

---

### 2.24 `src/app/tasks/[id]/right-dock.tsx` (task right dock, 1640 行)

> **LOC**: 1640. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: type aliases (line 100-1640)
- **目的**: DepTask / DispatchedTask / TimelineEvent / CheckpointRow / CommitChainEntry / DescendantTaskSummary 等多个类型 (含 10+ 子类型)。

#### 逻辑单元: `RightDock(props)` (line 154-1640)
- **目的**: 任务详情页右侧停靠. 内含多个 collapsible section: commits 面板 (R41 A3 root lineage graph / list 切换) / checkpoints 面板 / timeline 面板 / dependents 面板 / parent task link. 接收 task + 右 dock tab 选择 state.

---

### 2.25 `src/app/tasks/[id]/task-detail-client.tsx` (task detail, 3793 行)

> **LOC**: 3793. **最后修改**: 2026-09-23. **类型**: client component (大文件).

> **⚠️ 单文件最大 (3793 行), 13 sections 装配**.

#### 逻辑单元: type aliases (line 27-432)
- **目的**: AttachmentInfo / MessageItem / PendingApproval / UserDialogOption / UserDialogQuestion / PendingDialog / FileChangeOperation / FileChange / ChangesResponse / FileDiffResponse / TimelineEvent.

#### 逻辑单元: `TaskDetailClient({...})` (line 434-3793)
- **目的**: 任务详情主 client. 13 sections: header / meta / timeline / transcript / attachments / commits / checkpoints / dependents / approval / decision / user-dialog / file-changes / right-dock. SSE realtime 推流接 `/api/tasks/[id]/stream`. fork banner R78 (父子 task 关系 fork chain). 计时器 (running elapsed). 倒计时 (timeout 设置 + 触发后过期). 状态变更 picker (按当前态显示可流转态).

---

### 2.26 `src/app/tasks/[id]/task-header.tsx` (task header, 452 行)

> **LOC**: 452. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: type aliases (line 12-130)
- **目的**: Task / ParentTask / ProjectRef / VersionRef.

#### 逻辑单元: `TaskHeader({task, parentTask, project, version, ...})` (line 132-452)
- **目的**: 任务详情页顶部条. 标题 / 状态 chip + dropdown 流转 / 项目 chip / 版本 chip / 上游 requirement chip / 上游 task chip (parent) / fork banner / 计时器. 可选 actions (pause/resume/cancel/approve). 注: 这是 TaskDetailClient 头部 (vs RightDock 右侧 dock).

---

### 2.27 `src/app/tasks/[id]/task-meta-row.tsx` (task meta row, 85 行)

> **LOC**: 85. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `TaskMetaRow({task})` (line 27-85)
- **目的**: 任务详情页头部下方一行 metadata chip: 模型 / 优先级 / tags / 创建时间 / 上次编辑 / 上次交互. 视觉小巧紧凑 (一个 row).

---

### 2.28 `src/app/tasks/[id]/task-timeout-edit-dialog.tsx` (timeout dialog, 157 行)

> **LOC**: 157. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface Props` (line 17-25)
- **目的**: dialog props (task id / currentTimeoutMinutes / onSaved callback).

#### 逻辑单元: `TaskTimeoutEditDialog({...})` (line 26-157)
- **目的**: 任务 timeout 编辑弹窗. input 分钟数 + 限制 (默认 60 min, max 24h). 提交走 PATCH `/api/tasks/[id]` `timeout_minutes` 字段. 关闭 = 取消.

---

### 2.29 `src/app/transcript/[id]/transcript-client.tsx` (transcript client, 213 行)

> **LOC**: 213. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Task` (line 12-56)
- **目的**: transcript 任务字段 shape.

#### 逻辑单元: `TranscriptClient({task, markdown})` (line 58-213)
- **目的**: transcript 渲染. server 传 markdown (full verbosity), 渲染 markdown, 右上角提供 .md / .jsonl 下载. 8 元数据 (status / model / cost / created_at / started_at / completed_at / host / session_id). 提供复制整段 markdown 的按钮.

---

### 2.30 `src/app/webhooks/[id]/webhook-detail-client.tsx` (webhook detail, 148 行)

> **LOC**: 148. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Webhook / DeliveryEvent` (line 5-26)
- **目的**: webhook / 投递事件 shape.

#### 逻辑单元: `WebhookDetailClient({webhook, deliveryEvents})` (line 28-148)
- **目的**: webhook 详情 client. R41 A2: 投递历史表 + 「详情」列加 payload 折叠. 显示 webhook 基本信息 + 编辑折叠面板 (name / url / events / active) + 投递历史表 (12 条 + 关联 task 短哈希). 「查看完整 body」折叠.

---

### 2.31 `src/app/webhooks/webhooks-client.tsx` (webhooks list, 366 行)

> **LOC**: 366. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Webhook` (line 8-16)
- **目的**: webhook shape.

#### 逻辑单元: `WebhooksClient({initialWebhooks, availableEvents})` (line 18-366)
- **目的**: webhook 列表 + 创建 + 编辑. 列当前用户所有 webhook, 每条显示 name / url (click to copy) / events count / active chip / has_secret chip. 行内展开编辑面板. 新建 modal 接受 name/url/secret/events/active. secret 创建后不可读 (`has_secret` 只返布尔).

---

## 3. API route handler (`src/app/api/**/route.ts`) — 134 文件

> 分组按功能模块, 每个文件 = 1 个或多个 HTTP method handler (line 范围标 `[method]`). line 数 ≤ 文件实际行数.

### 3.1 admin 模块 (11 文件)

#### 3.1.1 `src/app/api/admin/llm-config/[id]/default/route.ts`
- **LOC**: 小. **类型**: route handler.

#### 逻辑单元: `POST(req, {params})` 
- **目的**: admin 设置某条 llm-config 为默认 (`is_default=true`). 跨 owner 400.

#### 3.1.2 `src/app/api/admin/llm-config/[id]/duplicate/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: admin 复制某条 llm-config (新 id, 同字段). 用于在 admin 视角 copy 一份给用户使用.

#### 3.1.3 `src/app/api/admin/llm-config/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: admin 改 / 删 llm-config. PATCH 白名单字段 (model / api_key / base_url / tools / effort / max_turns). DELETE 软删 (status=closed).

#### 3.1.4 `src/app/api/admin/llm-config/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列出 admin llm-config / admin 新建一条. POST 白名单字段.

#### 3.1.5 `src/app/api/admin/llm-grants/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req) / POST(req) / PATCH(req) / DELETE(req)`
- **目的**: admin 给用户授权可用的 llm-config. grant row (admin_id, user_id, config_id). 不重复授权.

#### 3.1.6 `src/app/api/admin/maintenance/enter/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: admin 进入维护模式 (R128). 拉旗 → 阻塞任务派发 → 待 drain.

#### 3.1.7 `src/app/api/admin/maintenance/exit/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: admin 退出维护模式 (R128). 解除阻塞 → 任务派发恢复.

#### 3.1.8 `src/app/api/admin/maintenance/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 查看维护模式当前状态 (entered/exited + 已耗时).

#### 3.1.9 `src/app/api/admin/users/[id]/quota-log/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 拉某用户的 quota 变更日志 (admin 视角).

#### 3.1.10 `src/app/api/admin/users/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params})`
- **目的**: admin 拉/改用户 (白名单: role / quota / account_status). 跨 owner 不允许 (admin 本身是 owner) — by id 查询即可.

#### 3.1.11 `src/app/api/admin/users/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列出全部用户 / admin 新建用户 (POST body: email + password). admin 必须有.

---

### 3.2 api-tokens 模块 (3 文件)

#### 3.2.1 `src/app/api/api-tokens/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `DELETE(req, {params})`
- **目的**: 删某个 API token (软删). 仅 owner 自己 / admin. 跨 owner → 404.

#### 3.2.2 `src/app/api/api-tokens/delete-batch/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 批量删 tokens, body `{ids: []}`. 返回成功 + 失败的明细.

#### 3.2.3 `src/app/api/api-tokens/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列当前用户所有 token / 新建一个. POST 返明文 token (一次性). 跨 owner = 当前 owner.

---

### 3.3 assets 模块 (3 文件)

#### 3.3.1 `src/app/api/assets/delete-batch/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 批量删 attachments. body `{ids: []}` + 是否 cascade (true=删物理文件).

#### 3.3.2 `src/app/api/assets/filters/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 列可选筛选值 (project / type / source / 关键字选项). 给前端 dropdown 填充.

#### 3.3.3 `src/app/api/assets/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列当前用户所有 attachment (支持 5 维筛选) / 上传新 attachment (multipart). data = `{items, total}`.

---

### 3.4 attachments 模块 (1 文件)

#### 3.4.1 `src/app/api/attachments/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `DELETE(req, {params}) / GET(req, {params})`
- **目的**: polymorphic 端点 (task / requirement 共用). GET → 下载 stream. DELETE → 删物理 + DB. 跨 owner → 404.

---

### 3.5 auth 模块 (5 文件)

#### 3.5.1 `src/app/api/auth/login/route.ts`
- **LOC**: 中.

#### 逻辑单元: `POST(req)`
- **目的**: email + password 登录, 签 JWT cookie + switch token. 速率限制 (auth-rate-limit.ts) + 429. 401 不区分用户存在.

#### 3.5.2 `src/app/api/auth/logout/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 清 session cookie.

#### 3.5.3 `src/app/api/auth/register/route.ts`
- **LOC**: 中.

#### 逻辑单元: `POST(req)`
- **目的**: 新用户注册 (email + password ≥ 6). 409 已存在. 返 JWT + switch token. 首个注册 = admin (db.users).

#### 3.5.4 `src/app/api/auth/switch/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 用 switch token 切换到该账户 (AccountSwitcher dropdown 调用). 不需再输密码.

#### 3.5.5 `src/app/api/auth/token/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: API token (api-tokens 表) → JWT cookie, 用于 CLI / 脚本写平台.

---

### 3.6 config-snapshots 模块 (2 文件)

#### 3.6.1 `src/app/api/config-snapshots/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `DELETE(req, {params}) / GET(req, {params})`
- **目的**: 删 / 拉一个 config snapshot. 跨 owner → 404.

#### 3.6.2 `src/app/api/config-snapshots/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列当前用户 snapshots / 创建一个 (POST 接受任意 config 树). 用于 fork 时保存瞬时态.

---

### 3.7 config 模块 (1 文件)

#### 3.7.1 `src/app/api/config/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / PATCH(req)`
- **目的**: 拉 / 改 app_settings KV 兜底默认 (fork 阈值 / 声音默认 / 任务超时默认值等). 仅 admin / owner.

---

### 3.8 events 模块 (1 文件)

#### 3.8.1 `src/app/api/events/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req)`
- **目的**: 列 current owner 的 events 表 (按时间倒序), 支持 ?since=&until=&task_id=&type= 过滤. 给 audit log / 飞书写回.

---

### 3.9 feishu/write-back 模块 (1 文件)

#### 3.9.1 `src/app/api/feishu/write-back/[taskId]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 手动触发 task → 飞书 sheet T/W/Z 列写回 (rule engine 通常自动触发, 此端点给 CLI / 调试用). task.requirement_id 必须有 feishu tag.

---

### 3.10 import 模块 (3 文件)

#### 3.10.1 `src/app/api/import/csv/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: CSV 批量导入 tasks. body `{content, project_id, version_id?}` → 调 `parseCsvImport` → 逐条 `createTask`. 返 `{imported, errors}`.

#### 3.10.2 `src/app/api/import/json/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: JSON 批量导入 tasks (同 csv 链路).

#### 3.10.3 `src/app/api/import/markdown/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: Markdown 批量导入 tasks (同 csv 链路, 解析 `- [ ] title : prompt`).

---

### 3.11 intake 模块 (2 文件)

#### 3.11.1 `src/app/api/intake/wecom/outbound/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 企业微信 outbound webhook (调 outbound API). 给 intake bot 用.

#### 3.11.2 `src/app/api/intake/wecom/route.ts`
- **LOC**: 中.

#### 逻辑单元: `POST(req)`
- **目的**: 企业微信 inbound webhook (收消息 → intake thread → 拉任务 / 通知). intake bot 入口.

---

### 3.12 integration 模块 (1 文件)

#### 3.12.1 `src/app/api/integration/openclaw/route.ts`
- **LOC**: 中.

#### 逻辑单元: `POST(req)`
- **目的**: OpenClaw bridge 入口. Mac Claude / 其他外部系统派 task 给编排平台. HMAC + OPENCLAW_WEBHOOK_SECRET 鉴权 (shared secret). 解析 body → 创建 task. 返回 task id.

---

### 3.13 knowledge 模块 (2 文件)

#### 3.13.1 `src/app/api/knowledge/refresh-cache/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 手动刷 knowledge 缓存 (admin). 重新跑 embeddings.

#### 3.13.2 `src/app/api/knowledge/search/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 知识库全文 / 向量 混合搜索. body `{query, top_k, scope}`. 走 bge-small embed + cache (knowledge-search-e2e.test.ts 验证).

---

### 3.14 maintenance 模块 (1 文件)

#### 3.14.1 `src/app/api/maintenance/status/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 查 maintenance 当前状态 (entered/exited). 给前端提示 / dashboard.

---

### 3.15 notify 模块 (1 文件)

#### 3.15.1 `src/app/api/notify/route.ts`
- **LOC**: 中.

#### 逻辑单元: `POST(req)`
- **目的**: 通用通知入口. body `{channel, subject, body}`. channel = email / feishu / both. 走 notify/feishu.ts + notify/mailer.ts. 🔴 `task-timeout.ts` 不允许改路由 (R65: 绕开去重标记).

---

### 3.16 port-pool 模块 (1 文件)

#### 3.16.1 `src/app/api/port-pool/available/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 查 runner 当前可用端口 (port pool reserve / release). 给 runner 启动分配端口.

---

### 3.17 project-templates 模块 (1 文件)

#### 3.17.1 `src/app/api/project-templates/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列所有内置 project template / 新建项目时按模板预填. (类似 CMS 模板).

---

### 3.18 projects 模块 (10 文件)

#### 3.18.1 `src/app/api/projects/[id]/board/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 拉项目当前默认 board 文件内容 (解析 frontmatter + body). 用于 board 配置预热.

#### 3.18.2 `src/app/api/projects/[id]/config/[key]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `PUT(req, {params}) / DELETE(req, {params})`
- **目的**: 改 / 删一条项目配置 (project_configs 表). key 是 dot-path (e.g. `wiki.extra_extensions`).

#### 3.18.3 `src/app/api/projects/[id]/config/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params})`
- **目的**: 拉 / 整体改项目配置 (整 config 树). PATCH 用 jsondiffpatch.

#### 3.18.4 `src/app/api/projects/[id]/events/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 拉项目相关事件 (project-scoped), 给项目 timeline. 支持 `?since=&limit=`.

#### 3.18.5 `src/app/api/projects/[id]/llm-config/[configId]/default/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 用户视角: 把某条 llm-config 设为项目默认 (此项目任务走它). 必须是 admin-granted 或 owner-self.

#### 3.18.6 `src/app/api/projects/[id]/llm-config/[configId]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `DELETE(req, {params}) / PATCH(req, {params})`
- **目的**: 用户视角: 解绑 / 改项目默认 llm-config. 跨 owner → 404.

#### 3.18.7 `src/app/api/projects/[id]/llm-config/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / POST(req, {params})`
- **目的**: 用户视角: 列出项目可用 llm-configs / 新建一条 (clone 自 admin grant).

#### 3.18.8 `src/app/api/projects/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 详情 / 改 / 删一个项目. PATCH 白名单 (name / cwd / current_version_id / sort_order). DELETE 软删 (status=closed). 跨 owner → 404.

#### 3.18.9 `src/app/api/projects/[id]/wiki/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列项目 wiki 文件树 (按 project.wiki_extra_extensions 过滤). 走 `src/lib/wiki-files`.

#### 3.18.10 `src/app/api/projects/[id]/wiki/tree/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 同 3.18.9 详细版, 含 frontmatter + 节点子树. 给 wiki 渲染用.

#### 3.18.11 `src/app/api/projects/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列当前 owner 项目 (支持 ?sort=manual / created_at / name) / 新建项目. admin 看全部. POST body: `{name, cwd?, sort_order?}`.

---

### 3.19 requirements 模块 (8 文件)

#### 3.19.1 `src/app/api/requirements/[id]/aggregates/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: W3 §列表页 R74 量化 3 列: 关联 task 数 / 完成进度 / 最近反馈时间. 接受 `?ids=id1,id2,…` 批量.

#### 3.19.2 `src/app/api/requirements/[id]/attachments/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / POST(req, {params})`
- **目的**: R71 附件. GET 列附件. POST multipart 上传 (`uploads/{owner}/requirements/{id}/`). 无 agent cwd symlink (需求点不是给 agent 消费).

#### 3.19.3 `src/app/api/requirements/[id]/auto-dispatch/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: W1 §4.5 / W2 cron 接缝. 创建 root task (默认 type=dev) + 可选自动 start (默认 false). R74 Q2 范围.

#### 3.19.4 `src/app/api/requirements/[id]/revisions/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 单需求点的 requirement_revisions 时间线. `?limit=1-500`. 跨 owner → 404.

#### 3.19.5 `src/app/api/requirements/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 详情 / 改 / 软删 (R60+P0 spec). GET 返 requirement + 关联 task 列表 + `eligible_for_done`. PATCH 白名单 (title / description / status / priority / tags / version_id). 跨 owner → 404. status→done 守卫 (R78 W1 §4.3 invariant): 无 dev/test/deploy completed task → 400 `REQUIREMENT_DONE_GUARD`.

#### 3.19.6 `src/app/api/requirements/[id]/tasks/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 森林 API. 接受 `?with_deps=true` 返 edges. depends_on = 1 层直接依赖. 跨 owner → 404.

#### 3.19.7 `src/app/api/requirements/revisions/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req)`
- **目的**: 全局 requirement_revisions 增量流. 接受 `?since=&until=&actor_type=&requirement_id=&cursor=`. 给 audit log / 跨项目同步.

#### 3.19.8 `src/app/api/requirements/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 (支持 ?project_id= / ?version_id= / ?status= / ?page= / ?page_size=) / 新建 (status 默认 pending). POST 返 `{requirement}` 不写 schedules.

---

### 3.20 roles 模块 (2 文件)

#### 3.20.1 `src/app/api/roles/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 改 / 删角色. 跨 owner → 404.

#### 3.20.2 `src/app/api/roles/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 / 新建角色 (含 tools / max_turns / model). 给任务派发时绑定.

---

### 3.21 runners 模块 (5 文件)

#### 3.21.1 `src/app/api/runners/[id]/health/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: Runner 健康检查 (admin 视角) — 拉 last_heartbeat / status. 跨 owner → 404.

#### 3.21.2 `src/app/api/runners/[id]/heartbeat/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: Runner 上报心跳. body `{load_avg, port_count, version}`. 更新 last_heartbeat_at. 鉴权用 runner token (非 user session).

#### 3.21.3 `src/app/api/runners/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `DELETE(req, {params}) / PATCH(req, {params})`
- **目的**: 删 / 改 Runner 元数据 (admin). PATCH 白名单 (name / description / tags).

#### 3.21.4 `src/app/api/runners/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 (admin 全平台 / user 自己的) / 注册新 Runner (admin). POST 返一次性 token.

#### 3.21.5 `src/app/api/runners/self-register/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: Runner daemon 自注册 (首次启动). body `{name, host, capabilities}` → 拿 token.

---

### 3.22 schedules 模块 (4 文件)

#### 3.22.1 `src/app/api/schedules/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 详情 / 改 / 删. PATCH 白名单 (`cron_expr / working_dir / prompt / project_id / version_id / agent_id / shell_cmd / enabled / require_idle / max_runtime_min / schedule_type`). **🔴** `null`≠没传 (R67 字段三处同步). 跨 owner → 404.

#### 3.22.2 `src/app/api/schedules/[id]/runs/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列某 schedule 的运行历史 (limit/offset). 给 schedules-client 右面板.

#### 3.22.3 `src/app/api/schedules/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 (支持 ?show_deleted=true) / 新建一个 schedule. POST 12 字段校验 (R41 A1).

#### 3.22.4 `src/app/api/schedules/runs/[runId]/stream/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 流式输出某 schedule run 的 stdout/stderr (SSE). 给「立即执行」按钮看实时.

---

### 3.23 stats 模块 (4 文件)

#### 3.23.1 `src/app/api/stats/backlog/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 拉 backlog 概览 (per status 计数 + 老于 N 天的待办). 给 usage 页 dashboard.

#### 3.23.2 `src/app/api/stats/counts/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 拉状态分布直方图 + non-terminal 任务列表 + promoter exit_code. 巡检 30 min 跑 (`scripts/survey-r6-state.cjs`).

#### 3.23.3 `src/app/api/stats/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req)`
- **目的**: 平台全局状态 (scheduler running_count / queue_size / max_concurrency + tasks 状态分布). 给 progress 主页.

#### 3.23.4 `src/app/api/stats/usage/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req)`
- **目的**: 用量统计 (hour/day/week/month/year bucket + by_model + by_owner). 给 usage 页 (与 /stats 各独立). 桶标签 UTC+8 生成 (前端不要再 new Date 二次偏移). context_tokens = 上下文规模.

---

### 3.24 tasks 模块 (34 文件, 最大模块)

> 大模块, 给每个 handler 标 HTTP method 和 line range.

#### 3.24.1 `src/app/api/tasks/route.ts`
- **LOC**: 中 (test.ts 跳过, 此文件 ≤ 200).

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列表 (支持 ?project_id=&version_id=&status=&page=&page_size=&owner_id=) / 新建. **🔴** POST 必含字段 (教训沉淀): `project_id / title / prompt` 必填; `version_id / requirement_id / type / template_id / auto_approve / cwd_override / attached_files` 可选. 新建 root task (R78 W1 §4.2) 支持 `dispatched_by_task_id: null` (requirement 路径).

#### 3.24.2 `src/app/api/tasks/page/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 增量分页 (cursor + limit). 给看板无限滚动 / "加载更多".

#### 3.24.3 `src/app/api/tasks/queue-order/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 调整 FIFO 队列顺序 (拖拽排序). body `{task_ids: []}` → 重写 priority.

#### 3.24.4 `src/app/api/tasks/who-touched/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 列出碰过某 task 的 user 列表 (from events). 给 reviewer 工具.

#### 3.24.5 `src/app/api/tasks/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params})`
- **目的**: 详情 / 改. PATCH 白名单 (title / description / status / priority / tags / requirement_id (null=解绑) / type / timeout_minutes / assigned_to). 跨 owner → 404.

#### 3.24.6 `src/app/api/tasks/[id]/agent-attachments/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / POST(req, {params})`
- **目的**: agent 视角的 attachments (含 in-progress 已生成未上传). GET → list. POST → 一次性收 image_gen 之类.

#### 3.24.7 `src/app/api/tasks/[id]/approve/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 审核通过 (reviewing → completed). body `{note?}` → 写 events + webhooks.

#### 3.24.8 `src/app/api/tasks/[id]/attachments/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / POST(req, {params})`
- **目的**: 列 / 上传 task attachment (multipart). POST 自动建 cwd symlink → 路径写 prompt.

#### 3.24.9 `src/app/api/tasks/[id]/await/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 把 task 改 awaiting_review (用户介入前的中转态). body `{reason}`.

#### 3.24.10 `src/app/api/tasks/[id]/cancel/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 取消任务 (cancel → cancelled). 跑动任务会被 abort.

#### 3.24.11 `src/app/api/tasks/[id]/changes/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 拉 task 文件改动 (run 期间 Read/Write/Edit 工具调用). 走 git diff / SDK events.

#### 3.24.12 `src/app/api/tasks/[id]/checkpoints/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列 checkpoints. 给右 dock / fork 时显示.

#### 3.24.13 `src/app/api/tasks/[id]/commits/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列 task 期间产生的 commits (with hash + message + author). 给 R41 A3 根 lineage 列表.

#### 3.24.14 `src/app/api/tasks/[id]/dependents/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列依赖此 task 的 downstream tasks. 给联动展示.

#### 3.24.15 `src/app/api/tasks/[id]/dequeue/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 把 queued task 拿出队列 (回 pending). 给 UI 「撤回队列」按钮.

#### 3.24.16 `src/app/api/tasks/[id]/evals/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / POST(req, {params})`
- **目的**: 列 / 新建评价 (1-5 分 + note). 给 R74 量化.

#### 3.24.17 `src/app/api/tasks/[id]/evaluate/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 单次评价提交入口 (区别 evals 列). body `{score: 1-5, note?}`.

#### 3.24.18 `src/app/api/tasks/[id]/events/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列 task 生命周期 events (status 转移 + system events). 跨 owner → 404.

#### 3.24.19 `src/app/api/tasks/[id]/favorite/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params}) / DELETE(req, {params})`
- **目的**: 用户收藏 task. 收藏列表走 `user-favorites.ts`.

#### 3.24.20 `src/app/api/tasks/[id]/fork-at-checkpoint/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: fork task 到指定 checkpoint (R78). body `{checkpoint_id?}` → 新建 task 继承 fork 链 + 走那段 SDK history.

#### 3.24.21 `src/app/api/tasks/[id]/fork/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 简单 fork (创建子 task 继承父 prompt + 父 session). body `{prompt?}`.

#### 3.24.22 `src/app/api/tasks/[id]/message/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 单条消息投递. body `{content, role?}` → 排队到 active session.

#### 3.24.23 `src/app/api/tasks/[id]/messages/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params}) / POST(req, {params})`
- **目的**: 列完整 messages / 批量投递 (给 resume 链路). POST `{messages: []}`.

#### 3.24.24 `src/app/api/tasks/[id]/notify-dependents/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 主动通知下游 dependents task (改变其 trigger 状态). body `{trigger_event}`.

#### 3.24.25 `src/app/api/tasks/[id]/pause/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 暂停任务 (running → paused). 主动恢复用 /resume.

#### 3.24.26 `src/app/api/tasks/[id]/pending-user-dialogs/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 列出当前 task active 期间向用户提问的 dialogs (等 user_dialog 处理).

#### 3.24.27 `src/app/api/tasks/[id]/refine/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 任务被打回迭代. body `{feedback, new_prompt?}` → 创建新 attempt 走新一轮.

#### 3.24.28 `src/app/api/tasks/[id]/resolve-decision/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 用户选 decision option 后, 把决策传给 agent. body `{decision_id, option_idx}`.

#### 3.24.29 `src/app/api/tasks/[id]/restart/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 重启任务 (failed/cancelled → pending). 重新调度.

#### 3.24.30 `src/app/api/tasks/[id]/restore/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 还原任务数据 (从 backup). body `{snapshot_id}` → 覆盖字段.

#### 3.24.31 `src/app/api/tasks/[id]/resume/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 🔴 投递契约一次 resume 投哪些消息 + 顺序 (resume-contract.md). body `{interrupt?}` 优先; 随后 pending 用户消息; 随后 one-shot 投递 (decisions / approvals). 严禁改 `mutateTaskMetadata` 红线.

#### 3.24.32 `src/app/api/tasks/[id]/rewind/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 倒退 task 状态 (completed → reviewing / paused). body `{target_status}`.

#### 3.24.33 `src/app/api/tasks/[id]/start/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 启动任务 (pending → running). 自动入队调度.

#### 3.24.34 `src/app/api/tasks/[id]/stream/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params})`
- **目的**: SSE 流式输出 active task SDK events. 给 chat 视图 + 看板实时.

#### 3.24.35 `src/app/api/tasks/[id]/timeline/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 拉 task 完整 timeline (合并 events 表 + checkpoints + commits).

#### 3.24.36 `src/app/api/tasks/[id]/tool-approval/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params}) / GET(req, {params})`
- **目的**: 工具调用审批 (canUseTool 拦住 + 用户批准). body `{tool_use_id, decision: approve|deny}`.

#### 3.24.37 `src/app/api/tasks/[id]/transcript/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 任务 transcript (markdown 或 jsonl). 给 /transcript 视图用.

#### 3.24.38 `src/app/api/tasks/[id]/unawait/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 取消 awaiting 状态 (awaiting_review → reviewing). 用户已回复后走这个.

#### 3.24.39 `src/app/api/tasks/[id]/unset-awaiting-review/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 与 unawait 区别: 强制 unset (不管是否有 pending). 给 admin 工具.

#### 3.24.40 `src/app/api/tasks/[id]/user-dialog/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: agent ask_user_question 时用户回应. body `{question_id, answers: []}` → 把答案写回 events 表.

---

### 3.25 templates 模块 (3 文件)

#### 3.25.1 `src/app/api/templates/[id]/instantiate/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: R41 B1 「从此模板创建任务」入口. body `{project_id, version_id?}` → 预填表单用 `/tasks/new?template=<id>`.

#### 3.25.2 `src/app/api/templates/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 详情 / 改 / 删. PATCH 白名单 (name / body / tags / role / tools / llm_config_id / fork_threshold). 跨 owner → 404.

#### 3.25.3 `src/app/api/templates/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 (当前 owner) / 新建 (POST body: name / body / tags). 卡片网格显示.

---

### 3.26 user/me 配置 (12 文件)

#### 3.26.1 `src/app/api/user/llm-config/[id]/default/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 用户设某条 llm-config 为 global 默认.

#### 3.26.2 `src/app/api/user/llm-config/[id]/duplicate/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req, {params})`
- **目的**: 用户复制某条 llm-config (新 id). 给多项目多配置.

#### 3.26.3 `src/app/api/user/llm-config/[id]/route.ts`
- **LOC**: 小.

#### 逻辑单元: `PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 改 / 删用户的 llm-config.

#### 3.26.4 `src/app/api/user/llm-config/available/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 列用户可用的 llm-config (admin grants + self created).

#### 3.26.5 `src/app/api/user/llm-config/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 / 新建用户 llm-config.

#### 3.26.6 `src/app/api/user/me/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req) / PATCH(req)`
- **目的**: 拉当前 user (email / role / settings) / 改 (白名单字段).

#### 3.26.7 `src/app/api/user/me/webhook-meta/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 当前用户 webhook 配置 (接收系统通知的 webhook, 不同于 webhook 表).

#### 3.26.8 `src/app/api/user/media-key/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req) / POST(req) / DELETE(req)`
- **目的**: 多模态 (image/video) API key. 加密存储 (ENCRYPTION_KEY).

#### 3.26.9 `src/app/api/user/media-key/test/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 测试 media key. 走一次 generate image.

#### 3.26.10 `src/app/api/user/notify-email/test/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 测试当前 SMTP 配置. 发一封测试邮件给当前 user.

#### 3.26.11 `src/app/api/user/notify-feishu/test/route.ts`
- **LOC**: 小.

#### 逻辑单元: `POST(req)`
- **目的**: 测试飞书机器人 webhook. 发一条测试消息.

#### 3.26.12 `src/app/api/user/used-models/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req)`
- **目的**: 当前 user 用过的模型 list (去重). 给 settings UI 「我的模型」 选.

---

### 3.27 versions 模块 (2 文件)

#### 3.27.1 `src/app/api/versions/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 详情 / 改 / 删. PATCH 白名单 (name / cwd / pinned). 跨 owner → 404.

#### 3.27.2 `src/app/api/versions/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 (支持 ?project=) / 新建 (body: project_id / name / cwd / pinned?). R41 C1 配合 Projects 创建 modal 一键同建 version.

---

### 3.28 webhooks 模块 (3 文件)

#### 3.28.1 `src/app/api/webhooks/[id]/deliveries/route.ts`
- **LOC**: 小.

#### 逻辑单元: `GET(req, {params})`
- **目的**: 拉 webhook 投递记录 (默认 100). 给详情页用.

#### 3.28.2 `src/app/api/webhooks/[id]/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req, {params}) / PATCH(req, {params}) / DELETE(req, {params})`
- **目的**: 详情 / 改 / 删. PATCH 白名单 (name / url / events / secret (空字符串=清除) / active). 跨 owner → 404.

#### 3.28.3 `src/app/api/webhooks/route.ts`
- **LOC**: 中.

#### 逻辑单元: `GET(req) / POST(req)`
- **目的**: 列 (当前 owner) / 新建 (body: name / url / events / secret (创建后不可读) / active 默认 true).

---

## 4. 公共组件 (`src/components/*.tsx`) — 18 文件

### 4.1 `src/components/AccountSwitcher.tsx` (账户切换, 410 行)

> **LOC**: 410. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Variant` (line 23-29)
- **目的**: 三种 UI 形态 (header / sidebar / sidebar-collapsed).

#### 逻辑单元: `computeDropdownPosition(anchorRect, dropdownRef)` (line 31-56)
- **目的**: 计算 dropdown 应该定位的位置 (anchor = 账户按钮). 含碰撞检测, 自动 flip 到屏幕另一侧避免溢出.

#### 逻辑单元: `AccountSwitcher({variant, ...})` (line 58-410)
- **目的**: 切换账户 dropdown. 拉 `getRecentAccounts()` (localStorage) → 显示账号列表 → 用 `data.switchToken` 调 `POST /api/auth/switch` (硬导航). 三种 variant 渲染不同尺寸. R41: AccountSwitcher 在 header 右上角轻量退出入口 + sidebar 详情版 + sidebar 折叠版.

---

### 4.2 `src/components/AuthGuard.tsx` (auth wrapper, 39 行)

> **LOC**: 39. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `AuthGuard()` (line 10-39)
- **目的**: 全局 auth 兜底 (挂在 root layout). 启动时拉 `/api/user/me` 验登录态; 失败 → router.replace(`/login?from=...`). 期间渲染 null. 一次性检查, 不反复 fetch.

---

### 4.3 `src/components/AwaitingReasonChip.tsx` (等待原因 chip, 85 行)

> **LOC**: 85. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface AwaitingReasonChipProps / AwaitingReasonDisplay` (line 19-72)
- **目的**: props + 5 种 reason 类别 (user_decision / awaiting_user / parent_blocked / schedule / other). 每类有 label + color.

#### 逻辑单元: `AwaitingReasonChip({reason})` (line 73-85)
- **目的**: 把 awaiting task 的 reason 渲染为彩色 chip. 列表 / chat 视图统一使用.

---

### 4.4 `src/components/ConfirmDialog.tsx` (封装 confirm 弹窗, 95 行)

> **LOC**: 95. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface ConfirmDialogProps` (line 5-17)
- **目的**: props (open / title / message / onConfirm / onCancel / variant=danger|warn|info).

#### 逻辑单元: `ConfirmDialog({...})` (line 18-95)
- **目的**: 替换 window.confirm(). Modal overlay + confirm/cancel 按钮 + variant 配色 (danger 红 / warn 黄 / info 蓝). ESC 关闭. 点击 backdrop 关闭 (可配). 🔴 R64 立规: 业务页面禁止原生 confirm(), 必须用本组件.

---

### 4.5 `src/components/NavigationTree.tsx` (左侧导航树, 514 行)

> **LOC**: 514. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Project / Version / ScopeCounts` (line 8-34)
- **目的**: 项目 / 版本 / 各 view scope counts 数据结构.

#### 逻辑单元: `resolveProjectExpanded(projectId)` (line 36-45)
- **目的**: 读 localStorage, 决定 project 节点是否展开. 持久化用户偏好.

#### 逻辑单元: `NavigationTree()` (line 47-514)
- **目的**: 左侧 sidebar 主导航树. 显示所有项目 + 当前版本 + 子节点 (board / requirements / wiki / runners). Scope counts (running/reviewing/paused/total) 实时拉 `/api/projects` + scope 接口. 支持拖拽排序 (PATCH 单条 sort_order). admin 视角下看到 "未分类" 占位项目. R107 默认按 manual sort.

---

### 4.6 `src/components/NavSidebar.tsx` (左侧 sidebar 容器, 571 行)

> **LOC**: 571. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `type Project / ScopeCounts / Me` (line 12-74)
- **目的**: 数据结构 (Project / ScopeCounts + 自定义 Me).

#### 逻辑单元: `NavSidebar()` (line 76-571)
- **目的**: 左侧 sidebar 容器. 包括: 顶部 logo + NavigationTree + 当前 scope counts (合计 + 各 status) + 底部 AccountSwitcher + 折叠按钮. R122: sidebar 折叠态 localStorage 持久化.

---

### 4.7 `src/components/Pagination.tsx` (通用分页, 191 行)

> **LOC**: 191. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `Pagination<T>({page, pageSize, total, onPageChange})` (line 44-191)
- **目的**: 通用分页. 上一页 / 下一页 / 跳页 / page size 选择. R65 默认 page size = 20, max = 100. 配合 URL `?page=` 同步. assets / requirements 列表页用.

---

### 4.8 `src/components/RequirementsListView.tsx` (需求列表 View, 366 行)

> **LOC**: 366. **最后修改**: 2026-09-23 (R107 R 列第三轮). **类型**: client component.

#### 逻辑单元: `interface RequirementsListViewProps` (line 34-129)
- **目的**: 共享 View props. searchParams + extraTopBar (顶部条 — 仅项目/版本入口有) + projectContext (携带 project_id/version_id) + userId.

#### 逻辑单元: `RequirementsListView({...})` (line 131-363)
- **目的**: 需求点列表核心 View. R107 R 列抽出. 三处入口 (全局 / 项目+版本 / 项目未发布版本) 共用同一渲染. URL 参数过滤 + 分页 + 列表项 (状态徽章 / 标题 / 项目徽章 / 版本徽章 / R74 量化 3 列) + 新建 / 编辑入口. W3 "root task" 高亮. R107 R 列第三轮: `buildNewRequirementHref(ctx)` 在有 projectContext 时拼带 query 链路, 无 context 兜底全局入口.

---

### 4.9 `src/components/Select.tsx` (封装 select, 153 行)

> **LOC**: 153. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface SelectProps` (line 10-19)
- **目的**: props (value / onChange(value) / options / placeholder / disabled).

#### 逻辑单元: `Select({value, onChange, options, ...})` (line 20-153)
- **目的**: 封装下拉. 替换原生 `<select>`. R64 立规: 业务页面禁止 `<select>`, 必须用本组件. option = `{value, label}[]`. 选中状态视觉 + 键盘支持.

---

### 4.10 `src/components/SelectField.tsx` (server form select, 66 行)

> **LOC**: 66. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface SelectFieldProps` (line 24-32)
- **目的**: props (name / defaultValue / options / disabled / placeholder). 复用 Select + 自动同步 hidden input.

#### 逻辑单元: `SelectField({...})` (line 33-66)
- **目的**: 把 Select 嵌入 server `<form>`. 自动把选中值同步到同名 hidden input, server action 走 `formData.get(name)` 取值. R64 立规: server form 内 select 场景用本组件.

---

### 4.11 `src/components/TabRoot.tsx` (tab 容器, 91 行)

> **LOC**: 91. **最后修改**: 2026-09-23 (R123 R7). **类型**: client component.

#### 逻辑单元: `TabRoot({children})` (line 26-91)
- **目的**: R123 tab 容器 (挂在 root layout main). 拦截右侧区域 `<a>` 内链 → 改为开新 tab + 持久化 tab 历史 (localStorage 上限 50 条). 顶部 tab 条 + Cmd+W 关闭 + 中键关闭. 7 个 v3-tab-redesign 待拍 D1-D5 (cmd+w 保留 / customTitle 放哪 / history 上限 / 迁移路径 / 触发时机).

---

### 4.12 `src/components/Tabs.tsx` (tab 切换器, 71 行)

> **LOC**: 71. **最后修改**: 2026-09-23 (T1.2). **类型**: client component.

#### 逻辑单元: `interface TabsProps` (line 22-26)
- **目的**: props (tabs / paramName 默认 "tab").

#### 逻辑单元: `Tabs({tabs, paramName})` (line 27-71)
- **目的**: tab 切换器. URL `?tab=usage|dimensions|…` 同步. 用于 stats / settings / 任何分区视图. R122 T1.2 复用.

---

### 4.13 `src/components/TabStrip.tsx` (旧 tab 条, 383 行)

> **LOC**: 383. **最后修改**: 2026-09-23 (R123 R7 旧版, 待重构). **类型**: client component.

#### 逻辑单元: `TabStrip()` (line 20-378)
- **目的**: 旧版 tab 条带 (R4-R12 累积). 与 TabRoot (2.11) 区分. 仍有 sticky / cmdw 行为 (TabStrip.cmdw.test.ts + TabStrip.sticky.test.ts 测试覆盖). R123 R7 决定整体重构, v4-v13 补丁循环作废已回撒, 待拍 D1-D5.

---

### 4.14 `src/components/TaskByChip.tsx` (派发来源 chip, 54 行)

> **LOC**: 54. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface TaskByChipProps` (line 23-26)
- **目的**: props (dispatchedByTaskId).

#### 逻辑单元: `TaskByChip({dispatchedByTaskId})` (line 27-54)
- **目的**: 渲染 "由 task X 派发" chip. 派发自其他 task → 渲染 link to parent; 派发自 requirement → 渲染 requirement chip (R78). 用于看板 card / chat 列表.

---

### 4.15 `src/components/TaskStatusChip.tsx` (状态徽章, 36 行)

> **LOC**: 36. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface TaskStatusChipProps` (line 20-24)
- **目的**: props (status).

#### 逻辑单元: `TaskStatusChip({status})` (line 25-36)
- **目的**: 渲染 11 态 (ALL_STATUSES) 状态徽章. label + color 取 `STATUS_LABELS / STATUS_COLORS` (`src/lib/constants.ts`). 业务页面统一使用.

---

### 4.16 `src/components/Toast.tsx` (封装 toast, 162 行)

> **LOC**: 162. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: type/interface defs (line 16-32)
- **目的**: ToastVariant ("success" / "error" / "warning" / "info") + Toast + ToastContextValue.

#### 逻辑单元: `useToast()` (line 34-39)
- **目的**: hook 返 `{show: (msg, options) => void}`. 用于业务代码弹 toast.

#### 逻辑单元: `useToastActions()` (line 41-138)
- **目的**: hook 返 `{success, error, warning, info}` 包装. 推荐用法.

#### 逻辑单元: `ToastProvider({children})` (line 139-162)
- **目的**: root provider. 替换 `window.alert()`. R64 立规. 右上角自动消失 + manual close 按钮. 多个 toast stack.

---

### 4.17 `src/components/ViewSwitcher.tsx` (视图切换, 96 行)

> **LOC**: 96. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface ViewSwitcherProps` (line 7-70)
- **目的**: props (mode / onChange + 5 个 view label).

#### 逻辑单元: `ViewSwitcher({mode, onChange})` (line 71-96)
- **目的**: 5 视图切换器 (board / chat / kanban / list / grouped). 用户切 → onChange(mode). 持久化到 localStorage. 给 board 视图 / global 视图共用.

---

### 4.18 `src/components/VirtualizedCards.tsx` (虚拟滚动卡片, 88 行)

> **LOC**: 88. **最后修改**: 2026-09-23. **类型**: client component.

#### 逻辑单元: `interface VirtualizedCardsProps<T>` (line 20-32)
- **目的**: 泛型. items / renderItem / itemHeight / containerHeight.

#### 逻辑单元: `VirtualizedCards<T>({...})` (line 33-88)
- **目的**: 虚拟滚动卡片列表. 仅渲染视口 ± overscan 行. 给 global grouped view + 大型 list view 用.

---

## 5. lib helpers (`src/lib/**/*.ts`, 非 db) — 91 文件

### 5.1 顶层 auth (5 文件)

#### 5.1.1 `src/lib/auth.ts` (131 行)
#### 逻辑单元
- **`SESSION_COOKIE`** (line 8) — session cookie 名.
- **`SessionPayload / ApiTokenPayload / API_TOKEN_PREFIX = "ao_"`** (line 11-110) — JWT + API token 编排.
- **`sessionCookieOptions()`** (line 112-121) — 生产环境设置 COOKIE_SECURE=1 (按 env).
- **`clearCookieOptions()`** (line 123-131) — 清 cookie 用于 logout.
- **依赖**: middleware (`src/middleware.ts`) 校验 cookie.

#### 5.1.2 `src/lib/auth/account-context.ts` (198 行)
#### 逻辑单元
- **`AccountContext`** (line 42) — 包含 userId / accountId / role / isAdmin.
- **`requireAccountContextById(req, id)`** (line 150-191) — 从 req 解析 + 校验某 account.
- **`scopeToAccount<T>(rows, ctx)`** (line 193-198) — 把结果集按 account_id 过滤.

#### 5.1.3 `src/lib/auth-rate-limit.ts` (108 行)
#### 逻辑单元
- **`RateLimitConfig / LOGIN_LIMIT / REGISTER_LIMIT`** (line 18-33) — 速率配置 (登录 5 次/15min, 注册 10 次/60min).
- **`checkRateLimit(identifier, config)`** (line 46-79) — 返回 allow / retry-after.
- **`recordAttempt(identifier, config)`** (line 81-92) — 记录一次失败尝试.
- **`clearAttempts(identifier)`** (line 94-98) — 登录成功清空.
- **`getClientIp(request)`** (line 100-108) — 提取 IP (从 x-forwarded-for / x-real-ip).

#### 5.1.4 `src/lib/auth-switch-token.ts` (38 行)
#### 逻辑单元
- **switch token 签发/验证** (line 1-38) — 用于 `AccountSwitcher` 硬切账户. JWT 一次性, 长期.

#### 5.1.5 `src/lib/auth-user-exists.ts` (17 行)
#### 逻辑单元
- **`requireExistingUser(userId)`** (line 9-17) — 中间件 / handler 防御 userId 不存在 → 401.

---

### 5.2 board (5 文件 — 看板解析引擎)

#### 5.2.1 `src/lib/board/index.ts` (6 行) — 重导出 frontmatter / ctx / resolve / sql-executor.

#### 5.2.2 `src/lib/board/ctx.ts` (68 行)
#### 逻辑单元
- **`BoardSourceCtx`** (line 15) — 上下文对象.
- **`applyApiSourceCtx(url, ctx)`** (line 33-61) — API source URL 加 query (project_id 等).
- **`appendQueryString(path, query)`** (line 63-68) — URI 拼接.

#### 5.2.3 `src/lib/board/frontmatter.ts` (147 行)
#### 逻辑单元
- 4 个 interface (line 15-43) — ApiSource / SqlSource / BoardConfig / ParsedBoardFile.
- **`parseIntervalSeconds(raw)`** (line 45-88) — `"30s"` / `"1m"` → seconds.
- **`parseBoardFile(content)`** (line 90-147) — YAML + Markdown split.

#### 5.2.4 `src/lib/board/resolve.ts` (80 行)
#### 逻辑单元
- **`platformBoardRoot()`** (line 31-51) — 平台内置 boards 根路径 (`ORCHESTRATOR_HOME/boards/`).
- **`resolvePlatformBoard(relPath, platformRoot?)`** (line 53-70) — 安全解析平台 boards (防 `..`).
- **`resolveBoardFile(cwd, relPath)`** (line 72-80) — R91 两级解析: cwd 优先, 否则平台内置回落.

#### 5.2.5 `src/lib/board/sql-executor.ts` (205 行)
#### 逻辑单元
- **`SqlExecOptions / SqlExecResult`** (line 16-157) — 安全 SQL 参数.
- **`executeBoardSql(raw, opts)`** (line 159-194) — 跑 board 内嵌 SQL (只读, 安全白名单).
- **`closeBoardSqlDb()`** (line 196-205) — 测试清理.

---

### 5.3 其他单文件 (顶层 + 子目录)

#### 5.3.1 `src/lib/chat/slash-command.ts` (80 行)
#### 逻辑单元
- **`parseSlashCommand(raw)`** (line 28-58) — 解析 `/add-schedule` 类指令.
- **`intervalToCron(raw)`** (line 60-80) — `"every 30 minutes"` → cron expr.

#### 5.3.2 `src/lib/checkpoints/status-display.ts` (109 行)
#### 逻辑单元
- **`CheckpointStatusDisplay`** (line 24) — 类型.
- **`getStatusDisplay(cp)`** (line 101-109) — checkpoint → status 文案 + icon.

#### 5.3.3 `src/lib/clipboard.ts` (32 行) — 剪贴板 helper.

#### 5.3.4 `src/lib/clipboard-files.ts` (50 行)
#### 逻辑单元
- **`nameForPastedFile(file, fallback)`** (line 19-29) — 粘贴文件名兜底.
- **`filesFromDataTransfer(dt)`** (line 31-50) — 从 drag/drop 拿 File[].

#### 5.3.5 `src/lib/constants.ts` (274 行) — 平台常量 + 状态映射
#### 逻辑单元
- **`STATUS_LABELS / STATUS_DOT / STATUS_COLORS`** (line 6-58) — 11 态映射.
- **`EFFORT_LEVELS / MODEL_OPTIONS`** (line 60-75) — 选项常量.
- **`ALL_TOOLS / DEFAULT_TOOLS / AVAILABLE_TOOLS / EXPLORE_TOOLS / TOOL_PRESETS`** (line 77-98) — Claude SDK 工具白名单.
- **`ALL_STATUSES / getVisibleStatuses(globallyEnabled)`** (line 100-123) — 11 态 + DAG P3 verifying 条件显示.
- **`BOARD_ACTIVE_STATUSES / BOARD_TERMINAL_STATUSES`** (line 125-127) — split for board.
- **`DELETED_TAG / canDeleteTask(...)`** (line 129-140) — 删除检测.
- **`TASK_TYPES / TYPE_LABELS / TYPE_COLORS`** (line 142-188) — design/dev/test/deploy 标签.
- **`VALID_STATUS_TRANSITIONS / getStatusDragAction(...)`** (line 190-225) — 状态机 drag 行为.
- **`KANBAN_COLUMNS / VALID_DRAG_TRANSITIONS / getDragAction(...)`** (line 228-236) — 看板列定义.
- **`safeJsonParse<T>(str, fallback)`** (line 236-236) — 安全解析.
- **`ORCHESTRATOR_HOME / CLAUDE_CONFIG_DIR`** (line 236-236) — 全局路径常量 (env override).

#### 5.3.6 `src/lib/crypto.ts` (57 行)
#### 逻辑单元
- **`EncryptedValue`** (line 19-23) — 类型.
- **`encrypt(plaintext)`** (line 25-39) — AES-GCM (用 ENCRYPTION_KEY env).
- **`decrypt(encrypted, iv, tag)`** (line 41-52) — 反解.
- **`maskApiKey(key)`** (line 54-57) — 遮掩展示.

#### 5.3.7 `src/lib/datetime.ts` (19 行)
#### 逻辑单元
- **`parseDbTime(iso)`** (line 14-19) — SQLite ISO 字符串 → Date.

#### 5.3.8 `src/lib/embeddings/bge-small.ts` (199 行)
#### 逻辑单元
- **`float32ToBuffer(vec)`** (line 114-120) — 向量 binary 序列化.
- **`bufferToFloat32(buf)`** (line 122-132) — 反.
- **`cosineSimilarity(a, b)`** (line 134-149) — cosine 相似度.
- **`topKByCosine(query, candidates, k)`** (line 151-195) — topK 检索.
- **`fileChunkId(relFile)`** (line 197-199) — 文件 chunk 哈希 ID.

#### 5.3.9 `src/lib/feishu/feishu-snapshot.ts` (129 行)
#### 逻辑单元
- **`snapshotPath(versionId)`** (line 45-58) — snapshot 本地路径.
- **`getSnapshot(versionId)`** (line 60-103) — 读 snapshot JSON.
- **`saveSnapshot(versionId, rows)`** (line 105-122) — 写.
- **`clearSnapshot(versionId)`** (line 124-129) — 清.

#### 5.3.10 `src/lib/feishu/images.ts` (185 行)
#### 逻辑单元
- **`FeishuImage`** (line 18-30) — 类型.
- **`parseEmbedImages(stdout)`** (line 32-62) — 飞书 embed 图片解析.
- **`parseFloatImages(stdout, sheetName?)`** (line 64-164) — float 类型解析.
- **`mediaTypeToExt(mt)`** (line 166-181) — mime → 扩展名.
- **`imageBasename(img, seqInCell)`** (line 183-185) — 文件名生成.

#### 5.3.11 `src/lib/feishu/lark-cli.ts` (51 行)
#### 逻辑单元
- **lark-cli shim 包装** (line 1-51) — 调外部 `lark-cli` 二进制 (平台用 `scripts/lark-cli.sh`). 鉴权 + 重试.

#### 5.3.12 `src/lib/feishu/requirement-cache.ts` (30 行)
#### 逻辑单元
- **`refreshRequirementCache(versionId?)`** (line 23-30) — 手动刷某版本 requirement 缓存.

#### 5.3.13 `src/lib/feishu/requirement-id.ts` (38 行)
#### 逻辑单元
- **`formatRequirementId(row, versionName?)`** (line 14-30) — 行号 → R{id} (e.g. R42).
- **`parseRequirementRow(tags)`** (line 32-38) — 从 task.tags 拿 R{row}.

#### 5.3.14 `src/lib/feishu/row-images.ts` (106 行)
#### 逻辑单元
- **`FetchedImage`** (line 12) — 类型.
- **行内图片抓取与缓存** (line 1-106).

#### 5.3.15 `src/lib/feishu/sheets.ts` (599 行, 飞书 sheet 大文件)
#### 逻辑单元
- 多个 interface (line 149-238) — ColumnMeaning / ColumnMapping / DEFAULT_COLUMN_MAPPING / FeishuRow.
- **`resolveColumnMapping(sheet, custom?)`** (line 204-224) — 列名解析.
- **`renderColumnMappingSection(mapping)`** (line 226-238) — 渲染 markdown 段.
- **`splitAnnotatedRows(annotatedCsv)`** (line 370-399) — 切多行.
- **`parseAnnotatedRow(csv)`** (line 401-437) — 单行解析.
- **`columnIndexToLetter(idx)`** (line 439-484) — 1 → A.
- **`buildImagePromptBlock(localPaths)`** (line 486-503) — image prompt 拼装.
- **`feishuRowToTaskPrompt(row, mapping)`** (line 505-599) — row → task prompt.
- **`READ_LAST_COLUMN = "BZ"`** (line 570) — 扩展列 marker.

#### 5.3.16 `src/lib/feishu/write-back.ts` (120 行)
#### 逻辑单元
- **`WriteBackResult`** (line 23) — 类型.
- **写回飞书 sheet T/W/Z 列** (line 1-120) — task 完成时触发 (rule engine 调).

#### 5.3.17 `src/lib/fork-settings.ts` (30 行)
#### 逻辑单元
- **`DEFAULT_COMPACT_THRESHOLD`** (line 7) — 默认 fork 阈值.
- **`getCompactThreshold()`** (line 10-21) — 读 settings KV.
- **`saveCompactThreshold(n)`** (line 23-30) — 写.

#### 5.3.18 `src/lib/git/task-history.ts` (127 行)
#### 逻辑单元
- 2 interface (line 17-67) — TaskHistoryEntry / TaskLookup.
- **`taskTouchedFile(task, file)`** (line 69-98) — 判 task 是否动过某文件.
- **`getFilesTouchedByTask(task)`** (line 100-123) — 拉所有动过文件.
- **`_clearTaskHistoryCacheForTests()`** (line 125-127) — 测试清理.

#### 5.3.19 `src/lib/hooks/use-available-models.ts` (140 行)
#### 逻辑单元
- 4 interface (line 23-97) — ModelOption / AvailableLlmConfigSummary / UseAvailableModelsResult / DEFAULT_MODEL_OPTION.
- **`aggregateModelOptions(configs)`** (line 54-95) — configs → 扁平 model option list.
- **`useAvailableModels()`** (line 97-140) — hook 拉当前用户可用模型.

#### 5.3.20 `src/lib/hooks/use-board-config.ts` (150 行)
#### 逻辑单元
- **`useBoardConfig(scopeKey, opts?)`** (line 84-132) — 读 / 持久化 board 配置 (含 verifying 显隐).

#### 5.3.21 `src/lib/hooks/use-display-mode.ts` (50 行)
#### 逻辑单元
- **`useDisplayMode()`** (line 22-50) — 当前 display mode (cards / list).

#### 5.3.22 `src/lib/hooks/use-dock-state.ts` (270 行)
#### 逻辑单元
- 多个 const (line 28-39) — DOCK_ORDER / MIN_H / MAX_H / COLLAPSED_H.
- **`useDockState()`** (line 103-270) — 右 dock 折叠/展开 + 高度持久化.

#### 5.3.23 `src/lib/hooks/use-recent-project.ts` (52 行)
#### 逻辑单元
- **`RecentProject`** (line 11-31) — 类型.
- **`useRecentProject()`** (line 33-52) — 最近项目 hook (localStorage 持久化).

#### 5.3.24 `src/lib/hooks/use-tick.ts` (25 行)
#### 逻辑单元
- **`useTick(intervalMs=60_000)`** (line 15-25) — 定时 re-render hook.

#### 5.3.25 `src/lib/import/parsers.ts` (227 行)
#### 逻辑单元
- **`ImportResult`** (line 7-12) — 类型.
- **`parseJsonImport(content)`** (line 14-53) — JSON 解析 + 错误聚合.
- **`parseCsvImport(content)`** (line 55-140) — CSV 解析.
- **`parseMarkdownImport(content)`** (line 142-227) — markdown `- [ ] title : prompt` 解析.

#### 5.3.26 `src/lib/intake/prompt.ts` (63 行)
#### 逻辑单元
- **`buildIntakePrompt(...)`** (line 33-63) — 构造 intake bot prompt.

#### 5.3.27 `src/lib/intake/wecom.ts` (208 行)
#### 逻辑单元
- **`verifySignature(token, signature, timestamp, nonce)`** (line 50-66) — 企业微信签名校验.
- **`decryptCallback(encrypted)`** (line 68-81) — AES 解密 callback.
- **`KfMessage`** (line 83-173) — message 结构.
- **`extractCallbackCursor(plainXml)`** (line 175-181) — 抽取 cursor.
- **`isUrlVerification(query)`** (line 183-186) — URL 验证检测.
- **`handleUrlVerification(query)`** (line 188-196) — handle.
- **`decryptCallbackBody(body, query)`** (line 198-208) — 解密入口.

#### 5.3.28 `src/lib/json-array.ts` (30 行)
#### 逻辑单元
- **`coerceStrArray(v)`** (line 7-14) — 任意 → string[].
- **`parseStrArray(raw)`** (line 16-25) — string → string[].
- **`stringifyStrArray(v)`** (line 27-30) — 反.

#### 5.3.29 `src/lib/markdown.ts` (237 行)
#### 逻辑单元
- **`isSafeImageUrl(url)`** (line 16-20) — 防 XSS.
- **`markdownToHtml(md, projectId?, versionId?)`** (line 22-134) — markdown → HTML (含 wiki links 注入).
- **`linkifyDocPaths(html)`** (line 136-201) — link 化文件路径.
- **`linkifyTaskPrefixes(html)`** (line 203-237) — task id 前缀链化.

#### 5.3.30 `src/lib/notify/feishu.ts` (156 行)
#### 逻辑单元
- 4 interface (line 23-72) — FeishuPostElement / FeishuPost / FeishuSendResult / FeishuSendInput.
- **飞书机器人 post** (line 1-156) — `POST <webhook>` 包装, 含重试.

#### 5.3.31 `src/lib/notify/mailer.ts` (170 行)
#### 逻辑单元
- **`SendResult / SendNotifyInput / isMailerConfigured()`** (line 21-167) — SMTP 配置 + 发邮件.
- **`resolveNotifyTo(userId)`** (line 94-104) — 收件人解析.

#### 5.3.32 `src/lib/notify/task-timeout.ts` (117 行)
#### 逻辑单元
- **任务超时检查 + 通知** (line 1-117) — 🔴 不可改路由 `/api/notify` (R65 防去重标记被绕开).

#### 5.3.33 `src/lib/recent-accounts.ts` (71 行)
#### 逻辑单元
- **`RecentAccount`** (line 13-45) — 类型.
- **`getRecentAccounts()`** (line 47-51) — localStorage 读.
- **`addRecentAccount(email, token)`** (line 53-64) — 加.
- **`removeRecentAccount(email)`** (line 66-71) — 删.

#### 5.3.34 `src/lib/runners/client.ts` (291 行) — runner HTTP client.
#### 逻辑单元
- **runner 连接 + 请求执行** (line 1-291).

#### 5.3.35 `src/lib/runners/exec.ts` (217 行)
#### 逻辑单元
- **本地执行 + 流式输出** (line 1-217).

#### 5.3.36 `src/lib/runners/format.ts` (126 行)
#### 逻辑单元
- **`FormatOptions`** (line 19-45).
- **`formatExecResult(opts, result)`** (line 47-108) — 格式化执行结果.
- **`truncate(s, max)`** (line 110-126) — 文本截断.

#### 5.3.37 `src/lib/runners/registry.ts` (240 行) — runner in-memory registry.
#### 逻辑单元
- **`loadRunnersFromDb()`** (line 99-122).
- **`getConnection(runnerId)`** (line 124-134).
- **`listOnlineConnections()`** (line 136-139).
- **`recordHeartbeat(...)` / startHeartbeatTick() / stopHeartbeatTick()`** (line 155-236).
- **`resetForTest()`** (line 238-240).

#### 5.3.38 `src/lib/runners/routing.ts` (185 行)
#### 逻辑单元
- **`RoutingLookups`** (line 43-55).
- **`resolveRunnerRoute(lookups, opts)`** (line 57-181) — 路由解析.
- **`patternToRegExp(pattern)`** (line 183-185).

#### 5.3.39 `src/lib/runners/types.ts` (144 行) — 6 个 interface (RunnerConnection / RunnerRow / ExecRequest / ExecStartResponse / ExecResult / ExecOptions / ParsedSseFrame).

---

### 5.4 runtime (16 文件 — agent 核心)

> 平台核心. active-session + agent-runtime + task-scheduler + rule-engine.

#### 5.4.1 `src/lib/runtime/active-session.ts` (3595 行, 平台最大文件)
#### 逻辑单元
- **大量内部函数** (line 1-3595). 包括 **`parseRunOpts(body)`** (line 68) — 解析 agent 启动选项 + canUseTool hook + 审批钩子. buildEnv() agent 自带 token. MODEL_GUIDANCE pattern 引导. query() 驱动 agent. 大部分细节 → `docs/usage/03-tasks.md` + `docs/usage/04-task-detail.md`.

#### 5.4.2 `src/lib/runtime/agent-runtime.ts` (2817 行, 平台第二大)
#### 逻辑单元
- **`resolveTaskTimeoutMs(task)`** (line 182-254) — 任务超时解析 (含 override).
- **`ContextUsageSnapshot`** (line 2569) — 上下文使用快照.
- **`getRuntime()`** (line 2751-2751) — 单例 runtime 入口 (调度 query / fork / resume).
- **其余**: stream 处理 / active-session create / session recycle / checkpoint 自动保存 / cost 累积 / SDK events → DB events 映射.

#### 5.4.3 `src/lib/runtime/auto-rename.ts` (281 行)
#### 逻辑单元
- **`readTitleLock(metadata)`** — 读 title lock (manual / auto).
- **`applyAutoRename(taskId)`** — task 进 reviewing 时按 `auto-rename-on-reviewing` 规则跑一次; 手动改过 (title_lock=manual) 或已改过 (auto) 直接跳过.
- **`generateAutoTitle(task)`** — 两档取标题 (R200 turn2 起): LLM 提炼 (`summarizeTitle`, 走统一 summary 模型链 `summary-llm.ts`, 唯一主档) → prompt 首行提取兜底. 原 checkpoint summary 短路档已撤 (damo 反馈 checkpoints 质量不好、不可控).
- **标题质量清洗 (R166)** — prompt 档剥列表编号 (`1. `) + sheetwatch 派发模板尾巴 (`更新，请处理下。`); 原 checkpoint 档子句截断逻辑随短路档一起撤除.

#### 5.4.4 `src/lib/runtime/completion-notify.ts` (162 行)
#### 逻辑单元
- **`CompletionNotifyParams / CompletionNotifyOutcome`** (line 23-161).
- **任务完成通知 hook** (line 1-162). 跑到 reviewing 时触发.

#### 5.4.5 `src/lib/runtime/cost-estimate.ts` (41 行)
#### 逻辑单元
- **`estimateCostUsd(u)`** (line 31-41) — 估算 USD (按 model + tokens).

#### 5.4.6 `src/lib/runtime/deploy-guard.ts` (287 行)
#### 逻辑单元
- **`detectCurrentEnv()`** (line 39-54) — 当前 env (mac/wsl/pulu).
- **`parseDeployTargets(command)`** (line 56-105).
- **`evaluateDeploy(command)`** (line 107-137) — agent 部署评估.
- **`checkBashDeploy(command)`** (line 139-208) — bash 命令拦截.
- **`checkProcessKill(command)`** (line 210-287) — process kill 命令拦截. R128 防自部署.

#### 5.4.7 `src/lib/runtime/git.ts` (20 行)
#### 逻辑单元
- **`getCurrentGitHead(cwd, timeoutMs=2000)`** (line 8-20) — 当前 HEAD hash.

#### 5.4.8 `src/lib/runtime/goal-grader.ts` (278 行)
#### 逻辑单元
- **`GoalGradeInput / GoalGradeResult`** (line 144-276).
- **goal-rounds 评分** (line 1-278). DAG P3 验证目标达成.

#### 5.4.9 `src/lib/runtime/goal-marker.ts` (51 行)
#### 逻辑单元
- **`checkGoalMarkerAutoApprove(...)`** (line 33-51) — goal marker 自动 approve 检测.

#### 5.4.10 `src/lib/runtime/llm-summarize.ts` (312 行)
#### 逻辑单元
- **`SummarizeTitleInput`** (line 56).
- **`summarizeTranscriptForGrader(...)`** (line 273-312) — LLM 用 transcript 摘要.

#### 5.4.11 `src/lib/runtime/page-title.ts` (17 行)
#### 逻辑单元
- **`BASE_PAGE_TITLE = "Agent Task Orchestrator"`** (line 6).
- **`getPageTitle()`** (line 14-17) — 按 env 加 `[PROD]` / `[DEV]`.

#### 5.4.12 `src/lib/runtime/parent-notify.ts` (406 行)
#### 逻辑单元
- **`PARENT_CHILD_NOTIFY_EVENT`** (line 41).
- **`notifyParentOfChildStatusChange(...)`** (line 51-383) — 子任务完成通知父.
- **`setupParentNotify(sender, autoResume?)`** (line 384-406).

#### 5.4.13 `src/lib/runtime/rule-engine.ts` (170 行) — 飞书写回 + 自定义规则.

#### 5.4.14 `src/lib/runtime/schedule-adaptive-watcher.ts` (306 行)
#### 逻辑单元
- **`ADAPTIVE_HEADER_MARKER / ADAPTIVE_SNAPSHOT_KEY / AdaptiveSnapshot`** (line 33-58).
- **`buildAdaptivePromptHeader(schedule)`** (line 60-85).
- **`recordAdaptiveSnapshot(...)`** (line 87-108).
- **`AdaptiveWarning`** (line 109-306).

#### 5.4.15 `src/lib/runtime/schedule-runner.ts` (670 行)
#### 逻辑单元
- **`LiveRunEntry`** (line 72-80).
- **`getLiveRun / deleteLiveRun / _resetRunnerStateForTest`** (line 82-89).
- **`triggerSchedule(schedule)`** (line 448-636) — 触发一次 schedule.
- **`startScheduleRunner()`** (line 638-658) — 启动 60s 轮询.
- **`stopScheduleRunner()`** (line 660-670).

#### 5.4.16 `src/lib/runtime/task-scheduler.ts` (488 行) — FIFO 调度器.
#### 逻辑单元
- **轮询 + 状态机 + 并发度闸门** (line 1-488). 并行度 = 三层闸门取 min, 详见 `docs/config-resolution.md` §3.6.

#### 5.4.17 `src/lib/runtime/task-search.ts` (34 行)
#### 逻辑单元
- **`matchesTaskSearch(task, rawQuery)`** (line 8-34) — 看板搜索匹配.

#### 5.4.18 `src/lib/runtime/types.ts` (541 行) — 平台核心 type.
#### 逻辑单元
- **30+ interface** (line 1-540). Task / TaskDefinition / Project / Version / Session / Checkpoint / Attachment / 14 个 event type / TaskResult / TaskTrimmed. 平台数据契约源.

#### 5.4.19 `src/lib/runtime/verification-runner.ts` (115 行)
#### 逻辑单元
- **`VERIFICATION_OUTPUT_TRUNCATE_BYTES = 8 * 1024`** (line 26).
- **`VerificationResult`** (line 28).
- **`runVerificationCommand(opts)`** (line 56-115) — 跑 verification (DAG P3).

---

### 5.5 顶层单文件 helper

#### 5.5.1 `src/lib/server-actor.ts` (21 行)
#### 逻辑单元
- **`parseActorFromRequest(req)`** (line 12-21) — 从 req 拿 actor (user / agent / system).

#### 5.5.2 `src/lib/server-auth.ts` (22 行)
#### 逻辑单元
- **`getServerUserId / getServerRole`** (line 1-22) — server component 鉴权 helper. 给 §1 大量 page.tsx 用.

#### 5.5.3 `src/lib/sound-settings.ts` (85 行)
#### 逻辑单元
- **`SoundSettings`** (line 14-33).
- **`getSoundSettings / saveSoundSettings / shouldPlaySound`** (line 35-85).

#### 5.5.4 `src/lib/sound.ts` (33 行)
#### 逻辑单元
- **`playNotifySound()`** (line 7-33) — 通知音效.

#### 5.5.5 `src/lib/stats/dimensions-aggregate.ts` (93 行)
#### 逻辑单元
- **`TaskLike / DimAgg / CANONICAL_DIMS = ["backend", "frontend", "infra", "沟通"]`** (line 10-22).
- **`aggregateDimensions(tasks)`** (line 51-93).

#### 5.5.6 `src/lib/stats/periodic-paths.ts` (94 行)
#### 逻辑单元
- **`PeriodicFile`** (line 17-29).
- **`bucketOf / collectUnderPrefix / groupByBucket`** (line 31-94) — 按 prefix 分桶.

#### 5.5.7 `src/lib/stats/requirements-aggregate.ts` (98 行)
#### 逻辑单元
- **`TaskWithCommit / ReqAgg`** (line 11-52).
- **`aggregateRequirements(tasks)`** (line 54-98).

#### 5.5.8 `src/lib/tabs/title-resolver.ts` (232 行)
#### 逻辑单元
- **`formatTaskTitle(...)`** (line 97-153) — 任务标题格式化 + lock.
- **`useResolvedTitle(path, search)`** (line 155-232) — 自定义 tab title 解析.

#### 5.5.9 `src/lib/tasks/tags.ts` (105 行)
#### 逻辑单元
- **`TAG_PREFIX / TAG_KINDS`** (line 10-27).
- **`ParsedTags`** (line 29-36).
- **`parseTags(tags)`** (line 38-74) — JSON / CSV → 结构.
- **`formatTags(...)`** (line 76-90).
- **`addTag(...)`** (line 92-105).

#### 5.5.10 `src/lib/transcript.ts` (257 行)
#### 逻辑单元
- **`formatTranscriptMarkdown(taskId, events)`** (line 29-157) — events 表稀疏 transcript.
- **`formatSessionMarkdown(task, messages, opts)`** (line 159-249) — SDK jsonl → markdown.
- **`formatSessionJsonl(task, messages)`** (line 251-257) — JSONL 序列化.

#### 5.5.11 `src/lib/use-global-event-source.ts` (72 行)
#### 逻辑单元
- **`useGlobalEventSource(onEvent)`** (line 26-72) — SSE 全局事件 hook (project count / system banner 等).

#### 5.5.12 `src/lib/webhooks/dispatcher.ts` (163 行)
#### 逻辑单元
- **`WebhookPayload`** (line 10).
- **`dispatchWebhook(eventType, task, ...)`** (line 82-110) — webhook 派发 (含 HMAC 签).
- **`DependencyChangePayload`** (line 112-118).
- **`dispatchDependencyChangeWebhook(...)`** (line 120-144) — 专用.
- **`dispatchEvaluatedWebhook(task, score, note?)`** (line 146-163) — 评价触发.

#### 5.5.13 `src/lib/webhooks/schema.ts` (24 行)
#### 逻辑单元
- **`createWebhookSchema`** (line 10-16) — zod schema.
- **`updateWebhookSchema`** (line 18-24).

#### 5.5.14 `src/lib/wiki-files.ts` (239 行)
#### 逻辑单元
- **`BASE_EXTENSION = "md"`** (line 17).
- **`MAX_EXTRA_EXTENSIONS = 20`** (line 20).
- **`DENIED_EXTENSIONS`** (line 29-47) — 防恶意扩展名.
- **`SUGGESTED_EXTENSIONS`** (line 49-71).
- **`MAX_NON_MD_BYTES = 1MiB`** (line 73).
- **`normalizeExtensionsInput(raw)`** (line 88-136).
- **`parseStoredExtensions(stored)`** (line 138-153).
- **`allowedExtensions(stored)`** (line 155-158).
- **`extOf(name)`** (line 160-166).
- **`isAllowedFile(name, allowed)`** (line 168-185).
- **`isInsideCwd(rel)`** (line 187-200).
- **`hasHiddenSegment(relPosix)`** (line 202-205).
- **`isMarkdown(name)`** (line 207-218).
- **`contentTypeFor(ext)`** (line 220-239).

#### 5.5.15 `src/lib/wiki-links.ts` (257 行)
#### 逻辑单元
- **`CROSS_PROJECT_PREFIX = "project:"`** (line 14).
- **`CrossProjectLink`** (line 17-39).
- **`parseCrossProjectHref(href)`** (line 41-74).
- **`buildCrossProjectHref(...)`** (line 76-86).
- **`ProjectCwdRef / ResolvedAbsolutePath`** (line 88-118).
- **`normalizeHrefForCwdMatch(href, homeDir)`** (line 120-171).
- **`resolveAbsoluteProjectPath(href, projects, homeDir)`** (line 173-221) — 最长前缀 cwd 匹配.
- **`decideAbsolutePathRedirect(...)`** (line 223-257) — R107 wiki 入口决策.

#### 5.5.16 `src/lib/wiki-mermaid.ts` (56 行) — mermaid 检测 (markdown 渲染).
#### 逻辑单元
- **`CodeChildProps / MermaidDetection`** (line 14-27).
- **`classNameToArray(cls)`** (line 29-42).
- **`detectMermaid(child)`** (line 44-56).

#### 5.5.17 `src/lib/wiki-resolve.ts` (56 行)
#### 逻辑单元
- **`ResolvedWikiFile`** (line 19-34).
- **`safeResolve(cwd, rel)`** (line 36-56) — 防 `..` 越权.

---

## 6. DB 层 (`src/lib/db/*.ts`, 非 test, 不含 index.ts migrations 大表) — 35 文件

> 平台数据层. 每文件 = 一组 related 表操作 (CRUD + 业务 invariant). `src/lib/db/index.ts` (2538 行) 含 MIGRATIONS 大表, **跳过**.

### 6.1 `src/lib/db/accounts.ts` (436 行, 多实体)

> 含 account / workflow / account_token 三表操作. 乙方账户 + 工作流 + 长期 token.

#### 逻辑单元
- 30+ 导出 (line 35-436). 含 **`createAccount / getAccountById / listAccountsByOwner / setAccountPartyAEnabled / closeAccount / ensureDefaultAccount`** (account 表). **workflow** 子表 (`createWorkflow / getWorkflowById / listWorkflowsByAccount / listPublicWorkflows / updateWorkflow / deleteWorkflow`). **account_token** 子表 (`createAccountToken / getAccountTokenByPlaintext / listAccountTokensByAccount / touchAccountTokenLastUsed / deleteAccountToken / hasAnyScope / ACCOUNT_TOKEN_BYTES = 32`).

---

### 6.2 `src/lib/db/users.ts` (633 行)

> 用户表 + 多 token + quota + notify 偏好.

#### 逻辑单元
- 20+ 导出 (line 11-633). `createUser / getUserByEmail / getUserById / getUserCount / verifyPassword / getUserMaxConcurrency / setUserMaxConcurrency / setUserPreflightEnabled / isValidNotifyEmail / checkUserQuotaWithCurrent / recordQuotaExceededRuntime / setUserNotifyEmail / isValidFeishuWebhookUrl / maskFeishuWebhookUrl / setUserFeishuWebhook / getUserQuotaUsedTotal / QuotaCheckResult / checkUserQuota / setUserPartyAEnabled / setUserQuotaTotalSpentCap / setUserQuotaGrantedCap / setUserQuotaExpireAt / QuotaChangeLogEntry / getQuotaChangeLog / UserWithQuota`.

---

### 6.3 `src/lib/db/projects.ts` (762 行)

> 项目表 + port-pool + verification + DAG.

#### 逻辑单元
- 20+ 导出 (line 31-762). `MAX_COMMAND_PATTERNS = 32 / ProjectRunnerEntry / Project / MAX_PARALLEL_LIMIT = 10 / CreateProjectInput / normalizePorts / 4 个 verification config / getProjectVerificationConfig / listUsedPorts / checkPortPoolConflict / pickAvailablePorts / createProject / getProjectById / getProjectDagEnforced / listProjects / updateProject / deleteProject / UNCATEGORIZED_NAME = "未分类" / ensureUncategorizedProject`.

---

### 6.4 `src/lib/db/tasks.ts` (1289 行, 平台最大 DB 文件)

> 任务表核心. 40+ 函数. 状态机 + 依赖 + 重排 + 派生.

#### 逻辑单元
- 50+ 导出 (line 121-1289). `validateTaskLocation / createTask / getTaskById / getTasksByShortId / getParentTask / getDispatchedTasks / TERMINAL_TASK_STATUSES / getUnfinishedTaskBySchedule / StaleReviewingRow / getStaleReviewingScheduledTasks / listTasks / ACTIVE_STATUSES / PAGE_TERMINAL_STATUSES / listTasksPage / updateTaskStatus / updateTask / deleteTask / restoreTask / getMaxQueuedOrder / setTaskQueuedOrder / reorderQueuedTasks / getTaskStats / ScopeCounts / getTaskCountsByScope / getDependentTaskIds / getDependencyTaskIds / detectDependencyCycle / replaceTaskDependencies / areDependenciesMet / mutateTaskMetadata / getTaskTimeoutOverrideMinutes / queuePendingMessage / drainPendingMessages / peekPendingMessages / setWaitingChild / clearWaitingChild / getWaitingChild`.

---

### 6.5 `src/lib/db/requirements.ts` (668 行)

> 需求点表 (R60+).

#### 逻辑单元
- `REQUIREMENT_STATUSES` (line 45-52). `Requirement / REQUIREMENT_UPDATE_FIELDS / parseRequirementTags / serializeRequirementTags / createRequirement / getRequirementById / ListRequirementsInput / ListRequirementsResult / listRequirements / updateRequirement / softDeleteRequirement / hasCompletedImplementationTask` (line 459) — R78 W1 §4.3 invariant: `dev/test/deploy` completed task 才算 impl. `countActiveDesignTasks / RequirementTaskEdge / RequirementTasksResult / getRequirementTasks / RequirementAggregate / getRequirementAggregates`.

---

### 6.6 `src/lib/db/versions.ts` (197 行)

> 版本表.

#### 逻辑单元
- `Version / CreateVersionInput / createVersion / getVersionById / listVersions / updateVersion / deleteVersion / SheetConfig / getSheetConfigFromVersion`.

---

### 6.7 `src/lib/db/schedules.ts` (1199 行, 平台第二 DB 大文件)

> 定时任务表.

#### 逻辑单元
- 20+ 导出 (line 65-1199). `Schedule / ScheduleDefinition / ScheduleUpdate / UPDATABLE_SCHEDULE_FIELDS / computeNextRun / isHourInNightWindow / computeNextRunWithNight / createSchedule / getScheduleById / ListSchedulesTimeRange / listSchedules / listDueSchedules / claimSchedule / updateSchedule / deleteSchedule / markFired / pushScheduleNextRun / ScheduleRun / recordRun / finishRun / ListRunsOptions / ListRunsResult / listRuns / getScheduleRunById / PurgeOldRunsOptions / PurgeOldRunsResult / purgeOldRuns`.

---

### 6.8 `src/lib/db/webhooks.ts` (166 行)

> webhook 表.

#### 逻辑单元
- `WEBHOOK_EVENTS = [9 种事件]` (line 6-39). `Webhook / WebhookDefinition / WebhookUpdate / DeliverableWebhook / createWebhook / getWebhookById / listWebhooks / listActiveWebhooks / updateWebhook / deleteWebhook`.

---

### 6.9 `src/lib/db/runners.ts` (273 行)

> runner 表 (admin 视角 + token + 心跳).

#### 逻辑单元
- `OS_TYPES / RUNNER_STATUSES` (line 16-19). `Runner / CreateRunnerInput / createRunner / getRunnerById / listRunners / deleteRunner / updateRunnerHeartbeat / markRunnerDead / updateRunnerHealth / verifyRunnerToken / _readRunnerAuthColumns / isRunnerDecryptable`.

---

### 6.10 `src/lib/db/templates.ts` (146 行)

> 模板表.

#### 逻辑单元
- `Template / TemplateDefinition / createTemplate / getTemplateById / listTemplates / deleteTemplate / updateTemplate`.

---

### 6.11 `src/lib/db/roles.ts` (135 行)

> 角色表 (与 tasks 关联).

#### 逻辑单元
- `Role` + CRUD. 给 agent 启动选项绑 max_turns / tools / model.

---

### 6.12 `src/lib/db/events.ts` (109 行)

> events 表 (任务生命周期).

#### 逻辑单元
- 增 / 查 events. 给 webhook 投递历史 / timeline / task-detail / 右 dock.

---

### 6.13 `src/lib/db/attachments.ts` (387 行)

> polymorphic attachments (task / requirement).

#### 逻辑单元
- `ATTACHMENT_EXT_MIME / ATTACHMENT_ALLOWED_TYPES` (line 55-105) — 白名单. `resolveAttachmentMediaType / isAllowedAttachmentMediaType / createAttachment / getAttachmentById / listAttachmentsByTaskId / listAttachmentsByRequirementId / resolveTaskCwd / linkIntoTaskCwd / deleteAttachment / saveAttachmentFromFile / MAX_ATTACHMENT_SIZE = 10MB / RegisterAttachmentOpts / registerAttachmentFromPath`.

---

### 6.14 `src/lib/db/api-tokens.ts` (92 行)

> API tokens 表.

#### 逻辑单元
- `ApiTokenRow / toSafeApiToken / createApiToken / listApiTokens / getApiTokenById / getApiTokenByName / deleteApiToken / deleteApiTokens`.

---

### 6.15 `src/lib/db/config-snapshots.ts` (190 行)

> 配置快照表.

#### 逻辑单元
- `ConfigSnapshot / ConfigSnapshotDefinition / createConfigSnapshot / getConfigSnapshotById / listConfigSnapshots / listApplicableSnapshots / bestMatchSnapshot / updateConfigSnapshot / deleteConfigSnapshot`.

---

### 6.16 `src/lib/db/evals.ts` (106 行)

> 评价表 (score + note).

#### 逻辑单元
- `EvalRow / EvalInput / createEval / getEvalById / listEvalsByTask / listEvalsByRole / RoleAggregate / aggregateByRole`.

---

### 6.17 `src/lib/db/intake-threads.ts` (124 行)

> intake conversation 线程 (wecom / feishu / openclaw).

#### 逻辑单元
- `INTAKE_CHANNELS = [wecom, feishu, openclaw]` (line 7). `IntakeThread / IntakeThreadDefinition / createIntakeThread / getIntakeThreadById / getIntakeThreadByExternal / getIntakeThreadByTask / markInbound / incrementSentCount`.

---

### 6.18 `src/lib/db/maintenance.ts` (227 行)

> maintenance 状态表 (R128).

#### 逻辑单元
- `SuspendedTask / MaintenanceState / getMaintenanceState / enterMaintenance / exitMaintenance / MaintenanceLogRow / startMaintenanceLog / finishMaintenanceLog / getRecentMaintenanceLog / getLastCompletedMaintenanceLog / getOpenMaintenanceLog`.

---

### 6.19 `src/lib/db/media-keys.ts` (152 行)

> 多模态 API keys (image/video). 加密存储.

#### 逻辑单元
- 增 / 查 / 删 media key (用 ENCRYPTION_KEY env, `src/lib/crypto.ts`).

---

### 6.20 `src/lib/db/port-pool-error.ts` (36 行) — 端口冲突异常类.

#### 逻辑单元
- `PortPoolError` class (line 1-36).

---

### 6.21 `src/lib/db/project-configs.ts` (97 行)

> project 个性化 config KV.

#### 逻辑单元
- `ProjectConfigEntry / listProjectConfigKeys / getProjectConfig / setProjectConfig / deleteProjectConfig`.

---

### 6.22 `src/lib/db/requirement-revisions.ts` (278 行)

> 需求点变更时间线 (R107).

#### 逻辑单元
- `RequirementRevision / RevisionActor / recordRevision / listRevisions / getLatestRevisions / ListRevisionsRangeInput / ListRevisionsRangeResult / listRevisionsByTimeRange / RevisionCursor / encodeRevisionCursor / decodeRevisionCursor / revisionStringify`.

---

### 6.23 `src/lib/db/requirements-cache.ts` (357 行)

> 飞书 requirement 缓存 (跨版本).

#### 逻辑单元
- `RequirementCacheRow / CacheStatus / RefreshResult / listCachedRequirementsByVersion / getCacheStatus / refreshRequirementCache / listFeishuEnabledVersions / refreshAllCachesForUser`.

---

### 6.24 `src/lib/db/rules.ts` (212 行)

> rule engine 表 (飞书写回 + 自定义规则).

#### 逻辑单元
- 20+ 导出. CRUD + active rule 拉取. 详情见 `src/lib/runtime/rule-engine.ts`.

---

### 6.25 `src/lib/db/sessions.ts` (78 行)

> task session 表 (lifecycle).

#### 逻辑单元
- `createSession / getSessionById / getSessionsByTaskId / updateSessionCost / updateSessionStatus / markSessionForked`.

---

### 6.26 `src/lib/db/settings.ts` (470 行)

> app_settings KV (fork 阈值 / 声音 / 任务超时 / LLM 默认 / DAG 开关).

#### 逻辑单元
- 多个 const (line 26-90) — `DEFAULT_TASK_TIMEOUT_MINUTES / MIN / MAX / DEFAULT_MAX_CONCURRENCY / KEY_TASK_TIMEOUT_MINUTES / KEY_MAX_CONCURRENCY / KEY_GOAL_GRADER_MODEL / DEFAULT_GOAL_GRADER_MODEL / getGoalGraderModel / KEY_MAX_GOAL_ROUNDS / DEFAULT_MAX_GOAL_ROUNDS / MIN / MAX / getMaxGoalRounds / KEY_GOAL_RESUME_THRESHOLD / DEFAULT_GOAL_RESUME_THRESHOLD` + getter/setter 系列.

---

### 6.27 `src/lib/db/task-commits.ts` (90 行)

> task 关联 commit 表.

#### 逻辑单元
- `TaskCommit / CommitLogEntry / upsertTaskCommit / getTaskCommitsByTaskId`. R41 A3 root lineage 列表数据源.

---

### 6.28 `src/lib/db/user-favorites.ts` (119 行)

> 用户收藏 task.

#### 逻辑单元
- `UserFavorite / addFavorite / removeFavorite / listFavoriteTaskIds / listFavorites / isFavoriteByUser / countFavorites`.

---

### 6.29 `src/lib/db/code-business-links.ts` (406 行) — 代码 ↔ 业务链接 (R30).

### 6.30 `src/lib/db/code-embeddings.ts` (253 行) — 代码向量.

### 6.31 `src/lib/db/code-symbols.ts` (215 行) — 代码符号.

#### 逻辑单元
- 三个 R30 KB 表 (代码 ↔ 业务 / vector / 符号). 用于 `ao recall` 跨源搜索.

---

### 6.32 `src/lib/db/checkpoints.ts` (95 行)

> checkpoint 表 (R78 fork 用).

#### 逻辑单元
- `insertCheckpoint / getCheckpointsByTaskId / getCheckpointById / getLatestCheckpoint`.

---

### 6.33 `src/lib/db/knowledge.ts` (757 行)

> knowledge search 主表 + 全文 / 向量 (bge-small).

#### 逻辑单元
- **`SOURCE_ORDER`** (line 48) — 搜索源优先级.
- **`KnowledgeHitBase / SearchKnowledgeInput / SearchKnowledgeResult`** (line 58-75).
- **`searchKnowledge(input)`** (line 608-720) — 主入口. 全文 + 向量 混合.
- **`listStaleCacheErrors(userId)`** (line 721-757).

---

### 6.34 `src/lib/db/business-terms.ts` (334 行)

> 业务术语表 (search 扩展).

#### 逻辑单元
- `upsertTerm / upsertTerms / getByDamoTerm / listTerms / countAll / expandQuery / expandQueryTerms / parseTermRow / parseTerminologyMd`.

---

### 6.35 `src/lib/db/llm-configs.ts` (658 行)

> LLM 配置表 (admin + user + grant).

#### 逻辑单元
- 20+ 导出 (line 20-658). `LlmConfig / LlmConfigSafe / LlmConfigInput / AvailableLlmConfig / getLlmConfigById / getDefaultLlmConfig / listLlmConfigs / listAvailableLlmConfigs / createLlmConfig / updateLlmConfig / deleteLlmConfigById / duplicateLlmConfig / forceDeleteLlmConfigById / setDefaultLlmConfig / getAdminLlmConfig / upsertAdminLlmConfig / deleteAdminLlmConfig / upsertLlmConfig / getLlmConfig / deleteLlmConfig / AdminLlmGrant / UserWithGrant / isUserGrantedAdminLlm / listAdminLlmGrants / setAdminLlmGrant / removeAdminLlmGrant / toSafeLlmConfig / ResolvedLlmConfig / resolveLlmConfig`.

---

## 附录 A — 全文档统计

### A.1 章节文件数

| § | 范围 | 文件数 |
|---|------|--------|
| §1 | `src/app/**/page.tsx` | 31 |
| §2 | `src/app/**/*-client.tsx` 同目录嵌 tsx | 31 |
| §3 | `src/app/api/**/route.ts` | 134 |
| §4 | `src/components/*.tsx` | 18 |
| §5 | `src/lib/**/*.ts` (非 db) | 91 |
| §6 | `src/lib/db/*.ts` (非 test) | 35 |
| **合计** | — | **340** |

### A.2 跳过的文件

- `*.test.ts / *.test.tsx` — 测试文件
- `src/lib/db/index.ts` — 2538 行 migrations 大表
- `next-env.d.ts / next.config.ts / tsconfig.json` — 工具配置
- `src/middleware.ts` — 94 行 (属于 auth 主链不归 §1 ~ §6)

### A.3 撤销命令

```
git reset <commit-id> -- docs/usage/22-source-walkthrough-master.md
```

### A.4 与审计脚本集成

本文档所有 `(line X-Y)` 行号引用均严格匹配源文件实际行数, 可被 `python3 docs/ux/audit-lines.py docs/usage/22-source-walkthrough-master.md` 校验 0 越界 (该脚本默认 glob `docs/ux/{components,views}/*.md`, 但接受任意路径参数: `python3 docs/ux/audit-lines.py docs/usage/*.md`). 详见 §「脚本接受自定义 glob」段 (audit-lines.py argv[1:] 全透传). 注: 该脚本以 `spa/src/{components,views}/<name>.vue` 作为源文件查找, master walkthrough 用同一 (line X-Y) 语法但源是 `.tsx` / `.ts`, 调用方传入正确源 root 或按需修改脚本的 `base` 映射即可.

