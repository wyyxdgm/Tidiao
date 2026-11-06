# 功能地图（Feature Map）

> **定位**：提调平台「能干啥」的一页树 —— L1 功能域（一句话）→ L2 功能点（一句话 + 📖 文档指针）→ L3 证据（代码入口 / 实测数字 / 验证命令）。
> 生态位：README 文档树 = 按章节的手册目录；00-skill-tree = agent 用 skill 视角；**本文件 = 功能域视角的树状总图**。功能真相源仍在各 usage 章节。
> 维护约定：新增功能域/大功能时在本文件对应域下补一行 L2（一句话 + 指针），不展开细节。
> 证据口径：代码路径于 2026-10-29 实测存在（`ls` 校验）；数字为当日实测值。

---

## 1️⃣ 任务派发与执行（核心引擎）

一句话：**一句话派活给 AI agent，独立会话独立工作区并行跑，全程留痕可干预。**

- 创建任务 —— UI「+」弹窗 / CLI / API / 模板，4 个入口 → 📖 [03](./03-tasks.md) §创建任务
- 调度排队 —— FIFO + 三层并发闸门（全局 / 每 cwd 互斥 / 每用户）→ 📖 [03](./03-tasks.md) §调度与排队
- 实时输出 —— SSE 流式看 agent 干活，断线自愈重连 → 📖 [04](./04-task-detail.md) §实时输出
- 对话改需求 —— 对在跑/已停任务留言，agent 自己改代码跑验证，打回继续干 → 📖 [04](./04-task-detail.md) §对话输入
- 工具审批 + 提问 —— agent 要权限或要决策时弹给人拍 → 📖 [04](./04-task-detail.md) §工具审批
- Checkpoint / Fork / Rewind —— 任意节点分叉（fork 自带可选压缩）、文件回退 → 📖 [04](./04-task-detail.md) §检查点
- Goal Loop —— 条件完成型长跑（`<goal>` marker + 自动判分 + 智能续跑）→ 📖 [18](./18-goal-loop.md)
- 9 态状态机 —— 终态可复活：发消息/重启回到 running → 📖 [03](./03-tasks.md) §状态机
- 附件与资源池 —— 任务传图传文件落 cwd；跨任务附件汇总检索、批量删 → 📖 [04](./04-task-detail.md) §附件 + [16](./16-assets-pool.md)
  - ▲ 证据：`src/lib/runtime/agent-runtime.ts`（query 驱动）· `src/lib/runtime/task-scheduler.ts`（调度）· `src/lib/runtime/active-session.ts`（canUseTool/审批）· `src/lib/db/checkpoints.ts`（fork/回退）· 验证 `./scripts/ao doctor`

## 2️⃣ 项目 · 版本 · 看板 · Wiki

一句话：**项目绑工作目录，版本分组绑飞书 sheet；任务全景一块看板，repo 根目录即 Wiki。**

- 项目 / 版本 —— cwd 绑定、current_version（类比 git HEAD）、并发上限、超时 → 📖 [02](./02-projects.md)
- 项目概览看板 —— 每个项目一份 md（状态 / 常用链接 / 凭据），**加密存不进 git**；页面 tab + `ao overview` CLI 同一份 → 📖 [02](./02-projects.md) §项目概览看板
  - ▲ 证据：`src/lib/db/project-overview.ts` · `src/app/api/projects/[id]/overview/` · `spa/src/components/ProjectOverviewPanel.vue` · `spa/src/lib/wiki-markdown.ts` · `scripts/ao-overview.sh`
- 看板多视图 —— board 卡片（拖拽）/ 列表 / 聊天 / 分类，按喜好固定+浏览器记忆 → 📖 [02](./02-projects.md) §看板视图
- 任务画布总控制台 —— 单项目全景画布、紧急×重要四象限、AI 一句话派活 → 📖 [20](./20-console.md)
- 导航树 + 全局看板 —— 跨项目全景 + SSE 实时 + 手机可滚动 → 📖 [02](./02-projects.md) §导航树
- 项目 Wiki —— cwd 根 `INDEX.md` 即入口，文件树渲染 + 跨项目深链接 + board 引擎 → 📖 [09](./09-wiki.md)
  - ▲ 证据：`spa/src/views/`（30 个视图，实测 2026-10-29：GlobalBoard / ProjectBoard / ConsoleCanvas / ProjectWiki …）· `src/lib/board/`（board 引擎）· `src/lib/wiki-links.ts`

## 3️⃣ 需求点管理 · 飞书协作

一句话：**需求是一等实体：飞书表里改，agent 完工自动回写，人只看一个表。**

- Requirement 实体 —— 列表 / 详情 / 完成度量化 / 打回迭代 / 归档 → 📖 [14](./14-requirement-management.md)
- 飞书双向同步 —— sync 导入 + write-back 回写 + 列权限（AGENT_WRITABLE 不变量）→ 📖 [08](./08-import-sync.md) §飞书同步导入
- 需求点 API —— AI 编程用 HTTP + `scripts/requirements.sh`（CRUD + 派 task + 时间线）→ 📖 [17](./17-requirements-api.md)
  - ▲ 证据：`src/lib/feishu/sheets.ts` · `scripts/feishu.sh` / `scripts/requirements.sh` · `docs/plans/requirement-as-entity.md` §15（列漂移不变量）

## 4️⃣ 定时任务 · Webhook · 通知

一句话：**无人值守：到点自动派活，事件外推，通知回流。**

- 定时任务 —— cron 周期 / once 一次性 × agent / shell 两执行体；自适应频率 + 夜间智能降频 + 防重派 → 📖 [05](./05-scheduling.md)
- 卡死体检 —— `ao stuck` 诊断 paused 僵尸 + `--fix` 清理解锁 → 📖 [05](./05-scheduling.md) §cron 卡死体检
- Webhook —— 9 种事件订阅 + 投递历史可查 → 📖 [06](./06-webhooks.md)
- 通用通知 —— email + 飞书机器人，CLI `scripts/notify.sh` / HTTP `/api/notify` / AI 对话「通知我」触发 → 📖 [15](./15-notifications.md)
  - ▲ 证据：`scripts/cron.sh` · `scripts/notify.sh` · `docs/schedules.md` + `docs/api-schedules.md`

## 5️⃣ 消息渠道 · 甲方入口

一句话：**五路消息直达任务流：telegram 扫码 / 微信个人号 / 企微客服 / 飞书 / Lark。**

- 渠道扫码即接 —— telegram 深链一键绑、微信扫一次码自动建渠道（iLink 官方协议）、每路可挂默认角色 → 📖 [13](./13-intake-bot.md)
- 语音转文字 —— 微信语音自动 ASR 进需求线程，失败礼貌兜底 → 📖 [13](./13-intake-bot.md) §语音
- 甲方 Intake Bot —— 甲方直连 AI、双通道、48h 窗口 → 📖 [13](./13-intake-bot.md)
  - ▲ 证据：`docs/plans/channel-qr-bind.md` · usage/13 章全文

## 6️⃣ 构思画布（idea 层）

一句话：**想法一球一假设，拆节点派任务去验证，反馈信号抓取归因，收益面板对账。**

- 构思画布 —— playcanvas 3D 球（关联度/时间线两视图）+ 假设/判据/窗口/反馈信号回路，过窗未判自动标红 → 📖 [21](./21-ideas.md)
- 节点 DAG 画布 —— 拖卡片摆位、拖桩连线建依赖（成环自动拒）、执行节点琥珀游标 → 📖 [21](./21-ideas.md)
- CLI —— `ao idea` / `ao list` 直接操作构思 → 📖 [21](./21-ideas.md)
  - ▲ 证据：`spa/src/views/IdeasView.vue` · `docs/plans/idea-canvas.md` + `docs/plans/idea-node-dag.md`

## 7️⃣ 预设 · 模板 · 导入迁移

一句话：**把人设和流程存成预设一键复用；老家底（CSV/CLI 历史）一键搬进来。**

- 模板 —— 3 套出厂项目模板（Hello Agent / 需求协作 / 长跑开发），UI「从模板建」→ 📖 [19](./19-templates.md)
- 角色 —— 人设连 system_prompt + 模型/轮次默认存成角色，派发下拉一选带着跑，可按角色关飞书回写 → 📖 [07](./07-presets.md)
- 配置快照 —— 任务配置整包复用 → 📖 [07](./07-presets.md)
- 批量导入 —— CSV / JSON / Markdown 三格式 → 📖 [08](./08-import-sync.md)
- CLI 历史搬家 —— 本机 Claude Code 会话一键导入成任务，增量幂等 → 📖 [08](./08-import-sync.md) §CLI 历史
  - ▲ 证据：`spa/src/views/Templates.vue` · `src/lib/import/parsers.ts` · `scripts/import-cli-history.ts`

## 8️⃣ 统计 · 成本 · 监控

一句话：**成本归因一屏对账：单任务花费 + 全局按天/按模型统计 + 主机资源环。**

- 任务统计 / 花费分解 / 调度器状态 → 📖 [12](./12-stats-monitoring.md)
- 用量统计页 —— token 用量按模型/按天 → 📖 [12](./12-stats-monitoring.md) §用量统计页
- 资源可见 —— 看板运行中任务实时资源徽章 + 顶栏主机状态四环弹层（admin）→ 📖 [03](./03-tasks.md) §资源徽章
  - ▲ 证据：`spa/src/views/Stats.vue` / `Usage.vue` · `src/lib/git/collect-task-commits.ts`（commit 归因）

## 9️⃣ 设置 · 多模型 · 安全

一句话：**选厂商只填一个 Key（8 家国内目录日更），权限/并发/超时/维护模式全在这。**

- LLM 配置 —— 平台级（admin 多配置）+ 用户级，继承 fallback → 📖 [10](./10-settings.md)
- 供应商目录 —— 8 家国内厂商下拉即接，模型列表日更 → 📖 [10](./10-settings.md) + `docs/models.md`
- API Token / 并发控制 / 任务超时 / Preflight 自检 → 📖 [10](./10-settings.md)
- 维护模式（admin）+ Auth 多租户（JWT + owner_id 隔离）→ 📖 [10](./10-settings.md)
- 部署防护 —— deploy guard 防 agent 自部署自杀 → 📖 `docs/shared-standards/agent-sdk-standards.md` §3.5
  - ▲ 证据：`src/lib/db/settings.ts`（app_settings KV）· `src/lib/provider-catalog/`（catalog.json + zod）· `src/lib/runtime/deploy-guard.ts` · `src/lib/auth.ts`

## 🔟 CLI 工具链 · 知识沉淀

一句话：**`./scripts/ao` 统一入口：派发/聊天/会话导出/关键词召回，一条命令。**

- `ao` 统一入口 —— `ao help` / `ao doctor` 自检 / `ao query`（auto-login）/ `ao recall`（4 源并发关键词检索）/ `ao stuck` / `ao idea` → 📖 [11](./11-cli.md)
- 派发/聊天 —— `ao-dispatch.sh`（派任务）/ `ao-chat.sh`（交互聊天）/ `ao-session.sh`（会话导出导入搬运）→ 📖 [11](./11-cli.md)
- 习惯沉淀 —— 项目特有偏好一条命令写入，跨项目 `ao recall` 检索 → 📖 [13.5](./13-habits.md)
- 会话真相源 —— 完整会话在 SDK jsonl 不在 DB；导出/备份以 jsonl 为准 → 📖 [04](./04-task-detail.md) §会话转录
  - ▲ 证据：`scripts/ao` · `scripts/ao-dispatch.sh` / `ao-chat.sh` / `ao-session.sh` · `docs/cli-tools.md`

---

## 附：证据全景（一层看全集）

| 证据类型 | 数字 / 位置 | 实测日 |
|---|---|---|
| API 路由 | `src/app/api/**/route.ts` = **167 个**（`find … -name route.ts \| wc -l`）| 2026-10-29 |
| 前端视图 | `spa/src/views/*.vue` = **30 个** | 2026-10-29 |
| CLI 脚本 | `scripts/` 20+（ao / ao-dispatch / ao-chat / ao-session / cron / feishu / maintenance / deploy …）| 2026-10-29 |
| 运行时核心 | `src/lib/runtime/`（agent-runtime / task-scheduler / active-session / deploy-guard）| 2026-10-29 |
| DB schema | `src/lib/db/index.ts`（MIGRATIONS v1-v20+） | 2026-10-29 |
| 全量 API/页面清单 | `docs/api-routes.md`（⚠️ 数字偏旧，以上实测为准） | 2026-10-29 |
| 端到端验证 | `./scripts/ao doctor`（自检全过 = 平台活） | 随时可跑 |
