# 21. 构思画布（Idea Canvas）

> **这是**：跨项目构思层 —— 一个想法一个球，假设-验证-归因回路的可视化载体。
> **不是**：项目菜单里的「需求点」（那是项目内结构化执行单元，见 14 章）；构思是还没定型、聊着聊着还在变的方向层。
> **入口**：侧栏 💡 构思画布 → `/#/ideas`
> **设计稿**：`docs/plans/idea-canvas.md`（四实体 + 两层状态机 + P0-P4 分期）

## 功能点

### 画布（playcanvas 3D）

- 一 idea 一球：球大小 = 关联任务/节点数，颜色 = 状态（靛蓝=构思中 / 天蓝=探索中 / 绿=已定案 / 灰=搁置 / 红=已否定 / 金=已落地）
- **两视图**：🕸 关联度（力导向：关联边弹簧 + 斥力收敛）/ 📅 时间线（x=创建时间，y=状态泳道）
- 滚轮缩放；点球标签开右侧详情抽屉；球间连线 = 构思关联（虚线 = 依赖/取代类）

### 假设-验证-归因回路

- 新构思表单带：**假设**（相信【做什么】会让【谁】产生【什么可观测行为】）+ **验证判据**（数字+时限，如「2 周内 ≥3 真实询问」）+ **验证窗口**（deadline）
- 详情抽屉常驻**收益面板**：投入（`SUM(任务 cost_usd)`）+ 任务数 + 信号汇总（咨询/注册/收入）+ 判据窗口倒计时；**过窗未出结论 = 🔴 待复盘**
- **反馈信号**：手动/agent 录入（kind: inquiry/signup/payment/review/usage/other + 数值 + 证据指针）；「结论」按钮（定案/证伪/搁置/落地）强制先写含证据的结论

### 构思流程节点（DAG 画布）

- 一个 idea 下挂多个节点（`idea_nodes`），节点间依赖（`deps`，带环检测：自依/跨 idea/成环全拒 400）
- 节点状态 8 态：计划中/待执行/执行中/待审核/等决策/卡住/完成/放弃（意图层词表，与任务运行态分离）
- **下钻画布**（1014 Dify 式重构）：点球 → DAG 画布接管中间主区（布局 = 左列表栏 + 中画布 + 右详情栏），节点 = Dify 式卡片（状态色条 + 标题 + 任务徽章 + detail 摘要 + 状态 chip），左入右出连接桩，边 = 依赖方向贝塞尔
- **自由画布**：滚轮缩放（鼠标为中心）/ 拖空白平移 / 双击或 ⤢ 适配视图 / ⟲ 自动布局清手摆回 topo 分层
- **可编排**：拖卡片摆位（`pos_x/pos_y` 落库，卡片与边实时跟随）；**拖输出桩 → 落到目标卡 = 建依赖**（成环被拒 toast）；右栏选中节点面板可切状态 / ×删上游 / 派任务
- **游标 + 聚焦**：`执行中` 节点带琥珀虚线脉冲环（一眼看到做到哪）；hover 节点 → 直接上下游保持、其余淡化
- **从节点派任务**：选中节点 → 右栏「派任务」→ 自动带 `idea_id`/`node_id`/`work_class='plan'` 派发并启动；「＋ 节点」在画布左下

### 人工分拣列表（左栏）

- 任意标题列表，建/改名/删/排序（sort_key 持久化）；条目多态（task/idea/node）
- 任务详情页状态栏「🗂 分类」按钮（删除右侧，damo 1012 从独占行挪进按钮排）下拉直达；条目删除只摘关联，对象本体不动
- `added_by` 归因：damo 或 agent:<项目名>

### 任务与构思的关联

- 任务三新列：`idea_id` / `node_id`（弱引用，删构思不删任务）/ `work_class`（fix 一次性修复 | feature 功能 | plan 规划 | ops 维护）
- 归属校验：API 层 idea/node 必须属于任务 owner（404 no existence leak）+ node 与 idea 一致性（400 NODE_IDEA_MISMATCH）

### CLI（AI 读写闭环）

```bash
ao idea add -t "AO 变现" --hypothesis "成本归因让外包公司付费" --criteria "2 周 ≥3 询问" --deadline 2026-12-06
ao idea ls / ao idea show <prefix> / ao idea node <prefix> -t 节点 --deps p1,p2
ao idea signal <prefix> --kind inquiry --note "B 站私信" --ref "task 3de8"
ao idea conclude <prefix> --status rejected --conclusion "证伪：零询问（证据 task 3de8）"
ao idea export <prefix> -o docs/plans/idea-x.md      # 冷启动源兜底
ao pinlist ls / add -t 下期做 / put <列表> --task <prefix> / mv / rm
```

### 项目列表（任务容器，替代需求入口）

> damo 1012 说法原文：列表挂项目下、任务全量进列表分类、AI 权限开放可自动搬动、条目可挂 data（按 schema 设计，UI 可展示、AI 遵循规范更新）。

- **项目级列表**：`ao pinlist add -t 标题 -p 项目名`（`pin_lists.project_id`，NULL=全局）；项目版本页「🗂 列表」抽屉渲染本项目列表 + 全局列表
- **data 扩展字段（schema 驱动）**：列表可定义 `data_schema`（properties/required），条目 `data` 为 JSON 实例——AI 按 schema 校验（缺必填/类型错 → 400 DATA_INVALID）；UI 在条目下渲染 chips（schema 的 title 优先，URL 自动变链接）；AI 遵循 schema 更新（`PATCH /api/pin-list-items/[id]`）
- **需求替代**：旧「需求点」入口降级为旧版（数据保留可查）；需求 = 一个带 schema 的列表（schema 带文档链接/优先级字段），任务全量进列表分类。「讨论中 / 开发完未部署 / 测试通过 / 测试不通过」各建一个列表，AI 部署验证完成后依次自动搬动
- **CLI 全量**：

```bash
ao pinlist add -t "需求" -p 项目名 --schema '{"doc":{"title":"文档","type":"string"}}' --required doc
ao pinlist schema <列表> --set '{"doc":{"title":"文档","type":"string","required":true}}'
ao pinlist put <列表> --task <prefix> --data '{"doc":"https://...","priority":"P1"}'
ao pinlist mv --task <prefix> --from 开发完成未部署 --to 已部署测试中   # note/data 随行
ao pinlist ls --project 项目名
```

### 导出

- `GET /api/ideas/[id]/export` → md 冷启动源（mermaid DAG + 收益面板 + 信号 + 挂的任务），`?download=1` 下载；可直接贴进 `docs/plans/`

## 实现原理（开发者参考）

- 数据：`src/lib/db/ideas.ts` + `pin-lists.ts`（migrations v520-v524）；两层状态机红线：任务运行态词表不动，意图态全在 ideas/idea_nodes
- API：`/api/ideas`（+[id]/nodes|signals|export）、`/api/idea-nodes`、`/api/idea-signals`、`/api/idea-links`、`/api/pin-lists`（+items）、`/api/pin-list-items`、`/api/dashboard-blocks`（积木布局存储已就位，网格拖拽 UI 后续）
- 前端：`spa/src/views/IdeasView.vue`（playcanvas 3D + DOM 投影混合架构：球走 3D，命中/标签/边走投影，引擎仅本页加载）
- 测试：`src/lib/db/ideas.test.ts` + `pin-lists.test.ts` + `src/app/api/ideas/route.test.ts`
