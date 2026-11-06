# 10. 设置

> 系统配置、LLM 凭据、多模态 mmx-cli Key、API Token、并发控制、维护模式、Preflight 自检、提示音偏好、Fork 压缩阈值。

## 概述

设置页（`/settings`）集中管理所有运行时配置。普通用户可配置个人 LLM 凭据、多模态 mmx-cli Key、API Token、并发和提示音。管理员额外可配置平台级 LLM 和用户授权。所有配置按用户隔离。

### 功能点：系统 API 配置

- **是什么**：只读展示环境变量级别的系统 API 配置状态。
- **怎么用**：访问 `/settings`，第一个卡片展示以下信息：
  - `ANTHROPIC_API_KEY` 是否已配置（绿/红圆点指示）。
  - 当前 `Base URL`（来自 `ANTHROPIC_BASE_URL` 环境变量）。
  - 默认模型（若环境变量设置了 `ANTHROPIC_MODEL`）。
- **注意**：
  - 此区块为只读，无法在页面修改，需在服务器环境变量中设置后重启服务。
  - 环境变量中的 API Key 仅作系统级 fallback。普通用户必须配置自己的 API Key 或被管理员授权才能运行任务。
  - 未配置时显示红色圆点并提示"agent 无法运行"。

### 功能点：平台 LLM 配置（管理员，v50 多配置）

- **是什么**：管理员可配置**多份**平台级 LLM 配置（每份命名区分，如"Claude 生产"/"火山方舟测试"），从其中选一份作为平台默认。被授权用户可使用平台默认配置；任务创建时也可从可见的 LLM 列表里选具体某一份来固定。
- **怎么用**：
  1. 管理员登录后，设置页显示"平台 LLM 配置"卡片。
  2. 点"+ 新增配置"，填：名称（必填，如 `Claude-Opus-生产`）、Base URL、Model、API Key。表单顶部同样有「快捷选择供应商」下拉（R240，见「个人 LLM 配置」节）——选厂商自动填 Base URL + 模型建议 + Key 获取链接。
  3. 点"保存"。第一份自动为默认；后续用"设为默认"按钮切换。
  4. 列表里每行：名称 / Base URL / Model / Key（脱敏显示如 `ark-***...***`）/ 默认标记 / 操作（编辑 / 设为默认 / 删除）。
  5. 删除不受默认/最后一份限制（R215）：默认行、最后一份都可直接删，删光后回落到环境变量 fallback。
- **注意**：
  - API Key 在数据库中加密存储，返回时脱敏显示。
  - 未配置任何平台 API Key 时，即使用户被授权也无法使用平台 LLM。
  - 管理员自身默认可用，无需额外授权。
  - 协议类型 `type` 当前固定 `anthropic`，UI 不暴露选择；字段已预留，后续扩展 OpenAI 等用。
  - 老数据迁移：v50 升级时单行自动变 `name='Default' + is_default=1`，不破坏现有 url/key/model。

### 功能点：用户授权（管理员）

- **是什么**：管理员授权普通用户使用平台 LLM 配置，并可设置每用户并发上限。
- **怎么用**：
  1. 管理员在"用户授权"卡片中查看所有用户列表（分页，每页 10 条）。
  2. 切换每行的开关，授权/撤销该用户使用平台 LLM 的权限。
  3. 在"并发上限"输入框中设置每用户最大并发数（1-10，留空=不限）。
  4. 输入框失焦时自动保存，右侧显示保存状态（`...`/`✓`/`✗`）。
- **注意**：
  - 管理员行显示"默认"标记，无需授权（始终可用）。
  - 并发上限为 `null`（留空）时表示不限，但仍受全局最大并发约束。
  - 授权状态和并发上限的变更实时生效。

### 功能点：Preflight 自检

- **是什么**：控制新任务启动时是否注入 preflight 自检要求。
- **怎么用**：
  1. 在"Dispatch 行为"卡片中切换 Preflight 开关。
  2. 开启时，每个新任务启动会在 prompt 头部注入 preflight 要求，agent 必须先报告 `pwd`、`git remote`、`last commit`。
  3. 派发者通过 SSE 看到自检结果后决定是否继续。
  4. 关闭时跳过自检，节省 1 轮 token。
- **注意**：
  - 默认开启。
  - 适合信任自己派发准确性的资深用户关闭以节省 token。
  - 设置按用户隔离，仅影响当前用户的任务。
  - 乐观更新：切换开关后 UI 立即响应，保存失败时回滚。

### 功能点：Git 提交身份（账号级，v515）

- **是什么**：账号级 git 提交署名（`user.name` / `user.email`）。配置后，你派出的 agent 子进程里 `git commit` 的作者/提交者都用这个身份，`git log` 直接可见——多账号共用一台机器时提交不再冒名机器全局配置的身份。
- **怎么用**：
  1. 设置 → 账号 → 「🌿 Git 提交身份」卡片。
  2. 用户名留空 = 取邮箱前缀；邮箱留空 = 取账号注册邮箱。
  3. 点「保存 Git 身份」，此后所有新任务的 git 提交生效。
- **注意**：
  - 通过环境变量（`GIT_AUTHOR_*` / `GIT_COMMITTER_*`）注入，优先级高于任何 git config；**不改**各仓库的 `.git/config`（同机多账号并发写共享仓会互相踩）。
  - 只传一个字段时另一个保持现值；空串/清除 = 回落默认。
  - 用户名 ≤128 字符、不能含 `<` `>` 换行（git 硬性要求）；邮箱不能填其他账号的注册邮箱（防冒名，409）。
  - 对已运行中的任务不生效（env 在任务启动时注入）。
  - 实现原理（开发者参考）：DB v515（`users.git_name/git_email`）+ `src/lib/db/users.ts` `resolveGitIdentity` + `active-session.ts` buildEnv 注入；测试 `src/lib/db/users-git-identity.test.ts`（13 条）+ `src/lib/runtime/agent-env-isolation.test.ts`（3 条）+ `src/app/api/user/me/git-identity.test.ts`（7 条）。

### 功能点：用户身份——昵称 + 自我介绍（账号级，v518）

- **是什么**：告诉 agent「用户是谁、喜好是什么」。配置昵称 + 自我介绍后，每个新任务的 agent 会话开头会收到一段身份 system-reminder（每会话一次，不逐轮重复），对话与汇报就用这个称呼，不再从邮箱前缀 / 项目文件里的名字猜。设计参考 OpenClaw 的 `USER.md`（About Your Human，每 session 全局加载）。
- **怎么用**：
  1. 设置 → 账号 → 「🪪 用户身份（agent 视角）」卡片。
  2. 填昵称（如「老王」）和自我介绍（如「偏好简洁汇报」「讨论技术直接给结论」）。
  3. 点「保存用户身份」，此后所有新任务的 agent 生效。
- **注意**：
  - 解析规则（R222 原文）：配置了就用配置的；**昵称没配默认「用户」；自我介绍没配省略整行**。
  - 未配置时也会注入默认身份（称呼=用户），主动对冲「项目文件里出现 damo 等名字被 agent 误称」的问题。
  - 昵称 ≤64 字符、不能含换行；自我介绍多行自由文本 ≤2000 字符（防灌 agent 上下文）。
  - 只传一个字段时另一个保持现值；空串/清除 = 回落默认。
  - 对已运行中的任务不生效（reminder 在任务启动时拼进首条 prompt）；resume 的任务带着历史里的旧 reminder。
  - 实现原理（开发者参考）：DB v518（`users.nickname/bio`）+ `src/lib/db/users.ts` `setUserProfile`/`resolveUserProfile` + `active-session.ts` `userProfileReminder()`（start() head 第三段，内容直注不指路文件——总共几行，多一次 Read turn 反而亏）；测试 `src/lib/db/users-profile.test.ts` + `src/app/api/user/me/profile.test.ts` + `src/lib/runtime/user-profile-reminder.test.ts`。

### 功能点：个人 LLM 配置（v50 多配置）

- **是什么**：用户可配置**多份**自己的 LLM 配置（命名区分），从其中选一份作为个人默认。被管理员授权后，任务/模板创建时可从「自配 + 平台」聚合的可见列表里选。
- **怎么用**：
  1. 在"个人 LLM 配置"卡片里点"+ 新增配置"，填名称（必填）/ Base URL / Model / API Key。
  2. 点"保存"——第一份自动为默认；后续用"设为默认"切换。
  3. 已配列表每行显示名称 / Base URL / Model / Key / 默认 / 操作。
  4. 编辑已有配置时：API Key 框留空保留原 key，勾选"清除现有 key"才真清空。
  5. 卡片下方"可见的 LLM 配置（任务/模板可从这里选）"区块显示聚合列表：`我的`（自配）+ `平台`（被授权时）。任务和模板创建表单里这个列表作为下拉选择器。
- **快捷选择供应商（R240）**：新增/编辑表单顶部有「快捷选择供应商」下拉，内置 8 家国内厂商（火山方舟 / DeepSeek / 智谱 GLM / Kimi / MiniMax / 阿里百炼 / 硅基流动 / 腾讯混元）。选中后自动填 Base URL + Model 建议列表切到该厂商 + 显示 Key 获取链接——**用户只需再填一个 Key 即可保存**。编辑已有配置时按 Base URL 自动反查匹配厂商；手动改 Base URL 也会实时联动。模型列表由 `scripts/update-provider-catalog.ts` 日更（拉各厂商 `/models` 端点 merge 回 `src/lib/provider-catalog/catalog.json`，目录数据源见 `docs/models.md`）。
- **注意**：
  - 运行任务必须配置个人 API Key，或被管理员授权使用平台 LLM。
  - 若被管理员授权且未配置个人 Key，会显示绿色提示"你已被管理员授权使用平台 LLM 配置"。
  - LLM 配置优先级：任务显式选定 (`tasks.llm_config_id`) → 模板绑定 → 项目默认 → 个人默认 → 平台默认（需授权）→ 环境变量 fallback。
  - API Key 在数据库中加密存储，返回时脱敏。
  - 撤销授权后平台列表消失，自配仍可用。

### 功能点：个人多模态 API Key（mmx-cli，v48）

- **是什么**：minimax 全模态平台（mmx-cli）的个人 API Key + region 配置。供 agent 在任务中调用 `mmx image` / `mmx video` / `mmx music` 等命令生成图片/视频/音乐。
- **怎么用**：
  1. 在「🎨 多模态 API Key (mmx-cli)」卡片里输入 minimax API Key（密码框）。
  2. 选择 region：`cn`（国内端点 api.minimaxi.com，默认）/ `global`（海外端点）。
  3. 点「保存」——DB 加密存 + 后端自动 `mmx auth login` 写到 per-user `$ORCHESTRATOR_HOME/users/<id>/.mmx/config.json`，下次 agent 启动即用。
  4. 已配置后点「更换」修改 Key、「清除」删除 Key（保留 region）、「删除全部」清空整条记录（需二次确认）。
  5. 点「测试」按钮调 `/api/user/media-key/test` 在临时目录跑 `mmx auth login + mmx quota`，验证 Key + region + 网络可达性。
- **注意**：
  - 🔴 **mmx-cli 不读 `MINIMAX_API_KEY` env**——必须落到 `$MMX_CONFIG_DIR/config.json` 明文文件，agent 子进程会自动读。平台做法：buildEnv 注入 per-user `MMX_CONFIG_DIR`，API 端「保存」时 `mmx auth login` 写入。
  - Key 在 DB 里 AES-256-GCM 加密存（与 LLM Key 同体系），GET 返回脱敏（`sk-***...***xyz`）。
  - 区域只支持 `cn` / `global`，其他值 PUT 时返 400。
  - mmx-cli 未装的部署机不影响保存（DB 仍写入），但 agent 跑 `mmx` 命令会 ENOENT 报错——装 `npm i -g mmx-cli` 即可。
  - 多用户同机安全：`buildEnv` 注入 per-user `MMX_CONFIG_DIR`，未配时 delete 平台残留 env，绝不共享 `~/.mmx`。
  - 跨机器不自动同步：每台机器各自走「保存」一次（API 端就地写本机 config.json）。

### 功能点：API Token

- **是什么**：不过期的个人访问令牌，供 CLI 工具和脚本调用 API。
- **怎么用**：
  1. 在"API Token"卡片中输入名称（如 `CLI-local`）。
  2. 点击"创建 Token"。
  3. Token 仅显示一次，立即复制保存（格式为 `ao_` 前缀的 bearer token）。
  4. 在 CLI 中使用：`Authorization: Bearer <token>`。
  5. 列表可搜索（按名称）、多选、批量删除；列表超过 8-10 行时内部滚动（卡片不被撑高）。
  6. 删除前需在弹窗确认（单条 / 批量均走 `ConfirmDialog`）；批量删除时若包含 `switch-account`（登录时自动签发的切换账号专用 token），提示「删除后下次登录会自动重建」。
  7. 也可在 CLI 中删除：`user.sh tokens-rm <id>[,<id>...]`（逗号分隔，调 `POST /api/api-tokens/delete-batch`）。
- **注意**：
  - Token 不过期，适合长期运行的脚本和 CLI 工具。
  - 删除仅清理数据库记录，Token 在服务端轮换 `JWT_SECRET` 后才彻底失效。
  - 每个 Token 都有独立的名称标识，方便管理。
  - 用法示例：`curl -H "Authorization: Bearer <token>" https://<host>/api/projects`。
  - 批量删除上限 100 个/次（路由层校验），跨用户 id 静默忽略（DB 层 `WHERE user_id` 过滤）。

### 功能点：并发控制

- **是什么**：全局最大并发任务数的滑块设置（1-10）。**v39 起落库**（`app_settings.max_concurrency`），pm2 重启仍生效。
- **怎么用**：
  1. 在"并发控制"卡片中拖动滑块设置最大并发数（范围 1-5）。
  2. 下方实时显示当前运行数和排队数。
  3. 点击"保存运行配置"（同一个按钮也保存下方的「任务超时」）。
- **注意**：
  - 这是全局并发上限，所有用户共享。
  - 每用户还可有独立的并发上限（由管理员设置，见"用户授权"）。
  - 每 cwd 目录还有互斥锁，同一工作目录同时只能运行一个任务（项目可用 `parallel_limit` 放宽）。
  - 修改后立即影响新任务的调度，正在运行的任务不受影响。
  - 保存时同时落库 + 改调度器内存值：立即生效**且**重启仍在。新实例未设置过时缺省 2。

### 功能点：任务超时（全局默认，v40）

- **是什么**：单个任务最长运行多久的**全局默认值**（1-1440 分钟，缺省 30）。存在 `app_settings` 表里，**pm2 重启仍生效**（与上面的并发数不同）。
- **怎么用**：
  1. "任务超时（全局默认）"卡片里填分钟数。
  2. 点击"保存运行配置"（管理员才有权限写，非管理员会收到 `admin required`）。
  3. 单个项目要不一样的值 → 项目列表 → 高级选项 →「任务超时」覆盖（留空 = 继承这里）。
- **注意**：
  - 到点后任务走「暂停」同一条路径（保留上下文可恢复），不是取消。
  - 🔴 `paused` 是非终态，会挡住同一个 schedule 的后续触发 —— 调长超时等于把这段窗口一起调长。
  - **对已在跑的任务不生效**（下一次启动/恢复才吃到新值）。
  - 新实例未设置过时缺省 30 分钟（不再有环境变量入口）。

### 功能点：维护模式（管理员）

- **是什么**：部署前有序关停平台任务，部署后一键恢复。解决的问题是：直接重启服务会连 agent 的 SDK 子进程一起杀掉，**正在跑的任务会丢上下文**。关停会挂起运行中的任务并保留其 session，恢复时能续上完整对话历史。
- **怎么用**：
  1. 在"维护模式"卡片点「关停任务」→ 确认框二次确认。
  2. 卡片变琥珀色并显示「🔧 维护中」+ 进入时间 + 挂起任务数。
  3. 执行部署（重启服务等）。
  4. 回到本页点「恢复运行」，挂起的任务自动重新跑起来。
- **关停时发生什么**：
  - 运行中的任务被挂起（当前这一轮**会被打断**，但 `session_id` 保留 → 恢复后续完整 transcript）。
  - 排队中的任务被摘下队列（恢复时重新入队）。
  - 定时任务轮询停止（不会在关停期间造出新任务）。
- **注意**：
  - **仅管理员可见可用** —— 影响全平台所有租户的任务调度。
  - 维护期间点任务的「启动」不会报错，任务停在"排队中"，恢复后自动执行。
  - 恢复**只处理关停时挂起的那批**；你自己手动暂停的任务不会被唤醒。
  - 维护期间被手动处理过的任务（通过/取消/删除）恢复时自动跳过，不报错。
  - 状态存在数据库里 —— **重启服务后仍处于维护模式**，必须显式点「恢复运行」才放行。
  - 关停会打断当前那一轮工作，可能留下半改的文件；agent 恢复后从 transcript 继续。
- **CLI / 自动化**：
  - 手动：`scripts/maintenance.sh enter|exit|status`
  - 部署时自动包住：`./scripts/deploy.sh -- --drain`（需 admin token）

### 功能点：提示音设置

- **是什么**：任务详情页收到特定事件时播放提示音，按事件类型独立开关。
- **怎么用**：
  1. 在"提示音设置"卡片中切换总开关（关闭后全部静音）。
  2. 总开关开启后，显示 7 个事件类型的独立开关：
     - **工具需审批**：agent 使用写入类工具时需你批准（默认开）
     - **需回答问题**：agent 通过 AskUserQuestion 向你提问（默认开）
     - **任务待审核**：agent 完成工作，等待你审核（默认开）
     - **任务失败**：agent 出错或异常结束（默认开）
     - **任务已暂停（自动）**：超时等待人工输入时自动暂停（默认关）
     - **排队中**：并发已满，任务进入排队（默认关）
     - **任务已取消（自动）**：运行超时被强制取消（默认关）
  3. 点击"测试提示音"按钮试听效果。
- **注意**：
  - 纯客户端实现，设置存储在浏览器 `localStorage`，不跨设备同步。
  - 提示音使用 Web Audio API 合成（880Hz 正弦波，0.2 秒短促 beep），无需音频文件。
  - 首次使用需有用户手势交互（浏览器 autoplay policy 限制），AudioContext 首次可能 suspended，会自动 resume。
  - **自动 vs 人为区分**：`paused` 和 `cancelled` 事件仅在系统自动触发时响铃（如超时），用户手动暂停/取消时不响（因为用户正在看页面）。
  - 服务端重启导致的暂停无法触发提示音。

### 功能点：Fork 自动压缩阈值

- **是什么**：控制 Fork 弹窗中「压缩后继续」复选框的自动勾选行为。
- **怎么用**：
  1. 在"Fork 自动压缩阈值"卡片中输入一个 token 数值（默认 100000，即 100k）。
  2. 打开 Fork 弹窗时，若父任务上下文（`context_tokens`，任务停止时的快照）超过此阈值，自动勾选「压缩后继续」。
  3. 自动勾选后仍可手动取消。
- **注意**：
  - 纯客户端实现，设置存储在浏览器 `localStorage`，不跨设备同步。
  - 阈值比较基于父任务最后一次停止时记录的上下文占用，非实时值。

### 功能点：通知邮箱（v41）

- **是什么**：本账号接收平台通知（目前是任务超时）的邮箱地址。
- **怎么用**：
  1. 在"📧 通知邮箱"卡片中填入邮箱地址，点「保存」。
  2. 点「发送测试邮件」真发一封到**已保存**的地址（改了输入框请先保存再测试）。
  3. 留空并保存 = 清空，通知回落到平台系统邮箱（env `NOTIFY_FALLBACK_TO`）。
- **注意**：
  - 收件人解析链：`users.notify_email` 非空 → 用它；否则 `NOTIFY_FALLBACK_TO`；两者都没有 → 不发（静默跳过，不报错）。
  - 平台未配置 SMTP 时卡片顶部会显示黄条提示，此时填了也发不出。SMTP 配置在 `.env.local`（`SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `NOTIFY_FROM` / `NOTIFY_FALLBACK_TO`）。
  - 「发送测试邮件」端点**不接受请求体里的任意地址**，只发到解析出的收件人 —— 否则就是个开放中继，任何登录用户都能借平台 SMTP 往外发信。
  - 邮箱格式校验在后端（唯一判据），前端只显示错误。

### 功能点：飞书机器人（v47）

- **是什么**：本账号的飞书自定义机器人 webhook URL。通用通知 CLI/HTTP（`scripts/notify.sh`、`POST /api/notify`）会把消息推到这里。
- **怎么用**：
  1. 在飞书群里开一个**自定义机器人**（群设置 → 群机器人 → 添加机器人 → 自定义机器人），复制它的 webhook URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/<token>`）。
  2. 在设置页"🤖 飞书机器人"卡片粘贴 URL，点「保存」。
  3. 点「发送测试消息」真发一条到飞书群确认配置可用。
- **注意**：
  - **webhook URL 是半秘密**：拿到就能往那个群发机器人消息。设置页只显示末 4 位脱敏（如 `****abcd`），不显示完整 URL。`GET /api/user/me` 永远不回明文。
  - 「发送测试消息」端点**不接受请求体里的 URL**，只发到 DB 里存的 webhook —— 否则就是个开放中继。
  - URL 格式校验在后端：`https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，token 长度 16-256 字符。
  - 没配 webhook 时通用通知的飞书渠道会静默跳过（不报错），`summary=none`。`feishu_configured` 布尔可读但要查看脱敏值走 `GET /api/user/me/webhook-meta`。
  - 飞书消息默认 markdown 格式（支持标题/列表/代码块），可显式传 `msg_type: "text"` 切纯文本。
  - 「关键词策略」是飞书群机器人的安全设置：消息必须含配置时设的关键词至少一个，不在本平台做限制。

### 功能点：通用通知（v47，给其他项目用）

- **是什么**：平台唯一的"把人/事告诉操作员"出站原语。CLI `scripts/notify.sh` + HTTP `POST /api/notify`，两渠道（email / 飞书）可单选或并发。
- **怎么用**：CLI 在 cwd 跑 `bash scripts/notify.sh --channel feishu --message "..."`（自动鉴权）；HTTP 走 `Authorization: Bearer $AO_TOKEN`。**普通用户发给自己**（默认），**admin 可指定 `--user <id>` / `--to <email>` 代发/改收件人**。
- **注意**：
  - 非 admin 传 `--user`/`--to` → CLI 在 description 里写明"admin-only"（HTTP 端点会返 403）。
  - 出口仍走 SMTP / 飞书 webhook 两套现成链路，**调用方不需要持凭据**。
  - 不要给现有 `task-timeout.ts` 改成调 `/api/notify`（绕开去重标记 + 加网络往返），用 skill `notify` 复用现成出站。
  - 详见 `.claude/skills/notify/SKILL.md`（AI 触发入口，含 CLI 用法 + HTTP schema + 排障三步）。

### 功能点：账号配额（管理员，R50.1 SPA）

- **是什么**：管理员给用户设三件套配额（`party_a_enabled` 甲方开关 + `quota_total_spent_cap` 费用上限 + `quota_granted_cap` 授予上限 + `quota_expire_at` 到期日期）+ 变更历史。**仅 admin 可见**（卡片渲染在「平台管理」tab 下）。
- **怎么用**：
  1. 管理员登录后，「平台管理」tab → 「💰 账号配额」卡片。
  2. 每用户一行：邮箱 + 甲方标记 badge + party_a 开关 + 用量进度条（party_a=1 且有上限才显示，超过 80% 变琥珀，超过 100% 变红）+ 三件套输入框（onBlur 自动保存）+ 「查看变更历史」折叠按钮。
  3. 开关翻转、任一输入框失焦立即 PATCH `/api/admin/users/[id]`，不阻塞 UI（乐观：保存中按钮 disabled）。
  4. 点「查看变更历史」→ 懒加载 `/api/admin/users/[id]/quota-log?limit=50`，列出 50 条 `field` / `old_value → new_value` / `reason` / `created_at`。
  5. 列表**服务端分页**（AO-DEV R208）：底部标准 Pagination 条（每页大小切换 + 跳页 + 首末页），默认每页 20 条，切每页大小自动回第 1 页。后端 `GET /api/admin/users?page=&pageSize=` 返 `{users, total, page, pageSize}`（不传参数保持旧全量形状向后兼容；非法参数 400，pageSize 上限 200）。
- **注意**：
  - 后端路由 `GET /api/admin/users` + `PATCH /api/admin/users/[id]` + `GET /api/admin/users/[id]/quota-log` 已在 master 全部就绪（R88 Sheet L 验收 ④ 后端）。
  - 非 admin 拿 403 → SPA 静默不渲染（与维护模式策略一致）。
  - `party_a_enabled` 是拦截开关（决定三件套是否生效），其它 3 个字段是展示/拦截值。`granted_cap` 仅展示不参与拦截（与 Sheet H 列明文一致）。
  - 进度条颜色规则：< 80% 蓝、80-99% 琥珀、≥ 100% 红，0 进度时显示 `0%`。
  - SPA 与 Next.js 完全镜像（master `src/app/settings/page.tsx:1794-1979`），所有 PATCH 字段含义与边界（null = 清空、ISO8601 校验、number 校验）走同一后端契约。

### 功能点：个人 LLM 配置 CRUD（v50，R50.3 SPA）

- **是什么**：用户在「设置 → 账户」tab 看到「🤖 个人 LLM 配置」卡片，可对**自己**的多份 LLM 配置做 CRUD + 设为默认 + 拷贝 + 复制成文本。**镜像 master `src/app/settings/page.tsx:2314-2500`**。
- **怎么用**：
  1. 点「+ 新增配置」展开表单，填：名称 *（必填）/ Base URL（默认取平台 `ANTHROPIC_BASE_URL`）/ Model / API Key（密码框）。
  2. 点「保存」→ POST `/api/user/llm-config`；第一份自动为默认。
  3. 已配列表每行：名称 / Base URL / Model / Key 脱敏 / 默认标记 + 5 个操作按钮（设为默认 / 编辑 / 拷贝 / 📋 复制 / 删除）。
  4. 编辑已有：API Key 框留空保留原 key；勾选「清除现有 key」才真清空。
  5. 「拷贝」POST `/api/user/llm-config/[id]/duplicate`，新行名加 `-拷贝` 后缀（冲突自动 -2/-3）。
  6. 「📋 复制」拼 6 行 markdown 风格文本到剪贴板（API Key 走脱敏 `api_key_masked`，明文不让出页面）。
  7. 「删除」走浏览器 `confirm()` 二次确认，默认行按钮 disabled（与 master 一致）。
  8. 卡片底部「可见的 LLM 配置（任务/模板可从这里选）」聚合块：自配 = `我的` badge + 蓝，admin 授权 = `平台` badge + 琥珀。任务和模板创建表单把这份聚合列表当下拉数据源。
- **注意**：
  - **至少 1 份**：标题旁有琥珀 badge 提示，避免跑任务时报"无默认 LLM"。
  - API Key 在 DB 加密存储，返回脱敏（如 `sk-***...***xyz`）。📋 复制只复制脱敏值，明文不出页面。
  - 删除走浏览器原生 `confirm()`（不是 `ConfirmDialog`），与 master 同款；默认行按钮 disabled 而不是 confirm 时拦截（master 也是 disabled，更早给反馈）。
  - 后端 7 端点全部就绪：`GET/POST /api/user/llm-config`、`PUT/DELETE /api/user/llm-config/[id]`、`POST /api/user/llm-config/[id]/{default,duplicate}`、`GET /api/user/llm-config/available`。
  - 后端 `name` 冲突返 409 + `code: "name_conflict"`，前端弹错误信息。
  - SPA 类型 `LlmConfigSafe` + `AvailableLlmConfig` 字段对齐 master `src/lib/db/llm-configs.ts:37/62`。

### 功能点：/stats 顶部返回链接（R50.2 SPA）

- **是什么**：`/stats` 页面顶部一条「← 返回」链接，对应 Next.js `src/app/stats/page.tsx:19-21` 的 `<Link href="/">`。
- **怎么用**：访问 `/stats`，页面顶部就能看到「← 返回」，点回平台首页。
- **注意**：
  - master 走 `Link href="/"`，但 SPA 路由里 `/` 是带子路由的 LayoutContainer（`projects` / `tasks` / `schedules` 等），没有可用落地页。所以 SPA 走 `router-link to="/global"`（全局看板页 = master 首页 "项目总览" 的 SPA 镜像）。
  - 链接视觉用 `.back-link` 灰色 + 13px，hover 时加深，与 master `text-gray-600 hover:text-gray-900 text-sm` 视觉一致。

---

### 功能点：调度参数 admin 增强（R55.7 SPA）

- **是什么**：「设置 → 调度」tab 下，admin 可改全局并发 + 任务壁钟超时 + 端口池。R55.7 在已有的 `saveAppConfig` 基础上补端口池**单段端口范围** + **段数上下限**校验，与 master `page.tsx:836-844` 同口径。
- **怎么用**：
  1. 输入「并发上限」（范围 `config.concurrency_min`/`max`），下方实时显示 `当前运行 X / cap` + 队列深度。
  2. 输入「任务壁钟超时（分钟）」（范围 `task_timeout_min/min`/`max`）—— 改动落库，pm2 重启仍生效；改全局值不会重挂已在跑任务的定时器（它们按启动时解析值超时）。
  3. 端口池：每段两 input number，admin 可加段 / 删段 / 改段起止。`+ 段` 触发到 `port_pool_max_segments` 上限会 `toast.warn` 阻止；保存时单段校验：`start <= end + 1024-65535 整数` 范围内 + 0 段被拒。错误用红字 inline 报错。
  4. 点「保存调度参数」→ PATCH `/api/config`（含 concurrency / task_timeout_minutes / port_pool 三个字段）。前端 inline 报错 + 后端 `fieldErrors` 落回红字 + 网络错误 toast。
- **注意**：
  - 改端口池**不级联校验**已有项目端口：历史已分配端口可能在新池外，但仍在用，不强迁（与 master `page.tsx:2942-2943` 同款）。
  - 端口段最少 1 段，最多 `port_pool_max_segments`（默认 8）。0 段校验拒（前端拦截，不发请求）。
  - 后端 `setPortPool` 还会做一次反向校验作为最后兜底，前端校验只是给即时反馈。

### 功能点：平台 LLM admin 配置（R55.8 SPA — admin only）

- **是什么**：「设置 → 平台管理」tab 下，admin 管理被授权用户可见的"平台 LLM 配置"（区别于用户的"个人 LLM 配置"）。这些配置在用户任务/模板创建表单的下拉里以「平台」badge 露出。镜像 master `src/app/settings/page.tsx:1548-1697`。
- **怎么用**：
  1. 顶部表格列出全部平台 LLM：名称 / Base URL / Model / API Key (脱敏) / 默认标记 / 操作。
  2. 操作 5 个按钮：**设为默认** / 编辑 / 拷贝 / 📋 复制（拼 JSON 到剪贴板，仅脱敏 key） / 删除。
  3. 点「+ 新增配置」展开表单（5 字段）：名称 *（必填）/ Base URL / Model / API Key（密码框，留空保留）/ 编辑时多「清除现有 key」checkbox。
  4. 保存 → POST（新增）或 PUT `/api/admin/llm-config/[id]`（编辑）；成功后表格 reload + adminLlmMessage 状态提示。
- **注意**：
  - 6 个端点全部就绪（master 已有）：
    - `GET/POST /api/admin/llm-config` — 列表 / 新建
    - `PUT/DELETE /api/admin/llm-config/[id]` — 编辑 / 删除
    - `POST /api/admin/llm-config/[id]/default` — 设为默认
    - `POST /api/admin/llm-config/[id]/duplicate` — 拷贝
  - 至少 1 个 admin LLM 配置是默认；删除默认行按钮 disabled。
  - API Key 走 `clear_api_key` checkbox 二态：勾选 = 清，传 `api_key: ""` = 视为无变化（与 master 同款前后端契约）。
  - 「📋 复制」走 `navigator.clipboard.writeText`，失败（非 https / 权限拒绝）→ `toast.error('复制失败 (浏览器权限?)')`。
  - 删除走浏览器 `confirm()`（非 `ConfirmDialog`，与 personal LLM 卡片同款 —— master 也用原生 confirm）。

### 功能点：用户授权 grants（R55.9 SPA — admin only）

- **是什么**：「设置 → 平台管理」tab 下，admin 可授权用户使用平台 LLM 配置（granted toggle）+ 设每账号并发上限（max_concurrency 1-10 或 null 不限）。镜像 master `src/app/settings/page.tsx:1701-1790`。
- **怎么用**：
  1. 每用户一行：邮箱 + role 标签（管理员 badge） / 并发上限 input number + 状态徽标（saving=… / saved=✓ / error=✗ / 1.5s 后回 idle） / granted 开关 toggle（admin 默认 enabled 且显示「默认」灰色字）。
  2. 并发上限 input blur → PUT `/api/admin/llm-grants` body `{ user_id, max_concurrency }`（1-10 整数或 null 留空）。后端落库 + 调度器 `invalidateOwnerLimit` 让队列新限制立即生效。
  3. 开关 → PUT `{ user_id, enabled }`。
  4. 用户表 10 行/页（GRANTS_PAGE_SIZE），翻页按钮「上一页/下一页 + N/M」。
- **注意**：
  - 端点：`GET /api/admin/llm-grants → { users: [...] }`、`PUT /api/admin/llm-grants body { user_id, enabled?, max_concurrency? }`（两者至少 1 个）。
  - 校验：1-10 整数，留空 = null = 不限。`max_concurrency` 后端落库 + 调度器缓存失效（queued 任务下一轮 dispatch 看到新值）。
  - mount 时拉一次（admin 守门），非 admin 走 403 静默吞（`isHttpError(e)` 处理），platform tab 实际只在 admin 角色渲染（`v-show` + `showPlatformTab` 守门）。
  - **翻页客户端做**：100 用户 = 10 页，避免 table 塞爆。`grantsPage` ref + `safeGrantsPage` 计算防止越界。

### 功能点：角色预设管理（波3 P5，2026-10-13 SPA）

- **是什么**：「设置 → 角色」tab。Role = 可复用配置包（system_prompt + model/effort/max_turns/allowed_tools/memory_doc 默认值），建任务时选中即继承，task 级显式字段优先。角色三态属性：
  - **项目绑定**（v525）：「全局」= 所有项目派发时都可选用；绑定具体项目 = 只在该项目派发时出现在角色下拉里。跨项目用专属角色会被 400 `ROLE_SCOPE_MISMATCH` 拒。
  - **飞书回写开关**（v527）：默认允许。禁止 = 该角色的任务完成后 rule-engine 不自动回写飞书（events 留 `feishu_writeback_skipped_by_role`）、UI 手动回写得 403 `ROLE_WRITEBACK_DISABLED`、agent 上下文注入「本角色不回写」提醒。注意是**行为开关**非安全边界——agent 用 shell 直写飞书技术上拦不住。
- **怎么用**：
  1. 设置 → 角色 → 「＋ 新建角色」：填名称 + system_prompt（必填），可选描述 / 模型覆盖（datalist 建议可手填）/ 推理强度 / 最大轮次 / 允许工具（CSV）/ memory_doc / 项目绑定 / 回写开关。
  2. 列表按行「编辑 / 删除」（删除走确认框，已有任务不受影响——role 随 task 定型）。
  3. 派发时选：新建任务「完整配置」模式 → 「角色预设」下拉（数据 = 全局 + 当前项目专属，随项目切换刷新）。
- **实现**：面板 `spa/src/components/RolesPanel.vue`（挂 Settings roles tab）；API `/api/roles` CRUD + `?projectId=` 过滤（getRolesForProject 语义：全局 + 项目专属合并）。角色本体见 [`docs/workflow.md`](../workflow.md) §9。

### 功能点：渠道接入管理（channel-role-ui D2，2026-10-13 SPA）

- **是什么**：「设置 → 渠道」tab。Channel config = 一个 IM 渠道实例，绑定一个项目 + 可选默认角色；外部用户给 bot 发「bind &lt;绑定码&gt;」完成会话绑定，之后消息直接在该项目下建 task（首 task 挂默认角色，P3 消费链路）。此前 channel_configs 只能脚本直插（R184），本功能点补上可视化管理宿主。
  - **类型三值开放**（damo 2026-10-13 拍板，替代同日早前的收窄口径）：telegram / wecom / feishu 三条 intake 线路均已落地消费 channel_configs，新建三值可选。**编辑已有行类型不可改**（渠道类型决定消费方协议，改了线路断）。openclaw 是外部智能体借道 intake_threads 的内部线程通道，不是消息渠道，不出现。后端 `INTAKE_CHANNELS` 枚举仍全量保留（API 层不收窄）。
  - **绑定粒度到版本**（v529，2026-10-13）：绑定项目选中后出现「绑定版本（可选）」下拉（数据 = 该项目版本列表）；指定后该渠道进来的需求固定落所选 version，不指定 = 跟随项目 current_version（原行为）。后端校验版本必须属于绑定项目（400 VERSION_PROJECT_MISMATCH）。
- **怎么用**：
  1. 设置 → 渠道 → 「＋ 新建渠道」：选类型、填名称 + secret（bot token 等，必填）、绑定项目（必填）、绑定版本（可选，空 = 跟随 current_version）、默认角色（可选，可选集 = 全局角色 + 绑定项目专属角色）。
  2. 列表展示：类型 / 名称（含凭据是否已配）/ 绑定项目 / 绑定版本 / 默认角色 / 启用状态 / 绑定码（**点击即复制**）。
  3. 编辑：**类型锁定不可改**；secret 密码框**留空 = 不修改**；默认角色传「未配」= 清除；绑定版本传「跟随 current」= 清除钉死；enabled 开关停用后渠道不响应绑定与新消息（bind_code 失效）。
  4. 删除：走确认框，不级联——intake 会话历史保留，只是渠道失效。
- **实现**：面板 `spa/src/components/ChannelsPanel.vue`（挂 Settings channels tab）+ `spa/src/api/channels.ts`；API `/api/channels`（GET owner 列表连带 project/role 名 + POST）/ `[id]`（PATCH / DELETE）。**secret / webhook_secret 一律不回传**（列表只有 `has_secret` 布尔）；错误码 `CHANNEL_NOT_FOUND` / `ROLE_NOT_FOUND` / `INVALID_CHANNEL`（no existence leak）。db 层 CRUD 见 `src/lib/db/channel-configs.ts`（v516，凭据 AES-256-GCM）；intake 消费链路见 [`13-intake-bot.md`](13-intake-bot.md)。

## 常见问题

**Q: 配置了 fallback 链后什么情况会触发切换？**
A: 两层机制（v514，飞书 R175）：① **同凭证模型级**（自动）— 链上与主配置同 API Key + 同 Base URL 的成员模型名会传给 SDK `fallbackModel`，主模型 overloaded / 不可用时按序切换，每个 user turn 会回试主模型；② **跨凭证起跑级** — 任务起跑阶段（模型还没说过任何一句话）调用失败时，按链换下一个**不同凭证**的配置整体重跑；模型已开口后的中途失败**不**换（避免丢对话进度）。典型场景：同一 Ark 代理配 glm-5.2 主 + minimax-m3 备 = 纯 SDK 层切换，无需第二把 key。
   **🆕 API 错误伪装成功也算起跑失败（2026-10-04 补丁）**：429 限流 / 鉴权失败等 API 层错误，SDK 会以「正常完成」收尾但正文是错误文本（R182）——这类情况视为零真实进度，起跑重试同样按链换凭证重跑；链尽才落 `failed`（`error` 带 `api_error:` 前缀）。重试期间不写中间 failed（不触发 webhook / 父通知双跳）。
   **🆕 throw 形态同样触发（2026-10-04 补丁二）**：起跑即 401/429 时 SDK 实际是**直接抛错**（result `subtype:'error'` → "Claude Code returned an error result: ..."），与伪装成功是两条路，补丁一只盖了后者。补丁二后零进度判据统一为「本轮模型没说过真话」，两条路都按链换凭证重跑（本地 E2E 实证：坏 key 主配置 → 3 分钟后自动换备用 key 跑到 reviewing）。
   **🆕 配置 key 优先于环境残留 token（同日）**：agent 子进程的认证优先级是 `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`，平台已为任务解析出明确 LLM 配置时会清掉继承的环境 AUTH_TOKEN —— 否则宿主机 env 里的占位 token 会让配置的 key 永远不生效（表现为配了有效 key 仍 401「令牌已过期」）。

**Q: 「支持视觉」标记有什么用？**
A: 任务带图片附件、且主模型被**明确**标为「不支持视觉」（选「未设置」时按模型名推断，推断不出来 = 未知，不触发）、且 fallback 链上有明确支持的成员时，起跑前自动把该成员提升为主模型（tasks.metadata.llm_fallback 有记录）。列表里 👁 = 支持、🚫👁 = 不支持、无标记 = 未知。

**Q: 忘记保存 API Token 怎么办？**
A: Token 仅创建时显示一次。如果忘记复制，删除该 Token 重新创建即可。

**Q: 个人 LLM 配置和平台 LLM 配置同时存在时用哪个？**
A: 优先使用个人配置。如果个人配置未设置 API Key 但被管理员授权，则使用平台配置。两者都没有时回退到环境变量。

**Q: 配了通知邮箱但收不到超时通知？**
A: 依次确认三件事：① 设置页点「发送测试邮件」能否成功（失败会把 SMTP 原始 reason 显示出来）；② 任务是**真的超时**而非手动暂停 —— 只有超时回调会发信；③ 同一个任务只发一次（去重标记落在 `tasks.metadata.timeout_notified_at`），恢复后再超时不会重复发。
