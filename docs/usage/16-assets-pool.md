# 16. 资源池（/assets）

> 跨任务的统一附件管理入口。所有 task 上传的附件 / Agent AI 生成的产物，都在这里统一查看、筛选、批量删除。

## 概述

资源池把原本散落在各 task 详情页的 attachments 汇总到一个全平台列表页，便于：

- 找历史产物（跨 task 检索）
- 按项目 / 版本 / 类型 / 来源 / 时间筛选
- 批量清理（一次删多个）

底层数据仍来自 `attachments` 表，资源池只是统一视图，**不会复制物理文件**。

## 进入路径

顶部导航 → 资源池 → `/assets`（admin/owner 全账号通用，按 `owner_id` 隔离）。

## 筛选维度

### 类型（顶部 tab 直接切换）

按 MIME 大类分：全部 / 图片 / 视频 / 音频 / 其他文件。点击即切换，无下拉。

### 来源（下拉）

按 attachment `source` 字段分：

| 标签 | 枚举值 | 含义 |
|------|--------|------|
| AI 生成 | `agent_generated` | Agent 调用 mmx 工具生成的图/视频 |
| 人工上传 | `upload` | 用户上传的文件 |
| Fork 继承 | `fork` | 从历史 task fork 时带过来的 |

### 项目 / 版本

项目下拉 = 当前 owner 名下所有有 attachment 的 project；版本下拉 = 选中项目后才有候选（联动）。

🆕 **R218 (2026-10-08)**：版本下拉末尾新增「**其他版本（未挂版本）**」选项 = 只看 `version_id` 为空的条目（task 创建时没挂任何版本）。实现：前端发 `version_id=null`（字面量），后端翻译成 `t.version_id IS NULL`。

### 文件名搜索

输入框 → 回车 / 点搜索按钮。LIKE 部分匹配。

### 时间窗

URL 参数 `since` / `until`（ISO 字符串），闭区间。

### 排序

URL 参数 `sort`：`created_at:desc`（默认）/ `created_at:asc` / `size_bytes:asc` / `size_bytes:desc` / `filename:asc` / `filename:desc`。

## 表格字段

| 列 | 内容 |
|----|------|
| ☐ | 多选（当前页全选 + 单条勾选） |
| 预览 | 图片缩略图 / 其他文件 icon |
| 文件名 | 可点（在新标签页打开原文件），下方一行小字显示 MIME |
| 类型 | 图片/视频/音频/文件 badge |
| **来源** | 三色 badge：紫色 = AI 生成，蓝色 = 人工上传，琥珀色 = Fork 继承 |
| 大小 | B / KB / MB / GB 自适应 |
| 所属 Task | 链接到 task 详情页 |
| 创建时间 | 本地时区 YYYY-MM-DD HH:MM |
| 操作 | 单删（带确认弹窗） |

## 批量删除

1. 多选要删的项
2. 工具栏右侧「批量删除 (N)」按钮亮起 → 点击
3. 弹确认框（`ConfirmDialog`，防误删）
4. 确认 → 物理文件清理 + 删记录

> 🔴 **不可恢复**：删除 = 物理文件清掉，没有回收站（damo 拍板，防误删）。

## API 速查

### `GET /api/assets`

列表查询。

| 参数 | 含义 |
|------|------|
| `project_id` / `version_id` / `task_id` | 维度筛选；🆕 R218：`version_id=null`（字面量）= 只看未挂版本（`IS NULL`） |
| `type` | `image` / `video` / `audio` / `file`（`file` = 排除前三类） |
| `source` | `upload` / `fork` / `agent_generated` |
| `q` | 文件名 LIKE |
| `since` / `until` | ISO 时间，闭区间 |
| `sort` | `字段:方向`，字段白名单 `created_at` / `size_bytes` / `filename` |
| `limit` / `offset` | 分页，默认 50，上限 200 |

返回 `{ assets, total, limit, offset }`，按 `owner_id` 严格隔离。

### `GET /api/assets/filters`

当前用户下有 attachment 的 project/version 树（含 count），给项目/版本下拉用。已 JOIN 去重 + 排除空选项。

### `POST /api/assets/delete-batch`

批量删，`body: { ids: string[] }`，返回 `{ deleted, failed: [{id}] }`。失败项不影响其他删除。

## 实现原理（开发者参考）

- 页面：`src/app/assets/page.tsx`（server）+ `assets-client.tsx`（client，工具栏/表格/批量删）
- API：`src/app/api/assets/route.ts`（列表 + 6 维筛选）/ `filters/route.ts`（下拉候选）/ `delete-batch/route.ts`（批量删）
- 测试：`src/app/api/assets/route.test.ts`（24 条，覆盖鉴权 / 跨 owner / 各维度筛选 / 排序 / 分页 / 时间窗）
- 字段定义：`src/lib/db/attachments.ts`（`source` 枚举 `upload | fork | agent_generated`，R121 扩展 `agent_generated`）
