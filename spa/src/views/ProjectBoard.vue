<script setup lang="ts">
/* 功能: 项目看板视图 — 完整镜像 Next.js /[projectId]/board. 拉取 board 文件
   frontmatter (title/refresh/sources) + body HTML, 把 body 塞进 iframe srcdoc
   (sandbox=allow-scripts 不给 allow-same-origin, 与 Next D2 拍板一致), 再
   拉每个 source 的 data 通过 postMessage 注入 iframe (CSP connect-src 'none').
   顶部工具栏 = title + 路径 + 刷新节奏 + 最后更新 + source 失败数 +
   时间线胶囊 (最近 20 次 git commits). hash 路由 URL = #/[projectId]/board
   (?path=xxx 可选覆盖 board 文件路径, 缺省 boards/my-project.md).

   关注点 (R28):
   - GET /api/projects/[id]/board?path=... 拿 { exists, config, body } — server-side
     解析 frontmatter + body, 客户端只负责 iframe 渲染.
   - POST /api/projects/[id]/board body { path } 拿所有 source 数据 (信封装
     { data: {...}, errors: {...}, meta: {...} }), postMessage 到 iframe.
   - GET /api/projects/[id]/board?path=...&history=1 拿 git 时间线 commits.
   - iframe sandbox: allow-scripts 但不给 allow-same-origin (Next D2 拍板, AI 写
     的 JS 拿不到宿主 cookie/localStorage); 数据只能来自 postMessage.
   - srcdoc 模板 = CSP meta + inline listener (board-data 收 + board-resize 发) +
     业务 body. 与 Next board-client.tsx buildSrcDoc 1:1 对等.
   - 自适应高度: iframe 内 ResizeObserver → postMessage(board-resize, h) →
     宿主 setIframeHeight. 限制 [200, 4000] 防异常值.
   - refresh: interval → setInterval; sse/manual → 不开 timer. 与 frontmatter
     refresh.kind 完全对齐.
   - 失败降级: exists=false → "找不到 board 文件" + 提示 frontmatter 示例;
     no-cwd → "本项目未配置 cwd" + 返回项目列表链接.
   - URL 即状态: ?path=xxx 走 useRoute().query.path, 缺省 boards/my-project.md.
   - 不挂 ProjectSidebar 主导航 (看板是项目级视图, 与版本需求点同款
     inline 入口, 每个项目行加按钮). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, post } from '@/api/http';
import { buildBoardSrcDoc } from '@/lib/board-srcdoc';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 与 master src/lib/board/frontmatter.ts BoardConfig 1:1 对齐.
    SPA 只关心 refresh.kind/seconds 用于 setInterval, sources[].name
    用于 buildSrcDoc 注入 + meta.sources 错误数. */
type SourceKind = 'api' | 'sql';

interface ApiSource {
  name: string;
  kind: 'api';
  path: string;
  query?: Record<string, string>;
}

interface SqlSource {
  name: string;
  kind: 'sql';
  query: string;
}

type Source = ApiSource | SqlSource;

type Refresh =
  | { kind: 'interval'; seconds: number }
  | { kind: 'sse' }
  | { kind: 'manual' };

interface BoardConfig {
  title: string;
  refresh: Refresh;
  sources: Source[];
  layout: 'page' | 'panel';
}

/** GET /api/projects/[id]/board 响应. 4 种 reason:
    - exists=true → 正常 config + body
    - exists=false, reason='no-cwd' → 项目没配 cwd
    - exists=false, reason='not-found' → board 文件找不到
    - 其他 (404 等) → ErrorView */
interface BoardFileResponse {
  exists: boolean;
  reason?: 'no-cwd' | 'not-found';
  path?: string;
  origin?: 'project' | 'platform';
  config?: BoardConfig;
  body?: string;
  error?: string;
}

/** POST /api/projects/[id]/board 信封响应. */
interface BoardDataResponse {
  data?: Record<string, unknown>;
  errors?: Record<string, string>;
  meta?: {
    fetchedAt: string;
    sources: Array<{ name: string; ok: boolean; ms?: number }>;
  };
  error?: string;
}

/** GET ?history=1 响应. */
interface BoardHistoryResponse {
  commits?: CommitEntry[];
  error?: string;
}

interface CommitEntry {
  sha: string;
  author: string;
  email: string;
  time: string;
  message: string;
  authorRole: 'agent' | 'user';
}

/** 视图状态机: loading (初次拉 GET) / no-cwd / not-found / content / error. */
type ViewState = 'loading' | 'no-cwd' | 'not-found' | 'content' | 'error';

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

/** 默认 board 路径 (与 Next page.tsx:48 同款). boards/my-project.md 是 R91 第二步
    拍板的"每个项目点 Board 自动看本项目视图". */
const DEFAULT_BOARD_PATH = 'boards/my-project.md';

/** 最小刷新间隔 (frontmatter.ts 拍板的 10s 兜底, 与服务端一致). */
const MIN_REFRESH_SECONDS = 10;

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const projectId = computed<string>(() => String(route.params.projectId || ''));

/** 当前 board 路径 (URL ?path= 覆盖, 缺省 boards/my-project.md). 改 path
    会触发 GET 重拉 + watch 重置. */
const boardPath = computed<string>(() => {
  const raw = route.query.path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_BOARD_PATH;
});

/** 把 boardPath 写回 URL (router.replace, 不入历史栈). undefined = 删字段,
    URL 干净 (与 Next 缺省 boards/my-project.md 等价). */
function setBoardPath(p: string): void {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (typeof v === 'string') next[k] = v;
  }
  if (!p || p === DEFAULT_BOARD_PATH) delete next.path;
  else next.path = p;
  void router.replace({ query: next });
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const viewState = ref<ViewState>('loading');
const config = ref<BoardConfig | null>(null);
const body = ref<string>('');
const boardOrigin = ref<'project' | 'platform' | null>(null);

const iframeHeight = ref<number>(600);
const lastFetched = ref<string | null>(null);
const sourceErrors = ref<Record<string, string>>({});

const commits = ref<CommitEntry[]>([]);
const historyOpen = ref<boolean>(false);

const errorMessage = ref<string>('');
const retrying = ref<boolean>(false);

/* ------------------------------------------------------------------ */
/*  Refs (lifecycle)                                                   */
/* ------------------------------------------------------------------ */

const iframeRef = ref<HTMLIFrameElement | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

/** 构造 board API URL (path 透传 + 保留 query). */
function buildBoardQuery(extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams({ path: boardPath.value, ...extra });
  return qs.toString();
}

/** 拉取 board config + body (前端能直接 POST 拿 source data, 但 frontmatter
    + body 走 GET). 401/404/500 各自处理. */
async function fetchBoardFile(): Promise<void> {
  viewState.value = 'loading';
  errorMessage.value = '';
  try {
    const j = await get<BoardFileResponse>(`/api/projects/${projectId.value}/board?${buildBoardQuery()}`);
    if (!j.exists) {
      // reason: no-cwd / not-found → 进入对应渲染分支
      viewState.value = j.reason === 'no-cwd' ? 'no-cwd' : 'not-found';
      config.value = null;
      body.value = '';
      return;
    }
    config.value = j.config ?? {
      title: 'Untitled Board',
      refresh: { kind: 'interval', seconds: 30 },
      sources: [],
      layout: 'page',
    };
    body.value = j.body ?? '';
    boardOrigin.value = j.origin ?? null;
    viewState.value = 'content';
  } catch (e: unknown) {
    // 401 走 http.ts 自动 refresh+retry; 这里 catch 的是非 401 + refresh 后仍 401.
    const msg = e instanceof Error ? e.message : t('projects.board.loadFailedTitle');
    errorMessage.value = msg;
    viewState.value = 'error';
  }
}

/** 拉 source 数据 (POST body 包含 path) + postMessage 到 iframe. */
async function fetchAndInject(): Promise<void> {
  if (!iframeRef.value?.contentWindow) return;
  try {
    const j = await post<BoardDataResponse>(
      `/api/projects/${projectId.value}/board`,
      { path: boardPath.value },
    );
    lastFetched.value = j.meta?.fetchedAt ?? new Date().toISOString();
    sourceErrors.value = j.errors ?? {};
    iframeRef.value.contentWindow.postMessage(
      {
        type: 'board-data',
        data: j.data ?? {},
        errors: j.errors ?? {},
        meta: j.meta,
      },
      window.location.origin,
    );
  } catch {
    // 静默失败, 下轮再试 (Next board-client.tsx:90 同款)
  }
}

/** 拉 git 时间线 commits (P5). */
async function fetchHistory(): Promise<void> {
  try {
    const j = await get<BoardHistoryResponse>(
      `/api/projects/${projectId.value}/board?${buildBoardQuery({ history: '1' })}`,
    );
    commits.value = Array.isArray(j.commits) ? j.commits : [];
  } catch {
    // 静默失败, 时间线留空
  }
}

/** 拉 board 文件 + 初次 source data + 首次 history. */
async function loadAll(): Promise<void> {
  await fetchBoardFile();
  if (viewState.value !== 'content') return;
  await Promise.all([fetchAndInject(), fetchHistory()]);
  startRefreshTimer();
}

function startRefreshTimer(): void {
  stopRefreshTimer();
  const cfg = config.value;
  if (!cfg || cfg.refresh.kind !== 'interval') return;
  const sec = Math.max(MIN_REFRESH_SECONDS, cfg.refresh.seconds);
  refreshTimer = setInterval(() => {
    void fetchAndInject();
  }, sec * 1000);
}

function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/*  srcdoc builder                                                     */
/* ------------------------------------------------------------------ */

// srcdoc 模板已抽到 src/lib/board-srcdoc.ts (R28). Vue SFC compiler 不允许
// 在 setup 块内出现脚本 tag 字面量 (编译器会当作新块的开始/结束), 所以这块
// HTML 模板必须放到独立 .ts 文件里, 浏览器运行时拼回完整 HTML, 行为不变.

const srcDoc = computed<string>(() => {
  if (viewState.value !== 'content' || !config.value) return '';
  return buildBoardSrcDoc({
    body: body.value,
    sourceNames: config.value.sources.map((s) => s.name),
  });
});

/* ------------------------------------------------------------------ */
/*  iframe 自适应高度 + postMessage                                    */
/* ------------------------------------------------------------------ */

/** 监听 board-resize 消息, 重设 iframe 高度. 限制 [200, 4000] 防异常值.
    与 Next board-client.tsx:121-131 1:1 对等. */
function onMessage(e: MessageEvent): void {
  if (e.origin !== window.location.origin) return;
  const data = e.data as { type?: string; height?: number };
  if (data?.type === 'board-resize' && typeof data.height === 'number') {
    iframeHeight.value = Math.max(200, Math.min(4000, data.height));
  }
}

onMounted(() => {
  window.addEventListener('message', onMessage);
  void loadAll();
});

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  stopRefreshTimer();
});

/* ------------------------------------------------------------------ */
/*  Watchers                                                           */
/* ------------------------------------------------------------------ */

/** boardPath 变化 → 重拉. path 来自 URL ?path=, 用户手动改 path 后路由
    query 变化触发 watcher. */
watch(boardPath, () => {
  stopRefreshTimer();
  void loadAll();
});

/** projectId 变化 → 重拉. */
watch(projectId, () => {
  stopRefreshTimer();
  void loadAll();
});

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onRetry(): void {
  retrying.value = true;
  void loadAll().finally(() => {
    retrying.value = false;
  });
}

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

function formatCommitTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function sourceErrorTooltip(): string {
  return Object.entries(sourceErrors.value)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

const projectHomeUrl = computed<string>(() => `/projects/${projectId.value}`);
</script>

<template>
  <div class="project-board">
    <!-- Header / 工具栏 -->
    <div v-if="viewState === 'content' && config" class="board-toolbar">
      <div class="toolbar-left">
        <span class="board-title">{{ config.title }}</span>
        <span class="board-path">{{ boardPath }}</span>
        <template v-if="config.refresh.kind === 'interval'">
          <span class="board-meta">{{ t('projects.board.refreshEvery', { n: Math.max(MIN_REFRESH_SECONDS, config.refresh.seconds) }) }}</span>
        </template>
        <template v-else-if="config.refresh.kind === 'sse'">
          <span class="board-meta">{{ t('projects.board.refreshSse') }}</span>
        </template>
        <template v-else>
          <span class="board-meta">{{ t('projects.board.refreshManual') }}</span>
        </template>
        <span v-if="lastFetched" class="board-meta">{{ t('projects.board.lastUpdate', { time: formatTime(lastFetched) }) }}</span>
      </div>
      <div class="toolbar-right">
        <span
          v-if="Object.keys(sourceErrors).length > 0"
          class="board-warn"
          :title="sourceErrorTooltip()"
        >
          {{ t('projects.board.sourcesFailed', { n: Object.keys(sourceErrors).length }) }}
        </span>
        <button type="button" class="toolbar-link" @click="toggleHistory">
          {{ t('projects.board.timeline', { n: commits.length }) }}
        </button>
      </div>
    </div>

    <!-- P5 时间线胶囊 (折叠面板) -->
    <div v-if="viewState === 'content' && historyOpen" class="board-history">
      <h3 class="history-title">{{ t('projects.board.historyTitle') }}</h3>
      <p v-if="commits.length === 0" class="history-empty">{{ t('projects.board.noHistory') }}</p>
      <ul v-else class="history-list">
        <li v-for="c in commits" :key="c.sha" class="history-item">
          <span
            :class="['history-role', c.authorRole === 'agent' ? 'history-role-agent' : 'history-role-user']"
          >
            {{ c.authorRole }}
          </span>
          <code class="history-sha">{{ c.sha.slice(0, 7) }}</code>
          <span class="history-msg">{{ c.message }}</span>
          <span class="history-author">{{ c.author }}</span>
          <span class="history-time">{{ formatCommitTime(c.time) }}</span>
        </li>
      </ul>
    </div>

    <!-- Body: 状态机 -->
    <div class="board-body">
      <!-- Initial loading -->
      <div v-if="viewState === 'loading'" class="board-loading">
        <Loading size="lg" />
        <p class="board-loading-text">{{ t('projects.board.loading') }}</p>
      </div>

      <!-- 401/网络错 -->
      <ErrorView
        v-else-if="viewState === 'error'"
        :title="t('projects.board.loadFailedTitle')"
        :description="errorMessage"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <!-- no-cwd: 跳项目详情配置 cwd -->
      <div v-else-if="viewState === 'no-cwd'" class="board-message">
        <p>{{ t('projects.board.noCwd1') }}</p>
        <p>{{ t('projects.board.noCwd2') }}</p>
        <router-link :to="projectHomeUrl" class="board-link">{{ t('projects.board.backToProject') }}</router-link>
      </div>

      <!-- not-found: 提示 frontmatter 示例 -->
      <div v-else-if="viewState === 'not-found'" class="board-message board-message-wide">
        <h1 class="board-message-title">{{ t('projects.board.notFoundTitle') }}</h1>
        <p class="board-message-text">
          {{ t('projects.board.pathLabel') }} <code>{{ boardPath }}</code>
          <span v-if="boardOrigin === 'platform'" class="board-meta">
            {{ t('projects.board.platformBoard') }}
          </span>
        </p>
        <p class="board-message-text board-message-faded">
          {{ t('projects.board.resolveOrder') }}
        </p>
        <div class="board-message-tip">
          <p class="board-message-text">{{ t('projects.board.createTip1') }} <code>cwd</code> {{ t('projects.board.createTip2') }}</p>
          <!-- v-pre: 让 Vue 模板编译器跳过该块, 防止 &lt;script&gt; / &lt;/script&gt;
              实体编码被错误解析成模板开始/结束标记. -->
          <pre class="board-message-pre" v-pre>---
title: 我的看板
refresh: 30s
sources:
  - name: projects
    kind: api
    path: /api/projects
---
&lt;div id="app"&gt;&lt;/div&gt;
&lt;script&gt;
  fetch(window.__DATA__.projects).then(r =&gt; r.json()).then(d =&gt; {
    document.getElementById('app').innerText = JSON.stringify(d, null, 2);
  });
&lt;/script&gt;</pre>
        </div>
      </div>

      <!-- content: iframe sandbox -->
      <iframe
        v-show="viewState === 'content'"
        ref="iframeRef"
        :title="config?.title || 'Board'"
        sandbox="allow-scripts"
        :srcDoc="srcDoc"
        class="board-iframe"
        :style="{ height: `${iframeHeight}px` }"
      />
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

.project-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg, #f9fafb);
  color: var(--color-text, #111827);
}

/* ------------------------------------------------------------------ */
/*  Toolbar                                                            */
/* ------------------------------------------------------------------ */

.board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  background: var(--color-bg-elevated, #ffffff);
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  font-size: 13px;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.board-title {
  font-weight: 600;
  color: var(--color-text, #111827);
}

.board-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--color-text-muted, #6b7280);
}

.board-meta {
  font-size: 12px;
  color: var(--color-text-muted, #6b7280);
}

.board-warn {
  font-size: 12px;
  color: var(--tw-amber-700);
  cursor: help;
}

.toolbar-link {
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: var(--color-primary, #2563eb);
  cursor: pointer;
  text-decoration: none;
}

.toolbar-link:hover {
  text-decoration: underline;
}

/* ------------------------------------------------------------------ */
/*  History panel                                                      */
/* ------------------------------------------------------------------ */

.board-history {
  background: var(--tw-gray-50);
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  padding: 8px 16px;
  max-height: 16rem;
  overflow-y: auto;
}

.history-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted, #6b7280);
}

.history-empty {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted, #9ca3af);
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}

.history-role {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  flex-shrink: 0;
}

.history-role-agent {
  background: var(--tw-purple-100);
  color: var(--tw-purple-800);
}

.history-role-user {
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
}

.history-sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--color-text-muted, #6b7280);
  flex-shrink: 0;
}

.history-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text, #374151);
}

.history-author {
  font-size: 11px;
  color: var(--color-text-muted, #9ca3af);
  flex-shrink: 0;
}

.history-time {
  font-size: 11px;
  color: var(--color-text-muted, #9ca3af);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  Body                                                               */
/* ------------------------------------------------------------------ */

.board-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: auto;
}

.board-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted, #6b7280);
}

.board-loading-text {
  margin: 0;
  font-size: 14px;
}

.board-message {
  margin: 32px 24px;
  padding: 24px;
  background: var(--color-bg-elevated, #ffffff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-md, 6px);
  font-size: 14px;
  color: var(--color-text-muted, #6b7280);
}

.board-message-wide {
  max-width: 720px;
}

.board-message-title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text, #111827);
}

.board-message-text {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--color-text, #374151);
}

.board-message-text code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--tw-gray-100);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.board-message-faded {
  color: var(--color-text-muted, #6b7280);
  font-size: 12px;
}

.board-message-tip {
  margin-top: 16px;
}

.board-message-pre {
  margin: 8px 0 0;
  padding: 12px;
  background: var(--tw-gray-50);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius, 4px);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text, #374151);
}

.board-message-pre-tag {
  color: var(--tw-gray-500);
}

.board-link {
  display: inline-block;
  margin-top: 12px;
  font-size: 13px;
  color: var(--color-primary, #2563eb);
  text-decoration: none;
}

.board-link:hover {
  text-decoration: underline;
}

/* iframe sandbox: width 100% + 自适应高度, 不给 allow-same-origin */
.board-iframe {
  width: 100%;
  border: 0;
  background: var(--color-bg-elevated, #ffffff);
  flex: 1;
  display: block;
}
</style>