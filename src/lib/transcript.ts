// Transcript formatting: shared by the /transcript/[id] page and the
// /api/tasks/[id]/transcript route. Pure function over events array so it
// doesn't couple to the DB layer and call sites query events once.

import type { TaskEvent } from "./runtime/types";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

// 🔴 harness 注入的取消/拒绝文本(Anthropic Claude Code CLI 二进制硬编码).
// 触发场景: Ctrl+C 中断工具调用 / UI 拒工具 / harness 防护拦截.
// 这些 tool_result 经 SDK 流到模型时是 user-role 消息, 内容是英文 STOP 指令;
// 弱模型(MiniMax-M3 实测)会直球当成"用户在叫停" → ack 后 end_turn 浪费一轮.
// 关注点: 文本是 SDK 二进制里写死的字符串, 平台只能在外层渲染时标出来
//   给运维/审计看, 不能拦截 SDK 已经送给模型的内容 —— 那部分由
//   docs/claude-config/docs/model-guidance/minimax-m3.md 红线 6 教模型分辨.
const HARNESS_DENIAL_PATTERNS = [
  "The user doesn't want to take this action right now",
  "The user doesn't want to proceed with this tool use",
] as const;

// 功能: 判定一段 tool_result content 是否是 harness 注入的取消/拒绝文本.
// 关注点: 既匹配 SDK 流出的 user-role tool_result.content 字符串, 也匹配
//   单层嵌套的 {type:"text", text:"..."} 块数组. 不区分大小写, 防止未来
//   harness 调整文案破窗.
function isHarnessDenialText(text: string): boolean {
  const trimmed = text.trimStart();
  return HARNESS_DENIAL_PATTERNS.some((p) => trimmed.startsWith(p));
}

export function formatTranscriptMarkdown(taskId: string, events: TaskEvent[]): string {
  const lines: string[] = [`# Task ${taskId} - Session Transcript\n`];

  for (const event of events) {
    try {
      const data = JSON.parse(event.data);
      switch (event.type) {
        case "message":
          if (data.role === "assistant") {
            lines.push(`## 🤖 Assistant\n\n${data.text}\n`);
          } else if (data.role === "user") {
            lines.push(`## 👤 User\n\n${data.text}\n`);
          }
          break;
        case "tool_use":
          lines.push(`### 🔧 Tool: ${data.name}\n\n\`\`\`json\n${JSON.stringify(data.input, null, 2)}\n\`\`\`\n`);
          break;
        case "status_change":
          lines.push(`*Status: ${data.from} -> ${data.to}*\n`);
          break;
        case "cost":
          lines.push(`*Cost: $${data.cost_usd?.toFixed(4)}*\n`);
          break;
        case "error":
          lines.push(`**Error:** ${data.error || event.data}\n`);
          break;
      }
    } catch {
      lines.push(`*${event.type}: ${event.data}*\n`);
    }
  }

  return lines.join("\n");
}

// ---- 完整会话导出 (SDK transcript 为源) ----
//
// 为什么不复用上面的 formatTranscriptMarkdown: events 表是稀疏日志(只记
// message/tool_use/status_change/cost/checkpoint), 实测一个 task 的 events
// 只有 SDK jsonl 内容的 ~10%. 导出/备份/跨机搬运必须走 getSessionHistory()
// 拿到的 SessionMessage[](SDK jsonl 为主 + events 补漏).

// summary 模式下 tool_result 与大块文本参数的截断长度.
const SUMMARY_TRUNCATE = 2000;

// tool_use 输入里适合单行展示的标量参数; 其余(content/old_string 这类大块)
// 在 summary 模式下只报字节数, 避免把整个文件内容抄进导出.
const TOOL_KEY_PARAMS = [
  "file_path", "notebook_path", "path", "command", "pattern", "glob",
  "url", "query", "description", "subagent_type", "offset", "limit",
];

export type TranscriptTaskMeta = {
  id: string;
  title: string;
  status: string;
  session_id?: string | null;
  cwd?: string | null;
  model?: string | null;
  resolved_model?: string | null;
  effort?: string | null;
  cost_usd?: number | null;
  created_at?: string;
  completed_at?: string | null;
  project_name?: string | null;
  version_name?: string | null;
  source?: string | null; // 导出机器标识, 由调用方填 (纯函数不摸 os)
};

export type TranscriptVerbosity = "summary" | "full";

// SDK 的 content block 在类型层是 union, 这里只取渲染要用到的字段.
type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
};

// 功能: 把任意 content(string | block 数组) 归一成 block 数组.
// 关注点: SDK 的 user 消息 content 常是裸 string, assistant 一律是数组, 两种都要吃.
function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字）`;
}

// 功能: 抽出 tool_result 的纯文本(content 可能是 string 或 {type:"text"} 块数组).
function toolResultText(block: ContentBlock): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as ContentBlock[])
      .map((b) => (b?.type === "text" ? b.text ?? "" : `[${b?.type || "unknown"}]`))
      .join("\n");
  }
  return "";
}

// 功能: tool_use 输入渲染成一行摘要(summary) —— 只出白名单里的标量参数,
//   大块参数降级成 "<name>: N 字".
function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (TOOL_KEY_PARAMS.includes(k)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}: ${truncate(String(s), 300)}`);
    } else if (typeof v === "string") {
      parts.push(`${k}: ${v.length} 字`);
    } else {
      parts.push(`${k}: ${truncate(JSON.stringify(v) ?? "", 120)}`);
    }
  }
  return parts.join(" · ");
}

// 功能: 把 SessionMessage[] 渲染成一份自包含的 markdown 会话记录, 供导出 /
//   /transcript 页面 / 当附件喂给另一台机器上的新会话共用.
// 关注点: verbosity="summary"(默认) 会丢弃 thinking 并把 tool_result 截到
//   2000 字 —— 长任务原样导出轻易超过 attachments 的 10MB 上限, 而 thinking
//   对"接手上下文"几乎无用. 需要逐字存档时用 "full"(thinking 折进 <details>).
export function formatSessionMarkdown(
  task: TranscriptTaskMeta,
  messages: SessionMessage[],
  opts: { verbosity?: TranscriptVerbosity } = {},
): string {
  const full = opts.verbosity === "full";
  const lines: string[] = [`# ${task.title}\n`];

  const meta: Array<[string, string | null | undefined]> = [
    ["Task ID", task.id],
    ["Status", task.status],
    ["Project", task.project_name],
    ["Version", task.version_name],
    ["Cwd", task.cwd],
    ["Model", task.resolved_model || task.model],
    ["Effort", task.effort],
    ["Cost", task.cost_usd != null ? `$${task.cost_usd.toFixed(4)}` : null],
    ["Session", task.session_id],
    ["Created", task.created_at],
    ["Completed", task.completed_at],
    ["Exported from", task.source],
    ["Messages", String(messages.length)],
    ["Verbosity", full ? "full" : "summary"],
  ];
  for (const [k, v] of meta) if (v) lines.push(`- ${k}: ${v}`);
  lines.push("\n---\n");

  for (const msg of messages) {
    const m = msg as unknown as { type?: string; message?: { content?: unknown }; isSynthetic?: boolean; toolDenialKind?: string };
    const role = m.type;
    const blocks = contentBlocks(m.message?.content);

    for (const block of blocks) {
      switch (block?.type) {
        case "text": {
          const text = block.text || "";
          if (!text.trim()) break;
          // harness 注入的取消文本也可能作为裸 text 块出现(理论上少见,
          // 但 jsonl 上看到过 toolUseResult 字段是同一字符串). 同款渲染.
          if (role !== "assistant" && isHarnessDenialText(text)) {
            lines.push(`## 🛑 harness cancellation\n\n> ${text.trim()}\n\n_非用户输入, 模型若 ack+end_turn 即视为误读 (model-guidance 红线 8)._\n`);
            break;
          }
          lines.push(role === "assistant" ? `## 🤖 Assistant\n\n${text}\n` : `## 👤 User\n\n${text}\n`);
          break;
        }
        case "thinking": {
          if (!full) break;
          lines.push(`<details><summary>💭 thinking</summary>\n\n${block.thinking || ""}\n\n</details>\n`);
          break;
        }
        case "tool_use": {
          if (full) {
            lines.push(`### 🔧 ${block.name}\n\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\`\n`);
          } else {
            const summary = toolInputSummary(block.input);
            lines.push(`### 🔧 ${block.name}${summary ? `\n\n\`${summary}\`` : ""}\n`);
          }
          break;
        }
        case "tool_result": {
          const text = toolResultText(block);
          // 🔴 harness 注入的取消/拒绝: 渲染成 🛑 而非 ❌ ↩ result,
          // 让运维一眼分辨"这是用户拒绝的真实 tool 失败"还是"harness
          // 自动注入的取消信号". 不要静默吞掉 —— 老格式会被误读成
          // "用户 tool 真的报错了".
          if (isHarnessDenialText(text)) {
            const reason = m.toolDenialKind || "cancelled";
            const body = full ? text : truncate(text, SUMMARY_TRUNCATE);
            lines.push(`#### 🛑 harness event (${reason})\n\n_非用户指令, 模型若 ack+end_turn 即视为误读 (model-guidance 红线 8)._\n\n\`\`\`\n${body}\n\`\`\`\n`);
            break;
          }
          const flag = block.is_error ? "❌ " : "";
          const body = full ? text : truncate(text, SUMMARY_TRUNCATE);
          lines.push(`#### ${flag}↩ result\n\n\`\`\`\n${body}\n\`\`\`\n`);
          break;
        }
        case "image": {
          lines.push(`*[图片]*\n`);
          break;
        }
      }
    }
  }

  return lines.join("\n");
}

// 功能: 导出成 jsonl —— 第 1 行元信息头, 之后每条 SessionMessage 一行原样.
// 关注点: 原样保留 SDK 结构(含 thinking/tool_result), 是"逐字存档"格式;
//   它不是可直接被 SDK resume 的 transcript(缺 SDK 私有的 queue-operation /
//   file-history-snapshot 等行, 且跨机 cwd slug 不同), 别当 resume 用.
export function formatSessionJsonl(
  task: TranscriptTaskMeta,
  messages: SessionMessage[],
): string {
  const header = { type: "orchestrator-export", version: 1, task, message_count: messages.length };
  return [JSON.stringify(header), ...messages.map((m) => JSON.stringify(m))].join("\n") + "\n";
}
