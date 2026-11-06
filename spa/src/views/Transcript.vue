<script setup lang="ts">
/* 功能: 任务完整会话转录视图 — 完整镜像 Next.js src/app/transcript/[id]/page.tsx +
   transcript-client.tsx 的核心渲染逻辑（单文件组件，与 master 单文件 client 组件
   结构对齐）。包含：
     - Header (返回任务链接 + 标题 + 状态 chip + 下载 .md + 下载 .jsonl 两个按钮)
     - Metadata grid (模型/强度/花费/时长/创建/开始/完成/session_id 8 项)
     - Body (markdown-it 渲染的完整会话转录，markdown 文本由后端 formatSessionMarkdown
       生成，含 verbosity=full 的逐字 SDK transcript)
   数据源:
     - GET /api/tasks/[id]                          任务元信息 (master /api/tasks/[id] route)
     - GET /api/tasks/[id]/transcript?format=markdown  markdown 文本 (master route 默认)
     - GET /api/tasks/[id]/transcript?format=jsonl&verbosity=full  仅 .jsonl 下载按钮触发

   关注点 (R20 scope, sheet R20 任务清单):
   - SPA 无 SSR, 因此服务端能一次拿到的 task + markdown, SPA 必须串行/并行两条
     GET; 用 Promise.all 并发拉两条, 任何一个失败各自走 ErrorView 兜底.
   - markdown 渲染走 markdown-it (与 R27 Wiki.vue 同款); linkify:true + html:false,
     与 master react-markdown 默认语义对齐; XSS 防护靠 markdown-it 默认转义,
     不依赖 dangerouslySetInnerHTML (Vue v-html 同样需要 raw HTML, 但 markdown-it
     html:false 已确保源不含 raw HTML, 转义由 markdown-it 接管).
   - .md / .jsonl 下载与 Next 同款 fileSlug 算法 (去除 /\\:*?"<>| 和空白 → '-',
     合并连续 -, 去首尾 -, 截前 60; 空标题 fallback "transcript").
   - .jsonl 下载走 fetch + Blob + URL.createObjectURL, 与 Next transcript-client
     handleDownloadJsonl 1:1; 失败走 toast.error 不静默.
   - 状态机走 R11 Loading + R13 ErrorView (retry) + R13 Empty (404 "任务不存在").
   - duration 计算: started_at && completed_at → ms; 与 Next formatDuration 1:1
     (含 "<1秒" / "X秒" / "X分Y秒" / "X时Y分" 4 档).
   - 与 sheet 模块名差异披露: sheet R20 列 "[新] spa/src/views/Transcript.vue",
     本文件实际名 Transcript.vue (与 sheet 一致, 不加 View 后缀 — 此视图是 master
     Next.js /transcript/[id] 直镜像, 与 R19 TaskDetailView 等 "本仓自创详情页"
     不同语境, 沿用 sheet 字面文件名). 路由 name="transcript", meta tagTitle="转录".
   - 不引新组件: Layer 0 已有 R7 Button / R8 Input / R11 Loading / R13 Empty/
     ErrorView / useToast 全套; 唯一新增依赖 = markdown-it (package.json 早已装).
   - 不挂 ProjectSidebar 入口: transcript 是 task 专属子页 (从 task-detail 进),
     与 wiki-detail / webhook-detail 同款不进主导航. */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import MarkdownIt from 'markdown-it';
import { get, HttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import Button from '@/components/Button.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import { useToast } from '@/composables/useToast';
import { useTagsStore } from '@/stores/tags';
import { formatProjectItemTitle } from '@/lib/format-tab-title';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 11 个 TaskStatus — 与 TaskDetailView / BoardPage 同源. */
type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'verifying'
  | 'await_user'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

/** /api/tasks/[id] 响应投影 — 本视图消费的最小字段集, 字段名与 master src/lib/db/tasks.ts
    getTaskById 行结构对齐 (TaskDetailView R19 已对齐, 这里复制避免 import 循环). */
interface TaskDetail {
  id: string;
  title: string;
  status: TaskStatus;
  model: string | null;
  resolved_model: string | null;
  effort: string | null;
  cost_usd: number | null;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  /** /api/tasks/[id] 同款 — 仅用于 tab 标题 {项目≤8}-{任务≤12} 截断 (R59). */
  project_name: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** 状态中文标签 — 与 TaskDetailView / BoardPage 同源 (sheet 红线 "完整功能对等"). */
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待执行',
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  reviewing: '待审核',
  verifying: '验收中',
  await_user: '等用户介入',
  completed: '已完成',
  failed: '失败',
  rejected: '已取消', // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策, 曾误标等待中)
  cancelled: '已取消',
};

/** 状态圆点 class — 与 master STATUS_DOT 同款 (Tailwind bg-* 简化为 css class, 与
    TaskDetailView 的 status-XXX chip 配色一致, 视觉锚点统一). */
const STATUS_DOT: Record<TaskStatus, string> = {
  pending: 'status-pending',
  queued: 'status-queued',
  running: 'status-running',
  paused: 'status-paused',
  reviewing: 'status-reviewing',
  verifying: 'status-verifying',
  await_user: 'status-await-user',
  completed: 'status-completed',
  failed: 'status-failed',
  rejected: 'status-rejected',
  cancelled: 'status-cancelled',
};

/** 单例 markdown-it — html:false + linkify:true, 与 R27 Wiki.vue 同款; transcript 是
    后端 formatSessionMarkdown 生成的纯文本 (含 verbosity=full 的 SDK 全文), 不需要
    mermaid/fence 重写, 走默认渲染即可. */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
});

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

const route = useRoute();

/** vue-router 4 params 类型 = string | string[], 单段路由强转 string. */
const taskId = computed<string>(() => String(route.params.id));

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const task = ref<TaskDetail | null>(null);
const markdown = ref<string>('');
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const notFound = ref<boolean>(false);
const retrying = ref<boolean>(false);

/** .jsonl 下载按钮 loading (与 Next handleDownloadJsonl setDownloadingJsonl 同款).
    避免连点触发多个并发请求. */
const downloadingJsonl = ref<boolean>(false);

const toast = useToast();

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 状态 chip class — 含 unknown 兜底. */
const statusClass = computed<string>(() =>
  task.value ? STATUS_DOT[task.value.status] || 'status-default' : 'status-default',
);

/** 状态中文标签 — 含 unknown 兜底. */
const statusLabel = computed<string>(() =>
  task.value ? STATUS_LABELS[task.value.status] || task.value.status : '',
);

/** 时长 ms. started_at + completed_at 都有才计算, 否则 null. */
const durationMs = computed<number | null>(() => {
  if (!task.value?.started_at || !task.value?.completed_at) return null;
  const start = new Date(task.value.started_at).getTime();
  const end = new Date(task.value.completed_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
});

/** 文件下载 slug — 与 Next transcript-client.tsx fileSlug 1:1.
    去除 /\\:*?"<>| 和空白 → '-', 合并连续 '-', 去首尾 '-', 截前 60;
    空标题 fallback "transcript". */
const fileSlug = computed<string>(() => {
  const title = task.value?.title ?? '';
  return (
    title
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'transcript'
  );
});

/** 模型显示 — resolved_model 优先, 缺省 model, 都没有 → "-". */
const modelLabel = computed<string>(() => {
  if (!task.value) return '-';
  return task.value.resolved_model || task.value.model || '-';
});

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

/** ms → "X秒 / X分Y秒 / X时Y分" — 与 Next transcript-client.tsx formatDuration 1:1. */
function formatDuration(ms: number): string {
  if (ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return '<1秒';
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}时${mins}分`;
}

/** ISO 时间 → "YYYY-MM-DD HH:mm:ss". null/无效 → "-".
    与 Next transcript-client.tsx formatDateTime 1:1 (含秒). */
function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
  const d = parseDbTime(iso);
  if (!d) return '-';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** session_id 截前 16 字符 + 省略号 — 与 Next transcript-client.tsx 1:1. */
function formatSessionId(sid: string | null): string {
  if (!sid) return '';
  return `${sid.slice(0, 16)}…`;
}

/** session_id 是否显示 — 仅 sid 非空才渲染那一格. */
const showSessionRow = computed<boolean>(() => !!task.value?.session_id);

/* ------------------------------------------------------------------ */
/*  Markdown render                                                    */
/* ------------------------------------------------------------------ */

/** markdown → HTML (markdown-it 渲染, Vue v-html 注入). */
const html = computed<string>(() => md.render(markdown.value));

/* ------------------------------------------------------------------ */
/*  Download                                                           */
/* ------------------------------------------------------------------ */

/** 触发浏览器下载 Blob. 与 Next triggerDownload 1:1.
    关注点: URL.revokeObjectURL 推迟一帧执行, 给浏览器足够时间触发 click 事件
    (revoke 太早某些浏览器会忽略下载). */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 下载 .md — 直接落盘当前已渲染的 markdown (markdown 自带 task 元信息头,
    与 Next handleDownload 同款: markdown 自包含). */
function handleDownloadMd(): void {
  const blob = new Blob([markdown.value], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${fileSlug.value}.md`);
}

/** 下载 .jsonl — 拉一次 /api/tasks/[id]/transcript?format=jsonl&verbosity=full,
    blob 落盘. 与 Next handleDownloadJsonl 1:1; 失败走 toast.error 不静默. */
async function handleDownloadJsonl(): Promise<void> {
  if (downloadingJsonl.value) return;
  downloadingJsonl.value = true;
  try {
    const res = await fetch(
      `/api/tasks/${taskId.value}/transcript?format=jsonl&verbosity=full`,
      { credentials: 'include' },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    triggerDownload(blob, `${fileSlug.value}.jsonl`);
  } catch (e: unknown) {
    toast.error(`导出 .jsonl 失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    downloadingJsonl.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

/** 并发拉 task 元信息 + markdown transcript. 任一失败:
   - 404 → notFound=true (用 Empty "任务不存在" 兜底)
   - 其他 → error 兜底 (R13 ErrorView 重试) */
async function loadTranscript(): Promise<void> {
  loading.value = true;
  error.value = null;
  notFound.value = false;
  try {
    const [taskData, mdText] = await Promise.all([
      get<TaskDetail>(`/api/tasks/${taskId.value}`),
      fetch(`/api/tasks/${taskId.value}/transcript?format=markdown`, {
        credentials: 'include',
      }).then(async (r) => {
        if (!r.ok) throw new Error(`transcript HTTP ${r.status}`);
        return r.text();
      }),
    ]);
    task.value = taskData;
    markdown.value = mdText;
  } catch (e: unknown) {
    if (e instanceof HttpError && e.status === 404) {
      notFound.value = true;
    } else if (e instanceof Error) {
      error.value = e.message || '加载失败';
    } else {
      error.value = '加载失败';
    }
    task.value = null;
    markdown.value = '';
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function retry(): void {
  retrying.value = true;
  void loadTranscript();
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

onMounted(() => {
  void loadTranscript();
});

/** 路由参数变化 → 重拉 (SPA hash mode 下同组件复用, 切换 taskId 时不重 mount).
    与 VersionDetailView / RequirementDetail 同款 (R17/R16 拍板). */
watch(taskId, () => {
  void loadTranscript();
});

/* ------------------------------------------------------------------ */
/*  R59 tab 标题: 与 TaskDetailView 1:1 — {项目≤8}-{任务≤12}.            */
/*  Transcript 路由 meta.tagTitle='转录' 是兜底, watch 后被覆盖.        */
/* ------------------------------------------------------------------ */

const tags = useTagsStore();

watch(
  () =>
    task.value
      ? { title: task.value.title, project: task.value.project_name }
      : null,
  (next) => {
    if (!next) return;
    tags.applyTitle(
      route.path,
      formatProjectItemTitle(next.project, next.title),
    );
  },
);
</script>

<template>
  <div class="transcript-page">
    <!-- 加载态 -->
    <div v-if="loading && !task && !notFound && !error" class="state-block">
      <Loading size="lg" label="加载转录" />
      <p class="state-text muted">加载中…</p>
    </div>

    <!-- 404 -->
    <Empty
      v-else-if="notFound"
      illustration="doc"
      title="任务不存在"
      description="该任务可能已被删除,或当前用户无权访问"
      size="md"
    />

    <!-- 错误 -->
    <ErrorView
      v-else-if="error"
      title="加载转录失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      @retry="retry"
    />

    <!-- 主内容 -->
    <template v-else-if="task">
      <!-- Header -->
      <header class="transcript-header">
        <div class="header-row">
          <router-link :to="`/tasks/${task.id}`" class="back-link">
            ← 返回任务
          </router-link>
          <h1 class="task-title" :title="task.title">{{ task.title }}</h1>
          <span class="status-chip">
            <span class="status-dot" :class="statusClass" />
            <span class="status-text">{{ statusLabel }}</span>
          </span>
          <div class="header-actions">
            <Button
              variant="primary"
              size="sm"
              title="下载完整 Markdown 转录"
              @click="handleDownloadMd"
            >
              ⬇ 下载 .md
            </Button>
            <Button
              variant="secondary"
              size="sm"
              :disabled="downloadingJsonl"
              title="下载机器可读的完整会话 (每行一条消息, 含 thinking / tool_use / tool_result)"
              @click="handleDownloadJsonl"
            >
              {{ downloadingJsonl ? '导出中…' : '⬇ 下载 .jsonl' }}
            </Button>
          </div>
        </div>

        <!-- Metadata grid -->
        <dl class="meta-grid">
          <div class="meta-row">
            <dt class="muted">模型</dt>
            <dd class="meta-value mono">{{ modelLabel }}</dd>
          </div>
          <div class="meta-row">
            <dt class="muted">强度</dt>
            <dd class="meta-value mono">{{ task.effort || '-' }}</dd>
          </div>
          <div class="meta-row">
            <dt class="muted">花费</dt>
            <dd class="meta-value mono">
              {{ task.cost_usd != null ? `$${task.cost_usd.toFixed(4)}` : '-' }}
            </dd>
          </div>
          <div class="meta-row">
            <dt class="muted">时长</dt>
            <dd class="meta-value mono">
              {{ durationMs != null ? formatDuration(durationMs) : '-' }}
            </dd>
          </div>
          <div class="meta-row">
            <dt class="muted">创建</dt>
            <dd class="meta-value mono">{{ formatDateTime(task.created_at) }}</dd>
          </div>
          <div class="meta-row">
            <dt class="muted">开始</dt>
            <dd class="meta-value mono">{{ formatDateTime(task.started_at) }}</dd>
          </div>
          <div class="meta-row">
            <dt class="muted">完成</dt>
            <dd class="meta-value mono">{{ formatDateTime(task.completed_at) }}</dd>
          </div>
          <div v-if="showSessionRow" class="meta-row session-row">
            <dt class="muted">Session</dt>
            <dd class="meta-value mono">{{ formatSessionId(task.session_id) }}</dd>
          </div>
        </dl>
      </header>

      <!-- Body — markdown 渲染 -->
      <div class="transcript-body">
        <article class="transcript-article" v-html="html" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

.transcript-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--tw-gray-50); /* bg-gray-50 */
  min-height: 0;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 16px;
}

.state-text {
  margin: 0;
  font-size: 13px;
}

.muted {
  color: var(--color-text-muted);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

.transcript-header {
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--tw-gray-200); /* border-gray-200 */
  padding: 12px 24px;
  flex-shrink: 0;
}

.header-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.back-link {
  color: var(--tw-gray-600); /* text-gray-600 */
  text-decoration: none;
  font-size: 13px;
  flex-shrink: 0;
}

.back-link:hover {
  color: var(--tw-gray-900); /* text-gray-900 */
}

.task-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--tw-gray-900);
  word-break: break-word;
  max-width: 28rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
  min-width: 0;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  flex-shrink: 0;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.status-text {
  color: var(--tw-gray-700); /* text-gray-700 */
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
}

/* ------------------------------------------------------------------ */
/*  Meta grid                                                          */
/* ------------------------------------------------------------------ */

.meta-grid {
  margin: 12px 0 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px 24px;
  font-size: 12px;
}

.meta-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.meta-row dt {
  color: var(--tw-gray-400); /* text-gray-400 */
  flex-shrink: 0;
}

.meta-row dd {
  margin: 0;
  color: var(--tw-gray-800); /* text-gray-800 */
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.session-row dd {
  font-size: 11px;
}

/* ------------------------------------------------------------------ */
/*  Status dot colors (与 TaskDetailView 同源 11 色)                   */
/* ------------------------------------------------------------------ */

.status-pending    { background: var(--tw-gray-100); }
.status-queued     { background: var(--tw-blue-100); }
.status-running    { background: var(--tw-sky-100); }
.status-paused     { background: var(--tw-yellow-100); }
.status-reviewing  { background: var(--tw-purple-100); }
.status-verifying  { background: var(--tw-violet-100); }
.status-await-user { background: var(--tw-amber-100); }
.status-completed  { background: var(--tw-emerald-100); }
.status-failed     { background: var(--tw-red-100); }
.status-rejected   { background: var(--tw-orange-50); }
.status-cancelled  { background: var(--tw-gray-100); }
.status-default    { background: var(--tw-gray-300); }

/* ------------------------------------------------------------------ */
/*  Body                                                               */
/* ------------------------------------------------------------------ */

.transcript-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: 24px;
  box-sizing: border-box;
}

.transcript-article {
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-gray-200);
  border-radius: 8px;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  padding: 24px;
  max-width: none;
  word-break: break-word;
  line-height: 1.625;
  font-size: 13px;
  color: var(--tw-gray-700);
}

/* markdown 渲染样式 — 与 master transcript-client.tsx [&_h1]:text-2xl 等价.
   :deep() 让 scoped 样式穿透到 v-html 注入的子节点. */
.transcript-article :deep(h1) {
  font-size: 24px;
  font-weight: 700;
  margin: 8px 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--tw-gray-200);
  color: var(--tw-gray-900);
}

.transcript-article :deep(h2) {
  font-size: 18px;
  font-weight: 600;
  margin: 24px 0 12px;
  color: var(--tw-gray-800);
}

.transcript-article :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  margin: 16px 0 8px;
  color: var(--tw-gray-800);
}

.transcript-article :deep(h4) {
  font-size: 14px;
  font-weight: 600;
  margin: 12px 0 4px;
  color: var(--tw-gray-700);
}

.transcript-article :deep(h5),
.transcript-article :deep(h6) {
  font-weight: 600;
  margin: 8px 0 4px;
  color: var(--tw-gray-700);
}

.transcript-article :deep(p) {
  margin: 8px 0;
}

.transcript-article :deep(ul) {
  list-style: disc;
  padding-left: 20px;
  margin: 8px 0;
}

.transcript-article :deep(ol) {
  list-style: decimal;
  padding-left: 20px;
  margin: 8px 0;
}

.transcript-article :deep(li) {
  margin: 2px 0;
}

.transcript-article :deep(strong) {
  font-weight: 600;
  color: var(--tw-gray-900);
}

.transcript-article :deep(em) {
  font-style: italic;
}

.transcript-article :deep(br) {
  content: '';
}

.transcript-article :deep(a) {
  color: var(--tw-blue-600);
  text-decoration: underline;
}

.transcript-article :deep(code) {
  background: var(--tw-blue-50);
  color: var(--tw-blue-800);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.transcript-article :deep(pre) {
  background: var(--tw-gray-900);
  color: var(--tw-gray-100);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  margin: 12px 0;
  font-size: 12px;
  white-space: pre-wrap;
}

.transcript-article :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
  white-space: pre;
}

.transcript-article :deep(blockquote) {
  border-left: 4px solid var(--tw-gray-300);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--tw-gray-500);
}

.transcript-article :deep(hr) {
  border: none;
  border-top: 1px solid var(--tw-gray-200);
  margin: 16px 0;
}

/* 修 2026-11-01 表格挤扁(与 TaskTranscript.vue 同款): 中文单元格任意字符可断 +
   列无宽度下限, 宽表格在文章宽度内被压成竖条. 改 max-content + min-width:100%:
   窄表格撑满正文宽, 宽表格横向滚动; td nowrap 保持列宽 = 内容自然宽. */
.transcript-article :deep(table) {
  width: max-content;
  min-width: 100%;
  max-width: 100%;
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 8px 0;
}

.transcript-article :deep(th),
.transcript-article :deep(td) {
  border: 1px solid var(--tw-gray-200);
  padding: 6px 10px;
  white-space: nowrap;
}

.transcript-article :deep(th) {
  background: var(--tw-gray-50);
  font-weight: 600;
}
</style>