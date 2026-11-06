# API 路由（下表 61 个；⚠️ 仓里实际 `route.ts` 已有 78 个，本表未逐一补齐 —— 当索引读，别当全集）

## Tasks（24 个）

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/tasks | 列出任务（支持 `?project=` `?version=` `?unversioned=true` `?unassigned=true` `?status=` `?limit=` `?search=`（R180 顶栏搜索：LIKE 匹配 id/title/status/tags，owner 隔离）过滤）|
| POST | /api/tasks | 创建任务（`project_id` 必填，`version_id` 可选且必须属于该 Project；可传 `type`、`dispatched_by_task_id`=派发方 task id，跨项目也可，仅校验同 owner）。`role_id`（Role 场景化 P2，[role-scoped-roles.md](plans/role-scoped-roles.md) D2）：挂角色预设，task 继承 role 的 system_prompt/model/effort/max_turns/allowed_tools（task 显式字段优先）；role 须属同 owner 且作用域匹配 —— 全局 role（`project_id` NULL）任意 project 可用，project 专属 role 只能用于绑定 project。`autoComplete`（波 2.5，[auto-complete-dag.md](plans/auto-complete-dag.md) D7）：任务级自动验收，true = 任务进 reviewing 的瞬间自动翻 completed（复用 approveTask 全部副作用：events/webhook/父通知/依赖链下游自动启动）；**仅 DAG 项目可用**（`dag_enforced=1`）。错误码（均 400）：`ROLE_NOT_FOUND` = role 不存在或跨 owner；`ROLE_SCOPE_MISMATCH` = 项目专属 role 跨 project 使用；`AUTO_COMPLETE_REQUIRES_DAG` = autoComplete=true 但项目未开 DAG（route + createTask 两级校验，防绕过） |
| GET | /api/tasks/page | 看板专用分页端点: `?statusGroup=active\|terminal\|all` (必填) + `?project=` `?version=` `?unversioned=` `?includeDeleted=` `?limit=` (默认 50 上限 200) `?offset=` (默认 0). 返回精简投影信封 `{items, total, hasMore}` (`TaskTrimmed` 20 字段, 大字段 prompt/result/error 替换为末尾/头部 preview). `/global` 和 `/[projectId]/[versionId]` 看板专用. 与 `/api/tasks` 共存, 不替换. |
| GET | /api/tasks/[id] | 任务详情（含 `depends_on_ids`/`dependent_task_ids`/`dispatched_task_ids` 下游派发链）|
| PATCH | /api/tasks/[id] | 更新任务 |
| DELETE | /api/tasks/[id] | 删除任务 |
| POST | /api/tasks/[id]/start | 启动任务（含 await_user / 历史 rejected 状态也可 start 复用 session）|
| POST | /api/tasks/[id]/pause | 暂停 |
| POST | /api/tasks/[id]/resume | 恢复 |
| POST | /api/tasks/[id]/cancel | 取消 |
| POST | /api/tasks/[id]/message | 发送消息（运行中或 paused 队列）|
| POST | /api/tasks/[id]/fork | Fork session（真 SDK forkSession，带 body：upToMessageId/title/prompt/newCwd）|
| POST | /api/tasks/[id]/approve | 审核通过 |
| POST | /api/tasks/[id]/refine | reviewing→running，agent 接着干（替旧 /reject）。Body: `{message?:string}` |
| POST | /api/tasks/[id]/await | running→await_user，等用户介入。Body: `{reason:"dispatch_needed"\|"decision_pending"\|"suggestion", note?:string, requested_by?:"damo"\|"agent"}` |
| POST | /api/tasks/[id]/unawait | await_user→running，等结束了。Body: `{reason:"agent_self_resolved"\|"user_timeout"\|"external_event", note?:string, requested_by?:"damo"\|"agent"}` |
| ~~POST /api/tasks/[id]/reject~~ | **🆕 R131 删除**（单人协作系统无他人接驳回）。替换为 `/refine` |
| POST | /api/tasks/[id]/evaluate | 评分（仅 completed / 历史 rejected 状态，1-5 + note，触发 task.evaluated webhook）|
| POST | /api/tasks/[id]/tool-approval | 运行中工具审批（allow/deny）|
| POST | /api/tasks/[id]/rewind | 文件回滚到指定消息状态 |
| GET | /api/tasks/[id]/stream | SSE 实时事件流 |
| GET | /api/tasks/[id]/messages | Session 历史消息 |
| GET | /api/tasks/[id]/transcript | 完整会话导出（`format=markdown`/`jsonl`/`json` + `verbosity=summary`/`full`；源是 SDK transcript，**`json` 是历史语义 = raw events**）|
| GET | /api/tasks/[id]/timeline | 任务状态变更时间线 |
| GET | /api/tasks/[id]/changes | 任务变更记录 |
| GET | /api/tasks/[id]/dependents | 反向查：依赖此 task 的 task 列表 |
| POST | /api/tasks/[id]/notify-dependents | body `{message}`：触发 task.dependency_changed webhook 通知所有 dependents |
| GET | /api/tasks/[id]/evals | 列出该 task 的所有评分 |
| POST | /api/tasks/[id]/evaluate | 提交评分（仅 completed / 历史 rejected，1-5 + note，触发 task.evaluated webhook）|
| GET | /api/tasks/who-touched | 反查「哪些历史 task 改过这个文件」(`?file=` `?project_id=` 必填, `?lookback=` 1-365 默认 90, `?limit=` 1-50 默认 5). 数据 = `git diff base..head --name-only -- <file>` 派生, 不依赖 agent opt-in / marker (R113 marker adoption 0%). owner 隔离 + admin bypass (x-user-role). 软删 / failed / reviewing task 已过滤. |

## Checkpoints（4 个）

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/tasks/[id]/checkpoints | 列出该 task 的 checkpoint 锚点 |
| POST | /api/tasks/[id]/checkpoints | 手动写一个 checkpoint（step/summary）|
| POST | /api/tasks/[id]/fork-at-checkpoint | 从指定 checkpoint 切出 fork（传 checkpoint_id + prompt）|
| GET | /api/tasks/[id]/commits | 该 task + 所有 fork 派生的 commit 链（SQL 递归 CTE）|

## Stats / Import / Templates（9 个）

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/stats | 统计信息（含花费聚合、按状态/标签/天）|
| GET | /api/stats/usage | 用量聚合（v41+双口径）：`?granularity=hour\|day\|week\|month\|year` + `?limit=` + `?owner=self\|all\|<user_id>`，按 UTC+8 分桶。响应自述 `scope`（mine/all/owner），owner=all 多带 `total.by_owner`（LEFT JOIN users）。非 admin 传 owner=all/别人 id → 403 "admin required"；admin 传不存在的 user_id → 404。**与 `/api/stats` 分开的，巡检脚本在用后者**|
| POST | /api/user/notify-email/test | 真发一封测试邮件到本账号解析出的通知邮箱（v41）。🔴 **不接受请求体里的地址**（否则是开放中继）；发不出回 200 + `{sent:false, reason}` 而非 5xx |
| POST | /api/user/notify-feishu/test | 真发一条飞书消息到本账号配置的 webhook（v47）。与 notify-email/test 同口径：不接受请求体里的 URL（防中继）；发不出回 200 + `{sent:false, reason}` |
| GET | /api/user/me/webhook-meta | 返回 `{ feishu_configured, masked_url }`（v47）。`GET /api/user/me` 只回 `feishu_configured` 布尔，**不回 webhook 明文**（半秘密保护）；要看脱敏值走这里 |
| GET/PUT/DELETE | /api/user/media-key | minimax mmx-cli API Key + region（v48）。PUT「保存即生效」：DB 加密存 + 后端 `mmx auth login` 写到 per-user `$ORCHESTRATOR_HOME/users/<id>/.mmx/config.json`；mmx 未装/失败时 DB 仍存但响应附 `mmx_warning` 字段。region 校验 `cn|global|null`，非法 → 400。DELETE 清空 + 删 config.json 目录 |
| POST | /api/user/media-key/test | 健康检查（v48）。临时目录跑 `mmx auth login + mmx quota`，8s timeout，mmx 未装 ENOENT 兜底返 `{ok:false, reason}`。**不接受请求体里的 key**（防中继，同 notify-feishu/test 政策） |
| POST | /api/notify | 通用通知出站（v47）。body `{channel: email\|feishu\|both, user_id?, to?, subject?, text?, html?, message?, msg_type?}`；admin-only 的 `user_id`/`to` 非 admin 传 → 403（开放中继闸门）；channel=both 时两渠道 `Promise.all` 并发；返回 `{results, summary: all_ok\|partial\|none}` 始终 200（除非 400/403/404）|
| POST | /api/import/json | JSON 批量导入（目标 `project_id` 必填，`version_id` 可选）|
| POST | /api/import/csv | CSV 批量导入（目标 `project_id` 必填，`version_id` 可选）|
| POST | /api/import/markdown | Markdown 批量导入（目标 `project_id` 必填，`version_id` 可选）|
| GET/POST | /api/cli-import | 本机 CLI 会话历史导入（批量导入页「从原生 CLI 会话导入」卡片）。GET = 读 sync 运行状态（`~/.agent-orchestrator/cli-import/state.json` + pid 探活）；POST = 起 detached 子进程跑 `scripts/import-cli-history.ts sync --owner-email <当前用户>`（任务 owner = 会话用户），运行中重复 POST → 409，stdout/stderr 落 `cli-import/sync.log`。依赖同机文件系统（`~/.claude/projects` + transcript 硬链接），跨机调用无意义 |
| GET/POST | /api/templates | 模板列表 / 创建 |
| GET/PATCH/DELETE | /api/templates/[id] | 模板详情 / 更新 / 删除 |
| POST | /api/templates/[id]/instantiate | 从模板创建任务 |

## Config / Projects / Versions（11 个）

| Method | Path | 说明 |
|--------|------|------|
| GET/PATCH | /api/config | 配置读写（`concurrency` + `task_timeout_minutes`，v39 起**都落库**，重启仍生效；PATCH 需 admin）|
| GET/POST | /api/projects | 项目列表 / 创建（POST 可传 `cwd` 作项目级 fallback）；GET 接 `?sort=created_at\|recent_activity`（默认 created_at，DB 层 pinned 永远置顶）|
| GET/PATCH/DELETE | /api/projects/[id] | 项目详情 / 更新（含 current_version_id、`pinned` 0/1、`runners` JSON `[{runner_id, purpose, cwd_mapping, command_patterns[]}]` 字段）/ 删除 |
| GET/POST | /api/config-snapshots | 配置快照列表（`?project=&version=` 返回该位置可用快照）/ 创建 |
| GET/PUT/DELETE | /api/config-snapshots/[id] | 配置快照详情 / 更新 / 删除 |

## Project Configs（v511, 4 个，per-project KV，**AES-256-GCM 加密存**）

**用途**: reuse-pool 等需要 per-project 敏感配置（卡号 / 密钥等）的项目。跟 `app_settings` (全局 KV) 分工：本表每行带 `project_id`，`projects.id` 删除时 CASCADE 清空。值一律加密，敏感/非敏感由调用方按 key 命名约定（reuse-pool 用 `bank_account_holder` / `bank_card_no` / `bank_branch` / `payee_phone`）。

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/projects/[id]/config | 列该 project 所有 config key（**不含 value**，防 API 一把泄露所有明文）|
| GET | /api/projects/[id]/config/[key] | 读单条 (明文 value + updated_at + updated_by)。404 = 不存在 **或** 解密失败（ENCRYPTION_KEY 漂移；不抛 500）|
| PUT | /api/projects/[id]/config/[key] | 写 (upsert)。body `{value: string}`。updated_by = 当前 user_id。🔴 `overview_md` 返 409（走专用端点）|
| DELETE | /api/projects/[id]/config/[key] | 删 (404 = 不存在) |

🔴 **owner 隔离（2026-11-01 补）**：本组 4 个端点原先只校验「用户存在」，**没校验项目归属** —— 任何登录用户都能读别人项目的明文凭据或改写它。现已加 `getProjectById(id, userId)` 校验，不过返 404（不暴露项目存在性）；admin **不**豁免写。

### Project Overview（3 个，项目概览单文件 markdown）

**用途**: 每个项目一份 markdown 看板 —— 当前状态 + 常用链接 + 凭据备注。页面 = 项目详情页第一个 tab「概览」（默认显示）；CLI = `ao overview show|edit|append|clear|url`。

**为什么存 DB 而不是 cwd 文件**：cwd 是仓库目录，写文件等于把密码提交进 git。存 `project_configs` 表走 AES-256-GCM 加密（复用 `src/lib/crypto.ts`），密钥来自 `ENCRYPTION_KEY` / `JWT_SECRET`。

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/projects/[id]/overview | 读。`{exists, markdown, updated_at, updated_by}`；`exists=false` = 还没写（**200，不是 404**）|
| PUT | /api/projects/[id]/overview | 写 (upsert)。body `{markdown: string}`。超 64 KiB 返 400（**不截断**）|
| DELETE | /api/projects/[id]/overview | 删 (404 = 不存在) |

**owner 隔离**：读写删都校验项目归属，非 owner 一律 404；admin 不豁免写。

**0 新 migration**：复用 v511 已有的 `project_configs` 表（`key = overview_md`），只是新开一组端点 —— 不改 schema。

**配置示例 (curl)**:
```bash
export AO_TOKEN=$(ao login print-token)
PID="080af705-59dc-4a27-9b13-e0e1de3f9a50"  # ao-dev

# 写
curl -X PUT https://dao.example.com/api/projects/$PID/overview \
  -H "Cookie: session=$AO_TOKEN" -H "Content-Type: application/json" \
  -d '{"markdown":"# 状态\n- [飞书表](https://my.feishu.cn/sheets/abc)\n"}'

# 读
curl https://dao.example.com/api/projects/$PID/overview -H "Cookie: session=$AO_TOKEN"
```

**配置示例 (curl)**:
```bash
export AO_TOKEN=$(ao login print-token)
PID="5335678b-7482-4f1f-9870-65f4b981a5fb"  # reuse-pool

# 写
curl -X PUT https://dao.example.com/api/projects/$PID/config/bank_account_holder \
  -H "Cookie: session=$AO_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"张三"}'

# 列 (只看 key)
curl https://dao.example.com/api/projects/$PID/config -H "Cookie: session=$AO_TOKEN"

# 读
curl https://dao.example.com/api/projects/$PID/config/bank_card_no -H "Cookie: session=$AO_TOKEN"
```

## Runners（R1，6 个，远程执行 daemon 的注册 / 心跳 / 探针）

**5 admin + 1 runner daemon**。详见 [docs/runners.md](./runners.md) 架构 + 协议；UI 在 [/runners](../src/app/runners/page.tsx)（admin only）。
token 是 256-bit shared secret（3 列 AES-256-GCM 存），**POST 响应是唯一一次返回明文**，之后 GET 永不带。heartbeat 走 middleware bypass（不带 `ao_` 前缀），由路由层自己 `verifyRunnerToken` 验签。

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/runners | 全部 runner 列表（admin only）。不返 auth 列 |
| POST | /api/runners | 注册（admin only，body `{name, host, port, os_type}`）。返回 `{runner, token}` —— **token 仅此一次**。UNIQUE(host, port) 冲突回 409 `DUPLICATE_HOST_PORT` |
| GET | /api/runners/[id] | 单个 runner 详情（admin only，404-not-403） |
| DELETE | /api/runners/[id] | 撤销注册（admin only）。硬删 + 同时让 daemon 下次心跳 401 |
| POST | /api/runners/[id]/health | 手动调 runner `/v1/health` 探针（admin only）。5s 超时；成功落 `last_health_json`。**不动 status**（状态由 heartbeat 驱动） |
| POST | /api/runners/[id]/heartbeat | runner daemon 心跳（**bearer secret，非 admin**），3 列解密 + constant-time compare；401 body 带 `error: "decrypt_failed" \| "token_mismatch" \| "token_missing" \| "header_malformed"` 区分 JWT 漂 / token 抄错 / 没带 header |

## 维护模式（部署前关停 / 部署后恢复，3 个）

**全部 admin only**（`x-user-role === "admin"`）—— 影响全平台所有租户的调度。
关停会 pause 全部 running（保住 `session_id`，恢复时 resume 续完整 transcript）+ 摘下排队任务；
状态落库 `maintenance_state`（v34），所以 pm2 重启后新进程仍知道自己该静默。
CLI: `scripts/maintenance.sh`（含 `probe` 机器可读探测）；部署: `./scripts/deploy.sh` 默认 auto（有任务才关停）。

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/admin/maintenance | 当前维护状态 + 挂起清单 + 调度器实时计数（部署脚本用它核对 running 是否已归零）|
| POST | /api/admin/maintenance/enter | 进入维护（body 可选 `reason`）。**幂等**：已在维护中返回 `already:true` 且不重复 pause |
| POST | /api/admin/maintenance/exit | 退出维护 + 自动恢复挂起任务（paused→resume，pending→start）。用户手动 pause 的不碰；维护期间被手动处理过的进 `skipped` |

## Feishu / Webhooks / Roles（7 个）
| Method | Path | 说明 |
|--------|------|------|
| POST | /api/feishu/sync | 飞书行批量导入为 task（body: rows[] + project_id；version_id 可选，或无版本时另传 sheetUrl）|
| POST | /api/feishu/write-back/[taskId] | 写回 task 状态到飞书行（自动查 version 绑定的 sheet）|
| GET/POST | /api/webhooks | Webhook 列表 / 创建（9 事件可选）|
| GET/PATCH/DELETE | /api/webhooks/[id] | Webhook 详情 / 更新（启用 + events）/ 删除 |
| GET/POST | /api/roles | 角色配置包列表 / 创建（§9 v1）。GET 支持 `?projectId=X`（Role 场景化 P1/P5）：返回全局 + 该项目专属合并集（getRolesForProject 语义），无参 = 全量。POST 可带 `project_id`（null/空 = 全局角色）+ `feishu_writeback`（0/1，缺省 1 允许，[role-scoped-roles.md](plans/role-scoped-roles.md) D4/D5）|
| GET/PATCH/DELETE | /api/roles/[id] | 角色详情 / 更新 / 删除。PATCH 支持 `project_id`（undefined=不改，null=清成全局）+ `feishu_writeback`（0/1）|

## Channels（渠道配置，6 个）

owner-scoped（`x-user-id`）；secret/webhook_secret 不回传（`has_secret` 布尔掩码）。channel ∈ INTAKE_CHANNELS（telegram/wecom/feishu/lark/openclaw/weixin，openclaw 是内部线程通道，UI 不出现）。

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/channels | 列表（连带 project_name / version_name / role_name 二次查询免前端拼）|
| POST | /api/channels | 创建。bind_code 自动生成；secret 加密落库；role_id 校验同 owner（400 ROLE_NOT_FOUND）；`bound_version_id`（v529）可选，必须属于 bound_project_id（400 VERSION_PROJECT_MISMATCH）|
| PATCH | /api/channels/[id] | 部分更新：undefined=不改；secret 留空=不改；role_id null=清除；`bound_version_id`（v529）undefined=不改 / null/''=清除（跟随项目 current_version）/ string=设置（按「生效版本 ∈ 生效项目」整体校验，换绑项目时存量版本一并复核）|
| DELETE | /api/channels/[id] | 删除（不级联，intake thread 历史保留）|
| GET | /api/channels/[id]/bind-qr | 扫码绑定 QR（2026-10-13 D1）：owner 校验（跨 owner 404 CHANNEL_NOT_FOUND）→ `{ qr_content, qr_svg, hint, copy_text }`。telegram=深链 `t.me/<bot>?start=<码>`（getMe 取 bot_username，内存缓存 24h；失败 400 BOT_UNREACHABLE）；feishu/lark/weixin=文本 `bind <码>`；wecom=null（凭据即绑定，不做假 QR）。SVG 服务端 qrcode 库生成 |
| POST | /api/channels/weixin/qr-login | 微信扫码登录建会话（2026-10-13 D3）：body 必填 `bound_project_id`（owner 校验 404 PROJECT_NOT_FOUND），可选 role_id/bound_version_id → 平台调 iLink `get_bot_qrcode`（bot_type=3），QR SVG 服务端生成（编码 liteapp URL 非 qrcode 码值），内存 Map TTL 10min → `{ login_id, qr_svg, qr_url, expires_in }`；iLink 不可达 502 ILINK_UNREACHABLE |
| GET | /api/channels/weixin/qr-login/status?login_id= | 微信扫码登录状态轮询（D3）：调 iLink `get_qrcode_status`（挂起式，fetch 25s 超时归 pending 让前端续轮）→ `{ status: pending\|scanned\|success\|expired\|error, channel?, message? }`。success 自动建 channel='weixin' 渠道行（secret=加密 JSON `{bot_token, ilink_bot_id}`，bind_code 自动生成）；expired/error 会话即删（QR 不可复用）；跨 owner 判 expired 不动他人会话 |

> v529 绑定粒度到版本：渠道行 `bound_version_id` 非空 → 三个 intake route（telegram/wecom/feishu）建首 task 时显式传 `version_id`；空 → 走项目 current_version（原行为）。

## Intake（甲方 intake bot，4 个）

⚠️ 都在 `src/middleware.ts` public 白名单里（**不走 session**），靠企微验签 / webhook HMAC / Telegram secret_token / 飞书 Encrypt Key+Token 自证。
详见冷启动源 [`docs/plans/projects/wecom-intake-phase2.md`](./plans/projects/wecom-intake-phase2.md) + [`docs/plans/intake-channel-unify.md`](./plans/intake-channel-unify.md)。

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/intake/wecom | 企微回调 URL 验证（验签 + 解密 echostr 回显明文）|
| POST | /api/intake/wecom | 企微消息事件回调 → sync_msg 拉消息 → 建/续 intake thread task |
| POST | /api/intake/wecom/outbound | 内部 webhook（task.reviewing）→ 提取 `<<<REPLY>>>` → 企微 send_msg 发甲方；验 HMAC + 48h/5条 窗口 |
| POST | /api/intake/telegram | Telegram bot 入站 webhook（`?c=<config_id>` 定位渠道行）→ `bind <码>` 绑定 / 续聊；验 `X-Telegram-Bot-Api-Secret-Token` 头 |
| POST | /api/intake/feishu | 飞书事件回调（D2）→ `url_verification` challenge 应答 + `im.message.receive_v1` 按 chat_id 建/续 thread task；Encrypt Key AES 解密 + Verification Token 比对（凭据在 channel_configs feishu 行，收侧只收不发，出站走 lark-cli）|
| POST | /api/intake/weixin/outbound | 内部 webhook（task.reviewing，D3）→ 提取 `<<<REPLY>>>` → iLink sendmessage 发回微信；验 HMAC（与 telegram outbound 同模式）。微信入站不走本表 —— 无 webhook，`src/lib/intake/weixin-worker.ts` 进程内长轮询（instrumentation 启动挂载）|

## Schedules（6 个）

| Method | Path | 说明 |
|--------|------|------|
| GET | /api/schedules | 列出定时任务（支持 `?project=` + `?version=` + `?lastRunFrom/To` + `?nextRunFrom/To` 过滤，`?includeDeleted=true` 含软删除）|
| POST | /api/schedules | 创建定时任务（`exec_type` agent/shell；`schedule_type` cron/once；agent 需 `project_id`+`title`+`prompt`，shell 需 `command`）|
| GET | /api/schedules/[id] | 定时任务详情 |
| PATCH | /api/schedules/[id] | 更新（启停 `enabled`、改表达式/命令等；改 schedule_expr 自动重算 next_run）|
| DELETE | /api/schedules/[id] | 删除（级联删 schedule_runs）|
| GET | /api/schedules/[id]/runs | 触发历史（agent 记 task_id，shell 记 output/exit_code）|
| POST | /api/schedules/[id]/runs | 手动触发（立即执行，不推进 next_run、不影响正常节奏；skip_if_running 冲突返回 409）|

## 前端页面（22 个 `page.tsx`）

| 路径 | 说明 |
|------|------|
| `/` | 项目列表（每个 project 卡片展开 version 列表，⭐ 标识 current version；高级选项面板里新增 Runners 子块 R51）|
| `/[projectId]` | 307 Redirect → current/首个 Version；无 Version 时到“其他任务” |
| `/[projectId]/[versionId]` | VersionBoardPage（看板 + 侧边导航树，URL 用 UUID）|
| `/[projectId]/unversioned` | 项目级“其他任务”（`version_id=NULL`）|
| `/uncategorized` | 兼容重定向到“未分类 / 其他任务” |
| `/tasks/new` | 创建任务表单（快速/完整/模板配置三模式；`?project=&version=` 自动套用匹配快照）|
| `/tasks/[id]` | 任务详情 + Session 实时对话面板 |
| `/import` | 批量导入（JSON/CSV/Markdown）|
| `/settings` | 系统配置（并发数、API Key）|
| `/stats` | 花费/状态统计页 |
| `/usage` | 用量统计面板（v41）：粒度切换 hour/day/week/month/year，顶部总计 = 全量，表格只是最近 N 个区间（对不上是预期）|
| `/templates` | 任务模板管理 |
| `/progress` | 进度跟踪页 |
| `/transcript/[id]` | Session 转录查看器 |
| `/webhooks` | Webhook 管理（列表 + 新建 + 编辑 events/active + 删除）|
| `/webhooks/[id]` | Webhook 详情 + 投递历史（最近 100 条 success/fail）|
| `/schedules` | 定时任务列表（只读 + 启停开关；通过 API 创建）|
| `/runners` | **R4**: Runner 管理（admin only）。列表 / 注册（含一次性 token 弹窗）/ 删除 / 健康检查 |