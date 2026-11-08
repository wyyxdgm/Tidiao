# 8. 批量导入与飞书同步

> 从 CSV/JSON/Markdown 文件批量创建任务，以及与飞书表格双向同步。

## 概述

编排平台支持三种文件格式批量导入任务，以及与飞书（Lark）表格的双向同步：从飞书 sheet 行导入为任务并自动启动，以及将任务状态、session、commit 等元数据写回 sheet。导入页面位于 `/import`。

### 功能点：CSV 导入

- **是什么**：将 CSV 格式的任务列表批量解析并导入为任务。
- **怎么用**：
  1. 访问 `/import` 页面，选择格式为 CSV。
  2. 选择目标项目和版本（版本可选，不选归入项目级"其他任务"）。
  3. 粘贴 CSV 内容，格式为 `title,prompt,description,tags`，第一行必须为表头。
  4. 点击"预览解析"查看解析结果，确认无误后点击"确认导入"。
- **注意**：
  - 表头必须包含 `title` 和 `prompt` 列，其余可选列：`description`、`priority`、`cwd`、`tags`、`model`。
  - `tags` 列用分号分隔多个标签（如 `bug;urgent`）。
  - 支持双引号包裹的字段（如含逗号的 prompt）。
  - 缺少 title 或 prompt 的行会被跳过并在错误列表中提示。

### 功能点：JSON 导入

- **是什么**：将 JSON 数组格式的任务列表批量导入。
- **怎么用**：
  1. 在导入页面选择格式为 JSON。
  2. 选择目标项目和版本。
  3. 粘贴 JSON 内容，格式为对象数组：`[{"title": "任务标题", "prompt": "详细指令", "description": "可选", "tags": ["tag1"]}]`。
  4. 预览解析后确认导入。
- **注意**：
  - 必须是 JSON 数组，单个对象会报错。
  - 每个对象必须包含 `title` 和 `prompt` 字段。
  - 可选字段：`description`、`priority`、`cwd`、`auto_approve`（或 `autoApprove`）、`model`、`allowedTools`（数组）、`maxTurns`、`effort`、`tags`（数组）。
  - 缺少必填字段的对象会被跳过并记录错误。

### 功能点：Markdown 导入

- **是什么**：从 Markdown 文本中提取任务列表。
- **怎么用**：
  1. 在导入页面选择格式为 Markdown。
  2. 选择目标项目和版本。
  3. 粘贴 Markdown 内容，支持两种格式：
     - **复选框格式**：`- [ ] 任务标题`，下方用 `: 详细指令` 或 `> 引用` 补充 prompt。
     - **标题格式**：`## 标题`，标题下方的正文作为 prompt。
  4. 预览解析后确认导入。
- **注意**：
  - 复选框格式优先匹配；若无复选框则尝试标题格式。
  - 复选框格式中，如果 checkbox 下方有以 `:` 开头的行或 `>` 引用行，会追加到 prompt 中。
  - 标题格式支持 1-3 级标题（`#`/`##`/`###`），标题下所有非空行作为 prompt。
  - 若两种格式都未匹配到任务，会提示错误。

### 功能点：飞书同步导入

- **是什么**：从飞书表格的指定行读取数据，自动创建任务并可选启动。
- **怎么用**：
  1. 确保版本已绑定飞书 sheet URL（在版本设置中配置 `feishu_url` 和 `sheet` 名称）。
  2. 调用 `POST /api/feishu/sync`，传入参数：
     - `rows`（必填）：飞书 sheet 行号数组，如 `[3, 5, 8]`。
     - `version_id`：版本 ID，用于读取绑定的 sheet 配置。
     - `project_id`：项目 ID（当不传 version_id 时必填）。
     - `start`：是否自动启动任务，默认 `true`。
     - `sheetUrl`/`sheetName`/`cwd`：可选覆盖，不传则从版本配置读取。
  3. 返回结果包含每行的 `task_id` 和 `started` 状态。
- **注意**：
  - 前提条件：`lark-cli` 已登录且可用。
  - sheet 名默认为 `Sheet2`。
  - 导入的任务自动添加 `feishu` 和 `R<行号>` 标签（如 `R3`），用于后续写回定位。
  - 任务标题格式为 `anflow R{行号}: {模块或问题描述}`。
  - 任务 `auto_approve` 默认为 `true`。
  - 需要当前用户拥有目标项目/版本的所有权。

### 功能点：飞书写回

- **是什么**：将任务运行状态和元数据写回飞书表格的 S-Z 列，让 sheet 成为单一事实来源。
- **怎么用**：
  1. 调用 `POST /api/feishu/write-back/{taskId}`，传入任务 ID。
  2. 系统自动从任务的 `R<行号>` 标签解析行号，从版本配置读取 sheet URL。
  3. 写回以下列：
     - **S** `task_id`：任务数据库 ID
     - **T** `session_id`：Agent SDK session UUID
     - **V** `base_commit`：任务开始时的 git HEAD
     - **W** `head_commit`：任务结束时的 git HEAD
     - **X** `forks`：分叉任务数量
     - **Y** `checkpoints`：检查点数量
     - **Z** `status`：任务状态（running/completed/failed 等）
  4. 返回每列的写入结果（成功/失败）。
- **注意**：
  - 任务必须通过飞书同步导入创建（有 `R<行号>` 标签），否则报错。
  - 任务必须关联版本（`version_id`），版本需绑定 `feishu_url`，否则报错。
  - 可通过 body 中的 `sheetUrl`/`sheetName` 覆盖版本配置。
  - 空值字段会被跳过不写入。

### 功能点：列权限

- **是什么**：飞书表格列按写入权限分为三类，确保不同角色只能写各自负责的列。
- **怎么用**：无需操作，权限在后端代码中硬编码。
  - **用户列**（A-R）：用户手动填写，包括 `feedback_date`、`serial`、`module`、`type`、`problem`、`screenshot`、`expected`、`priority`、`owner`、`release`、`test_passed`、`reply` 等。
  - **Agent 可写列**（J, M, O, U）：
    - J `note_for_customer`：面向客户的简短说明
    - M `effort_hours`：预估工时
    - O `fixed`：是否已修复（0/1）
    - U `commit_ids`：提交 ID（CSV 格式）
  - **Orchestrator 可写列**（S, T, V, W, X, Y, Z）：仅编排平台可写，见上方"飞书写回"。
- **注意**：
  - I `ai_supplement` 列为 AI 只读上下文，N `qna` 和 R `reply` 为双向可写。
  - 写回时后端校验 `ORCHESTRATOR_WRITABLE` 集合，非集合内列会被拒绝。

## 常见问题

**Q: 导入后任务状态是什么？**
A: 文件导入（CSV/JSON/Markdown）创建的任务初始状态为 `pending`，需要手动启动。飞书同步导入默认自动启动（`start=true`）。

**Q: 飞书写回什么时候触发？**
A: 飞书写回是手动调用的 API，不自动触发。可在任务完成后调用，或在 agent 运行过程中通过定时任务定期调用。

## 本机 CLI 会话历史导入

> 平台端 API（`/api/cli-import`：把本机 Claude Code CLI 会话历史导入为平台任务）随开源版提供；
> CLI 端辅助脚本（scan / summarize / ingest 一站式）未随开源版发布，可直接调 API 实现。

