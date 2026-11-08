# 定时任务（Schedules）

> 到点自动创建并启动任务，跟随系统启动（60s 轮询），无需外部 cron。支持手动触发。

## 核心概念

**调度规则（schedule）与执行实例（task / run）分离**——schedule 存「到点该建什么 + 什么时候触发」，到点时复用现有生命周期：
- **agent** 类型 → `createTask()` + `startTask()`（进现有 TaskScheduler 队列，受并发/per-cwd 互斥约束，核心零改动）
- **shell** 类型 → `child_process.exec()` 直接执行命令/脚本（不进队列）

## 两种执行体 × 两种调度

| | agent（派给 Claude Code） | shell（直接执行命令） |
|---|---|---|
| **cron**（重复） | 定时派任务，如每天 9 点巡检 | 定时跑脚本，如每 5 分钟备份 |
| **once**（一次性） | 指定时间派一次任务 | 指定时间跑一次，触发后自动停用 |

- **cron**：标准 5 段表达式（`分 时 日 月 周`），如 `0 9 * * *`、`*/5 * * * *`，timezone 默认 `Asia/Shanghai`
- **once**：`schedule_expr` 为 ISO 时间，触发后 `enabled` 自动置 false

## 触发机制

`instrumentation.ts` 的 `register()` 起一个 60s `setInterval`，扫 `next_run <= now` 的 schedule 触发。单进程 + better-sqlite3 同步事务，无并发抢触发问题。timer 随 Next.js server 起停，pm2 守护。

## 关键策略

| 策略 | 行为 |
|------|------|
| **精度** | 60s 轮询，分钟级（agent 任务场景足够） |
| **防重触发** | `claimSchedule()` 在触发前原子推进 `next_run`，崩溃也不会重复触发 |
| **防重派** | `skip_if_running` 默认开——**该 schedule 派出的 task 只要没走完就跳本次**。判据是 `tasks.schedule_id` 反查（两类 schedule 都走它），终态只有 `completed/failed/cancelled`：`reviewing`/`paused`/`rejected` 都算「还在飞，只是在等人」。shell 类另有一道进程级闸门（内存 Set，管命令自身没跑完不重入） |
| **重启补跑** | 重启后 `next_run <= now` 即触发，**补跑一次**后恢复节奏（对备份/巡检合理；若要「错过即跳」后续加 `catch_up` 选项） |
| **shell 超时** | 10 分钟，超时 exit_code=124 |
| **输出截断** | shell 的 stdout/stderr 截断 64KB 存 `schedule_runs`，防 sqlite 膨胀 |

### 🔴 shell 类定时任务派 task 必须传 `schedule_id`

平台只能挡住「自己知道是谁派的」task。shell 脚本自己走 `POST /api/tasks` 建 task 时**必须带 `schedule_id`**（只能填自己 owner 的 schedule，否则 404），否则 `tasks.schedule_id` 为 null → 平台看不见 → 防重派闸门对它完全无效。

不传的代价有实测: `v2-p0-loop` 5 天重派同一件事 604 次、烧 $206（判据把 `reviewing` 当成"没派过"）—— 事故教训：判据必须把 `reviewing` 算作「已派过」。

反过来，**闸门口径宽也有代价**：一个干完停在 `reviewing` 等人验收的任务会挡住后续所有触发。要「无条件每次都派」的 schedule 把 `skip_if_running` 关掉（`cron.sh update <id> --no-skip`）；要解开被僵尸任务卡住的 schedule，把那些 task 软删除即可（软删除的不算在飞）。跳过会打日志 `[ScheduleRunner] Skip <name>: task <id> still <status>`，「到点没触发」先查这行。

### 🔴 平台重启遗留的 `paused` 任务会把 cron 静默卡死（2026-09-07 实证）

**症状**：一条 enabled 的 cron **完全不再触发**，`next_run` 冻结在过去某个时刻，`last_exit_code` 空，UI 上看不出任何错。

**根因链**：平台重启 → 该 schedule 派出的任务留在 `paused` → `paused` 不在 `TERMINAL_TASK_STATUSES`（`src/lib/db/tasks.ts:417`）内 → `getUnfinishedTaskBySchedule()` 永远认为「还在飞」→ 永不重派。跟 `reviewing` 挡住是同一道闸门，区别在 `reviewing` 有人会来验收，`paused` **没有任何人会来解**，所以是死锁而非等待。

**实测**：`AO-R6 全局目标自动推进-守护&纠正`（`c16abf84`, `*/40`）+ `reviewing 全项目自动审核`（`cdd896a7`, `*/30`）2026-09-06 22:02 CST 起静默失语 **14h+**，顶层巡检连续 13 轮记为「观察中，等自愈」——它不会自愈。

**一条命令查 + 修**：

```bash
ao stuck          # 列出所有「enabled + 过期 >5min + 被非终态任务挡住」的 schedule
ao stuck --fix    # 只 cancel 其中 paused 僵尸（reviewing/running/queued 只报告，交人判断）
```

修完 60s 内（runner 下一 tick）自动补触发，复跑 `ao stuck` 应为 ✅。脚本 = `scripts/check-stuck-schedules.sh`（`bash scripts/ao stuck`）。

**巡检启示**：「到点没触发」不要记成「观察中」——`paused` 类卡死没有自愈路径，每轮 `ao stuck` 一次即可定性。

## 数据模型

```
schedules          调度规则 + 任务定义（exec_type / schedule_type / schedule_expr / next_run / enabled...）
  ├── schedule_runs   每次触发记录（agent 记 task_id；shell 记 command/output/exit_code）
  └── tasks.schedule_id  反向关联：task 由哪个 schedule 生成
```

migration v26（v37 补 `tasks.schedule_id` 索引 —— 防重派闸门每分钟按它反查），详见 `src/lib/db/index.ts`。

## 自适应频率（v60）

agent + cron schedule 可设 `freq_min_minutes` / `freq_max_minutes`（分钟整数，`min <= max`，都填或都不填），启用后 **agent 每轮必须自选下次 cron**（区间内）：

- **机制**：`schedules` 表加 `freq_min_minutes` / `freq_max_minutes` 两列（migration v60，`src/lib/db/schedules.ts:51-52` + `:174-181` 白名单）；`schedule-runner fireAgent` 时按 schedule 是否带区间拼 `buildAdaptivePromptHeader` 到 prompt 头部（`src/lib/runtime/schedule-runner.ts:146-153` + `src/lib/runtime/schedule-adaptive-watcher.ts:60-76`），硬指令「每次回复最后一段显式输出 `下次 cron: <expr>`，并调 `cron.sh update <schedule_id> --expr "<新 expr>"` 落库」。
- **校验**（任务完成 / 转 reviewing 时跑，damo 2026-09-01 拍板）：
  - **校验 A**：把当前 `schedule_expr` 解析成下次触发时刻 → 算出间隔分钟 → 不在 `[min, max]` → warn（agent 调了 expr 但落在区间外）。
  - **校验 B**：比对 task 创建时记录的 `schedule_expr` vs task 完成时的 `schedule_expr`，相同 = agent 这轮没调 → warn。
- **警告通知**：命中通过飞书 webhook + email 双渠道警告 owner（`sendFeishuWebhook` + `sendNotifyToUser`，owner 没配 webhook 降级 `console.warn`）。**警告是兜底不是闸门**：不会拦截 task 完成，不会强制改写 expr。
- **仅 agent + cron**：shell / once schedule 拒（频率区间对它们无意义，`validateDefinition` 抛错）。
- **「本轮 expr 快照」**存在 `tasks.metadata.adaptive_snapshots` JSON 数组里（key=`schedule_id`，value=`{at, expr_before, expr_after, trigger}`），不加新表；fire 时写「in 快照」，watcher 校验后写「out 快照」。
- **CLI 入口**：`cron.sh create/update` 的 `--freq-min N --freq-max N`（agent 侧 flag）。

> 完整 agent 视角的 prompt 文案 + watcher 实现：`src/lib/runtime/schedule-adaptive-watcher.ts`。

## 归属与 admin

schedules 按 `owner_id` 隔离；**admin 例外**：`GET/PATCH/DELETE /api/schedules/[id]` 与 `/runs` 对 admin 不按 owner 过滤，`GET /api/schedules?all=true`（admin only，`cron.sh list --all`）列出所有人的。别人的定时任务失控时，admin 能直接 disable 而不用进 DB 改（这条能力是 `v2-p0-loop` 事故逼出来的）。

## 如何创建

UI `/schedules` 只做列表查看 + 启停开关（不做新建），创建走 API：

```bash
# shell 定时（每 5 分钟）—— 纯命令/脚本
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"每5分钟巡检","exec_type":"shell","command":"echo tick && date","schedule_type":"cron","schedule_expr":"*/5 * * * *"}'

# agent 定时（每天 9 点派任务给 Claude Code）
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"每日巡检","exec_type":"agent","title":"巡检","prompt":"检查项目状态并汇报","project_id":"<pid>","schedule_type":"cron","schedule_expr":"0 9 * * *"}'

# 一次性（指定时间跑一次，触发后自动停用）
curl -X POST http://localhost:13000/api/schedules \
  -H "Authorization: Bearer $MAC_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"延时备份","exec_type":"shell","command":"/path/backup.sh","schedule_type":"once","schedule_expr":"2026-08-06T03:00:00Z"}'
```

**agent 必填**：`name`、`project_id`、`title`、`prompt`；**shell 必填**：`name`、`command`；**共用必填**：`exec_type`、`schedule_type`、`schedule_expr`。

**🆕 `description` 强烈建议填写**（飞书 R95，damo 0825 拍板）：排查事故时 description 是「这个 cron 是干嘛的」快速定位线索。**缺失时不会阻断创建，但会触发两层软告警**：

- **服务端**：`createSchedule` / `updateSchedule`（`src/lib/db/schedules.ts`）在 description 为空/null 时 `console.warn`（不 throw），4 个创建入口（API POST/PATCH + `scripts/cron.sh` + UI 新建/编辑）同享。
- **前端**：`src/app/schedules/schedules-client.tsx` 的 `submitCreate` / `submitEdit` 在 description 为空时弹 `toast.warning`。

不要写 P 列。

## 手动触发

`POST /api/schedules/[id]/runs` 立即执行一次，**不影响正常节奏**：不推进 `next_run`、不禁用 once schedule、不改 `enabled`。纯粹"现在额外跑一次"。

- 对 `enabled=false` 的 schedule 也能触发（手动是显式行为）
- `skip_if_running` 仍生效：该 schedule 派出的 task 还没走完则返回 **409**（reason 带上 task id + 状态）
- agent 返回 `task_id`，shell 返回 `task_id: null`

```bash
# 手动触发
curl -X POST -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  http://localhost:13000/api/schedules/<id>/runs
# -> {"ok":true,"task_id":"..."}  或  {"error":"上一次触发的命令仍在执行"} [409]
```

## 查看触发历史

```bash
# 某 schedule 的触发记录（agent 记 task_id，shell 记 output/exit_code）
curl -H "Authorization: Bearer $MAC_ADMIN_TOKEN" \
  http://localhost:13000/api/schedules/<id>/runs
```

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/lib/runtime/schedule-runner.ts` | 60s 轮询触发器（agent→createTask+startTask，shell→exec） |
| `src/lib/db/schedules.ts` | CRUD + `computeNextRun`（cron-parser）+ 触发历史 |
| `src/app/api/schedules/` | 6 个 API 路由（list/create/detail/update/delete/runs） |
| `src/app/schedules/` | 列表页（只读 + 启停开关） |
| `instrumentation.ts` | `register()` 启动 schedule runner |

API 完整说明见 [`docs/api-routes.md`](api-routes.md) 的 Schedules 段。
