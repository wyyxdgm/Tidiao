---
name: orchestrator-advanced
description: Advanced/integration operations on agent-orchestrator (running at ${AO_BASE_URL:-http://localhost:13000}) -- Feishu sheet sync and write-back, task import from CSV/JSON/Markdown, webhook CRUD and delivery, task evaluation (score 1-5). Use when the user wants to integrate with Feishu, bulk-import tasks, configure webhooks, or score completed tasks.
---

# orchestrator-advanced

提调（Tidiao）的集成与高级操作。系统在 `${AO_BASE_URL:-http://localhost:13000}`。

## 调用约定
- `export BASE=${AO_BASE_URL:-http://localhost:13000}`，JSON body。
- Feishu 与 webhook 字段细节见 `src/lib/feishu/` 和 `src/lib/db/webhooks.ts`（schema 在 `createWebhookSchema`/`updateWebhookSchema`，需要精确字段时读这两个）。

## Feishu 同步

飞书 sheet ↔ task 双向。sheet 行结构见 `src/lib/feishu/sheets.ts` 的 `COLUMN_HEADERS`。

| 端点 | 作用 | body |
|------|------|------|
| POST `/feishu/sync` | 从 sheet 行导入并可选启动任务 | rows(number[]), project_id?, version_id?, start?(bool), sheetUrl?, sheetName?, cwd? |
| POST `/feishu/write-back/[taskId]` | 任务状态回写飞书行（列 S/T/V/W/X/Y/Z） | sheetUrl?, sheetName? |

- sync 返回 `{ok, imported, results:[{row, task_id, started}]}`。
- write-back 返回 `{ok, row, task_id, wrote, total, results:[{field,value,ok,error?}]}`。
- sheet 配置优先取 body 的 sheetUrl/sheetName，缺省从 version 绑定的 `feishu_url`/`feishu_sheet` 读（见 [[orchestrator-manage]] 的 version 字段）。

## 批量导入

三种格式，body 都是 `content`(字符串) + 可选 `project_id`/`version_id`。返回 `{imported, task_ids, errors?}`。

| 端点 | 输入格式 |
|------|---------|
| POST `/import/csv` | CSV 文本 |
| POST `/import/json` | JSON 数组字符串 |
| POST `/import/markdown` | Markdown 文本 |

解析器在 `src/lib/import/parsers.ts`，不确定列/字段格式时读它。

## Webhook

9 个事件 + 投递历史，详见 `docs/decision-log.md` 的 Webhook 备忘。

| 端点 | 作用 | body |
|------|------|------|
| GET `/webhooks` | 列表 | - |
| POST `/webhooks` | 创建（schema 校验） | createWebhookSchema 字段 + secret 处理 |
| PATCH `/webhooks/[id]` | 更新；secret="" 删除 secret | updateWebhookSchema 字段, secret? |
| DELETE `/webhooks/[id]` | 删除 | - |

精确字段读 `src/lib/db/webhooks.ts` 的 `createWebhookSchema`/`updateWebhookSchema`。

## 评估

| 端点 | 作用 | body |
|------|------|------|
| POST `/tasks/[id]/evaluate` | 给完成/打回任务打 1-5 分，触发 evaluated webhook | event?('approved'\|'rejected'), score(1-5), note? |

返回 eval row。仅对 completed / 历史 rejected 状态的任务有效。🆕 R131 起，evaluate 主要服务 completed；rejected 仅作为历史数据兜底存在，不再产生新值。

## 常用

### 从飞书导入并自动启动
```bash
curl -s -X POST $BASE/api/feishu/sync -H 'Content-Type: application/json' \
  -d '{"rows":[2,3,4],"project_id":"'$PID'","version_id":"'$VID'","start":true}' | python3 -m json.tool
```

### 批量导 task（JSON）
```bash
curl -s -X POST $BASE/api/import/json -H 'Content-Type: application/json' \
  -d '{"content":"[{\"title\":\"t1\",\"prompt\":\"...\"},{\"title\":\"t2\",\"prompt\":\"...\"}]","project_id":"'$PID'"}'
```

### 给完成任务打分
```bash
curl -s -X POST $BASE/api/tasks/$TID/evaluate -H 'Content-Type: application/json' \
  -d '{"event":"approved","score":4,"note":"质量良好"}'
```

## 注意
- Feishu 操作依赖 version 绑定的 sheet 配置或 body 显式传 sheetUrl/sheetName，两者都无会报错。
- webhook 投递是异步，失败有重试，历史见投递记录（`docs/decision-log.md` Webhook 备忘）。
- evaluate 触发 webhook，若不想要副作用先确认 webhook 配置。
