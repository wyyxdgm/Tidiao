---
name: orchestrator-onboarding
description: Top-level navigation skill -- "I'm new to agent-orchestrator, which skill should I use?" Use when you don't know which orchestrator-* skill to start with. Covers the full 5-category skill tree (A onboarding / B daily / C special / D ops / E advanced) + 5 core scenarios (login / create project / dispatch task / check status / stuck). 跨环境通用.
---

# orchestrator-onboarding

你是 agent-orchestrator 平台的使用者。**不知道该用哪个 skill 时，先看本 skill**。

本 skill 是「meta-skill」——只做**导航和决策树**，不教具体操作。具体操作跳到对应子 skill 看。

## 何时用

- 第一次接触平台，不知道从哪里开始
- 想做某事但不知道哪个 skill 能做
- 在多个 skill 之间犹豫不决
- 想了解平台能力全景

## 何时不该用本 skill

- **已知要用某个具体 skill**（直接打开那个 skill，不要再过 onboarding 一遍）
- **紧急修复卡死任务**（直接用 [[orchestrator-stuck]]，省 1 分钟）
- **平台外的开发工作**（这是另一个 skill 系统，不是 orchestrator-*）
- **只想查一条命令**（用 `bash scripts/ao recall <关键词>` 更快）

## skill 树（5 类 · 全平台）

```
┌──────────────────────────────────────────────────────────────────┐
│ A 入门（5 分钟用上平台）                                          │
│   ├─ orchestrator-onboarding   ← 你正在读这个                     │
│   └─ orchestrator-quickstart   注册→login→建项目→派任务            │
├──────────────────────────────────────────────────────────────────┤
│ B 日常（90% 时间用这些）                                          │
│   ├─ orchestrator-query         只读查询（list / get / stream）    │
│   ├─ orchestrator-manage        增删改 + 任务状态机               │
│   ├─ orchestrator-dispatch ⭐   派任务（skill 树锚点）             │
│   └─ 关键词检索                  `bash scripts/ao recall <关键词>` │
├──────────────────────────────────────────────────────────────────┤
│ C 专项（按需启用）                                                │
│   └─ orchestrator-advanced      飞书 / 批量导入 / webhook / 评估  │
├──────────────────────────────────────────────────────────────────┤
│ D 运维（出问题时用）                                              │
│   ├─ orchestrator-ops           部署 / 备份 / cron / user         │
│   └─ orchestrator-stuck         卡死诊断 + 修复                    │
├──────────────────────────────────────────────────────────────────┤
│ E 高级（在 dispatch / manage 里 cross-link，不新加 skill）          │
│   └─ fork / checkpoint / DAG 模板 / M 模式无人值守                │
└──────────────────────────────────────────────────────────────────┘
```

**路径约定**：所有子 skill 在仓内路径 `.claude/skills/orchestrator-<name>/SKILL.md`。本仓 git 跟踪，跨机器可见。

## 5 个核心场景决策路径

### 场景 1：我没登录 / 拿不到 token

```
是 → [[orchestrator-quickstart]] §「登录 / 拿到 token」
     或 [[orchestrator-ops]] §「鉴权模型」+ §「user.sh 速记」
否 → 继续下一个场景
```

**速查**：
- 拿 7 天 session cookie：`POST /api/auth/login` with email+password（curl 见 quickstart §1）
- 拿不过期 `ao_` bearer：`scripts/user.sh token --name "my-cli"`
- 远程自托管实例：`export AO_BASE_URL=https://your-host`

### 场景 2：我想建第一个项目

```
没建过项目 → [[orchestrator-quickstart]] §「建项目」+ §「从模板建」
            或 [[orchestrator-manage]] §「典型流程」新建 project → version → task
建过但忘了 ID → [[orchestrator-query]] §「看某任务现在啥状态」+ §「当前 project/version 速查」
想从模板建   → 看 [[docs/usage/19-templates.md]]（3 套出厂模板：Hello Agent / 需求协作 / 长跑开发）
```

### 场景 3：我想派第一个任务

```
简单 fix（< 5 行）→ 直接派 [[orchestrator-dispatch]] 用 7 段 prompt 模板
复杂任务 / 多文件  → 派 [[orchestrator-dispatch]] + effort=high + maxTurns=150-200
无人值守波次       → [[orchestrator-dispatch]] §「无人值守波次监控 cron prompt 模板」
不知道派到哪个仓库 → 查平台 Projects 列表 + 各项目 CLAUDE.md 的能力声明
```

### 场景 4：我想查任务状态 / 看结果

```
在跑 + 实时输出 → [[orchestrator-query]] §「实时跟踪任务输出」(SSE /stream)
跑完了 + 要看 diff → [[orchestrator-query]] §「看任务改了哪些文件」(/changes)
跑完了 + 要看 transcript → [[orchestrator-query]] §「Task 深度查询」(/transcript)
批量查全平台 → `bash scripts/ao recall <关键词>`（4 源并发：任务/需求点/飞书/项目文档）
```

### 场景 5：任务卡住了怎么办

```
立刻诊断       → [[orchestrator-stuck]]（首选）
cron 失语 / paused 僵尸 → [[orchestrator-ops]] §「cron stuck 排查」
                      + `bash ~/workspace/agent-orchestrator/scripts/check-stuck-schedules.sh --fix`
SSE 中断 / 流断了 → [[orchestrator-stuck]] §「SSE 中断」段
飞书协作没回    → [[orchestrator-stuck]] §「飞书没回」段
真没招了       → 升级到用户拍板（通知用户，附 task_id + 卡死现象 + 已尝试命令）
```

## cross-link 全表

### A 入门
- [orchestrator-quickstart](../orchestrator-quickstart/SKILL.md) — 5 分钟跑通 demo
- [docs/usage/00-skill-tree.md](../../../docs/usage/00-skill-tree.md) — 文档侧 skill 树（双通道）

### B 日常
- [orchestrator-query](../orchestrator-query/SKILL.md) — 只读查询（list/get/stream/transcript/changes）
- [orchestrator-manage](../orchestrator-manage/SKILL.md) — CRUD + 任务状态机（创建/启动/暂停/取消/审批）
- [orchestrator-dispatch](../orchestrator-dispatch/SKILL.md) — 派任务（skill 树锚点，含 7 段 prompt 模板）
- `bash scripts/ao recall <关键词>` — 跨源知识检索（任务/需求点/飞书/项目文档）

### C 专项
- [orchestrator-advanced](../orchestrator-advanced/SKILL.md) — 飞书 sync/write-back、批量导入、webhook、评估

### D 运维
- [orchestrator-ops](../orchestrator-ops/SKILL.md) — 部署 / 备份 / cron / user / 鉴权模型
- [orchestrator-stuck](../orchestrator-stuck/SKILL.md) — 卡死诊断（5 类模式 + 修复命令）

### E 高级（在 dispatch / manage 里 cross-link）
- fork / checkpoint — 见 [orchestrator-manage](../orchestrator-manage/SKILL.md) §「Fork / Rewind / Checkpoint」
- DAG 模板 — 见 [docs/usage/03-tasks.md](../../../docs/usage/03-tasks.md) §DAG
- 无人值守 M 模式 — 见 [orchestrator-dispatch](../orchestrator-dispatch/SKILL.md) §「无人值守波次监控 cron prompt 模板」

### 项目模板 / 实战
- [docs/usage/19-templates.md](../../../docs/usage/19-templates.md) — 3 套出厂项目模板（Hello Agent / 需求协作 / 长跑开发）

### 战略 + 验证

## 已知坑

- onboarding 是**导航 skill**，不教具体操作 —— 不要把它当 quickstart 用
- skill 触发词在每个子 skill 的 `description` 第一行精修过；想直接跳到某个子 skill，**用子 skill 的 description 关键词**
- 「我不知道该用哪个 skill」 = onboarding 用例；「我要派一个开发任务」 = 直接 dispatch，跳过 onboarding
- 本 skill 是 meta-skill，**不替代 quickstart**（quickstart 是 5 分钟流程实操）
- 🟡 **规划中**：cross-link 里 `orchestrator-quickstart` (#3) 和 `orchestrator-stuck` (#5) 还在阶段 1 后续任务落仓中；本 onboarding 文档已含完整 cross-link，子 skill 落仓后即生效，无需再改本文件

## 注意

- 本 skill 维护在仓内 `.claude/skills/orchestrator-onboarding/SKILL.md`，**不依赖环境变量**（跨环境可读）
- 新增子 skill 时**必须**在本文件「5 类 skill 树」和「cross-link 全表」同步加一行（防 convention 腐烂）
- skill 树 5 类是认知路径，**不轻易改类目**；新增 skill 优先塞进现有 5 类
