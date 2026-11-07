---
name: orchestrator-stuck
description: Diagnose and fix stuck tasks in agent-orchestrator -- 5 common stuck modes (running卡 / paused卡 / queued排队卡 / SSE中断 / 飞书没回). Use when a task is stuck, a cron has gone silent, SSE stream dropped, or a Feishu collaboration has no response. 跨环境通用.
---

# orchestrator-stuck

任务卡住怎么办。本 skill 教**怎么诊断 + 怎么修**，不教怎么避免（避免是 dispatch / ops 的活）。

## 何时用

- 任务卡 running > 30 分钟没动静
- 任务 status=paused 长时间不动（**最常见的卡死模式**）
- 任务排队 queued 一直不跑（并发占满 / scheduler 没起来）
- SSE 流断了 / 流断了再连不上
- 飞书 sheetwatch 派发出去没人接
- cron 失语 / schedule 没触发

## 何时不该用本 skill

- 任务跑完了想看结果 → [[orchestrator-query]]
- 想派新任务 → [[orchestrator-dispatch]]
- 想调度 / 启停 cron → [[orchestrator-ops]]
- 任务跑失败想重派 → [[orchestrator-manage]] §「Fork / Resume」

---

## 诊断流程图

```
任务卡了 → 看 status（GET /api/tasks/<id>）
          │
          ├─ status=running 且 elapsed > 90min
          │  → 「模式 1: running 卡」→ ① cancel → ② 改派
          │
          ├─ status=paused
          │  → 「模式 2: paused 卡」→ ① resume → ② 还不动就 cancel + 改派
          │
          ├─ status=queued 且 elapsed > 10min
          │  → 「模式 3: 排队卡」→ ① 看并发配置 → ② 看 scheduler 状态
          │
          ├─ SSE 流断了 / /stream 没事件
          │  → 「模式 4: SSE 中断」→ ① 重连 → ② 看任务 status 是否真在跑
          │
          └─ 飞书 sheetwatch 没接
             → 「模式 5: 飞书没回」→ ① 看 O 列四态 → ② 重派
```

---

## 模式 1：running 卡

### 症状

- `status=running` 持续 > 90 分钟无响应
- `updated_at` 不再推进
- SSE 流有事件但停在一个 user prompt（agent 卡在等对话）

### 诊断

```bash
bash ~/workspace/agent-orchestrator/scripts/ao-monitor.sh <project_id> --stale-min 90
# exit 1 + 列出 stale_min > 90 的任务 = 确认卡死
```

### 修复

```bash
# 1. cancel（POST /api/tasks/<id>/cancel）
source ~/workspace/agent-orchestrator/scripts/login.sh
ao_init_env && ao_resolve_auth
bash ~/workspace/agent-orchestrator/scripts/ao-task-act.sh cancel <8位前缀>

# 2. 改派（重新派发，注意派发路由别撞死循环）
bash ~/workspace/agent-orchestrator/scripts/ao-dispatch.sh \
  -p <项目名> -t "<新 title>" -m "<原 prompt + 卡死原因>" \
  --auto-approve
```

### 升级判据

- 同一个 prompt 重派 ≥ 3 次都卡 → 大概率模型/环境问题 → 升级给用户

---

## 模式 2：paused 卡（最常见 · 平台重启遗留）

### 症状

- `status=paused` 长时间（> 30 分钟）不动
- 通常平台重启或 `maintenance enter` 后遗留
- 根因（`check-stuck-schedules.sh` 注释）：`paused` 不在 `TERMINAL_TASK_STATUSES` 内 → `skip_if_running` 永远认为「还在飞」 → 永不重派

### 诊断

```bash
# 查所有 paused 任务
bash ~/workspace/agent-orchestrator/scripts/check-stuck-schedules.sh
# exit 1 = 有卡死（列出 schedule_id + task_id + overdue_min）
```

### 修复（两种路径）

**路径 A：恢复（推荐先试）**

```bash
# 1. resume（POST /api/tasks/<id>/resume）
bash ~/workspace/agent-orchestrator/scripts/ao-task-act.sh -- help 2>&1 | grep resume
# 注意：resume 在 orchestrator-manage，不在 ao-task-act.sh
curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/tasks/$TID/resume"
```

**路径 B：清僵尸（一键）**

```bash
# --fix 自动 cancel 所有 paused 僵尸
bash ~/workspace/agent-orchestrator/scripts/check-stuck-schedules.sh --fix
# exit 0 = 全部清完，schedule 下一 tick 自动补触发
```

### 已知坑

- **只 cancel paused**：脚本**不**碰 reviewing/running/queued（reviewing 是人工闸门，cancel 会吃产物）
- grace 默认 5 分钟（schedule 刚过期几十秒不算卡死，防抖）

---

## 模式 3：queued 卡（排队卡）

### 症状

- `status=queued` 持续 > 10 分钟不动
- 任务没进 running

### 诊断

```bash
# 1. 看全局并发配置
curl -s -b /tmp/ao-cookies.txt "$BASE/api/config" | python3 -m json.tool
# 看 running_count vs concurrency 上限

# 2. 看 scheduler 是否还活着
ps aux | grep -E "scheduler|agent-runtime" | grep -v grep
# 没进程 = scheduler 挂了 → 重启平台服务（[orchestrator-ops]）

# 3. 看是不是 cwd 互斥占满
# 同 cwd 同时只能跑一个任务（全局策略）
curl -s -b /tmp/ao-cookies.txt "$BASE/api/tasks?status=running" | python3 -m json.tool
# 看是否有别的任务占着同一 cwd
```

### 修复

```bash
# 1. 并发占满 → 等待，或 PATCH /api/config 临时调高
curl -s -b /tmp/ao-cookies.txt -X PATCH "$BASE/api/config" \
  -H 'Content-Type: application/json' \
  -d '{"concurrency": 5}'

# 2. scheduler 挂了 → 重启平台
bash ~/workspace/agent-orchestrator/scripts/maintenance.sh restart agent-orchestrator  # [orchestrator-ops]

# 3. cwd 互斥占着 → 等在跑的跑完，或 cancel 占着的任务
bash ~/workspace/agent-orchestrator/scripts/ao-task-act.sh cancel <占着的 task 8 位前缀>
```

### 已知坑

- **同 cwd 同时只跑一个**（不是 bug，是设计）；大量同 cwd 任务会排队
- 调 `concurrency` 不会破除 cwd 互斥（这是另一个闸门）

---

## 模式 4：SSE 中断

### 症状

- `curl -N $BASE/api/tasks/$TID/stream` 没事件输出
- UI 任务详情页「实时输出」卡住

### 诊断

```bash
# 1. 任务真在跑吗？（流断了不代表任务停了）
curl -s -b /tmp/ao-cookies.txt "$BASE/api/tasks/$TID" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['task']['status'])"

# 2. SSE 服务端断了？换条命令重连
curl -N -b /tmp/ao-cookies.txt --max-time 300 "$BASE/api/tasks/$TID/stream"
# --max-time 避免无限等
```

### 修复

| 现象 | 修法 |
|------|------|
| 流断了但任务在跑 | 重连即可（`/stream` 会**先回放 DB 历史**，再追新事件） |
| 任务已 running 但 `/stream` 一直空 | 服务端 SSE bug → 用 `GET /api/tasks/<id>/transcript` 拉历史 |
| `/transcript` 也没有 | 任务其实没起来 → 看 status，可能是 queued/paused（走模式 2/3） |

### 已知坑

- `curl -N $BASE/api/tasks/$TID/stream` **会先回放历史事件**（不是只追新流），长任务输出会刷一遍
- `/stream` 在脚本里别无限等，加 `--max-time` 或后台跑

---

## 模式 5：飞书没回

### 症状

- 飞书 sheetwatch 派发出去，没看到任何 agent 接手
- 任务在 sheet 里 O 列一直空

### 诊断

```bash
# 1. 看 sheet 末几行 R{row} 状态
bash ~/workspace/agent-orchestrator/scripts/feishu.sh row-get --row <行号>
# O 列 = 0/空 = 没动过；sheetwatch 视为未完工 → 下轮 diff 重派

# 2. 看 sheetwatch 最近派发历史
# sheetwatch log 在平台日志里，不在仓内；用 ao query 查 schedule 执行记录
```

### 修复

| 现象 | 修法 |
|------|------|
| O 列空 + 任务真没派 | 手动派发到 `ao-board-watcher` 那个 schedule 或手动 dispatch |
| O 列有中间态（等回复/有 建议/卡住）| sheetwatch 不会重派，但 board plan / todo-for-you 会捞起来推 |
| O 列 = 1（已完成）| sheetwatch 不该重派；如果还在派 → 看 schedule 配置 |
| DISPATCH_COOLDOWN 300s 同 hash | 等 5 分钟；或换 prompt 内容避免 hash 撞 |

### 已知坑

- `1`/`是`/`yes`/`done`/`true` 都算处理好了；空 = 没动过；中间态 = 等回复

---

## 何时升级给用户拍板

| 现象 | 升级路径 |
|------|---------|
| 同 prompt 重派 ≥ 3 次都卡同一处 | [[notify]] 通知用户，附 task_id + 卡死现象 + 已尝试 3 种修法 |
| 平台 scheduler 挂了 + restart 不行 | 同上 |
| SSE 全平台断流 | 同上 |
| 飞书 sheetwatch 派发全平台不响应 | 同上 + 检查 sheetwatch 定时任务配置 |
| 数据丢失 / DB 损坏 | 同上（**别自己动 DB**，等用户决策） |

通知模板：

```bash
# 通知用户（已配置邮件/飞书机器人时走 POST /api/notify；没配置则把下面内容贴给用户）
ao query POST /api/notify --data '{
  "subject": "[stuck] <task_id 8 位前缀> 卡死",
  "body": "卡死现象：<running 90min+ / paused 30min+ / SSE 断流 / 飞书没回>\n已尝试：\n  1. <命令 + 结果>\n  2. <命令 + 结果>\n建议：<我建议的下一步，等你拍板>"
}'
```

## 注意

- 本 skill 维护在仓内 `.claude/skills/orchestrator-stuck/SKILL.md`
- 5 类模式不互斥：一个任务可能同时卡 running + SSE 断（先按 running 处理，状态变了 SSE 自然恢复）
- **不要直接动 DB**：cancel / resume / approve 都走平台状态机 API（`ao-task-act.sh` / `curl POST /api/...`）
- 同 cwd 同时只跑一个任务是**设计特性**，不是 bug；不要改 scheduler 代码绕过
