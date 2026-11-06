<script setup lang="ts">
/* 功能: 任务详情 transcript 实时流组件 — 一次性拉历史 + EventSource 订阅
   SSE 增量事件, 渲染消息列表 + 自动滚到底 + 3s 重连 + 连接中 Spinner.
   URL: /api/tasks/[id]/messages (历史) + /api/tasks/[id]/stream (SSE).
   父组件: TaskDetailView 在已有元信息下方嵌入本组件, 仅传 taskId.

   关注点 (R20 scope, 来自 sheet R20 任务清单):
   - 历史 vs 流: 历史走 GET /api/tasks/[id]/messages (一次性 fetch, R19 同款
     模式), SSE 走 EventSource('/api/tasks/[id]/stream'). 历史拉完再开 SSE,
     避免 race (历史 GET 期间到达的 SSE 事件可能比历史 fetch 更晚入库, 但 master
     实现里历史 = SDK session JSONL 完整 dump, SSE = live + DB events replay;
     先历史再 SSE = 历史在前 + 新事件在后, 顺序天然正确).
   - 重连策略: EventSource 默认无限重连(默认 3s), 但若 session 过期服务端返
     401, EventSource 默认会无限 401 重连 — 与 master 同款 probe
     /api/user/me, 401 则主动 close 不再重连 (AuthGuard 跳登录页接管).
   - 重连退避: 显式 close + setTimeout 3s 重建, 与 sheet "3s 重连" 对齐.
     EventSource 自动重连虽省事, 但无法干预 401 close 后的"不再重连"语义 —
     显式管理更清晰. 加 retryCount 上限 20 防无限重连死循环 (实测可绕开
     "proxy 挂 / 服务真 down 时页面卡死" 的边角).
   - 流式文本 stream_delta: SSE 不带完整消息边界, 多条 delta 拼成一条
     streamingText 暂存项; 收到 assistant_message 时清空 streamingText 并
     推送正式消息 (与 master handleEvent 同款语义).
   - 关注点 (代理): vite dev proxy 同源 /api, EventSource 不需 withCredentials
     (same-origin 自动带 cookie). 生产 nginx 反代同理 (proxy_pass 透传 cookie).
   - 不实现 markdown 渲染 / 用户输入 / 工具审批 / 文件 diff 等 — 这些归 M3+
     独立 task. 本组件仅做"transcript 流接入 + 滚动 + 重连 + Spinner"
     四件套.
   - 与 sheet 模块名差异披露: sheet R20 列 "[新] spa/src/views/TaskDetail.vue",
     实际 = TaskDetailView.vue (现有文件) + 新建本组件 TaskTranscript.vue
     (sheet 红线允许的"如 transcript 视图组件化可接受"分支, 单一新文件). */
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { get, getIfChanged } from '@/api/http';
import Loading from '@/components/Loading.vue';
import ForkModal from '@/components/ForkModal.vue';
import MessageForkBoundary from '@/components/MessageForkBoundary.vue';
import { renderTranscriptMessage } from '@/lib/markdown';
import { formatTimestampLabel } from '@/lib/datetime-format-label';
import { parseDbTime } from '@/lib/datetime';
import {
  createTaskStreamSubscription,
  taskStreamState,
  MAX_RETRY_COUNT,
  type TaskStreamEvent,
} from '@/composables/useTaskStream';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** 任务 ID. 父组件 useRoute().params.taskId 透传. */
  taskId: string;
  /** parent task 标题 + prompt + max_turns 给 ForkModal 当默认值. */
  parentTitle: string;
  parentPrompt: string;
  parentMaxTurns: number | null;
  /** context 占用阈值 — ForkModal 用这个决定是否默认勾选 compactFirst. */
  contextTokens: number | null;
  /** R56-A3.4 (C4): 搜索条移出 transcript, 由父级 TaskStatusBar 🔍 toggle 控制.
      searchOpen = true 时本组件渲染搜索 input (master tdc.tsx:2511-2539 同款);
      searchQuery 与 v-model 双向绑定到父级, 父级持久化或由状态栏管理. */
  searchOpen: boolean;
  searchQuery: string;
  /** R56-A3.5 (C5): 内联 ForkBoundary — 父任务信息 + forked_at 时间戳.
      master tdc.tsx:3160-3166 同款 prev.timestamp < forkMs ≤ msg.timestamp 触发. */
  forkedAt: string | null;
  parentTask: { id: string; title: string; status: string } | null;
  /** R56-A4.6: 显示模式 — text-only / all / expanded. 父级 (TaskStatusBar) 持有
      source of truth + 持久化. text-only 隐藏 tool_use/tool_result; expanded
      让所有 tool_use 默认展开. */
  displayMode?: 'text-only' | 'all' | 'expanded';
  /** R56-A4.7: projectId 用于 markdown 渲染时把 .md 链接转 wiki 深链. */
  projectId?: string | null;
  /** R56-B2.4: 父任务在没有 messages 但已有 task.result / task.error 时
      透传进来, 让 transcript 空态渲染 markdown 结果 (master tdc.tsx:2571-2591
      同款 — 失败任务一次性展示, 无须等 SSE 走完). */
  taskResult?: string | null;
  taskError?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  parentTitle: '',
  parentPrompt: '',
  parentMaxTurns: null,
  contextTokens: null,
  searchOpen: false,
  searchQuery: '',
  forkedAt: null,
  parentTask: null,
  displayMode: 'all',
  projectId: null,
  taskResult: null,
  taskError: null,
});

const emit = defineEmits<{
  (e: 'update:searchQuery', q: string): void;
}>();

/** ts ms → "HH:mm:ss". 缺省 → "—". 与 master task-detail-client.tsx
    formatTime 同款. */
/** R56-B4.7: 工具类型图标 — 跟 master tdc.tsx toolCardSummary 同款, 但补充
    每个工具类型独立 emoji (master 只有 ▶ 箭头没类型图, 区分 Bash / Read / Edit
    不直观). SPA 这里集中维护. */
function toolIcon(toolName: string | undefined): string {
  switch (toolName) {
    case 'Bash':
    case 'bash':
      return '🖥️';
    case 'Read':
    case 'read':
      return '📖';
    case 'Write':
    case 'write':
      return '📝';
    case 'Edit':
    case 'edit':
      return '✏️';
    case 'Grep':
    case 'grep':
      return '🔍';
    case 'Glob':
    case 'glob':
      return '📂';
    case 'Agent':
    case 'agent':
      return '🤖';
    case 'WebFetch':
    case 'webfetch':
      return '🌐';
    case 'WebSearch':
    case 'websearch':
      return '🔎';
    default:
      return '🔧';
  }
}

/** R56-B4.6: 折叠态一行摘要 — master tdc.tsx:253 toolCallSummary 同款.
    优先用 description (Bash/Agent 等工具自带的人类可读说明), 否则按工具类型
    取关键入参 (Bash 截短 command, Edit/Read/Write 取 basename). 折叠态拿
    description 比单看 tool_name ("Bash Bash") 有用. R56-B4.6.1: description
    不在 JS 层截断 (CSS 容器可换行展示完整), Bash command 仍然 40 字截短
    (单行 shell 命令太长没意义, 不如展开看 toolInput 完整 JSON). */
function toolCallSummary(
  toolName: string | undefined,
  toolInputRaw: Record<string, unknown> | undefined,
): string {
  if (!toolName) return 'Tool';
  const input = toolInputRaw ?? {};
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  if (desc) return `${toolName}: ${desc.replace(/\s*\n\s*/g, ' ')}`;
  switch (toolName) {
    case 'Edit':
    case 'edit': {
      const fp = String(input.file_path ?? input.filePath ?? '');
      const file = fp.split('/').pop() || fp;
      const line = input.old_string
        ? `:${String(input.old_string).split('\n').length}L`
        : '';
      return `Edit: ${file}${line}`;
    }
    case 'Write':
    case 'write': {
      const fp = String(input.file_path ?? input.filePath ?? '');
      const file = fp.split('/').pop() || fp;
      return `Write: ${file}`;
    }
    case 'Bash':
    case 'bash': {
      const cmd = String(input.command ?? '');
      // 单行 shell 命令 40 字截短 (跟 master 一致), 长命令 → 展开看完整 JSON.
      const short = cmd.length > 40 ? cmd.slice(0, 37) + '…' : cmd;
      return `Bash: ${short}`;
    }
    case 'Read':
    case 'read': {
      const fp = String(input.file_path ?? input.filePath ?? '');
      const file = fp.split('/').pop() || fp;
      return `Read: ${file}`;
    }
    case 'Grep':
    case 'grep':
      return `Grep: ${String(input.pattern ?? '')}`;
    case 'Glob':
    case 'glob':
      return `Glob: ${String(input.pattern ?? '')}`;
    default:
      return toolName;
  }
}

/** 折叠态摘要 (去重版). 无 description/command 的工具 (如 mcp__chrome-devtools__*)
    走 toolCallSummary 的 default fallback = toolName 本身 → 名字渲染两遍;
    摘要与工具名相同则返回 '' 不渲染 (damo 1006 手机反馈挤行时顺带去重). */
function toolCollapsedSummary(
  toolName: string | undefined,
  toolInputRaw: Record<string, unknown> | undefined,
): string {
  const s = toolCallSummary(toolName, toolInputRaw).replace(/^[A-Za-z]+: /, '');
  return s === (toolName || 'tool') ? '' : s;
}

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** R56-B1.3: 字节数 → "1.2 MB" / "456 KB" / "789 B". master tdc.tsx:208-216
    formatSize 同款 (KB/MB/GB 三档 + B 兜底). */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** R56-B1.5: user 消息发送方标签 — master tdc.tsx:3279-3285 同款三态. */
function senderBadge(senderType: string | undefined): { icon: string; label: string; cls: string } {
  switch (senderType) {
    case 'script': return { icon: '🤖', label: '脚本', cls: 'sender-script' };
    case 'system': return { icon: '⚙️', label: '系统', cls: 'sender-system' };
    default:       return { icon: '👤', label: '你',   cls: 'sender-user' };
  }
}

/** R56-B3.1: 历史 GET /api/tasks/[id]/messages 返回的 SDK 格式消息
   (来自 getRuntime().getSessionHistory). 实际结构是嵌套的
   `{type, uuid, session_id, message: {role, content}, parent_tool_use_id,
   parent_agent_id, timestamp}` — `content` 是 string 或 block 数组
   (text / tool_use / tool_result). 历史里 tool_result 块混在 type='user'
   里 (SDK 把 tool 执行结果也归类为 user), 必须按 block 类型拆开.
   R56-B1.2 / R56-B1.3 / R56-B1.4 attachment/warning/sender_type 字段
   历史接口仍保留 (attachment 走 master /api/tasks/[id]/attachments
   端点 fetch, 不在 messages 流里 — 见 loadHistory). */
interface HistoryContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}
interface HistoryMessage {
  type?: string;
  role?: string;
  uuid?: string;
  /** SDK 实际返回 — content 字段藏在这里. */
  message?: {
    role?: string;
    content?: string | HistoryContentBlock[];
  };
  /** R56-B3.1: SDK session_messages 透传 ISO 时间戳. */
  timestamp?: string | number;
  /** R56-B1.5: user 消息的发送方 — master tdc.tsx:3279-3285 同款.
     user (默认 👤 你) / script (🤖 脚本) / system (⚙️ 系统). */
  sender_type?: string;
  /** R56-B1.3: attachment 单条 (历史流里基本不出现, 真实路径走
     /api/tasks/[id]/attachments 在 loadHistory 后插; 保留兜底). */
  attachment?: {
    id: string | number;
    filename: string;
    media_type: string;
    size_bytes: number;
  };
  /** R56-B1.4: attachment_group 多条. 同上保留兜底. */
  attachments?: Array<{
    id: string | number;
    filename: string;
    media_type: string;
    size_bytes: number;
  }>;
}

/** 统一的消息项, 内部用. 历史 + SSE 合并到同一数组里渲染. */
interface TranscriptItem {
  /** 客户端唯一 id — 历史用 uuid; SSE 自增 id. */
  id: string;
  /** 角色归类. user / assistant / tool / warning / attachment / attachment_group. */
  role: 'user' | 'assistant' | 'tool' | 'warning' | 'attachment' | 'attachment_group';
  /** 显示文本. tool 角色时 = tool_name (tool_use) 或 result (tool_result). */
  content: string;
  /** 工具名 (role=tool + tool_use 类型时). */
  toolName?: string;
  /** 原始时间戳 ms, 用于左侧时间列. undefined → "—". */
  ts?: number;
  /** 流式暂存标记. SSE stream_delta 累积到这一条; assistant_message
      到达时清空并推正式条目. */
  streaming?: boolean;
  /** R56-A4.6: tool_use 是否折叠. expanded 显示模式强制全部展开. */
  collapsed?: boolean;
  /** R56-A4.6: tool_use 输入 JSON (渲染折叠 body 用). */
  toolInput?: string;
  /** R56-B4.6: tool_use 原始输入对象 (用于折叠态摘要 — 拿 description / command
      / file_path 等关键入参, 跟 master tdc.tsx:253 toolCallSummary 同款). */
  toolInputRaw?: Record<string, unknown>;
  /** R56-B1.5: user 消息的发送方 (user/script/system). */
  senderType?: string;
  /** R56-B1.3: attachment 单条 (media_type/filename/size_bytes/id). */
  attachment?: {
    id: string | number;
    filename: string;
    media_type: string;
    size_bytes: number;
  };
  /** R56-B1.4: attachment_group 多条. */
  attachments?: Array<{
    id: string | number;
    filename: string;
    media_type: string;
    size_bytes: number;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** UUID v7 时间戳提取 (与 master task-detail-client.tsx 同款算法).
    SDK 消息的 uuid 是 v7, 前 48 位 = unix ms, 没有 timestamp 字段时
    用它兜底显示时间. */
function uuidToTimestamp(uuid: string | undefined): number | undefined {
  if (!uuid) return undefined;
  const clean = uuid.replace(/-/g, '');
  const msHex = clean.slice(0, 12);
  const ms = parseInt(msHex, 16);
  if (Number.isNaN(ms) || ms < 1_000_000_000_000) return undefined;
  return ms;
}

/** R56-B3.1: SDK 内部塞 (subagent <task-notification>, <system-reminder>
   等) 不该渲染成 user 消息 — master tdc.tsx:231-240 isSdkInternalContent 同款.
   历史 type='user' 但 content 命中以下任一标记 → skip. */
function isSdkInternalContent(text: string): boolean {
  if (!text) return false;
  if (text.includes('<task-notification>')) return true;
  if (text.includes('<system-reminder>')) return true;
  if (text.includes('tool_result')) return true;
  return false;
}

/** R56-B3.1: 历史条目 → 统一 TranscriptItem. 解析 SDK-style
   `{type, message: {content: string|Array<block>}}` 嵌套结构.
   - type='user':  string content → user msg (过滤 SDK 内部);
                   array content 含 tool_result → 整条 skip (master
                   tdc.tsx:881-883 同款); 只有 text block → user msg.
   - type='assistant': string → assistant text;
                       array → 每个 text block 推 assistant text, 每个
                       tool_use block 推 tool entry (折叠态). */
function normalizeHistoryItem(m: HistoryMessage): TranscriptItem | null {
  const content = m.message?.content;
  const ts = typeof m.timestamp === 'number' ? m.timestamp
    : typeof m.timestamp === 'string' ? new Date(m.timestamp).getTime()
    : uuidToTimestamp(m.uuid);

  // R56-B3.1: attachment / attachment_group 兜底 (历史流里基本不出现,
  // 见 loadHistory 注释 — 真实路径走 /api/tasks/[id]/attachments).
  if (m.attachment) {
    return {
      id: m.uuid ?? `history-${Math.random().toString(36).slice(2, 10)}`,
      role: 'attachment',
      content: m.attachment.filename,
      attachment: m.attachment,
      ts: Number.isNaN(ts ?? NaN) ? undefined : ts,
    };
  }
  if (m.attachments && m.attachments.length > 0) {
    return {
      id: m.uuid ?? `history-${Math.random().toString(36).slice(2, 10)}`,
      role: 'attachment_group',
      content: `${m.attachments.length} 个附件`,
      attachments: m.attachments,
      ts: Number.isNaN(ts ?? NaN) ? undefined : ts,
    };
  }

  // R56-B3.1: 没有 content 字段且没 attachment → 跳过 (避免空 push).
  if (content == null) return null;

  // type='user': string content → 直接做 user msg (过滤 SDK 内部);
  // array content → 检查 tool_result 块 (整条 skip), 合并 text 块.
  if (m.type === 'user') {
    if (typeof content === 'string') {
      if (!content || isSdkInternalContent(content)) return null;
      return {
        id: m.uuid ?? `history-${Math.random().toString(36).slice(2, 10)}`,
        role: 'user',
        content,
        ts: Number.isNaN(ts ?? NaN) ? undefined : ts,
        senderType: m.sender_type,
      };
    }
    if (Array.isArray(content)) {
      const hasToolResult = content.some((b) => b.type === 'tool_result');
      if (hasToolResult) return null; // master tdc.tsx:881-883 同款 skip
      const text = content
        .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
        .join('');
      if (!text) return null;
      return {
        id: m.uuid ?? `history-${Math.random().toString(36).slice(2, 10)}`,
        role: 'user',
        content: text,
        ts: Number.isNaN(ts ?? NaN) ? undefined : ts,
        senderType: m.sender_type,
      };
    }
    return null;
  }

  // type='assistant': string → 一条 assistant 文本; array → 每个 text
  // 推一条 assistant 文本 (按 block 顺序), 每个 tool_use 推一条 tool.
  // 一条 history 可能产生多条 item, 需要返回数组 — 但 normalizeHistoryItem
  // 当前签名只返单条. 改成一次返首条 + 用 historyToolUses / historyTexts
  // 二级结构收集, 在调用侧展开. (见下方调用方的 spread.)
  // R56-B3.1: 简化 — 只返首条, 其它在 caller 自行 loop 处理 (调用频率低,
  // 不需要 O(1) 索引优化).
  const baseId = m.uuid ?? `history-${Math.random().toString(36).slice(2, 10)}`;
  const baseTs = Number.isNaN(ts ?? NaN) ? undefined : ts;
  if (m.type === 'assistant') {
    if (typeof content === 'string') {
      if (!content) return null;
      return { id: baseId, role: 'assistant', content, ts: baseTs };
    }
    if (Array.isArray(content)) {
      // 取第一个 text block 作为主条目; 其它 (text/tool_use) 在 caller 展开.
      for (const b of content) {
        if (b.type === 'text' && b.text) {
          return { id: baseId, role: 'assistant', content: b.text, ts: baseTs };
        }
        if (b.type === 'tool_use' && b.name) {
          return {
            id: `${baseId}-${b.id ?? Math.random().toString(36).slice(2, 8)}`,
            role: 'tool',
            content: b.name,
            toolName: b.name,
            toolInput: b.input ? JSON.stringify(b.input, null, 2) : '',
            toolInputRaw: b.input ?? undefined,
            ts: baseTs,
            collapsed: true,
          };
        }
      }
    }
  }
  return null;
}

/** R56-B3.1: 一条 assistant history 可能含多个 text + tool_use 块,
   而 normalizeHistoryItem 单条返回. 这个 helper 在 loadHistory 循环里
   调用, 一次展开成多条 TranscriptItem (master tdc.tsx:897-911 同款语义). */
function expandHistoryItem(m: HistoryMessage): TranscriptItem[] {
  const content = m.message?.content;
  if (m.type !== 'assistant' || !Array.isArray(content)) {
    const single = normalizeHistoryItem(m);
    return single ? [single] : [];
  }
  const ts = typeof m.timestamp === 'number' ? m.timestamp
    : typeof m.timestamp === 'string' ? new Date(m.timestamp).getTime()
    : uuidToTimestamp(m.uuid);
  const baseTs = Number.isNaN(ts ?? NaN) ? undefined : ts;
  const baseId = m.uuid ?? `history-${Math.random().toString(36).slice(2, 10)}`;
  const out: TranscriptItem[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) {
      out.push({ id: baseId, role: 'assistant', content: b.text, ts: baseTs });
    } else if (b.type === 'tool_use' && b.name) {
      out.push({
        id: `${baseId}-${b.id ?? Math.random().toString(36).slice(2, 8)}`,
        role: 'tool',
        content: b.name,
        toolName: b.name,
        toolInput: b.input ? JSON.stringify(b.input, null, 2) : '',
        toolInputRaw: b.input ?? undefined,
        ts: baseTs,
        collapsed: true,
      });
    }
    // tool_result / 其他类型 block — 跳过, master 同款
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const items = ref<TranscriptItem[]>([]);
const loadingHistory = ref<boolean>(false);
const historyError = ref<string | null>(null);

/** 已渲染附件 id 去重 (master tdc.tsx:646 knownAttachmentIds 同款):
    上传路由 POST 会触发后端 SSE `attachment` 事件 (agent-runtime.ts:1359),
    loadHistory merge 也会插同一条 — 双路径都过这个 set 防重复.
    keep-alive 切 task 时 loadHistory 重建 items 的同时重建本 set. */
let knownAttachmentIds = new Set<string>();

/** R56-B8: 按 ts 二分插入到数组, 等时间戳 stable 追加在后面 (SDK 顺序保留).
   镜像 master src/app/tasks/[id]/insert-by-timestamp.ts: 没时间戳的 item
   排到末尾 (兜底 Number.MAX_SAFE_INTEGER, 跟 master R155 bug fix 一致).
   用于注入 task.prompt 到 fork 时间戳位置 — fork 会话继承父历史, prompt
   不能无脑 unshift, 否则会被继承的旧消息盖到下面. */
function insertByTimestamp(arr: TranscriptItem[], item: TranscriptItem): void {
  const ts = item.ts ?? Number.MAX_SAFE_INTEGER;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid].ts ?? Number.MAX_SAFE_INTEGER) <= ts) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
}

/** R56-B8: 注入 task.prompt 作为首条 user 消息 (master tdc.tsx:989-1006 同款).
   覆盖 SDK JSONL 还没 flush 新建 task 的初始 prompt 的 race, 也覆盖页面刷新
   后 SDK 历史已含 prompt 时的去重 (无 isPrompt 标记, SPA 没乐观消息, 直接
   text-match 去重). fork 会话按 forked_at 时间戳插入到继承历史中间 — 不用
   unshift 把用户指令埋到 fork 分隔线之上. */
function injectPromptIfMissing(): void {
  const prompt = props.parentPrompt;
  if (!prompt) return;
  if (items.value.some((it) => it.role === 'user' && it.content === prompt)) return;
  const forkMs = props.forkedAt ? parseDbTime(props.forkedAt)?.getTime() ?? 0 : 0;
  const promptItem: TranscriptItem = {
    id: `prompt-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: prompt,
    ts: forkMs || undefined,
    senderType: 'user',
  };
  if (forkMs) {
    const next = [...items.value];
    insertByTimestamp(next, promptItem);
    items.value = next;
  } else {
    items.value = [promptItem, ...items.value];
  }
}

/** SSE 连接状态 (R234 后续项收口到共享 hub): connecting = 首次连 / 重连中;
    connected = 已连; closed = 主动断开 (401 关停) 或全部消费者释放后回落 idle.
    state/retryCount 由 useTaskStream 的 reactive registry 提供, 与父
    TaskDetailView 共享同一条 /api/tasks/{id}/stream 长连接 (原先各开一条 =
    同页双倍占 HTTP/1.1 每域 6 个并发名额). R256: 无限重连 + 指数退避 (原 20
    次上限在隧道抖动 >60s 时把流打进 closed 永久停更); onReconnect → 重拉
    messages (ETag 304 零传输) 校准断线窗口内漏掉的 SSE 消息增量. */
const streamSub = createTaskStreamSubscription(
  () => (props.taskId ? `/api/tasks/${props.taskId}/stream` : ''),
  (e: TaskStreamEvent) => handleSseEvent(e),
  () => void loadHistory(),
);
const { state: connState, retryCount } = taskStreamState(
  () => (props.taskId ? `/api/tasks/${props.taskId}/stream` : ''),
);

/** 当前流式暂存的 assistant 文本. SSE stream_delta 累积到这里; 收到
    assistant_message 时清空并推正式条目. 独立 ref 而不是数组里的
    streaming:true 项, 简化"取最后一条"逻辑 (避免 items 反复变更触发
    auto-scroll 抖动). */
const streamingText = ref<string>('');

/** 自增 id 计数器, SSE 事件 id 兜底. */
let nextSseId = 0;

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 连接中 Spinner 是否显示. connecting 显示; connected / idle / closed
    不显示 (R20 红线: "连接中显示 Spinner"). */
const showSpinner = computed<boolean>(() => connState.value === 'connecting');

/** 连接状态文字 (调试用 + 给 sheet 反馈用). */
const connLabel = computed<string>(() => {
  switch (connState.value) {
    case 'idle': return '';
    case 'connecting': return retryCount.value > 0 ? `重连中 (${retryCount.value}/${MAX_RETRY_COUNT})…` : '连接中…';
    case 'connected': return '实时';
    case 'closed': return '已断开';
  }
});

/* ------------------------------------------------------------------ */
/*  B227 + B228: 搜索过滤 + Esc 清空 + × 按钮 (master tdc.tsx:2511-2539)  */
/* ------------------------------------------------------------------ */

/** R56-A3.4 (C4): searchQuery 现在由父级持有 (TaskStatusBar 🔍 toggle + 父级
    v-model), 本组件只负责过滤. */
const searchQuery = computed<string>({
  get: () => props.searchQuery,
  set: (v: string) => emit('update:searchQuery', v),
});

/** R56-A4.6: 先按 displayMode 过滤/展开, 再叠加 searchQuery. */
const baseItems = computed<TranscriptItem[]>(() => {
  let base: TranscriptItem[] = items.value;
  if (props.displayMode === 'text-only') {
    base = base.filter(
      (it) => it.role === 'user' || it.role === 'assistant',
    );
  }
  if (props.displayMode === 'expanded') {
    base = base.map((it) =>
      it.role === 'tool' && it.toolName && it.collapsed !== false
        ? { ...it, collapsed: false }
        : it,
    );
  }
  return base;
});

/** 过滤后的 items (不区分大小写 substring match on content). master
    tdc.tsx:825-852 useMemo 同款语义. 空 query → 直接返 baseItems (避免无意义
    rerender). */
const filteredItems = computed<TranscriptItem[]>(() => {
  const q = props.searchQuery.trim().toLowerCase();
  if (!q) return baseItems.value;
  return baseItems.value.filter((it) => {
    if (it.content.toLowerCase().includes(q)) return true;
    if (it.toolName && it.toolName.toLowerCase().includes(q)) return true;
    if (it.toolInput && it.toolInput.toLowerCase().includes(q)) return true;
    return false;
  });
});

const isFiltering = computed<boolean>(() => props.searchQuery.trim().length > 0);
const matchCount = computed<number>(() => filteredItems.value.length);

/** R56-B4: 用户手动 toggle 意图 (id → boolean, true=展开, false=折叠).
    之前用 Set<id> 表达"手动折叠覆盖" 语义, 但 item.collapsed 默认 true
    (折叠), 用户点 ▶ 想要展开 → 加入 set → 已经折叠 → 视觉无变化. 改成显式
    boolean map, effectiveCollapsed 优先读 map, 跟原 item.collapsed 无关. */
const userToggle = ref<Map<string, boolean>>(new Map());

function toggleToolCollapse(id: string): void {
  if (props.displayMode === 'text-only') return;
  const next = new Map(userToggle.value);
  // 翻转当前 effectiveCollapsed: 当前展开 → 折叠, 当前折叠 → 展开.
  // item.collapsed 默认 true (折叠), 所以无 userToggle 时视为折叠.
  const currentlyExpanded =
    next.has(id) ? next.get(id) === true
    : props.displayMode === 'expanded' ? true
    : false;
  next.set(id, !currentlyExpanded);
  userToggle.value = next;
}

function effectiveCollapsed(item: TranscriptItem): boolean {
  // R56-B4: userToggle 优先; 没动过 → 走 displayMode 默认 (expanded 全展开,
  // 其它走 item.collapsed 默认 true=折叠).
  if (userToggle.value.has(item.id)) {
    return userToggle.value.get(item.id) === false;
  }
  if (props.displayMode === 'expanded') return false;
  return item.collapsed !== false;
}

/** R56-A4.7: assistant / user 文本走 markdown 渲染 + 高亮 + 链接化.
    tool 文本走纯文本 (工具输入 JSON 直接 escape). */
function renderText(item: TranscriptItem): string {
  if (item.role === 'tool') return '';
  return renderTranscriptMessage(item.content, props.searchQuery, props.projectId);
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightPlain(s: string): string {
  if (!props.searchQuery.trim()) return escapeHtmlText(s);
  const q = props.searchQuery.trim();
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escapeHtmlText(s).replace(re, '<mark>$1</mark>');
}

/* R56-A3.5 (C5): 内联 ForkBoundary — master tdc.tsx:3160-3166 同款. 当
   prev.timestamp < forkMs AND current.timestamp >= forkMs 时, 在 current
   消息之前插入 ForkBoundary. */
const forkedAtMs = computed<number | null>(() => {
  if (!props.forkedAt) return null;
  // R205: forked_at 是 DB 裸 UTC 字符串, parseDbTime 显式补 Z (消息 ts 是
  // SDK ISO 时间, 基准要对齐, 否则 fork 分界线错位 8h).
  return parseDbTime(props.forkedAt)?.getTime() ?? null;
});

/** 给定消息索引 i, 返回 i-1 与 i 之间是否跨过了 forkMs 边界. */
function isForkBoundaryBefore(i: number): boolean {
  if (forkedAtMs.value == null) return false;
  if (i <= 0) return false;
  const prev = filteredItems.value[i - 1];
  const cur = filteredItems.value[i];
  if (!prev?.ts || !cur?.ts) return false;
  return prev.ts < forkedAtMs.value && cur.ts >= forkedAtMs.value;
}

/** R56-B2.3: needsSeparator — master tdc.tsx:3156 同款语义:
   prev 和 cur 一边 user 一边 assistant 时, 在 cur 之前插细横线
   (`border-t border-gray-200 my-2`). tool / warning / attachment /
   attachment_group 不参与 (master 也是只在 user/assistant 的 Fragment 顶部判断). */
function needsSeparatorBefore(i: number): boolean {
  if (i <= 0) return false;
  const prev = filteredItems.value[i - 1];
  const cur = filteredItems.value[i];
  if (!prev || !cur) return false;
  if (cur.role !== 'user' && cur.role !== 'assistant') return false;
  return prev.role !== cur.role;
}

/** Esc 清空 + 失焦 (master 同款语义: input 内 Esc 关闭搜索条). */
function onSearchKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    searchQuery.value = '';
    (e.target as HTMLInputElement).blur();
  }
}

/** × 按钮: 直接清空 query, 不动 focus. */
function clearSearch(): void {
  searchQuery.value = '';
}

/* ------------------------------------------------------------------ */
/*  B230: hover message 显示 ⑂ fork 按钮 + 打开 ForkModal                 */
/* ------------------------------------------------------------------ */

/** fork 模式. null = 未打开; 'message' = 从某条 message uuid fork
    (B230 当前唯一模式, 后续 'head'/'checkpoint' 留 R52+). */
const forkModalRef = ref<InstanceType<typeof ForkModal> | null>(null);
const forkOpen = ref<boolean>(false);

function onForkFromMessage(uuid: string): void {
  forkOpen.value = true;
  void nextTick(() => {
    forkModalRef.value?.prefillUpToMessageId(uuid);
  });
}

function onForkModalClose(): void {
  forkOpen.value = false;
}

function onForked(newTaskId: string): void {
  forkOpen.value = false;
  // 跳到新 task — 用 hash 路由 (#/tasks/<id>) + 全页 reload 简化处理.
  window.location.href = `#/tasks/${newTaskId}`;
}

/* ------------------------------------------------------------------ */
/*  Scroll                                                             */
/* ------------------------------------------------------------------ */

/** transcript 滚动容器 ref. auto-scroll 用 nextTick 拿到 DOM 后滚到底. */
const scrollEl = ref<HTMLElement | null>(null);

/** 用户是否在底部附近. 距底 < 80px 视为"在底部", 新消息自动滚底;
    否则保留滚动位置 + 不打断用户阅读 (master tdc.tsx:812-826 smart
    auto-scroll 同款). */
const NEAR_BOTTOM_PX = 80;
const isNearBottom = ref<boolean>(true);

/** R56-B1.9: 未读消息计数 (master tdc.tsx:632-664 同款). 用户在底部时
    新消息直接滚底 + 清零; 不在底部时 +1, 显示 "↓ N 条新消息" 浮窗. */
const unreadCount = ref<number>(0);

function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  // 用户主动滚到底 = 已读, 清零.
  if (isNearBottom.value && unreadCount.value > 0) {
    unreadCount.value = 0;
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/** R56-B1.9: 未读 badge 点击 = 滚底 + 清零 (master tdc.tsx:2650-2660 同款). */
async function scrollToBottomAndClear(): Promise<void> {
  await scrollToBottom();
  unreadCount.value = 0;
  isNearBottom.value = true;
}

/** R56-B1.7: tool_result 在 expanded 模式下不限高, 默认 max-h 32 (master
    tdc.tsx:3417-3431 同款). text-only / all 模式下截断 500 字符 + max-h-32. */
function displayExpanded(_item: TranscriptItem): boolean {
  return props.displayMode === 'expanded';
}

/** 监听 items / streamingText 变化 → 若用户在底部则滚底. watch 比
    computed effect 更直接, 避免手动调 scrollToBottom 的散点调用.
    注意: B227 引入 searchQuery 后, items 不再等于显示列表, 这里 watch
    只管原始 items / streaming 增删, 不影响过滤后视图滚到底的时机
    (master 同样在 isFiltering 时不滚底).
    R56-B1.9: 不在底部时改记 unreadCount, 不滚底打断用户阅读. */
let prevItemsLen = 0;
watch(
  [items, streamingText],
  ([newItems, newStream]) => {
    // 总长度变化 (新条目追加) 才计 unread. 同一 item 内部 streaming 累积不计数.
    if (newItems.length > prevItemsLen || newStream.length > 0) {
      if (!isNearBottom.value) {
        unreadCount.value += 1;
      } else {
        void scrollToBottom();
      }
    }
    prevItemsLen = newItems.length;
  },
  { deep: false },
);

/* ------------------------------------------------------------------ */
/*  History fetch                                                      */
/* ------------------------------------------------------------------ */

// 会话历史的 ETag 缓存 (模块级, keep-alive 重挂不丢): taskId → 上次 200 响应
// 的 ETag. 服务端指纹 = task.updated_at + session_id + MAX(events.id) (见
// messages route), 没变回 304 → 不再拉 282KB 全量 (2026-10-08 压测: messages
// 是详情页最大 payload, 公网隧道下 0.8~3.3s). 只在 SPA 会话内有效, 硬刷新
// 后自然 200 全量重建.
const historyEtagCache = new Map<string, string>();

// 本组件实例当前内存里装的是哪个 task 的消息 (keep-alive 跨 task 复用同一
// 实例, 切过任务后 items 是别的 task 的). 只有内存消息确实属于当前 task 时
// 才允许 304 沿用 —— 否则会把 A 任务的对话渲染在 B 任务页面上.
let lastLoadedTaskId = '';

async function loadHistory(): Promise<void> {
  loadingHistory.value = true;
  historyError.value = null;
  try {
    const sameTaskInMemory =
      lastLoadedTaskId === props.taskId && items.value.length > 0;
    const { changed, etag, data } = await getIfChanged<HistoryMessage[]>(
      `/api/tasks/${props.taskId}/messages`,
      sameTaskInMemory ? (historyEtagCache.get(props.taskId) ?? null) : null,
    );
    if (etag) historyEtagCache.set(props.taskId, etag);
    if (!changed || !data) {
      // 304: 服务端历史没变, 内存里就是这个 task 的消息 (含 SSE 增量), 沿用.
      lastLoadedTaskId = props.taskId;
      return;
    }
    const normalized: TranscriptItem[] = [];
    for (const m of data) {
      // R56-B3.1: assistant array content 可能展开成多条 (text + tool_use);
      // 其它类型走单条 normalize. expandHistoryItem 内部已处理跳过.
      const items = m.type === 'assistant' ? expandHistoryItem(m) : (() => {
        const single = normalizeHistoryItem(m);
        return single ? [single] : [];
      })();
      for (const it of items) normalized.push(it);
    }
    lastLoadedTaskId = props.taskId;
    // 🆕 修 2026-10-31 附件不显示 bug 之历史侧 (master tdc.tsx:994-1014 同款):
    //   历史上传不经 SSE 重放, 只有这里按 created_at 把 task-level attachments
    //   merge 进 timeline, 刷新后附件才显示. 同时重建去重 set (keep-alive 切
    //   task 时 items 全量换新, 旧 task 的 id 不能残留). best-effort — 拉不到
    //   不阻断历史渲染.
    try {
      const attRes = await fetch(`/api/tasks/${props.taskId}/attachments`);
      if (attRes.ok) {
        const body = await attRes.json() as {
          attachments?: Array<{
            id: string;
            filename: string;
            media_type: string;
            size_bytes: number;
            created_at: string;
          }>;
        };
        const atts = Array.isArray(body?.attachments) ? body.attachments : [];
        knownAttachmentIds = new Set(atts.map((a) => a.id));
        for (const a of atts) {
          const ts = parseDbTime(a.created_at)?.getTime() ?? Date.now();
          insertByTimestamp(normalized, {
            id: `att-${a.id}`,
            role: 'attachment',
            content: a.filename,
            attachment: { id: a.id, filename: a.filename, media_type: a.media_type, size_bytes: a.size_bytes },
            ts,
          });
        }
      }
    } catch {
      /* attachments best-effort */
    }
    items.value = normalized;
    // R56-B8: 注入 task.prompt 作为首条 user 消息, 覆盖 SDK JSONL 还没
    // flush 新建 task 初始 prompt 的 race. text-match 去重, fork 会话按
    // forked_at 时间戳插到继承历史中间.
    injectPromptIfMissing();
  } catch (e: unknown) {
    historyError.value = e instanceof Error ? e.message : '加载消息历史失败';
  } finally {
    loadingHistory.value = false;
    void scrollToBottom();
  }
}

/** R56-B8: parentPrompt 异步到达时 (TaskDetailView / chat 模式都是先拉 task
   详情再挂 transcript, 详情 fetch 完才传 prompt 进来) — 历史里缺首条 user
   消息就补上. 已有相同 text 时去重, 与 loadHistory 注入逻辑共用
   injectPromptIfMissing (text-match + fork 时间戳二分插入). */
watch(
  () => props.parentPrompt,
  (next, prev) => {
    if (!next || next === prev) return;
    injectPromptIfMissing();
  },
);

/* ------------------------------------------------------------------ */
/*  SSE connection                                                     */
/* ------------------------------------------------------------------ */

/* 连接的建立/重连/关停全部在 useTaskStream hub 内 (见上方 streamSub 定义),
   本组件只负责 attach/detach 时机 —— 原先 90 行手写 EventSource 管理
   (openStream/closeStream/scheduleReconnect/401 探测) 已随收口删除. */

/** 处理单个 SSE 事件. 仅消费 transcript 相关 type; 其他 (status_change
    / tool_approval_request 等) 静默忽略 — 这些归其他组件处理
    (TaskDetailView 头部 / R21 LifecycleActions / 未来的审批面板). */
function handleSseEvent(event: { type?: string; [k: string]: unknown }): void {
  switch (event.type) {
    case 'connected':
      // 服务端连接确认, no-op. onopen 已经把状态切到 connected.
      return;

    case 'stream_delta': {
      // 增量文本. 累积到 streamingText, UI 单独渲染这一条.
      const text = typeof event.text === 'string' ? event.text : '';
      streamingText.value += text;
      return;
    }

    case 'assistant_message': {
      // 完整 assistant 消息 — 清空流式暂存, 推正式条目.
      streamingText.value = '';
      const text = typeof event.text === 'string' ? event.text : '';
      const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
      const ts = uuidToTimestamp(uuid) ?? Date.now();
      items.value.push({
        id: uuid ?? `sse-${nextSseId++}`,
        role: 'assistant',
        content: text,
        ts,
      });
      return;
    }

    case 'tool_use': {
      streamingText.value = '';
      const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'tool';
      const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
      const ts = uuidToTimestamp(uuid) ?? Date.now();
      const toolInput = event.tool_input ? JSON.stringify(event.tool_input, null, 2) : '';
      items.value.push({
        id: uuid ?? `sse-${nextSseId++}`,
        role: 'tool',
        content: toolName,
        toolName,
        toolInput,
        toolInputRaw: (event.tool_input as Record<string, unknown> | undefined) ?? undefined,
        ts,
        collapsed: true,
      });
      return;
    }

    // 🆕 R55: 实时补全 tool_use 输入. backend content_block_start 先发
    //   空占位 tool_use (tool_input: {}), 完整 input 经 input_json_delta
    //   流式累积, 在 content_block_stop 时发 tool_use_update 推送真值.
    //   不监听此事件 = 实时只见 {} (跟 master tdc.tsx:1312-1323 同款
    //   "tool_use_update → 找原 tool_use 补 toolInput" 实现).
    case 'tool_use_update': {
      const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
      if (!uuid) return;
      const input = (event.tool_input && typeof event.tool_input === 'object')
        ? (event.tool_input as Record<string, unknown>)
        : undefined;
      // 不可变更新, 触发 Vue 响应式. 没匹配的 tool item 时 no-op (与
      // master setMessages map 语义一致: 找不到就跳过, 不创建新 item).
      let matched = false;
      items.value = items.value.map((it) => {
        if (it.role !== 'tool' || it.id !== uuid) return it;
        matched = true;
        return {
          ...it,
          toolInput: input ? JSON.stringify(input, null, 2) : '',
          toolInputRaw: input,
        };
      });
      // 兜底: tool_use_update 比 tool_use 先到 (罕见, SSE 重排 / 历史
      //   重放等场景) → 补一条 tool item, 后续 tool_use 走 stream_delta
      //   路径来的概率极低, 显式 id=uuid 保证去重.
      if (!matched) {
        const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'tool';
        const ts = uuidToTimestamp(uuid) ?? Date.now();
        items.value.push({
          id: uuid,
          role: 'tool',
          content: toolName,
          toolName,
          toolInput: input ? JSON.stringify(input, null, 2) : '',
          toolInputRaw: input,
          ts,
          collapsed: true,
        });
      }
      return;
    }

    case 'tool_result': {
      const result = typeof event.result === 'string' ? event.result : '';
      const toolName = typeof event.tool_name === 'string' ? event.tool_name : undefined;
      items.value.push({
        id: `sse-${nextSseId++}`,
        role: 'tool',
        content: result,
        toolName,
        ts: Date.now(),
      });
      return;
    }

    case 'user_message': {
      // R22+ 真实用户消息经 SSE 回传 (master handleEvent 同款).
      const text = typeof event.text === 'string' ? event.text : '';
      items.value.push({
        id: `sse-${nextSseId++}`,
        role: 'user',
        content: text,
        ts: Date.now(),
      });
      return;
    }

    // 🆕 修 2026-10-31 附件不显示 bug 之实时侧 (master tdc.tsx:1398-1408 同款):
    //   上传路由保存文件后后端 emit SSE attachment 事件 (agent-runtime.ts:1359),
    //   SPA 之前不消费 → 刚上传的图片不出现在消息流里. 按 knownAttachmentIds
    //   去重 (loadHistory merge 也会插同一条), 按当前时间二分插入.
    case 'attachment': {
      const a = event.attachment as {
        id: string;
        filename: string;
        media_type: string;
        size_bytes: number;
      } | undefined;
      if (!a || knownAttachmentIds.has(a.id)) return;
      knownAttachmentIds.add(a.id);
      const next = [...items.value];
      insertByTimestamp(next, {
        id: `att-${a.id}`,
        role: 'attachment',
        content: a.filename,
        attachment: a,
        ts: Date.now(),
      });
      items.value = next;
      void scrollToBottom();
      return;
    }

    case 'message': {
      // 🐛 R56 旧 bug: 后端 sendUserMessage 7 个分支 (live running / paused /
      // terminal auto-start / queued / closed-session / parent-notify / server
      // restart) 全部 emit `{type: "message", data: JSON.stringify({role, text,
      // sender_type, timestamp})}`, 但 SPA 这里之前只挂了 `user_message` 兜底
      // (从未触发), 导致发出去的消息不会立马出现在 transcript — 必须等 SDK
      // session JSONL 落库 + 下次 loadHistory 才能看到. master
      // task-detail-client.tsx:1421-1449 同款解析, 这里补齐.
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as {
          role?: string;
          text?: string;
          sender_type?: string;
          timestamp?: number | string;
          queued?: boolean;
        };
        if (parsed.role !== 'user') return;
        const text = parsed.text ?? '';
        if (!text || isSdkInternalContent(text)) return;
        const tsNum = typeof parsed.timestamp === 'number'
          ? parsed.timestamp
          : typeof parsed.timestamp === 'string'
            ? new Date(parsed.timestamp).getTime()
            : Date.now();
        // 去重: 同 text 已存在 (历史拉过 / SSE 重复推) → skip.
        if (items.value.some(
          (it) => it.role === 'user' && it.content === text,
        )) return;
        items.value.push({
          id: `sse-${nextSseId++}`,
          role: 'user',
          content: text,
          senderType: parsed.sender_type,
          ts: Number.isNaN(tsNum) ? Date.now() : tsNum,
        });
      } catch {
        /* ignore parse errors */
      }
      return;
    }

    // 历史 replay (master 在 SSE 打开时回放 events 表) — 历史已拉过,
    // 这里静默跳过, 避免重复渲染.
    case 'history':
      return;

    // status_change / tool_approval_request / 其他 — 不归本组件.
    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/* R75 fix: 切换 task 时父 view 通过 prop.taskId 传新 id, keep-alive 复用
   本组件实例不重 mount. 必须显式 watch taskId 重新拉历史 + 关旧 SSE 开新
   SSE. immediate=true 让首次进入也对得上 (避免 mount + watch 重复拉同
   一 taskId 的浪费). R234 后续项: 关/开流 = streamSub.attach (hub 内部
   自动迁移旧 url → 新 url). */
watch(
  () => props.taskId,
  () => {
    // R198 fix: 父 view 切到非 task 路由时 taskId 传空串, 不发请求不连 SSE.
    if (!props.taskId) return;
    streamSub.detach();
    void loadHistory().then(() => streamSub.attach());
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  streamSub.detach();
});

// R228: keep-alive 切走时关 SSE —— HTTP/1.1 直连 (内网 IP:13000) 每域只有
// 6 个并发名额, 后台 tab 的长连接不还会饿死所有 fetch, 发消息 POST 都发不
// 出去 (2026-10-09 实证接口全 pending). 切回 = 走上方 watch 同款路径 (重拉
// 历史 + 重开流), ETag 命中 304 时历史拉取代价可忽略.
let streamWasDeactivated = false;
onDeactivated(() => {
  streamWasDeactivated = true;
  streamSub.detach();
});
onActivated(() => {
  if (!streamWasDeactivated) return; // 首次 mount 的 onActivated 跳过 (watch immediate 已开)
  streamWasDeactivated = false;
  if (!props.taskId) return;
  streamSub.detach();
  void loadHistory().then(() => streamSub.attach());
});
</script>

<template>
  <!-- R56-B1.1: 去掉 transcript-card + header — master tdc.tsx:2544 同款
       flex-1 直接撑满主列, 无 card chrome + 无独立 header. 主列里的
       TaskStatusBar 头部已带连接状态. 保留 .transcript-scroll 容器实现
       smart auto-scroll + unread badge. -->
  <div
    ref="scrollEl"
    class="transcript-scroll"
    @scroll="onScroll"
  >
    <!-- R256: 连接状态横幅 — SSE 断线时用户必须能看见, 否则「实时流停了但
         页面照常渲染」看起来像任务卡住. 重连中显示退避次数 (与 retryCount
         联动), 已断开 (401 关停) 常驻提示. connected 不渲染 (不打扰). -->
    <div v-if="connState === 'connecting' && retryCount > 0" class="conn-banner conn-connecting">
      ⚡ 实时流重连中 ({{ retryCount }})… 消息可能有延迟
    </div>
    <div v-else-if="connState === 'closed'" class="conn-banner conn-closed">
      ✕ 实时流已断开 — 显示的可能不是最新状态, 刷新页面重连
    </div>

    <!-- R56-A3.4 (C4): 搜索条由父级 TaskStatusBar 🔍 控制显示; searchOpen=true
         才渲染输入框. Esc 清空 + × 按钮语义保留 (master tdc.tsx:2511-2539).
         搜索条 sticky 在 scroll 顶部, 不随消息流消失. -->
    <div v-if="searchOpen" class="search-bar">
      <input
        :value="searchQuery"
        type="text"
        class="search-input"
        placeholder="搜索消息..."
        @input="(e: Event) => (searchQuery = (e.target as HTMLInputElement).value)"
        @keydown="onSearchKeyDown"
      />
      <span v-if="isFiltering" class="search-count">{{ matchCount }} 个匹配</span>
      <button
        v-if="searchQuery"
        type="button"
        class="search-clear"
        title="清空搜索"
        @click="clearSearch"
      >×</button>
    </div>

    <div v-if="loadingHistory && items.length === 0" class="state-block">
      <Loading size="md" label="加载消息历史" />
      <p class="state-text muted">加载历史消息…</p>
    </div>

    <p v-else-if="historyError" class="error-text">{{ historyError }}</p>

    <div v-else class="transcript-body">
      <!-- R56-B2.4: master tdc.tsx:2571-2591 同款 — 当 messages 还没到
           (后端一次性 fetch 没回来), 但 task.result 或 task.error 已存在
           (失败任务 / 短任务) 时, 直接渲染结果 markdown, 不让用户看到白屏.
           这两条分支在 messages 来之前只会触发一次, SSE 来之后这条隐藏. -->
      <div
        v-if="items.length === 0 && !streamingText && (taskResult || taskError)"
        class="result-preview"
      >
        <div v-if="taskError" class="result-preview-error">
          <span aria-hidden="true">⚠️</span>
          <span>{{ taskError }}</span>
        </div>
        <div v-if="taskResult" class="result-preview-result">
          <div class="result-preview-header">
            <span class="result-preview-icon" aria-hidden="true">🤖</span>
            <span class="result-preview-label">Agent 输出</span>
          </div>
          <div
            class="result-preview-body markdown-body"
            v-html="renderTranscriptMessage(taskResult, '', props.projectId)"
          />
        </div>
      </div>

      <div v-else-if="items.length === 0 && !streamingText" class="empty-block">
        <p class="empty-text muted">暂无消息</p>
      </div>

      <div
        v-else-if="isFiltering && filteredItems.length === 0"
        class="empty-block"
      >
        <p class="empty-text muted">没有匹配的消息</p>
      </div>

      <ol v-else class="message-list">
        <li
          v-for="(item, i) in filteredItems"
          :key="item.id"
          class="message-item"
          :class="`role-${item.role}`"
        >
          <!-- R56-B2.3: needsSeparator (master tdc.tsx:3156 同款) —
               相邻 user ↔ assistant 时在上一条底部插细横线, 视觉分组. -->
          <div v-if="needsSeparatorBefore(i)" class="msg-separator" />
          <!-- R56-A3.5 (C5): 内联 ForkBoundary (master tdc.tsx:3289 同款,
               跨过 forked_at 时间戳时插在 prev 与 current 之间). -->
          <MessageForkBoundary
            v-if="isForkBoundaryBefore(i)"
            :parent-task="parentTask"
          />
          <!-- R56-B1.6: warning 居中卡片 (master tdc.tsx:3168-3175 同款 amber-50). -->
          <template v-if="item.role === 'warning'">
            <div class="msg-warning">
              <span class="msg-warning-icon">⚠️</span>
              <span class="msg-warning-text">{{ item.content }}</span>
            </div>
          </template>
          <!-- R56-B1.3: attachment 单条 + 内联 image/video/audio 预览
               (master tdc.tsx:3177-3234 同款). -->
          <template v-else-if="item.role === 'attachment' && item.attachment">
            <div class="msg-attachment">
              <div class="msg-attachment-header">
                <span class="msg-attachment-icon" aria-hidden="true">
                  {{ item.attachment.media_type.startsWith('image/') ? '🖼️'
                     : item.attachment.media_type.startsWith('video/') ? '🎬'
                     : item.attachment.media_type.startsWith('audio/') ? '🎵'
                     : '📄' }}
                </span>
                <a
                  :href="`/api/attachments/${item.attachment.id}`"
                  target="_blank"
                  rel="noreferrer"
                  class="msg-attachment-name"
                  :title="item.attachment.filename"
                >{{ item.attachment.filename }}</a>
                <span class="msg-attachment-size">{{ formatSize(item.attachment.size_bytes) }}</span>
              </div>
              <a
                v-if="item.attachment.media_type.startsWith('image/')"
                :href="`/api/attachments/${item.attachment.id}`"
                target="_blank"
                rel="noreferrer"
                class="msg-attachment-preview"
              >
                <img
                  :src="`/api/attachments/${item.attachment.id}`"
                  :alt="item.attachment.filename"
                  loading="lazy"
                  class="msg-attachment-img"
                />
              </a>
              <video
                v-else-if="item.attachment.media_type.startsWith('video/')"
                controls
                preload="metadata"
                :src="`/api/attachments/${item.attachment.id}`"
                class="msg-attachment-media"
              />
              <audio
                v-else-if="item.attachment.media_type.startsWith('audio/')"
                controls
                preload="metadata"
                :src="`/api/attachments/${item.attachment.id}`"
                class="msg-attachment-audio"
              />
            </div>
          </template>
          <!-- R56-B1.4: attachment_group 网格 (master tdc.tsx:3236-3273 同款). -->
          <template v-else-if="item.role === 'attachment_group' && item.attachments">
            <div class="msg-attachment-group">
              <div class="msg-attachment-group-title">
                <span>📎</span>
                <span>{{ item.attachments.length }} 个附件</span>
              </div>
              <div class="msg-attachment-grid">
                <a
                  v-for="a in item.attachments"
                  :key="a.id"
                  :href="`/api/attachments/${a.id}`"
                  target="_blank"
                  rel="noreferrer"
                  class="msg-attachment-tile"
                  :title="a.filename"
                >
                  <img
                    v-if="a.media_type.startsWith('image/')"
                    :src="`/api/attachments/${a.id}`"
                    :alt="a.filename"
                    class="msg-attachment-tile-img"
                  />
                  <div v-else class="msg-attachment-tile-icon">📄</div>
                  <div class="msg-attachment-tile-name">{{ a.filename }}</div>
                </a>
              </div>
            </div>
          </template>
          <!-- R56-B1.5 / R56-B4: 消息渲染入口.
               - user / assistant 走 meta + content 一起包在 .message-bubble 里
                 (master tdc.tsx:3297 + 3319 同款 — sender header 写在气泡顶部).
               - tool 不渲染 meta (R56-B4.7: 之前 tool 也走 meta, 导致 meta 行
                 跟 tool-card 重复显示 '🔧 Bash' / '🔧 Write' + 时间戳, 每条
                 tool 都占 2 行. tool-card 自己的 header (▶ + name + desc +
                 time) 已经够, 去掉 meta 行变单行). tool 也不包 message-bubble
                 (透明壳多余), 直接挂 .tool-card / .tool-result-card 在 li 下. -->
          <template v-if="item.role === 'user' || item.role === 'assistant'">
            <div
              class="message-bubble"
              :class="`role-${item.role}`"
            >
              <div class="message-meta">
                <span class="message-role" :class="[`role-tag-${item.role}`, item.senderType ? `sender-${item.senderType}` : '']">
                  <template v-if="item.role === 'user'">
                    {{ senderBadge(item.senderType).icon }} <span class="msg-sender-label">{{ senderBadge(item.senderType).label }}</span>
                  </template>
                  <template v-else>
                    🤖 <span class="msg-sender-label">助手</span>
                  </template>
                </span>
                <span class="message-time mono">{{ formatTimestampLabel(item.ts, filteredItems[i - 1]?.ts) }}</span>
                <!-- B230: assistant 消息有真 uuid 时显示 ⑂ fork 按钮 (hover-only).
                     user 消息 uuid 不可靠 (本地追加), master tdc.tsx:3319-3321 同款隐藏. -->
                <button
                  v-if="item.role === 'assistant' && item.id && !item.id.startsWith('sse-')"
                  type="button"
                  class="msg-fork-btn"
                  title="从这条消息 fork：新任务继承到此为止的历史"
                  @click="onForkFromMessage(item.id)"
                >⑂ fork</button>
              </div>
              <!-- R56-B1.8: assistant 走 prose-sm markdown; user 走白底.
                   v-html 由 markdown-it 内部 escape 处理 + 我们的 linkify 限制白名单,
                   信任边界 = 后端 chat 流 (agent 输出). -->
              <div
                class="message-content"
                :class="{ 'user-bubble': item.role === 'user', 'assistant-bubble': item.role === 'assistant', 'markdown-body': item.role === 'assistant' }"
                v-html="renderText(item)"
              />
            </div>
          </template>
          <!-- R56-B1.7: tool_result 走绿色 ✅ 卡片 (master tdc.tsx:3417-3431 同款). -->
          <template v-else-if="item.role === 'tool' && !item.toolName">
            <div class="tool-result-card">
              <div class="tool-result-header">
                <span class="tool-result-icon">✅</span>
                <span class="tool-result-name">{{ 'tool_result' }}</span>
                <span class="msg-time mono">{{ formatTimestampLabel(item.ts, filteredItems[i - 1]?.ts) }}</span>
              </div>
              <pre
                v-if="item.content"
                class="tool-result-body"
                :class="{ 'tool-result-body-collapsed': item.content.length > 500 && !displayExpanded(item) }"
              >{{ item.content.length > 500 && !displayExpanded(item)
                    ? item.content.slice(0, 500) + '...'
                    : item.content }}</pre>
            </div>
          </template>
          <!-- R56-A4.7 / R56-B1.7: tool_use 折叠卡片 (master tdc.tsx:3379-3426
               同款 amber 底色). R56-B4.7: 直接挂 li 下, 不再走 message-bubble
               透明壳 (省一层嵌套, 折叠态保持单行). -->
          <template v-else-if="item.role === 'tool'">
            <div class="tool-card">
              <button
                type="button"
                class="tool-card-header"
                @click="toggleToolCollapse(item.id)"
              >
                <span class="tool-card-caret">{{ effectiveCollapsed(item) ? '▶' : '▼' }}</span>
                <span class="tool-card-icon" aria-hidden="true">{{ toolIcon(item.toolName) }}</span>
                <span class="tool-card-name">{{ item.toolName || 'tool' }}</span>
                <span v-if="effectiveCollapsed(item) && toolCollapsedSummary(item.toolName, item.toolInputRaw)" class="tool-card-summary">{{ toolCollapsedSummary(item.toolName, item.toolInputRaw) }}</span>
                <span v-if="!effectiveCollapsed(item)" class="tool-card-hint">点击折叠</span>
                <span class="tool-card-time mono">{{ formatTimestampLabel(item.ts, filteredItems[i - 1]?.ts) }}</span>
              </button>
              <pre
                v-if="!effectiveCollapsed(item) && item.toolInput"
                class="tool-card-body"
                v-html="highlightPlain(item.toolInput)"
              />
            </div>
          </template>
        </li>

        <!-- 流式暂存 (SSE stream_delta 累积) — master tdc.tsx:2633-2639 同款蓝底 + 闪烁. -->
        <li v-if="streamingText" class="message-item role-assistant streaming">
          <div class="message-meta">
            <span class="message-role role-tag-assistant">🤖 <span class="msg-sender-label">助手</span></span>
            <span class="message-time mono">{{ formatTimestamp(Date.now()) }}</span>
            <span class="streaming-dot">●</span>
          </div>
          <pre class="message-content assistant-bubble streaming-bubble mono">{{ streamingText }}</pre>
        </li>

        <!-- R56-B1.9: 未读消息徽章 (master tdc.tsx:2646-2667 sticky bottom).
             用户滚到上方 + 新消息进来时显示 "↓ N 条新消息" 浮窗. -->
        <li v-if="unreadCount > 0" class="unread-badge-row">
          <button
            type="button"
            class="unread-badge"
            @click="scrollToBottomAndClear"
          >↓ {{ unreadCount }} 条新消息</button>
        </li>
      </ol>
    </div>

    <!-- B230: ForkModal — 仅 forkOpen=true 时渲染, 自然关闭走 emit close. -->
    <ForkModal
      v-if="forkOpen"
      ref="forkModalRef"
      :task-id="taskId"
      :parent-title="parentTitle"
      :parent-prompt="parentPrompt"
      :parent-max-turns="parentMaxTurns"
      :context-tokens="contextTokens"
      :compact-threshold="180000"
      @close="onForkModalClose"
      @forked="onForked"
    />
  </div>
</template>

<style scoped>
/* R56-B1.1: transcript-scroll 改成主列的 flex 子项 (master tdc.tsx:2544
   `flex-1 min-h-0 overflow-y-auto` 同款), 撑满父级 main-col 剩余高度.
   不再 .transcript-card + .card 双层 chrome — master 主列直接是滚动容器,
   无 border/radius/box-shadow, 视觉更轻. */
.transcript-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  position: relative;
  background: var(--color-bg);
  padding: 12px 14px;
}

.transcript-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* R56-B1.1: 旧的 transcript-card / transcript-header / section-title /
   conn-status / state-block 标签保留作为 fallback (子模板不再引用),
   但不再渲染 — 删去以避免遗留. */

.conn-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.conn-label {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}

.conn-connecting { color: var(--tw-sky-700); }
.conn-connected  { color: var(--tw-emerald-700); }
.conn-closed     { color: var(--tw-red-800); }
.conn-idle       { color: var(--color-text-muted); }

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
}

.state-text {
  margin: 0;
  font-size: 13px;
}

.error-text {
  margin: 0;
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--tw-red-800);
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  border-radius: var(--radius);
}

.empty-block {
  padding: 24px 16px;
  text-align: center;
}

.empty-text {
  margin: 0;
  font-size: 13px;
}

/* R56-B2.4: master tdc.tsx:2571-2591 同款 — 没有 messages 时也能看到
   task.result (markdown) 和 task.error (红条). 复用 .markdown-body 全局
   样式 (与 assistant 消息一致), 视觉统一. */
.result-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.result-preview-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  background: var(--tw-red-50);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13px;
  color: var(--tw-red-800);
  word-break: break-word;
}
.result-preview-result {
  background: var(--tw-blue-50);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13px;
  color: var(--tw-gray-700);
  word-break: break-word;
}
.result-preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.result-preview-icon {
  color: var(--tw-blue-500);
  font-size: 12px;
}
.result-preview-label {
  color: var(--color-text-muted);
  font-size: 11.5px;
}
.result-preview-body {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: normal;
  word-break: break-word;
}

.message-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.message-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* R56-B4: chat 风格对齐 — message-item 是 flex column, cross axis 是水平,
   所以用 align-items 控制左右 (justify-content 在 column 里是垂直对齐).
   user / script / system 右对齐, assistant / tool 左对齐, warning / attachment
   居中. children 内部 (气泡 / msg-separator) 通过 max-width 控制宽度. */
.message-item.role-user,
.message-item.role-script,
.message-item.role-system {
  align-items: flex-end;
}
.message-item.role-assistant,
.message-item.role-tool {
  align-items: flex-start;
}
.message-item.role-warning,
.message-item.role-attachment,
.message-item.role-attachment_group {
  align-items: center;
}

/* R56-B4: 统一消息气泡容器 — master tdc.tsx 把 sender header + content 都包在
   同一个 rounded div 里, 视觉上 meta + 主体不可分割. 按 role 选背景.
   R56-B4.7: damo '直接消息等长' 反馈, 全部消息同宽 90% (不再 shrink-to-content,
   长 user 消息也不会被压成窄条). */
.message-bubble {
  border-radius: var(--radius-md);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--tw-gray-700);
  width: 90%;
  max-width: 90%;
  min-width: 60px;
  border: 1px solid transparent;
  box-sizing: border-box;
  /* R56-B15: 防止 markdown 长内容把气泡撑爆 + 推外层 .transcript-scroll 横滚.
     - min-width: 0 让 flex item 能缩到比内容窄
     - word-break: break-word + overflow-wrap: anywhere !important 字符级断行
       (curl URL / 长 hash 都折回 bubble 内, 不再 clip 出 bubble 边界外不可见)
     - max-width: 100% 兜底 box 不要溢出父
     R56-B14 加的 overflow-x: hidden 把超长文本藏掉看不见, 移除 — 用户反馈
     "文字出去了, 看不到被隐藏掉" — 强制折行才是正路, 不要 clip. */
  min-width: 0;
  word-break: break-word;
  overflow-wrap: anywhere !important;
  max-width: 100%;
}
.message-bubble.role-user {
  background: var(--tw-gray-100);
  border-color: var(--tw-gray-200);
  /* R56 反馈: user 消息末尾 \n 在 .message-content pre-wrap 下撑出一行空行.
     user 是 plain text 不像 assistant 走 markdown 需要保留 \n, 改 white-space:
     normal 折叠尾部 / 中间空白 + 单词断行. */
  white-space: normal;
  word-break: break-word;
}
.message-bubble.role-assistant {
  background: var(--tw-blue-50);
  border-color: var(--tw-blue-100);
}
/* tool_use / tool_result 内部自己带颜色卡片 (tool-card amber / tool-result-card
   green), 外层 .message-bubble 在 tool 角色保持透明无边框, 让内层卡片透出来. */
.message-bubble.role-tool {
  background: transparent;
  border: 0;
  padding: 0;
}

/* R56-B2.3: needsSeparator 分隔线 (master tdc.tsx:3156 + 3288/3310 同款,
   `border-t border-gray-200 my-2`). 在 message-item flex 列顶插入, 不被
   message-item gap / padding 干扰. */
.msg-separator {
  height: 0;
  border-top: 1px solid var(--tw-gray-200);
  margin: 6px 0;
}

/* R56-B1.6: warning 卡片 (master tdc.tsx:3168-3175 amber-50 + 居中). */
.msg-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: center;
  max-width: 560px;
  background: var(--tw-amber-50);
  border: 1px solid var(--tw-amber-300);
  border-radius: var(--radius);
  padding: 6px 12px;
  font-size: 12.5px;
  color: var(--tw-amber-800);
}
.msg-warning-icon { font-size: 14px; }
.msg-warning-text { flex: 1; word-break: break-word; }

/* R56-B1.3: attachment 卡片 (master tdc.tsx:3177-3234 gray-50 + 内联预览). */
.msg-attachment {
  align-self: center;
  max-width: 560px;
  background: var(--tw-gray-50);
  border: 1px solid var(--tw-gray-200);
  border-radius: var(--radius);
  padding: 8px;
  font-size: 12px;
  color: var(--tw-gray-600);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.msg-attachment-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.msg-attachment-icon {
  font-size: 16px;
  flex-shrink: 0;
}
.msg-attachment-name {
  flex: 1;
  min-width: 0;
  color: var(--tw-gray-700);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-attachment-name:hover {
  text-decoration: underline;
  color: var(--tw-blue-700);
}
.msg-attachment-size {
  color: var(--tw-gray-400);
  font-size: 11px;
  flex-shrink: 0;
}
.msg-attachment-preview {
  display: block;
  margin-top: 4px;
}
.msg-attachment-img {
  max-width: 100%;
  max-height: 480px;
  object-fit: contain;
  border-radius: var(--radius);
  background: var(--tw-gray-100);
  margin: 0 auto;
  display: block;
}
.msg-attachment-media {
  max-width: 100%;
  max-height: 480px;
  border-radius: var(--radius);
  background: var(--tw-gray-100);
  margin-top: 4px;
  display: block;
}
.msg-attachment-audio {
  width: 100%;
  margin-top: 4px;
}

/* R56-B1.4: attachment_group 网格 (master tdc.tsx:3236-3273 同款). */
.msg-attachment-group {
  align-self: center;
  max-width: 480px;
  background: var(--tw-gray-50);
  border: 1px solid var(--tw-gray-200);
  border-radius: var(--radius);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.msg-attachment-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--tw-gray-500);
}
.msg-attachment-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
@media (min-width: 640px) {
  .msg-attachment-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.msg-attachment-tile {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-gray-200);
  border-radius: var(--radius);
  padding: 4px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s;
}
.msg-attachment-tile:hover {
  border-color: var(--tw-blue-400);
}
.msg-attachment-tile-img {
  width: 100%;
  height: 64px;
  object-fit: cover;
  border-radius: 2px;
}
.msg-attachment-tile-icon {
  width: 100%;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  background: var(--tw-gray-100);
  border-radius: 2px;
}
.msg-attachment-tile-name {
  font-size: 10px;
  color: var(--tw-gray-600);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  /* R56-B4: meta 行跟 content 分隔, master tdc.tsx 把 sender header 写在气泡顶部
     跟 content 之间留 mb-1 间距. 这里用 bottom border 区分 (line mb-1 视觉同款). */
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  justify-content: space-between;
}

.message-role {
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.msg-sender-label {
  font-weight: 500;
}

/* R56-B1.5: user/assistant/tool role 标签颜色. */
.role-tag-user      { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.role-tag-assistant { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.role-tag-tool      { background: var(--tw-purple-100); color: var(--tw-purple-800); }

/* R56-B1.5: sender 三态配色 (master tdc.tsx:3281-3284 同款). */
.sender-user    { color: var(--tw-gray-600); }
.sender-script  { color: var(--tw-orange-600); }
.sender-system  { color: var(--tw-violet-600); }

.message-time {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* R56-B1.8 / R56-B4: 气泡背景 / 圆角 / padding / 边框都搬到 .message-bubble 上,
   user-bubble / assistant-bubble 只留 prose 类 markdown-body 样式.
   master tdc.tsx:3290 + 3312 同款 (bg-gray-100 / bg-blue-50 / rounded-lg / p-3).
   R56-B16: user 消息 v-html 渲染用户粘贴的原始 HTML (含 <pre><code>), 也得走
   pre 横向滚动 + max-width: 100% 兜底, 否则长 curl 命令撑出气泡. */
.user-bubble,
.assistant-bubble {
  word-break: break-word;
  min-width: 0;
}
.user-bubble :deep(pre),
.assistant-bubble :deep(pre) {
  background: var(--tw-gray-800);
  color: var(--tw-gray-100);
  padding: 8px 10px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 11.5px;
  white-space: pre;
  max-width: 100% !important;
  box-sizing: border-box !important;
  display: block !important;
}
.user-bubble :deep(pre code),
.assistant-bubble :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  display: block !important;
  white-space: pre;
  font-family: inherit;
}
.streaming-bubble {
  background: var(--tw-blue-50);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  margin: 0;
  word-break: break-word;
}

.message-content {
  margin: 0;
  padding: 0;
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: transparent;
  border: none;
  color: var(--color-text);
}

/* R56 反馈: user 消息末尾 \n 被 .message-content pre-wrap 渲染成一行.
   user 是 plain text 不像 assistant 走 markdown 需要保留 \n, 在 .user-bubble
   上覆盖 white-space: normal 折叠. 中间换行也折叠, 副作用 user 不像
   assistant 经常贴代码块. */
.message-content.user-bubble {
  white-space: normal;
}

/* R56-A4.7: markdown 渲染 (master tdc.tsx:3335 同款 prose-sm). 块级元素 reset
   默认 margin, 行内 code 蓝底, pre 黑底, mark 黄底 (highlight 注入).
   R56-B12/13: max-width: 100% + word-break 让 table / 长 URL 不撑爆父
   .message-bubble. table / pre 自身 overflow-x: auto 横向滚, 不外溢. */
.markdown-body {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: normal;
  word-break: break-word;
  max-width: 100%;
}
.markdown-body :deep(p),
.markdown-body :deep(ul),
.markdown-body :deep(ol),
.markdown-body :deep(blockquote),
.markdown-body :deep(pre) {
  margin: 0 0 6px;
}
.markdown-body :deep(p:last-child),
.markdown-body :deep(ul:last-child),
.markdown-body :deep(ol:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 8px 0 4px;
  font-weight: 600;
  font-family: inherit;
  font-size: 1.05em;
}
.markdown-body :deep(pre) {
  background: var(--tw-gray-800);
  color: var(--tw-gray-100);
  padding: 8px 10px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 11.5px;
  white-space: pre;
  /* R56-B16: pre 严格不超出父 .message-bubble (max-width: 90%). 多个 max-width:
     100% + box-sizing: border-box + display: block 兜底, 防 inline 行为让 pre
     跟着 <code> 内容撑开. 长 curl 命令在 pre 内部横向滚 (overflow-x: auto). */
  max-width: 100% !important;
  box-sizing: border-box !important;
  display: block !important;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  /* R56-B16: code 显式 block + 不强制断行, 让 pre 的 overflow-x: auto + white-space:
     pre 处理长行 (curl 命令在 pre 内部横向滚, 代码格式保留). display: block
     防 code 行内行为让 pre 跟着内容撑开. */
  display: block !important;
  white-space: pre;
  font-family: inherit;
}
.markdown-body :deep(code) {
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11.5px;
}
.markdown-body :deep(a) {
  color: var(--tw-blue-600);
  text-decoration: none;
}
.markdown-body :deep(a):hover {
  text-decoration: underline;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 20px;
}
.markdown-body :deep(li) {
  margin: 2px 0;
}
.markdown-body :deep(mark) {
  background: var(--tw-amber-100);
  border-radius: 2px;
  padding: 0 2px;
}
.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}
/* R56-B12: table 默认会按内容撑开, 把气泡撑爆. 修 2026-11-01 表格挤扁:
   原 width:100% + td break-word 在中文场景下任意字符可断 + 列无下限,
   多列/长内容表格被压成竖条(列 34px 行高 77px 且永不触发滚动).
   改 max-content + min-width:100%: 窄表格撑满气泡, 宽表格横向滚动;
   td nowrap 保持列宽 = 内容自然宽(实测 8 列 400px 容器: 行高 77px→26px).
   超长单元格(长句/URL)代价 = 表格变宽横向滚, 信息完整, 优于挤扁. */
.markdown-body :deep(table) {
  width: max-content;
  min-width: 100%;
  max-width: 100%;
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 12px;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--tw-gray-200);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
}
.markdown-body :deep(th) {
  background: var(--tw-gray-100);
  font-weight: 600;
}
/* R56-B12: blockquote / hr 等块级元素也别撑出气泡. */
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--tw-gray-300);
  padding-left: 8px;
  color: var(--tw-gray-500);
  max-width: 100%;
}
.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--tw-gray-200);
  margin: 8px 0;
}
.markdown-body :deep(strong) {
  font-weight: 600;
}

/* R56-A4.6 / R56-B1.7: tool_use 折叠卡片 (master tdc.tsx:3384 同款 amber 底色). */
.tool-card {
  border: 1px solid var(--tw-amber-200);
  background: var(--tw-amber-50);
  border-radius: 4px;
  font-size: 12px;
  overflow: hidden;
  /* R56-B4.7: damo '别 100%, 90%' — 跟 message-bubble 对齐 90%, 全部消息
     等宽. tool 不再嵌在 message-bubble 透明壳里 (template 直接挂 li 下),
     自己的 max-width = 90% of container. */
  width: 90%;
  max-width: 90%;
  box-sizing: border-box;
}
.tool-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.tool-card-header:hover {
  background: var(--tw-amber-100);
}
.tool-card-caret {
  color: var(--tw-amber-700);
  font-size: 10px;
  flex-shrink: 0;
}
.tool-card-name {
  font-weight: 500;
  color: var(--tw-amber-800);
  /* 2026-10-06 damo 手机反馈: mcp__chrome-devtools__emulate 这类长工具名
     flex-shrink: 0 永不收缩 → 右侧描述被挤成 1-2 字符窄条. 去掉 shrink:0 +
     允许 anywhere 断行, 长名在窄屏折行, 描述恢复可读宽度. */
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.tool-card-icon {
  flex-shrink: 0;
  font-size: 13px;
  line-height: 1;
}
.tool-card-summary {
  color: var(--tw-gray-600);
  font-size: 11.5px;
  /* R56-B4.6.1: damo 反馈 '都显示不全 desc'. 之前 white-space: nowrap 强制单行,
     CSS 截断长 description 看不到全文. 改成允许 wrap, 折叠态摘要可占多行,
     description 一次性展示完整; command / file_path 等短文本自然也是单行. */
  word-break: break-word;
  overflow-wrap: anywhere;
  min-width: 0;
  flex: 1;
  line-height: 1.4;
}
.tool-card-hint {
  color: var(--tw-gray-400);
  font-size: 11px;
  flex: 1;
  text-align: right;
  padding-right: 4px;
}
.tool-card-time {
  color: var(--tw-gray-400);
  font-size: 11px;
  flex-shrink: 0;
}
.tool-card-body {
  margin: 0;
  padding: 8px 10px;
  border-top: 1px dashed var(--tw-amber-200);
  background: var(--color-bg-elevated);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--tw-gray-600);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-x: auto;
}

/* R56-B1.7: tool_result 卡片 (master tdc.tsx:3417-3431 green-50 + ✅). */
.tool-result-card {
  border: 1px solid var(--tw-green-200);
  background: var(--tw-green-50);
  border-radius: 4px;
  font-size: 12px;
  overflow: hidden;
  /* R56-B4.7: 同 tool-card, 全部消息 90% 等宽. */
  width: 90%;
  max-width: 90%;
  box-sizing: border-box;
}
.tool-result-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  color: var(--tw-green-700);
}
.tool-result-icon {
  font-size: 12px;
  flex-shrink: 0;
}
.tool-result-name {
  font-weight: 500;
  color: var(--tw-green-700);
  flex: 1;
  font-size: 11.5px;
}
.tool-result-body {
  margin: 0;
  padding: 0 10px 8px;
  font-size: 11px;
  color: var(--tw-gray-600);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.tool-result-body-collapsed {
  max-height: 128px;
  overflow: hidden auto;
}

.tool-content {
  color: var(--tw-violet-800);
}

.streaming-dot {
  color: var(--tw-sky-700);
  font-size: 10px;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}

.msg-fork-btn {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 6px;
  border: 1px solid var(--tw-blue-200);
  background: var(--color-bg-elevated);
  color: var(--tw-blue-700);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.message-item:hover .msg-fork-btn {
  opacity: 1;
}
.msg-fork-btn:hover {
  background: var(--tw-blue-100);
}

/* R56-B1.9: 未读消息徽章 sticky bottom (master tdc.tsx:2646-2667). */
.unread-badge-row {
  position: sticky;
  bottom: 8px;
  display: flex;
  justify-content: center;
  pointer-events: none;
  list-style: none;
  margin: 0;
  padding: 0;
}
.unread-badge {
  pointer-events: auto;
  background: var(--tw-blue-600-solid);
  color: white;
  font-size: 11.5px;
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
  transition: background 0.15s;
}
.unread-badge:hover {
  background: var(--tw-blue-700-solid);
}

.muted {
  color: var(--color-text-muted);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* B227/B228 search bar — sticky 顶部, 不随消息流消失. */
/* R256: SSE 连接状态横幅 — 断线可见性. sticky 顶部与 search-bar 同位分层,
   不随消息流滚走. */
.conn-banner {
  position: sticky;
  top: 0;
  z-index: 6;
  font-size: 12px;
  padding: 5px 10px;
  margin: -12px -14px 8px;
  text-align: center;
}
.conn-connecting {
  color: #92610a;
  background: #fff7e0;
  border-bottom: 1px solid #f0d9a8;
}
.conn-closed {
  color: #a12622;
  background: #fdeceb;
  border-bottom: 1px solid #f5c6c4;
}
@media (prefers-color-scheme: dark) {
  .conn-connecting {
    color: #e6a817;
    background: #2d2410;
    border-bottom-color: #4a3a15;
  }
  .conn-closed {
    color: #f28b82;
    background: #2d1615;
    border-bottom-color: #5c2a27;
  }
}

.search-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin: -12px -14px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
}
.search-input {
  flex: 1;
  font-size: 12.5px;
  border: 0;
  outline: none;
  background: transparent;
  padding: 2px 0;
  color: var(--color-text);
}
.search-input::placeholder {
  color: var(--color-text-muted);
}
.search-count {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.search-clear {
  background: transparent;
  border: 0;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
}
.search-clear:hover {
  color: var(--color-text);
}
</style>