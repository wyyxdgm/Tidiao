# 18. Goal-driven Loop（条件完成型长跑任务）

> 让 task 通过 prompt 内嵌 `<goal>...</goal>` marker + 小模型评判回路，反复跑到条件满足 —— 对标 Claude Code CLI 的 `/goal` 命令。与 [`05-定时任务`](./05-scheduling.md) 的「间隔触发」互补：定时任务 = 每 N 分钟 fire，goal loop = 跑到满足某个语义条件。
> **不在范围**：托管型 outcome（产品级方案，本平台架构不兼容）；替换 verification-runner（正交关系，并存串行 gate）。

---

## 是什么

goal-loop 让 task 在 prompt 里写一个**完成条件**，agent 每轮跑完后由小模型（默认 Haiku 4.5）评判「达成 / 未达成 / 不可能」，未达成则注入反馈或 fork 续跑，达成或达上限则收尾。适用于有明确「完成判据」的场景：文件检查 / 数据校验 / 代码自查 / 状态转换等。

不带 `<goal>` marker 的 task 行为不变（向后兼容）。

---

## 怎么用

### 1. 准备 prompt（含 marker）

```
把 docs/usage/01-overview.md 第一段 'foo' 改成 'bar'.

<goal>docs/usage/01-overview.md 第一段第一个词是 'bar' (且其他内容不变)</goal>
```

` <goal>...</goal>` marker 内的文本 = 完成条件描述，越具体越便于 grader 判定（"文件第一段第一个词是 'bar'" 比 "改对了" 更可判定）。

### 2. 用 ao-dispatch.sh 派发

```bash
scripts/ao-dispatch.sh -p creative-studio -t "fix: 修文档错字" \
  -m "把 docs/foo.md 'foo' 改成 'bar'.\n<goal>docs/foo.md 第一段第一个词是 'bar' (且其他内容不变)</goal>"
```

也可以用 `-f` 从文件读取：

```bash
scripts/ao-dispatch.sh -p creative-studio -t "fix: 修文档错字" \
  -f /tmp/task-prompt.md
# /tmp/task-prompt.md 末尾含 <goal>...</goal>
```

**约束**：
- ✅ 必须 `--auto-approve`（脚本默认即 true，无需显式写）
- ❌ 加 `--no-auto-approve` → 脚本早期校验 exit 1（goal loop 强依赖 autoApprove）
- ❌ prompt 无 `<goal>` marker → 普通 task 行为，不进 goal loop

### 3. agent 末尾输出 goal_report 块自报告

agent 每轮 SDK 报 success 后，**最终回复末尾**用 `goal_report` 块自报告本轮做了什么（grader 读这个块 + transcript 联合判定）：

```
```goal_report
[done|not_done|impossible]
[动作清单: 你用了什么工具]
[产物清单: 文件路径 + 内容]
```
```

| 字段 | 含义 |
|------|------|
| 第 1 行 | 本次自评：`done` = 已满足 goal / `not_done` = 还没满足但方向对 / `impossible` = 做了也达不到 |
| 第 2 行 | 动作清单：用了哪些工具（Read / Edit / Bash ...）|
| 第 3 行 | 产物清单：动了哪些文件 + 内容 |

### 3. 在 UI 创建 goal task（R143 起支持）

完整配置 tab → Prompt 下方「完成条件（goal loop，可选）」textarea，填写后提交时自动拼成 `<goal>...</goal>` 追加到 prompt 末尾（实现：`src/app/tasks/new/page.tsx` `buildGoalPrompt`）。

快速模式默认折叠「设置完成条件（goal loop）」，点开后填写同样行为。**两种模式都默认 autoApprove=true**，满足 goal loop 强制要求；若手动切到「需逐个审核」→ API 返 400 `GOAL_REQUIRES_AUTO_APPROVE`，task 创建失败。

也支持手动在 prompt textarea 直接写 `<goal>...</goal>` marker（CLI/历史做法），行为一致。

### 3.1 per-task 最大轮次（R143 二轮）

完成条件下方有「最大轮次」number 输入框（整数，0 = 不限 sentinel，R143 四轮扩到 1000 上界；空 = 默认 20）。填了就走 per-task 覆盖：API 写 `task.metadata.max_goal_rounds`，`continueGoalLoop` 优先读它，缺省回退到全局 settings。

「没有 goal_text 传数字也无效」：UI 把 input 在 `goal_text` 为空时禁用 + 显式打 ⚠ 警告；后端则宽松——存了 metadata 但 active-session 看不到 goal marker 就不进 continueGoalLoop，字段落空。

CLI / API 也支持：
- API：`POST /api/tasks` 接 `goalRounds` 字段（[0, 1000] 整数，越界 400 `GOAL_ROUNDS_INVALID`）
- CLI：`scripts/ao-dispatch.sh --goal-rounds N`（[0, 1000] 整数，CLI 早期校验，越界 / 非整数 exit 1 不发请求；不传默认 20，跟 settings `DEFAULT_MAX_GOAL_ROUNDS` 对齐，**总是**写 `body.goalRounds` —— 显式优于隐式 + `task.metadata.max_goal_rounds` 落库可观测）

  ```bash
  # 默认（20，body 显式含 goalRounds=20）
  ao-dispatch.sh -p GDM -t "..." -m '...<goal>...</goal>'

  # 自定义 5 轮（折中成本）
  ao-dispatch.sh -p GDM -t "..." -m '...<goal>...</goal>' --goal-rounds 5 --wait

  # 0 sentinel（不限轮次，靠 agent 主动 impossible 早停）
  ao-dispatch.sh -p GDM -t "..." -m '...<goal>...</goal>' --goal-rounds 0
  ```

### 4. agent 末尾输出 goal_report 块自报告

agent 每轮 SDK 报 success 后，**最终回复末尾**用 `goal_report` 块自报告本轮做了什么（grader 读这个块 + transcript 联合判定）：

```
```goal_report
[done|not_done|impossible]
[动作清单: 你用了什么工具]
[产物清单: 文件路径 + 内容]
```
```

| 字段 | 含义 |
|------|------|
| 第 1 行 | 本次自评：`done` = 已满足 goal / `not_done` = 还没满足但方向对 / `impossible` = 做了也达不到 |
| 第 2 行 | 动作清单：用了哪些工具（Read / Edit / Bash ...）|
| 第 3 行 | 产物清单：动了哪些文件 + 内容 |

> **提示**：agent 自评的 done/not_done/impossible ≠ grader 最终 verdict。grader 独立读 transcript 判定。两者不一致时以 grader 为准。

---

## 三种 verdict 含义与对应行为

每轮 agent SDK 报 success 后，调 grader 模型读 transcript 摘要 + goal_report 块，输出三态 verdict：

| verdict | 含义 | 触发后行为 |
|---------|------|-----------|
| **`met`** | transcript 出现 goal 描述的可观察副作用（文件改对了 / 命令 exit 0 / 字段写入正确） | 走 verification-runner → completed（reviewing）|
| **`not_yet_met`** | 方向对但在推进 / 部分完成 / 信息不足 | pushMessage 注入反馈续同一 session，**最多 `max_goal_rounds` 轮**（默认 20）|
| **`impossible`** | 与物理/权限/资源边界冲突 / 自相矛盾 / 依赖不可能前提 | 翻 `failed`（reason = `goal_unreachable`），立即终止 |

**关键边界**：`impossible` ≠ "agent 不会做"。"agent 拒绝做" = `not_yet_met`（agent 有能力做但方向不对）；"做了也达不到"（如要求访问物理隔离网络）= `impossible`。

**续跑策略**：
- context 占用比例 < `goal_resume_threshold`（默认 0.8）→ `pushMessage(feedback, 'system')` 续同一 session
- context 占用比例 ≥ `goal_resume_threshold` → `forkSession({ compactFirst: true })` 开新 task 续跑；**父 task 同步翻 `paused`（reason=`goal_forked`，可 resume）并关闭 session 释放 cwd 锁** —— 否则父仍占 cwd（`parallel_limit` 默认 1），fork 永远排队（2026-10-14 死锁实证，见 `docs/fixes/2026-10-14-goal-loop-fork-deadlock.md`）
- `goal_rounds ≥ max_goal_rounds` → 翻 `failed`（reason = `goal_unreachable_max_rounds`）；`max_goal_rounds=0`（哨兵「不限」）→ 跳过此检查，靠 agent 主动 `impossible` 或 grader `met` 才停

**Agent 主动 impossible 早停（R143 四轮重点）**：

Agent 每轮结束可在 `goal_report` 块第 1 行写 `impossible` 触发提前终止，无需等 `max_goal_rounds` 跑满：

```goal_report
[impossible]
[动作: 反复试了 30 次, 物理网络无法到达 192.168.0.0/16, 这是该网段的物理隔离]
[产物: 见 transcript, 30 次 connect timeout 日志]
```

→ grader 收到 `impossible` 信号 → 输出 `{verdict: "impossible", reason: ...}` → `continueGoalLoop` 翻 `failed`（reason = `goal_unreachable`）。

适用场景：
- 目标与物理/网络/权限边界冲突（隔离网段、不存在 API、文件被锁）
- 任务自相矛盾（"删了自己还要读"）
- 依赖不可能前提（"等永远不会发生的 X 事件"）

**不适用**（仍是 `not_yet_met`）：
- "agent 不会做 / 不会写" → 反馈方向不对, 续跑
- "调外部 API 失败重试" → 短暂失败, 续跑
- "信息不足" → 给补充信息, 续跑

跟 `max_goal_rounds=0`（不限轮次）配合用效果最好：循环永远不结束 + agent 任何一轮写 `impossible` 立即停 = 既给足重试空间又不卡死不可能任务。

**兜底**：grader API 挂 / JSON 解析失败 / verdict 越界 → 视为 `not_yet_met` + warning（不阻断 task）。

---

## 配置项（app_settings 三个 key）

位置：管理 → 设置 → 平台设置（或 `PATCH /api/config`）。

| key | 默认 | 范围 | helper | 说明 |
|-----|------|------|--------|------|
| `goal_grader_model` | `claude-haiku-4-5-20251001` | 任意非空字符串 | `getGoalGraderModel()` | grader 模型。Haiku 4.5 廉价稳定，单次 ≈ $0.001-0.002；调成 opus = 贵 10× 但更准，给关键路径用 |
| `goal_resume_threshold` | `0.8` | `[0.0, 1.0]` | `getGoalResumeThreshold()` | context 占用 ≥ 该值时 fork+compress；0.0 = 永远 fork，1.0 = 永远 resume |
| `max_goal_rounds` | `20` | `[0, 1000]` | `getMaxGoalRounds()` | 超过即翻 failed。R143 二轮改默认 20，R143 四轮扩范围 [0, 1000]，**0 是 sentinel = 不限轮次**（见上文「续跑策略」+「Agent 主动 impossible 早停」）。per-task 覆盖见 §3.1。|

调法：

```bash
# 调成 3 轮就跑，节省成本
curl -X PATCH http://localhost:13000/api/config \
  -H "Cookie: ao-session=$AO_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "key": "max_goal_rounds", "value": "3" }'

# 调成 opus 评（贵但更准，给关键路径用）
curl -X PATCH http://localhost:13000/api/config \
  -H "Cookie: ao-session=$AO_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "key": "goal_grader_model", "value": "claude-opus-4-8" }'
```

脏值 / NaN / 超范围一律 warn 并回退默认值（不会静默落到非法值）。

---

## 成本估算

按 `max_goal_rounds=5` + grader $0.002/次 + Haiku 4.5 agent 单轮 ~$0.05-0.20：

| 路径 | grader 成本 | agent 成本 | 合计 |
|------|-----------|-----------|------|
| 1 轮 met | $0.002 | $0.10 | **$0.10 / 1-3min** |
| 5 轮全 not_yet_met 后 met | 5 × $0.002 = $0.01 | 5 × $0.10 = $0.50 | **$0.51-0.55 / 5-15min** |
| 5 轮全 not_yet_met 后 impossible | 同上 | 同上 | **$0.51-0.55 / 5-15min** |
| 5 轮全 not_yet_met 后 max_rounds giveUp | 同上 | 同上 | **$0.51-0.55 / 5-15min** |
| 20 轮全 not_yet_met 后 giveUp（R143 二轮默认）| 20 × $0.002 = $0.04 | 20 × $0.10 = $2.0 | **~$2.0 / 30-60min** |

最坏 $2.0 / 60min（默认 20 轮全部不满足），仍远低于 verification-runner 失败重试 5 次的成本（编译命令重跑 + 注入反馈 + agent 重做）。

调 `max_goal_rounds` 参考：默认 20（R143 二轮，给足余量）/ 5（保守，成本 $0.50）/ 10（折中，成本 $1.0）。per-task 覆盖见 §3.1。

---

## task.metadata 字段（跑动后查看）

跑动后看下面四个字段（在任务详情页「元数据」或 API `GET /api/tasks/<id>`）：

| 字段 | 类型 | 含义 |
|------|------|------|
| `goal_text` | string | 从 marker 解析（启动时一次）|
| `goal_rounds` | number | 已跑轮数（首次 = 1）|
| `goal_history` | Array<{round, verdict, reason, at, context_tokens, context_max}> | 每轮 grader 输出，cap 在最近 20 条 |
| `last_grader_reason` | string | 最新一轮 grader 给出的原因 |

> UI 暂未暴露 `goal_rounds` / `goal_text` 字段（设计取舍，避免 UI 复杂度）；查 `goal_history` 走 API。

---

## 与定时任务结合

cron 触发 + goal loop = 「每 N 分钟看目标达成没，没达成 agent 自动修正」。例：

```bash
scripts/cron.sh create --name "每 30 分钟检查文档完整性" \
  --exec-type agent --schedule-type cron --expr "*/30 * * * *" \
  --project creative-studio --title "doc-check" \
  --prompt "检查 docs/foo.md 第一段是否含 'bar'.
<goal>docs/foo.md 第一段包含 'bar' (且其他内容不变)</goal>"
```

cron prompt 模板作者写了 `<goal>` = 隐式 goal loop。和手工创建 goal task 行为一致。详见 [`05-定时任务`](./05-scheduling.md)。

---

## 与 verification-runner 关系

goal grader 和 verification-runner 判的东西不一样，**正交关系，并存串行 gate**：

```
goal met? → verification exit 0? → completed
任一失败 → 注入反馈 → 重跑
```

- **goal grader** = 语义完成（"文件改对了" / "文案已修改"）
- **verification-runner** = 编译/测试/lint（exit code 判）

漏掉一个不致命：goal met 但 verification 失败 → verification-runner 注入反馈重跑；goal not_yet_met → 继续 goal loop。

---

## FAQ

### goal loop 跟 verification-runner 啥关系？

并存串行 gate。详见「与 verification-runner 关系」段。两者正交，覆盖不同失败模式（编译失败 vs 语义未达成）。

### autoApprove=false 能跑 goal task 吗？

**不能**。API 强制 `autoApprove=true`。原因：pushMessage 注入到非 autoApprove task 时，下一轮工具调用进审批 UI = loop 死锁。`ao-dispatch.sh` 在脚本早期校验就拦了，加 `--no-auto-approve` + 含 `<goal>` → exit 1；不加 → API 返 400 `GOAL_REQUIRES_AUTO_APPROVE`。

### 已有 fork task 能加 goal marker 吗？

**不能**，marker 在 task **创建时**解析（active-session.ts 启动路径）。fork 后的新 task 必须在 prompt 里**强制重拼** `<goal>...</goal>`（`continueGoalLoop` 在 fork 分支构造 `opts.prompt` 时已处理）。手动创建 fork 然后希望保留原 goal 不行 —— 必须 fork 时显式带 marker。

### schedule 触发的 task 带 goal marker 会怎样？

schedule prompt 模板作者写了 `<goal>` = 隐式 goal loop。和手工创建 goal task 行为一致。

### 与 CLI `/loop` 有什么区别？

- `/loop` = 每 N 分钟 fire 一次新建 task（[`05-定时任务`](./05-scheduling.md) 的 ScheduleRunner 实现）
- `/goal` = 跑到满足某个条件（本文）

两者正交：goal task 也可由 schedule 触发（每 N 分钟看一次目标达成了没，到时间不达 → 翻 failed）；schedule 触发的 goal task = 间隔 + 条件 = 更复杂的策略。

### chat 输入框的 /goal / /loop slash 命令（R143 五轮）

任务详情页底部 chat 输入框支持两个 slash 命令，复用已有 goal-loop + cron 基础设施。R143 五轮起 Next master + SPA 都支持（SPA port 见 [spa/src/lib/chat/slash-command.ts](../../spa/src/lib/chat/slash-command.ts)）：

| 命令 | 效果 | 实现 |
|------|------|------|
| `/goal <prompt>` | 在当前 task 归属的 project/version 下**新建一个 goal task**，prompt 包装为 `<goal>...</goal>` 触发 goal loop。创建后自动跳转新 task 页。 | `POST /api/tasks` 同 /tasks/new 完整配置 tab 行为 |
| `/loop [interval] <prompt>` | 在当前 task 归属的 project/version 下**新建一个 cron schedule**（agent 类型），按 interval 周期执行 prompt | `POST /api/schedules`（ScheduleRunner） |

interval 简写格式：`Nm`（分钟 1-59）/ `Nh`（小时 1-23）/ `Nd`（v1 仅 `1d`，每天 9 点首次）。其他格式（如 cron 字面）走 `/api/schedules` 的 cron expr 字段，slash 命令 v1 不支持。

示例：

```
/goal docs/foo.md 第一段第一个词是 'bar'（且其他内容不变）
/loop 30m 检查 docs/foo.md 含 bar
/loop 2h 检查 docs/foo.md 含 bar
/loop 1d 每天 9 点跑一次检查
```

**实现层**（[src/lib/chat/slash-command.ts](../../src/lib/chat/slash-command.ts) + SPA [spa/src/lib/chat/slash-command.ts](../../spa/src/lib/chat/slash-command.ts)）：
- 纯函数 `parseSlashCommand(text)`：检测 `/goal` / `/loop`，提取 prompt + cron 表达式
- `intervalToCron(raw)`：简写 → cron 表达式，格式错返 null（caller 报「无法识别」）
- 解析在 UI 层（Next master 端 task-detail-client.tsx handleSendMessage；SPA 端 TaskMessageInput.vue:send），非 slash 命令走原 message 路径，不吞 `/xxx` 未知命令
- 14 条单测覆盖（大小写 / trim / 边界 / 未知命令）

**失败行为**：API 调用失败 → toast 报错 + 还原输入框（用户可改后重发）。

### grader 误判怎么办？

- 看 `task.metadata.goal_history` —— 每轮 grader 给的 `verdict` + `reason` + `at` 时间戳都在
- 如误判 met → 调高 `goal_grader_model` 到 opus（更准但贵 10×）
- 如 grader 永远判 not_yet_met → 检查 prompt 让 goal_text 更明确（"文件第一段第一个词是 'bar'" 比 "改对了" 更可判定）
- 如 grader 抛错 → 视为 not_yet_met 续跑，下一轮 verification-runner 兜底

### agent 自评 `goal_report` 与 grader verdict 不一致怎么办？

**以 grader 为准**。grader 独立读 transcript + goal_report 块判定，agent 自评只作参考。两者不一致时平台行为 = grader verdict 对应的分支。

---

## 不做的事（scope 边界）

- ❌ 不引入新 SDK 依赖
- ❌ 不实现 Managed Agents outcome（产品级托管方案）
- ❌ 不替换 verification-runner（正交关系，并存）
- ❌ 不加 `tasks.goal_text` DB 字段（marker 走 prompt，零 schema 改动）
- ❌ 不改 ScheduleRunner（`/loop` 等价物已存在）
- ❌ 不改 fork API（只内部消费 `compactFirst`）
- ❌ ~~不做 goal UI（前端不暴露 goal_rounds / goal_text 字段）~~ ✅ R143 起 `/tasks/new` 已暴露 goal_text 结构化字段（详见「怎么用 §3」）；goal_rounds / goal_history 仍走 API 查看
- ❌ 不加 goal loop 专用通知（沿用 task completion 通知链路）
- ❌ 不跨进程复用 goal session（每次 fork 都是新 task，新 SDK session）

---

## 相关文档

- **派发 CLI**：[`scripts/ao-dispatch.sh`](../../scripts/ao-dispatch.sh)（用法提示在头部 / 早期校验）
- **定时任务 CLI**：[`scripts/cron.sh`](../../scripts/cron.sh)（头部含 goal-loop 注释）
- **任务管理章节**：[`03-tasks.md`](./03-tasks.md)（派发章节含 goal-loop 引用）

---

## 实现原理（开发者参考）

- **grader 模块**：`src/lib/runtime/goal-grader.ts` —— 调 runSingleTurnLlm + 解析 `{verdict, reason}` + 失败兜底
- **集成点**：`src/lib/runtime/active-session.ts` —— 启动时解析 marker → success 拦截路径调 gradeGoal → 调 continueGoalLoop
- **续跑 helper**：`src/lib/runtime/agent-runtime.ts:continueGoalLoop()` —— 决策树（giveUp / fork+compress / pushMessage）+ metadata 写回

- **配置 helper**：`src/lib/db/settings.ts:getGoalGraderModel/getGoalResumeThreshold/getMaxGoalRounds()`
