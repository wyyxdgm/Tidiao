---
name: orchestrator-ops
description: Operate and run-keep the agent-orchestrator platform itself via the scripts in ./scripts -- scheduled tasks (cron), user accounts & per-user LLM config, API tokens, deploy, DB backup, standards sync, password reset. Use when the user wants to run/maintain the platform system (deploy, backup, manage schedules/users/tokens/llm-config) rather than dispatch a dev task or do CRUD via raw curl.
---

# orchestrator-ops

`./scripts` 下平台系统/运维脚本的统一入口。所有脚本自文档化（`<script> --help` 看完整参数），本 skill 只做「什么场景用哪个脚本」的导航，不重复 --help 内容。

> 本 skill 管「用哪个脚本」，runbook 管「**怎么确认它真的成了**」：
> pm2 日志参数（`--nostream` 不加会挂住）、持续盯日志的三条铁律、
> 第三方 API 探针（分清是代码坏了还是授权坏了）、迁移时会丢什么、部署后自检。
> **脚本回 ✅ 不等于功能可用** —— 见 runbook §5.1。

## 何时用哪个脚本

| 意图 | 脚本 | 说明 |
|------|------|------|
| 定时任务：建/改/删/启停/查/立即触发 | `~/workspace/agent-orchestrator/scripts/cron.sh` | 封装 `/api/schedules` + `POST /runs` 手动触发 |
| 注册/登录自检/查资料 | `scripts/user.sh` | `register` / `login` / `me` |
| 给账号生成不过期 token / 列 token / 删 token | `scripts/user.sh` | `token` / `tokens` / `tokens-rm` |
| 配置当前用户的 LLM（api_key/base_url/model） | `scripts/user.sh` | `llm-config` get/set/clear-key/delete |
| 同步共享标准到 ~/.claude/docs | `~/workspace/agent-orchestrator/scripts/sync-standards.sh` | 部署时跑 |
| 派发开发任务给 agent | `~/workspace/agent-orchestrator/scripts/ao-dispatch.sh` | 见 [[orchestrator-dispatch]] skill 的 7 段 prompt 方法论 |
| 与运行中任务聊天 | `~/workspace/agent-orchestrator/scripts/ao-chat.sh` | 同上 |
| 飞书表格取图 / 读行 / 写格 | `~/workspace/agent-orchestrator/scripts/feishu.sh` | `img-list` / `img-get` / `row-get` / `cell-set`。**别自己拼 lark-cli 接口** —— 图片有 4 个静默坑（csv-get 读图返回空、两种贴法两个命令、`medias` 才能下载、`-o` 与 `-q` 互斥），都封在里面了 |

> 平台资源 CRUD（project/version/task 状态机/模板/角色/运行时 config）走 [[orchestrator-manage]]；飞书/导入/webhook/评估走 [[orchestrator-advanced]]。本 skill 只管「系统/运维脚本」。

## 鉴权模型（所有 API 脚本统一）

优先级：`AO_TOKEN`（`ao_` bearer，不过期）> `AO_EMAIL`+`AO_PASSWORD`（密码换 session）> 环境检测内置默认。

- 共享鉴权逻辑在 `~/workspace/agent-orchestrator/scripts/login.sh`（被 `cron.sh` / `user.sh` / `ao-dispatch.sh` / `ao-chat.sh` `source`，非直接执行）。
- 拿 token：`source scripts/.env.tokens` 注入 `MAC_ADMIN_TOKEN` / `WSL_ADMIN_TOKEN` / `PULU_ADMIN_TOKEN` 等，再 `export AO_TOKEN=$MAC_ADMIN_TOKEN`；或 `scripts/user.sh token` 现场生成一个。
- `register` / `login` 子命令不需要已有鉴权（它们本身就是换 session）。
- 🆕 **agent SDK 子进程已自带 AO_TOKEN**：平台 `buildEnv()` v52+ 启动 SDK 时自动调 `issueSwitchToken(this.userId)` 注入 task owner 的 switch-account token。子进程里直接 `curl -H "Authorization: Bearer $AO_TOKEN" http://localhost:13000/api/...` 即可，无需 source login.sh / cookie jar / refresh。注入的 token 是 task owner **本人**的 switch-account token，**永远拿不到** 管理员 / 其他账号 token。详见 [`docs/usage/11-cli.md`](../../../docs/usage/11-cli.md) §AI 一键登录。

## 环境自动检测

默认打 `localhost:13000`（自托管默认端口）。连远程实例：`export AO_BASE_URL=https://your-host`，鉴权设 `AO_PASSWORD` 或 `AO_TOKEN`（本 skill 不内置任何凭据）。

## cron.sh 速记

```
cron.sh list                                    # 列表
cron.sh create --name N --exec-type agent|shell --schedule-type cron|once \
        --expr "0 9 * * *" [--project GDM --title T --prompt P | --command C] ...
cron.sh enable <id> | disable <id> | trigger <id>   # trigger = POST /runs 立即触发
cron.sh runs <id>                               # 触发历史
cron.sh update <id> [--expr ...] | delete <id>
```
agent 必填 project+title+prompt；shell 必填 command；共用必填 name+exec_type+schedule_type+schedule_expr。详见 `cron.sh --help`。手动触发不影响 cron 节奏，`skip_if_running` 仍生效（上次没跑完返 409）。


```
```
🔴 `status` 回 ✅ 只证明接口活着 —— 真正要验的是关停后 task 的 `session_id` 非空 + 恢复后 transcript 完整。
恢复失败时平台会**静默停在维护态不跑任何任务**，必须手动 `exit`。

## user.sh 速记

```
user.sh register --email E --password P
user.sh me                                      # 当前用户（role + admin_llm_granted）
user.sh token --name "my-cli"                   # 生成 ao_ bearer（仅显示一次）
user.sh llm-config                              # 查看（key 脱敏）
user.sh llm-config set --api-key K --base-url U --model M   # 仅传要改的字段
user.sh llm-config clear-key | delete
```

## 指向文档

- CLI 工具完整说明：[`docs/usage/11-cli.md`](../../../docs/usage/11-cli.md)
- 定时任务设计（60s 轮询/防重/防堆积/重启补跑）：`docs/schedules.md`

## 注意

- `cron.sh` / `user.sh` 依赖 `curl` + `python3`，且需能 `source` 到同目录 `login.sh`（`cp` 到 `~/bin` 时一起带上，或设 `AO_LOGIN_SH` 指向 login.sh 绝对路径）。
