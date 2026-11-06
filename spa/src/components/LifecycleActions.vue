<script setup lang="ts">
/* 功能: 任务生命周期操作按钮组 — 按 status 显隐 + 关键操作走 ConfirmDialog.

   与 Next src/app/tasks/[id]/task-detail-client.tsx 的 statusActions + deleteButton
   同口径 (单槽位 actionLoading + variant 配色), 但封装到独立 SFC 便于挂在 R19
   TaskDetailView / M3 后续 SSE 面板 / Kanban 卡片行内复用. 设计原则:

   - 单槽位 actionLoading: 同 Next postAction 模式, 一时刻只允许一个 action 在飞,
     按 key (`start`/`pause`/`cancel`/`approve`/`refine`/`restart`/`await`/`unawait`/
     `delete`) 串行, 防止用户连点导致后端 race / 二次报错.
   - 关键操作 (cancel / delete) 走 ConfirmDialog (type='danger') — 与 sheet R21
     "关键操作走 R6 ConfirmDialog" 红线一致. 误点不致命, 但撤销代价高 (取消已
     running 的 task 可能丢半个会话; 删除是物理 delete + 软删标记), 必须二次确认.
   - 其他按钮直接发请求 (start/pause/approve/refine/restart/await/unawait) —
     这类都是 idempotent + 后端 status gate 兜底, 误点不致命.
   - 操作成功后 emit('changed', newStatus) — 父组件 (TaskDetailView) 据此重新
     fetch 详情; 失败 toast.error + 不 emit. 兼容 409 (e.g. approve 被
     awaiting_owner_review gate 拦下) — toast 提示, 仍不 emit.

   🆕 R56-A4.8 (P1-1): refine / await / unawait 走三段 ConfirmDialog (master
     tdc.tsx:2992-3082 同款) — refine = optional message, await = 3 选 1 reason
     + optional note, unawait = 3 选 1 reason + optional note. 取代旧版默认
     body (decision_pending / agent_self_resolved).

   关注点:
   - sheet 列出的 API = POST /api/tasks/[id]/{start,pause,cancel,approve,refine,
     await,unawait}; 后端实际端点存在. R131 把 reject 换成 refine + 新加
     await/unawait, 已覆盖 sheet 全部意图.
   - canDeleteTask inline 实现 (R105 同口径): running 不允许 + deleted 不允许.
     不引 @/lib/constants — 当前 R21 红线只动本文件, 后续跨模块复用时再外提.
   - restart (🔄 清空重来): Next 版在 failed/cancelled/completed/rejected 都可点.
     本组件严格按 status 渲染 (rejected 单独分支), 与 Next 一致.
   - verifying 状态暂无对应 action (后端没 expose "verifying 完了 → ..." 按钮),
     渲染空集合. verifying 期间 UI 显示 Loading 由父组件负责.
   - 不引入新依赖. 复用 R7 Button + R6 ConfirmDialog + R4 Toast + R2 http. */
import { computed, reactive, ref } from 'vue';
import Button from '@/components/Button.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import IconSvg from '@/components/IconSvg.vue';
import { useToast } from '@/composables/useToast';
import { confirmTextFromLabel } from '@/lib/confirm-label';
import { api, del, isHttpError } from '@/api/http';
import { unsetAwaitingReview } from '@/api/tasks';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 11 个 TaskStatus — 与 R19 TaskDetailView / R15 TaskCard 同源, R131 加 await_user. */
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

interface Props {
  taskId: string;
  status: TaskStatus;
  deletedAt?: string | null;
  /** R52.3 (B219): 当前 task 的 awaiting_owner_review 标记. 1 = 后端 approve
      会被 409 gate 拦下, 必须先 unset-awaiting-review 再 approve. */
  awaitingOwnerReview?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  deletedAt: null,
  awaitingOwnerReview: false,
});

const emit = defineEmits<{
  (e: 'changed', newStatus: string): void;
  /** R52.9 (B251): paused 态点 ▶ 恢复执行 时改走 ResumeModal, 让父级
      打开弹窗收集 auto_approve/max_turns 再走 PATCH+POST /resume.
      这里不直接发 /start, 把触发交给父级 (TaskDetailView). */
  (e: 'open-resume'): void;
}>();

/* ------------------------------------------------------------------ */
/*  Action definition                                                  */
/* ------------------------------------------------------------------ */

type ActionKey =
  | 'start'
  | 'pause'
  | 'cancel'
  | 'approve'
  | 'refine'
  | 'restart'
  | 'await'
  | 'unawait'
  | 'delete'
  /** R52.9 (B251): sentry key, 不走 API, 走父级弹 ResumeModal. */
  | '__resume';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ActionDef {
  key: ActionKey;
  /** 图标类型 key, 渲染走 IconSvg 组件 (play/pause/check/refresh/x/trash).
      不是 emoji — 之前用 emoji 在不同 OS 渲染差别大, 跟整体设计风格不一致.
      mobile icon-only 模式 (lca-label display:none) 时仍可见. */
  icon: 'play' | 'pause' | 'check' | 'refresh' | 'x' | 'trash';
  /** 按钮文案 (不含 icon). */
  label: string;
  variant: ButtonVariant;
  /** 是否走 ConfirmDialog 二次确认. 关键操作 (cancel/delete/refine/await/unawait) 走 R6. */
  dangerous: boolean;
  /** POST body — undefined = 空 body. */
  body?: Record<string, unknown>;
  /** 成功 toast 文案 (≤ 30 字). */
  success: string;
}

/* ------------------------------------------------------------------ */
/*  Action map by status                                               */
/* ------------------------------------------------------------------ */

/** 按 status 返回按钮列表. refine/await/unawait 现在全部走 ConfirmDialog (P1-1),
    之前给的默认 body 删了 — 弹窗收集 reason/note. */
function actionsFor(status: TaskStatus): ActionDef[] {
  switch (status) {
    case 'pending':
      return [
        { key: 'start', icon: 'play', label: '启动', variant: 'primary', dangerous: false, success: '已启动' },
      ];
    case 'queued':
      return [
        { key: 'cancel', icon: 'x', label: '取消', variant: 'danger', dangerous: true, success: '已取消' },
      ];
    case 'running':
      return [
        { key: 'await', icon: 'pause', label: '等用户介入', variant: 'ghost', dangerous: true, success: '已切到等用户介入' },
        { key: 'pause', icon: 'pause', label: '暂停', variant: 'secondary', dangerous: false, success: '已暂停' },
        { key: 'cancel', icon: 'x', label: '取消', variant: 'danger', dangerous: true, success: '已取消' },
      ];
    case 'reviewing':
      return [
        // 「继续干」用 ▶ 跟其他 continue 类动作 (▶ 启动/▶ 恢复执行/▶ 继续执行) 同款语义.
        { key: 'refine', icon: 'play', label: '继续干', variant: 'primary', dangerous: true, success: '已继续' },
        { key: 'approve', icon: 'check', label: '完成', variant: 'primary', dangerous: false, success: '已标记完成' },
        { key: 'restart', icon: 'refresh', label: '清空重来', variant: 'secondary', dangerous: false, success: '已重新启动' },
      ];
    case 'await_user':
      return [
        { key: 'unawait', icon: 'play', label: '继续执行', variant: 'primary', dangerous: true, success: '已回到执行' },
        { key: 'approve', icon: 'check', label: '完成', variant: 'primary', dangerous: false, success: '已标记完成' },
        { key: 'cancel', icon: 'x', label: '取消', variant: 'danger', dangerous: true, success: '已取消' },
      ];
    case 'paused':
      // R52.9 (B251): 暂停态 "▶ 恢复执行" 改走 ResumeModal, 让用户在恢复前
      // 可调整 auto_approve / max_turns (master tdc.tsx:3682-3812 ResumeModal).
      // 父级 (TaskDetailView) 监听 open-resume 弹窗.
      return [
        { key: '__resume', icon: 'play', label: '恢复执行', variant: 'primary', dangerous: false, success: '已恢复' },
        { key: 'approve', icon: 'check', label: '已完成', variant: 'primary', dangerous: false, success: '已标记完成' },
        { key: 'cancel', icon: 'x', label: '取消', variant: 'danger', dangerous: true, success: '已取消' },
      ];
    case 'rejected':
      // 历史兼容: R131 之前写入的 rejected task. UI 给"继续执行" (start) + "已完成" (approve).
      return [
        { key: 'start', icon: 'play', label: '继续执行', variant: 'primary', dangerous: false, success: '已恢复' },
        { key: 'approve', icon: 'check', label: '已完成', variant: 'primary', dangerous: false, success: '已标记完成' },
      ];
    case 'failed':
    case 'cancelled':
    case 'completed':
      return [
        { key: 'restart', icon: 'refresh', label: '清空重来', variant: 'secondary', dangerous: false, success: '已重新启动' },
      ];
    case 'verifying':
      // 后端未 expose verifying 期间的对外 action. 不渲染任何按钮.
      return [];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/*  canDeleteTask — inline 版 (R105 同口径)                            */
/* ------------------------------------------------------------------ */

/** 允许删除的状态集. running 排除 (会打断正在跑的会话) + 软删后 (deleted_at 非空)
    排除 (已删不能再删, 让位 restore 路径). 跨模块复用时外提到 src/lib/constants. */
function canDeleteTask(status: TaskStatus, deletedAt: string | null | undefined): boolean {
  if (deletedAt) return false;
  if (status === 'running') return false;
  return true;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

/** 单一槽位记录当前在飞的 action. 与 Next actionLoading 同口径 (避免重复提交). */
const actionLoading = ref<ActionKey | null>(null);

/** ConfirmDialog 状态 — 关键操作 (cancel / delete / refine / await / unawait)
    弹窗前先 populate 这里. */
interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  pending: ActionDef | null;
}

const confirm = reactive<ConfirmState>({
  open: false,
  title: '',
  message: '',
  confirmText: '确认',
  pending: null,
});

/* R56-A4.8 (P1-1): refine / await / unawait 三段 ConfirmDialog (master
   tdc.tsx:2992-3082 同款). refine 收一条可选 message; await/unawait 各收
   3 选 1 reason + 可选 note. */
const refineOpen = ref<boolean>(false);
const refineMessage = ref<string>('');

const awaitOpen = ref<boolean>(false);
const awaitReason = ref<'dispatch_needed' | 'decision_pending' | 'suggestion'>('decision_pending');
const awaitNote = ref<string>('');

const unawaitOpen = ref<boolean>(false);
const unawaitReason = ref<'agent_self_resolved' | 'user_timeout' | 'external_event'>('agent_self_resolved');
const unawaitNote = ref<string>('');

const toast = useToast();

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 当前 status 对应的按钮集. */
const actions = computed<ActionDef[]>(() => actionsFor(props.status));

/** 是否展示删除按钮 — canDeleteTask 判定. */
const showDelete = computed<boolean>(() =>
  canDeleteTask(props.status, props.deletedAt),
);

/* ------------------------------------------------------------------ */
/*  Dispatch                                                           */
/* ------------------------------------------------------------------ */

/** 走 POST /api/tasks/[id]/<key> (body 可选) → 返回 { status: string }.
    delete 走 DELETE /api/tasks/[id] 单独处理 (无 body, 路径不同).
    approve 在 awaiting_owner_review=1 时先调 unset-awaiting-review 解 gate
    再 approve — 与 master task-detail-client.tsx:2985 ConfirmDialog →
    unsetAwaitingReview → 再次 approve 同款语义.
    '__resume' 是 R52.9 sentry: 不调 API, 走父级 open-resume. */
async function callApi(action: ActionDef, body?: Record<string, unknown>): Promise<string | null> {
  if (action.key === '__resume') {
    return null;
  }
  if (action.key === 'delete') {
    await del(`/api/tasks/${props.taskId}`);
    /* R230: 删除后必须 emit 信号 — 后端软删无 SSE 广播, return null 会让父级
       (chat 左列表 / 详情页) 完全无感知, 已删会话仍挂在列表里. 返回 'deleted'
       哨兵值 (非 TaskStatus), 父级 onStatusChanged 据此摘除/跳走. */
    return 'deleted';
  }
  if (action.key === 'approve' && props.awaitingOwnerReview) {
    await unsetAwaitingReview(props.taskId);
  }
  const res = await api<{ status?: string }>(`/api/tasks/${props.taskId}/${action.key}`, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.status ?? null;
}

/** 弹 ConfirmDialog 或直接执行. dangerous → confirm; '__resume' → emit
    open-resume 让父级弹 ResumeModal; 否则直接 dispatch. */
function dispatch(action: ActionDef): void {
  if (action.key === '__resume') {
    emit('open-resume');
    return;
  }
  // R56-A4.8 (P1-1): refine / await / unawait 走各自专用 dialog (master 同款).
  if (action.key === 'refine') {
    refineMessage.value = '';
    refineOpen.value = true;
    return;
  }
  if (action.key === 'await') {
    awaitNote.value = '';
    awaitReason.value = 'decision_pending';
    awaitOpen.value = true;
    return;
  }
  if (action.key === 'unawait') {
    unawaitNote.value = '';
    unawaitReason.value = 'agent_self_resolved';
    unawaitOpen.value = true;
    return;
  }
  if (action.dangerous) {
    confirm.title = action.key === 'cancel' ? '取消任务' : '删除任务';
    confirm.message =
      action.key === 'cancel'
        ? `确认取消此任务? 取消后已运行的部分不可恢复.`
        : `确认删除此任务? 删除后可通过 "恢复" 找回, 但历史记录不再展示.`;
    // 🔴 用 confirmTextFromLabel, 不要内联 /^[^\w]+/ —— \w 不含中文, 会把
    // '删除' / '取消' 整串剥空 (R213). 见 spa/src/lib/confirm-label.ts.
    confirm.confirmText = confirmTextFromLabel(action.label);
    confirm.pending = action;
    confirm.open = true;
    return;
  }
  void runAction(action);
}

/** ConfirmDialog confirm 触发后真正调 API. */
async function onConfirm(): Promise<void> {
  const action = confirm.pending;
  if (!action) return;
  confirm.open = false;
  confirm.pending = null;
  await runAction(action);
}

function onCancelConfirm(): void {
  confirm.open = false;
  confirm.pending = null;
}

/** R56-A4.8: 三段弹窗 confirm 处理 (master tdc.tsx:2992-3082 同款语义). */
async function onConfirmRefine(): Promise<void> {
  refineOpen.value = false;
  await runActionByKey('refine', { message: refineMessage.value });
}
function onCancelRefine(): void {
  refineOpen.value = false;
}

async function onConfirmAwait(): Promise<void> {
  awaitOpen.value = false;
  await runActionByKey('await', { reason: awaitReason.value, note: awaitNote.value });
}
function onCancelAwait(): void {
  awaitOpen.value = false;
}

async function onConfirmUnawait(): Promise<void> {
  unawaitOpen.value = false;
  await runActionByKey('unawait', { reason: unawaitReason.value, note: unawaitNote.value });
}
function onCancelUnawait(): void {
  unawaitOpen.value = false;
}

/** 实际执行 action: 设 loading → 调 API → toast 反馈 → emit('changed'). */
async function runAction(action: ActionDef): Promise<void> {
  actionLoading.value = action.key;
  try {
    const newStatus = await callApi(action);
    toast.success(action.success);
    if (newStatus) emit('changed', newStatus);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || `操作失败 (HTTP ${e.status})`);
    } else if (e instanceof Error) {
      toast.error(`网络异常: ${e.message}`);
    } else {
      toast.error('操作失败');
    }
  } finally {
    actionLoading.value = null;
  }
}

/** R56-A4.8: 弹窗式 refine/await/unawait 走专用入口 (带自定义 body). */
async function runActionByKey(key: ActionKey, body: Record<string, unknown>): Promise<void> {
  const def = actionsFor(props.status).find((a) => a.key === key);
  if (!def) return;
  actionLoading.value = key;
  try {
    const newStatus = await callApi(def, body);
    toast.success(def.success);
    if (newStatus) emit('changed', newStatus);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || `操作失败 (HTTP ${e.status})`);
    } else if (e instanceof Error) {
      toast.error(`网络异常: ${e.message}`);
    } else {
      toast.error('操作失败');
    }
  } finally {
    actionLoading.value = null;
  }
}
</script>

<template>
  <div class="lca-root">
    <!-- 状态操作按钮组 — icon + label 双 span, 1024 以下藏 label 只剩 icon
         (跟 .tsb-tbtn-text 1024px 断点一致). -->
    <div v-if="actions.length > 0" class="lca-group">
      <Button
        v-for="act in actions"
        :key="act.key"
        :variant="act.variant"
        size="mini"
        :class="act.key === 'approve' ? 'lca-btn-approve' : ''"
        :loading="actionLoading === act.key"
        :disabled="actionLoading !== null && actionLoading !== act.key"
        :title="act.label"
        @click="dispatch(act)"
      >
        <span class="lca-icon"><IconSvg :name="act.icon" /></span><span class="lca-label">{{ act.label }}</span>
      </Button>
    </div>

    <!-- 删除按钮 — canDeleteTask 判定, 走 ConfirmDialog (R6). -->
    <Button
      v-if="showDelete"
      variant="danger"
      size="mini"
      :loading="actionLoading === 'delete'"
      :disabled="actionLoading !== null && actionLoading !== 'delete'"
      title="删除"
      @click="dispatch({ key: 'delete', icon: 'trash', label: '删除', variant: 'danger', dangerous: true, success: '已删除' })"
    >
      <span class="lca-icon"><IconSvg name="trash" /></span><span class="lca-label">删除</span>
    </Button>

    <!-- R56-A4.8 (P1-1): 三段 ConfirmDialog — refine / await / unawait
         (master tdc.tsx:2992-3082 同款). refine 收 optional message;
         await / unawait 收 3 选 1 reason + optional note. -->

    <!-- refine 弹窗 -->
    <ConfirmDialog
      :open="refineOpen"
      title="让 agent 接着干"
      :message="refineMessage"
      confirm-text="▶ 继续干"
      cancel-text="取消"
      type="info"
      @confirm="onConfirmRefine"
      @cancel="onCancelRefine"
    >
      <template #default>
        <div class="lca-dialog-body">
          <p class="lca-dialog-hint">
            任务从 reviewing 切回 running, agent 会按新指示继续。消息可选。
          </p>
          <input
            v-model="refineMessage"
            type="text"
            class="lca-dialog-input"
            placeholder="(可选) 给 agent 的继续消息"
          />
        </div>
      </template>
    </ConfirmDialog>

    <!-- await 弹窗 -->
    <ConfirmDialog
      :open="awaitOpen"
      title="等用户介入"
      :message="awaitNote"
      confirm-text="⏸ 等用户介入"
      cancel-text="取消"
      type="info"
      @confirm="onConfirmAwait"
      @cancel="onCancelAwait"
    >
      <template #default>
        <div class="lca-dialog-body">
          <p class="lca-dialog-hint">切到「等用户介入」状态，等拍板/建议。</p>
          <select v-model="awaitReason" class="lca-dialog-select">
            <option value="dispatch_needed">dispatch_needed — 等派发实现</option>
            <option value="decision_pending">decision_pending — 等拍板</option>
            <option value="suggestion">suggestion — 有建议给 damo</option>
          </select>
          <input
            v-model="awaitNote"
            type="text"
            class="lca-dialog-input"
            placeholder="(可选) 备注"
          />
        </div>
      </template>
    </ConfirmDialog>

    <!-- unawait 弹窗 -->
    <ConfirmDialog
      :open="unawaitOpen"
      title="让 agent 继续执行"
      :message="unawaitNote"
      confirm-text="▶ 继续执行"
      cancel-text="取消"
      type="info"
      @confirm="onConfirmUnawait"
      @cancel="onCancelUnawait"
    >
      <template #default>
        <div class="lca-dialog-body">
          <p class="lca-dialog-hint">任务从「等用户介入」回到 running，agent 接着干。</p>
          <select v-model="unawaitReason" class="lca-dialog-select">
            <option value="agent_self_resolved">agent_self_resolved — agent 自决</option>
            <option value="user_timeout">user_timeout — 用户超时</option>
            <option value="external_event">external_event — 外部触发</option>
          </select>
          <input
            v-model="unawaitNote"
            type="text"
            class="lca-dialog-input"
            placeholder="(可选) 备注"
          />
        </div>
      </template>
    </ConfirmDialog>

    <!-- cancel / delete 关键操作 ConfirmDialog -->
    <ConfirmDialog
      :open="confirm.open"
      :title="confirm.title"
      :message="confirm.message"
      :confirm-text="confirm.confirmText"
      type="danger"
      @confirm="onConfirm"
      @cancel="onCancelConfirm"
    />
  </div>
</template>

<style scoped>
.lca-root {
  display: flex;
  align-items: center;
  gap: 8px;
  /* nowrap: 之前 wrap 在 tsb-row 拥挤时 (e.g. reviewing 3 个 action + 删除) 会把
     「删除」挤下来自成一行, 看着像孤儿按钮. 改 nowrap 后整个按钮簇作为 tsb-row
     的一个 flex item 一起换行, 删除永远贴着 action 组. */
  flex-wrap: nowrap;
}

.lca-group {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 同 lca-root: 不让组内按钮单个掉行. */
  flex-wrap: nowrap;
}

/* R59: action 按钮内 icon 跟 label 之间留点呼吸, 之前 0 间距看着挤.
   用 margin-right 而非 Button 内 flex gap — Button 渲染不固定是 flex,
   margin 更稳. mobile (label display:none) 时 margin 必须归零, 否则
   Button 是 inline-flex justify-content:center, 隐藏的 label 仍占 4px
   margin 空间, icon 被推偏左. */
.lca-icon {
  margin-right: 4px;
}

@media (max-width: 1023px) {
  .lca-icon {
    margin-right: 0;
  }
}

/* 小屏幕 (跟 .tsb-tbtn-text 1024px 同断点) — 按钮只露 icon, 文字藏.
   title 属性 (上面 :title="act.label") 提供 hover 长提示做兜底. */
@media (max-width: 1023px) {
  .lca-label {
    display: none;
  }
}

/* 「打钩 完成」按钮 (approve) 改 emerald 绿 — 跟 .tsb-tbtn-active-emerald
   同色系 (bg=#d1fae5 / fg=#047857 / border=#a7f3d0), 表达「完成 = 正反馈」
   一脉相承. !important 盖过 Button.vue 的 .btn-primary, 因 scoped css
   specificity 跟 :class 一样, 不强压会被 primary 蓝盖回去. 只针对
   key==='approve' (即三个 status 下的"完成"按钮), 不影响 start/pause/
   cancel/refine/restart/await/unawait 等. */
.lca-btn-approve {
  background: var(--tw-emerald-100) !important;
  color: var(--tw-emerald-700) !important;
  border-color: var(--tw-emerald-200) !important;
}
.lca-btn-approve:hover:not(:disabled) {
  background: var(--tw-emerald-200) !important;
  border-color: var(--tw-emerald-300) !important;
}

/* R56-A4.8 (P1-1): refine / await / unawait 三段 ConfirmDialog 内部 form 样式.
   master tdc.tsx:2995-3009 / 3023-3042 / 3056-3075 同款 space-y-2 + 圆角输入框. */
.lca-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lca-dialog-hint {
  margin: 0;
  font-size: 13px;
  color: var(--tw-gray-600);
  line-height: 1.5;
}
.lca-dialog-input,
.lca-dialog-select {
  width: 100%;
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 4px;
  background: var(--color-bg-elevated);
  box-sizing: border-box;
}
.lca-dialog-select {
  cursor: pointer;
}
.lca-dialog-input:focus,
.lca-dialog-select:focus {
  outline: none;
  border-color: var(--tw-blue-400);
  box-shadow: 0 0 0 1px var(--tw-blue-400);
}
</style>