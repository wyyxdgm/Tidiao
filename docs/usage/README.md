# 使用说明文档

> 提调（Tidiao，原 Agent Orchestrator）平台的使用手册。面向**使用者**（创建任务、看板操作、定时调度等），不面向代码开发。
> 开发者文档（架构 / API / 部署）见 [上一级 docs/](../) 索引。

---

## 📖 文档树

| # | 章节 | 覆盖范围 |
|---|------|---------|
| 🗺️ | [功能地图](./feature-map.md) | **10 大功能域树状总图**：L1 域一句话 → L2 功能点+文档指针 → L3 代码证据。「系统有啥功能」从这里看 |
| 00 | [Skill 树总览](./00-skill-tree.md) | 平台能力双通道索引 · 5 类 skill 树 · 一表全 skill · 5 场景决策路径 |
| 01 | [快速上手](./01-getting-started.md) | 注册登录 · API Key · 核心概念 · 第一个任务 |
| 02 | [项目与版本](./02-projects.md) | 项目管理 · 版本管理 · 看板视图 · 导航树 |
| 03 | [任务管理](./03-tasks.md) | 任务创建 · 调度排队 · 状态机 · 并发控制 |
| 04 | [任务详情页](./04-task-detail.md) | 实时输出 · 对话 · 工具审批 · 提问 · 检查点 · 分叉 · 回退 · 附件 · 会话转录/导出 |
| 05 | [定时任务](./05-scheduling.md) | cron/once · agent/shell 两种执行体 · 防重 |
| 06 | [Webhook](./06-webhooks.md) | 事件订阅 · 9 种事件 · 投递历史 |
| 07 | [预设与复用](./07-presets.md) | 模板 · 角色 · 配置快照 |
| 08 | [批量导入与飞书同步](./08-import-sync.md) | CSV/JSON/Markdown 导入 · 飞书 sheet 双向同步 |
| 09 | [项目 Wiki](./09-wiki.md) | INDEX.md 入口 · 文件树 · 深链接 |
| 10 | [设置](./10-settings.md) | LLM 配置 · API Token · 并发 · Preflight · 提示音 |
| 11 | [CLI 工具](./11-cli.md) | ao-dispatch · ao-chat · ao-session（会话导出/导入）· cron · user · backup-db · login |
| 12 | [统计与监控](./12-stats-monitoring.md) | 任务统计 · 全局看板 · 花费追踪 |
| 13 | [甲方 Intake Bot](./13-intake-bot.md) | 企微微信客服 · 甲方直连 AI · 双通道 · 48h 窗口 · 排查 |
| 14 | [需求点管理](./14-requirement-management.md) | Requirement 实体 · 飞书同步（弱/强）· 迭代视图 · 派新迭代 · 打回 · 归档 |
| 15 | [通用通知](./15-notifications.md) | 通知渠道配置（email + 飞书）· CLI `scripts/notify.sh` · HTTP `/api/notify` · AI 对话触发 · 飞书 webhook 配置速查 |
| 16 | [资源池](./16-assets-pool.md) | 跨任务附件汇总 · 类型 tab + 来源下拉 + 项目/版本/搜索 · 批量删 |
| 17 | [需求点 API](./17-requirements-api.md) | AI 编程用接口（HTTP + `scripts/requirements.sh`）· CRUD + 派 task + 时间线 · 入参/出参/错误码/反模式+ curl 示例 |
| 18 | [Goal-driven Loop](./18-goal-loop.md) | 条件完成型长跑任务（`<goal>` marker + Haiku grader + 智能续跑 / fork）· 3 配置项 · 成本估算 · FAQ · 与 verification 关系 |
| 19 | [项目模板](./19-templates.md) | 3 套出厂项目模板（Hello Agent / 需求协作 / 长跑开发）· JSON 源 · UI「从模板建」按钮 · 自己加模板 |
| 20 | [任务画布总控制台](./20-console.md) | 单项目全景画布 · 状态动画 · 紧急×重要四象限 · 等我处理 · 排队区 · AI 一句话派活（R177 P1）|
| 21 | [构思画布](./21-ideas.md) | 跨项目构思层：一 idea 一球（playcanvas 3D，关联度/时间线两视图）· 假设-验证-归因回路（假设/判据/窗口/收益面板/反馈信号）· 构思流程 DAG · 人工分拣列表 · `ao idea`/`ao list` CLI |

---

## 🚀 30 秒上手

```bash
npm install && npm run dev   # -> http://localhost:13000
```

注册 → 登录 → 设置页填 API Key → 创建项目 → 新建任务 → 启动。详见 [01-快速上手](./01-getting-started.md)。

---

## 🧠 核心概念

| 概念 | 说明 | 类比 |
|------|------|------|
| **项目（Project）** | 任务的必填归属，绑定一个工作目录（cwd） | git 仓库 |
| **版本（Version）** | 项目下的可选分组，可绑定飞书 sheet；每个项目有一个 current_version（类似 HEAD） | git 分支 |
| **任务（Task）** | 一个待执行的工作单元，关联一个 Claude Code agent session | 一个 PR / 一个工单 |
| **Session** | Claude Code 的对话历史，通过 Agent SDK 的 `query()` 驱动。**完整内容落在 SDK 的 jsonl 文件里，不在数据库**（DB 的 `events` 表只是稀疏日志）——看会话/导出/备份都以 jsonl 为准，详见 [04](./04-task-detail.md) | 一次对话 |
| **调度器** | FIFO 队列 + 并发控制（全局 + 每 cwd 互斥 + 每用户上限） | 任务队列 |

**任务状态流转**（9 种状态）：

```
pending(待执行) → queued(排队中) → running(运行中)
                                    ↓
              paused(已暂停) ←── 超时/手动
              reviewing(待审核) ←── agent 完成
              failed(失败) ←── 出错/超时
              completed(已完成) ←── 审核通过
              rejected(已驳回) ←── 审核打回
              cancelled(已取消) ←── 手动/超时
```

任何终态都可通过发消息或重启回到 running。详见 [03-任务管理](./03-tasks.md#状态机)。

---

## 📝 文档维护约定（重要）

> **规则：每次功能开发（新增 / 修改 / 移除功能），必须同步更新 `docs/usage/` 中对应章节的具体功能点。**

### 怎么更新

1. **新增功能** → 在对应章节末尾追加一个「功能点」小节
2. **修改功能** → 找到对应功能点，更新描述
3. **移除功能** → 删除对应功能点，或在标题标注 `~~已移除~~`
4. **新增模块**（没有对应章节）→ 新建章节文件（`NN-name.md`，序号递增），并在本 README 文档树表中登记

### 功能点格式

每个章节用「功能点」小节组织，便于精准定位和更新：

```markdown
### 功能点：XXX

- **是什么**：一句话说明
- **怎么用**：操作步骤
- **注意**：边界 / 限制 / 依赖
```

### 功能区 → 章节速查

| 改了什么功能 | 更新哪个章节 |
|------------|------------|
| 注册 / 登录 / Token | 01-快速上手、10-设置 |
| 项目 / 版本 / 看板 | 02-项目与版本 |
| 任务创建 / 调度 / 状态 | 03-任务管理 |
| 详情页（输出 / 审批 / 提问 / fork / 附件）| 04-任务详情页 |
| 定时任务 | 05-定时任务 |
| Webhook | 06-Webhook |
| 模板 / 角色 / 配置快照 | 07-预设与复用 |
| 导入 / 飞书 | 08-批量导入与飞书同步 |
| 项目 Wiki | 09-项目 Wiki |
| 设置页任何项 | 10-设置 |
| CLI 工具 | 11-CLI 工具 |
| 统计 / 看板 | 12-统计与监控 |
| 习惯沉淀（项目特有偏好一行写一条）| 13.5-习惯沉淀 |
| 需求点管理（面向使用者）| 14-需求点管理 |
| 需求点 API（面向 AI / 自动化）| 11-CLI 工具（`requirements.sh` 子命令）+ 17-需求点 API |

### 检验标准

改完功能后自问：**对应章节的功能点是否与实际行为一致？** 不一致就先补文档再提交。
