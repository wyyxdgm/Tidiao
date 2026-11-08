# 19. 项目模板

> 平台出厂的**项目模板**（不是任务模板）。点「从模板建」按钮选一套，自动预填项目名 + 描述，tasks/roles 走快速手动建。

## 何时用本章节

- 新用户想快速体验平台
- 想用统一结构建项目（飞书协作 / 长跑开发模式）
- 想给团队成员提供标准开局

## 区分：项目模板 vs 任务模板

| 类型 | 落点 | 内容 | 入口 |
|------|------|------|------|
| **项目模板** | `docs/project-templates/*.json`（git 跟踪）| 项目 + version + tasks + roles 的整体模板 | 项目页「📦 从模板建」按钮 |
| **任务模板** | `templates` 表（DB）| 单个任务的 prompt + model + allowed_tools | [07-预设与复用](./07-presets.md) + 模板页 |

**设计取舍**（战略 V1 决策 2）：
- 项目模板**走 JSON 文件**，**不动 DB schema**（`templates` 表只有任务模板字段，不存项目结构）
- UI 按钮 = 前端 fetch `/api/project-templates` → 列表 → 选模板 → 预填表单
- tasks/roles **不自动创建**（避免一次性复杂 UI），预填后引导用户看下方步骤手动建

---

## 3 套出厂模板

### 1. Hello Agent（starter · 5 分钟）

**适用**：新用户首次体验、想 5 分钟跑通 demo。

**结构**：1 个空项目 + 1 个 hello 任务。

**一键流程**：
1. 项目页点「📦 从模板建」→ 选 Hello Agent → 表单预填 `hello-agent-demo`
2. 点「创建」
3. 项目里手动建 1 个 v1.0 version
4. 手动建 1 个 hello 任务（prompt 复制 [docs/project-templates/hello-agent.json](../../project-templates/hello-agent.json) 的 `tasks[0].prompt`）
5. 启动任务，看 agent 输出 /tmp/hello-demo-output.md

**对应 skill**：[[orchestrator-quickstart]] + [[orchestrator-onboarding]]（把这两个 skill 一起看，5 分钟跑通）

---

### 2. 需求协作（collaboration · 30 分钟）

**适用**：想演示飞书 sheetwatch + 需求点管理 + O 列四态工作流。

**结构**：项目 + 飞书 sheet 绑定占位 + 2 个演示任务（setup + verify）。

**前置**：你必须有可用的飞书 sheet（建一个空 sheet 拿到 URL + sheet 名）。

**一键流程**：
1. 项目页点「📦 从模板建」→ 选需求协作 → 表单预填 `requirement-collab-demo`
2. 点「创建」
3. 建 version 时填你的飞书 sheet URL + sheet 名（**填真值，不是占位**）
4. 手动建 2 个任务：setup（建占位需求）+ verify（验证 O 列状态）
5. 跑 setup → 飞书 sheet 末 3 行应有 R2/R3/R4
6. 跑 verify → 演示 sheetwatch 自动派发 / O 列四态行为

**对应 skill**：[[orchestrator-advanced]] + [[orchestrator-stuck]]（飞书 sheetwatch 卡住怎么排查）

**坑**：O 列四态定义见 partner CLAUDE.md §O 列四态定义（damo 0829 拍板）。`1`/`是`/`done`/`true` = 处理好了；空 = 没动过；中间态 = 等回复。

---

### 3. 长跑开发（advanced · 2 小时）

**适用**：演示 anflow 风格的多任务长跑开发模式（DAG + 依赖 + checkpoint + 多角色）。

**结构**：项目 + dev/test 角色 + 2 个任务（feat → test，DAG 依赖）。

**一键流程**：
1. 项目页点「📦 从模板建」→ 选长跑开发 → 表单预填 `long-running-dev-demo`
2. 点「创建」
3. 手动建 dev 角色 + test 角色（prompt 复制 [docs/project-templates/long-running-dev.json](../../project-templates/long-running-dev.json) 的 `roles[*]`，去 [07-预设与复用 §角色](./07-presets.md) 建）
4. 建 version `v1.0`
5. 建第 1 个任务 `feat: 写一个 hello world 路由`（绑 dev 角色）
6. 建第 2 个任务 `test: 验收 hello world 路由`（绑 test 角色 + dependsOn 指向上一步）
7. 启动 → DAG 自动等 feat 跑完 → 跑 test
8. test 任务**独立验证**（不信 agent 自述，自己跑 server.js + curl）

**对应 skill**：[[orchestrator-dispatch]] + [[orchestrator-manage]]

**坑**：
- cwd 默认 `/tmp/long-running-demo/` —— 想改可换路径
- DAG `dependsOn` 自动设依赖，下游等上游完成才跑
- checkpoint 标记用于 fork 回退点（feat 任务完成后自动写）
- **不信 dev 自述** —— test 角色独立跑 server.js + curl 验证

---

## 自己加模板

**模板 schema**（参考 [hello-agent.json](../../project-templates/hello-agent.json)）：

```json
{
  "id": "<unique-id>",
  "name": "<中文显示名>",
  "description": "<一句话描述>",
  "category": "starter | collaboration | advanced | custom",
  "estimated_minutes": <数字>,
  "icon": "<emoji>",
  "recommended_skills": ["orchestrator-xxx", "..."],
  "project": {
    "name": "<默认项目名>",
    "description": "<默认描述>",
    "cwd": "<默认 cwd，可选>"
  },
  "version": {
    "name": "v1.0",
    "feishu_url": "<可选>",
    "feishu_sheet": "<可选>"
  },
  "roles": [{ "name": "...", "system_prompt": "...", "model": "...", "effort": "...", "max_turns": 80 }],
  "tasks": [{ "title": "...", "prompt": "...", "autoApprove": true, "effort": "low|medium|high", "maxTurns": 30, "tags": ["..."], "depends_on": ["..."] }],
  "notes": ["<可选说明>"]
}
```

**步骤**：
1. 复制 `docs/project-templates/hello-agent.json` → `docs/project-templates/my-template.json`
2. 改字段
3. 提交 PR（仓内 git 跟踪，所有人下次开项目页就看到）
4. UI 自动 fetch，不用重启服务（前端页面刷新即可）

**校验**：API 路由 `src/app/api/project-templates/route.ts` 解析失败不抛 500，降级返回空数组 + `errors` 字段。改坏 JSON 看 `curl /api/project-templates` 的 errors 段。

---

## 不该用项目模板的场景

- **只想复用一个任务** → 用任务模板（[07-预设与复用](./07-presets.md)），不是项目模板
- **想跨机迁移项目结构** → 用 [skill-templates/](../skill-templates/)（外部用户用），不是项目模板
- **想 fork 现有任务** → 用 [[orchestrator-manage]] §「Fork / Rewind / Checkpoint」，不是项目模板

## 注意

- 本文件维护在 `docs/usage/19-templates.md`
- 项目模板**不改 DB schema**；JSON 源 = 仓内 `docs/project-templates/`，UI = 前端 fetch + 预填
- tasks/roles 不自动创建 —— 预填后引导用户手动建（避免一次性复杂 UI + 让用户看清每一步）
- 新增模板只需在 `docs/project-templates/` 加 JSON 文件 + 提交 PR，UI 自动 pick up
