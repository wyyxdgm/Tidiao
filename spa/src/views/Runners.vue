<script setup lang="ts">
/* 功能: Runner 管理视图 — 对应 Next src/app/runners/runners-client.tsx.
   sheet R32 字面要求 = "GET /api/runners 列表 + echo 状态 + 项目绑定".
   Next 端的核心 4 个动作 (列 / 注册 / 删除 / 健康检查) 在 SPA 端 1:1 复刻, 注册成功弹
   一次性 token modal (关掉就看不到), 删走 R6 ConfirmDialog (type=danger), 健康检查
   走 loading 遮罩防连点.

   关注点 (sheet R32 + 与现实分歧):
   - admin gating: Next 端 page.tsx 是 server component, 非 admin 直接 redirect("/").
     SPA 没有 server redirect, 改在 client 端: fetch /api/runners 拿到 401 "admin only"
     时, ErrorView 渲染"需要 admin 权限" + "用 admin 账号重新登录"提示 (不弹通用加载
     失败 — 与 Next "看不见这条限制原因" 比起来, 这条对非 admin 用户更友好).
     auth store 拿到 user.role 后在表单区域前置 disabled + 提示, 避免无谓请求.
   - 注册表单字段对齐 master createRunner 后端校验: name.trim().min(1) + host.trim()
     .min(1) + port 是 1-65535 整数 (客户端先验一遍, 失败 toast.error 走前端轻校验,
     后端再验一遍权威).
   - token modal 用本地 state, 关掉立刻清空 (不写 store / 不写 localStorage) —
     与 Next runners-client.tsx:75-77 "token 仅此一次" 同款安全模型.
   - capabilities 列展示能力摘要: 后端 capabilities 字段是 JSON 字符串 (含 shells /
     max_concurrent), UI 解析后展示为 `shells=bash,zsh · max=4`, 解析失败兜底原
     字符串 (≤40 字符截断). 与 Next parseCapabilities 同款.
   - 健康检查走 POST /api/runners/[id]/health, 后端返 { ok, health: <JSON text> }.
     UI 把 health 字段 JSON.parse → 格式化展示在 toast.info 里 (与 Next
     runners-client.tsx:165-172 toast.info('「name」健康检查\n<text>') 同款), 失败
     走 toast.error. */
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import {
  listRunners,
  createRunner,
  deleteRunner,
  healthCheckRunner,
  OS_OPTIONS,
  type Runner,
  type OsType,
} from '@/api/runners';
import { isHttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Modal from '@/components/Modal.vue';
import Input from '@/components/Input.vue';
import Select from '@/components/Select.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

const auth = useAuthStore();
const toast = useToast();

const isAdmin = computed<boolean>(() => auth.user?.role === 'admin');

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const runners = ref<Runner[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);
/** 401 admin-only 单独标记 — ErrorView 文案分叉. */
const adminOnly = ref<boolean>(false);

/** 注册表单本地 state. */
const creating = ref<boolean>(false);
const formName = ref<string>('');
const formHost = ref<string>('');
const formPort = ref<string>('');
const formOsType = ref<OsType>('macos');

/** token modal 状态 — token 存组件本地 ref, 关掉立刻清空, 不持久化. */
const tokenModalOpen = ref<boolean>(false);
const tokenValue = ref<string>('');
const tokenRunnerName = ref<string>('');
const tokenCopied = ref<boolean>(false);

/** 删除二次确认. */
const pendingDelete = ref<Runner | null>(null);

/** 健康检查 loading 标记 (避免连点) — 记录正在检查的 runner id. */
const healthLoadingId = ref<string | null>(null);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<Runner['status'], string> = {
  online: 'chip-online',
  offline: 'chip-offline',
  dead: 'chip-dead',
};

const STATUS_LABELS: Record<Runner['status'], string> = {
  online: '在线',
  offline: '离线',
  dead: '失联',
};

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  adminOnly.value = false;
  try {
    const resp = await listRunners();
    runners.value = Array.isArray(resp.runners) ? resp.runners : [];
  } catch (e: unknown) {
    if (isHttpError(e)) {
      if (e.status === 401) {
        // admin gating: 后端拒绝非 admin. UI 层友好提示而非通用 "加载失败".
        adminOnly.value = true;
        error.value = e.message || '需要 admin 权限';
      } else {
        error.value = e.message || `加载失败 (HTTP ${e.status})`;
      }
    } else if (e instanceof Error) {
      error.value = `网络异常: ${e.message}`;
    } else {
      error.value = '加载失败';
    }
    runners.value = [];
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
/*  注册                                                                */
/* ------------------------------------------------------------------ */

function resetForm(): void {
  formName.value = '';
  formHost.value = '';
  formPort.value = '';
  formOsType.value = 'macos';
}

async function handleRegister(): Promise<void> {
  const name = formName.value.trim();
  const host = formHost.value.trim();
  const portNum = Number(formPort.value);
  if (!name) {
    toast.error('name 必填');
    return;
  }
  if (!host) {
    toast.error('host 必填');
    return;
  }
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    toast.error('port 必须是 1-65535 整数');
    return;
  }
  creating.value = true;
  try {
    const resp = await createRunner({
      name,
      host,
      port: portNum,
      os_type: formOsType.value,
    });
    // token 进 modal-local state, 关掉就清空 (不持久化).
    tokenRunnerName.value = resp.runner.name;
    tokenValue.value = resp.token;
    tokenCopied.value = false;
    tokenModalOpen.value = true;
    resetForm();
    await refresh();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      if (e.status === 409) {
        // 后端 code=DUPLICATE_HOST_PORT → 直接给后端 message ("已注册同 host:port").
        toast.error(e.message || `已注册同 host:port (${host}:${portNum})`);
      } else if (e.status === 401) {
        toast.error('需要 admin 权限');
      } else {
        toast.error(e.message || `注册失败 (HTTP ${e.status})`);
      }
    } else if (e instanceof Error) {
      toast.error(`注册失败: ${e.message}`);
    } else {
      toast.error('注册失败');
    }
  } finally {
    creating.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  token modal                                                         */
/* ------------------------------------------------------------------ */

function closeTokenModal(): void {
  tokenModalOpen.value = false;
  // 清空 token, 避免 React DevTools / Vue DevTools / 截图残留.
  tokenValue.value = '';
  tokenRunnerName.value = '';
  tokenCopied.value = false;
}

async function copyToken(): Promise<void> {
  if (!tokenValue.value) return;
  try {
    await navigator.clipboard.writeText(tokenValue.value);
    tokenCopied.value = true;
    toast.success('Token 已复制到剪贴板');
  } catch {
    toast.error('复制失败，请手动选中复制');
  }
}

/* ------------------------------------------------------------------ */
/*  删除                                                                */
/* ------------------------------------------------------------------ */

function askDelete(r: Runner): void {
  pendingDelete.value = r;
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    await deleteRunner(target.id);
    runners.value = runners.value.filter((r) => r.id !== target.id);
    toast.success(`已删除 runner「${target.name}」`);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || `删除失败 (HTTP ${e.status})`);
    } else if (e instanceof Error) {
      toast.error(`删除失败: ${e.message}`);
    } else {
      toast.error('删除失败');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  健康检查                                                            */
/* ------------------------------------------------------------------ */

async function handleHealthCheck(r: Runner): Promise<void> {
  healthLoadingId.value = r.id;
  try {
    const resp = await healthCheckRunner(r.id);
    // resp.health 是 runner 的 /v1/health JSON 字符串. JSON.parse 失败兜底原串.
    const formatted = (() => {
      try {
        return JSON.stringify(JSON.parse(resp.health), null, 2);
      } catch {
        return resp.health || '(空)';
      }
    })();
    toast.info(`「${r.name}」健康检查\n${formatted}`);
    await refresh();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || `健康检查失败 (HTTP ${e.status})`);
    } else if (e instanceof Error) {
      toast.error(`健康检查失败: ${e.message}`);
    } else {
      toast.error('健康检查失败');
    }
  } finally {
    healthLoadingId.value = null;
  }
}

/* ------------------------------------------------------------------ */
/*  格式化                                                              */
/* ------------------------------------------------------------------ */

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  // R211: last_heartbeat_at 是 SQLite 裸 UTC 串, parseDbTime 补 Z 当 UTC 解析
  // (旧 new Date(iso) 按本地时区解析, CST 偏早 8h).
  const d = parseDbTime(iso);
  if (!d) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function parseCapabilities(raw: string | null): string {
  if (!raw) return '—';
  try {
    const obj = JSON.parse(raw);
    const parts: string[] = [];
    if (Array.isArray(obj.shells)) parts.push(`shells=${obj.shells.join(',')}`);
    if (typeof obj.max_concurrent === 'number') parts.push(`max=${obj.max_concurrent}`);
    return parts.length > 0 ? parts.join(' · ') : '—';
  } catch {
    return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  }
}
</script>

<template>
  <div class="runners-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">Runners</h1>
        <p class="page-subtitle">
          跨机器白名单命令的远程执行 daemon。每条 runner = 一台目标机上一个独立的
          <code class="inline-code">agent-orch-runner</code>
          进程, 用 256-bit token 鉴权心跳。MVP 手动起 (不进 launchd / Windows service)。
        </p>
        <p v-if="!isAdmin" class="role-hint">
          ⚠️ 当前账号不是 admin，注册/删除/健康检查会被后端拒绝 (HTTP 401)。
        </p>
      </div>
    </header>

    <!-- Body -->
    <main class="page-body">
      <!-- 注册表单 -->
      <section class="card">
        <div class="section-title">注册 Runner</div>
        <div class="register-grid">
          <label class="form-field">
            <span class="form-label">name</span>
            <Input
              v-model="formName"
              placeholder="mac-build"
              :disabled="!isAdmin"
            />
          </label>
          <label class="form-field">
            <span class="form-label">host (IP 或域名)</span>
            <Input
              v-model="formHost"
              placeholder="192.168.3.243"
              :disabled="!isAdmin"
              class-name="mono-input"
            />
          </label>
          <label class="form-field form-field-port">
            <span class="form-label">port</span>
            <Input
              v-model="formPort"
              placeholder="8081"
              :disabled="!isAdmin"
              class-name="mono-input"
            />
          </label>
          <label class="form-field form-field-os">
            <span class="form-label">os_type</span>
            <Select
              :model-value="formOsType"
              :options="OS_OPTIONS"
              :disabled="!isAdmin"
              @update:model-value="(v: string | null) => { if (v) formOsType = v as OsType; }"
            />
          </label>
          <div class="form-field form-field-action">
            <Button
              variant="primary"
              :loading="creating"
              :disabled="creating || !isAdmin"
              @click="handleRegister"
            >
              注册
            </Button>
          </div>
        </div>
        <p class="form-warning">
          🔴 注册成功后弹窗一次性显示 token, 关掉就没了, 请立刻拷给运维在目标机上配
          <code class="inline-code">~/.agent-orch-runner/config.json</code>。
          port 不要暴露到公网; agent 跑的是白名单命令, 但 token 是 shared secret,
          一旦泄露 = 这台机器被任意执行白名单命令。
        </p>
      </section>

      <!-- 列表 -->
      <section class="card">
        <div class="section-head">
          <div class="section-title">已注册 Runner</div>
          <Button size="sm" variant="ghost" :disabled="loading" @click="refresh">
            刷新
          </Button>
        </div>

        <div v-if="loading && runners.length === 0" class="loading-block">
          <Loading size="md" />
          <p class="loading-text">加载中…</p>
        </div>

        <ErrorView
          v-else-if="adminOnly"
          title="需要 admin 权限"
          description="Runners 页只对 admin 开放 — 注册/删除/健康检查都是跨用户基础设施动作。请用 admin 账号登录后访问。"
          variant="warning"
          :retrying="retrying"
          @retry="onRetry"
        />

        <ErrorView
          v-else-if="error"
          title="加载失败"
          :description="error"
          variant="error"
          :retrying="retrying"
          @retry="onRetry"
        />

        <Empty
          v-else-if="runners.length === 0"
          title="还没有注册任何 runner"
          description="填一下上方表单, 注册一台目标机的 daemon。"
          illustration="inbox"
        />

        <div v-else class="table-wrap">
          <table class="runners-table">
            <thead>
              <tr>
                <th class="col-name">name</th>
                <th class="col-hostport">host:port</th>
                <th class="col-os">os</th>
                <th class="col-status">状态</th>
                <th class="col-heartbeat">last_heartbeat</th>
                <th class="col-cap">capabilities</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in runners" :key="r.id">
                <td class="col-name"><span class="cell-strong">{{ r.name }}</span></td>
                <td class="col-hostport"><code class="cell-mono">{{ r.host }}:{{ r.port }}</code></td>
                <td class="col-os"><span class="cell-muted">{{ r.os_type }}</span></td>
                <td class="col-status">
                  <span :class="['status-chip', STATUS_COLORS[r.status]]">
                    {{ STATUS_LABELS[r.status] }}
                  </span>
                </td>
                <td class="col-heartbeat"><span class="cell-mono cell-muted">{{ formatTime(r.last_heartbeat_at) }}</span></td>
                <td
                  class="col-cap"
                  :title="r.last_health_json || ''"
                >
                  <span class="cell-mono cell-muted cell-cap">{{ parseCapabilities(r.capabilities || r.last_health_json) }}</span>
                </td>
                <td class="col-actions">
                  <div class="row-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      :loading="healthLoadingId === r.id"
                      :disabled="!!healthLoadingId || !isAdmin"
                      @click="handleHealthCheck(r)"
                    >
                      健康检查
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      :disabled="!isAdmin"
                      @click="askDelete(r)"
                    >
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <!-- token modal (R5) — 一次性显示, 关掉清空. -->
    <Modal
      :model-value="tokenModalOpen"
      title="🔑 Runner 注册成功"
      size="md"
      @update:model-value="(v: boolean) => { if (!v) closeTokenModal(); }"
    >
      <div class="token-body">
        <p class="token-intro">
          Runner <strong>「{{ tokenRunnerName }}」</strong> 的
          <strong>一次性 token</strong>, 关掉这个弹窗 token 就看不到了。
          把它写到目标机的
          <code class="inline-code">~/.agent-orch-runner/config.json</code>
          (文件权限 <code class="inline-code">0600</code>) 里, 然后
          <code class="inline-code">./runner --daemon</code> 起。
        </p>
        <div class="token-display">
          <code class="token-text">{{ tokenValue }}</code>
        </div>
        <p class="token-tip">
          🔴 关掉弹窗 = token 永远丢失，需重新注册。
        </p>
      </div>
      <template #footer>
        <Button variant="secondary" @click="closeTokenModal">关闭 (token 不再可见)</Button>
        <Button variant="primary" :disabled="!tokenValue" @click="copyToken">
          {{ tokenCopied ? '已复制 ✓' : '复制 token' }}
        </Button>
      </template>
    </Modal>

    <!-- 删除二次确认 (R6) -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="`删除 runner「${pendingDelete?.name ?? ''}」`"
      :message="pendingDelete
        ? `确定要删除吗？同时会撤销它的 token, 已配置的 daemon 下次心跳会 401。host:port (${pendingDelete.host}:${pendingDelete.port}) 之后可以重新注册。`
        : ''"
      confirm-text="删除"
      cancel-text="取消"
      type="danger"
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    />

    <!-- 健康检查 loading 遮罩 (避免连点) -->
    <div v-if="healthLoadingId" class="health-overlay">
      <div class="health-overlay-card">
        <Loading size="sm" />
        <span>正在调用 /v1/health …</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/* Base                                                                */
/* ------------------------------------------------------------------ */
.runners-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}
.page-header {
  flex-shrink: 0;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  padding: 18px 24px 14px;
}
.header-text {
  max-width: 1024px;
}
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
  line-height: 1.6;
}
.inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 12px;
}
.role-hint {
  margin: 8px 0 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--tw-amber-800);
  background: var(--tw-amber-100);
  border-radius: var(--radius);
  display: inline-block;
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */
.page-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 32px;
  max-width: 1024px;
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 16px 18px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

/* ------------------------------------------------------------------ */
/* Register form                                                       */
/* ------------------------------------------------------------------ */
.register-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 120px 140px auto;
  gap: 12px;
  align-items: end;
  margin-top: 12px;
}
@media (max-width: 900px) {
  .register-grid {
    grid-template-columns: 1fr 1fr;
  }
  .form-field-port, .form-field-os, .form-field-action {
    grid-column: span 1;
  }
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.form-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
:deep(.mono-input input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.form-field-action {
  align-self: end;
}
.form-warning {
  margin: 12px 0 0;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--tw-amber-800);
  background: var(--tw-amber-100);
  border-radius: var(--radius);
  line-height: 1.6;
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */
.loading-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  color: var(--color-text-muted);
}
.loading-text {
  margin: 0;
  font-size: 14px;
}
.table-wrap {
  overflow-x: auto;
  margin-top: 4px;
}
.runners-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.runners-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}
.runners-table th.col-actions {
  text-align: right;
}
.runners-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
  color: var(--color-text);
}
.runners-table tbody tr:last-child td {
  border-bottom: none;
}
.runners-table tbody tr:hover {
  background: var(--color-bg);
}
.cell-strong {
  font-weight: 600;
  color: var(--color-text);
}
.cell-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.cell-muted {
  color: var(--color-text-muted);
}
.cell-cap {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.col-name { min-width: 120px; }
.col-hostport { min-width: 160px; }
.col-os { min-width: 80px; }
.col-status { min-width: 80px; }
.col-heartbeat { min-width: 150px; }
.col-cap { min-width: 200px; }
.col-actions { min-width: 200px; text-align: right; white-space: nowrap; }

.row-actions {
  display: inline-flex;
  gap: 6px;
  justify-content: flex-end;
}

/* ------------------------------------------------------------------ */
/* Status chip                                                         */
/* ------------------------------------------------------------------ */
.status-chip {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
}
.chip-online {
  background: var(--tw-emerald-100);
  color: var(--tw-emerald-800);
}
.chip-offline {
  background: var(--tw-gray-100);
  color: var(--tw-gray-500);
}
.chip-dead {
  background: var(--tw-red-100);
  color: var(--tw-red-700);
}

/* ------------------------------------------------------------------ */
/* Token modal                                                         */
/* ------------------------------------------------------------------ */
.token-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.token-intro {
  margin: 0;
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.6;
}
.token-display {
  background: var(--tw-gray-900);
  border-radius: var(--radius);
  padding: 12px 14px;
  overflow-x: auto;
}
.token-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--tw-emerald-300);
  word-break: break-all;
  white-space: pre-wrap;
}
.token-tip {
  margin: 0;
  font-size: 12px;
  color: var(--tw-amber-800);
  background: var(--tw-amber-100);
  border-radius: var(--radius);
  padding: 8px 10px;
}

/* ------------------------------------------------------------------ */
/* Health overlay                                                      */
/* ------------------------------------------------------------------ */
.health-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.health-overlay-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  /* R206: 原 rgba(255,255,255,0.92) 在暗色下留白底 + 浅色文字 (不可读).
     改用主题变量, 两主题都保持一致. */
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  padding: 10px 16px;
  font-size: 13px;
  color: var(--color-text);
  box-shadow: var(--shadow-md);
}
</style>