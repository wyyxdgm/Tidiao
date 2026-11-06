<script setup lang="ts">
/* 功能: 任务消息输入栏 — textarea (自动伸缩) + 文件上传 + auto_approve + 高级设置
   (model/effort/maxTurns) + 发送按钮. 镜像 master task-detail-client.tsx §消息输入.
   关注点:
   - Enter 发送 / Shift+Enter 换行; IME composing 防误发.
   - 文件走 multipart POST /api/tasks/[id]/attachments; 上传中显示文件名 + 进度.
   - 自动调节 textarea 高度 (60-160 行 → 120-160px 区间, 区间内自适应).
   - 🆕 R56-A4.10 (P1-3): 高级设置改回 inline 展开 (master tdc.tsx:2851 三列 grid),
     取代旧版 ⚙️ 按钮 + Modal 弹窗 — master 端实际就是 inline 展开, 旧 modal 是 SPA
     R19 当时的简化选择. ⚙️ 改 toggle button, 展开/折叠状态 = 纯前端, 不持久化.
   - PATCH /api/tasks/[id] 同步 advanced settings (model/effort/maxTurns). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { patch, post, HttpError } from '@/api/http';
import { useAvailableModels } from '@/composables/useAvailableModels';
import Button from './Button.vue';
import Checkbox from './Checkbox.vue';
import Input from './Input.vue';
import Select from './Select.vue';
import { useToast } from '@/composables/useToast';
import { parseSlashCommand } from '@/lib/chat/slash-command';
import {
  InputHistoryBrowser,
  clearInputHistoryStorage,
  loadDraft,
  loadInputHistory,
  pushGlobalInputHistory,
  pushHistoryEntry,
  saveDraft,
  saveInputHistory,
} from '@/lib/chat/input-history';

const toast = useToast();

/** 拖拽手柄持久化 key (per-task 隔离). localStorage 沉默失败, 失败不阻断
    功能 — 仅丢偏好. 与 master task-detail-client.tsx §消息输入手柄 同款口径. */
const INPUT_HEIGHT_STORAGE_PREFIX = 'ao-msg-input-height-';
const MIN_INPUT_HEIGHT_PX = 60;
const MAX_INPUT_HEIGHT_PX = 280;

function loadInputHeight(taskId: string): number | null {
  try {
    const raw = localStorage.getItem(INPUT_HEIGHT_STORAGE_PREFIX + taskId);
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(MIN_INPUT_HEIGHT_PX, Math.min(MAX_INPUT_HEIGHT_PX, n));
  } catch {
    return null;
  }
}

function saveInputHeight(taskId: string, h: number): void {
  try {
    localStorage.setItem(INPUT_HEIGHT_STORAGE_PREFIX + taskId, String(h));
  } catch {
    /* localStorage 不可用, 静默 */
  }
}

interface Props {
  taskId: string;
  disabled?: boolean;
  disabledReason?: string;
  /** R56-A4.10: 给 running 状态显示"配置将在下次恢复/重启时生效"提示. */
  status?: string;
  initialAutoApprove?: boolean;
  initialModel?: string | null;
  initialEffort?: string | null;
  initialMaxTurns?: number | null;
  /** R143 五轮: 当前 task 归属 — /goal / /loop slash command 创建新 task /
      schedule 时复用, 不让用户重新选 project. type 字段当前 ChatView 接口未
      暴露 (未在 SPA 消费), 不引进来 — 走默认行为. */
  contextProjectId?: string | null;
  contextVersionId?: string | null;
  contextModel?: string | null;
  contextEffort?: string | null;
}
const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  disabledReason: '',
  status: '',
  initialAutoApprove: false,
  initialModel: null,
  initialEffort: null,
  initialMaxTurns: null,
  contextProjectId: null,
  contextVersionId: null,
  contextModel: null,
  contextEffort: null,
});

const emit = defineEmits<{
  (e: 'sent'): void;
  (e: 'settings-changed'): void;
  /** B262: 报告 input form 当前像素高度, 让父级把 AskUserQuestion 弹窗
      的 max-height cap 起来避免遮挡. */
  (e: 'input-form-height', height: number): void;
}>();

/* ------------------------------------------------------------------ */
/*  Text state                                                         */
/* ------------------------------------------------------------------ */

// R179: 初始文本 = 该 task 未发送草稿 (切换/刷新不丢). 空草稿 = '' 同旧行为.
const text = ref<string>(loadDraft(props.taskId));
const isComposing = ref<boolean>(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const rootRef = ref<HTMLDivElement | null>(null);
/** 用户拖拽手柄设置的高度. 默认 100px (与 master 初始 messageInputHeight 同档).
    初始从 localStorage 读; 拖拽松手时写回. */
const inputHeight = ref<number>(loadInputHeight(props.taskId) ?? 100);

/* ------------------------------------------------------------------ */
/*  R179: 输入历史 (↑/↓ 召回) + 未发送草稿持久化                        */
/* ------------------------------------------------------------------ */

/** 已发送输入历史 (per-task, localStorage 持久). 非响应式也够, 但 goal/loop
    成功后要 toast 外无渲染依赖 — 用 ref 只为 clear 时可能的调试便利. */
const inputHistory = ref<string[]>(loadInputHistory(props.taskId));
/** ↑/↓ 浏览态状态机. 非响应式 (纯键盘交互, 无渲染依赖). 持有 inputHistory
    数组引用 — record/clear 后必须重建, 见 rebuildHistoryBrowser(). */
let historyBrowser = new InputHistoryBrowser(inputHistory.value);
/** 草稿防抖写盘 timer (300ms). unmount 时 flush, 防切换 task 丢最后输入. */
let draftTimer: number | null = null;

function rebuildHistoryBrowser(): void {
  historyBrowser = new InputHistoryBrowser(inputHistory.value);
}

/** 发送成功后记一条历史 (连续重复跳过, 上限 100, 见 input-history.ts).
    R233 Round7: 同时写全局共享历史 — 快速创建弹窗 ↑ 可召回任意 task 发过的指令. */
function recordHistory(raw: string): void {
  inputHistory.value = pushHistoryEntry(inputHistory.value, raw);
  saveInputHistory(props.taskId, inputHistory.value);
  pushGlobalInputHistory(raw);
  rebuildHistoryBrowser();
}

// R179: taskId 变化 (同组件复用路由) → 换 per-task 历史 + 恢复该 task 草稿.
//   防抖窗口内切走时, 先把未落盘草稿写给旧 task (否则丢最后几秒输入).
watch(
  () => props.taskId,
  (id, oldId) => {
    if (draftTimer != null) {
      window.clearTimeout(draftTimer);
      draftTimer = null;
      if (oldId) saveDraft(oldId, text.value);
    }
    inputHistory.value = loadInputHistory(id);
    rebuildHistoryBrowser();
    text.value = loadDraft(id);
  },
);

// R179: 草稿持久化 — 输入即存 (300ms 防抖), 切 task / 刷新后恢复. 初始值
//   在上方 text ref 初始化时已读, 这里只管后续变化 (非 immediate).
watch(text, (v) => {
  if (draftTimer != null) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = null;
    saveDraft(props.taskId, v);
  }, 300);
});

function flushDraft(): void {
  if (draftTimer != null) {
    window.clearTimeout(draftTimer);
    draftTimer = null;
    saveDraft(props.taskId, text.value);
  }
}


/** R56-B4: textarea 跟随内容自动撑高 (Shift+Enter 插换行后能看到多行).
    不用 `field-sizing:content` (iOS Safari 不可靠), 显式算 scrollHeight clamp 到
    [60, 280]. 用户拖拽过的 inputHeight 在新内容超 280 时让步 (内容优先). */
function autoresize(): void {
  /* R56-B10: 之前直接 t.style.height = '${next}px' 设 inline 样式, 但拖拽手柄
     onDragStart 改的是 inputHeight.value (CSS var --msg-input-h), 两条路径
     各管各的 → 拖拽看起来没反应. 改成只更新 inputHeight (textarea 高度走
     CSS var, autoresize clamp 到 [60, 280] 与原来行为一致). */
  const t = textareaRef.value;
  if (!t) return;
  // 临时清 inline 拿到真实 scrollHeight (无 inline 时 textarea 默认 min-height 60).
  const prev = t.style.height;
  t.style.height = 'auto';
  const next = Math.min(Math.max(t.scrollHeight, 60), 280);
  t.style.height = prev;
  inputHeight.value = next;
}
watch(text, () => { autoresize(); });

/* ------------------------------------------------------------------ */
/*  Auto-approve + advanced settings                                   */
/* ------------------------------------------------------------------ */

const autoApprove = ref<boolean>(props.initialAutoApprove);
const showAdvanced = ref<boolean>(false);
const advModel = ref<string>(props.initialModel ?? '');
const advEffort = ref<string>(props.initialEffort ?? '');
const advMaxTurns = ref<string>(
  props.initialMaxTurns != null ? String(props.initialMaxTurns) : '',
);
const advSaving = ref<boolean>(false);

const EFFORT_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
];

// R56-B4: 模型下拉统一走 useAvailableModels() (configured + builtin + used 三源并集),
// 取代 R19 简化的本地 MODEL_OPTIONS (只有 4 条且不含用户已配置的).
const { options: modelOptions, loading: modelOptionsLoading } = useAvailableModels();

watch(
  () => [props.initialAutoApprove, props.initialModel, props.initialEffort, props.initialMaxTurns],
  () => {
    autoApprove.value = props.initialAutoApprove;
    advModel.value = props.initialModel ?? '';
    advEffort.value = props.initialEffort ?? '';
    advMaxTurns.value = props.initialMaxTurns != null ? String(props.initialMaxTurns) : '';
  },
);

async function toggleAutoApprove(): Promise<void> {
  const next = !autoApprove.value;
  autoApprove.value = next;
  try {
    await patch(`/api/tasks/${props.taskId}`, { auto_approve: next ? 1 : 0 });
    emit('settings-changed');
  } catch (e) {
    autoApprove.value = !next;
    if (e instanceof HttpError) {
      toast.error(`设置失败: ${e.message}`);
    } else {
      toast.error('设置失败');
    }
  }
}

/** R56-B1.e: 高级设置 onChange 即 patch (master tdc.tsx:2854-2881 同款).
    旧 R56-A4.10 留 保存/取消 按钮是过度设计 — master 端 model/effort/maxTurns
    都是 onChange 实时 PATCH, 不需要两步提交. 这里保持 sync 实时保存语义,
    失败时回滚 + Toast 报错. */
async function setModel(v: string | null): Promise<void> {
  const prev = advModel.value;
  const next = v ?? '';
  advModel.value = next;
  if (next === (props.initialModel ?? '')) return;
  try {
    await patch(`/api/tasks/${props.taskId}`, { model: next || null });
    emit('settings-changed');
  } catch (e) {
    advModel.value = prev;
    if (e instanceof HttpError) {
      toast.error(`模型设置失败: ${e.message}`);
    } else {
      toast.error('模型设置失败');
    }
  }
}

async function setEffort(v: string | null): Promise<void> {
  const prev = advEffort.value;
  const next = v ?? '';
  advEffort.value = next;
  if (next === (props.initialEffort ?? '')) return;
  try {
    await patch(`/api/tasks/${props.taskId}`, { effort: next || null });
    emit('settings-changed');
  } catch (e) {
    advEffort.value = prev;
    if (e instanceof HttpError) {
      toast.error(`强度设置失败: ${e.message}`);
    } else {
      toast.error('强度设置失败');
    }
  }
}

async function setMaxTurns(v: string): Promise<void> {
  const prev = advMaxTurns.value;
  advMaxTurns.value = v;
  const turnsNum = v ? Number(v) : null;
  if (turnsNum === props.initialMaxTurns) return;
  try {
    await patch(`/api/tasks/${props.taskId}`, { max_turns: turnsNum });
    emit('settings-changed');
  } catch (e) {
    advMaxTurns.value = prev;
    if (e instanceof HttpError) {
      toast.error(`最大轮次设置失败: ${e.message}`);
    } else {
      toast.error('最大轮次设置失败');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Drag handle — 顶部手柄拖动调整 textarea 高度 (B231)                  */
/* ------------------------------------------------------------------ */

function onDragStart(ev: MouseEvent): void {
  ev.preventDefault();
  const startY = ev.clientY;
  const startH = inputHeight.value;
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
  const onMove = (e: MouseEvent): void => {
    // 手柄在 form 顶部: delta 为负 (clientY 减小 = 往上) → 高度增加.
    const delta = startY - e.clientY;
    const next = Math.max(
      MIN_INPUT_HEIGHT_PX,
      Math.min(MAX_INPUT_HEIGHT_PX, startH + delta),
    );
    inputHeight.value = next;
  };
  const onUp = (): void => {
    saveInputHeight(props.taskId, inputHeight.value);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ------------------------------------------------------------------ */
/*  ResizeObserver (B262) — emit 当前 input form 像素高度.              */
/* ------------------------------------------------------------------ */

/** 容器 root DOM ref. ResizeObserver 挂这里, 拖拽手柄改 textarea 后整个
    form 高度变化都触发 emit. mount 时同步一次首帧高度, 防止父级首屏弹窗
    位置错. onBeforeUnmount disconnect 避免内存泄漏. */

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    const el = rootRef.value;
    emit('input-form-height', el.offsetHeight);
    resizeObserver = new ResizeObserver(() => {
      emit('input-form-height', el.offsetHeight);
    });
    resizeObserver.observe(el);
  }
  // R56-B4: 挂载后立刻跑一次 auto-resize, 处理 localStorage 持久化的旧文本
  // 初始渲染就超 60px 的场景.
  autoresize();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  // R179: 卸载前把防抖窗口内的草稿落盘 (切 task 路由时防丢字).
  flushDraft();
});


/* ------------------------------------------------------------------ */
/*  Send                                                               */
/* ------------------------------------------------------------------ */

const sending = ref<boolean>(false);

async function send(): Promise<void> {
  // R56-B4: 修「发送失败: message is required」bug. SPA 之前 send `content` 字段,
  // 但 /api/tasks/[id]/message 读 body.message — 字段名不匹配 → API 返 400.
  // 改成 message 跟 Next.js 端 + API 对齐. 同时保留 raw text 推乐观消息, 不丢
  // 用户已输入的尾随空格; trim 只用于"是否为空"判断.
  const raw = text.value;
  const trimmed = raw.trim();
  if (!trimmed || sending.value || props.disabled) return;
  sending.value = true;

  // 🆕 R143 五轮 (damo 2026-09-15) SPA 端口化: /goal / /loop slash command.
  //   对齐 master task-detail-client.tsx:handleSendMessage, 复用当前 task
  //   的 project/version/model/effort, 不重选. 非 slash → 走原 message 路径.
  const slash = parseSlashCommand(raw);
  // 🆕 R179: /clearhistory — 纯前端动作 (清本 task 历史 + 草稿), 不上服务器.
  if (slash.kind === 'clearhistory') {
    clearInputHistoryStorage(props.taskId);
    inputHistory.value = [];
    rebuildHistoryBrowser();
    text.value = '';
    toast.success('已清除本任务的输入历史和草稿');
    sending.value = false;
    return;
  }
  if (slash.kind === 'goal') {
    if (!slash.prompt) {
      toast.error('/goal 后请输入目标条件');
      sending.value = false;
      return;
    }
    await handleSlashGoal(slash.prompt, raw);
    sending.value = false;
    return;
  }
  if (slash.kind === 'loop') {
    if (!slash.prompt) {
      toast.error('/loop 后请输入任务指令');
      sending.value = false;
      return;
    }
    await handleSlashLoop(slash.prompt, slash.interval, slash.cronExpr, raw);
    sending.value = false;
    return;
  }

  // 🆕 修 2026-10-31 用户实证 bug: 手机端选图片 → 发文字, 文字发出但图片永远
  //   留在附件栏. 根因 = SPA 端口化漏了 master tdc.tsx:1728-1729/1767 的
  //   "pendingAttachments 随消息一起发" — POST body 只带 {message}, 后端
  //   /api/tasks/[id]/message 的 body.attachments (附件 id 数组, fold 进消息
  //   文本) 从未被 SPA 调用. 补上: 发送带 attachments, 成功清 chip, 失败保留
  //   (master setPendingAttachments(atts) 回滚语义同款).
  const attIds = pendingAttachments.value.map((a) => a.id);

  try {
    await post(`/api/tasks/${props.taskId}/message`, {
      message: raw,
      attachments: attIds.length > 0 ? attIds : undefined,
    });
    text.value = '';
    pendingAttachments.value = [];
    recordHistory(raw); // R179: 发送成功才入史 (失败不记, 输入框已还原)
    emit('sent');
  } catch (e) {
    if (e instanceof HttpError) {
      toast.error(`发送失败: ${e.message}`);
    } else {
      toast.error('发送失败');
    }
    // 附件 chip 故意不清 — 发送失败保留, 用户重试时附件仍随消息带上.
  } finally {
    sending.value = false;
  }
}

// R143 五轮 SPA 端口化: /goal <prompt> → 创建新 task, prompt 包成 <goal>...</goal>
//   触发 goal loop (settings.max_goal_rounds 走默认 20). project_id/version_id
//   复用当前 task 归属, 失败 → 还原输入框.
async function handleSlashGoal(prompt: string, original: string): Promise<void> {
  const goalPrompt = `<goal>${prompt}</goal>`;
  text.value = '';
  try {
    const created = await post<{ id: string }>('/api/tasks', {
      title: prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt,
      prompt: goalPrompt,
      autoApprove: true,
      project_id: props.contextProjectId || undefined,
      version_id: props.contextVersionId || undefined,
      model: props.contextModel || undefined,
      effort: props.contextEffort || undefined,
    });
    toast.success(`已创建 goal task #${created.id.slice(0, 8)}`);
    recordHistory(original); // R179: slash 命令也算"输入过的内容"
    // hash 路由 SPA: 用 location.change 而不是 viewport 跳转
    window.location.href = `/#/tasks/${created.id}`;
    return;
  } catch (e) {
    console.error('[slash /goal] failed:', e);
    const msg = e instanceof HttpError ? e.message : '未知错误';
    toast.error(`创建 goal task 失败: ${msg}`);
    text.value = original; // 还原输入框
  }
}

// R143 五轮 SPA 端口化: /loop [interval] <prompt> → 创建 cron schedule (agent 类型),
//   失败 → 还原输入框.
async function handleSlashLoop(
  prompt: string,
  interval: string,
  cronExpr: string,
  original: string,
): Promise<void> {
  text.value = '';
  try {
    const schedule = await post<{ id: string }>('/api/schedules', {
      name: `loop-${interval}-${prompt.slice(0, 30)}`,
      exec_type: 'agent',
      schedule_type: 'cron',
      schedule_expr: cronExpr,
      title: prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt,
      prompt,
      auto_approve: true,
      project_id: props.contextProjectId || undefined,
      version_id: props.contextVersionId || undefined,
    });
    toast.success(`已创建 cron schedule #${schedule.id.slice(0, 8)} (${interval})`);
    recordHistory(original); // R179: slash 命令也算"输入过的内容"
    return;
  } catch (e) {
    console.error('[slash /loop] failed:', e);
    const msg = e instanceof HttpError ? e.message : '未知错误';
    toast.error(`创建 /loop schedule 失败: ${msg}`);
    text.value = original; // 还原输入框
  }
}

function onKeyDown(e: KeyboardEvent): void {
  // Enter 发送 (主流 IM 习惯). Cmd/Ctrl/Shift+Enter 显式插 \n, controlled v-model
  // 下手动管 selectionStart / End 避免 setState 与浏览器默认插入 race 丢字符.
  // IME composing 由 compositionstart/end 守护, 中文输入法候选上屏不误触发.
  if (isComposing.value) return;

  // 🆕 R179: ↑/↓ 翻输入历史 (terminal-style). 仅在"光标贴边"时劫持:
  //   ↑ 只在光标前无换行 (首行) 时; ↓ 只在光标后无换行 (末行) 时 — 多行文本
  //   内部方向键仍移动光标. 有选区 / IME 组字中不劫持.
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const t = e.target as HTMLTextAreaElement | null;
    if (!t || t.selectionStart !== t.selectionEnd) return;
    const before = t.value.slice(0, t.selectionStart);
    const after = t.value.slice(t.selectionEnd);
    if (e.key === 'ArrowUp') {
      if (before.includes('\n')) return;
      if (inputHistory.value.length === 0) return;
      e.preventDefault();
      text.value = historyBrowser.up(text.value);
    } else {
      if (after.includes('\n')) return;
      if (!historyBrowser.active) return;
      e.preventDefault();
      text.value = historyBrowser.down(text.value);
    }
    // 召回后光标落末尾 (v-model 异步 patch DOM, 用 microtask 等 patch 完).
    queueMicrotask(() => {
      const el = textareaRef.value;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
    return;
  }

  if (e.key !== 'Enter') return;
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    e.preventDefault();
    const t = e.target as HTMLTextAreaElement | null;
    if (!t) return;
    const { selectionStart: s, selectionEnd: end, value: v } = t;
    const next = v.slice(0, s) + '\n' + v.slice(end);
    text.value = next;
    // Vue 3 v-model 异步更新 DOM, 用 queueMicrotask 在 patch 后还原光标,
    // 否则光标会跳到末尾.
    queueMicrotask(() => {
      t.selectionStart = t.selectionEnd = s + 1;
    });
    return;
  }
  e.preventDefault();
  void send();
}

/* ------------------------------------------------------------------ */
/*  File upload                                                        */
/* ------------------------------------------------------------------ */

const fileInputRef = ref<HTMLInputElement | null>(null);

/** R56-B1.11: 待发送附件列表 (master tdc.tsx:2702-2733 同款).
    上传完成后保留 chip 显示, 跟消息流 attachment 块一致 (可点击打开 / × 删除).
    SPA 之前的 upload-progress-bar 模式是 R19 简化, master 端无此 UI. */
interface PendingAttachment {
  // attachments 表 id 是 uuid string (src/lib/db/attachments.ts createAttachment
  // uuidv4), 之前标 number 是错的 — 发给 /message 时后端按 string 查.
  id: string;
  filename: string;
  size_bytes: number;
  media_type: string;
}
const pendingAttachments = ref<PendingAttachment[]>([]);

function pickFile(): void {
  fileInputRef.value?.click();
}

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  for (const file of files) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const created = await uploadAttachment(`/api/tasks/${props.taskId}/attachments`, fd);
      pendingAttachments.value.push(created);
    } catch (err) {
      if (err instanceof HttpError) {
        toast.error(`上传失败: ${err.message}`);
      } else {
        toast.error(`上传失败: ${(err as Error).message ?? '未知错误'}`);
      }
    }
  }
  input.value = '';
}

/** multipart 上传 — http.ts 默认 Content-Type: application/json 会覆盖
    multipart boundary, 这里直接 fetch 走原始 FormData. 复用 401 refresh 失败
    抛 HttpError 语义 (调用方 catch 即可). */
async function uploadAttachment(
  url: string,
  fd: FormData,
): Promise<PendingAttachment> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new HttpError({ status: res.status, message: msg });
  }
  const body = await res.json() as { attachment?: PendingAttachment };
  if (!body.attachment) throw new HttpError({ status: 502, message: '服务端未返回附件信息' });
  return body.attachment;
}

function removePending(id: string): void {
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id);
}

/** 字节数 → "1.2 MB" / "456 KB" / "789 B". master tdc.tsx:208-216 formatSize. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/* ------------------------------------------------------------------ */
/*  Computed                                                           */
/* ------------------------------------------------------------------ */

const canSend = computed<boolean>(
  () => !props.disabled && !sending.value && text.value.trim().length > 0,
);

const placeholder = computed<string>(() => {
  if (props.disabled) return props.disabledReason || '当前状态下不可发送';
  // R143 五轮 SPA 端口化: 跟 master 端对齐 — 让用户知道支持 slash 命令.
  //   R179 加 ↑ 历史召回提示 (/clearhistory 见 04-task-detail 文档, 太长不塞).
  return '输入消息后按 Enter 发送（Shift+Enter 换行）· ↑↓ 召回历史输入 · /goal <目标> 创建 goal task · /loop 30m <指令> 周期任务';
});
</script>

<template>
  <!-- R56-B1.10: 容器由 card → inline form (master tdc.tsx:2671
       `<form className="border-t bg-white p-2 sm:p-3 shrink-0">` 同款).
       视觉上变轻: 顶部 border-t 分隔 (无 box-shadow / border-radius),
       无内 padding (内容由内部组件撑开). -->
  <form ref="rootRef" class="task-message-input" @submit.prevent="send">
    <!-- R56-B1.10: 拖拽手柄只桌面 sm+ 显示 (master `hidden sm:flex h-1.5 -mt-3
         mb-1.5` 同款). 移动端 textarea 走 JS auto-resize (本组件未启用, 但保留
         主列 scroll 不出问题), 不让手柄出现干扰. -->
    <div
      class="msg-resize-handle"
      title="拖动调整输入框高度（向上调高，向下调低）"
      @mousedown="onDragStart"
    >
      <span class="msg-resize-grip" />
    </div>

    <!-- R56-B1.11: 待发送附件 chip (master tdc.tsx:2702-2733 同款).
         上传完成即 chip, 整块可点开 / × 删除. 取代旧上传进度条 (SPA R19 简化). -->
    <div v-if="pendingAttachments.length > 0" class="pending-attachments">
      <a
        v-for="a in pendingAttachments"
        :key="a.id"
        :href="`/api/attachments/${a.id}`"
        target="_blank"
        rel="noreferrer"
        class="pending-chip"
        title="点击在新窗口打开附件"
      >
        <span aria-hidden="true">{{ a.media_type.startsWith('image/') ? '🖼️' : '📄' }}</span>
        <span class="pending-chip-name">{{ a.filename }}</span>
        <span class="pending-chip-size">{{ formatSize(a.size_bytes) }}</span>
        <button
          type="button"
          class="pending-chip-x"
          title="移除附件"
          @click.prevent="removePending(a.id)"
          @click.stop
        >×</button>
      </a>
    </div>

    <textarea
      ref="textareaRef"
      v-model="text"
      class="msg-textarea"
      :placeholder="placeholder"
      :disabled="disabled"
      rows="1"
      :style="{ '--msg-input-h': `${inputHeight}px` }"
      @compositionstart="isComposing = true"
      @compositionend="isComposing = false"
      @keydown="onKeyDown"
    />

    <!-- R56-B1.10: 工具栏 — 左侧 ☑自动批准 + ⚙️, 右侧 📎 + 发送.
         master tdc.tsx:2787 `flex justify-between items-center mt-1.5 sm:mt-2`. -->
    <div class="msg-toolbar">
      <div class="msg-toolbar-left">
        <label class="auto-approve" title="自动审批：开启后 agent 工具调用无需逐个审核">
          <Checkbox :model-value="autoApprove" @update:model-value="toggleAutoApprove" />
          <span class="auto-approve-label">自动审批</span>
        </label>
        <button
          type="button"
          class="tool-btn"
          :class="{ 'tool-btn-active': showAdvanced }"
          title="发送时覆盖模型/强度/最大轮次"
          @click="showAdvanced = !showAdvanced"
        >⚙️</button>
      </div>
      <div class="msg-toolbar-right">
        <input
          ref="fileInputRef"
          type="file"
          multiple
          hidden
          @change="onFileChange"
        />
        <button
          type="button"
          class="tool-btn"
          title="上传附件"
          :disabled="disabled"
          @click="pickFile"
        >📎</button>
        <Button
          variant="primary"
          size="sm"
          :loading="sending"
          :disabled="!canSend"
          type="submit"
        >
          发送
        </Button>
      </div>
    </div>

    <!-- R56-B1.10 + R56-B1.e: 高级设置 inline 展开 (master tdc.tsx:2844-2883).
         简化: 删去"保存/取消"按钮, onChange 即 PATCH (master 同款).
         status=running 时显示"配置将在下次恢复/重启时生效"提示. -->
    <div v-if="showAdvanced" class="adv-inline">
      <div v-if="status === 'running'" class="adv-running-hint">
        💡 任务运行中：配置将在下次恢复/重启时生效，本次发送仅推送消息。
      </div>
      <div class="adv-grid">
        <label class="adv-cell">
          <span class="adv-label">模型</span>
          <Select :model-value="advModel" :options="modelOptions" :disabled="modelOptionsLoading" @update:model-value="(v) => void setModel(v)" />
        </label>
        <label class="adv-cell">
          <span class="adv-label">强度</span>
          <Select :model-value="advEffort" :options="EFFORT_OPTIONS" @update:model-value="(v) => void setEffort(v)" />
        </label>
        <label class="adv-cell">
          <span class="adv-label">最大轮次</span>
          <Input
            :model-value="advMaxTurns"
            type="number"
            :min="1"
            :max="500"
            placeholder="不限制"
            @update:model-value="(v) => void setMaxTurns(v)"
          />
        </label>
      </div>
    </div>
  </form>
</template>

<style scoped>
/* R56-B1.10: inline form (master tdc.tsx:2671 `<form class="border-t bg-white
   p-2 sm:p-3 shrink-0">` 同款). 视觉对比:
   - 去掉 box-shadow / border-radius / 全 border
   - 仅顶部 border-t 分隔主列与 dock 视觉
   - padding 由内层决定 (textarea 满宽, 不挤压)
   - shrink-0 保证不被 flex 列压缩高度 */
.task-message-input {
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
@media (min-width: 640px) {
  .task-message-input {
    padding: 12px;
  }
}

.msg-textarea {
  width: 100%;
  /* R56-B10: 高度走 CSS var --msg-input-h (父级 :style 注入), 让拖拽手柄
     onDragStart 改 inputHeight.value 真正生效. autoresize 也更新同一变量
     (clamp [60, 280]). 之前 min-height: 60 / max-height: 280 + inline
     style.height 的写法, inline 把 max-height 覆盖掉, 而 var 又没人用,
     拖拽动 inputHeight.value 看起来没反应. */
  height: var(--msg-input-h, 100px);
  min-height: 60px;
  max-height: 280px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: 13.5px;
  line-height: 1.55;
  resize: none;
  outline: none;
  background: var(--color-bg);
  font-family: inherit;
  box-sizing: border-box;
}
.msg-textarea:focus {
  border-color: var(--color-primary, #3b82f6);
}
.msg-textarea:disabled {
  background: var(--color-bg-muted, rgba(0, 0, 0, 0.02));
  color: var(--color-text-muted);
  cursor: not-allowed;
}

/* R56-B1.10: 拖拽手柄只桌面 sm+ 显示 (master `hidden sm:flex h-1.5 -mt-3
   mb-1.5` 同款). -mt-3 把 grip 拉到 border 之上, 视觉读作"border 延伸". */
.msg-resize-handle {
  display: none;
  align-items: center;
  justify-content: center;
  height: 6px;
  margin: -12px 0 6px;
  cursor: ns-resize;
  border-radius: 4px;
}
@media (min-width: 640px) {
  .msg-resize-handle {
    display: flex;
  }
}
.msg-resize-handle:hover {
  background: rgba(59, 130, 246, 0.12);
}
.msg-resize-handle:active {
  background: rgba(59, 130, 246, 0.2);
}
.msg-resize-grip {
  display: block;
  width: 40px;
  height: 3px;
  background: var(--tw-gray-300);
  border-radius: 999px;
}

/* R56-B1.10: 工具栏 — master tdc.tsx:2787 `flex justify-between items-center
   mt-1.5 sm:mt-2 gap-2 flex-wrap` 同款. 左侧 ☑+⚙️, 右侧 📎+发送. */
.msg-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}
@media (min-width: 640px) {
  .msg-toolbar {
    margin-top: 8px;
  }
}
.msg-toolbar-left,
.msg-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
@media (min-width: 640px) {
  .msg-toolbar-left {
    gap: 12px;
  }
}
.auto-approve {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
}
.auto-approve-label {
  display: none;
}
@media (min-width: 640px) {
  .auto-approve-label {
    display: inline;
  }
}
/* R59+: tool-btn 28 → 30, 跟 AccountSwitcher .avatar-btn / TaskHeader
   .icon-btn / Pagination .pagination-btn 等顶部 30×30 图标按钮同档
   (用户反馈「还有28的」不齐). */
.tool-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--tw-gray-500);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.tool-btn:hover:not(:disabled) {
  background: var(--tw-gray-100);
  border-color: var(--tw-gray-400);
  color: var(--tw-gray-700);
}
.tool-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* R56-B1.11: 待发送附件 chip (master tdc.tsx:2708-2731 同款).
   整块 a 标签可点击; × 按钮 stopPropagation 防冒泡. */
.pending-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
.pending-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--tw-gray-100);
  border: 1px solid var(--tw-gray-200);
  border-radius: var(--radius);
  padding: 2px 8px;
  font-size: 11.5px;
  color: var(--tw-gray-700);
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.pending-chip:hover {
  background: var(--tw-blue-50);
  border-color: var(--tw-blue-300);
  color: var(--tw-blue-700);
}
.pending-chip-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pending-chip:hover .pending-chip-name {
  text-decoration: underline;
}
.pending-chip-size {
  color: var(--tw-gray-400);
  font-size: 11px;
}
.pending-chip:hover .pending-chip-size {
  color: var(--tw-blue-500);
}
.pending-chip-x {
  background: transparent;
  border: 0;
  color: var(--tw-gray-400);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
}
.pending-chip-x:hover {
  color: var(--tw-red-500);
}

/* R56-B1.10: 高级设置 inline — master tdc.tsx:2845 `mt-2 pt-2 border-t
   border-gray-100` 同款. status=running 提示用 amber-50 + 边距收紧. */
.adv-inline {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--tw-gray-100);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.adv-running-hint {
  font-size: 11.5px;
  color: var(--tw-amber-700);
  line-height: 1.5;
}
.adv-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
@media (min-width: 640px) {
  .adv-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
.adv-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.adv-label {
  font-size: 11.5px;
  color: var(--color-text-muted);
}

/* R56-B1.10: ⚙️ 按钮 toggle active 态 (master tdc.tsx:2810 同款蓝底). */
.tool-btn-active {
  background: var(--tw-blue-100);
  border-color: var(--tw-blue-300);
  color: var(--tw-blue-700);
}
</style>