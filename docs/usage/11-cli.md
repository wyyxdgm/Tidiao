# 11. CLI 工具

> 命令行工具集：派发任务、实时聊天、定时任务管理、用户维护、共享鉴权。

## 概述

编排平台的 CLI 由统一入口 `scripts/ao` 路由到各子脚本：`ao <子命令>` 等价于 `bash scripts/<对应脚本>`，`ao help` 列出全部子命令，`ao doctor` 自检脚本齐全。底层脚本共享 `login.sh` 鉴权库，默认打 `http://localhost:13000`，可用 `AO_BASE_URL` / `--base` 切换目标实例。鉴权走 `AO_TOKEN`（不过期 bearer）或 `AO_EMAIL` + `AO_PASSWORD`，CLI 不内置任何凭据。依赖 `curl` + `python3`；bash 3.2（macOS 自带）可用，个别脚本注明需要 bash 4+。

```bash
# 直接跑
bash scripts/ao dispatch -p my-project -t "标题" -m "prompt"

# 软链到 PATH（推荐）
ln -s "$(pwd)/scripts/ao" ~/bin/ao


### 功能点：ao-dispatch.sh - 任务派发

- **是什么**：从命令行创建并启动任务，支持等待完成。
- **怎么用**：
  ```bash
  # 基本用法（创建+启动）
  ao-dispatch.sh -p 项目名 -t "任务标题" -m "详细 prompt"

  # 从文件读取长 prompt
  ao-dispatch.sh -p my-project -t "fix: 邮件超时" -f /tmp/task-prompt.md

  # 高 effort + 自动审批 + 等待完成
  ao-dispatch.sh -p my-project -t "重构引擎" -m "..." \
    --effort high --max-turns 150 --auto-approve --wait

  # 只创建不启动
  ao-dispatch.sh -p my-project -t "待办" -m "..." --no-start

  # 带标签
  ao-dispatch.sh -p my-project -t "fix: bug" -m "..." --tags bug,urgent
  ```
- **注意**：
  - 必填参数：`-p`（项目名或 `--project-id UUID`）、`-t`（标题）、`-m`（prompt，或 `-f` 从文件读取）。
  - 可选参数：`-v`/`--version`（版本名）、`--version-id`、`--cwd`、`--effort`（low/medium/high/xhigh/max，默认 medium）、`--max-turns`（默认 80）、`--auto-approve`、`--no-start`、`--wait`、`--tags`（逗号分隔）、`--from-task`（上游派发方 task id）、`--why`（派发这个任务的「为什么」，自由文本）、`--kind`（5 选 1 价值枚举：`unlock_capability` / `fix_bug` / `document_knowledge` / `advance_requirement` / `investigate`，自由字符串也允许落库）。
  - **`--from-task` UUID 校验 + 降级**（0826 P1）：传入的值必须是合法 UUID（`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-…$`）。若 `--from-task` 传非 UUID 字符串、或环境变量 `ORCHESTRATOR_TASK_ID` 不是合法 UUID，wrapper 立即降级为不记录派发方 + stderr 打 warn，不再透传到 platform 触发 400。Platform 层（`src/lib/db/tasks.ts` createTask）有同款降级做双保险。跨 owner 引用仍抛错（防越权派发溯源，不放开）。
  - **`--why` 缺失时弹反思提示**（D10 前置门）：交互终端检测 (`[[ -t 0 && -t 1 && -t 2 ]]`) 才弹 5 类模板引导，5 秒内按 Enter 跳过 / `y` 放弃派发；agent 子进程 stdin 已闭 → 自动跳过不打顿。设计动机 = 后置 LLM 反思命中率低，改为派发那一瞬 dispatcher 记录为什么。
  - `--wait` 会阻塞并 30 秒轮询直到任务进入终态。
  - Agent 在执行任务时也可用此脚本派发子任务。
  - **如何选择 `--kind`**（派发时的自问分类）：
    - `unlock_capability` — 解锁后续能力（"以后不用重写"），杠杆最大，优先选这个
    - `fix_bug` — 修 bug（"没有它会出什么事"）
    - `document_knowledge` — 沉淀知识（"下次谁会需要"）
    - `advance_requirement` — 推进某条需求点（"完成后能解锁什么"）
    - `investigate` — 探索未知（"找到答案后下一步是什么"）

### 功能点：ao-chat.sh - 交互式聊天

- **是什么**：与编排平台任务实时对话，SSE 流式输出 + 终态自动激活。
- **怎么用**：
  ```bash
  # 模式 1：与已有任务聊天
  ao-chat.sh <task-id>

  # 模式 2：新建任务并聊天
  ao-chat.sh -p my-project -t "修复邮件发送" -m "修复 SMTP 超时..."
  ao-chat.sh -p my-project -v v1.6 -t "feat: 导出" -m "..." --auto-approve
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
    --expr "0 9 * * *" --project my-project --title "巡检" --prompt "检查状态并汇报"

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
  - `user.sh token` 是单环境便捷版；多环境各自跑一次即可。

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
  ao-session.sh import /tmp/a.md --new -p my-project -t "接手：修复 SMTP 超时"

  # 跨机器一步到位（= export 到临时文件再 import）
  ao-session.sh transfer <src-task-id> --from prod --new -p my-project -t "接手 xxx"
  ```
- **注意**：
  - 🔴 **这不是 SDK resume**。导入后目标 task 是全新 `session_id`，历史只是 agent 读到的一份材料——它能引用、能接着干，但不是"同一个会话续上"。
  - **两种 verbosity**：默认 `summary` 丢弃 thinking、`tool_result` 截到 2000 字（长任务原样导出轻易超 attachments 的 10MB 上限，且 thinking 对接手上下文几乎无用）；`--full` 逐字保留。
  - **`--format jsonl`** 一律逐字（`--full` 对它无效），是"存档"格式，不是能被 SDK resume 的 transcript。
  - **导出的完整性依赖对端已部署 2026-08-12 的变更**。老版本返回的是 `events` 表的稀疏日志（HTTP 200，不报错，只是内容残缺约 4/5）。判断方式：文件首行是 `# <任务标题>` = 新版；`# Task <uuid> - Session Transcript` = 老版。
  - 超 10MB 时 `export` 会告警但仍落盘，导入会被服务端拒（415/413）——改用默认 `summary`。
  - `--env` / `--from` 可选 `local` / `wsl` / `remote`（`pulu` 兼容别名）；远程实例需 `AO_TOKEN` 或 `AO_EMAIL`+`AO_PASSWORD`，地址用 `AO_REMOTE_BASE` 配。

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

### 功能点：AI / 外部脚本一键登录

> **Agent SDK 子进程已自带 AO_TOKEN**：从 v52 起，平台 `buildEnv` 会在 agent SDK 启动时自动注入当前 task owner 的不过期 bearer token 作为 `AO_TOKEN`。子进程里直接 `curl -H "Authorization: Bearer $AO_TOKEN" http://localhost:13000/api/...` 即可调用平台 API，无需 `source login.sh`、无需 cookie jar、无需 refresh。详见 [§10-设置 → API Token](./10-settings.md)。

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
  - **优先级**：`AO_TOKEN` > `AO_EMAIL`+`AO_PASSWORD`。设了 `AO_TOKEN` 之后，另两个被忽略。
  - **agent SDK 子进程**：v52+ 已自动注入 `AO_TOKEN`（task owner 的「switch-account」token；越权拿不到其他账号）。子进程**不需要** `source login.sh`。
  - **普通账号的 token 就是普通账号的**：拿不到管理员 token。详见 [§10-设置 → API Token](./10-settings.md)。
  - **token 不会自动泄露**：API token 是 bearer 等价物；只在 owner 自己的进程里注入，不会跨 task 串。
  - 拿 token 方式：`user.sh token` 现场生成，或在 Settings 页「API Token」卡复制。
- **实现原理（开发者参考）**：`active-session.ts` 的 `buildEnv()`（已改 async，3 处 `await`）复用 `issueSwitchToken(this.userId)` 拿「switch-account」token（无则建 / 有则复用，**永远只给本账号**）注入 `AO_TOKEN`；失败 `try/catch` + `delete env.AO_TOKEN` 兜底，set 前先 delete 防平台进程残留值透传。回归测试 `agent-env-isolation.test.ts`（4 条：注入 / 复用不攒行 / 残留覆盖 / 跨 user 隔离）。

### 功能点：目标实例切换

- **是什么**：所有脚本默认打 `http://localhost:13000`（自托管默认端口），连远程实例用环境变量切换。
- **怎么用**：
  ```bash
  # 本机实例（默认）
  bash scripts/ao query GET /api/projects

  # 远程自托管实例
  AO_BASE_URL=https://your-host AO_EMAIL=you@example.com AO_PASSWORD=xxx \
    bash scripts/ao dispatch -p my-project -t "标题" -m "..."
  ```
- **注意**：
  - 优先级：`--base`/`--email`/`--password` 命令行参数 > `AO_BASE_URL`/`AO_EMAIL`/`AO_PASSWORD` 环境变量 > 默认 `localhost:13000`。
  - `ao-session.sh` 的 `--env` 预设地址用 `AO_LOCAL_BASE` / `AO_REMOTE_BASE` 覆盖。
  - 登录失败必有 ❌ 人话报错（含 BASE_URL + 下一步提示），不静默退出。

### 功能点：ao-feedback.sh - 工具问题反馈（2026-10-10 新增）

- **是什么**：踩到平台工具问题（CLI 报错不清 / 默认地址不对 / 行为怪）时，一条命令把问题派成开发项目的 task。默认找名含 `ao-dev` 的项目，`AO_FEEDBACK_PROJECT` 环境变量可改匹配关键词，`AO_FEEDBACK_PROJECT_ID` 可直接指定项目 UUID。
- **怎么用**：
  ```bash
  ao-feedback "现象一句话"                    # 环境自动采集（时间/机器/env 已脱敏）
  ao-feedback "现象" -d trace.txt             # 附复现 trace；-d - 读 stdin
  ao-feedback "现象" -s ao-dispatch.sh        # 自动带出问题脚本的 md5 版本
  ```
- **注意**：入口 self-document（`--help` / `ao help feedback`）；报告自动脱敏（`*PASSWORD*`/`*TOKEN*`/`*SECRET*` 不进报告）。

### 功能点：ao-overview.sh - 项目概览单文件看板（2026-11-01 新增）

- **是什么**：项目详情页第一个 tab「概览」那份 markdown 看板的 CLI 入口 —— **人写的和 agent 写的是同一个文件**（DB 加密存，`key = overview_md`），所以 agent 拿项目现状不用开浏览器，人在页面改完 agent 立刻读得到。
- **怎么用**：
  ```bash
  ao overview show my-project          # 读，stdout = 纯 markdown（无杂音，可直接管道）
  ao overview edit my-project /tmp/x.md    # 用文件覆盖
  ao overview set  my-project /tmp/x.md    # 同 edit（别名）
  ao overview append my-project /tmp/y.md  # 追加（不覆盖原文）
  ao overview clear my-project             # 删掉
  ao overview url my-project               # 打印页面 URL
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

**Q: 会话备份在哪？**
A: 完整会话不在 DB 里，在 `$ORCHESTRATOR_HOME/claude-config/projects/` 的 `*.jsonl`（SDK transcript）。用 `ao-session.sh export` 可导出单个任务；整机备份请自行打包 DB + 该目录。
