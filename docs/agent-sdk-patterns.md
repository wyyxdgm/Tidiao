# Agent SDK 使用模式

项目使用 Claude Agent SDK 的两个核心能力：**Streaming Input Mode** + **运行时工具审批**。

## Streaming Input Mode

`query()` 的 prompt 参数是 `AsyncGenerator<SDKUserMessage>`，可以在 agent 运行中随时 yield 新的用户消息（人工反馈 / 动态纠正）。

```typescript
const messageGenerator = this.createMessageGenerator(task.prompt);
this.queryInstance = query({
  prompt: messageGenerator,
  options: {
    cwd, model, allowedTools, maxTurns, effort,
    includePartialMessages: true,  // 流式输出（partial text deltas）
    enableFileCheckpointing: true,  // 文件回滚（用于 rewind API）
    canUseTool: this.createCanUseTool(),  // 运行时工具审批
  },
});
```

### use case
- agent 跑错方向 → 用户 push 一条消息纠正（无需重启 session）
- paused task 恢复 → drain `task.metadata.pending_messages` 注入到 generator
- fork-at-checkpoint → 父 session 的 generator 状态被替换

## 运行时工具审批（canUseTool）

拦截写操作（Write/Edit/Bash/NotebookEdit），agent 暂停等待 Web UI 审批：

```typescript
canUseTool(toolName, input, opts) => Promise<PermissionResult>
  - auto_approve 任务或只读工具 → { behavior: 'allow' }
  - 写操作 → emit tool_approval_request 事件 → 等待 resolveApproval()
  - deny → { behavior: 'deny', message: feedback }
```

### use case
- 防止 AI 在生产项目目录乱改文件
- 需要人工 sign-off 的高危操作（删除、git push、数据库 DROP 等）
- 教育场景：让学生审查 AI 改了什么

### 实现位置
- `src/lib/runtime/active-session.ts` 的 `createCanUseTool()` 方法
- 事件分发：`ToolApprovalRequestEvent` 通过 SSE 推到前端
- UI 卡片：实时显示在 `task-detail-client.tsx`

## CLAUDE.md 自动加载

SDK 默认从文件系统加载 CLAUDE.md 作为 system prompt 的一部分（跟 CLI 行为一致）。**查找根目录由 `cwd` 选项决定** —— SDK 从 `cwd` 向上递归找 `CLAUDE.md` / `.claude/CLAUDE.md`，命中即合并。

控制开关是 `options.settingSources`（`'user'` / `'project'` / `'local'`）：

| settingSources | 加载 user settings | 加载 project settings + CLAUDE.md | 加载 local settings |
|----------------|-------------------|-----------------------------------|---------------------|
| 不传（默认） | ✅ | ✅ | ✅ |
| `['user', 'project', 'local']` | ✅ | ✅ | ✅ |
| `['user']` | ✅ | ❌ | ❌ |
| `[]`（SDK isolation） | ❌ | ❌ | ❌ |

本项目目前**不传 `settingSources`**，所以默认行为 = 加载全部，CLAUDE.md 自动生效。这意味着：

- agent 跑 task 时，`cwd` 下的 `CLAUDE.md` 会被自动读到 system prompt
- cwd 的 fallback 链（task → version → project → 隔离工作区）见 [`docs/config-resolution.md`](config-resolution.md)
- **不要再把 CLAUDE.md 的内容复制粘贴进 `role.system_prompt`** —— 重复且浪费 token
- role 的 system_prompt 只写"这个角色做什么 + 行为约束"这类动态/角色相关的内容；项目级静态约定让 SDK 自动加载即可

如果未来要做 SDK isolation（比如多租户跑不可信代码），把 `settingSources: []` 加上 —— 但届时需要自己实现 CLAUDE.md 注入（读文件 + appendSystemPrompt）。

参考：Agent SDK `sdk.d.ts:1878` 的 `settingSources` 注释（"Must include `'project'` to load CLAUDE.md files"）。

## File Checkpointing

`enableFileCheckpointing: true` 让 SDK 记录每个 turn 之后的文件状态，`POST /api/tasks/[id]/rewind` 可以回滚到指定 message 状态。

## Fork Session

`forkSession()` 调 SDK 顶层 `forkSession(parentId, { upToMessageId, title, dir })`，生成全新 session_id（不复用父 session）。继承父 autoApprove + maxTurns。

参见 `src/lib/runtime/agent-runtime.ts` 的 fork 路径和 `src/lib/db/checkpoints.ts`。

## API 配置

通过环境变量，传给 SDK 子进程（`ActiveSession.buildEnv()`）：

```bash
# Anthropic 官方
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_BASE_URL=https://api.anthropic.com   # 默认

# 第三方兼容 API（如 MiniMax M2.7）
export ANTHROPIC_API_KEY=sk-cp-...
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
# 创建 task 时 model 字段填 "MiniMax-M2.7"
```

### 已验证模型

- **MiniMax-M2.7**（Anthropic 兼容 API）— 端到端测试通过：单任务约 $0.24