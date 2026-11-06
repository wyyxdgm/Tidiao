# 20 · 任务画布总控制台（Console Canvas）

> R177 落地（P1）。单项目「一张画布看全景」：任务状态动画、紧急×重要四象限、等我处理、排队区、AI 一句话派活。设计文档 → [`docs/plans/task-canvas-console.md`](../plans/task-canvas-console.md)。

## 入口（R177 门面替代后）

- **`#/{projectId}` 一段 URL 自动跳画布**（原跳当前版本看板，2026-10-03 拍板画布作项目门面）
- **`#/{projectId}/board` 也跳画布**（原 R28 board 文件 markdown 看板视图退役，同日拍板「直接换掉」；老书签自动落画布）
- 侧栏项目行「🎬 控制台」· Wiki 页顶部「🎬 控制台」
- URL 直达：`#/{projectId}/console`
- 项目详情页（`/projects/{projectId}`）header「🎬 控制台」
- 版本看板 header「🎬 画布」· 需求点列表页「🎬 画布视图」· 未挂版本任务页「🎬 控制台」
- 画布顶部「📋 任务」（任务看板）「📋 需求」（需求列表）一键回老视图——看板是账本，全保留

## 画面分区

| 区 | 内容 | 数据 |
|----|------|------|
| 顶部指标带 | headline 文案（如「17 个等你 · 7 个排队」）+ 4 个数字 chip（在跑/等我/排队/需求） | 全项目任务 + 需求聚合 |
| ⚡ 近期聚焦 | 运行中/验收中的任务卡片（脉冲动画），按最近更新排序，点击进任务详情 | status ∈ running/verifying |
| 🎯 紧急×重要 | 四象限节点池：开放需求点（聚合活跃任务数）+ 无主活跃任务，点击直达 | 紧急度/重要度派生规则见下 |
| 🔔 等我处理 | 等拍板任务（awaiting_owner_review 优先）+ 等回复需求（铃铛动画） | reviewing/await_user/paused + awaiting_reply 等 |
| 🧊 排队中 | pending/queued 任务 chip 条（流光动画），≤14 个 + 溢出计数 | status ∈ pending/queued |
| ✦ 派活 FAB | 右下角 AI 派活入口：一句话 → 建任务 → 自动启动 | POST /api/tasks + start |

60s 自动轮询刷新；手动「↻ 刷新」；加载失败保留上次画面并 toast。

## 四象限规则（P1 派生，无 schema 改动）

- **紧急度**：等拍板 1.0 > 在跑 0.7 > 暂停 0.5 > 排队 0.35；其余按更新时间衰减（7 天饱和 0.6）。需求 awaiting_reply/有建议/需拍板 = 1.0。
- **重要度**：priority 映射（P3→1.0，无→0.33），clamp 0.15–1。
- **分象限**：阈值 紧急 0.6 / 重要 0.55 → 立刻干 / 排计划 / 快速清 / 少操心。
- **节点时间**（R199）：象限节点卡片右侧显示最后更新短时间（`MM-DD HH:mm`，与聚焦区卡片同口径）——老任务（如停在排队/暂停多日的）不再因为没时间显示而看不出多老。

## ✦ AI 全局归纳（R195）

画布顶部「AI 归纳」面板：**AI 结合项目业务文档**（项目 cwd 的 `CLAUDE.md` / `INDEX.md` / `docs/plans/README.md`，即 agent 环境都会加载到的文档）+ 全量任务清单（标题/状态/优先级/最近汇报），归纳出：

- **headline**：一句话项目状态（结论式，不是「有 N 个任务」）
- **分类统计**：固定 6 类工作类型分组（🔧要修的 / 🧭设计规划 / 📦已交付 / ✨功能迭代 / ⚖️等你拍板 / •其他），每类带数量——「20 个任务里几个修完、几个规划完、几个要选方案」一目了然
- **每任务建议**：结合业务文档给出的具体下一步（≤80 字大白话）+ 紧急度圆点（红高/黄中/灰低）+ 是否需要你拍板
- **一键同意与否**：每条带快捷按钮——reviewing/await_user = 「✓ 验收」（approve）；需拍板 = 「✓ 同意」（罐头消息带上建议原文转达并自动唤醒任务，零打字）；其余 = 「✎ 回复」（行内输入转达）。**终态任务（completed/cancelled）无任何按钮**（R204：已了结的不需要继续处理，一键同意会把终态任务重跑）——错分进非「已交付」分类的终态条目在解析端直接丢弃，「已交付」条目只展示不可动作。点条目本体 = 详情弹窗（同画布卡片）

数据接口：`GET /api/projects/[id]/console-digest`。**缓存**：后端按任务集指纹（id/status/updated_at）缓存进 `app_settings`——任务没变零 LLM 成本直接吃缓存，变了自动重算；「↻ 重算」强制绕缓存。LLM 失败时回退旧缓存（标「旧」徽标），无缓存才报不可用。归纳后台拉取（不阻塞画布首屏），独立 120s 轮询。

## AI 派活 / 智能控制

点 FAB → 输入一句话（首行作标题，≤60 字）→ 两个按钮二选一：

- **派发 ▶**：直接建任务（`autoApprove: true`）并启动，画布刷新可见。**注意**：槽位空闲时新任务立即 running（进「近期聚焦」而非排队区）。
- **🎛 智能控制**：把指令包成「总控任务」派给本项目 agent——由它代你批量验收（approve reviewing 任务）、推进、汇总「需要 damo 评估的核心问题」。总控 agent 拿平台注入的 token 调 API（列任务/看消息历史/approve/转达回复），含糊事项不猜、列进汇报。汇报落「等我处理」卡片，你直接在卡片上「✎ 回复」即转达并唤醒它继续。

## 卡片快捷操作（等我处理区）

- **✓ 验收**：reviewing 任务一键 approve（`awaiting_owner_review` 时自动先解除再验收，与任务详情页同语义）。
- **✎ 回复**：其余等待态（await_user/paused 等）一键回复转达——输入一句话 Enter，`sendUserMessage` 按状态自动路由（暂停任务入队待 resume 重放、reviewing/await_user 自动唤醒、running 直投流式）。

## 详情弹窗（点卡片原位展开）

点击任务卡 / 排队 chip → **卡片原位缩放展开成详情弹窗**（FLIP 动画：面板从卡片位置/尺寸过渡到居中终位，220ms；`prefers-reduced-motion` 降级为淡入）。弹窗内容 = 卡片没有的细节：

- **干啥 / 有啥用**（AI 摘要）+ **下一步**（优先 LLM 从 result 提取的后续，没有则回退最新 checkpoint **全文**）——弹窗三行**不限行数完全展示**（R238，damo 1010 拍板「不限 2 行,小屏幕 2 行不够,完全展示」；超长截断**不加省略号**的口径不变，damo 1007「省略号 = 总结不到位」——卡片上仍保持两行口径）；卡片摘要走 `GET /api/tasks/[id]/card-summary`（`card_summary_v4`），**任务完成时后台预热**（1007，与结果分层同款 fire-and-forget）→ 卡片打开即显，不再进画布 3 并发慢队列。历史：曾有「为什么」行（agent 最后汇报），迭代9 起**整行撤**（damo 1004 拍板：语义被「有啥用」覆盖），messages 拉取链路一并拆除
- **正文 3 层钻取**（R190）：有 result（≥200 字）时正文按 3 层手风琴组织，每层是对下一层的总结（理念多叉树，damo 1004 拍板「具体展示看着办」）——
  - **概览**（默认展开）= LLM 3~5 句内讲干了啥/按什么顺序操作了啥，**越少越好**（1007：1~3 句优先，删客套和过程性废话）
  - **核心细节**（点开）= **处理流程图解**（damo 1005 R 列拍板「细节画处理流程图，不要一堆文字」）：竖向步骤图（序号圆点 + 连接线），每步 =「做了什么动作 → 得到什么结果」；🔴 commit id/hash 不允许单独出现，必须配实际含义描述（LLM prompt 强制 + 缓存键 bump 重算存量）
  - **完整处理**（点开）= result 原文全文（前端直取零请求，40vh 内滚动；1007 起剥掉 `<checkpoint .../>` 等运行时标记，管线符号不进弹窗）
  - L1/L2 走 `GET /api/tasks/[id]/result-layers`，**两级来源**（R200 + turn2 修订，damo 1006 飞书反馈「点开才生成、慢到不可接受，要后台自主处理」；chat 反馈「checkpoints 质量不好不可控」后撤掉 checkpoints 组装中间层）：① metadata 缓存（`result_layers_v3`，秒回）→ ② LLM 生成（统一 summary 模型链，读 result 12k 字，一任务一次成本；50s 竞速超时）。`?refresh=true` 强制重算；result 变了按长度自动重算
  - 🔴 **后台自主处理**（R200）：任务 result → reviewing 落库时 runtime fire-and-forget 预热（关页面也继续跑，写缓存）→ 弹窗打开即显不再转圈；存量任务由 `npx jiti scripts/warm-result-layers.ts --apply` 批量 LLM 回填（dry-run 统计 → `--apply` 写库，同轮回填卡片摘要）
  - **prompt 质量红线**（1007，damo chat 三连拍板）：🔴 禁止省略号（每条说完说完整）；🔴 输入/输出剥运行时标记（`<checkpoint>/<awaiting>/<git>` 是管线符号，绝不复述进总结）；🔴 概览越少越好。v3 口径变更已让存量缓存全部自动重算
  - 生成中显示「✦ 正在生成总结…」（仅首次打开的无缓存老任务会遇到），失败/短结果回退单层原文
  - 🔴 **不无限转圈**（damo 1005 R 列反馈「一直卡在正在生成总结」）：后端 50s 整体竞速超时（死 key SDK 重试实测拖 3+ 分钟的兜底）+ 前端 45s AbortController；超时当失败回退原文，下次打开自动重试
- 无 AI 摘要时兜底显示**要求**（prompt 摘录）；result <200 字不分层直接单层显示原文
- 底部操作：**打开完整任务页 →**（老路径保留）；reviewing 任务加 **✓ 验收**（复用卡片验收语义）
- 关闭：✕ / Esc / 点遮罩

## 任务明细（下一步）

- 「近期聚焦」卡片带 **下一步** 行 = 最新 checkpoint summary（卡片 ≤120 字两行口径；R238 起数据层存全文,详情弹窗完全展示）——一眼看出干到哪。
- 「为什么」行已移除：迭代8 撤下卡片，迭代9（damo 1004 拍板「有啥用替代为什么」）连弹窗里的也撤掉，`extractWhy` 及其锚点/结构词规则一并删除。
- 明细按 `updated_at` 缓存防抖，60s 轮询不重拉没动的任务；弹窗打开时懒取；拉取失败静默（只少一行摘要）。

## 实现原理（开发者参考）

- 视图：`spa/src/views/ConsoleCanvas.vue`（路由 `:projectId/console`，SPA-only）
- 纯逻辑：`spa/src/lib/console/canvas-model.ts`（分区/象限/文案，21 条单测 `canvas-model.test.ts`）
- 动画：纯 CSS（pulse/bell/shimmer）+ `prefers-reduced-motion` 降级；不引 PlayCanvas（取舍见 plan §5）
- P2+（SSE 实时、拖拽改优先级、任务树）→ plan §7

## 功能点

- **2026-10-03（R177 P1）**：首版落地。四分区画布 + 四象限 + headline 文案 + AI 派活 + 60s 轮询。入口挂需求点列表页与未挂版本任务页。
- **2026-10-03（R177 迭代）**：门面替代——`/{projectId}` redirect 改跳画布，版本看板/项目详情页加互跳入口，画布顶部加「📋 任务 / 📋 需求」回老视图。老看板全保留。
- **2026-10-03（R177 迭代2）**：`/{projectId}/board` redirect → console（board 文件看板视图退役，组件文件保留可恢复）；侧栏 Board 按钮 / Wiki 📊 Board 快捷入口改指 🎬 控制台。
- **2026-10-03（R177 迭代4）**：卡片直观化——「等我处理」卡带**为什么**（最后一条 assistant 汇报，120 字摘要）+「近期聚焦」卡带**下一步**（最新 checkpoint summary），按 updated_at 缓存防抖；卡片快捷操作——「✓ 验收」一键 approve（自动解 awaiting gate）+「✎ 回复」转达并自动唤醒任务；AI 输入框双按钮——「派发 ▶」直建任务 /「🎛 智能控制」包成总控任务由 agent 代批量验收推进 + 汇总需 damo 评估的问题（汇报落等我处理，画布回复即转达）。实现全在 ConsoleCanvas.vue，零后端改动；细节 → [`docs/plans/task-canvas-console.md`](../plans/task-canvas-console.md) 迭代4 段。
- **2026-10-03（R177 迭代5）**：「为什么」摘要质量升级（damo 反馈「看不出来啥」）——剥 checkpoint XML/结构词噪声 → 锚点定位「等我什么」句（需要拍板/等回复/有建议/卡住）→ 标准「完成:」行兜底（收尾汇报约定同轮固化到 `docs/shared-standards/task-dispatch-standards.md` §7：最后一轮第一行 `完成: <做的啥, 有啥用>`）。纯逻辑抽 `spa/src/lib/console/card-summary.ts`（9 单测，用例 = damo 贴回的真实卡片文本）。
- **2026-10-04（R177 迭代6）**：卡片摘要改「干了啥 + 有啥用」两行直取（damo 1004 拍板，像飞书 M/V 列总结风格）——「有啥用」= `value_significance`（派发时登记的为什么做）→ `description` → prompt 目标句（剥身份行/标记行/命令行），纯同步零额外请求；「为什么」优先任务行自带 `result` 完成汇报本地提取，免拉 messages。纯逻辑 `extractGain` 进 `card-summary.ts`（35 单测）。
- **2026-10-04（R177 迭代7）**：摘要升级「面向用户」自包含（damo 1004 N 列追加拍板：「不看其他内容也能知道他要干什么」——机械提取截 prompt 行的黑话/命令行如「更新布署13000」光看读不懂）——新增 `GET /api/tasks/[id]/card-summary`（后端）= LLM（复用 `runSingleTurnLlm`，模型走任务 LLM 配置链）读标题+prompt头+result 生成「干啥/有啥用」两行自包含摘要（黑话展开成人话），结果缓存进 `tasks.metadata.card_summary`（一任务一次成本 ≈$0.005，`?refresh=true` 强制重算）；画布卡片并发 3 懒加载，「干啥」新行 + 「有啥用」优先 AI 摘要，LLM 失败静默回退机械提取。解析容错 `parseCardSummaryText` 单测 6 条。
- **2026-10-04（R177 迭代8）**：damo 1004 N 列三条反馈落地——① 卡片撤「为什么」行（「干啥」已体现），明细改弹窗懒取、轮询请求量砍半；② **详情弹窗**：点卡片/排队 chip 原位缩放展开成对话框（FLIP 动画 220ms），内容 = 干啥/有啥用/为什么/下一步/执行结果 + 打开完整任务页 + 验收，Esc/遮罩关闭；③ LLM 摘要新标准：**禁止出现「Rxxx」这类行号/编号**，换成它指代的具体功能语意（总控任务收尾汇报约定同步加这条）；缓存键 bump `card_summary_v2` 让存量卡片按新标准自动重算（一次性 ≈$0.005/任务）。改动 = ConsoleCanvas.vue + card-summary 路由/LLM 模块，目验 = vite dev + chrome-devtools（卡片无为什么行 / 弹窗缩放展开 / Esc 关闭 / 排队 chip 同款 / console 0 报错）。
- **2026-10-04（R177 迭代9）**：damo 1004 拍板「有啥用替代为什么」——弹窗「为什么」行整行撤，`extractWhy` + WAIT_ANCHOR/STRUCT_HEAD/DONE_LINE 规则与 9 个单测拆除，ensureDetail 不再拉 messages（弹窗明细只剩 checkpoints 一个请求）。改动 = ConsoleCanvas.vue + card-summary.ts（纯前端）。
- **2026-10-04（R189）**：标签页 tab 标题带项目名区分——多项目同开 console 全叫「总控制台」分不清；对齐 Wiki/未挂版本同款 pattern（`formatProjectWithLabel` + `applyTitle`），项目名加载后升级为「项目名-总控制台」（项目名 ≤8 字截断，用户手动重命名过的 tab 不覆盖）。纯前端一行 watch，ConsoleCanvas.vue。
- **2026-10-04（R190）**：详情弹窗正文 3 层钻取（damo 1004 飞书拍板「每一层都是对下一层的总结，理念多叉树，展示看着办」）——概览（LLM ≤5 句，默认展开）→ 核心细节（LLM 分条，看完可不用看原文）→ 完整处理（result 原文）；新增 `GET /api/tasks/[id]/result-layers`（复用 `runSingleTurnLlm` + card-summary 同款双跳 fallback，输入 result 12k 字，缓存 `tasks.metadata.result_layers_v1` 按 result 长度自动失效，短路 <200 字不分层）；解析容错 `parseResultLayersText` 单测 10 条。改动 = ConsoleCanvas.vue + result-layers 路由/LLM 模块，e2e 目验 = 临时实例（隔离 DB 拷贝）+ chrome-devtools（3 层展开/收起、生成中 loading、缓存命中 42s→0.015s、running 无 result 降级）。
- **2026-10-04（卡片摘要中途生成修复，damo 1004 二次投诉回归 task 6f5eeecd）**：`GET /api/tasks/[id]/card-summary` 加 result 闸门——`task.result` 为空（running/queued 等非终态）时**不调 LLM、不写缓存**，返回与 LLM 失败同形的空回退（`source='pending'`，前端机械提取兜底）；result 非空才生成+缓存。修的是「开跑 1 分钟（result 还空）就生成『具体改什么要看表格内容』式空话并永久缓存」。`?refresh=true` 仍强制绕缓存，但同样受闸门约束（result 是权威数据源，没它重算 = 复现同一 bug）。存量坏卡在画布里点刷新按新逻辑重算。测试 `card-summary/route.test.ts`（5 条）。
- **2026-10-05（R191）**：任务时间上卡片（damo 1005 拍板「暂时先加时间」）——各分区卡片统一显示**最后更新时间**（短格式 `MM-DD HH:mm`，本地时区，title 悬浮看完整时间戳）：近期聚焦 / 等我处理任务卡（状态左侧）+ 等我处理需求卡 + 排队 chip（内联，标题省略内移）+ 详情弹窗头部；四象限节点保持零布局占用、时间进悬浮 tooltip（`QuadrantNode` 透传 `updatedAt`）。格式化函数抽 `spa/src/lib/datetime.ts` `formatShortDateTime`（复用 `parseDbTime` UTC 归一口径，GlobalBoard 同款），新增 `datetime.test.ts` 4 条 + canvas-model 透传 1 条。**任务类型没上卡片**：`tasks.type`（design/dev/test/deploy）线上 99.9% 为空（5241 null / 5 dev），显示了也是空噪声；若要「bug修复/需求实现/方案设计/问答」这类分类，需先在派发侧登记字段（独立需求）。e2e 目验 = vite dev + chrome-devtools（5 处时间渲染 + 布局无挤压）。
- **2026-10-05（R195 AI 全局归纳）**：damo 1005 拍板「不只是按状态分紧急重要，要 AI 结合项目 claude.md 等业务文档 + 任务数据，全部先给建议，再按真实业务归纳分类 + 一键同意与否入口」——顶部新增「✦ AI 归纳」面板：headline 一句话项目状态 + 固定 6 类分组统计（fix/design/delivery/iterate/decision/other）+ 每任务建议（紧急度圆点 + need_owner 标记）+ 一键动作（✓ 验收 = approve / ✓ 同意 = 罐头消息带建议原文转达唤醒 / ✎ 回复 = 行内输入）。新增 `GET /api/projects/[id]/console-digest`：读项目 cwd 业务文档（CLAUDE.md 3000 字 + INDEX.md 600 + docs/plans/README.md 1000，缺了静默跳过）+ 任务清单（活跃全量 + 14 天内终态，≤50 行）→ 单次 LLM（复用 `runSingleTurnLlm` 双跳 fallback）输出严格 JSON；缓存进 `app_settings`（键 `console_digest:<projectId>`）按任务集 md5 指纹失效，失败回 stale 旧缓存。改动 = `src/lib/runtime/console-digest.ts`（新）+ 路由 + `spa/src/views/ConsoleCanvas.vue` + `spa/src/lib/console/digest-model.ts`（纯逻辑 7 单测）+ 后端 20 单测。e2e = 隔离 DB 副本无头实跑 GLM：400 任务 → 50 条归纳，headline 结论式、R193/R185 等待验收任务正确标「需拍板」，119s/次（缓存后零成本）。
- **2026-10-05（R190 turn2，damo R 列两条反馈）**：① **「一直卡在正在生成总结」修复**——根因 = LLM 配置链死 key 时 SDK 网络层重试拖 3+ 分钟 + 前端无限等；修法 = 后端 `generateResultLayers` 50s 整体竞速超时（超时当失败回退，不写缓存下次重试）+ 前端 45s AbortController（`spa/src/api/http.ts` get 加可选 RequestInit 透传 signal）+ loading 文案给预期（「首次约半分钟，之后秒开」）。② **干啥/有啥用/下一步限制两行**——JS 截断 cap 放宽（AI 摘要 48→96 字 + 缓存键 `card_summary_v3` 存量重算 / checkpoint 60→120 / 机械提取 80→160）+ 弹窗 `.tm-line` CSS line-clamp:2（「要求」行除外）。③ **核心细节改处理流程图解**（damo「细节画处理流程图，不要一堆文字；commit id 不单独出现必须配含义」）——LLM prompt 改「流程步骤」口径（每步=动作→结果，按顺序）+ 前端 bullet 列表改竖向步骤图（序号圆点+连接线）+ `result_layers_v2` 缓存键存量重算。单测 23 条（result-layers 10 + card-summary 11 + 路由 2）；e2e 目验 = 隔离 DB 副本 + chrome（流程图 10 节点渲染、commit id 配含义、两行完整展示、新 loading 文案）。

- **2026-10-06（R200，damo 1006 飞书反馈「每条点开才处理、慢到不可接受；期望后台自主处理」）**：结果分层改**缓存 + 后台预热**——① metadata 缓存秒回 → ② LLM 生成兜底（50s 竞速超时）。**后台自主处理** = active-session 在 result → reviewing 落库时 fire-and-forget 调 `warmResultLayersForTask`（关页面也继续跑，结果写缓存 → 弹窗打开即显）；**存量批量回填** = `scripts/warm-result-layers.ts`（dry-run 统计 → `--apply` LLM 回填）。
- **2026-10-06（R200 turn2，damo 1006 chat 反馈「checkpoints 质量不好、不可控；期望每个任务完成时都走一次 LLM 细节流程总结 + 标题自动命名，模型用系统统一 summary 模型且支持 fallback 链」）**：① **checkpoints 组装层撤除**（标题短路档 + 细节流程中间层一并撤，全部收敛到 LLM 一档）→ 存量 568 个 checkpoints 源缓存已清空（重开懒生成 / 新任务预热，src 统一 'llm'）；② **统一 summary 模型链**（新 `src/lib/runtime/summary-llm.ts`）：`app_settings.summary_llm_config_id` 指向的配置 + 该配置 `fallback_ids` 链（R175 字段首次真正运行时消费）→ 任务自身配置链 → env 兜底，死 key / 鉴权失败自动跳下一跳；result-layers / card-summary / 标题三处摘要调用统一改走此链。**设置**：ao-prod summary 配置 = glm-5.3-flash（含 fallback 链），ao-dev = glm-5.3（均直写 app_settings 生效）。③ 标题质量附带修复：原 summarizeTitle 的 systemPrompt 从未到达 SDK（runSingleTurnLlm 首参被丢弃的潜在 bug），现在统一链内部拼接生效。改动 = summary-llm.ts（新）+ result-layers-llm / card-summary-llm / llm-summarize / auto-rename / result-layers-store / 路由 / 回填脚本；单测 auto-rename 40 + summary-llm 7 + result-layers-store 5 全绿。**13001 已通过 next-dev 热载生效；13000 待 damo 派部署（R128）**。
- **2026-10-06（R204，damo 1006 飞书反馈「已完成任务在 AI 归纳「要修的」里显示一键同意，点了把终态任务重跑」）**：终态惰性守门三层——① **解析端**（`parseDigestJson` 新 `statusById` 参数）：completed/cancelled 错分进非 delivery 分类 → 丢弃，归 delivery → 保留但 `need_owner` 强制 false；② **LLM 口径**：系统提示加硬约束「completed/cancelled 只能进 delivery，need_owner 一律 false」；③ **前端**（`digest-model.ts`）：`digestActionFor` 终态 → `none`（按钮不渲染），`runDigestAction` none 直接 return（防落 agree 分支），`digestGroups` 过滤非已交付的终态条目（旧缓存兜底）。failed/rejected 不在内：失败恰恰是「要修的」典型来源，同意 = 按建议修。改动 = `src/lib/runtime/console-digest.ts` + `spa/src/lib/console/digest-model.ts` + `ConsoleCanvas.vue`；后端 16 + 前端 10 单测全绿。**待 damo 派部署（R128）**。
- **2026-10-08（1007 总结质量批次，damo chat 五连反馈「完成后专门任务直接生成全部总结 包括概览/有啥用/下一步；概览 3~5 句越少越好；不要省略号 总结不到位那叫；`<checkpoint step=1` 标签不该出现在概览」）**：① **summary 链死跳根因修复**——ao-prod 链首 ark 配置月配额爆掉（429 AccountQuotaExceeded）时 SDK 吐「Not logged in · Please run /login」，旧 `AUTH_FAIL_RE` 不认 → 链停在死跳、后面的健康 hop 永远轮不到（**全部 summary 失败的真正根因**，R200 预热 hook 一直在跑但全失败）；修法 = 正则补 `not logged in / please run /login / quota exceeded` + `runSingleTurnLlm` 结果前置检查加同款前缀 + 无 key 配置不进链 + env 覆盖剔除残留 `ANTHROPIC_AUTH_TOKEN`（对齐任务主路径 buildEnv 政策）。② **卡片摘要完成后预热**——新 `card-summary-store.ts`（缓存 `card_summary_v4` → LLM 两级 + inflight 去重 + 迭代 9 闸门保留），reviewing 落库后与 result-layers 同款 fire-and-forget，画布卡片打开即显。③ **layers v3 口径**——概览 1~3 句优先（上限 5）+ 新增【下一步】段（LLM 从 result 提取后续，弹窗「下一步」行优先用它、空则回退 checkpoint 尾条）+ 输入剥运行时标记 + 截断不加省略号（`result_layers_v3`，存量全部重算）。④ **落库剥标签**——reviewing 落库前 `stripRuntimeMarkers`（新 `src/lib/runtime/runtime-markers.ts`）剥 `<checkpoint>/<awaiting>/<git>`，管住新任务的所有下游表面；存量靠 LLM 输入剥 + 前端展示剥（SPA `stripRuntimeMarkers`：弹窗原文/兜底/完整处理全过）。⑤ 标题同口径——`summarizeTitle` 输入剥标记 + 截断不加省略号。⑥ 回填脚本升级——生成/缓存写入统一走 store + 同轮回填卡片摘要。测试：runtime-markers 5 + card-summary-store 6 + summary-llm 9 + result-layers-llm 13 + store 5 + card-summary-llm 11 + llm-summarize 全绿 + SPA card-summary 12；`vue-tsc` + `vite build` 过。改动 = summary-llm.ts / llm-summarize.ts / result-layers-llm.ts / result-layers-store.ts / card-summary-store.ts（新）/ card-summary-llm.ts / runtime-markers.ts（新）/ active-session.ts / 两路由 / 回填脚本 / ConsoleCanvas.vue / spa card-summary.ts。
- **2026-10-08（总结前置收口：任务详情信息面板直读）**：damo 拍板「总结动作前置化 —— 任务执行完成就直接跑，信息面板直接拿任务信息，不走 Console 按需接口」。收尾预热（R200 批次）已在 reviewing 落库后 fire-and-forget 生成两份总结并写 metadata 缓存，本批次把**消费端**接上：① `GET /api/tasks/{id}` 直带 `card_summary` / `result_layers` 字段（store 导出 `readCachedCardSummary` / `readCachedResultLayers` 只读器，失效判定同源：卡片摘要看非空、分层看 result_len 匹配）；② SPA 信息面板（RightDock 详情面板）新增「**总结**」模块置顶（干啥/有啥用 + 概览 + 核心细节流程图 + 下一步，样式对齐 Console 弹窗口径、浅色面板适配），有缓存才渲染，存量任务隐藏可跑回填脚本；③ 详情页在状态变 reviewing/completed 后 25s 单次静默刷新（不转 loading 不动 SSE），把刚预热完的总结拉进页面。Console 弹窗/卡片行为不变（缓存命中 = 秒显）；两个按需路由（result-layers / card-summary）保留供 Console 与 `?refresh` 用，待 Console 改读详情字段后可退役。测试：`summary-fields.test.ts` 3 条（新）+ card-summary 路由测试修复存量键腐化（v3→v4，R200 bump 时漏改）共 42 条全绿。改动 = 两 store（导出只读器）+ 详情路由 + RightDock.vue + TaskDetailView.vue。
- **2026-10-08（卡片摘要「有啥用」升价值口径，damo 1010 实例反馈）**：damo 拿 b9ce2100（热榜轮播任务）举例——「有啥用」写成「以轮播卡片呈现，全链路验证通过，浏览体验升级」= 在复述干了啥 + 完成态空话，没体现对用户/系统的具体价值。修法 = prompt 立口径：①「有啥用」只写价值不复述动作，从「省几步/新能力/堵住坏结果/哪变好用」挑真实成立的写具体；② 两行禁止互为复述；③「验证通过/已完成/体验升级」这类完成态陈述不算价值；④ 自检 = 遮住干啥只读有啥用仍知道为何值得做；⑤ 正反例 few-shot。缓存键 `card_summary_v4→v5` 存量重算。相关 4 文件 20 单测绿。改动 = card-summary-llm.ts + card-summary-store.ts + 3 测试文件。
- **2026-10-10（R238，damo 飞书反馈「展开弹窗后干啥/有啥用/下一步不可见？不限 2 行，小屏幕 2 行不够，完全展示」）**：详情弹窗三行摘要**双重截断松绑**——① 展示层：`.tm-line` 撤 `line-clamp:2`（弹窗行不限行数，`tm-line-uncapped` 修饰类随之清理）；② 数据层：「下一步」原来在 `ensureDetail` 就 `clip(summary, 120)`，几百字的 checkpoint summary 大半直接丢——改存**全文**（过 `stripRuntimeMarkers` 剥管线符号），卡片渲染时才 `clip 120` 保持两行口径，弹窗 `modalNext` 用全文。卡片行为不变（两行口径，R190）。验证：`vue-tsc` 过 + console lib 43 单测绿 + vite dev 连 13001 实测（zhuanlian reviewing 任务弹窗三行完整可见，420px 小屏 `scrollHeight === clientHeight` 无截断）。改动 = `spa/src/views/ConsoleCanvas.vue`（ensureDetail / 卡片渲染 / CSS / 注释）。
