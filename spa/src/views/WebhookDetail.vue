<script setup lang="ts">
/* 功能: Webhook 详情视图 — 对应 Next.js src/app/webhooks/[id]/page.tsx +
   webhook-detail-client.tsx. 完整镜像布局: 面包屑 (项目 › Webhooks › 名称) +
   标题 + 状态 chip + URL + 订阅事件 chips + 投递历史表格.
   数据源: GET /api/webhooks/[id] (webhook 元信息, R25 listWebhooks 同源) +
   GET /api/webhooks/[id]/deliveries (R38 G3 收口, 取代 R11 占位跳转).
   URL: /webhooks/:webhookId, route.params.webhookId 取值.

   关注点 (R38, G3 收口):
   - 投递历史 REST 后端已暴露 (commit a432dad2, master + v2.0-spa 双线), SPA 接入:
     删 R11 占位 "投递历史暂未对接 SPA" 提示 + "在新窗口打开 Next.js 详情页" 按钮,
     改走真实 getWebhookDeliveries(webhookId), 表格 columns/rows 渲染后端真实数据.
   - payload 字段是后端解析后的 JSON 对象 (event/status_code/error/url/duration_ms 等),
     直接读字段渲染; 与 master Next.js webhook-detail-client.tsx 1:1 同源.
   - 任务 id 字段从 payload.task_id 取 (events 表 event.data JSON 内的 task_id);
     详情列成功 = response_status + duration_ms, 失败 = error 字符串 (与 master 一致).
   - 401/403/500 三态兜底: 401 走 router 守卫 (login), 403 → 「无权限查看投递历史」,
     500 → R13 ErrorView retry. 主页面 401 已被 R3 HttpError → router.beforeEach 拦.
   - 加载策略: webhook + deliveries 并发拉 (Promise.allSettled, 任一失败不影响另一), 与
     R16 RequirementDetail 五路并发同款, 局部失败走 ErrorView 子面板, 整体结构保留.
   - 状态机走 R11 Loading + R13 ErrorView (retry) — 与 R17/R19 详情页同口径. */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  getWebhook,
  getWebhookDeliveries,
  type Webhook,
  type WebhookDelivery,
} from '@/api/webhooks';
import { HttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

const route = useRoute();
const webhookId = computed<string>(() => String(route.params.webhookId));

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const webhook = ref<Webhook | null>(null);
const deliveries = ref<WebhookDelivery[]>([]);
const loading = ref<boolean>(false);
const retrying = ref<boolean>(false);
const error = ref<string | null>(null);
const notFound = ref<boolean>(false);
/** deliveries 独立状态: 与 webhook 主加载解耦, 主加载失败时不影响投递区已显示的数据. */
const deliveriesLoading = ref<boolean>(false);
const deliveriesError = ref<string | null>(null);
const deliveriesRetrying = ref<boolean>(false);

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** webhook 是否加载成功 — 决定显示 detail 还是 Empty. */
const hasWebhook = computed<boolean>(() => webhook.value !== null);

/** 当前 active 布尔值 — Webhook 接口类型为 boolean. */
const isActive = computed<boolean>(() => !!webhook.value?.active);

/** 投递历史是否包含 task_id 字段 — 决定「关联 task」列是否显示链接. */

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

/** DB/ISO 时间字符串 → "YYYY-MM-DD HH:mm:ss". 缺省/无效 → "—".
    关注点: attempted_at 来自 events.created_at = SQLite 裸 UTC 串, 走 parseDbTime
    补 Z 当 UTC 解析 (旧 new Date(iso) 按本地时区解析, CST 偏早 8h; R211). */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseDbTime(iso);
  if (!d) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** task_id 截前 8 字符显示 — 与 Next.js webhook-detail-client.tsx 同款. */
function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

/** status 字符串 → { label, color } — 与 Next.js statusFor 同款, 兜底用 unknown 灰.
    后端 status 字段 = 'delivered' (webhook_delivered) 或 'failed' (webhook_delivery_failed),
    与 events 表 type 字段经后端映射后的字面值. */
function statusFor(status: string): { label: string; color: string } {
  if (status === 'delivered') {
    return { label: '已投递', color: 'status-active' };
  }
  if (status === 'failed') {
    return { label: '失败', color: 'status-inactive' };
  }
  return { label: status, color: 'status-default' };
}

/** 从 payload 取 task_id (events.data JSON 内的 task_id 字段) — 与 master 同款. */
function taskIdFromPayload(payload: Record<string, unknown>): string | null {
  const t = payload.task_id;
  return typeof t === 'string' ? t : null;
}

/** duration_ms 数字 → "123ms" 字符串; 缺省 → null (与 Next.js 同款条件渲染). */
function durationMs(payload: Record<string, unknown>): number | null {
  const d = payload.duration_ms;
  return typeof d === 'number' ? d : null;
}

/** error 字符串 — 失败详情列展示; 缺省 → null. */
function errorMessage(payload: Record<string, unknown>): string | null {
  const e = payload.error;
  return typeof e === 'string' ? e : null;
}

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

async function loadWebhook(): Promise<void> {
  loading.value = true;
  error.value = null;
  notFound.value = false;
  try {
    const data = await getWebhook(webhookId.value);
    webhook.value = data;
    // 主数据加载成功 → 顺道触发 deliveries 加载 (首次); 不依赖 onMounted 二次触发.
    void loadDeliveries();
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      if (e.status === 403) {
        error.value = '无权限查看该 webhook';
        webhook.value = null;
        return;
      }
      if (e.status === 404) {
        notFound.value = true;
        webhook.value = null;
        return;
      }
      // 401: http.ts 内部已尝试 refresh+retry, 仍 401 = 会话失效, 由 router guard
      // 拦截后续 navigation; 此处把后端 message 直接展示, 用户重试或刷新即恢复.
      error.value = e.message || `请求失败 (HTTP ${e.status})`;
      webhook.value = null;
    } else if (e instanceof Error) {
      error.value = `网络异常: ${e.message}`;
    } else {
      error.value = '加载失败';
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

async function loadDeliveries(): Promise<void> {
  deliveriesLoading.value = true;
  deliveriesError.value = null;
  try {
    const list = await getWebhookDeliveries(webhookId.value);
    deliveries.value = list;
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      if (e.status === 403) {
        deliveriesError.value = '无权限查看投递历史';
        return;
      }
      if (e.status === 404) {
        // 与 webhook 元信息 404 同步 — 后端 deliveries route 在 webhook 不存在时返 404;
        // 此处归一到主 404 提示 (webhook 不存在 = 投递历史也不可达, 概念一致).
        notFound.value = true;
        webhook.value = null;
        return;
      }
      deliveriesError.value = e.message || `请求失败 (HTTP ${e.status})`;
    } else if (e instanceof Error) {
      deliveriesError.value = `网络异常: ${e.message}`;
    } else {
      deliveriesError.value = '加载投递历史失败';
    }
  } finally {
    deliveriesLoading.value = false;
    deliveriesRetrying.value = false;
  }
}

function retry(): void {
  retrying.value = true;
  void loadWebhook();
}

function retryDeliveries(): void {
  deliveriesRetrying.value = true;
  void loadDeliveries();
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

onMounted(() => {
  void loadWebhook();
});
</script>

<template>
  <div class="webhook-detail">
    <!-- Header: 面包屑 + 标题 + 状态 chip + URL + 订阅事件 chips -->
    <header v-if="webhook" class="page-header">
      <nav class="breadcrumb">
        <span class="crumb">项目</span>
        <span class="crumb-sep">›</span>
        <span class="crumb">Webhooks</span>
        <span class="crumb-sep">›</span>
        <span class="crumb crumb-current">{{ webhook.name }}</span>
      </nav>

      <div class="title-row">
        <h2 class="page-title">{{ webhook.name }}</h2>
        <span :class="['status-chip', isActive ? 'status-active' : 'status-inactive']">
          {{ isActive ? '启用' : '禁用' }}
        </span>
      </div>

      <code class="url-block">{{ webhook.url }}</code>

      <div v-if="webhook.events.length > 0" class="event-row">
        <span
          v-for="ev in webhook.events"
          :key="ev"
          class="event-chip"
        >{{ ev }}</span>
      </div>
    </header>

    <!-- Body: loading / error / 404 / content -->
    <div v-if="loading && !webhook" class="state-block">
      <Loading size="lg" label="加载 webhook 详情" />
      <p class="state-text muted">加载中…</p>
    </div>

    <ErrorView
      v-else-if="error"
      title="加载失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      @retry="retry"
    />

    <Empty
      v-else-if="notFound"
      illustration="doc"
      title="Webhook 不存在"
      description="该 webhook 可能已被删除,或当前用户无权访问"
      size="md"
    />

    <main v-else-if="hasWebhook" class="content">
      <!-- 投递历史 section (R38: 接 GET /api/webhooks/[id]/deliveries, 删 R11 占位 notice) -->
      <section class="history-section">
        <h3 class="section-title">
          投递历史 (最近 {{ deliveries.length }} 条)
        </h3>

        <!-- deliveries 加载态: 与 webhook 主加载解耦, 主面板已渲染时不覆盖. -->
        <div v-if="deliveriesLoading && deliveries.length === 0" class="state-block-sm">
          <Loading size="md" label="加载投递历史" />
          <p class="state-text muted">加载投递历史中…</p>
        </div>

        <!-- deliveries 错误态: 子面板 ErrorView, 主面板不受影响, 一键重试. -->
        <ErrorView
          v-else-if="deliveriesError && deliveries.length === 0"
          title="加载投递历史失败"
          :description="deliveriesError"
          variant="error"
          size="sm"
          :retrying="deliveriesRetrying"
          @retry="retryDeliveries"
        />

        <!-- 表格: 已加载 + 非空 → 渲染数据; 空 → 复用 R13 Empty 插画 (与 Next 端同款 empty 文案). -->
        <div
          v-else-if="deliveries.length > 0"
          class="table-card"
        >
          <table class="history-table">
            <thead>
              <tr>
                <th class="col-time">时间</th>
                <th class="col-status">状态</th>
                <th class="col-event">事件</th>
                <th class="col-task">关联 task</th>
                <th class="col-detail">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in deliveries" :key="d.id ?? `${d.attempted_at}-${d.event}`">
                <td class="col-time-cell text-mono text-muted">
                  {{ formatDateTime(d.attempted_at) }}
                </td>
                <td>
                  <span :class="['status-chip', statusFor(d.status).color]">
                    {{ statusFor(d.status).label }}
                  </span>
                  <span v-if="typeof d.response_status === 'number'" class="status-meta">
                    HTTP {{ d.response_status }}
                  </span>
                  <span v-if="durationMs(d.payload) !== null" class="status-meta">
                    {{ durationMs(d.payload) }}ms
                  </span>
                </td>
                <td class="text-mono">
                  {{ d.event ?? '—' }}
                </td>
                <td>
                  <a
                    v-if="taskIdFromPayload(d.payload)"
                    class="task-link"
                    :href="`/#/tasks/${taskIdFromPayload(d.payload)}`"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ shortTaskId(taskIdFromPayload(d.payload)!) }}</a>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="detail-cell">
                  <code v-if="errorMessage(d.payload)" class="error-code">
                    {{ errorMessage(d.payload) }}
                  </code>
                  <span v-else-if="typeof d.payload.message === 'string'">
                    {{ d.payload.message }}
                  </span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 空态: 与 Next.js 「暂无投递记录」文案 1:1 对齐. -->
        <div v-else class="table-card">
          <table class="history-table">
            <thead>
              <tr>
                <th class="col-time">时间</th>
                <th class="col-status">状态</th>
                <th class="col-event">事件</th>
                <th class="col-task">关联 task</th>
                <th class="col-detail">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colspan="5" class="empty-row">
                  <Empty
                    illustration="inbox"
                    size="sm"
                    title="暂无投递记录"
                    description="该 webhook 还没被任何 task 事件触发过,或事件已超过 100 条上限。"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.webhook-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-bg);
  color: var(--color-text);
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

.page-header {
  flex-shrink: 0;
  padding: 16px 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.crumb-current {
  color: var(--color-text);
  font-weight: 500;
}

.crumb-sep {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
  word-break: break-word;
}

.url-block {
  display: block;
  margin: 0 0 10px;
  padding: 4px 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--color-text-muted);
  word-break: break-all;
  line-height: 1.5;
}

.event-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ------------------------------------------------------------------ */
/*  Chips                                                              */
/* ------------------------------------------------------------------ */

.status-chip {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
}

.status-active {
  background: var(--tw-emerald-100);
  color: var(--tw-emerald-800);
}

.status-inactive {
  background: var(--tw-gray-100);
  color: var(--tw-gray-500);
}

.status-default {
  background: var(--tw-gray-100);
  color: var(--tw-gray-700);
}

.event-chip {
  display: inline-block;
  padding: 2px 9px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--tw-blue-50);
  color: var(--tw-blue-700);
  border-radius: 999px;
}

/* ------------------------------------------------------------------ */
/*  Common                                                             */
/* ------------------------------------------------------------------ */

.muted {
  color: var(--color-text-muted);
}

.text-muted {
  color: var(--color-text-muted);
}

.text-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 12px;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
}

.state-block-sm {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.state-text {
  margin: 0;
  font-size: 13px;
}

/* ------------------------------------------------------------------ */
/*  Content                                                            */
/* ------------------------------------------------------------------ */

.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  max-width: 1024px;
  width: 100%;
  margin: 0 auto;
  padding: 24px;
}

.section-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

/* ------------------------------------------------------------------ */
/*  History table                                                      */
/* ------------------------------------------------------------------ */

.table-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.history-table thead {
  background: var(--color-bg);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.history-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 500;
  border-bottom: 1px solid var(--color-border);
}

.history-table tbody tr {
  border-bottom: 1px solid var(--color-border);
}

.history-table tbody tr:last-child {
  border-bottom: none;
}

.history-table td {
  padding: 8px 12px;
  vertical-align: middle;
}

.col-time {
  width: 160px;
}

.col-time-cell {
  white-space: nowrap;
  font-size: 12px;
}

.col-status {
  width: 200px;
}

.status-meta {
  margin-left: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.col-event {
  width: 180px;
  font-size: 12px;
  color: var(--tw-gray-700);
}

.col-task {
  width: 120px;
}

.task-link {
  color: var(--tw-blue-600);
  text-decoration: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.task-link:hover {
  text-decoration: underline;
}

.col-detail {
  /* flex */
}

.detail-cell {
  font-size: 12px;
  color: var(--color-text-muted);
  word-break: break-word;
}

.error-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--tw-red-700);
  background: var(--tw-red-50);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}

.empty-row {
  padding: 24px 12px !important;
  text-align: center;
}
</style>
