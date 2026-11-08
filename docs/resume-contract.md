# Resume 投递契约

> **这份文档回答一个问题**：一次 `resume()` 到底把哪些消息投给模型、按什么顺序、哪些消费一次就该销毁。
>
> **为什么需要它**：2026-08-12 一次事故里，用户给 `reviewing` 的 fork 任务发新消息，agent 却一直回应旧内容。
> 根因是三个各自独立的「一次性消息没有消费记录」缺陷叠在同一段代码里。三个 bug 形状完全相同，
> 而当时没有任何文档写清这份契约 —— 所以判据写错了也没人看得出来。

**代码**：`src/lib/runtime/active-session.ts` 的 `resume()` + `createMessageGenerator()`。
**回归测试**：`src/lib/runtime/resume-replay-guard.test.ts`（8 条）。

---

## 1. 投递顺序（🔴 排前面的先被模型回答）

`resume()` 把消息交给 `createMessageGenerator(initialPrompt, preMessages)`，generator 按下面顺序 yield，
**每条是一个独立 user turn**：

| 顺序 | 内容 | 何时有值 |
|------|------|---------|
| 1 | `initialPrompt` = `task.prompt` | 仅 fork 任务、且 `fork_prompt_sent` 未置 |
| 2 | `preMessages[0..n]` = 排空的 `pending_messages` | 用户/系统留言（下表） |
| 3 | `preMessages` 末尾 = `[驳回反馈] {reject_reason}` | `reject_reason` 在 metadata 里且未被去重命中 |
| 4 | `RESUME_NUDGE` = `继续` | **仅当 1-3 全空**（否则 resume 后 generator 一条不 yield，agent 干等到 30min 超时）|
| 5 | 之后由 `pushMessage()` 实时推入 | 会话跑起来后用户发的消息 |

**顺序即优先级**：模型先看到的先答。这是事故的直接机理 —— 旧 `task.prompt` 排在位置 1，
用户新消息排在位置 2，于是模型先答了旧的，表现为「新消息发不进去、旧消息一直重复」。

⚠️ `start()`（非 resume）走的是同一个 generator，`initialPrompt` 恒为 `task.prompt`；
**`preMessages` 不再恒空**（damo 2026-10-31）：任务在 pending/queued（从未启动）期间
收到的用户消息被 `sendUserMessage` 缓存进 `pending_messages`，`start()` 启动时排空
并作为 `preMessages` 逐条投在 prompt 之后 —— 顺序契约与上表一致（prompt 先答，
攒下的消息跟后）。回归测试：`src/lib/runtime/start-drains-queued-messages.test.ts`。

### 1.5 插话打断（barge-in，R216，damo 2026-10-08）

**问题**：上表 5 号「`pushMessage()` 实时推入」有边界 —— turn 进行中（尤其长工具调用）消息只能等
SDK turn 边界才被拉取，持续发消息时体感「进不去」。

**机制**（`active-session.ts`）：
1. `pushMessage()` 时 `turnActive=true`（generator 已 yield 消息但 result 未到）→ 主动
   `queryInstance.interrupt()` 打断当前 turn（2s debounce），等价轻量 pause→resume，session 不断。
2. 被打断 turn 以 `error_during_execution` result 收尾 —— `shouldSwallowBargeInResult()` 命中
   插话窗口（30s 内）时**吞掉这条 result 不翻 failed**，generator 续跑处理插话消息。
   ⚠️ `error_max_turns` / `error_max_budget_usd` / synthetic API 错误不在豁免内，照旧失败。
3. live 排队的多条消息在 generator 排空时**合并为一条**（`\n\n` 连接）投递 —— damo：「多条可以合并」。
   与上方 `preMessages`（resume 场景）的逐条投递是有意差异，历史语义不动。

**回归测试**：`src/lib/runtime/message-barge-in.test.ts`（11 条）。

---

## 2. 一次性消息清单（🔴 新增一条就必须在这里加一行）

每条一次性消息都必须有**持久的消费记录**。判据要问「投过没有」，不能拿别的状态凑：

| 消息 | 写入者 | 消费者 | 消费记录（缺了就会重放）|
|------|--------|--------|------------------------|
| fork 的 `task.prompt` | `forkSession()` 建 task 时 | `resume()` 位置 1 | `metadata.fork_prompt_sent = true` |
| `pending_messages` | `queuePendingMessage()`（6 个调用点，见下）| `resume()` 位置 2，`drainPendingMessages()` | 从 metadata **删除** |
| `reject_reason` | `rejectTask()` | `resume()` 位置 3 | 从 metadata **删除** |
| `compact_first` | `forkSession()` 压缩 fork | `resume()` 的 `/compact` 阶段 | 从 metadata **删除** |
| `RESUME_NUDGE`（`继续`）| `resume()` 自己兜底 | 当场 yield | **无**（无状态，每次判断 1-3 是否全空）|

`pending_messages` 的写入者（都在 `agent-runtime.ts`）：
`pauseTask` 回填未被响应的指令、`exitMaintenance` 注入「继续」、
`sendUserMessage` 的分支（paused / 终态自动激活 / **queued 或 pending 且无 live session**
—— damo 2026-10-31 起「从未启动的排队任务」发消息也入这里缓存，启动时由 `start()` 排空投递）、`rejectTask`。

> 定位一律用函数名而非行号（行号会随代码漂移）：`grep -n 'queuePendingMessage' src/lib/runtime/agent-runtime.ts`
> 可一次列出全部写入点。

消费点只有一处：`resume()` 里的 `drainPendingMessages()`。另有 `maybeDrainStrandedMessages()`
用 `peekPendingMessages()` 判断终态任务是否需要自动 resume 来排空（**只读不清**）。

### 🔴 三条红线

1. **判据必须是「投过没有」的直接记录**。事故里 fork 用 `reject_count > 0` 当判据 ——
   `parent_session_id` 是 fork 的永久标记从不清除，而「给 reviewing/completed 的任务发消息」
   走的是同一个 `resume()`，`reject_count` 压根挡不住它。
2. **别靠删血缘字段来止重放**。`parent_session_id` 要留给 UI / lineage，止重放另开标记。
3. **销毁记录放在 resume 之前**。和 `drainPendingMessages` 同一个取舍：中途崩了宁可丢一次投递，
   也不要留着无限重放。

---

## 3. 改 metadata 一律走 `mutateTaskMetadata`

`tasks.metadata` 是整块 JSON，`updateTask` 是全字段覆盖 ——
**谁手上攥着一份过期快照再写回，就会把别人刚写的键悄悄抹掉**。

```ts
// ✅ 重新读库 -> 改 -> 写回
mutateTaskMetadata(taskId, (meta) => { meta.fork_prompt_sent = true });

// ❌ task.metadata 可能已经过期(比如上游刚 drain 过 pending_messages)
const meta = JSON.parse(task.metadata); delete meta.compact_first;
updateTask(taskId, { metadata: JSON.stringify(meta) });
```

事故里 `/compact` 阶段的清理正是后者，把 `drainPendingMessages` 刚排空的 `pending_messages` 复活了一次，
接着被 `maybeDrainStrandedMessages` 当成「还有留言」再投一遍。

⚠️ 仍**无事务**：`mutateTaskMetadata` 只把 read-modify-write 的窗口收窄到函数内，并发写覆盖没有消除。

---

## 4. 排查手法（文档替代不了的那部分）

投递契约能让你看出「哪里可能重放」，但**看不出此刻正在发生哪一个**。事故当时三个候选缺陷并存，
是靠 DB 取证压成「1 个确诊 + 2 个潜伏」的：

```bash
# 同一条 user 消息被投了几次(events 表是稀疏日志, 数出来只会少不会多)
sqlite3 $DB "SELECT created_at, substr(replace(data,char(10),' '),1,80) FROM events
  WHERE task_id='<id>' AND type='message' AND data LIKE '%\"role\":\"user\"%' ORDER BY created_at;"
```

判据：**同一秒并列两条 user 消息** = 一条是用户真发的，另一条是平台重放的。
再看 `tasks.metadata` 里有没有对应的消费记录，就能定位是上表哪一行漏了。

🔴 别只凭代码推断就下结论 —— 三个缺陷的触发条件不同（是否 fork / 是否被驳回过 / 是否 compact），
改错对象等于没修。
