# 15. 通用通知

> 平台把"通知人"做成基础工具：SMTP email + 飞书自定义机器人 webhook 两渠道，HTTP / CLI 双入口。其他项目（mac-init / anflow / agis / yidao）的脚本能直接调，agent 在对话里也能被「通知我 xxx」触发。

## 概述

通知功能分两部分：

| 关注点 | 在哪 |
|--------|------|
| **配置通知渠道**（email 收件人 / 飞书 webhook URL） | [10. 设置](./10-settings.md) — 「通知邮箱」卡片 + 「飞书机器人」卡片 |
| **使用通知能力**（CLI / HTTP / agent 触发） | 本章节 |

已部署的触发场景：**任务超时**（v41，平台内部 `task-timeout.ts` 自动调邮件链路，不走本章节接口）。其他场景（agent "通知我 xxx"、其他项目脚本、cron 结果推送等）走本章介绍的 `POST /api/notify` 或 `scripts/notify.sh`。

---

### 功能点：CLI `scripts/notify.sh`（一命令发通知）

- **是什么**：通用通知的命令行入口。脚本只做鉴权 + 参数解析 + 调 `/api/notify` + 输出渲染 + exit code，其他项目（mac-init / anflow / agis）的脚本可直接调。
- **怎么用**：
  ```bash
  # 自己收一封邮件
  bash scripts/notify.sh --channel email --subject "早上好" --body "今日备份完成"

  # 自己的飞书机器人来一条
  bash scripts/notify.sh --channel feishu --message '**部署完成** v1.4.2'

  # 邮件 + 飞书并发
  bash scripts/notify.sh --channel both \
    --subject "数据库异常" \
    --body "请检查 replication lag" \
    --message '**DB 异常** replication lag 超阈值'

  # admin 代发给其他用户（拿那个用户的飞书 webhook）
  bash scripts/notify.sh --channel feishu --user <user-uuid> --message "你的任务超时了"

  # admin 改 email 收件人（跳过 resolveNotifyTo）
  bash scripts/notify.sh --channel email --to other@x.com --subject "..." --body "..."

  # 嵌套调用（脚本解析响应）
  bash scripts/notify.sh --channel feishu --message "..." --json | jq .summary
  ```
- **Exit code**：`0`=all_ok / `2`=partial / `3`=none / `4`=参数错 / `5`=API 错误。
- **注意**：
  - 普通用户默认发给自己（**不要传 `--user`/`--to`**——非 admin 会被 HTTP 拒绝）。admin 可指定他人或改收件人。
  - **email 收件人解析链**：`users.notify_email` 非空 → 用它；否则回落 `NOTIFY_FALLBACK_TO`（平台 env）；两者都没有 → `summary=none`，不发也不报错。
  - **飞书 webhook 没配** → `summary=none`，不发也不报错。配了但 webhook URL 非法（被手工改脏）→ 同样静默跳过。
  - CLI 依赖 `jq` 拼 JSON，没有回落 `python3`，再没有报错。
  - 鉴权走 `scripts/login.sh`：AO_TOKEN（bearer）优先，否则 AO_EMAIL/AO_PASSWORD 走密码换 session。

### 功能点：HTTP `POST /api/notify`

- **是什么**：通用通知的 HTTP 入口。任何能发 HTTP 的项目都能调（POST 一个 JSON body），自动鉴权按当前 session 归属。
- **怎么用**：
  ```bash
  curl -X POST -H "Authorization: Bearer $AO_TOKEN" -H 'Content-Type: application/json' \
    -d '{"channel":"feishu","message":"**部署完成** v1.4.2"}' \
    http://localhost:13000/api/notify
  ```
- **请求体**：
  ```ts
  {
    channel: "email" | "feishu" | "both",   // 必填
    user_id?: string,                         // admin-only, 默认 = 自己
    to?: string,                              // admin-only, 覆盖 email 收件人
    subject?: string,                         // channel 含 email 时必填
    text?: string,                            // email 纯文本正文
    html?: string,                            // email HTML 正文
    message?: string,                         // channel 含 feishu 时必填
    msg_type?: "text" | "markdown",           // 默认 markdown
  }
  ```
- **响应**（HTTP 200 即使渠道失败，要看 `summary`）：
  ```ts
  {
    results: [
      { channel: "email",  sent: true,  to: "x@y.com", response: "250 ..." },
      { channel: "feishu", sent: false, reason: "no webhook url configured", status: 0 },
    ],
    summary: "all_ok" | "partial" | "none",
  }
  ```
- **注意**：
  - 非 admin 传 `user_id` / `to` → **403**（开放中继闸门：否则任何登录用户借平台 SMTP / 飞书往外发）。这是结构性的，不能绕开。
  - 校验错（channel 缺失 / 缺 subject / 缺 message）才返 4xx；渠道失败一律返 200 + `summary` 字段。
  - `channel=both` 时两渠道 `Promise.all` 并发，不串行。
  - 飞书 webhook URL 走 DB，**调用方不需要持 webhook URL**，只需要平台鉴权 token。

### 功能点：AI 对话里被「通知我」触发

- **是什么**：agent 收到「通知我 xxx」/「发到飞书」/「发邮件给我」这类指令时，自动调 `scripts/notify.sh` 或 `POST /api/notify`，不用你手动写命令。
- **怎么用**：直接说就行。例如：
  - 「通知我部署完成」 → agent 跑 `notify.sh --channel feishu --message "部署完成"`
  - 「任务失败时发邮件告诉我」 → agent 加一段 cron / 钩子，调 `POST /api/notify channel=email`
- **注意**：
  - agent 通过 `.claude/skills/notify/SKILL.md` 知道这个能力（自动加载，无需额外提示）。
  - agent 不会主动配 webhook——`/settings` 卡片由你自己手动填。
  - 触发词：「通知我」/「notify me」/「发邮件给我」/「发到飞书」/「提醒我」。

### 功能点：飞书机器人配置（怎么拿 webhook URL）

- **是什么**：每用户配一个飞书自定义机器人 webhook URL，通用通知的飞书渠道把消息推到这里。
- **怎么用**：
  1. 打开飞书群（必须**群主或群管理员**）→ 「···」→ 群设置 → 群机器人 → 添加机器人 → 选**「自定义机器人」** → 填名字 → 完成 → 复制 webhook URL
  2. 打开 `/settings` 页 → 「🤖 飞书机器人」卡片 → 粘贴 URL → 直接点「发送测试消息」（无需先保存）→ 测通过后点「保存」才写入账户
- **注意**：
  - webhook URL 是**半秘密**：拿到就能往那个群发消息。**永远不要**贴到公开 issue / chat history。
  - 手机端如果看不到「自定义机器人」入口，**用浏览器登录 feishu.cn** 进群设置。
  - **新加的机器人 24h 内不能发消息**（飞书反垃圾策略）—— 先在群里手动发一句任意消息激活。
  - 完整速查见 `scripts/feishu-webhook-setup.md`（含三种安全设置对比 + 排障命令）。

---

## 常见问题

**Q：邮件没收到，verify 显示 `mailer_configured=true`？**
A：依次确认：① 收件人地址对（自己的 `notify_email` 还是 fallback `NOTIFY_FALLBACK_TO`）；② SMTP env 7 个键齐（`SMTP_HOST/PORT/SECURE/USER/PASS + NOTIFY_FROM/FALLBACK_TO`）；③ 发件人 `NOTIFY_FROM` 跟 `SMTP_USER` 同域（自建 maddy 会拒）；④ 收件箱是否在垃圾邮件里。

**Q：飞书收不到，但 API 返 `sent:true`？**
A：90% 是「群机器人没在群里发过消息」——飞书反垃圾会把 24h 内新机器人的消息静默。**去群里手动发一句**任意消息激活后重试。

**Q：飞书群机器人返 400「签名校验失败」？**
A：飞书群机器人开启了「签名校验」安全设置（要求 HmacSHA256 timestamp + secret 签名）。v47 暂未实现签名，**要么去掉勾**要么等签名版本扩展（见 `docs/plans/notify-v47-handoff.md` §5.1）。

**Q：能指定发给别的用户吗？**
A：admin 可用 `--user <user-uuid>` 指定代发（飞书渠道拿那个用户的 webhook，email 渠道走那个用户的 `resolveNotifyTo`）；admin 还可用 `--to <email>` 改 email 收件人字符串。非 admin 传 `--user` / `--to` → CLI 在 description 里写明「admin-only」，HTTP 端点会返 403。

**Q：`summary=none` 是 bug 吗？**
A：不一定。`none` = 两渠道都失败或都没配。常见原因：没配飞书 webhook 且 SMTP 未配置 / 收件人为空。查 `results[].reason` 看具体原因。**不是 bug**，是「当前配置不允许发出去」的诚实反映。

**Q：CLI 在 mac-init 项目里跑能调通吗？**
A：可以，但前提是 mac-init 机器能网络到达 agent-orchestrator 平台（默认 `localhost:13000`，跨机器需要改 `BASE_URL`）。脚本只依赖 `curl` + `jq` 或 `python3`，**不需要**把 webhook URL 或 SMTP 凭据搬到 mac-init 那台机器——所有凭据走 agent-orchestrator 平台。

**Q：agent 怎么知道有这个工具？**
A：`.claude/skills/notify/SKILL.md` 在主仓 git 跟踪，deploy 时通过 `scripts/sync-standards.sh` 推到 `$ORCHESTRATOR_HOME/claude-config/skills/notify/`，所有 cwd 下的 agent 启动时自动加载。agent 看到触发词（"通知我" / "notify me" 等）就会用这个 skill。

**Q：飞书机器人能 @ 人 / 发图片 / 发卡片吗？**
A：v47 只支持纯文本 + 简单 markdown。@人 / 富卡片 / 图片是另一个体系（tenant access token + 应用机器人），见 `docs/plans/notify-v47-handoff.md` §4 的扩展候选。