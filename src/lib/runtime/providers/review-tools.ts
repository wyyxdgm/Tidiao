// Agent SDK 工具: refine / await / unawait (review 状态机).
//
// 🆕 R131 (damo 2026-09-15): 取代旧 reject 工具. review 状态机三动作 —
//   - refine: reviewing → running, agent 接着干 (替旧 reject)
//   - await: running → await_user, 等用户介入/拍板/建议
//   - unawait: await_user → running, 等结束了
//
// 通过 SDK 的 createSdkMcpServer 注入. 实际 tool 名 = "mcp__review__refine" /
// "mcp__review__await_user" / "mcp__review__unawait". 上层 (active-session 的
// query options) 把本 server 加进 mcpServers.
//
// 关注点:
//   - handler 在 platform Node.js 进程内跑 (跟 active-session 同进程), 闭包
//     拿 taskId. 调同进程内部 fetch 到本地 HTTP 端点 (POST /api/tasks/[id]/{refine,await,unawait}).
//   - task_id 自动从 ctx 取, agent 不传 = 防呆. metadata 自动填 requested_by='agent'.
//   - 不用 HTTP 也可以直接调 getRuntime() — 选 HTTP 是为了对外契约一致 (UI/damo 也
//     走同端口), 错误码 = 真实 HTTP status, 模型能直观读懂.
//   - 状态机白名单校验由 HTTP 端点做, agent 调错状态时拿到 4xx 直接 retry 或停下.
//   - 工具不在 ALL_TOOLS (built-in) 集合, canUseTool 的 configurable gate 自然放过.
//     WRITE_TOOLS 也不含, !WRITE_TOOLS.has(toolName) → allow. 任何任务可调, 不用 autoApprove.

import { z } from "zod";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type ToolResult = CallToolResult;

export interface ReviewToolsContext {
  taskId: string;
  /** base URL 走同进程 HTTP. 默认 = 当前进程的对外地址 (UI 调用同源). */
  baseUrl: string;
  /** session cookie 或 user header (从 active-session 拿). */
  userId: string;
}

const refineInputSchema = {
  message: z.string().optional().describe("可选: 给 agent 的继续消息. 不传 = 仅切回 running 不附加指令."),
};

const awaitInputSchema = {
  reason: z
    .enum(["dispatch_needed", "decision_pending", "suggestion"])
    .describe("等用户介入的原因: dispatch_needed(等派发实现) / decision_pending(等拍板) / suggestion(有建议给 damo)."),
  note: z.string().optional().describe("可选: 自由文本, UI 渲染给 damo 看."),
};

const unawaitInputSchema = {
  reason: z
    .enum(["agent_self_resolved", "user_timeout", "external_event"])
    .describe("等结束了的原因: agent_self_resolved(自决) / user_timeout(超时) / external_event(外部触发)."),
  note: z.string().optional().describe("可选: 自由文本, 留痕."),
};

// 同进程 HTTP 调用封装. 错误码 = 真实 HTTP status. 4xx → isError:true 让模型看到.
async function postJson(
  ctx: ReviewToolsContext,
  path: string,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": ctx.userId,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: [{ type: "text", text: `[HTTP ${res.status}] ${text}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: text }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `[review-tools 网络错误] ${msg}` }],
      isError: true,
    };
  }
}

// 工具工厂. 同 active-session 一次构造一份 ctx, 复用同一 instance.
let _lastServerInstance: { server: McpSdkServerConfigWithInstance; ctx: ReviewToolsContext } | null = null;

export function createReviewServer(ctx: ReviewToolsContext): McpSdkServerConfigWithInstance {
  if (_lastServerInstance && _lastServerInstance.ctx !== ctx) {
    _lastServerInstance = null;
  }
  if (_lastServerInstance) {
    return _lastServerInstance.server;
  }

  const server = createSdkMcpServer({
    name: "review",
    version: "1.0.0",
    instructions:
      "review MCP server: review 状态机三动作 (refine / await_user / unawait). task_id 自动从 session 取, metadata 自动填 requested_by='agent'. 等用户介入用 await_user (running→await_user), agent 接着干用 refine (reviewing→running), 等结束用 unawait (await_user→running).",
    tools: [
      {
        name: "refine",
        description:
          "reviewing → running, 让 agent 接着干. 取代旧 reject: 不进 rejected 终态, session 保留, agent 自己消费消息. message 可选.",
        inputSchema: refineInputSchema,
        handler: (async (rawArgs: Record<string, unknown>) => {
          const args = rawArgs as z.infer<z.ZodObject<typeof refineInputSchema>>;
          return await postJson(ctx, `/api/tasks/${ctx.taskId}/refine`, {
            message: args.message,
          });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
      {
        name: "await_user",
        description:
          "running → await_user, 等用户介入. reason 必填: dispatch_needed / decision_pending / suggestion. 区别 pending(=等系统)/awaiting_owner_review(=reviewing flag). 调完 agent 停下, 等 damo 拍板.",
        inputSchema: awaitInputSchema,
        handler: (async (rawArgs: Record<string, unknown>) => {
          const args = rawArgs as z.infer<z.ZodObject<typeof awaitInputSchema>>;
          return await postJson(ctx, `/api/tasks/${ctx.taskId}/await`, {
            reason: args.reason,
            note: args.note,
            requested_by: "agent",
          });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
      {
        name: "unawait",
        description:
          "await_user → running, 等结束了. reason 必填: agent_self_resolved / user_timeout / external_event. 区别 approve (→completed): unawait 仅清 await 标记回到 running, agent 可继续工作.",
        inputSchema: unawaitInputSchema,
        handler: (async (rawArgs: Record<string, unknown>) => {
          const args = rawArgs as z.infer<z.ZodObject<typeof unawaitInputSchema>>;
          return await postJson(ctx, `/api/tasks/${ctx.taskId}/unawait`, {
            reason: args.reason,
            note: args.note,
            requested_by: "agent",
          });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
    ],
  });

  _lastServerInstance = { server, ctx };
  return server;
}

/** 重置缓存的 server instance (测试场景). */
export function _resetReviewServerForTesting(): void {
  _lastServerInstance = null;
}
