# Project / Version 层级

## 数据模型

```
Project (e.g. "anflow")
  ├── Version v1.6  ⭐ (current, 绑定 feishu Sheet2)
  │     └── Tasks (R9, R10, R11...)
  ├── Version v1.7-beta
  │     └── Tasks
  └── 其他任务 (version_id=NULL)
```

- **Project**：独立项目，每个有 `current_version_id`（类似 git HEAD，可切换）
- **Version**：绑定飞书 sheet（feishu_url + feishu_sheet + cwd），多个 version 互不干扰
- **Task**：必须归属 Project；Version 可选，`version_id=NULL` 表示项目级”其他任务”

> cwd 的完整 fallback 链（task → version → project → 隔离工作区）和前端显示逻辑见 [`docs/config-resolution.md`](config-resolution.md)。

## URL 结构

| URL | 渲染 |
|-----|------|
| `/` | ProjectsPage（项目列表）|
| `/[projectId]` | 307 Redirect → current/首个 Version；无 Version 时到 `unversioned` |
| `/[projectId]/[versionId]` | VersionBoardPage（看板）|
| `/[projectId]/unversioned` | 项目级“其他任务”（version_id=NULL）|
| `/uncategorized` | 兼容重定向到“未分类 / 其他任务” |

URL 用 **UUID** 而非 name slug（避免编码转换开销）。

## 创建工作流

```
1. POST /api/projects { name: "anflow" }
   → 创建 project，无 current_version_id

2. POST /api/versions { project_id, name: "v1.6", feishu_url, feishu_sheet }
   → 创建 version
   → 自动设为 current_version（如果 project 无 current）

3. PATCH /api/projects/[id] { current_version_id: <v1.7-id> }
   → 切换 HEAD（git checkout v1.7 概念）

4. POST /api/tasks { project_id, version_id?, prompt }
   → project_id 必填；version_id 省略时进入“其他任务”

5. POST /api/feishu/sync { rows: [9,10,11], version_id }
   → 批量导入飞书行为 task（自动用 version 绑定的 sheet）
```

## 飞书集成

每个 Version 绑定一个飞书 sheet。`src/lib/feishu/sheets.ts` 的 `readRow`/`writeField` 都接受 `sheetUrl` + `sheetName` 参数，从 Version 表读取。

- `POST /api/feishu/sync` body 加 `version_id`，从 version 查 sheet 配置（不再依赖硬编码 `DEFAULT_SHEET_URL`）
- `POST /api/feishu/write-back/[taskId]` 自动查 `task.version_id` 找 sheet

## NavigationTree

侧边栏组件 `src/components/NavigationTree.tsx`：
- 树形结构：Project → Version + 虚拟“其他任务”节点
- ⭐ 标记 current version
- 每个非 current version 旁有"+"按钮可设为 current（PATCH /api/projects/[id]）
- 仅在非根路径显示（`src/components/NavSidebar.tsx` 用 `usePathname` 判断）

> ⚠️ SPA 切换后对外 UI 只有侧栏（`ProjectSidebar.vue`，仅 ⭐ 标记）；切换 current version 的入口在**项目列表页 `spa/src/views/ProjectsView.vue` 的版本行「设为当前」按钮**（非当前版本显示，点击 PATCH `current_version_id`，飞书 AO-DEV R6 补——此前 SPA 无任何 UI 入口，只能命令行调 API）。`src/app/**` 历史壳仍带 "+" 按钮但用户不可见。

## 历史 task

Migration v7 会创建普通 Project“未分类”，把历史 `project_id=NULL` Task 迁入该项目并保留 `version_id=NULL`。`/uncategorized` 只保留为旧书签兼容重定向；正常查询使用：

```bash
GET /api/tasks?project=<project-id>&unversioned=true
```