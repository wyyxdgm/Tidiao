# SPA vs Master 视觉自查对照清单（用户浏览器两 tab 并排）

**操作**：浏览器开 2 个 tab 同登录态（admin `you@example.com` / `damo-test-2026`）

- **Tab A** (v2.0-spa Vue): http://localhost:5173
- **Tab B** (master Next.js): http://localhost:13000

**逐页对比**：视觉 B 类 / 字段 C 类 / 交互 D 类，逐 row 划勾；不达标记 ❌，等 R41 + 后续修复。

| # | URL (Tab A = SPA 5173, Tab B = Master 13000) | 视觉差异点（标 B）| 字段差异（标 C）| 交互差异（标 D）|
|---|----------|---|---|---|
| 1 | /login | - | - | SPA 登录后是否 router.push 进主界面 |
| 2 | /requirements | 列表行高 / chip 间距 | 5 条已 seed，行内 chip `📋N/📈X%/💬` 颜色 + 文本 | 空态 / filter 切换 / 分页 |
| 3 | /requirements/[id] (75dda136-...) | 时间线段间距 + 颜色 | 两段时间线都渲染：人·字段变更 + Task 执行事件 | 点 revisions "查看全部" 是否展开 |
| 4 | /webhooks (列表) | 行内 chip 数 | events + active + has_secret 都在 | 编辑折叠面板展开/收起 |
| 5 | /webhooks/[id] (d263e005-...) | 表头/列宽/状态色 | 12 条投递记录 + 关联 task 短哈希 + 详情列 | 「查看完整 body」 折叠 |
| 6 | /templates | 卡片网格 vs 表格 | 8 字段 + tags chip + LLM 配置下拉 | 编辑/新建 modal 提交 |
| 7 | /schedules | 卡片渲染 | 7 项 controls；当前是 5 字段，master 是 12 字段 | 立即执行按钮 + runs 面板 |
| 8 | /settings | 4 tab 渲染 | 4 tab：account/notify/schedule/platform | fork 阈值 / 声音 / API Token / 多模态 key 4 区块 |
| 9 | /assets | 列表 + 上传 modal | 资源池 5 维筛选 + 50/page | 批量选 + 删除 |
| 10 | /global | 卡片/列表/grouped 三视图 | cards/list/grouped (master 5 视图含 Kanban/Chat) | 视图切换 |
| 11 | /projects | 列表 + 创建 modal | 20 个项目 + 列表行 | 创建 modal 含 "version 同建" 一键 (C1) |
| 12 | /import | textarea + 预览 | JSON/CSV/Markdown 三格式 | 上传 + 预览 + 确认 |
| 13 | /runners | 列表 + 注册 modal | 4 actions (注册/删除/健康检查) | admin gating 显式 disabled |
| 14 | /tasks/[id] | 13 section 装配 | - | fork banner + 计时器 + 倒计时 |
| 15 | /transcript/[id] | header + 8 元数据 + markdown | - | .md / .jsonl 下载 |

## 重点 R41 后修复关注项（R1 主 agent 已在后台跑 sub-agent `afccc18007951fcce`）

- **A1**: ScheduleFormFields 5 → 12 字段（含 agent vs shell 二级条件 + working_dir 等）
- **A2**: WebhookDetail 投递历史表 「详情」列加 payload 折叠
- **A3**: tasks/[id] commits 列表面板（root lineage 列表版，graph 留 R+）
- **B1**: templates 「从此模板创建任务」挂 `/tasks/new?template=<id>` 预填表单
- **C1**: Projects 创建成功后弹 "version 同建" 一键 modal
- **C2**: Requirements new form 附件 maxSize 统一 10MB

## 怎样记下发现的不一致？

最简洁方式：给我 `R41 完了, /webhooks/[id] 还差 X`，我直接派后续 R42 修。
