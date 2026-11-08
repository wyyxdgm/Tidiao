---
name: orchestrator-query
description: Query/read the agent-orchestrator system (running at ${AO_BASE_URL:-http://localhost:13000}) -- list projects/versions/tasks/templates/roles/webhooks, get task detail/timeline/transcript/changes/commits/checkpoints/dependents/evals/messages, view stats and config. Use when the user wants to inspect or read orchestrator state without modifying it.
---

# orchestrator-query

提调（Tidiao）的只查询操作。系统在 `${AO_BASE_URL:-http://localhost:13000}`。所有 GET，不改状态。

## 调用约定
- `export BASE=${AO_BASE_URL:-http://localhost:13000}`
- 大多返回 JSON，`python3 -m json.tool` 美化。
- ID 皆 UUID。

## 列表类
| 端点 | 说明 | query 参数 |
|------|------|-----------|
| GET `/projects` | 所有 project（含 current_version_name） | - |
| GET `/versions` | version 列表 | ?project=PID |
| GET `/tasks` | 任务列表 | ?status / ?limit / ?project / ?version / ?unassigned / ?unversioned |
| GET `/templates` | 模板列表 | - |
| GET `/roles` | 角色列表 | - |
| GET `/webhooks` | webhook 列表 | - |
| GET `/stats` | 任务/调度/成本统计 | - |

## 单资源
| 端点 | 返回要点 |
|------|---------|
| GET `/projects/[id]` | {project} |
| GET `/versions/[id]` | {version} |
| GET `/tasks/[id]` | {...task, depends_on_ids, dependent_task_ids} |
| GET `/templates/[id]` | {template} |
| GET `/roles/[id]` | {role} |

## Task 深度查询
| 端点 | 说明 | 备注 |
|------|------|------|
| GET `/tasks/[id]/stream` | SSE 订阅事件流（先回放 DB 历史） | 长连接，curl 持续输出 |
| GET `/tasks/[id]/timeline` | 状态变更时间线 | {events:[{from,to,created_at,is_initial,duration_ms}]} |
| GET `/tasks/[id]/transcript` | 会话 transcript | ?format=markdown\|json |
| GET `/tasks/[id]/changes` | 任务改动文件 | ?file=PATH 返回单文件 diff |
| GET `/tasks/[id]/commits` | 任务+fork 后代提交链（递归 CTE） | {root_task_id, depth, entries} |
| GET `/tasks/[id]/checkpoints` | checkpoint 列表 | [checkpoint...] |
| GET `/tasks/[id]/dependents` | 反向依赖（谁依赖此任务） | {root_task_id, dependent_ids, dependents} |
| GET `/tasks/[id]/evals` | 评估记录 | [eval...] |
| GET `/tasks/[id]/messages` | session 消息历史 | [messages...] |
| GET `/tasks/[id]/pending-user-dialogs` | 内存中待处理用户对话快照 | 重启后空 |

## 常用

### 看某任务现在啥状态
```bash
curl -s $BASE/api/tasks/$TID | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['task']['status'],d['task'].get('title'))"
```

### 看统计
```bash
curl -s $BASE/api/stats | python3 -m json.tool
# 含 tasks 计数、scheduler(running/queued)、cost(total/by_tag/by_model/by_day)
```

### 实时跟踪任务输出
```bash
curl -N $BASE/api/tasks/$TID/stream   # SSE，Ctrl+C 退出
```

### 看任务改了哪些文件
```bash
curl -s $BASE/api/tasks/$TID/changes | python3 -m json.tool
curl -s "$BASE/api/tasks/$TID/changes?file=src/foo.ts"   # 单文件 diff
```

## 注意
- `/stream` 是 SSE 长连接，脚本里别无限等，加 `--max-time` 或后台跑。
- `/pending-user-dialogs` 是内存态，服务重启后清空；持久态看 `/messages`。
- `/stats` 的 cost 依赖 task 完成时记录的 token，未完成任务不计。
