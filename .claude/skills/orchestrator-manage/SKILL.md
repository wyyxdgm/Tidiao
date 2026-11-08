---
name: orchestrator-manage
description: Operate the agent-orchestrator system (running at ${AO_BASE_URL:-http://localhost:13000}) -- create/update/delete projects, versions, tasks; control task lifecycle (start/pause/cancel/approve/refine/await/unawait/resume/fork); manage templates, roles, runtime config. Use when the user wants to create or modify orchestrator resources or drive task state.
---

# orchestrator-manage

提调（Tidiao）的增删改 + 状态机操作。系统跑在本机 `${AO_BASE_URL:-http://localhost:13000}`（production，pm2 托管，名为 `agent-orchestrator`）。

## 调用约定

- 所有端点前缀 `/api`，JSON body，返回 JSON。
- 默认 `BASE=${AO_BASE_URL:-http://localhost:13000}`。先 `export BASE=...` 再 curl。
- 资源 ID 都是 UUID。project 必填；version 可选（`version_id=NULL` 归项目级"其他任务"）；task 归属 project。
- **改源码不自动生效**：production 模式，改完要在仓库根 `npm run build` 并重启服务，否则不生效。

## 已验证事实（直接用，勿重复验证）

- **createVersion 自动绑 current**：POST `/api/versions` 后，若 project 无 `current_version_id`，后端自动把新 version 设为 current。无需再手动 PATCH。（`src/lib/db/versions.ts` createVersion）
- **createProject 无自动逻辑**：刚建的 project `current_version_id=null`，建第一个 version 后才有。

## 端点速查

### Project / Version
| 端点 | body 关键字段 | 返回 |
|------|--------------|------|
| POST `/projects` | name, description?, cwd? | {project} |
| PATCH `/projects/[id]` | name?/description?/cwd?/current_version_id? | {project} |
| DELETE `/projects/[id]` | - | {ok:true} |
| POST `/versions` | project_id, name, feishu_url?, feishu_sheet?, cwd? | {version}（自动绑 current）|
| PATCH `/versions/[id]` | name?/feishu_url?/feishu_sheet?/cwd? | {version} |
| DELETE `/versions/[id]` | - | {ok:true} |

### Task CRUD
| 端点 | body 关键字段 |
|------|--------------|
| POST `/tasks` | project_id, title, prompt, description?, priority?, cwd?, autoApprove?, model?, allowedTools?, maxTurns?, effort?, tags?, dependsOn?(id[]), version_id? |
| PATCH `/tasks/[id]` | title?/description?/prompt?/priority?/cwd?/model?/allowed_tools?/max_turns?/effort?/tags?/metadata? |
| DELETE `/tasks/[id]` | - |

### Task 状态机
| 端点 | 作用 | body |
|------|------|------|
| POST `/tasks/[id]/start` | 入队（pending→queued） | - |
| POST `/tasks/[id]/pause` | 暂停运行中 | - |
| POST `/tasks/[id]/resume` | 恢复暂停任务入队 | - |
| POST `/tasks/[id]/cancel` | 取消 | - |
| POST `/tasks/[id]/approve` | 审批通过 reviewing→completed（await_user 也可，**自动 unwait 透明**） | - |
| POST `/tasks/[id]/refine` | reviewing→running，agent 接着干（替旧 reject） | `{message?:string}` |
| POST `/tasks/[id]/await` | running→await_user，等用户介入/拍板/建议 | `{reason:"dispatch_needed"\|"decision_pending"\|"suggestion", note?:string, requested_by?:"user"\|"agent"}` |
| POST `/tasks/[id]/unawait` | await_user→running，agent 继续工作 | `{reason:"agent_self_resolved"\|"user_timeout"\|"external_event", note?:string, requested_by?:"user"\|"agent"}` |

典型流转：
- `pending → queued → running ⇄ await_user`
- `running → reviewing → {approve: completed, refine: running}`
- `await_user → {approve: completed（自动 unwait）, message: running, unawait: running}`
- 也可 `paused / cancelled`。旧 `rejected` 状态保留仅用于历史数据显示兼容，不再写入。

🆕 R131 — 旧 `/reject` 端点已删除（单人协作系统无他人接驳回）。`refine` + `await` + `unawait` 取代。

### Fork / Rewind / Checkpoint
| 端点 | 作用 | body |
|------|------|------|
| POST `/tasks/[id]/fork` | 从某消息处分叉新任务 | upToMessageId?, title?, prompt?, newCwd? |
| POST `/tasks/[id]/fork-at-checkpoint` | 从 checkpoint 分叉 | checkpoint_id(number), prompt?, title?, newCwd? |
| POST `/tasks/[id]/rewind` | 文件回滚到某 user message 状态 | user_message_id, dry_run? |
| POST `/tasks/[id]/checkpoints` | 手动写 checkpoint | step?, summary? |

### 运行中交互
| 端点 | 作用 | body |
|------|------|------|
| POST `/tasks/[id]/message` | 向运行中 session 发用户消息 | {message} |
| POST `/tasks/[id]/user-dialog` | 解决 pending 用户对话 | request_id, answers?/{[q]:string}, cancelled?, feedback? |
| POST `/tasks/[id]/tool-approval` | 解决 pending 工具审批 | request_id, approved(boolean), feedback? |
| POST `/tasks/[id]/notify-dependents` | 触发 dependency_changed 通知下游 | message? |

### Template / Role / Config
| 端点 | 作用 | body |
|------|------|------|
| POST `/templates` | 创建模板 | name, prompt, description?, model?, allowedTools?, maxTurns?, effort?, autoApprove?, tags? |
| POST `/templates/[id]/instantiate` | 模板实例化任务（模板字段作默认） | title?, prompt?, ..., project_id?, version_id?, dependsOn? |
| DELETE `/templates/[id]` | - | - |
| POST `/roles` | 创建角色 | name, system_prompt, description?, model?, allowed_tools?, effort?, max_turns?, memory_doc? |
| PATCH `/roles/[id]` | 更新角色 | 同上可选 |
| DELETE `/roles/[id]` | - | - |
| GET `/config` | 读配置 | - | 返回 concurrency, queue_size, running_count, api_key_configured, base_url, model |
| PATCH `/config` | 改并发（1-10） | {concurrency:number} |

## 典型流程

### 新建 project → version → task → 启动
```bash
export BASE=${AO_BASE_URL:-http://localhost:13000}
# 1. project
PID=$(curl -s -X POST $BASE/api/projects -H 'Content-Type: application/json' \
  -d '{"name":"myproj","cwd":"/path/to/repo"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
# 2. version（自动绑 current，无需 PATCH）
VID=$(curl -s -X POST $BASE/api/versions -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PID\",\"name\":\"v1.0\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['id'])")
# 3. task
TID=$(curl -s -X POST $BASE/api/tasks -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PID\",\"version_id\":\"$VID\",\"title\":\"do X\",\"prompt\":\"实现 X 并写测试\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
# 4. 启动
curl -s -X POST $BASE/api/tasks/$TID/start
```

### 取 ID 的简便写法
返回 JSON 取 id，用 python3 一行：
```bash
curl -s -X POST $BASE/api/... | python3 -c "import sys,json;print(json.load(sys.stdin)['<key>']['id'])"
```
列表取 id：`json.load(sys.stdin)['<key>'][0]['id']`。

### 当前 project/version 速查
```bash
curl -s $BASE/api/projects | python3 -m json.tool   # 看 current_version_name
curl -s "$BASE/api/versions?project=$PID" | python3 -m json.tool
```

## 注意

- 写操作前若不确定 ID，先 GET 列表查。删 project/version 不会级联删 task，谨慎。
- task 状态机端点对错误状态会返回 400，看返回 message。
- 改源码后务必重新 build 并重启服务，否则不生效。
