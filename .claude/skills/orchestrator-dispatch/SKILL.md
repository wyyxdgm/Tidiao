---
name: orchestrator-dispatch
description: Dispatch a development task to an agent via the orchestrator platform (13000 production) -- create + start a task on a target repo with a high-quality prompt. Use when the user wants to drive iterative development on agent-orchestrator-bt / -mt / the original repo by assigning tasks to agents, instead of editing code directly.
---

# orchestrator-dispatch

通过 13000 正式平台派发开发任务给 agent，驱动 -mt/原仓库的迭代。本 skill 固化**"怎么派一个高质量任务"的标准**；任务的动态内容（改什么、现状如何）由你实时查证后填入。

## skill 树定位

dispatch 是 skill 树的**核心锚点**（B 类日常 · 派任务）。本 skill 不教怎么注册 / 登录 / 建项目——那是 onboarding / quickstart 的活。

| 你想做 | 跳到哪 |
|--------|--------|
| 第一次用平台 / 不知道从哪开始 | [[orchestrator-onboarding]]（meta-skill · 5 场景决策树） |
| 想跑通 5 分钟 demo | [[orchestrator-quickstart]]（注册→login→建项目→派 hello 任务） |
| 想只查任务状态 / 看 transcript / 看 diff | [[orchestrator-query]] |
| 想 CRUD 项目 / 版本 / 模板 / 角色 | [[orchestrator-manage]] |
| 想派一个高质量开发任务（7 段 prompt 模板） | **本文件**（往下读） |
| 任务卡死了怎么办 | [[orchestrator-stuck]] |
| 想导出/导入会话 / 跨机搬运 | [[orchestrator-session]]（阶段 1 P1，本波未做，下波落仓） |
| 跨源知识检索（任务/需求点/飞书/项目文档） | `bash scripts/ao recall <关键词>`（阶段 1 P1，本波未做） |
| 从模板建项目 | [docs/usage/19-templates.md](../../../docs/usage/19-templates.md) |

完整 skill 树 → [docs/usage/00-skill-tree.md](../../../docs/usage/00-skill-tree.md)。

---

## 平台凭证

| 项目 | 值 |
|------|-----|
| 平台 URL | `${AO_BASE_URL:-http://localhost:13000}`（自托管默认端口 13000） |
| 鉴权方式 | `AO_TOKEN`（不过期 bearer，优先）或 `AO_EMAIL` + `AO_PASSWORD` |
| account 侧 token | 平台 Settings 页「API Token」签发（`ao_` 前缀） |

登录获取 session cookie（不想用 token 时）：
```bash
curl -s ${AO_BASE_URL:-http://localhost:13000}/api/auth/login \
  -X POST -H 'Content-Type: application/json' \
  -d '{"email":"$AO_EMAIL","password":"$AO_PASSWORD"}' \
  -v 2>&1 | grep -i "set-cookie" | sed 's/.*session=//;s/;.*//'
```

> 🟡 **多实例注意**：`localhost:13000` 只会命中本机实例。如果你有多个实例（本机 dev / 服务器 prod），派发前用 `--base` 或 `AO_BASE_URL` 明确指定目标，避免打错库。

**注意**：session token 有效期 7 天，过期需重新登录。project_id/version_id 每次用前 `GET /api/projects` 确认仍存在。

## 何时用

用户要把某项开发工作交给 agent 做（而非你直接改代码）。典型信号："建个 task 修 X"、"派个任务做 Y"、"让 agent 推进 Z"。

## 核心原则：先查现状，再写 prompt

高质量 prompt 的关键不是文笔，是**填入了准确的现状**。派发前**必须**先查：

1. **目标仓库现状**：`git pull` 拉最新、`git log --oneline -5` 看最近 commit、读要改的文件确认现状
2. **依赖现状**：`grep` package.json 确认相关依赖在不在、版本；`ls node_modules/<pkg>` 确认是否真装了（transitive dep 可能被 prune）
3. **端口/DB/部署现状**：确认目标仓库的端口、ORCHESTRATOR_HOME、pm2 实例名（见端口约定：00=正式 01=预览）
4. **平台现状**：目标 project_id / version_id 是否已存在（GET /api/projects 查）；平台 running_count 别占满并发

**不要凭记忆写 prompt 里的现状**--仓库在变，记错就误导 agent。每条"已知坑""现状"都要有依据。

## prompt 必含的 7 个部分（缺一不可）

派发任务的 prompt（POST /api/tasks 的 `prompt` 字段）按以下结构写：

### 1. 身份与工作目录
```
你是 <仓库> 的开发 agent。工作目录已是 <绝对路径>。
```

### 2. 任务目标
一句话说清做什么。如果是系列任务（如 Phase 1 T1-T4），说明这是第几个、依赖谁。

### 3. 依据（必读文档）
列出 agent 要读的文档/文件。指向仓库内的相对路径。例：
- docs/phase-1-progress.md：任务拆解 + 工作流约定（§0）
- docs/multi-tenant.md §3 第 1 期：需求规格
- 参考现有极简风格：src/app/api/projects/route.ts

### 4. 改造点（具体、可执行）
编号列出要改什么、改哪个文件。不要泛泛"实现 X"，要具体到"migration v18 加在 src/lib/db/index.ts MIGRATIONS 末尾，建 X 表（字段 ...）"。**有歧义的地方先给决策或标注"记决策"**，别让 agent 纠结。

### 5. 关键约定
跨任务的统一约定（避免 agent 破坏已有逻辑）：
- userId/ownerId 从哪取（如 `request.headers.get('x-user-id')`）
- 错误码约定（越权 404 不 403，不泄露存在性）
- 不引入哪些依赖（如 express-rate-limit 是 express 中间件 Next.js 用不上）

### 6. 已知坑（实时查证后填入）
这个仓库/环境踩过的坑，**每次实时确认仍适用**再写。bt 仓库常见坑：
- `NODE_ENV=production` 裁 devDeps，加依赖用 `--include=dev`；tsc 用 `./node_modules/.bin/tsc --noEmit`（别用 npx tsc 会误装垃圾包）
- 自测起 dev 前先 `pkill -f "next dev"` 清残留，否则端口占用/数据残留
- 注册自测用全新邮箱（DB 没重置时旧邮箱已存在）
- 端口约定：13000=prod 13001=dev（自测别占用 prod）

### dev 实例自测（改平台自身源码时必读）

- **dev 模式** = `npm run dev`（默认端口 13000；第二个实例用 `PORT=13001 npm run dev`），HMR 热重载，**agent 自测用这个**

自测流程：
1. 改仓库源码 → HMR 自动 pick up，不用 build / 不用 restart
2. API 请求打到 `http://localhost:13000/api/...`（或你的 `AO_BASE_URL`）
3. 注册用全新邮箱（dev 实例的 DB 和正式数据隔离）

**禁止**：不要在 dev 模式跑 `npm run build`（dev 模式不需要），不要动生产实例

### 7. 工作流 + 验证标准 + 收尾
- 工作流：开工前 `git pull --ff-only`；只改本仓库；完成后更新进度文档（勾选状态、填进度明细、补决策记录）；`git commit -m "feat(mt-phase1-T<N>): <简述>"` + `git push origin master`
- 验证标准：**可独立验证的断言**。如"5 次错误密码后第 6 次返 429"、"越权 GET 返 404 不是 200"。弱标准（"让它工作"）不接受。
- 收尾：完成后简述做了什么、验证结果、commit hash、留了哪些待办

### 8. checkpoint 标记（长任务才加，简单 fix 不加）
多步骤/需回退点的任务，在 prompt 里提示 agent 在关键步骤输出 `<checkpoint step=N summary="...">` 标记。active-session 会自动解析写入 checkpoints 表，作为 fork 回退点。模型不会主动写，必须 prompt 里要求。例：
```
【checkpoint】这是多步骤任务。在每完成一个可独立回退的里程碑时（如 migration 完成、核心逻辑写完、自测通过），在输出里写一行 `<checkpoint step=N summary="一句话描述">`（N 递增）。这会自动记录为 fork 锚点，便于后续从某步骤回退重做。
```
简单单点 fix（如改个 UI 组件）不需要 checkpoint。判断标准：这个任务做完后有没有可能"想从中间某步 fork 重做"--有就加，没有就不加。

## 任务参数（POST /api/tasks body）

```python
{
  "title": "<类型>: <简述>",        # 如 "feat: 登录限流" / "fix: 注册页无侧栏"
  "prompt": "<上述 7 部分组装的 prompt>",
  "description": "<一句话，给列表展示用>",
  "project_id": "<目标项目 UUID>",  # 先 GET /api/projects 查，别猜
  "version_id": "<目标版本 UUID>",  # 可选；有 version 就带上
  "cwd": "<目标仓库绝对路径>", # agent 工作目录，必须是平台可访问的路径
  "autoApprove": true,              # bt 信任团队，工具调用自动通过
  "effort": "medium"|"high",        # 简单修 medium，复杂/多文件 high
  "maxTurns": 80|150|200,           # medium→80, high→150-200
  "allowedTools": ["Read","Write","Edit","Bash","Glob","Grep"],  # 不含 WebSearch/Agent，聚焦本仓库
  "tags": ["<分类>"]
}
```

创建后 `POST /api/tasks/<id>/start` 启动。

## 派发后：监控 + 核对（不能甩手）

派发不是结束，是开始。任务启动后：

1. **挂 Monitor 自动监控**：用 Monitor 工具 + `ao-task-watch.sh` 轮询任务状态 + pending dialog，检测 agent 提问/状态变化：
   ```bash
   ~/bin/ao-task-watch.sh <task-id> [base-url]
   ```
   Monitor 检测到 `PENDING_DIALOG`（agent 提问）或 `STATUS:`（状态变化）时会通知你。回复 agent 提问用：
   ```bash
   curl -X POST "${AO_BASE_URL:-http://localhost:13000}/api/tasks/<id>/user-dialog" \
     -H "Content-Type: application/json" \
     -d '{"request_id":"<requestId>","answers":{"<问题文本>":"<选择的label>"}}'
   ```

2. **preflight 自检核对（启动后立刻看）**：每个 task 启动时，`createTask` 会在 prompt 最前面注入一段 preflight 要求 agent 先输 4 行自检。`ao-task-watch.sh` 收到的第一段 assistant 文本应包含：
   ```
   preflight.cwd: <绝对路径>
   preflight.remote: <remote url 或 "none" 或 "no git repo">
   preflight.last_commit: <hash> <message> 或 "no git repo"
   preflight.is_correct: yes | no | unsure
   ```
   **肉眼 / 脚本核对 3 件事**：
   - `cwd` 末段是否匹配派发目标仓库的 basename（如 `agent-orchestrator-bt`、`agent-orchestrator-mt`）
   - `remote` 是不是目标仓库的 git remote（如 `win-git:repos/bt.git`）
   - `last_commit` 是不是派发时该有的（不是远古 commit、不是无关分支）
   
   **错了立刻 cancel + 改派**（不依赖 agent 自律）：
   ```bash
   # cancel 是 running 状态的中断 API；refine 取代旧 reject (reviewing 状态切回 running 让 agent 接着干)
   curl -X POST "${AO_BASE_URL:-http://localhost:13000}/api/tasks/<id>/cancel"
   # 然后重新派发到正确 project（或修 prompt）
   ```
   
   **不会重发 preflight 的场景**（看 SSE 时区分）：refine / pause-resume / scheduled-restart 走 SDK 重放，agent 看到的是 `pending_messages` / `refined_message` 反馈，**没有** preflight 块 —— 第一次启动时已经看过。fork 是新 task → 第一次 resume 仍会再发一次 preflight。

2. **完成后提取 agent 文字总结**：`~/bin/ao-task-text.sh <task-id> 5`（最后 5 条 assistant 文字 = agent 的总结），不只看 result 字段
3. **拉代码核对**：`git pull` + `git show <commit> --stat` 看改了哪些文件，确认符合任务范围
4. **独立验证**（不信 agent 自述）：SSH 到 WSL 起临时 dev 跑验证标准里的断言。用全新数据（重置 DB / 新邮箱）
5. **approve 或 refine**：通过 `POST /api/tasks/<id>/approve`；有问题 `POST /api/tasks/<id>/refine` 带 message 让 agent 接着干（🆕 R131 取代旧 /reject）。等用户介入用 `/await`（reviewing → running 后再点 await 或 agent 主动调）。
6. **部署生效**（若改了 prod 代码）：WSL 上 `git pull && NODE_ENV=production npm run build && pm2 restart <实例名>`
7. **分派下一任务**：系列任务按依赖顺序推进

## 三个仓库的派发参数速查

| 仓库 | project 名 | cwd | pm2 prod 实例 | 端口(prod/dev) |
|------|-----------|-----|--------------|----------------|
| 用途 | 仓库目录（示例） | pm2 实例名（示例） | 端口 |
|------|----------------|-------------------|------|
| 正式 | ~/workspace/my-app | my-app-prod | 13000 |
| 预览 | ~/workspace/my-app-preview | my-app-preview | 13001 |

project_id / version_id **每次 GET 查**，别记死（可能变）。三仓库的 git remote 都是 `win-git:repos/<名>.git`（WSL 内 `git@localhost:repos/<名>.git`）。

## 反模式（别这么派）

- ❌ 不查现状，凭记忆写"已知坑"和"现状"（仓库在变，会误导 agent）
- ❌ prompt 泛泛"实现登录限流"不给具体改造点（agent 会纠结 scope）
- ❌ 验证标准写"让它工作"（无法独立验证）
- ❌ 派完就甩手，不监控不核对（agent 可能 cancel/超时/跑偏）
- ❌ 自己直接改代码而不派 task（用户明确要"通过任务迭代"时，代码改动走 task；只有紧急 fix 或 task 被 cancel 的收尾可直接改并说明）
- ❌ maxTurns 给太小（复杂任务 80 turns 不够，会被 cancel；high 任务给 150-200）

---

## 无人值守波次监控 cron prompt 模板（用户不在场时用）

> **触发**：用户口头委托「推一波 X，要有可看的东西，别问我问题」（编排方视角完整 SOP 见
> **机制**：在 cron 里挂自包含监控轮，每 N 分钟错峰触发，登录→拉列表过滤 project_id→对时换算→判卡
> （running 距 updated_at > 90min 视为卡死）→独立验收→处理 reviewing / failed / 卡死 → 收尾删 cron + notify。
>
> **关键约束**：
> - cron prompt **必须自包含**——不能假设触发时的自己还记得上下文（会话重启就真没了）
> - **双保险**：冷启动源文档（git 跟踪）+ cron prompt
> - 错峰触发：`3-59/N * * * *` 或 `H,M * * * *`，别整点撞别人的 cron

### 模板（参数化占位替换即可）

```bash
# === 监控 cron prompt 模板 ===
# 用法: 复制下面「PROMPT_BEGIN 到 PROMPT_END」整段到 cron.sh create --prompt-file <文件>
# 占位（替换后单引号内文本必须不再含单引号，否则切到 -f 文件模式）:
#   <PROJECT_ID>     项目 UUID（ao-monitor.sh 或 GET /api/projects 拿）
#   <PROJECT_NAME>   项目名（仅日志可读性用）
#   <BASE_URL>       平台地址（默认 http://localhost:13000，或你的 AO_BASE_URL）
#   <WAVE_TAG>       本波标识（如 gx-promo-0828），命名 cron 与子任务用
#   <TASK_IDS>       本波派的 task UUID 列表（空格分隔），用于核对「是不是少了谁」
#   <EXPECT_TEXT>    演示/部署验收的关键词（如 "数据均为模拟"），独立验证用
#   <DEMO_URL>       演示站 URL（WSL 内网 / 公网）
#   <PM2_NAME>       常驻实例名（如 gx-demo）
#   <NOTIFY_RECIPIENT> 通知收件人（邮箱或 webhook），空 = 仅自身

# PROMPT_BEGIN
你是 <PROJECT_NAME> 项目的监控轮 agent，工作目录 $HOME。
本波名称：<WAVE_TAG>。本波派的 task：<TASK_IDS>。

【每轮必做】严格按顺序：

1) 对时与登录
   - `date -u` 拿当前 UTC；本地时间 = UTC + 8h（**不要把 UTC 直接当本地**）
   - `source $HOME/workspace/agent-orchestrator-dev/scripts/login.sh`
   - export AO_BASE_URL='<BASE_URL>'
   - `ao_init_env`; `ao_resolve_auth`

2) 拉列表 + project_id 过滤（**绝不**扫全平台）
   - `bash ~/workspace/agent-orchestrator-dev/scripts/ao-monitor.sh <PROJECT_ID> --base <BASE_URL> --stale-min 90`
   - 看输出：卡死 / reviewing / failed / 在飞 / 终态统计
   - 退出码 1 = 有需处理；0 = 无事；2 = 不可达

3) 对本波 task 列表 (<TASK_IDS>) 逐个 detail 核对：
   - status=completed → 进 #4 验收
   - status=reviewing → 进 #5 批
   - status=running 且 elapsed > 90min → `ao-task-act.sh cancel <8位前缀>` 后用 ao-dispatch.sh 重派（命名 `<WAVE_TAG>-retry-<n>`）
   - status=failed → 看 result 字段，决策重派或换方案
   - status=queued 堆积 > 2 个 → 同 cwd 串行是默认，别慌；不要乱调 parallel_limit

4) 验收（**不信 agent 自述**，独立验证）：
   - 演示/部署任务：`ao-verify-demo.sh <DEMO_URL> --expect-text '<EXPECT_TEXT>' --pm2 <PM2_NAME>`
   - 飞书任务：feishu.sh row-get 读回结构核对（不只看 agent 汇报）
   - 通过 → `ao-task-act.sh approve <8位前缀>`
   - 不过 → `ao-task-act.sh refine <8位前缀> "具体哪条没过"`

5) 收尾（满足**所有**条件才执行）：
   - 本波所有 task 终态（completed / cancelled），无 running / reviewing
   - 演示/部署验收全过
   - **先通知**：`ao query POST /api/notify --data '{...}'`（已配置邮件/飞书机器人时）或手动查看面板
   - **再删 cron**：`cron.sh delete <本 cron id>`（用 `cron.sh list` 查 id）
   - 最后把完成态写进冷启动源文档 + commit + push

【硬约束】
- 不主动调 parallel_limit（串行是特性）
- 不传 maxTurns
- review 阶段问题点用 refine (reviewing → running)；不要用 reject（已删除）
- cancel 只对 running 用；reject 只对 reviewing 用
- 不要重写别人的飞书表行
- 任何「可能 / 也许 / 应该」都改成「已查 X 文件 / 已跑 Y 命令」
- 退出条件严格按 #5，**不要等用户**（用户不在场）

环境回退：
- 工具找不到：export PATH=$PATH:$HOME/workspace/agent-orchestrator-dev/scripts
- 鉴权失败：重新跑 `ao_resolve_auth`，若仍失败 → notify 自己后跳过本轮
# PROMPT_END
```

### 注册示例

```bash
# 写模板到文件（占位已替换）
cat > /tmp/cron-prompt-<WAVE_TAG>.md <<'EOF'
# （上面 PROMPT_BEGIN 到 PROMPT_END 之间的内容）
EOF

# 注册 cron（每 15 分钟错峰 7,22,37,52 分）
cron.sh create --name "wave-monitor-<WAVE_TAG>" \
  --exec-type agent --schedule-type cron \
  --expr "7,22,37,52 * * * *" \
  --project <开发项目名> \
  --title "监控 <WAVE_TAG> 波次" \
  --prompt-file /tmp/cron-prompt-<WAVE_TAG>.md

# 查 cron id（收尾用）
cron.sh list --all | grep <WAVE_TAG>
```

### 反模式（监控 cron 模板别这么写）

- ❌ 让 cron 内 agent 主动 `AskUserQuestion`（用户不在场 = 卡死到天亮）
- ❌ prompt 里没指定 `--stale-min` / `--expect-text` 等口径（agent 会自己拍，导致波次间漂移）
- ❌ 只看 `result` 字段就 approve（playbook #3：list 与 detail 有延迟差，必须独立验证）
- ❌ 不删 cron = 隔天再来一波；不 notify = 用户醒来两眼一抹黑
- ❌ 用整点触发（`0 * * * *`）撞别的 cron（同分打爆数据库）

### 关联

- 监控脚本：[`scripts/ao-monitor.sh`](../../../scripts/ao-monitor.sh)（列表+对时+判卡）
- 任务动作：[`scripts/ao-task-act.sh`](../../../scripts/ao-task-act.sh)（approve/refine/await/unawait/cancel/resolve）
