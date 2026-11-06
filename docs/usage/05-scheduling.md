# 5. 定时任务

> 到点自动创建并启动任务或执行 shell 命令，跟随系统启动，无需外部 cron。

## 概述

定时任务（Schedule）是一条"到点该做什么"的规则。到了触发时间，平台按规则创建一次执行实例：agent 类型复用现有任务生命周期（createTask + startTask），shell 类型直接执行命令。调度器随 Next.js 服务启动，每 60 秒轮询一次，分钟级精度。

### 功能点：定时类型（cron 周期 / once 一次性）

- **是什么**：每条 schedule 有两种调度模式--`cron`（重复周期）和 `once`（一次性）。
- **怎么用**：创建时通过 `schedule_type` 字段指定。
  - `cron`：`schedule_expr` 为标准 5 段 cron 表达式（`分 时 日 月 周`），如 `0 9 * * *`（每天 9 点）、`*/5 * * * *`（每 5 分钟）。平台用 cron-parser 计算下一次触发时间。
  - `once`：`schedule_expr` 为 ISO 时间字符串，如 `2026-08-06T03:00:00Z`。到点触发后 `enabled` 自动置为 `false`（一次性，不重复）。
- **注意**：cron 表达式的时区由 `timezone` 字段决定（见下方时区功能点）。

### 功能点：执行体（agent / shell）

- **是什么**：schedule 到点后"做什么"分两种执行体--`agent`（派给 Claude Code）和 `shell`（直接执行命令）。
- **怎么用**：创建时通过 `exec_type` 字段指定。
  - **agent**：到点后调用 `createTask()` + `startTask()`，创建一个任务并入队调度器。必填字段：`name`、`project_id`、`title`、`prompt`。可选继承字段：`version_id`、`priority`、`cwd`、`auto_approve`、`model`、`allowed_tools`、`max_turns`、`effort`、`tags`。生成的任务与手动创建的任务完全等价，受并发控制、per-cwd 互斥约束。
  - **shell**：到点后用 `child_process.exec()` 直接执行命令，不进任务队列。必填字段：`name`、`command`。可选：`cwd`（默认为 `ORCHESTRATOR_HOME`）。执行超时 10 分钟（超时 exit_code=124），stdout/stderr 截断 64KB 存储。
- **注意**：shell 类型不走 agent 生命周期，没有任务详情页；查看结果只能看触发历史中的 output/exit_code。

### 功能点：自适应频率 — 时间区间 + AI 自调频（飞书 AO-DEV R93，v60）

- **是什么**：agent + cron schedule 可设 `freq_min_minutes` / `freq_max_minutes` 两个字段，启用后 **agent 每轮必须自选下次 cron 表达式**（落在 `[min, max]` 分钟区间内），并通过 `cron.sh update` 落库。平台用 A/B 校验 + 飞书 webhook 警告兜底。
- **怎么用**：创建 / 更新时传两个字段，**必须都填或都不填**，都填时 `min <= max`，且都是 `>= 1` 整数分钟。
  - CLI：
    ```bash
    cron.sh create --name "价格巡检" --exec-type agent \
      --project agent-orchestrator-dev --title "价格巡检" \
      --prompt "巡检并自选下轮间隔" \
      --schedule-type cron --expr "*/5 * * * *" \
      --freq-min 3 --freq-max 30

    # 更新现有 schedule 启用自适应频率
    cron.sh update <id> --freq-min 3 --freq-max 30

    # 关闭（两个都传空串或不传；只传一个会被后端 400 拒）
    cron.sh update <id> --freq-min '' --freq-max ''
    ```
  - API：POST/PATCH `/api/schedules` body 加 `"freq_min_minutes": 3, "freq_max_minutes": 30`（PATCH 路径同样支持，传 `null` = 关闭）。
  - 启用后 schedule 没特殊标识，**`GET /api/schedules` 返回里看到这两个字段非空** = 已启用。
- **agent prompt 头部会多一段硬指令**（damo 拍板原话，`schedule-adaptive-watcher.ts:60-76`）：
  ```
  [SCHEDULE_ADAPTIVE_HEADER]
  本 schedule 启用了自适应频率模式：每次触发你必须在 [min, max] 分钟区间内自选下次 cron 表达式。
  必须做的事：
  1. 每次回复正文最后一段显式输出 "下次 cron: <expr>"（expr 必须落在 [min, max] 分钟区间内）
  2. 任务收尾前调 cron.sh update <schedule_id> --expr "<新 expr>" 把新表达式落库
  3. expr 落到区间外不会拦截 task 完成, 但会发警告通知 damo, 连续 3 轮不调 → 警告升级
  ```
- **校验机制**（任务完成 / 转 reviewing 时跑）：
  - **校验 A**：把当前 `schedule_expr` 解析成下次触发时刻，算出间隔分钟，不在 `[min, max]` → warn。
  - **校验 B**：比对 task 创建时记录的 `schedule_expr` vs 完成时的 `schedule_expr`，相同 = 这轮没调 → warn。
  - **警告是兜底不是闸门**：不拦截 task 完成，不强制改写 expr（damo 拍板原话）。
  - 命中通过飞书 webhook + email 双渠道警告 owner（owner 没配 webhook 降级 `console.warn`）。
- **注意**：
  - 🔴 **仅 agent + cron schedule 支持**：shell / once 频率区间无意义，后端 400 拒。
  - 🔴 **两字段同时设置或同时清空**：只传一个 = 400（`freq_min_minutes 与 freq_max_minutes 必须同时设置或同时为空`）。
  - 🔴 **CLI flag 名（`--freq-min`）≠ API 字段名（`freq_min_minutes`）**：CLI 已经内部转换，body 直传要走长名。
  - 「本轮 expr 快照」存在 `tasks.metadata.adaptive_snapshots` JSON 数组里（key=`schedule_id`，fire 写 `in 快照` / watcher 校验后写 `out 快照`），不加新表。
  - 完整机制 + 测试 + 演化：`src/lib/runtime/schedule-adaptive-watcher.ts` + `src/lib/db/schedules.ts` 校验段（`v60 自适应频率校验`）。
  - 适用场景：AI 跑巡检 / 监控类任务，繁忙时段自动密、闲时自动疏，比硬编码 cron 灵活。

### 功能点：智能降频 — 夜间自动切低频表达式（飞书 AO-DEV R96，v70）

- **是什么**：cron schedule 可设 `night_start_hour` / `night_end_hour` / `night_schedule_expr` 三个字段，启用后 **平台按 schedule timezone 下当前小时判断：落在夜间窗口时用 `night_schedule_expr` 算 next_run，否则用 `schedule_expr`**。适用「白天高频、晚上低频」的运维 / 监控类定时任务（例：partner-sheetwatch `*/5 * * * *` 白天跑、23-6 点改成 `*/30 * * * *`）。
- **怎么用**：三个字段**要么都填要么都不填**，都填时 `start != end` 且都在 `[0, 23]`，且 `night_schedule_expr` 是合法 cron 表达式。
  - CLI：
    ```bash
    # 给已有 schedule 启用夜间降频（partner-sheetwatch 实战）
    cron.sh update <id> --night-start-hour 23 --night-end-hour 6 \
                    --night-expr "*/30 * * * *"

    # 关闭（三个都传空串或不传；只传一两个 = 400 拒）
    cron.sh update <id> --night-start-hour '' --night-end-hour '' --night-expr ''
    ```
  - API：POST/PATCH `/api/schedules` body 加 `"night_start_hour": 23, "night_end_hour": 6, "night_schedule_expr": "*/30 * * * *"`（PATCH 路径同样支持，传 `null` = 关闭）。
  - 启用后 schedule 没特殊标识，**`GET /api/schedules` 返回里看到这三个字段非空** = 已启用。
- **窗口语义**：`[start_hour, end_hour)`（end 不含）；**支持跨午夜**：`start=23, end=6` 表示 23,0,1,2,3,4,5 是夜间小时，6:00 起进入白天。`start == end` = 零长度窗口 = 拒绝（语义无意义）。`start < end` 是不跨午夜的常规窗口（例：9-18 工作时间屏蔽）。小时判定走 `Intl.DateTimeFormat({ hourCycle: "h23", timeZone: schedule.timezone })`，避免 UTC 漂移导致凌晨错位。
- **计算逻辑**（`computeNextRunWithNight`，`schedule-runner.ts:tick` 调用）：
  1. 用 `schedule_expr` 算出 `next1`。
  2. 若 `next1` 落在夜间窗口，改用 `night_schedule_expr` 算出 `next2`，取 `max(next1, next2)` 作为最终 `next_run`。
  3. `max` 而不是 `min` 是为了避免「白天末班跑太密」——如 22:55 `*/5` 算出 `next1=23:00`（刚跨入夜间），夜间 `*/30` 在 23:00 也命中，选较晚时刻让 schedule 自然推进。
  4. `night_schedule_expr` 解析失败 → `console.warn` 后退回 `next1`，**不会**因配错让 schedule 停摆。
- **与 v60 自适应频率的关系**：**两条独立路径**。v60 改 `schedule_expr` 本身（agent 自选），R96 不动 `schedule_expr`、仅在 runner 算 next_run 时按当前时段从两个 expr 中选一个。两者可同时启用（但实际场景重叠度低——一个面向「AI 决策」，一个面向「时段差异化」）。
- **注意**：
  - 🔴 **仅 cron schedule 支持**：once 一次性无窗口意义，shell + cron 是 OK 的（不是只限 agent，shell 也能用）。
  - 🔴 **三字段同时设置或同时清空**：只传 1-2 个 = 400（`night_start_hour / night_end_hour / night_schedule_expr 必须同时设置或同时清空`）。这是为了避免「start=23, end=null」半态落库，PATCH 单边清空时另一边的同步校验会失败。
  - 🔴 **night_schedule_expr 必须落在夜间窗口才有意义**：若 expr 不在窗口内（例如配成 `0 12 * * *` 中午一次），`computeNextRunWithNight` 永远不会切到它，行为退化为原 `schedule_expr`。CLI / API 不强制校验这点（cron-parser 视角下合法），但 description/手测时务必确认。
  - 完整机制 + 测试 + 演化：`src/lib/db/schedules.ts` 校验段（`v70 飞书 R96 智能降频校验`）+ `computeNextRunWithNight` + `isHourInNightWindow` + `src/lib/runtime/schedule-runner.ts:tick`。回归测试 `src/lib/db/schedules.test.ts` v70 段（10 条：isHourInNightWindow / computeNextRunWithNight / create+update 校验）。
  - 适用场景：sheetwatch / 监控 / 飞书 webhook 心跳 / 数据备份 等「白天需要密、晚上可以稀」的纯运维任务；agent 业务类调度请用 v60 自适应频率。

### 功能点：防重派（skip_if_running）

- **是什么**：`skip_if_running` 机制防止同一个 schedule 的活儿堆积——上一次派出的任务没走完，就不派下一次。
- **怎么用**：`skip_if_running` 默认开启。到点触发时按 `tasks.schedule_id` 反查该 schedule 派出的任务，只要还有没走完的就跳过本次（两类 exec_type 都走这条判据）。
  - **终态只有 `completed` / `failed` / `cancelled`**。`reviewing`（干完等验收）、`paused`、`rejected` 都算「还在飞，只是在等人」。
  - shell 类型另有一道进程级闸门：内存 Set 跟踪命令进程，命令自身没跑完不重入。
- **注意**：
  - 🔴 **shell 脚本自己建任务时必须传 `schedule_id`**（`POST /api/tasks` 的字段，只能填自己的 schedule）。不传 = 平台不知道那个任务是这条 schedule 派的 = 闸门对它无效。实测代价：5 天重派 604 次、烧 $206。
  - 反过来，一个停在 `reviewing` 等验收的任务会**挡住后续所有触发**。要无条件每次都派就把 `skip_if_running` 关掉；要解开被僵尸任务卡住的 schedule，把那些任务删掉（软删除的不算在飞）。
  - 跳过会打日志 `[ScheduleRunner] Skip <name>: task <id> still <status>`——「到点没触发」先查这行。
  - 手动触发同样受约束——返回 409，reason 里带上挡路的任务 id + 状态。

### 功能点：cron 卡死体检（`ao stuck`，2026-09-07）

- **是什么**：一条 enabled 的 cron 突然不再触发、`next_run` 冻结在过去、`last_exit_code` 空、UI 无任何报错 —— 多半是被上面那道 `skip_if_running` 闸门挡住了。这个命令把判定做成 exit code，不用手工翻 DB。
- **怎么用**：

  ```bash
  ao stuck                 # 报告：enabled + 过期 >5min + 被非终态任务挡住的 schedule
  ao stuck --fix           # 报告 + cancel 其中 paused 僵尸
  ao stuck --grace 10      # 过期宽限改 10 分钟（默认 5）
  ```

  exit 0 = 无卡死，1 = 有卡死，2 = 环境错。修完 60s 内（runner 下一 tick）自动补触发。
- **注意**：
  - **只自动修 `paused`**。`reviewing` 是等人验收的人工闸门（cancel 会吃掉产物）、`running`/`queued` 是真在飞，这两类只报告。
  - 🔴 **`paused` 类卡死不会自愈**——跟 `reviewing` 不同，没有任何人会来解它。平台重启把任务留在 `paused` 就足以让 cron 永久失语。2026-09-07 实测两条 R6 守护 cron 因此静默 14h+，巡检连续 13 轮误记为「观察中等自愈」。「到点没触发」直接跑 `ao stuck` 定性，别记成观察项。
- **实现原理（开发者参考）**：`scripts/check-stuck-schedules.sh`（终态口径须与 `src/lib/db/tasks.ts:TERMINAL_TASK_STATUSES` 保持一致）；根因链详解见 [`docs/schedules.md`](../schedules.md) §平台重启遗留的 `paused`。

### 功能点：admin 跨 owner 管定时任务

- **是什么**：定时任务默认按 owner 隔离，但 admin 能管别人的（别人的定时任务失控时不用进 DB 改）。
- **怎么用**：admin 对 `GET/PATCH/DELETE /api/schedules/<id>` 及 `/runs` 不受 owner 限制；`GET /api/schedules?all=true` 列出所有人的（CLI：`cron.sh list --all`）。
- **注意**：`?all=true` 是 admin only，普通用户传了会被静默忽略（仍只返回自己的）。创建任务时挂 `schedule_id` **不走这个例外**——只能挂自己的 schedule。

### 功能点：防崩溃重复触发（claimSchedule 原子认领）

- **是什么**：触发前原子推进 `next_run`，确保即使中途崩溃也不会重复触发。
- **怎么用**：调度器在 `tick()` 中对每个到期的 schedule 先调用 `claimSchedule()`，将 `next_run` 推进到下一个未来时间点，然后再执行 fire 操作。如果 fire 过程中崩溃，重启后 `next_run` 已在未来，不会重复触发。
- **注意**：这是单进程 + better-sqlite3 同步事务保证的原子操作，无需分布式锁。

### 功能点：错过的触发（重启补跑）

- **是什么**：停机期间错过的 schedule，服务重启后会补跑一次。
- **怎么用**：调度器在服务启动 5 秒后执行首个 tick，扫描所有 `next_run <= now` 的 schedule。对于停机期间错过的触发，补跑一次后恢复正常节奏。
- **注意**：只补跑一次，不追溯历史所有错过的次数。如果需要"错过即跳"语义，后续可加 `catch_up` 选项（当前未实现）。

### 功能点：手动触发

- **是什么**：不等待调度时间，立即执行一次 schedule。
- **怎么用**：调用 `POST /api/schedules/<id>/runs`，立即触发执行。
  ```bash
  curl -X POST -H "Authorization: Bearer $TOKEN" \
    http://localhost:13000/api/schedules/<id>/runs
  ```
  返回 `{"ok":true,"task_id":"..."}`（agent）或 `{"ok":true}`（shell）。
- **注意**：
  - 手动触发**不影响正常节奏**--不推进 `next_run`、不禁用 once schedule、不改 `enabled` 状态。
  - 即使 `enabled=false` 的 schedule 也能手动触发（手动是显式行为）。
  - `skip_if_running` 仍生效，上一次派出的任务还没走完时返回 409。

### 功能点：时区

- **是什么**：schedule 的 `timezone` 字段控制 cron 表达式的解析时区。
- **怎么用**：创建时通过 `timezone` 字段指定，默认 `Asia/Shanghai`。值应为 IANA 时区标识符（如 `UTC`、`America/New_York`）。
- **注意**：`once` 类型的 `schedule_expr` 是 ISO 时间（含时区偏移或 Z 后缀），不受 `timezone` 字段影响。

### 功能点：触发历史

- **是什么**：每次触发都会在 `schedule_runs` 表中记录一条运行实例。
- **怎么用**：
  - UI `/schedules` 列表页展示每条 schedule 的上次触发时间、上次结果（shell 显示 exit code 徽章、agent 显示上次任务链接）。
  - API 查询：`GET /api/schedules/<id>/runs` 返回该 schedule 的触发历史。
  - agent 类型记录 `task_id`（可点击跳转到任务详情页）。
  - shell 类型记录 `command`、`output`、`error`、`exit_code`。
- **注意**：shell 输出截断 64KB 存储，防止 SQLite 膨胀。

### 功能点：列表页与启停

- **是什么**：`/schedules` 页面展示所有定时任务，支持启用/停用切换。
- **怎么用**：访问 `/schedules`，每条 schedule 卡片显示名称、类型（agent/shell）、调度表达式、下次触发时间、上次触发时间。**操作按钮组（触发历史 / 编辑 / 启用·停用 / 删除）位于卡片头部内容区右下角，hover 卡片或键盘 focus 任一按钮时才横向展开成一排；非 hover 状态显示一个 `⋯` 占位**（飞书 R86 二期 + 三期，详见下条）。
- **注意**：⚠️ 旧版（v68 之前）UI 只做列表 + 启停，新建/删除走 API；R68 v2 起 UI 同时支持「+ 新建定时任务」按钮和「删除」按钮（删除走 `DELETE /api/schedules/[id]` 二次确认）。脚本/批量场景仍推荐走 `cron.sh create/delete`。

### 功能点：UI 编辑入口（飞书 AO-DEV R86）

- **是什么**：在每条 schedule 卡片加「编辑」按钮，弹出 `EditScheduleModal`，复用新建表单字段，预填当前值，提交走 `PATCH /api/schedules/[id]`。
- **怎么用**：
  - 触发：hover 卡片让按钮组横向展开 → 点「编辑」→ modal 打开（任务名 / 时区 / 调度类型 / 调度表达式 / 描述 / 执行体专属字段全部可改）。
  - 保存：点「保存」→ 调 `PATCH /api/schedules/<id>` → 后端回写 → 前端 `setSchedules` 局部更新（避免重拉列表）。
  - 取消：点「取消」或点击 backdrop 关闭。
- **注意**：
  - 「执行体」字段**不可改** —— 后端 PATCH 白名单 (`UPDATABLE_SCHEDULE_FIELDS`) 不含 `exec_type`，UI 改成只读 label（避免「UI 改了但保存无效」的反模式）。同理「创建时间」「上次触发时间」等不可改字段也不在表单里出现。
  - 与新建共用 `ScheduleFormFields` 子组件，~100 行 JSX 不复制漂移。
  - 权限：非 admin 只能编辑自己创建的 schedule（其他 owner 返 404 不暴露存在性）；admin 可跨 owner 编辑但 `owner_id` 保持不变。
  - 后端契约没改 —— R86 是纯前端入口补齐，`PATCH /api/schedules/[id]` 早已支持 20 字段白名单 + 未知键返 400。
  - 8 条端到端单测在 `src/lib/db/schedules-edit-flow.test.ts`：跨 owner 隔离 / exec_type 边界 / 多字段同时 PATCH / schedule_type 切换 / description 边界全覆盖。

### 功能点：卡片操作按钮 hover 横向展开（飞书 AO-DEV R86 二期）

- **是什么**：4 个操作按钮（触发历史 / 编辑 / 启用·停用 / 删除）从原来的右侧垂直堆叠改为头部内容区右下角绝对定位 + 横向一排，默认 `opacity-0` + `pointer-events-none` 隐藏；hover 卡片或键盘 focus 任一按钮时渐显成一排，非 hover 状态显示一个 `⋯` 占位。
- **怎么用**：鼠标移到任意 schedule 卡片 → 卡片头部内容区右下角浮出 4 个按钮横向排列 → 点对应按钮触发操作；离开卡片 → 渐隐回 `⋯` 占位。键盘 Tab 也能进入按钮组（`focus-within` 同步触发显示）。
- **注意**：
  - 改动纯 CSS / 布局，没碰按钮 onClick / 业务逻辑 —— 4 个按钮（触发历史 / 编辑 / 启停 / 删除）的行为完全不变。
  - 绝对定位让卡片左侧内容区域不再被按钮列挤压，标题 + description + 时间信息可用宽度更大。
  - `pointer-events-none` 默认关，避免透明按钮拦截下方 description 点击（点击展开 / 折叠）。
  - RunsPanel（飞书 R75 触发历史面板）展开时正常显示，按钮组锚定在头部内容区，不盖 RunsPanel。
  - 🆕 **R86 三期**：把头部内容 + 按钮组包在同一个 `relative` 容器里，RunsPanel 移出这个容器成为卡片 div 的直接子元素。根因：二期按钮组 `absolute bottom-3 right-3` 锚到卡片 div 右下角，RunsPanel 展开后卡片高度增加时按钮组落在 RunsPanel 右上角，盖住「上一页 / 下一页」翻页按钮。三期把按钮组锚到头部内容区右下角，RunsPanel 自然排在按钮组下方，不再被覆盖。视觉位置一致（仍 `bottom-3 right-3`），纯结构改动。

### 功能点：UI 新建与删除（飞书 AO-DEV R68 v2）

- **是什么**：`/schedules` 页右上角「+ 新建定时任务」按钮，弹出表单 modal；每条 schedule 卡片右下角新增「删除」按钮（带二次确认）。
- **怎么用**：
  - 新建：填写「任务名 / 执行体 (agent|shell) / 调度类型 (cron|once) / 调度表达式 / 时区 / 描述」+ 执行体专属字段（agent：项目 + title + prompt；shell：command + 可选 cwd），点「创建」。
  - 删除：点「删除」→ 弹出确认框 → 「删除」走 `DELETE /api/schedules/[id]`，**硬删除**（不走 v68 软删除通道），会级联清掉 `schedule_runs` 触发历史。
- **注意**：
  - 前端 `validateCreateForm` 做必填校验（任务名 / 调度表达式 / agent 三件套 / shell command），后端 `validateDefinition` 是权威校验，前端仅防无意义请求。
  - 调度表达式示例：cron → `0 9 * * *`；once → `2026-12-31T16:00:00Z`（ISO 时间）。
  - 删除不可恢复（硬删），二次确认对话框用 `@/components/ConfirmDialog`（variant="danger"）。
  - 后端行为没动 —— UI 改造纯前端，`POST/DELETE /api/schedules` 接口契约不变。

### 功能点：列表筛选 — 项目 + 版本 + 时间区间（飞书 AO-DEV R92 + 第二批反馈）

- **是什么**：`/schedules` 页面 toolbar 增加项目下拉 + **版本下拉** + 时间区间筛选（上次执行 / 下次执行各一组起止）。后端 `GET /api/schedules` 与 `cron.sh list` 同步支持对应参数。
- **怎么用**：
  - UI：在 toolbar 上选项目（或留「全部项目」）、选版本（按所选项目过滤，留「全部版本」）、填 datetime-local 起止即可（300ms 防抖）。**切项目时版本筛选自动清空**（旧 versionId 可能不属于新项目，避免 WHERE 命中 0 行的「列表突然空」困惑）。任何筛选非空时显示「重置」按钮。
  - API：`GET /api/schedules?project=<id>&version=<id>&lastRunFrom=<ISO>&lastRunTo=<ISO>&nextRunFrom=<ISO>&nextRunTo=<ISO>`。`project`/`version` 是 UUID；时间区间为 ISO 8601 字符串（如 `2026-09-01T00:00:00Z`）。
  - CLI：
    ```bash
    cron.sh list --project <id-or-name>
    cron.sh list --version <version-uuid>
    cron.sh list --last-run-from 2026-08-01T00:00:00Z --last-run-to 2026-09-01T00:00:00Z
    cron.sh list --next-run-from 2026-09-01T00:00:00Z --next-run-to 2026-09-30T00:00:00Z
    ```
- **注意**：
  - **版本筛选**（R92 第二批，damo 0830 R 列反馈）：精确匹配 `version_id`，空 = 不过滤；与 `project` 是 AND 叠加关系，可单独筛 version 也可「先 project 后 version」组合。Toolbar 元素尺寸统一到 `w-44`（与 Select 等宽），R 列反馈的「后面几个时间筛选明显比前面项目下拉小」已修。🆕 **R218 (2026-10-08)**：版本下拉末尾新增「**其他版本（未挂版本）**」= `?version=null`（字面量）→ 后端 `version_id IS NULL`，只看没挂版本的 schedule。
  - 时间区间「上次」「下次」**两组独立**：上次 = `last_run`（上次执行时刻），下次 = `next_run`（下次计划触发时刻），互不干扰。
  - **NULL 不在区间内**：`last_run=NULL`（从未执行过）的 schedule 即便时间区间「全开」也不会被显示出来（damo 拍板：未执行的不算）。`next_run` 对 once/cron 必有值，所以这条只对 `last_run` 生效。
  - **半传 = 忽略半边**：`lastRunFrom` 缺 `lastRunTo` 时整组不生效（避免「只设了 from 就砍掉全部」误操作）；非法字符串（无法 parse）也兜成 undefined 忽略。
  - 项目 / 版本 / 状态（`enabled`）/ 时间区间 / 软删除（`includeDeleted`）五组筛选**独立可叠加**，AND 关系。
  - agent 与 shell 一视同仁：项目筛选过滤 `project_id`，未设置项目（shell 类型）的 schedule 仍可被 `?project=` 之外的其他筛选看到。

### 功能点：状态筛选 + 卡片创建时间（2026-11-02）

- **是什么**：`/schedules` toolbar 新增**状态下拉**（全部状态 / 启用 / 停用），按 `enabled` 过滤；卡片 meta 行新增「创建: <时间>」。同轮修了筛选下拉被工具栏边界裁剪的 bug（`.toolbar` 之前带 `overflow-x: auto`，把 Select 的绝对定位下拉裁在工具栏内；窄屏换行已由 `flex-wrap: wrap` 兜底，属性删除）。
- **怎么用**：
  - UI：toolbar 选「状态」下拉即可（300ms 防抖与其他筛选一致）；卡片「创建」列在「下次 / 上次」之前。
  - API：`GET /api/schedules?enabled=true`（只看启用）/ `?enabled=false`（只看停用）；未传 = 不过滤。
  - CLI：`bash scripts/cron.sh list --enabled false`（只看停用）。

### 功能点：软删除与筛选（v68）

- **是什么**：schedule 支持软删除 —— DB 记录保留但默认从列表中隐藏，避免「删完后悔找不回」又避免「UI 一堆鬼影」。
- **怎么用**：
  - 默认 `/schedules` 页面 / `GET /api/schedules` / `cron.sh list` 只返回活跃（`deleted_at IS NULL`）的 schedule。
  - 想看软删除的：UI 勾选「显示已软删除」复选框 / API 传 `?includeDeleted=true` / CLI 用 `--include-deleted`。
  - 已软删除的卡片显示红色「已删除」徽章 + 删除时间。
  - 软删除字段 `deleted_at` 由 v68 migration 自动加；历史靠 name 前缀 `[soft-deleted-YYYYMMDD]` 识别的旧软删除条目会被回填 `deleted_at=YYYYMMDD`T00:00:00Z。
- **注意**：
  - 软删除 schedule 仍带 `enabled=0`，runner 走 `listDueSchedules(enabled=1)` 天然不触触发，无需额外防护。
  - 当前 API 是「只读 + 展示」，没有 `PATCH deleted_at` 端点 —— 软删除动作由后台脚本直接 SQL 完成（如未来需要软删/恢复端点单独提需求）。
  - `skip_if_running` 「软删除的不算在飞」这条闸门判断仍生效（判断的是 `enabled`+ 任务状态，不看 `deleted_at`）。

### 功能点：邮件路由管线（shell schedule 实战样例，2026-10-31）

damo 的 163 邮箱（`you@example.com` = 平台 notify 收件箱）新邮件每 15 分钟自动抓取分流：**告警类直接派平台任务处理、纯信息类跳过不过 AI、未知类型派 AI 裁定并自动沉淀新规则**。规则越用越多，越少邮件需要过 AI。

- **怎么用**：
  - 管线本体在 `scripts/mail-router/`（fetch.mjs + rules.json + templates/ + run.sh），schedule `邮件路由-163邮箱抓取`（shell，`*/15 * * * *`）执行 `run.sh`。
  - **加规则** = 编辑 `scripts/mail-router/rules.json`（match 支持 `subject_contains` / `from_contains` / `body_contains` 子串数组，`any`/`all` 组合；action = `skip` / `dispatch`），先命中先赢。AI 裁定任务也会自己往里追加新规则（带 `git pull --rebase` 后 commit）。
  - **换邮箱 / 改凭据** = `scripts/mail-router/.env`（gitignored，模板见 `env.example`；163 用授权码非登录密码）。
  - **手动触发 / 预演**：`bash scripts/mail-router/run.sh --dry-run`（零副作用，只打印将派什么）。
- **注意**：
  - 管线**只读邮箱**（不标记已读、不移动邮件），去重靠 `var/state.json` 水位（UIDNEXT 单调递增）；首次运行把现有邮件全部记为已处理（不回扫历史）。
  - 每轮最多派 5 个任务防风暴；派发失败重试 3 次后放弃并落日志（`var/mail-router.log` JSON 行）。
  - 🔴 AI 裁定/处理任务**禁用 email 通知通道**（会把消息发回 163 邮箱造成回流循环），统一走飞书通道。
  - 凭据未配时每轮优雅退出 exit 0（schedule_runs 可见 skip 记录），配好自动生效，无需重启。

## 常见问题

**Q: schedule 创建后 next_run 怎么算？**
A: cron 类型用 cron-parser 计算下一次触发时间；once 类型直接用 `schedule_expr` 的 ISO 时间。

**Q: agent schedule 创建的任务和手动创建的有什么区别？**
A: 完全等价。生成的 task 有 `schedule_id` 字段反关联回 schedule，除此之外走相同的调度器、并发控制、状态机。

**Q: shell 超时了怎么办？**
A: 超时后进程被 kill，exit_code 记为 124，已截断的 stdout/stderr 存入触发历史。不会自动重试。
