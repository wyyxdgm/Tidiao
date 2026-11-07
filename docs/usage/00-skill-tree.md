# Skill 树总览

> 平台能力的**双通道索引**：左侧走 skill（Claude Code 自动触发），右侧走文档（人工查阅）。
> 不知道从哪里开始？先看 [[orchestrator-onboarding]] 或本文件「5 个核心场景」段。

## 何时用本文件

- 想**找功能** → 不知道哪个 skill / 文档 → 看下方「5 类 skill 树」+「一表全 skill」
- 想**了解平台能力全景** → 看「完整度」列（绿色=核心完整，黄色=阶段 1 后续，灰色=阶段 2/3）
- 想**走 skill 触发** → skill 名 + 触发关键词直接在 Claude Code 里说，平台自动命中

## 5 类 skill 树

```
┌──────────────────────────────────────────────────────────────────┐
│ A 入门（5 分钟用上平台）                                          │
│   ├─ orchestrator-onboarding   meta-skill（决策树导航）           │
│   └─ orchestrator-quickstart   注册→login→建项目→派任务           │
├──────────────────────────────────────────────────────────────────┤
│ B 日常（90% 时间用这些）                                          │
│   ├─ orchestrator-query         只读查询                          │
│   ├─ orchestrator-manage        增删改 + 任务状态机               │
│   ├─ orchestrator-dispatch ⭐   派任务（skill 树锚点）            │
│   └─ 关键词检索                  bash scripts/ao recall <关键词>  │
├──────────────────────────────────────────────────────────────────┤
│ C 专项（按需启用）                                                │
│   └─ orchestrator-advanced      飞书 / 批量导入 / webhook / 评估  │
├──────────────────────────────────────────────────────────────────┤
│ D 运维（出问题时用）                                              │
│   ├─ orchestrator-ops           部署 / 备份 / cron / user         │
│   └─ orchestrator-stuck         卡死诊断 + 修复                    │
├──────────────────────────────────────────────────────────────────┤
│ E 高级（在 dispatch / manage 里 cross-link，不新加 skill）        │
│   └─ fork / checkpoint / DAG 模板 / M 模式无人值守               │
└──────────────────────────────────────────────────────────────────┘
```

> **5 类 = 用户认知路径**：先入门 → 再日常 → 再专项 → 出问题 → 高阶玩法。
> **不要把 stuck 塞到 ops 里**——卡死时找不到入口等于没做。

## 一表全 skill

| 分类 | skill 名 | 一句话功能 | 何时用 | 完整度 |
|------|---------|-----------|--------|--------|
| A | [orchestrator-onboarding](../../.claude/skills/orchestrator-onboarding/SKILL.md) | meta-skill，列出全部 skill + 5 场景决策路径 | 第一次用、不知道用哪个 | 🟢 完整 |
| A | [orchestrator-quickstart](../../.claude/skills/orchestrator-quickstart/SKILL.md) | 5 分钟跑通 demo（注册→login→建项目→派任务） | 新用户首次体验 | 🟢 完整 |
| B | [orchestrator-query](../../.claude/skills/orchestrator-query/SKILL.md) | 只读查询（list / get / stream / transcript / changes） | 想看状态、看结果、看 diff | 🟢 完整 |
| B | [orchestrator-manage](../../.claude/skills/orchestrator-manage/SKILL.md) | 增删改 + 任务状态机 + fork/checkpoint | 想新建 / 修改 / 推任务 | 🟢 完整 |
| B | [orchestrator-dispatch](../../.claude/skills/orchestrator-dispatch/SKILL.md) | 派任务（7 段 prompt 模板 + 监控） | 把工作交给 agent | 🟢 完整 |
| C | [orchestrator-advanced](../../.claude/skills/orchestrator-advanced/SKILL.md) | 飞书 sync/write-back / 批量导入 / webhook / 评估 | 集成第三方、批量操作 | 🟢 完整 |
| D | [orchestrator-ops](../../.claude/skills/orchestrator-ops/SKILL.md) | 部署 / 备份 / cron / user / 鉴权模型 | 平台层运维 | 🟢 完整 |
| D | [orchestrator-stuck](../../.claude/skills/orchestrator-stuck/SKILL.md) | 5 类卡死模式 + 修复命令 + 诊断流程图 | 任务卡住、cron 失语、SSE 中断 | 🟢 完整 |

> **完整度图例**：🟢 阶段 1 P0 完成；🟡 阶段 1 P1（下一波）；⚪ 阶段 2/3（远期）。

## skill 与文档双通道对照

| skill | 等价文档章节 |
|-------|-------------|
| onboarding | 本文件 + [01-快速上手](./01-getting-started.md) |
| quickstart | [01-快速上手](./01-getting-started.md) |
| query | [03-任务管理](./03-tasks.md) / [04-任务详情页](./04-task-detail.md) / [12-统计与监控](./12-stats-monitoring.md) |
| manage | [02-项目与版本](./02-projects.md) / [03-任务管理](./03-tasks.md) / [04-任务详情页](./04-task-detail.md) |
| dispatch | [11-CLI 工具](./11-cli.md) |
| advanced | [06-Webhook](./06-webhooks.md) / [08-批量导入与飞书同步](./08-import-sync.md) / [14-需求点管理](./14-requirement-management.md) |
| ops | [10-设置](./10-settings.md) / [11-CLI 工具](./11-cli.md) |
| stuck | 本文件「卡住怎么办」段 + [05-定时任务](./05-scheduling.md) §「cron stuck 排查」 |

## 5 个核心场景（决策路径）

### 场景 1：我没登录 / 拿不到 token

- 拿 7 天 session cookie：`POST /api/auth/login`，见 [01-快速上手 §登录](./01-getting-started.md)
- 拿不过期 `ao_` bearer token：`bash scripts/user.sh token --name "my-cli"`，见 [11-CLI 工具 §login](./11-cli.md)
- 远程自托管实例：`export AO_BASE_URL=https://your-host`

### 场景 2：我想建第一个项目

- 没建过项目 → [01-快速上手 §第一个项目](./01-getting-started.md) + [02-项目与版本](./02-projects.md)
- 建过但忘了 ID → 用 `bash scripts/ao query /api/projects`（auto-login + token cache）
- 想从模板建 → [19-模板](./19-templates.md)（3 套出厂：Hello Agent / 需求协作 / 长跑开发）

### 场景 3：我想派第一个任务

- 简单 fix（< 5 行）→ 直接派 `ao dispatch`，用 7 段 prompt 模板（[orchestrator-dispatch](../../.claude/skills/orchestrator-dispatch/SKILL.md)）
- 复杂任务 / 多文件 → 派 `ao dispatch` + `effort=high` + `maxTurns=150-200`
- 不知道派到哪个项目 → 看平台 Projects 列表 + 各项目 CLAUDE.md 的能力声明

### 场景 4：我想查任务状态 / 看结果

- 在跑 + 实时输出 → `bash scripts/ao query /api/tasks/<id>/stream`（SSE 长连接）
- 跑完了 + 要看 diff → `bash scripts/ao query /api/tasks/<id>/changes`
- 跑完了 + 要看 transcript → `bash scripts/ao query /api/tasks/<id>/transcript`
- 批量查全平台 → `bash scripts/ao recall <关键词>`（4 源并发）

### 场景 5：任务卡住了怎么办

- 立刻诊断 → [orchestrator-stuck](../../.claude/skills/orchestrator-stuck/SKILL.md)（首选）
- cron 失语 / paused 僵尸 → [orchestrator-ops](../../.claude/skills/orchestrator-ops/SKILL.md) §「cron stuck 排查」
- SSE 中断 / 流断了 → [orchestrator-stuck](../../.claude/skills/orchestrator-stuck/SKILL.md) §「SSE 中断」段
- 飞书协作没回 → [orchestrator-stuck](../../.claude/skills/orchestrator-stuck/SKILL.md) §「飞书没回」段
- 真没招了 → 升级给用户拍板（通知用户，附 task_id + 卡死现象 + 已尝试命令）

## 完整度图（实际 vs 计划）

| 阶段 | 项 | 状态 |
|------|---|------|
| 阶段 1 P0 | onboarding / quickstart / dispatch 锚点 / stuck / skill-tree / templates / playbook / verification | 🟢 本波完成 |
| 阶段 1 P1 | login / session / recall / feishu / requirement / wiki | 🟡 下一波 |
| 阶段 2 | UI 顶部「帮助」菜单渲染 skill 树 + 「从 skill 创建项目」反向 | ⚪ 远期 |


## 注意

- 本文件维护在 `docs/usage/00-skill-tree.md`（git 跟踪，跨机器可见）
- 新增 skill 时**必须**同步更新「一表全 skill」+ 对应「场景」段
- skill 与文档是**双通道**：skill 用于 Claude Code 自动触发，文档用于人工查阅；两份内容可能略有时差，但每个 skill 都在「双通道对照」表里能找到等价文档章节
