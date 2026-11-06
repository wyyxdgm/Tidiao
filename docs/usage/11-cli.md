# 11. CLI 工具

> 命令行工具集：派发任务、实时聊天、定时任务管理、用户维护、共享鉴权。

## 概述

编排平台提供五个 CLI 脚本，覆盖从命令行操作平台的所有场景。所有脚本共享 `login.sh` 鉴权库，自动检测当前环境并选择对应的 API 地址。安装方式：`cp scripts/ao-*.sh scripts/cron.sh scripts/user.sh scripts/login.sh ~/bin/ && chmod +x ~/bin/{ao-*.sh,cron.sh,user.sh,login.sh}`，依赖 `curl` + `python3`。

### 功能点：ao-dispatch.sh - 任务派发

- **是什么**：从命令行创建并启动任务，支持等待完成。
- **怎么用**：
  ```bash
  # 基本用法（创建+启动）
  ao-dispatch.sh -p 项目名 -t "任务标题" -m "详细 prompt"

  # 从文件读取长 prompt
  ao-dispatch.sh -p GDM -t "fix: 邮件超时" -f /tmp/task-prompt.md

  # 高 effort + 自动审批 + 等待完成
  ao-dispatch.sh -p yidao -t "重构引擎" -m "..." \
    --effort high --max-turns 150 --auto-approve --wait

  # 只创建不启动
  ao-dispatch.sh -p GDM -t "待办" -m "..." --no-start

  # 带标签
  ao-dispatch.sh -p anflow -t "fix: bug" -m "..." --tags bug,urgent
  ```
- **注意**：
  - 必填参数：`-p`（项目名或 `--project-id UUID`）、`-t`（标题）、`-m`（prompt，或 `-f` 从文件读取）。
  - 可选参数：`-v`/`--version`（版本名）、`--version-id`、`--cwd`、`--effort`（low/medium/high/xhigh/max，默认 medium）、`--max-turns`（默认 80）、`--auto-approve`、`--no-start`、`--wait`、`--tags`（逗号分隔）、`--from-task`（上游派发方 task id）、`--why`（派发这个任务的「为什么」，自由文本）、`--kind`（5 选 1 价值枚举：`unlock_capability` / `fix_bug` / `document_knowledge` / `advance_requirement` / `investigate`，自由字符串也允许落库）。
  - **`--from-task` UUID 校验 + 降级**（0826 P1）：传入的值必须是合法 UUID（`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-…$`）。若 `--from-task` 传非 UUID 字符串、或环境变量 `ORCHESTRATOR_TASK_ID` 不是合法 UUID，wrapper 立即降级为不记录派发方 + stderr 打 warn，不再透传到 platform 触发 400。Platform 层（`src/lib/db/tasks.ts` createTask）有同款降级做双保险。跨 owner 引用仍抛错（防越权派发溯源，不放开）。设计来由：0825 sheetwatch / 0826 partner 派单链 / 0826 P2 #16 #17 撞同根第 3 次。详见 [`docs/conventions/dispatched-by-fallback.md`](../conventions/dispatched-by-fallback.md)。
  - **`--why` 缺失时弹反思提示**（D10 前置门，2026-09-08）：交互终端检测 (`[[ -t 0 && -t 1 && -t 2 ]]`) 才弹 5 类模板引导，5 秒内按 Enter 跳过 / `y` 放弃派发；agent 子进程 stdin 已闭 → 自动跳过不打顿。设计动机 = 后置 LLM 反思 value 5 样本 0/5 命中，改为派发那一瞬 dispatcher 知道为什么。详见 [§18](../plans/requirement-as-entity.md#18-🔴-d10value_significance-前置门damo-2026-09-08-拍板) + 升硬时机见 §18.8。
  - `--wait` 会阻塞并 30 秒轮询直到任务进入终态。
  - Agent 在执行任务时也可用此脚本派发子任务。
  - **如何选择 `--kind`**（damo 派发时的自问分类）：
    - `unlock_capability` — 解锁后续能力（"以后不用重写"），杠杆最大，优先选这个
    - `fix_bug` — 修 bug（"没有它会出什么事"）
    - `document_knowledge` — 沉淀知识（"下次谁会需要"）
    - `advance_requirement` — 推进某条需求点（"完成后能解锁什么"）
    - `investigate` — 探索未知（"找到答案后下一步是什么"）

### 功能点：requirements.sh - 需求点 CRUD + 派发任务 + 任务列表查询

> **2026-09-05 新增**（炉 = 需求点管理的统一 CLI 封装）。覆盖范围对齐 [17-需求点 API](./17-requirements-api.md) —— AI 能调到的需求点操作一站式，仿 `ao-dispatch.sh` + `feishu.sh` 风格。

- **是什么**：单脚本多子命令，把需求点 CRUD + 派发 + 时间线查询封装成 bash 工具；agent 不必记 HTTP 路径 / 拼 `Authorization: Bearer` / 处理 4xx 错误码。

- **怎么用**：
  ```bash
  # 子命令速查
  requirements.sh help                 # 全局帮助
  requirements.sh help dispatch        # 子命令详细帮助
  requirements.sh list                # 列需求点

  # CRUD
  requirements.sh create  --project-id 080af705-... --title "实现导出" --priority 2
  requirements.sh get     --id <uuid>
  requirements.sh patch   --id <uuid> --status awaiting_reply
  requirements.sh delete  --id <uuid>

  # 关联 task（森林 API）
  requirements.sh tasks    --requirement-id <uuid> --with-deps

  # 派发任务（在需求点下创建 task；默认自动启动）
  requirements.sh dispatch --requirement-id <uuid> \
    --title "fix: xxx" --prompt-file ./spec.md --type dev
  # 只创建不启动（避免 agent SDK 占用资源 / 跑 dry-run）
  requirements.sh dispatch --requirement-id <uuid> --title "..." --prompt "..." \
    --type dev --no-start
  # 等待完成（30s 轮询，仿 ao-dispatch.sh --wait）
  requirements.sh dispatch --requirement-id <uuid> --title "..." --prompt "..." --wait

  # 时间线（字段级 diff）
  requirements.sh revisions         --id <uuid> --limit 20
  requirements.sh revisions-stream  --since 2026-09-01T00:00:00Z --actor-type agent

  # 任务列表查询
  requirements.sh list-tasks --requirement-id <uuid> --status completed

  # 通用
  requirements.sh <sub> --json                # 原始 JSON 输出
  requirements.sh <sub> --quiet               # 只输出关键 id
  requirements.sh <sub> --token ao_xxx        # 显式 bearer (优先于密码)
  ```

- **注意**：
  - **鉴权复用 `login.sh`**：`AO_TOKEN` (bearer, 不过期) 优先；否则密码换 session。Agent 子进程由 buildEnv 自动注入 `AO_TOKEN`，**零配置可用**。
  - **`--no-start` 必须显式传 `body.start=false`**（2026-09-05 首版 bug 已修）—— 不传默认自动启动，会触发 agent SDK 跑 prompt；测试/CI/dry-run 必加。
  - **status='done' 守卫**：CLI 不会替你检查 `eligible_for_done`；先 `get` 看响应字段，或参考 [17 章 §3.1](./17-requirements-api.md#31-r78-w1-43--statusdone-守卫damo-痛点核心)。
  - **`list-tasks` 不带过滤返全平台 `Task[]`**（不是信封结构）—— 必传 `--requirement-id` 或 `--status` 缩小范围；CLI 默认 `page_size=50` 兜底防刷屏。
  - **与飞书无关**：本脚本只操作 platform `requirements` 表；飞书写回另见 `scripts/feishu.sh` + `src/lib/feishu/write-back.ts`。
  - **数据流向**：`create` → `patch` → `revisions` 自动写 `requirement_revisions` 字段级 diff（actor 标 `user`）；CLI 默认走 `parseActorFromRequest` 自动捕获，可带 header `x-actor-type: agent` + `x-task-id: <uuid>` 让时间线追溯到来源 task。
  - **依赖**：`bash 4+` + `curl` + `python3`（python 3 处理 JSON + base64，避开 jq 依赖）。macOS 自带 bash 3.2 **不支持**，需 `brew install bash` 后用 `/opt/homebrew/bin/bash` 执行。



### 功能点：ao-chat.sh - 交互式聊天

- **是什么**：与编排平台任务实时对话，SSE 流式输出 + 终态自动激活。
- **怎么用**：
  ```bash
  # 模式 1：与已有任务聊天
  ao-chat.sh <task-id>

  # 模式 2：新建任务并聊天
  ao-chat.sh -p GDM -t "修复邮件发送" -m "修复 SMTP 超时..."
  ao-chat.sh -p anflow -v v1.6 -t "feat: 导出" -m "..." --auto-approve
  ```
  聊天界面内可用命令：
  - 直接输入文字：发送消息给 agent（终态任务自动激活并注入消息）
  - `/status`：查看任务状态、费用、模型
  - `/history`：查看最近 10 条消息
  - `/q` `/quit` `/exit`：退出
- **注意**：
  - SSE 实时流：agent 回复逐字流式显示。
  - 终态自动激活：向 reviewing/completed/failed 等状态的任务发消息，自动启动任务并注入消息。
  - 连续对话安全：快速连续发消息不会丢失（先入队再启动，避免竞态）。
  - 工具调用提示：显示 agent 调用的工具名称。
  - 费用追踪：每次 agent 回复后显示累计费用。
  - 新建任务参数与 `ao-dispatch.sh` 相同（`-p`、`-t`、`-m`、`-v`、`--effort`、`--max-turns`、`--auto-approve` 等）。

### 功能点：cron.sh - 定时任务管理

- **是什么**：封装定时任务 API，支持完整的 CRUD + 启停 + 触发历史。
- **怎么用**：
  ```bash
  # 列表
  cron.sh list
  cron.sh list --project <UUID>                        # 项目过滤
  cron.sh list --version <UUID>                        # 版本过滤 (R92 第二批)
  cron.sh list --last-run-from 2026-08-01T00:00:00Z \
              --last-run-to   2026-09-01T00:00:00Z      # 上次执行时间区间
  cron.sh list --next-run-from 2026-09-01T00:00:00Z \
              --next-run-to   2026-09-30T00:00:00Z      # 下次执行时间区间

  # 创建 agent 定时（每天 9 点派任务）
  cron.sh create --name "每日巡检" --exec-type agent --schedule-type cron \
    --expr "0 9 * * *" --project GDM --title "巡检" --prompt "检查状态并汇报"

  # 创建 shell 定时（每 5 分钟跑命令）
  cron.sh create --name "巡检" --exec-type shell --schedule-type cron \
    --expr "*/5 * * * *" --command "echo tick && date"

  # 创建一次性任务（指定时间跑一次，触发后自动停用）
  cron.sh create --name "延时备份" --exec-type shell --schedule-type once \
    --expr "2026-08-06T03:00:00Z" --command "/path/backup.sh"

  # 启停 / 立即触发 / 触发历史 / 更新 / 删除
  cron.sh enable <id>
  cron.sh disable <id>
  cron.sh trigger <id>            # 不影响 cron 节奏；skip_if_running 仍生效
  cron.sh runs <id> [--limit N]
  cron.sh update <id> --expr "0 10 * * *"
  cron.sh delete <id>
  ```
- **注意**：
  - 必填参数：`--name` + `--exec-type`（agent/shell）+ `--schedule-type`（cron/once）+ `--expr`。
  - `list` 的 `--project` / `--version` / `--last-run-from/to` / `--next-run-from/to` 四组筛选独立可叠加；时间区间缺一边/非法值会被忽略，未执行过的（`last_run=NULL`）不在区间内。
  - agent 类型还需 `--project`/`--project-id` + `--title` + `--prompt`（或 `--prompt-file`）。
  - shell 类型还需 `--command`（或 `--command-file`）。
  - create 默认 `enabled` + `skip_if_running` 开启。
  - `trigger` 立即触发不影响 cron 节奏，但 `skip_if_running` 仍生效（上次没跑完返回 409）。
  - 后端 60 秒轮询触发，设计细节见 `docs/schedules.md`。

### 功能点：user.sh - 用户与 LLM 配置维护

- **是什么**：封装 auth + user + llm-config + api-tokens API。
- **怎么用**：
  ```bash
  # 注册（首个用户自动 admin）
  user.sh register --email me@x.com --password secret123

  # 验证凭据
  user.sh login

  # 当前用户资料
  user.sh me

  # 生成不过期 bearer token
  user.sh token --name "laptop-$(date +%F)"

  # token 管理（tokens-rm 支持多个 id 逗号分隔，走批量端点）
  user.sh tokens
  user.sh tokens-rm id1,id2,id3

  # LLM 配置查看 / 设置 / 清除 Key / 删除
  user.sh llm-config
  user.sh llm-config set --api-key ark-... --base-url https://... --model claude-...
  user.sh llm-config clear-key
  user.sh llm-config delete
  ```
- **注意**：
  - `register`/`login` 不需要已有鉴权。
  - `token` 用当前鉴权（`AO_TOKEN` 或 session）生成新 bearer，仅显示一次。
  - `llm-config set` 仅传要改的字段，未传的不变。
  - `llm-config` 返回的 api_key 脱敏。
  - 多环境批量刷 token 用 `refresh-tokens.sh`，`user.sh token` 是单环境便捷版。

### 功能点：ao-session.sh - 会话导出 / 导入（备份 + 跨机器共享）

- **是什么**：把一个 task 的**完整会话**导出成文件，或把这样一个文件作为附件喂给另一台机器上的会话当阅读材料。
- **怎么用**：
  ```bash
  # 导出（默认 ./ao-session-<task 前 8 位>.md）
  ao-session.sh export <task-id>
  ao-session.sh export <task-id> -o /tmp/a.md --full     # 逐字，含 thinking
  ao-session.sh export <task-id> --format jsonl          # 逐字存档格式
  ao-session.sh export <task-id> --env wsl               # 跨机器直取，不落地中转

  # 导入到已有 task（上传附件 + 发一条消息让 agent 先读）
  ao-session.sh import /tmp/a.md --to <task-id>

  # 导入到新建 task
  ao-session.sh import /tmp/a.md --new -p ao-dev -t "接手：修复 SMTP 超时"

  # 跨机器一步到位（= export 到临时文件再 import）
  ao-session.sh transfer <src-task-id> --from wsl --new -p ao-dev -t "接手 xxx"
  ```
- **注意**：
  - 🔴 **这不是 SDK resume**。导入后目标 task 是全新 `session_id`，历史只是 agent 读到的一份材料——它能引用、能接着干，但不是"同一个会话续上"。
  - **两种 verbosity**：默认 `summary` 丢弃 thinking、`tool_result` 截到 2000 字（长任务原样导出轻易超 attachments 的 10MB 上限，且 thinking 对接手上下文几乎无用）；`--full` 逐字保留。
  - **`--format jsonl`** 一律逐字（`--full` 对它无效），是"存档"格式，不是能被 SDK resume 的 transcript。
  - **导出的完整性依赖对端已部署 2026-08-12 的变更**。老版本返回的是 `events` 表的稀疏日志（HTTP 200，不报错，只是内容残缺约 4/5）。判断方式：文件首行是 `# <任务标题>` = 新版；`# Task <uuid> - Session Transcript` = 老版。
  - 超 10MB 时 `export` 会告警但仍落盘，导入会被服务端拒（415/413）——改用默认 `summary`。
  - `--env` / `--from` 可选 `local` / `wsl` / `pulu`；连 pulu 需 `AO_TOKEN` 或 `AO_PASSWORD`。

### 功能点：backup-db.sh - 备份（DB + 会话 transcript）

- **是什么**：一条命令把平台状态备份出去：SQLite 在线一致性快照 + agent 会话 transcript 打包。
- **怎么用**：
  ```bash
  # 直接跑（用默认路径）
  scripts/backup-db.sh

  # 换备份目标目录
  AGENT_ORCH_BACKUP_DIR=/tmp/bk scripts/backup-db.sh

  # cron（WSL 每天 01:30，须以 damo 用户跑）
  30 1 * * * /home/user/workspace/agent-orchestrator/scripts/backup-db.sh >> ~/.agent-orchestrator/backup.log 2>&1
  ```
- **产出两个文件**：

  | 文件 | 内容 | 为什么需要 |
  |---|---|---|
  | `orchestrator-<时间戳>.db.gz` | 整个 SQLite（任务/项目/版本/线程/配置/附件记录） | 平台状态 |
  | `transcripts-<时间戳>.tar.gz` | `$ORCHESTRATOR_HOME/claude-config/projects/`（全部 `*.jsonl`） | **task 的完整会话在这里，不在 DB 里**，见 [04-任务详情页](04-task-detail.md) 的会话转录段 |

- **环境变量**：`AGENT_ORCH_DB`（源 DB）、`AGENT_ORCH_HOME`（默认 `$HOME/.agent-orchestrator`，取其 `claude-config/projects`）、`AGENT_ORCH_BACKUP_DIR`（默认 `/mnt/e/wsl_files_backup/agent-orchestrator`）、`AGENT_ORCH_RETAIN_DAYS`（默认 30，两种产出物同样清理）。
- **注意**：
  - DB 用 `sqlite3 .backup` 取快照，**平台运行中也安全**；🔴 直接 `cp` 会因 WAL 撕裂丢已提交数据。
  - **`uploads/`（用户上传的附件文件）不在 backup-db.sh 备份内** —— 由 `backup-wsl-env.sh` 接管（含明文凭证 chmod 600）。若只跑 backup-db.sh，换机后附件 404。
  - transcript 目录不存在（全新机器、还没跑过任务）只提示不报错；打包失败也不会带崩 DB 备份。
  - 验证备份真的完整：`tar -tzf transcripts-*.tar.gz | grep -c '\.jsonl$'` 应等于 `find $ORCHESTRATOR_HOME/claude-config/projects -name '*.jsonl' | wc -l`。

### 功能点：backup-wsl-env.sh - 备份 WSL 环境（env + 仓库 + 附件 + pm2）

- **是什么**：与 `backup-db.sh` 职责分离 —— 本脚本只做「环境」类备份：仓库源码、用户附件、明文凭证、pm2 配置。runbook §2 迁移检查表里 9/11 项空缺都从这里补齐。
- **怎么用**：
  ```bash
  # 直接跑（用默认路径，WSL 默认 = ~/workspace/agent-orchestrator + ~/.agent-orchestrator + ~/.pm2 → /mnt/e/wsl_files_backup/agent-orchestrator）
  scripts/backup-wsl-env.sh

  # cron（WSL 每天 02:30，与 backup-db.sh 01:30 错开 1 小时；须以 damo 用户跑）
  30 2 * * * /home/user/workspace/agent-orchestrator/scripts/backup-wsl-env.sh >> ~/.agent-orchestrator/backup.log 2>&1
  ```
- **产出四个文件**（全部 `chmod 600`）：

  | 文件 | 内容 | 为什么需要 |
  |---|---|---|
  | `uploads-<TS>.tar.gz` | `$ORCHESTRATOR_HOME/uploads/` 全部用户上传（图片/PDF 等） | DB 里有附件记录但文件丢了 = 附件 404 |
  | `repo-<TS>.bundle` | `git bundle create --all` —— 全部分支 + tag + working tree 改动 | 代码已 push，但**本地未提交改动** + 私有分支靠它恢复。`git clone repo-xxx.bundle` 还原 |
  | `secrets-<TS>.tar.gz` | `.env.local` + `.env.wsl.secret` + `ecosystem.local.config.cjs` + `ecosystem.wsl.config.cjs` | **含明文凭证**（JWT_SECRET / ENCRYPTION_KEY / WECOM_* / SMTP_*）；不在 git；不备 = 换机后平台启动但全部静默失效 |
  | `pm2-dump-<TS>.pm2` | `~/.pm2/dump.pm2`（含 env / args / cwd） | 跨机恢复 pm2 进程注册；dump 内有绝对路径，需先建目录再 cp |

- **环境变量**：`WSL_REPO_DIR`（默认 `~/workspace/agent-orchestrator`）、`WSL_ORCH_HOME`（默认 `~/.agent-orchestrator`）、`WSL_BACKUP_DIR`（默认 `/mnt/e/wsl_files_backup/agent-orchestrator`，与 backup-db.sh 一致）、`WSL_PM2_DIR`（默认 `~/.pm2`）、`WSL_RETAIN_DAYS`（默认 30）。
- **注意**：
  - 🔴 **`secrets-*.tar.gz` 含明文凭证**：备份目录 `chmod 700` + 每个产物 `chmod 600`。**不要**放到任何能被多账号读到的位置；若需更强保护，外层包一层 GPG 或移到加密盘。
  - 任一项失败（uploads 缺 / 不是 git 仓库 / pm2 没 dump）只 warn，不阻断整体 —— 已落地的产物保留。
  - **WSL 上才需要跑**（pulu 的 ORCHESTRATOR_HOME 不同，用 `WSL_ORCH_HOME=/home/orchestrator/.agent-orchestrator` 覆盖）。
  - **一定要和 backup-db.sh 一起跑**：单跑这个 → 没有 DB；单跑 backup-db.sh → 没有 env / 附件 / 仓库源码。
  - 验证产物：每项最后一行 `✅ <file>`；`git bundle verify repo-*.bundle` 验证 bundle 完整。

### 功能点：login.sh - 共享鉴权

- **是什么**：被其他脚本 `source` 的共享库，提供环境检测 + 鉴权解析 + `ao_curl` 包装。
- **怎么用**：
  ```bash
  source scripts/login.sh
  ao_init_env                 # 设置 AO_DEF_BASE / AO_DEF_EMAIL / AO_DEF_PASS
  ao_resolve_auth             # 设置 AO_AUTH / AO_AUTH_MODE（失败则 exit 1）
  ao_curl GET /api/schedules  # 自动带鉴权 + base + json header
  ```
- **注意**：
  - `login.sh` 是被 source 的库，不直接执行。
  - 必须与其他脚本同目录，或设 `AO_LOGIN_SH` 环境变量指向其绝对路径。
  - 鉴权优先级：`AO_TOKEN`（`ao_` bearer，不过期）> `AO_EMAIL`+`AO_PASSWORD` > 环境检测内置默认。

### 功能点：who-touched.sh - 反查「哪些历史 task 改过这个文件」(whoTouchedThis V2)

- **是什么**：走平台 `GET /api/tasks/who-touched` 反查「这个文件以前被哪些 task 改过」，按 `completed_at` 倒序展示。给 agent 按需感知代码历史用（不确定代码当前约束 / 想看历史决策 / 涉及可能改动的已存在逻辑时）。
- **怎么用**：
  ```bash
  # 文件路径 + project_id (必填), --lookback N (默认 90d, 1-365), --limit N (默认 5, 1-50)
  ao who-touched src/lib/db/task-commits.ts <project_uuid>
  ao who-touched src/lib/db/x.ts <project_uuid> --lookback 30 --limit 10
  ```
- **数据来源**：服务端跑 `git diff base..head --name-only -- <file>`，派生自 `tasks.base_commit` + `tasks.head_commit`（任务起止时由 orchestrator 自动记录，**不依赖 agent opt-in / marker** —— R113 marker adoption 实测 0%）。91.8% 已有任务直接可查。
- **注意**：
  - **与 `ao recall` 的分工**：`ao recall` 按 keyword 跨源搜（任务 / 需求点 / 飞书 / 项目文档），是关键词匹配；`ao who-touched` 是按文件路径反查具体 task，是 git diff 派生。两者互补。
  - **只看 task 列表**：要看 task 决策完整内容（prompt + result）走 `GET /api/tasks/[id]`。两接口职责不重叠。
  - **过滤**：软删 / failed / reviewing task 已自动过滤，只返 `status='completed'`。
  - **跨 owner**：admin role 可看任意 owner 的 project，普通用户看别人的 project 返 404（不暴露存在性）。
  - **graceful fallback**：task.cwd 不可访问 / 非 git 仓 / head 不可达 → 静默跳过该候选，不抛 5xx（用 `git diff --` 自带 shell escape 阻断路径注入）。
- **实现原理（开发者参考）**：`src/lib/git/task-history.ts` 用 `execFileSync("git", ["-C", cwd, "diff", "--name-only", base..head, "--", file])` 派生；LRU 缓存 key = `${cwd}::${base}..${head}::${file}`，1024 上限。lib 测试 `src/lib/git/task-history.test.ts`（13 条）；route 测试 `src/app/api/tasks/who-touched/route.test.ts`（18 条）。10 维度验证脚本 `scripts/validate-who-touched-v2.sh`（基于生产数据）。

### 功能点：AI / 外部脚本一键登录

> **Agent SDK 子进程已自带 AO_TOKEN**：从 v52 起，平台 `buildEnv` 会在 agent SDK 启动时自动注入当前 task owner 的不过期 bearer token 作为 `AO_TOKEN`。子进程里直接 `curl -H "Authorization: Bearer $AO_TOKEN" http://localhost:13000/api/...` 即可调用平台 API，无需 `source login.sh`、无需 cookie jar、无需 refresh。详见 [§10-设置 → API Token](./10-settings.md) 与 [`docs/cli-tools.md`](../cli-tools.md)。

- **是什么**：AI / 外部脚本接入平台 API 的两种 token 来源，两模式完全兼容。
- **怎么用**：
  ```bash
  # 模式 A：环境变量直接给（适合 CI、长期集成、外部脚本）
  export AO_TOKEN=ao_xxx      # 从设置页「API Token」卡复制；永久不过期
  ao_curl GET /api/tasks/<id>/transcript

  # 模式 B：邮箱密码换（适合临时调试、一次性脚本）
  AO_EMAIL=me@x.com AO_PASSWORD=xxx ao_curl GET /api/tasks/<id>/transcript
  # ao_curl 内部自动走 login → 拿 cookie，但 token 是一次性的 session（7 天）

  # 模式 C：手动换 token 复用（推荐 — 一次换、永久用）
  user.sh token --name "my-ai-script"
  # → 输出 ao_xxx，复制 → export AO_TOKEN=ao_xxx（环境变量优先级最高）
  ```
- **注意**：
  - **优先级**：`AO_TOKEN` > `AO_EMAIL`+`AO_PASSWORD` > 环境检测内置默认。设了 `AO_TOKEN` 之后，另两个被忽略。
  - **agent SDK 子进程**：v52+ 已自动注入 `AO_TOKEN`（task owner 的「switch-account」token；越权拿不到其他账号）。子进程**不需要** `source login.sh`。
  - **普通账号的 token 就是普通账号的**：拿不到管理员 token。详见 [§10-设置 → API Token](./10-settings.md)。
  - **token 不会自动泄露**：API token 是 bearer 等价物；只在 owner 自己的进程里注入，不会跨 task 串。
  - 拿 token 方式：`source scripts/.env.tokens` 后 `export AO_TOKEN=$MAC_ADMIN_TOKEN`，或 `user.sh token` 现场生成。
- **实现原理（开发者参考）**：`active-session.ts` 的 `buildEnv()`（已改 async，3 处 `await`）复用 `issueSwitchToken(this.userId)` 拿「switch-account」token（无则建 / 有则复用，**永远只给本账号**）注入 `AO_TOKEN`；失败 `try/catch` + `delete env.AO_TOKEN` 兜底，set 前先 delete 防平台进程残留值透传。回归测试 `agent-env-isolation.test.ts`（4 条：注入 / 复用不攒行 / 残留覆盖 / 跨 user 隔离）。

### 功能点：环境自动检测

- **是什么**：根据 `whoami` 和 `WSL_DISTRO_NAME` 自动判断当前环境，选择默认 API 地址。
- **怎么用**：无需手动配置，脚本自动检测。
  | 检测条件 | 环境 | 默认平台 |
  |---------|------|---------|
  | `whoami` = orchestrator | Pulu | `localhost:13000` |
  | `WSL_DISTRO_NAME` 非空 | WSL | `localhost:13000` |
  | 其他（macOS） | Mac | `https://dao.example.com` → fallback `192.0.2.50:13000` → `localhost:13000`（逐级降级） |
- **注意**：
  - 优先级：`--base`/`--email`/`--password` 命令行参数 > `AO_BASE_URL`/`AO_EMAIL`/`AO_PASSWORD` 环境变量 > 环境检测 > 内置默认。
  - 跨环境连接示例：从 Mac 连 WSL 正式环境，`AO_BASE_URL=http://192.0.2.50:13000 ao-dispatch.sh ...`。
  - 连 Pulu 环境：`AO_BASE_URL=https://ao.example.com AO_PASSWORD=xxx ao-dispatch.sh ...`。
  - 登录失败必有 ❌ 人话报错（含 BASE_URL + 下一步提示），不静默退出。

### 功能点：ao-feedback.sh - 工具问题反馈（2026-10-10 新增）

- **是什么**：踩到平台工具问题（CLI 报错不清 / 默认地址不对 / 行为怪）时，一条命令把问题派成 ao-dev task，由 ao-dev agent 处理。
- **怎么用**：
  ```bash
  ao-feedback "现象一句话"                    # 环境自动采集（时间/机器/env 已脱敏）
  ao-feedback "现象" -d trace.txt             # 附复现 trace；-d - 读 stdin
  ao-feedback "现象" -s ao-dispatch.sh        # 自动带出问题脚本的 md5 版本
  ```
- **注意**：入口 self-document（`--help` / `ao help feedback`）；报告自动脱敏（`*PASSWORD*`/`*TOKEN*`/`*SECRET*` 不进报告）；**别自己改 `~/bin` 共享脚本**，走这个入口。

### 功能点：ao-overview.sh - 项目概览单文件看板（2026-11-01 新增）

- **是什么**：项目详情页第一个 tab「概览」那份 markdown 看板的 CLI 入口 —— **人写的和 agent 写的是同一个文件**（DB 加密存，`key = overview_md`），所以 agent 拿项目现状不用开浏览器，人在页面改完 agent 立刻读得到。
- **怎么用**：
  ```bash
  ao overview show ao-dev              # 读，stdout = 纯 markdown（无杂音，可直接管道）
  ao overview edit ao-dev /tmp/x.md    # 用文件覆盖
  ao overview set  ao-dev /tmp/x.md    # 同 edit（别名）
  ao overview append ao-dev /tmp/y.md  # 追加（不覆盖原文）
  ao overview clear ao-dev             # 删掉
  ao overview url ao-dev               # 打印页面 URL
  ```
- **项目标识**：完整 UUID / 完整项目名 / 名称的唯一子串均可；口径与 `ao-dispatch.sh` 同款四级解析（精确 > 别名 > 大小写不敏感 > 子串唯一）。**多义拒绝执行**并列出候选，不猜。
- **注意**：
  - stdout 只吐正文（`show`），提示信息走 stderr —— `ao overview show X > status.md` 拿到的是干净 markdown。
  - 概览存在 DB 并加密，**凭据不进 git**；页面与 CLI 是同一份数据，不分叉。
  - 大小上限 64 KiB（后端 400 拒绝，不截断）。
  - 平台内跳转写法：`task:任务ID` / `project:{UUID}?path=相对路径` / 相对 `.md` 路径 / 裸 URL（外部）。详见 [02-项目与版本](./02-projects.md) §项目概览看板。

## 常见问题

**Q: 脚本报 "鉴权失败" 怎么办？**
A: 检查 `AO_TOKEN` 是否设置且有效，或 `AO_EMAIL`/`AO_PASSWORD` 是否正确。可用 `user.sh login` 验证凭据。也可用 `user.sh token --name "xxx"` 生成新 bearer token 后 `export AO_TOKEN=<token>`。

**Q: 项目名和项目 ID 用哪个？**
A: 用 `-p 名称` 会自动查询项目 ID，适合交互使用。高频调用脚本建议用 `--project-id UUID` 跳过查询。项目 ID 可能变更，用名称最安全。

**Q: 把会话导出再导入，等于"在另一台机器上接着聊"吗？**
A: **不等于**。导入后是**全新 session**，导出的会话只是 agent 读到的一份材料——它能引用里面的事实、能接着往下干，但平台层面这是另一个 task、另一个 `session_id`，费用和轮次都从零算。真正的"续上同一个会话"只有同机 resume（`session_id` 还在时平台自动做，比如维护模式恢复）。

**Q: 为什么导出的会话比我在页面上看到的少？**
A: 三种可能：① 用了默认 `summary`（丢 thinking、`tool_result` 截 2000 字）→ 加 `--full`；② 对端实例还没部署 2026-08-12 的变更，返回的是 `events` 表的稀疏日志（判断：首行是 `# Task <uuid> - Session Transcript` 而不是 `# <任务标题>`）；③ SDK jsonl 真的没了（换过机器且只拷了 DB / 手工清过 `claude-config/projects/`），此时平台只能降级回 events。

**Q: 会话备份在哪，多久一次？**
A: `backup-db.sh` 产出 `transcripts-*.tar.gz`（完整会话）+ `orchestrator-*.db.gz`（平台状态），WSL 上挂在每天 01:30 的 cron。⚠️ **`uploads/` 不在备份内**。
