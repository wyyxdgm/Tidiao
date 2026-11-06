# 13. 甲方 Intake Bot（企微微信客服）

> 甲方用**微信**直接给 AI 发需求，AI 做模块定位+拆解+测试用例，蒸馏成 1 条人话回复。把你从「甲方↔开发」的转述链里摘出来。
>
> **当前状态**：MVP 已上线（单客服账号 → 单项目）。规划与缺口见 [`docs/plans/projects/wecom-intake-phase2.md`](../plans/projects/wecom-intake-phase2.md)。

---

## 13.1 它解决什么

甲方描述需求通常随意、跨模块、不完整（「那个列表页能不能加个导出」）。以前要你居中转述给开发，成本高且易失真。

现在甲方直接对 AI 说，AI 负责：

1. **模块定位** — 把随意表述映射到正确的系统模块（搞错 = 下游全废）
2. **拆解** — 整理成 1/2/3 模块化条目
3. **测试用例** — 每条给出输入 → 预期输出
4. **疑点提取** — 标出模糊、矛盾、主观的地方
5. **蒸馏回复** — 用人话回甲方 1 条，把疑点变成甲方能答的简单问题

## 13.2 双通道：甲方看到的 ≠ 你看到的

这是理解本功能的关键。

| 通道 | 内容 | 去哪看 |
|------|------|--------|
| **轻通道**（发甲方） | `<<<REPLY>>>` 和 `<<<END>>>` 之间的蒸馏段，1 条人话 | 甲方微信 |
| **重通道**（给你） | 完整分析：模块定位、拆解、测试用例、疑点 | 平台 task 对话页 |

AI 的详细分析**不会**发给甲方。甲方只收那条蒸馏消息。所以你随时可以打开 task 看它到底怎么理解的，判断定位对不对。

## 13.3 甲方怎么用

把客服链接或二维码发给甲方，对方在微信里点开就是客服会话，像跟客服聊天一样发消息。

- 客服链接：`https://work.weixin.qq.com/kfid/kfc09d53d9865c21429`
- 甲方不需要装企微、不需要注册，就是普通微信

## 13.4 你怎么看 / 怎么介入

**一个甲方 = 一个持久 task**（「需求线程」）。甲方后续每条消息都续在同一个 task 里，上下文不丢，跨版本迭代能复用之前确认过的模块定位。

- task 打了 `intake` + `wecom` 标签，标题是「甲方需求线程（xxxxxx）」
- 在 anflow 项目下能找到
- **你可以直接在 task 对话里插话** —— 但注意：你说的话也会走同一条出站逻辑，若含 `<<<REPLY>>>` 标记就会发给甲方

## 13.5 重要约束：48 小时 / 5 条窗口

这是**企微的硬限制**，不是平台设计：

> 甲方发消息后 48 小时内，企业最多回 5 条。甲方再发则重置。

推论：

- **AI 每轮只发 1 条**（prompt 里明确约束「不挤牙膏，一次问完」）
- 超窗后平台**不能主动联系甲方**，只能等甲方再发消息
- 所以「开发完了通知甲方」这种主动触达，如果距甲方上次发言超过 48h，做不到 —— 得你手动去微信戳一下

窗口到顶时出站会跳过并记 `intake_send_skipped` 事件（在 task 事件流里可见）。

## 13.6 目前不支持什么

> 微信个人号渠道（iLink）的语音/非文本行为 2026-10-15 更新，见 §13.6.1。

| 情况 | 现状 |
|------|------|
| 甲方发**语音**（微信个人号 iLink 渠道） | ✅ **自动转文字**进现有链路（见 §13.6.1）；转写失败回兜底话术 |
| 甲方发**图片/文件**（iLink 渠道） | 回一句兜底话术（不再静默丢弃），请甲方发文字 |
| 多个甲方 → 不同项目 | ❌ 当前所有甲方都进同一个项目 |
| AI 主动发图/菜单 | ❌ 当前只发文字（出站语音未实现：iLink 协议侧 ZCode 无发语音样例，不硬造） |

语音和图片是甲方最自然的表达方式（尤其截图），图片直传仍是已知缺口，规划见 Phase 2 文档 §5.4。

### 13.6.1 微信个人号语音转写（2026-10-15）

**链路**：甲方发语音 → `getupdates` 里 `msg.item_list[].audio_item`（CDN 直链 + `aes_key`，协议契约从 zai-org/ZCode 提取）→ 下载 → **AES-128-ECB + PKCS7 解密**（iLink CDN 返回密文）→ 格式嗅探（silk → wav，silk-wasm；wav/mp3 直传）→ ASR → 以「`[语音转写] 文本`」走现有 intake 文本链路（bind / 续聊 / 未绑引导不变）。

**ASR 选型**（2026-10-15 实测拍板）：**智谱 GLM-ASR**（`glm-asr`，OpenAI whisper 兼容 `/audio/transcriptions` 协议）。理由：平台已有 bigmodel key 体系（DB `llm_configs` 解密直取，agent 运行进程 env 无需配 key）、国内直连、curl 实测鉴权+真实语音转写全通。⚠️ **上线前提**：实测该 key 的 glm-asr 资源包极小（几次调用即 1113 余额不足），部署前需给 bigmodel 账户充 glm-asr 资源包，或用 env 指到其他 whisper 兼容服务（如阿里 dashscope compatible-mode 同协议可切）。

**env 覆盖**（换供应商零代码改动，均作用于 worker 进程）：

| env | 默认 | 说明 |
|-----|------|------|
| `WEIXIN_ASR_API_KEY` | （无） | 显式指定 ASR key；不设则从 DB `llm_configs` 取 bigmodel 配置的 key（10 分钟缓存） |
| `WEIXIN_ASR_ENDPOINT` | `https://open.bigmodel.cn/api/paas/v4/audio/transcriptions` | whisper 兼容端点 |
| `WEIXIN_ASR_MODEL` | `glm-asr` | 模型名 |

**失败降级**（不挂收消息链）：下载/解密/转写任一步失败 → 回「语音转写暂时不可用，请直接发文字 🙏」；图片/视频等非文本媒体 → 回「图片/视频等非文字消息暂不支持，请直接发文字 🙏」。降级不影响游标提交（重投由 msgId 去重兜住）。

**代码**：协议层 `src/lib/intake/weixin.ts`（audio_item 提取 + AES 解密 + CDN 下载）、ASR 层 `src/lib/intake/weixin-asr.ts`、worker 分支 `weixin-worker.ts processMessage`；测试 3 个 suite 全绿（含 silk→wav 真实 roundtrip、AES 解密 roundtrip、转写失败降级）。

## 13.7 运维

**改回调相关代码后必须验证通路**：

```bash
# 从 WSL 取凭证（不落盘）
eval "$(ssh -p 2222 user@win 'grep -E "^(WECOM_CALLBACK_TOKEN|WECOM_ENCODING_AES_KEY|WECOM_CORP_ID|WECOM_KF_ID)=" ~/workspace/agent-orchestrator/.env.local | sed "s/^/export /"')"

# GET + POST 双验（--dry 不消费甲方消息）
node scripts/verify-intake-callback.mjs --dry
```

⚠️ **只验 GET 会漏 bug**：URL 验证的载荷短，会侥幸通过；真实事件 XML 长，曾因此炸过（详见 Phase 2 文档 §3.1）。脚本会自动构造长载荷。

**看日志**：

```bash
ssh -p 2222 user@win "source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1; \
  npx pm2 logs ao-prod --nostream --lines 60 --raw | grep -iE 'intake|bad decrypt|9500'"
```

**看线程状态**（含 48h 窗口计数）：

```bash
ssh -p 2222 user@win "sqlite3 ~/.agent-orchestrator/orchestrator.db \
  'SELECT external_user_id, task_id, last_inbound_at, msg_sent_in_window FROM intake_threads;'"
```

## 13.8 甲方没收到回复？按序排查

1. **task 到 reviewing 了吗** —— 没到说明 agent 还在跑或失败了，看 task 状态
2. **最后一条 assistant 消息有 `<<<REPLY>>>` 段吗** —— 没有则出站跳过（AI 没按格式输出）
3. **48h 窗口超了 / 5 条到顶了吗** —— 查 `intake_threads` 的 `msg_sent_in_window`，或看事件流有无 `intake_send_skipped`
4. **会话被人工接待抢了吗** —— 日志里找 `service_state/trans` 告警。企微规则：会话流入「人工接待」或「待接入池」后 API 就发不出去。平台每次入站会自动置为「智能助手接待」，但若企微后台配了自动分配给接待人员，可能被抢
5. **日志有 `send_msg failed` 吗** —— 看具体 errcode

## 13.9 相关文档

- [`docs/plans/projects/wecom-intake-phase2.md`](../plans/projects/wecom-intake-phase2.md) — 冷启动源：现状、踩坑实录、缺口、Phase 2 规划
- [`docs/deploy/2026-08-08.md`](../deploy/2026-08-08.md) — 部署记录、企微侧配置步骤、凭证位置
- [`docs/api-routes.md`](../api-routes.md) — intake 路由表

## 13.10 自动化测试覆盖（E2E + 边界）

2026-09-07 加了 3 个 vitest 文件，把入站→partner→出站的全链路和边界条件做成回归测试，**改回调相关代码后必跑**：

```bash
npx vitest run src/lib/intake/ src/app/api/intake/
# → 24 tests across 6 files: 全绿
```

| 文件 | 覆盖什么 | 关键不变量 |
|------|---------|-----------|
| `src/lib/intake/wecom.test.ts` | 加解密 + 签名 + PKCS7 pad>16 回归 | 旧 `setAutoPadding(true)` 实现必败（`bad decrypt`），现实现必过 |
| `src/app/api/intake/wecom/allowed-tools.test.ts` | 入站建 task 时的工具收口 | `allowed_tools` 落库非 null + 不含 Bash/Write/Edit |
| `src/app/api/intake/wecom/e2e.test.ts` | **入站→partner→出站 全链路 E2E** | 加密回调 → thread+task 落库 → 出站 webhook → `<<<REPLY>>>` 提取 → `sendKfMessage` 调用 |
| `src/app/api/intake/wecom/failclosed.test.ts` | env 缺失 fail-closed | 缺 `WECOM_CALLBACK_TOKEN` → 403；缺 `WECOM_ENCODING_AES_KEY` → 200 + 0 task（防企微重试风暴的故意行为）|
| `src/app/api/intake/wecom/outbound/ratelimit.test.ts` | 48h/5 窗口 + 唯一约束 | 第 5 条 OK 第 6 条拒 + `intake_send_skipped` 事件；`markInbound` 后归 0 |

### E2E 测试的「真实」与「mock」边界

| 真实 | mock |
|------|------|
| 加密/解密（覆盖 2026-08-09 的 PKCS7 pad>16 bug）| `syncMessages` 返回固定甲方消息 |
| HMAC 验签（webhook）+ SHA1 签名（回调）| `sendKfMessage` / `ensureBotServiceState` |
| SQLite 落库（`intake_threads` / `tasks` 表）| `runtime.createTask` 走真实 db 函数（保证落库），但 `runtime.getSessionHistory` 返回 canned `<<<REPLY>>>` |
| 路由模块（`route.ts` / `outbound/route.ts`）整体 | — |

**关键不变量**（E2E 守住的）：
- 入站用 `pad>16` 加密载荷（强制命中回归区），如果未来有人改 `setAutoPadding(true)` 旧实现就崩
- 出站调 `sendKfMessage` 的内容**只是** `<<<REPLY>>>` 之间的蒸馏段，**不能泄漏**完整 assistant 文本
- 出站计数 `msg_sent_in_window` 必须 +1

### fail-closed 边界（设计 vs 行为）

| 场景 | HTTP 状态 | 任务创建？ | 备注 |
|------|----------|-----------|------|
| 缺 `WECOM_CALLBACK_TOKEN` | **403** | ❌ 不建 | 验签函数用空 token 算 hash 必不匹配 |
| 缺 `WECOM_ENCODING_AES_KEY` | **200** | ❌ 不建 | 解密抛 `ERR_CRYPTO_INVALID_IV` 被外层 catch 吞（防企微重试风暴：错配不会自愈，反复回调只会刷日志）|
| 签名错 / 解密空 | 403 | ❌ 不建 | 路由返回 `signature mismatch` |

安全边界 = **「不会因为 env 缺失就静默放行造出 task」**，不一定是 HTTP 4xx（200 是为了不和企微打重试战）。

---

## 13.11 多渠道插件化（Telegram P0，飞书 R184）

> 状态：**代码已合 master（P0），部署待派**。方案全景见 [`docs/plans/multi-channel-intake.md`](../plans/multi-channel-intake.md)。

### 已上线渠道矩阵

| 渠道 | 状态 | 主动发限制 | 备注 |
|------|------|-----------|------|
| 微信客服（wecom） | MVP 在线 | **48h / 5 条**（企微硬限制） | §13.5 |
| Telegram | P0 代码完成 | 无限制 | 本节 |
| 飞书（feishu） | 代码完成（2026-10-13 D2），待后台配置 | 无限制（lark-cli 主动发，收发分治） | §13.13 |
| Lark（lark，飞书国际版） | 代码完成（2026-10-13 扫码绑定 D2），与 feishu 同协议同 route | 无限制（同 feishu） | §13.14 |
| 微信个人号（weixin，iLink bot） | 代码完成（2026-10-13 扫码绑定 D3），待部署 | 无限制（iLink sendmessage 无配额） | §13.15 |

### Telegram 通道怎么用

1. **BotFather 建 bot** 拿 token（`123456:ABC-...`）
2. **建渠道配置**（写 `channel_configs`，绑目标 project，自动生成 8 位绑定码）
3. **用户在 Telegram 里给 bot 发 `bind <绑定码>`（或扫码走深链落成 `/start <绑定码>`，见 §13.14）** → 建 intake thread（同 wecom：一 chat 一持久 task）+ 回「已绑定」
4. 之后直接发消息 = 续聊，agent 回复经出站 webhook 发回 Telegram

### 绑定粒度到版本（v529，2026-10-13）

渠道行可钉死 `bound_version_id`（`/api/channels` UI「绑定版本（可选）」下拉 / PATCH 同名字段）：

- **钉了** → 三条 intake 线路（telegram / wecom / feishu）建首 task 时显式落该 version，不随项目 current_version 切换漂移
- **空（默认）** → 走项目 current_version（原行为，存量渠道行全部如此，零行为变化）
- 后端校验：版本必须属于渠道绑定的项目（`VERSION_PROJECT_MISMATCH` 400）；换绑项目时存量版本一并复核

### 与 wecom 的差异

| | wecom | telegram |
|---|---|---|
| 绑定方式 | 客服链接固定单项目 | **绑定码**（`bind <码>`），一 bot 绑一 project |
| 出站窗口 | 48h/5 条，超窗跳过 + 记 `intake_send_skipped` | 无限制（Telegram bot 无窗口） |
| 提问节奏 | 一次问完（prompt ASK_STYLE.wecom） | 多回合逐个问（同 h5 风格） |
| 入站防伪 | 企微 AES+SHA1 解密验签 | `X-Telegram-Bot-Api-Secret-Token` 头比对 |
| 未绑定消息 | 建线程（客服号语义=已定向） | **不建 task**，回引导语（防陌生人白烧额度） |

### 部署要求（🔴 不配就瘫出站）

- `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=http://192.168.3.243:1087` —— **api.telegram.org 国内直连被墙**（实测 000 超时），Node 24 内置 fetch 靠这两个 env 走代理（实测 200）。代理挂 = 出站瘫（入站不受影响）
- webhook URL：`https://dao.example.com/api/intake/telegram?c=<config_id>`（Telegram setWebhook，`secret_token` 填 config 的 webhook_secret）

### 插件化架构（damo 拍板「从简单的先搞，能插件化最好」）

- **一个渠道 = 一个文件**（`src/lib/intake/channels/<channel>.ts` 实现 `ChannelAdapter`）+ `registry.ts` 注册一行 + `INTAKE_CHANNELS` 加枚举 + `/api/intake/<channel>` 路由
- adapter 接口：`parseInbound` / `verifyRequest` / `sendMessage` / 可选 `outboundGate`（wecom 的 48h 窗口即此形态）/ `askStyleChannel`（提问节奏模板）
- **不做**第三方运行时插件加载（安全沙箱+分发机制，个人自部署平台不需要 —— damo「不好做就不考虑」口径）
- 飞书/钉钉 = P1（同接口各写一个文件）；wecom 收编进 registry = P1（动线上链路，测试先行）

### 顺手修复（同 commit）

- 🔴 `517a9fef`（08-28）重写 middleware isPublic 时误删 `/api/intake` public 行 → **master 上企微回调会被 401 拦**（线上旧构建未暴露，因企微通道已降级）。本次加回 + 注释留痕

---

## 13.12 wecom 凭据接入 channel_configs（2026-10-13 D1）

> 方案：[`docs/plans/intake-channel-unify.md`](../plans/intake-channel-unify.md)。telegram 是「渠道实例注册」完整参照，wecom 本次收编为查表定位。

### 凭据定位顺序（route 每次回调现查）

1. **channel_configs 表行优先**：启用的 wecom 行逐个试解密回调（谁验签通过用谁），命中行提供凭据 + `bound_project_id` + 默认 `role_id`（配了则首个 intake task 挂载，同 telegram）
2. **env 五常量兜底**（`WECOM_CORP_ID / CORP_SECRET / ENCODING_AES_KEY / CALLBACK_TOKEN / KF_ID`）：查不到表行走旧路径，**行为不回退**（现网回调不能断）
3. 多账号场景按消息里的 `open_kfid` 精确匹配（`getWecomChannelByKfId`）；出站 `sendKfMessage` 仍走 env（收发分治，本次不动出站）

### 一次性迁移脚本

```bash
# 实例 6 个 env（5 个 WECOM_* + INTAKE_PROJECT_ID）source 后跑
# 幂等（按 name=wecom-客服主账号 跳过）；打印解密回读校验
jiti scripts/migrate-wecom-channel.ts
# 回滚: sqlite3 <db> "DELETE FROM channel_configs WHERE channel='wecom' AND name='wecom-客服主账号';"
```

- `secret` 字段 = AES-256-GCM 加密的打包 JSON `{corpId, corpSecret, aesKey, callbackToken, kfId}`（KF_ID 在加密体内按解密匹配查回，v516/v526 schema 不动列）
- `role_id` 留空，后续在 /api/channels UI 配 → 之后 wecom 新建的 intake 首 task 自动挂该角色

---

## 13.13 飞书通道（2026-10-13 D2）

> 方案：[`docs/plans/intake-channel-unify.md`](../plans/intake-channel-unify.md) §D2。甲方在**飞书**里对机器人发消息 → 平台建/续需求线程，同 wecom/telegram。

### 与 wecom / telegram 的差异

| | wecom | telegram | feishu |
|---|---|---|---|
| 绑定方式 | 客服链接固定单项目 | 绑定码（`bind <码>`） | **回调 URL 单值直绑**（channel 行 `bound_project_id`） |
| 入站防伪 | 企微 AES+SHA1 验签 | secret_token 头比对 | **Encrypt Key AES 解密 + Verification Token 比对**（逐启用行试解密命中） |
| 出站 | 平台出站路由（48h/5 窗口） | 平台出站 webhook | **不在本平台**——发消息走部署机 lark-cli（收发分治） |
| 提问节奏 | 一次问完 | 逐个问（同 h5） | 逐个问（同 h5，无配额窗口） |
| 线程键 | external_userid | chat.id | **chat_id**（`oc_...`，p2p/群聊各自稳定） |

### 凭据边界（收发分治）

channel_configs 的 feishu 行 `secret` 字段只存打包 JSON `{"verificationToken":"...","encryptKey":"..."}`（AES-GCM 加密落库）。**`app_id` / `app_secret` 不进平台**——本线路只管「收」，回复由 agent 侧 `lark-cli` / `feishu.sh` 走（凭据在部署机本地 config，见 `docs/claude-config/docs/feishu-integration-standards.md`）。

### 飞书后台配置 checklist（代码已合，damo 一次性操作）

1. [ ] **订阅事件**：飞书开放平台 → 自建应用 → 事件与回调 → 订阅 `im.message.receive_v1`
2. [ ] **配回调 URL**：填 `https://dao.example.com/api/intake/feishu`，飞书发 `url_verification` 握手，平台用 channel 行的 Encrypt Key 解密应答 challenge → 过验证
3. [ ] **建渠道行**：把开放平台「事件与回调」页的 **Encrypt Key + Verification Token** 填进 channel_configs 的 feishu 行（`/api/channels` UI 或 API；`secret` 填 `{"verificationToken":"...","encryptKey":"..."}`，绑目标 project，可配默认 role）
4. [ ] **实测**：飞书里给机器人发 `bind <绑定码>`（绑定码在渠道管理页/扫码绑定弹窗可查）→ 平台应建「甲方需求线程（xxx）」task（tags `intake`+`feishu`，只读探索集工具，role 按渠道行挂载），agent 首轮回复带绑定成功确认；再发一条 → 续聊不建新 task

### 行为细节

- 验签失败（密文解不开 / token 不匹配 / 无启用 feishu/lark 行）→ **403**，不建任何东西（fail-closed）
- 处理出错也回 200（防飞书重试风暴，与 wecom/telegram 同策略）
- 同 `event_id` 重投去重（飞书 at-least-once），重复投递不重复触发续聊
- 非 `im.message.receive_v1` 事件、非文本消息（图片/语音/文件）→ 200 跳过，静默丢弃（同 wecom §13.6 的已知缺口）
- 多个 feishu/lark 渠道行共存：回调无实例参数（飞书 URL 单值），靠逐启用行试解密命中「谁的 Encrypt Key 能解开就用谁」
- **bind 门控**（扫码绑定 D2，2026-10-13）：未绑定的 chat 首条消息必须是 `bind <绑定码>`，非 bind 消息不建 task（防陌生人白烧额度，同 telegram）；绑定成功回执由首 task 的 agent 首轮回复送达（本线路只收不发，route 无法直发文案）

## 13.14 扫码绑定（QR，2026-10-13 D1+D2）

渠道管理页（设置 → 渠道）每行新增「**扫码绑定**」操作 → 弹窗显示二维码 + 引导 + 一键复制命令。对标 zcode 的两步分离设计：QR 只负责把绑定命令送到用户手上，真正的绑定动作 = 渠道会话里的一条文本命令（`bind <码>` / telegram 深链 `/start <码>`）。

三渠道形态各一行：

| 渠道 | QR 内容 | 用户动作 |
|------|---------|---------|
| telegram | 深链 `https://t.me/<bot_username>?start=<绑定码>`（bot_username 用渠道 token 调 Bot API `getMe` 实时取，平台内存缓存 24h；token 无效/网络失败报 `BOT_UNREACHABLE`） | 扫码 → Telegram 打开 bot 对话 → 发送 `/start` 自动带码 → 绑定完成 |
| feishu / lark | 纯文本 `bind <绑定码>`（hint 按类型标 feishu.cn / larksuite.com） | 扫码得到命令 → 在飞书/Lark 机器人会话里发送 → 绑定完成 |
| weixin | 纯文本 `bind <绑定码>`（同 feishu 形态） | 扫码得到命令 → 在微信里发给该微信号 → 绑定完成。**绑定码主动送达**（2026-10-14）：登录成功弹窗大字展示绑定码 + 一键复制；未绑定时给该微信号发任意消息，机器人自动回本渠道绑定码（不用问人、不用去页面找） |
| wecom | **不产 QR**（凭据即绑定，诚实 UI） | 行内只显示「凭据绑定，无需扫码」 |

- API：`GET /api/channels/[id]/bind-qr`（owner 校验，跨 owner 404）→ `{ qr_content, qr_svg, hint, copy_text }`；SVG 服务端 `qrcode` 库生成（SPA 零新依赖），前端 v-html 渲染
- lark 渠道类型（飞书国际版）：与 feishu 同一回调协议（验签解密与域名无关，intake 只收不分域名），`INTAKE_CHANNELS` 已加枚举；bind-qr hint / SPA 渠道类型下拉同步支持
- telegram 绑定别名：`/start <码>` 与 `bind <码>` 并存（QR 深链落地动作就是 /start）


---

## 13.15 微信个人号通道（iLink bot，2026-10-13 扫码绑定 D3）

> 方案：[`docs/plans/channel-qr-bind.md`](../plans/channel-qr-bind.md) §3 D3。个人微信（非公众号/非企业微信），走**腾讯官方 iLink bot 开放平台**（`ilinkai.weixin.qq.com`），协议契约从 zai-org/ZCode 源码提取核实。

### 怎么用（damo 视角，一次扫码全程无手填）

1. **设置 → 渠道 → 顶部「扫码登录微信」** → 弹窗里选绑定项目（可选默认角色）→ 点「生成登录二维码」
2. **手机微信扫码并确认**（弹窗显示「手机已扫描，请在微信上确认登录」中间态；3s 轮询，二维码 10 分钟内有效，过期点重新生成）
3. 登录成功 → 平台自动建 `channel='weixin'` 渠道行（名称 `weixin-iLink-<botId 前 8 位>`，凭据加密落库），列表自动刷新；**弹窗大字展示新渠道行绑定码 + 一键复制**（码由流程送出，不用去列表找）
4. **甲方在微信里给该微信号发第一条消息** → 机器人自动回复本渠道绑定码（未绑定即送码，damo 2026-10-14）；回 `bind <绑定码>` → 建 intake thread + 首 task（同 telegram 两段式）；之后直接发消息 = 续聊，agent 回复经 iLink sendmessage 发回
5. **甲方发语音** → 自动转文字（「`[语音转写] …`」进现有链路，2026-10-15）；发图片/视频 → 回兜底话术。链路 + ASR 选型 + env 覆盖 → §13.6.1
5. 出站回执需要在平台 UI 配一条 webhook 行：URL = `https://dao.example.com/api/intake/weixin/outbound`，event = `task.reviewing`（与 telegram 出站同配法，共用 `INTAKE_WEBHOOK_SECRET` 验签）

### 与其他渠道的关键差异

| | telegram | feishu | weixin (iLink) |
|---|---|---|---|
| 渠道身份怎么来 | BotFather 手建贴 token | 开放平台自建应用 | **平台内扫码登录**（iLink 发 bot_token） |
| 入站形态 | webhook 回调 | webhook 回调 | **平台主动长轮询**（`getupdates`，90s 挂起，无公网回调依赖） |
| 渠道行绑定 | 绑定码 | 回调 URL 单值直绑 | 绑定码（扫码登录建行后仍走 `bind <码>` 两段式） |
| 出站 | api.telegram.org（**需代理**） | 部署机 lark-cli | iLink sendmessage（**国内直连可达**，实测 2026-10-13） |
| 消息窗口 | 无 | 无 | 无（个人微信 bot 无 48h/5 条配额） |
| 提问节奏 | 逐个问（h5 风格） | 逐个问 | 逐个问（h5 风格） |

### 实现要点（开发者参考）

- 客户端：`src/lib/intake/weixin.ts`（headers `AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN` 随机 + body `base_info.channel_version: "2.0.0"` 包装；消息 `message_type=2` 是 bot 自发回显要跳过；出站文本 LF→CRLF）
- worker：`src/lib/intake/weixin-worker.ts`，`instrumentation.ts` 启动时挂载，2s tick 扫 `enabled=1` 的 weixin 行，每行独立长轮询。🔴 **游标纪律**：`get_updates_buf` 是服务端 ack 语义，整批消息业务处理成功才持久化（app_settings KV `weixin_get_updates_buf:<channelId>`），失败不推 = 下轮重投（at-least-once），内存 msgId 去重兜住重复。未绑非 bind 消息 = 回**本渠道绑定码**引导（主动送达，谁发消息谁收到码；不建 task）
- 登录状态机：`src/lib/intake/weixin-qr-login.ts`（内存 Map TTL 10min；QR 编码的是 `qrcode_img_content` 这个 liteapp URL，不是 qrcode 码值；挂起式 `get_qrcode_status` 超时归 pending 继续轮）
- 部署注意：worker 常驻进程，**部署后需 restart 生效**；轮询 worker 无行时空转（2s 一次查表，开销可忽略）
- 测试：`src/lib/intake/weixin.test.ts`（协议 23 条）/ `weixin-worker.test.ts`（游标纪律 + bind + 两段式 10 条）/ `weixin-qr-login.test.ts`（登录状态机 6 条）
