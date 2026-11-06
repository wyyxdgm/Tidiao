# 6. Webhook

> 订阅任务生命周期事件，自动向外部系统推送通知（HMAC-SHA256 签名验证）。

## 概述

Webhook 让外部系统实时感知任务状态变化。你创建一个 Webhook，指定目标 URL 和订阅的事件类型，当任务发生对应状态变化时，平台会向该 URL 发送 POST 请求，附带 HMAC-SHA256 签名供接收方验身份。投递成功和失败都记录在事件表中，可在详情页查看投递历史。

### 功能点：创建 Webhook

- **是什么**：注册一个 webhook 端点，配置目标 URL、订阅事件和签名密钥。
- **怎么用**：在 `/webhooks` 页面点击"新建 Webhook"，填写：
  - **名称**（必填）：标识这个 webhook，如"CI 监听"。
  - **URL**（必填）：接收 POST 请求的地址，必须以 `http://` 或 `https://` 开头。
  - **Secret**（必填）：用于 HMAC-SHA256 签名的密钥，接收方用同样的密钥验证请求来源。
  - **订阅事件**（至少选 1 个）：勾选要监听的事件类型（见下方 9 种事件）。
  - 也可通过 API 创建：`POST /api/webhooks`，body 包含 `name`、`url`、`events`、`secret`，可选 `active`（默认启用）。
- **注意**：secret 创建后不可读取（API 不返回明文，只返回 `has_secret` 布尔值）。编辑时传空字符串 `""` 可清除 secret。

### 功能点：9 种事件

- **是什么**：平台定义了 9 种任务生命周期事件可供订阅。
- **怎么用**：创建或编辑 webhook 时勾选要订阅的事件。完整列表：

  | 事件 | 触发时机 |
  |------|---------|
  | `task.created` | 任务被创建时（在 `createTask()` 中直接触发，无 from/to） |
  | `task.started` | 任务状态变为 `running`（调度器启动时） |
  | `task.reviewing` | agent 自然完成，进入待审核状态 |
  | `task.completed` | 人工审核通过，任务标记完成 |
  | `task.failed` | 任务出错或超时 |
  | `task.rejected` | 人工驳回任务 |
  | `task.cancelled` | 任务被取消 |
  | `task.dependency_changed` | 依赖联动变更（根任务状态变化影响依赖方任务） |
  | `task.evaluated` | 任务被评价（携带 score + note） |

- **注意**：
  - `task.reviewing` 表示 agent 自然完成等待审核，`task.completed` 表示人工确认通过。外部系统如需区分"agent 做完了"和"人工确认了"，应分别订阅这两个事件。
  - `task.dependency_changed` 和 `task.evaluated` 的 payload 结构与其他事件不同：前者包含 `root_task` + `dependents`，后者包含 `score` + `note`。

### 功能点：投递机制

- **是什么**：事件发生时，平台向所有订阅了该事件且启用的 webhook 发送 POST 请求。
- **怎么用**：投递流程：
  1. 任务状态变化时，`dispatchWebhook()` 被调用。
  2. 查找该任务所属用户（`owner_id`）下所有 active 且订阅了该事件的 webhook（跨用户不投递）。
  3. 对每个 webhook，用 `secret` 对 JSON body 做 HMAC-SHA256 签名，放入 `X-Signature` 请求头。
  4. 发送 POST 请求，Content-Type 为 `application/json`，body 为 JSON payload（包含 `event`、`timestamp`、`task`、可选 `from`/`to`）。
  5. 请求超时 5 秒。
- **注意**：
  - **不重投**。投递失败（超时、非 2xx 响应、网络错误）只记录失败事件，不会自动重试。
  - 投递是异步的（fire-and-forget），不阻塞任务状态转换。
  - 接收方应验证 `X-Signature` 头：用相同 secret 对原始 body 做 HMAC-SHA256，比较 hex 摘要是否一致。

### 功能点：投递历史

- **是什么**：每次投递（无论成功或失败）都记录在事件表中，可在 webhook 详情页查看。
- **怎么用**：在 `/webhooks` 列表页点击某条 webhook 的"详情 & 投递历史"链接，进入 `/webhooks/[id]` 详情页。
  - 页面展示 webhook 基本信息（名称、URL、订阅事件、启用状态）。
  - 下方列出最近 100 条投递记录，每条显示：
    - 状态徽章：已投递（绿色）/ 失败（红色）。
    - 关联的任务 ID。
    - 投递详情（成功：status_code + duration_ms；失败：error 信息）。
    - 投递时间。
- **注意**：投递历史上限 100 条。超过后旧记录不再显示（数据库中仍保留，只是查询限制 100 条）。目前投递记录存在 events 表中，量大时可能需要独立表优化（后续演进）。

### 功能点：编辑 Webhook

- **是什么**：修改已有 webhook 的订阅事件和启用状态。
- **怎么用**：在 `/webhooks` 列表页，点击某条 webhook 的"编辑"按钮，展开编辑面板：
  - 勾选/取消订阅事件。
  - 切换启用/禁用状态。
  - 点击"保存"提交（`PATCH /api/webhooks/[id]`）。
  - 也可通过 API 修改 `name`、`url`、`events`、`secret`、`active` 字段。
- **注意**：编辑时传 `secret: ""`（空字符串）会清除已设置的 secret。不传 `secret` 字段则保持不变。

### 功能点：启用 / 禁用 / 删除

- **是什么**：控制 webhook 的生效状态，或彻底删除。
- **怎么用**：
  - **启用/禁用**：编辑面板中切换"启用"复选框，或通过 API `PATCH /api/webhooks/[id]` 传 `{"active": true/false}`。禁用后不再投递事件，但 webhook 记录保留。
  - **删除**：在列表页点击"删除"按钮，弹出确认框后确认（`DELETE /api/webhooks/[id]`）。删除后不可恢复，投递历史也会丢失。
- **注意**：所有操作都是 owner 隔离的--只能操作自己创建的 webhook，访问他人的 webhook 返回 404。

## 常见问题

**Q: 接收方如何验证签名？**
A: 用创建 webhook 时设置的 secret，对收到的原始请求 body 做 HMAC-SHA256，将得到的 hex 摘要与 `X-Signature` 请求头的值比较。一致则请求来自平台。

**Q: 投递失败后会重试吗？**
A: 不会。当前设计为不重投，失败仅记录 `webhook_delivery_failed` 事件。后续可能加入重试和死信队列（已在路线图中）。

**Q: 一个任务的状态变化会触发多个 webhook 吗？**
A: 会。如果你创建了多个订阅了同一事件的 webhook，且都属于该任务的 owner，每个 webhook 都会收到投递。投递按创建时间顺序（ASC）依次发送。

---

## SPA 补充（R55 收口）

### 卡片详情 Link：B420

- SPA `Webhooks.vue` 在每张 webhook 卡片右上角加了 `<router-link :to="\`/webhooks/\${w.id}\`">详情 & 投递历史</router-link>`，镜像 master `webhooks-client.tsx:185-190`。
- 之前侧栏有 `window.open('/webhooks/${id}', '_blank')` 按钮 —— 这是过渡期折中（master 后端没暴露 `/api/webhooks/[id]/deliveries`，SPA 侧栏跳转 Next 详情页拉历史）。卡片 Link 走 SPA router 后用户点卡片本身能直接进详情页；侧栏的 window.open 暂留，detail 端点接齐后再撤。
