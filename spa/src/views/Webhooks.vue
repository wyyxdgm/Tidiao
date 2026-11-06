<script setup lang="ts">
/* 功能: Webhooks 管理视图 — 对应 Next src/app/webhooks/webhooks-client.tsx + 投递历史侧栏.
   sheet R25 字面要求 = GET /api/webhooks 列表 + 编辑 + 投递历史侧栏. 视图范围按 sheet 红线
   只动本文件; api 封装放 api/webhooks.ts (R25 glue, 与 R23 schedules.ts / R24 templates.ts
   同款). 路由 + 侧栏入口也按 R23/R24 同款补 (router/index.ts + ProjectSidebar.vue).

   关注点 (sheet R25 + 与现实分歧):
   - 投递历史侧栏: master 后端当前**没有** GET /api/webhooks/[id]/deliveries 端点
     (Next [id]/page.tsx 是 server-side 直接调 getWebhookDeliveryEvents, 没暴露 REST API).
     按 sheet 红线「只动 R25 模块名 = Webhooks.vue + 必要 glue」, 不在 src/app/api/ 加端点.
     折中: 侧栏显示选中 webhook 的元信息 (name/url/events/active/created_at/has_secret),
     底部「在新窗口打开投递历史」按钮 → 跳 Next /webhooks/[id] 看完整历史 (SaaS 跨页过渡
     期可接受, 后续 M4 接齐端点后再嵌入).
   - 编辑抽屉: 沿用 Next 内联编辑 (折叠面板, 不弹 modal) — 与 sheet 字面「编辑」一致,
     跟 schedules 编辑抽屉 (R23 modal) 形态不同. 字段只覆盖 events + active, name/url/secret
     创建后**不提供修改入口** (Next 也是同口径 — 编辑面板只显示 events/active). 完整修改
     留后续 task (删除重建是 Next 也认可的逃生路径).
   - 删除走 R6 ConfirmDialog (type=danger). 硬删 (后端无软删除通道).
   - 「启用/停用」直接走 edit panel 的 active 切换, 不另起 toggle action — 与 Next 字面
     「编辑面板含 active checkbox」一致, 不创造 sheet 之外的操作按钮.
   - 创建表单字段对齐 master createWebhookSchema (name/url/secret/events + active 可选):
     name.trim().min(1) + url http(s) 校验 + secret.min(1) + events 至少 1 个. 校验失败
     走 toast.error, 不引入 R3 formErrors 字段级红框 (列表页 + 一次性创建, 用 toast 更轻量). */

import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  WEBHOOK_EVENTS,
  type Webhook,
  type CreateWebhookBody,
  type UpdateWebhookBody,
} from '@/api/webhooks';
import { isHttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';
import { parseDbTime } from '@/lib/datetime';
import Button from '@/components/Button.vue';
import Modal from '@/components/Modal.vue';
import Input from '@/components/Input.vue';
import Checkbox from '@/components/Checkbox.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();
const { t } = useI18n();

const webhooks = ref<Webhook[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

/** 选中的 webhook id — 控制侧栏显示. null = 没选 (默认空状态). */
const selectedId = ref<string | null>(null);

/** 正在编辑的 webhook id — 控制每个 card 底部的事件编辑面板展开. null = 都不编辑. */
const editingId = ref<string | null>(null);
/** 编辑面板的本地状态 — events 数组 + active 布尔. */
const editForm = reactive<{ events: string[]; active: boolean; saving: boolean }>({
  events: [],
  active: true,
  saving: false,
});

/** 删除二次确认 — pendingDelete 非空 = 弹窗显示. */
const pendingDelete = ref<Webhook | null>(null);

/** 创建 modal. */
const createOpen = ref<boolean>(false);
const createSaving = ref<boolean>(false);
const createForm = reactive<CreateWebhookBody>({
  name: '',
  url: '',
  events: [],
  secret: '',
  active: true,
});

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const selected = computed<Webhook | null>(() =>
  selectedId.value ? webhooks.value.find((w) => w.id === selectedId.value) ?? null : null,
);

const enabledCount = computed<number>(
  () => webhooks.value.filter((w) => w.active).length,
);

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await listWebhooks();
    webhooks.value = Array.isArray(list) ? list : [];
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('misc.webhooks.loadFailedHttp', { status: e.status });
    } else if (e instanceof Error) {
      error.value = t('misc.webhooks.errNetwork', { msg: e.message });
    } else {
      error.value = t('misc.webhooks.loadFailed');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function onRetry(): void {
  retrying.value = true;
  void refresh();
}

onMounted(() => {
  void refresh();
});

/* ------------------------------------------------------------------ */
/*  选中 / 编辑                                                        */
/* ------------------------------------------------------------------ */

function selectWebhook(w: Webhook): void {
  selectedId.value = w.id;
  // 切换选中 = 取消当前编辑 (避免编辑面板跨卡片状态泄漏).
  if (editingId.value && editingId.value !== w.id) {
    editingId.value = null;
  }
}

function startEdit(w: Webhook): void {
  editingId.value = w.id;
  editForm.events = [...w.events];
  editForm.active = w.active;
  editForm.saving = false;
}

function cancelEdit(): void {
  editingId.value = null;
}

function toggleEditEvent(ev: string): void {
  editForm.events = editForm.events.includes(ev)
    ? editForm.events.filter((e) => e !== ev)
    : [...editForm.events, ev];
}

async function saveEdit(): Promise<void> {
  if (!editingId.value) return;
  if (editForm.events.length === 0) {
    toast.error(t('misc.webhooks.errEventRequired'));
    return;
  }
  editForm.saving = true;
  const targetId = editingId.value;
  try {
    const body: UpdateWebhookBody = {
      events: editForm.events,
      active: editForm.active,
    };
    const updated = await updateWebhook(targetId, body);
    const idx = webhooks.value.findIndex((w) => w.id === targetId);
    if (idx >= 0) webhooks.value[idx] = updated;
    editingId.value = null;
    toast.success(t('misc.webhooks.saved'));
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('misc.webhooks.saveFailedHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('misc.webhooks.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('misc.webhooks.saveFailed'));
    }
  } finally {
    editForm.saving = false;
  }
}

/* ------------------------------------------------------------------ */
/*  创建 modal                                                          */
/* ------------------------------------------------------------------ */

function openCreate(): void {
  createForm.name = '';
  createForm.url = '';
  createForm.events = [];
  createForm.secret = '';
  createForm.active = true;
  createOpen.value = true;
}

function closeCreate(): void {
  if (createSaving.value) return;
  createOpen.value = false;
}

function toggleCreateEvent(ev: string): void {
  createForm.events = createForm.events.includes(ev)
    ? createForm.events.filter((e) => e !== ev)
    : [...createForm.events, ev];
}

async function submitCreate(): Promise<void> {
  const name = createForm.name.trim();
  const url = createForm.url.trim();
  const secret = createForm.secret.trim();
  if (!name) {
    toast.error(t('misc.webhooks.errNameRequired'));
    return;
  }
  if (!url) {
    toast.error(t('misc.webhooks.errUrlRequired'));
    return;
  }
  if (!/^https?:\/\//.test(url)) {
    toast.error(t('misc.webhooks.errUrlProtocol'));
    return;
  }
  if (!secret) {
    toast.error(t('misc.webhooks.errSecretRequired'));
    return;
  }
  if (createForm.events.length === 0) {
    toast.error(t('misc.webhooks.errEventRequired'));
    return;
  }
  createSaving.value = true;
  try {
    const created = await createWebhook({
      name,
      url,
      secret,
      events: createForm.events,
      active: createForm.active,
    });
    webhooks.value = [created, ...webhooks.value];
    createOpen.value = false;
    toast.success(t('misc.webhooks.created'));
    // 自动选中新创建的 webhook, 方便立即看投递历史入口.
    selectedId.value = created.id;
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('misc.webhooks.createFailedHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('misc.webhooks.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('misc.webhooks.createFailed'));
    }
  } finally {
    createSaving.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  删除                                                                */
/* ------------------------------------------------------------------ */

function askDelete(w: Webhook): void {
  pendingDelete.value = w;
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    await deleteWebhook(target.id);
    webhooks.value = webhooks.value.filter((w) => w.id !== target.id);
    if (selectedId.value === target.id) selectedId.value = null;
    if (editingId.value === target.id) editingId.value = null;
    toast.success(t('misc.webhooks.deleted'));
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('misc.webhooks.deleteFailedHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('misc.webhooks.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('misc.webhooks.deleteFailed'));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  跳转 Next 投递历史                                                  */
/* ------------------------------------------------------------------ */

/** 当前选中 webhook 不存在 (e.g. 删除后) → 跳转禁用. */
function canOpenHistory(): boolean {
  return selected.value !== null;
}

function openHistory(): void {
  const w = selected.value;
  if (!w) return;
  // Next.js detail 页 (master 已有) — 当前 SPA 没暴露 /api/webhooks/[id]/deliveries,
  // 故走 Next 详情页拿历史 (sheet R25 红线 = 不动 backend, 单 SPA glue).
  window.open(`/webhooks/${w.id}`, '_blank', 'noopener,noreferrer');
}

/* ------------------------------------------------------------------ */
/*  格式化                                                              */
/* ------------------------------------------------------------------ */

function fmt(iso: string): string {
  try {
    // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
    return parseDbTime(iso)?.toLocaleString('zh-CN', { hour12: false }) ?? iso;
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="webhooks-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('misc.webhooks.title') }}</h1>
        <p class="page-subtitle">
          {{ t('misc.webhooks.subtitleA') }}
          <code class="inline-code">X-Signature</code>
          {{ t('misc.webhooks.subtitleB') }}
        </p>
      </div>
      <div class="header-meta">
        <span class="meta-count">{{ t('misc.webhooks.enabledCount', { n: enabledCount, total: webhooks.length }) }}</span>
        <Button variant="primary" @click="openCreate">{{ t('misc.webhooks.newBtn') }}</Button>
      </div>
    </header>

    <!-- Body — 左右分栏: 列表 + 侧栏 -->
    <div class="page-body-inner">
        <div class="list-column">
            <div v-if="loading && webhooks.length === 0" class="loading-block">
              <Loading size="lg" />
              <p class="loading-text">{{ t('misc.webhooks.loading') }}</p>
            </div>

            <ErrorView
              v-else-if="error"
              :title="t('misc.webhooks.loadFailed')"
              :description="error"
              variant="error"
              :retrying="retrying"
              @retry="onRetry"
            />

            <Empty
              v-else-if="webhooks.length === 0"
              :title="t('misc.webhooks.emptyTitle')"
              :description="t('misc.webhooks.emptyDesc')"
              illustration="inbox"
            >
              <template #cta>
                <Button variant="primary" size="sm" @click="openCreate">{{ t('misc.webhooks.newBtn') }}</Button>
              </template>
            </Empty>

            <div v-else class="card-list">
              <article
                v-for="w in webhooks"
                :key="w.id"
                :class="['webhook-card', { 'webhook-card-selected': selectedId === w.id }]"
                @click="selectWebhook(w)"
              >
                <div class="card-top">
                  <div class="card-title-row">
                    <h3 class="card-title">{{ w.name }}</h3>
                    <span :class="['chip', w.active ? 'chip-active' : 'chip-inactive']">
                      {{ w.active ? t('misc.webhooks.statusActive') : t('misc.webhooks.statusDisabled') }}
                    </span>
                    <span v-if="!w.has_secret" class="chip chip-warn" :title="t('misc.webhooks.noSecretTitle')">
                      {{ t('misc.webhooks.noSecret') }}
                    </span>
                  </div>
                  <div class="card-actions" @click.stop>
                    <!-- R55.2 B420: 详情 / 投递历史 卡片入口 — 镜像 master webhooks-client.tsx:185.
                         router-link (非 button) 以支持中键 / 右键菜单 / 复制链接.
                         侧栏的 window.open 仍保留作为辅助入口 (对没暴露 /[id]/deliveries 端点的过渡期),
                         但卡片本身应当走 SPA 内跳转. -->
                    <router-link
                      :to="`/webhooks/${w.id}`"
                      class="link-btn small"
                    >
                      {{ t('misc.webhooks.detailLink') }}
                    </router-link>
                    <Button
                      v-if="editingId !== w.id"
                      size="sm"
                      variant="secondary"
                      @click="startEdit(w)"
                    >
                      {{ t('misc.webhooks.edit') }}
                    </Button>
                    <Button
                      v-else
                      size="sm"
                      variant="ghost"
                      @click="cancelEdit"
                    >
                      {{ t('misc.webhooks.cancel') }}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      :disabled="editingId === w.id"
                      @click="askDelete(w)"
                    >
                      {{ t('misc.webhooks.delete') }}
                    </Button>
                  </div>
                </div>

                <code class="card-url">{{ w.url }}</code>

                <div class="card-events">
                  <span v-if="w.events.length === 0" class="muted small">{{ t('misc.webhooks.noEvents') }}</span>
                  <span
                    v-for="ev in w.events"
                    :key="ev"
                    class="event-chip"
                  >{{ ev }}</span>
                </div>

                <div class="card-meta">
                  <span class="meta-item">
                    {{ t('misc.webhooks.createdAt') }} <span class="meta-value">{{ fmt(w.created_at) }}</span>
                  </span>
                </div>

                <!-- 内联编辑面板 (events + active) -->
                <div v-if="editingId === w.id" class="edit-panel" @click.stop>
                  <div class="edit-label">{{ t('misc.webhooks.eventSubscription') }}</div>
                  <div class="event-grid">
                    <label
                      v-for="ev in WEBHOOK_EVENTS"
                      :key="ev"
                      class="event-toggle"
                    >
                      <Checkbox
                        :model-value="editForm.events.includes(ev)"
                        @update:model-value="() => toggleEditEvent(ev)"
                      />
                      <span class="event-toggle-name">{{ ev }}</span>
                    </label>
                  </div>
                  <label class="active-toggle">
                    <Checkbox v-model="editForm.active" />
                    <span>{{ t('misc.webhooks.statusActive') }}</span>
                  </label>
                  <div class="edit-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      :loading="editForm.saving"
                      :disabled="editForm.saving"
                      @click="saveEdit"
                    >
                      {{ t('misc.webhooks.save') }}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      :disabled="editForm.saving"
                      @click="cancelEdit"
                    >
                      {{ t('misc.webhooks.cancel') }}
                    </Button>
                  </div>
                  <p class="edit-info">
                    {{ t('misc.webhooks.editInfo') }}
                  </p>
                </div>
              </article>
            </div>
          </div>

          <!-- 侧栏: 选中 webhook 的元信息 + 投递历史跳转入口 -->
          <aside class="sidebar-column">
            <div v-if="!selected" class="sidebar-empty">
              <Empty
                :title="t('misc.webhooks.sidebarEmptyTitle')"
                :description="t('misc.webhooks.sidebarEmptyDesc')"
                illustration="doc"
                size="sm"
              />
            </div>
            <div v-else class="sidebar-card">
              <div class="sidebar-head">
                <h3 class="sidebar-title">{{ selected.name }}</h3>
                <span :class="['chip', selected.active ? 'chip-active' : 'chip-inactive']">
                  {{ selected.active ? t('misc.webhooks.statusActive') : t('misc.webhooks.statusDisabled') }}
                </span>
              </div>

              <dl class="sidebar-dl">
                <dt>URL</dt>
                <dd><code class="mono break-all">{{ selected.url }}</code></dd>
                <dt>Secret</dt>
                <dd>
                  <span v-if="selected.has_secret" class="badge-ok">{{ t('misc.webhooks.secretConfigured') }}</span>
                  <span v-else class="badge-warn">{{ t('misc.webhooks.secretMissing') }}</span>
                </dd>
                <dt>{{ t('misc.webhooks.eventSubscription') }}</dt>
                <dd>
                  <div v-if="selected.events.length === 0" class="muted small">{{ t('misc.webhooks.noSubscription') }}</div>
                  <div v-else class="event-list">
                    <span v-for="ev in selected.events" :key="ev" class="event-chip">{{ ev }}</span>
                  </div>
                </dd>
                <dt>{{ t('misc.webhooks.createdAtShort') }}</dt>
                <dd class="mono">{{ fmt(selected.created_at) }}</dd>
              </dl>

              <div class="sidebar-section">
                <h4 class="sidebar-subtitle">{{ t('misc.webhooks.deliveryHistory') }}</h4>
                <p class="sidebar-help">
                  {{ t('misc.webhooks.historyHelpA') }}
                  <code class="inline-code">/api/webhooks/[id]/deliveries</code>
                  {{ t('misc.webhooks.historyHelpB') }}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  :disabled="!canOpenHistory()"
                  @click="openHistory"
                >
                  {{ t('misc.webhooks.openHistoryBtn') }}
                </Button>
              </div>
            </div>
          </aside>
      </div>
    </div>

    <!-- 创建 modal (R5) -->
    <Modal
      :model-value="createOpen"
      :title="t('misc.webhooks.createTitle')"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeCreate(); }"
    >
      <div class="create-form">
        <div class="form-row">
          <label class="form-label">{{ t('misc.webhooks.labelName') }} <span class="required">*</span></label>
          <Input v-model="createForm.name" :placeholder="t('misc.webhooks.placeholderName')" />
        </div>
        <div class="form-row">
          <label class="form-label">URL <span class="required">*</span></label>
          <Input
            v-model="createForm.url"
            placeholder="https://example.com/hook"
            class-name="form-mono"
          />
          <p class="form-hint">{{ t('misc.webhooks.hintUrl') }}</p>
        </div>
        <div class="form-row">
          <label class="form-label">Secret <span class="required">*</span></label>
          <Input
            v-model="createForm.secret"
            :placeholder="t('misc.webhooks.placeholderSecret')"
            class-name="form-mono"
          />
          <p class="form-hint">{{ t('misc.webhooks.hintImmutable') }}</p>
        </div>
        <div class="form-row">
          <label class="form-label">{{ t('misc.webhooks.labelEvents') }} <span class="required">*</span> {{ t('misc.webhooks.labelEventsMin') }}</label>
          <div class="event-grid event-grid-modal">
            <label
              v-for="ev in WEBHOOK_EVENTS"
              :key="ev"
              class="event-toggle"
            >
              <Checkbox
                :model-value="createForm.events.includes(ev)"
                @update:model-value="() => toggleCreateEvent(ev)"
              />
              <span class="event-toggle-name">{{ ev }}</span>
            </label>
          </div>
        </div>
        <div class="form-row form-row-inline">
          <Checkbox v-model="createForm.active" />
          <span>{{ t('misc.webhooks.enableNow') }}</span>
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" :disabled="createSaving" @click="closeCreate">{{ t('misc.webhooks.cancel') }}</Button>
        <Button :loading="createSaving" :disabled="createSaving" @click="submitCreate">{{ t('misc.webhooks.create') }}</Button>
      </template>
    </Modal>

    <!-- 删除二次确认 (R6) -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="t('misc.webhooks.deleteTitle')"
      :message="pendingDelete
        ? t('misc.webhooks.deleteConfirmMsg', { name: pendingDelete.name })
        : ''"
      :confirm-text="t('misc.webhooks.delete')"
      :cancel-text="t('misc.webhooks.cancel')"
      type="danger"
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    />
</template>

<style scoped>
.webhooks-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

/* Header */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.header-text { min-width: 0; }
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}
.page-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 12px;
}
.header-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
/* R59+: header-meta 内所有交互元素统一 30px (跟 Button / .quick-link /
   .sort-select 等同档). 之前 font 13px + padding 4px 12px 自然高 ~22-24px,
   比 Button 30px 矮. 现在 inline-flex + height:30px + padding:0 12px +
   align-items:center, 文本垂直居中. */
.meta-count {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: var(--color-bg);
  border-radius: 999px;
  box-sizing: border-box;
}

/* Body */
.page-body { flex: 1; }
.page-body-inner {
  display: flex;
  gap: 16px;
  padding: 20px 24px 32px;
  align-items: flex-start;
}

/* 列表列 */
.list-column {
  flex: 1;
  min-width: 0;
}
.loading-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}
.loading-text {
  margin: 0;
  font-size: 14px;
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.webhook-card {
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.webhook-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}
.webhook-card-selected {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
}
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.card-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}
.card-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}
.link-btn {
  color: var(--tw-gray-500);
  text-decoration: none;
  font-size: 12px;
  cursor: pointer;
}
.link-btn:hover { color: var(--tw-blue-600); text-decoration: underline; }
.link-btn.small { font-size: 12px; }
.card-url {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
  background: var(--color-bg);
  padding: 4px 8px;
  border-radius: var(--radius);
}
.card-events {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  align-items: center;
}
.card-meta {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.meta-item { display: inline-flex; align-items: center; gap: 4px; }
.meta-value { color: var(--color-text); font-variant-numeric: tabular-nums; }

/* Chips */
.chip {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  background: var(--color-bg);
  color: var(--color-text-muted);
}
.chip-active { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.chip-inactive { background: var(--tw-gray-100); color: var(--tw-gray-500); }
.chip-warn { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.event-chip {
  display: inline-block;
  padding: 2px 9px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--tw-blue-50);
  color: var(--tw-blue-700);
  border-radius: 999px;
}

/* Edit panel */
.edit-panel {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.edit-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
.event-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px 12px;
}
.event-grid-modal {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.event-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.event-toggle-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--color-text);
}
.active-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.edit-actions {
  display: flex;
  gap: 8px;
}
.edit-info {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  padding: 6px 8px;
  background: var(--tw-yellow-100);
  border-radius: var(--radius);
}

/* 侧栏 */
.sidebar-column {
  width: 320px;
  flex-shrink: 0;
  position: sticky;
  top: 20px;
}
.sidebar-empty {
  padding: 24px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.sidebar-card {
  padding: 16px 18px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sidebar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sidebar-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  word-break: break-all;
  flex: 1;
  min-width: 0;
}
.sidebar-dl {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 12px;
  font-size: 12px;
}
.sidebar-dl dt {
  color: var(--color-text-muted);
  padding-top: 2px;
}
.sidebar-dl dd {
  margin: 0;
  color: var(--color-text);
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.break-all { word-break: break-all; }
.badge-ok {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--tw-emerald-100);
  color: var(--tw-emerald-800);
}
.badge-warn {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--tw-amber-100);
  color: var(--tw-amber-800);
}
.event-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sidebar-section {
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sidebar-subtitle {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.sidebar-help {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.muted { color: var(--color-text-muted); }
.small { font-size: 12px; }

/* Create form */
.create-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-row-inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.form-label {
  font-size: 13px;
  color: var(--color-text);
}
.form-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}
.required { color: var(--tw-red-600); margin-left: 2px; }
:deep(.form-mono input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>