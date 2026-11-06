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

## 本机 CLI 会话历史导入（Mac 本机 dev 实例）

> 三机各自独立实例（每台自己的 13000）通用——脚本按 `os.homedir()` 动态识别本机会话，见文末「跨机器使用」。本节标题保留 Mac 措辞是因为首次全量导入（clean+scan+summarize+ingest）发生在 Mac dev 实例。

### 功能点：CLI 历史一键导入（clean/scan/summarize/ingest）

- **是什么**：把本机原生 Claude Code CLI 的全部对话历史（`~/.claude/projects/<目录>/*.jsonl`）导入平台，一个 session = 一个任务（`status='completed'`、`tags=["cli-history"]`），带 LLM 摘要 + token/成本统计；**transcript 零拷贝**——硬链接本地 jsonl 进 `~/.agent-orchestrator/claude-config/projects/<munged-cwd>/`，平台任务详情页直接可看完整对话。
- **怎么用**（入口 `ao cli-import <子命令>` 或 `jiti scripts/import-cli-history.ts <子命令>`）：
  1. `clean [--yes]`——清空旧快照任务（判据 `created_at <= 快照日期`，先 `db.backup` 备份；无 `--yes` 只出报告）
  2. `scan`——流式解析本地会话（跳过 0 真实提问的空会话、非本机 HOME cwd 的会话、本工具 summarize 自产的一次性会话）→ `~/.agent-orchestrator/cli-import/scan.json`
  3. `summarize [--concurrency 4]`——`claude -p` 逐会话产出中文标题/摘要/关键词（增量可断点续跑；失败回退 aiTitle/summary 行/首提问）
  4. `ingest`——幂等导入（`tasks.session_id` 命中即跳过）：目录→项目匹配（cwd 精确 → basename 唯一 → 项目名唯一 → 自动建项目）+ sessions 行 + 硬链接
  5. `sync [--owner-email X]`——scan→summarize→ingest 一键链（增量幂等可重复跑），状态落 `~/.agent-orchestrator/cli-import/state.json`；**平台 UI 入口**：批量导入页「从原生 CLI 会话导入」卡片 → 「开始同步」按钮（= `POST /api/cli-import` 起 detached 子进程跑 `sync`，`GET /api/cli-import` 轮询进度，运行中重复点 409）——老 CLI 用户零学习成本把历史搬进平台
  6. `status` / `report`——进度查看 / scan↔DB↔文件三方对账
- **实现原理（开发者参考）**：`scripts/import-cli-history.ts`（文件头注释含完整用法/回滚/关注点）。读取契约：server 强制 `CLAUDE_CONFIG_DIR=$ORCHESTRATOR_HOME/claude-config`，`getSessionHistory()` 按 `task.cwd` 让 SDK 读 `claude-config/projects/<munge(cwd)>/<session_id>.jsonl`，`munge = cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g,"-")`（sdk.mjs 核实）。UI/API：`spa/src/views/Import.vue` + `src/app/api/cli-import/route.ts`（spawn `node_modules/.bin/jiti`，owner = 当前会话用户；状态单机全局不分用户）。冷启动档 → `docs/plans/cli-history-import.md`。
- **注意**：
  - UI 按钮和 sync 写本机实例 DB（直写，不走任务队列）；`sync` 需要 `claude` CLI 在 PATH（摘要用），没有则标题走回退链不影响导入。
  - `clean` 建议平台 server 停止时跑；回滚 = 恢复 `orchestrator.db.bak-pre-cli-import-*` 备份，或 `DELETE FROM tasks WHERE tags LIKE '%cli-history%'`。
  - 硬链接的好处：本地 CLI 的 `.last-cleanup` 清掉源文件后，平台侧 inode 仍持有数据。

### 功能点：同步后看板自动分类（ING / cron出片）

- **是什么**：`sync` 之后把当天（本地时区）新导入的会话任务自动挂进看板「分类」视图的全局列表——命中 cron 签名（first_prompt 前缀 `# 视频线每日出片`）的进「cron出片」，其余进「ING」（damo 2026-10-28 立：「后续都这么干」）。
- **怎么用**：`./scripts/ao cli-import sync && bash scripts/categorize-cli-import.sh`（或补某天：`bash scripts/categorize-cli-import.sh 2026-10-27`）。
- **注意**：归位三态（已就位跳过 / 错位 mv 搬正 / 未分类 put 挂入），重复跑无副作用；目标实例 = 本机 `AO_BASE_URL` 默认 `http://localhost:13000`；改列表名 / 加新 cron 签名改脚本顶部 `ING_LIST` / `CRON_LIST` / `CRON_PATTERNS` 变量。
- **实现原理（开发者参考）**：`scripts/categorize-cli-import.sh`（读 `scan.json` 二分 → 本地 sqlite `session_id→task_id` → `ao-pinlist.sh` mv/put；成员快照一次拉全避免逐任务 409 探测）。

### 功能点：跨机器使用（每机独立实例 + 各自导入本机会话）

- **是什么**：每台机器（Mac / Win-WSL / Mac Air）跑自己的平台实例（各自 13000 + 各自 `~/.agent-orchestrator/orchestrator.db`），各自导入**本机**的 CLI 会话历史，各自派发本地任务；跨机协作 = 用 `AO_BASE_URL` 指向对方 LAN IP 调 API（先例：Mac 操作 WSL ao-prod，见 `docs/mac-cli-notes.md`）。
- **每台新机器启用 runbook**（一次，约 20 分钟；Mac Air 为首个落地点）：
  1. **前置**：Node ≥ 20.9（`nvm install 22`）；Xcode Command Line Tools（better-sqlite3 原生编译）；Claude Code CLI 已装并登录（`~/.claude/projects/` 有历史 + `claude` 在 PATH，summarize 依赖）；git 能拉 origin（pulu git 服务器加本机公钥，主机名解析见 `docs/hosts.md`）；`git config user.name/email`
  2. **clone + install**：`git clone ssh://example.com/home/git/repos/agent-orchestrator.git && cd agent-orchestrator && npm install`（国内网络可用 cnpm/npmmirror）
  3. **env**：`.env.local` 写 `JWT_SECRET=<openssl rand -hex 32>`（不设走 dev 兜底但重启后全员掉登录）+ `COOKIE_SECURE=0`（HTTP 内网）
  4. **起服务**：`npm run build && nohup npx next start -p 13000 > /tmp/ao-prod.log 2>&1 &`——⚠️ **别用 `npm start`**：`ecosystem.config.cjs` 是 WSL/Pulu 四实例清单，Mac 上跑会把 bt/ao-prod/ao-dev 全拉起来。migration 首启自动跑
  5. **账号**：浏览器开 `localhost:13000` 注册（首个注册 = admin）+ Settings 配 LLM key（派任务用；cli-import 的 summarize 走本机 `claude` CLI，不依赖它）
  6. **同步 skills/标准/L1**：`bash scripts/sync-standards.sh`（bare = 本机化 + 落自己实例；会 ssh 锁 WSL/Pulu 副本 → 本机需与 win/pulu 互信，与跨机派发前提一致）
  7. **导入本机会话**：`./scripts/ao cli-import scan && ./scripts/ao cli-import summarize && ./scripts/ao cli-import ingest`（**不需要 clean**——那是 Mac 首次清 WSL 快照的一次性动作，且快照日期是 Mac 专属常量）
  8. **日常（拉模式）**：定期 `git pull --rebase && bash scripts/sync-standards.sh` 拿最新 skills/标准；改了东西 commit+push 回 origin
- **机器无关性口径**：scan 只认 `os.homedir()` 下的会话；Mac↔WSL 家目录别名（`/Users/user` ↔ `/home/user`）自动归一到本机 HOME 形态（保证自动建的项目 cwd 在本机真实存在）；Win 机建议跑在 WSL 里（平台 + CLI 同一文件系统，硬链接才成立）。
- **跨机访问对方实例**：`export AO_BASE_URL=http://<对方IP>:13000` + 用**对方实例**的账号登录（`scripts/login.sh`，token 按实例隔离）；HTTP 内网直连即可（`COOKIE_SECURE=0`）。
- **跨机派发模式**：本机派任务到对方实例实现 → 对方 agent 在其 checkout 上 commit+push 同一 origin → 本机 `git pull --rebase` 拿回。SOP → [`docs/shared-standards/task-dispatch-standards.md`](../shared-standards/task-dispatch-standards.md) §7。
