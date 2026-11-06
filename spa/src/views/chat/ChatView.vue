<script setup lang="ts">
/* 功能: Chat 视图 — 与 LLM 实时对话生成新 task 模板 (MVP 单会话版).
   左侧 task list (按当前 project/version scope 筛选) + 右侧当前对话/新建输入区.
   输入区: 粘贴监听 + 文件附件 + 拖拽 + 高级配置 (模型/强度/最大轮次/自动审批).

   关注点 (R53):
   - 单会话模式 (R55+ 加 chat list 多会话切换): 同一 project/version scope 下的
     所有 task 视为一个会话, 切换 task = 在同一会话内切换查看. 父组件只需传
     filteredTasks (已按 project/version 筛选) + 通过 created emit 收到新 task.
   - emits:
       created(task: Task) 父组件按 status 拆 active/terminal
       update:projectId / update:versionId 父组件同步全局 filter state
   - 不实现: chat list 多会话切换 / opencode 单独选模型 (留 R55+).
   - localStorage 键:
       chat-list-width      左栏宽度 (200-480px)
       chat-new-prompt-input-height-v1  输入框高度 (60-400px)
       ao-recent-project:projectId    最近项目 (MVP 暂未启, 留给 picker 兜底)
   - 所有 handler 与 master chat-view.tsx 同口径 (粘贴 → setPendingFiles, 新建
     → POST /api/tasks + 上传附件 + start). */

import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type PropType } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, post, HttpError } from '@/api/http';
import { createTaskStreamSubscription } from '@/composables/useTaskStream';
import { useToast } from '@/composables/useToast';
import { useAvailableModels } from '@/composables/useAvailableModels';
import { useMediaQuery } from '@/composables/useMediaQuery';
import Input from '@/components/Input.vue';
import Checkbox from '@/components/Checkbox.vue';
import Select from '@/components/Select.vue';
import FileInput from '@/components/FileInput.vue';
import { listProjects, listVersions, type Project, type Version } from '@/api/projects';
import TaskTranscript from '@/components/TaskTranscript.vue';
import TaskMessageInput from '@/components/TaskMessageInput.vue';
import Loading from '@/components/Loading.vue';
import LifecycleActions from '@/components/LifecycleActions.vue';
import ResumeModal from '@/components/ResumeModal.vue';
import TaskStatusBar from '@/components/TaskStatusBar.vue';
import RightDock from '@/components/RightDock.vue';
import ForkModal from '@/components/ForkModal.vue';
import TaskEvaluationBar from '@/components/TaskEvaluationBar.vue';
import TaskMetaChips from '@/components/TaskMetaChips.vue';
import { parseDbTime } from '@/lib/datetime';
import { displayProjectName } from '@/lib/project-display';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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

interface TaskTrimmed {
  id: string;
  title: string;
  description: string | null;
  prompt_preview: string;
  result_preview: string;
  error_preview: string;
  status: TaskStatus;
  priority: number;
  type: string;
  model: string | null;
  resolved_model: string | null;
  tags: string | null;
  project_id: string | null;
  version_id: string | null;
  owner_id: string | null;
  deleted_at: string | null;
  cost_usd: number | null;
  updated_at: string;
}

interface Version {
  id: string;
  project_id: string;
  name: string;
  feishu_url: string | null;
  feishu_sheet: string | null;
  cwd: string | null;
}

interface TaskCreated {
  id: string;
  title: string;
  prompt: string;
  project_id: string;
  version_id: string | null;
  status: TaskStatus;
  prompt_preview?: string;
  updated_at?: string;
}

/** R56-B6: 选中 task 后拉全量详情 (镜像 master chat-view.tsx 嵌 TaskDetailClient
    的形态). 顶层只需要字段够 transcript / input / 父级 SSE 用即可, 不必镜像
    TaskDetailView 整套 (~80 字段). 多余字段不消费 — 父级 SSE 自己拿 status. */
interface TaskDetail {
  id: string;
  title: string;
  status: TaskStatus;
  prompt: string;
  result: string | null;
  error: string | null;
  model: string | null;
  effort: string | null;
  max_turns: number | null;
  auto_approve?: number;
  forked_at?: string | null;
  parent_task?: { id: string; title: string; status: string } | null;
  project_id: string | null;
  /** R143 五轮 SPA 端口化: /goal / /loop slash command 复用当前 task 的
       version 归属. 后端 API 已暴露, 只是 ChatView 接口未声明. */
  version_id: string | null;
  deleted_at: string | null;
  cost_usd: number | null;
  context_tokens?: number | null;
  context_max?: number | null;
  /** R217: 右侧面板展示字段 — GET /api/tasks/:id 返回全行, 之前只是没声明. */
  type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  awaiting_owner_review?: number | null;
  resolved_model?: string | null;
  /* R217v2: 右面板换详情页同款 RightDock — 接口补齐 GET /api/tasks/:id 已返回
     但之前没声明的字段 (TaskDetailView 同名字段同型). */
  session_id?: string | null;
  cwd?: string | null;
  allowed_tools?: string | null;
  tags?: string | null;
  preflight_result?: string | null;
  requirement_id?: string | null;
  base_commit?: string | null;
  head_commit?: string | null;
  card_summary?: { what: string; why: string; at?: string } | null;
  result_layers?: { brief: string; details: string[]; next?: string; result_len?: number } | null;
  dispatcher_task?: { id: string; title: string; status: string } | null;
  dispatched_tasks?: Array<{ id: string; title: string; status: string }>;
  depends_on_tasks?: Array<{ id: string; title: string; status: string }>;
  dependent_tasks?: Array<{ id: string; title: string; status: string }>;
  requirement_link?: { id: string; title: string; status: string } | null;
  requirement_siblings?: Array<{ id: string; title: string; status: string }>;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface PendingDialog {
  requestId: string;
  dialogKind: string;
  questions: unknown[];
}

interface UserDialogQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multi_select: boolean;
}

/* ------------------------------------------------------------------ */
/*  Props & Emits                                                     */
/* ------------------------------------------------------------------ */

interface Props {
  tasks: TaskTrimmed[];
  project?: { id: string; name: string } | null;
  version?: { id: string; name: string } | null;
  initialTaskId?: string | null;
  projectNames?: Record<string, string>;
  versionNames?: Record<string, string>;
}

const props = withDefaults(defineProps<Props>(), {
  project: null,
  version: null,
  initialTaskId: null,
  projectNames: () => ({}),
  versionNames: () => ({}),
});

const emit = defineEmits<{
  (e: 'created', task: TaskCreated): void;
}>();

const route = useRoute();
const router = useRouter();
const toast = useToast();
// i18n (W3a): 用户可见字符串走 t('tasks.chat.*'), 文案源
//   spa/src/i18n/locales/{zh-CN,en-US}/tasks.json (chat 子域)。
const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  Local state                                                        */
/* ------------------------------------------------------------------ */

const selectedTaskId = ref<string | null>(props.initialTaskId ?? null);
const showNewTaskInput = ref<boolean>(false);
const mobilePanel = ref<'list' | 'chat'>(props.initialTaskId ? 'chat' : 'list');

/** R56-B6: 选中 task 后拉全量详情 + 父级 SSE 维护 status / cost / approvals /
    dialogs — 镜像 master chat-view.tsx 嵌 TaskDetailClient 的行为. chat 顶已
    有项目上下文 pill + 任务标题行, 不再重复 TaskHeader, transcript + input
    足以承载对话. 旧版只渲 prompt_preview 小块已被替换. */
const taskDetail = ref<TaskDetail | null>(null);
const taskDetailLoading = ref<boolean>(false);
const taskDetailError = ref<string | null>(null);
const liveStatus = ref<TaskStatus | null>(null);
const liveCost = ref<number | null>(null);
/* R236: 上下文占用 live 值 — 父级 SSE context/context_update 事件驱动,
   面包屑行尾 TaskMetaChips 消费. 结构与 TaskDetailView liveContext 同款. */
const liveContext = ref<{ tokens: number; max: number } | null>(null);
const pendingApprovals = ref<PendingApproval[]>([]);
const pendingDialogs = ref<PendingDialog[]>([]);

const newPrompt = ref<string>('');
const showAdvanced = ref<boolean>(false);
const advancedModel = ref<string>('');
const advancedEffort = ref<string>('high');
const advancedMaxTurns = ref<string>('');
const advancedAutoApprove = ref<boolean>(true);

/* ------------------------------------------------------------------ */
/*  R220: 新建聊天「项目 › 版本」选择器                                  */
/* ------------------------------------------------------------------ */

/** R220: 新建聊天可自选项目/版本 — 默认 = 当前激活上下文 (props, global 模式
    来自筛选栏联动), 允许模糊搜索切换到任意项目/版本. props 变化 (筛选栏联动)
    时跟随重置 — 用户没手动改过才跟随, 手动选过则尊重用户选择. */
const ctxTouched = ref<boolean>(false);
const ctxProjectId = ref<string>(props.project?.id ?? '');
const ctxVersionId = ref<string>(props.version?.id ?? '');

watch(() => props.project?.id, (next) => {
  if (!ctxTouched.value) ctxProjectId.value = next ?? '';
});
watch(() => props.version?.id, (next) => {
  if (!ctxTouched.value) ctxVersionId.value = next ?? '';
});

/** 项目列表 — 打开新建卡片时拉一次 (组件 20+ 项目, Select filterable 负责模糊搜索). */
const ctxProjects = ref<Project[]>([]);
const ctxVersions = ref<Version[]>([]);

function onCtxProjectChange(v: string | null): void {
  ctxTouched.value = true;
  ctxProjectId.value = v ?? '';
  if (ctxVersionId.value) ctxVersionId.value = '';
}

function onCtxVersionChange(v: string | null): void {
  ctxTouched.value = true;
  ctxVersionId.value = v ?? '';
}

const ctxProjectOptions = computed<{ value: string; label: string }[]>(() =>
  ctxProjects.value.map((p) => ({ value: p.id, label: displayProjectName(p.name) })),
);

/** 版本级联 — 版本名跨项目重名常见 (master/v1), label 拼项目名前缀消歧.
    版本可空 (global chat 允许建不挂版本的任务, 与 TaskNew 一致). */
const ctxVersionOptions = computed<{ value: string; label: string }[]>(() => {
  const pid = ctxProjectId.value;
  const pName = ctxProjects.value.find((p) => p.id === pid)?.name;
  return [
    { value: '', label: t('tasks.chat.noVersion') },
    ...ctxVersions.value.map((v) => ({
      value: v.id,
      label: pName ? `${pName} / ${v.name}` : v.name,
    })),
  ];
});

/** createTask 用的有效上下文: 内部选择 > props (未动过且 props 有值时二者同源,
    这里统一走内部 ref, props 只当初值). */
const effectiveProjectId = computed<string>(() => ctxProjectId.value || props.project?.id || '');
const effectiveVersionId = computed<string | undefined>(
  () => ctxVersionId.value || props.version?.id || undefined,
);

/** 新建卡片打开时拉项目 + 按当前项目拉版本. 失败静默 (下拉空 = 仅默认上下文可用). */
async function loadCtxOptions(): Promise<void> {
  if (ctxProjects.value.length === 0) {
    try {
      const resp = await listProjects();
      ctxProjects.value = resp.projects ?? [];
    } catch { /* 静默 — 保底 props 上下文仍可建 */ }
  }
  await reloadCtxVersions();
}

async function reloadCtxVersions(): Promise<void> {
  const pid = effectiveProjectId.value;
  if (!pid) {
    ctxVersions.value = [];
    return;
  }
  try {
    const resp = await listVersions(pid);
    ctxVersions.value = resp.versions ?? [];
  } catch {
    ctxVersions.value = [];
  }
}

watch(showNewTaskInput, (open) => {
  if (open) void loadCtxOptions();
});

/** 有效项目变化 (含首次拉到列表后) → 版本级联重拉. 保留用户已选版本 (还在列表就不动). */
watch(effectiveProjectId, () => {
  void reloadCtxVersions();
});

/** toolbar 常显当前「模型 · 强度」— R220「没法选模型、思考程度」: advanced 折在
    齿轮后不可见, 常显当前值 + 点击展开, 模型/强度从隐藏项变成一眼可见. */
const advancedSummary = computed<string>(() => {
  const model = advancedModel.value || t('tasks.chat.defaultModel');
  const eff = advancedEffort.value || 'high';
  return `${model} · ${eff}`;
});

/** R220: 新建模式面包屑显示所选项目 (选择器联动), 非 props 死值. */
const effectiveProjectName = computed<string>(() => {
  if (ctxProjectId.value) {
    return ctxProjects.value.find((p) => p.id === ctxProjectId.value)?.name
      ?? props.project?.name
      ?? ctxProjectId.value.slice(0, 8);
  }
  return props.project?.name ?? '—';
});

/** R56-B5: 模型下拉走 useAvailableModels() — 跟 master chat-view.tsx:85 同源,
    数据 = configured (用户 llm_configs.model) + builtin (MODEL_OPTIONS 兜底) +
    used (历史 task.model). 取代旧 R19 写死的 advancedModel="" (UI 暴露但无源). */
const { options: modelOptions, loading: modelOptionsLoading } = useAvailableModels();

const EFFORT_OPTIONS_ADV: { value: string; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

const creating = ref<boolean>(false);
const pendingFiles = ref<File[]>([]);
const draggingFiles = ref<boolean>(false);
const fileInputRef = ref<InstanceType<typeof FileInput> | null>(null);
const dropZoneRef = ref<HTMLDivElement | null>(null);
const newPromptRef = ref<HTMLTextAreaElement | null>(null);

/* ------------------------------------------------------------------ */
/*  Left column width drag (B446)                                      */
/* ------------------------------------------------------------------ */

const CHAT_LIST_WIDTH_KEY = 'chat-list-width';
const CHAT_LIST_DEFAULT = 280;
const CHAT_LIST_MIN = 200;
const CHAT_LIST_MAX = 480;
const chatListWidth = ref<number>(CHAT_LIST_DEFAULT);
const chatListDragging = ref<boolean>(false);
const widthMounted = ref<boolean>(false);

onMounted(() => {
  widthMounted.value = true;
  try {
    const saved = localStorage.getItem(CHAT_LIST_WIDTH_KEY);
    if (saved) {
      const n = parseInt(saved, 10);
      if (Number.isFinite(n) && n >= CHAT_LIST_MIN && n <= CHAT_LIST_MAX) {
        chatListWidth.value = n;
      }
    }
  } catch {
    /* ignore */
  }
});

function startDrag(e: MouseEvent): void {
  e.preventDefault();
  chatListDragging.value = true;
  const container = document.getElementById('chat-list-container') as HTMLElement | null;
  const onMove = (ev: MouseEvent): void => {
    if (container) {
      const rect = container.getBoundingClientRect();
      const next = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, ev.clientX - rect.left));
      chatListWidth.value = next;
    } else {
      const next = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, ev.clientX));
      chatListWidth.value = next;
    }
  };
  const onUp = (ev: MouseEvent): void => {
    let final: number;
    if (container) {
      const rect = container.getBoundingClientRect();
      final = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, ev.clientX - rect.left));
    } else {
      final = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, ev.clientX));
    }
    chatListWidth.value = final;
    try {
      localStorage.setItem(CHAT_LIST_WIDTH_KEY, String(final));
    } catch {
      /* ignore */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    chatListDragging.value = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    void ev;
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

const dynamicChatListWidth = computed<string>(() =>
  widthMounted.value ? `${chatListWidth.value}px` : `${CHAT_LIST_DEFAULT}px`,
);

/* ------------------------------------------------------------------ */
/*  New prompt input height (拖拽 + localStorage 持久化)              */
/* ------------------------------------------------------------------ */

const MIN_NEW_PROMPT_H_PX = 60;
const MAX_NEW_PROMPT_H_PX = 400;
const DEFAULT_NEW_PROMPT_H_PX = 240;
const HEIGHT_KEY = 'chat-new-prompt-input-height-v1';
const newPromptHeight = ref<number>(DEFAULT_NEW_PROMPT_H_PX);
const heightMounted = ref<boolean>(false);

onMounted(() => {
  heightMounted.value = true;
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= MIN_NEW_PROMPT_H_PX && n <= MAX_NEW_PROMPT_H_PX) {
        newPromptHeight.value = n;
      }
    }
  } catch {
    /* ignore */
  }
});

watch(newPromptHeight, (v) => {
  if (!heightMounted.value) return;
  try {
    localStorage.setItem(HEIGHT_KEY, String(v));
  } catch {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ */
/*  Mobile-resize textarea                                              */
/* ------------------------------------------------------------------ */

watch([newPrompt, showNewTaskInput], () => {
  const el = newPromptRef.value;
  if (!el) return;
  if (el.clientWidth >= 640) return;
  el.style.height = 'auto';
  const scrollH = el.scrollHeight;
  const slack = 4;
  const next = Math.max(MIN_NEW_PROMPT_H_PX, Math.min(MAX_NEW_PROMPT_H_PX, scrollH + slack));
  el.style.height = `${next}px`;
  el.style.overflowY = scrollH + slack > MAX_NEW_PROMPT_H_PX ? 'auto' : 'hidden';
});

watch(showNewTaskInput, (v) => {
  if (v) {
    requestAnimationFrame(() => newPromptRef.value?.focus());
  }
});

/* ------------------------------------------------------------------ */
/*  Paste / drop / file input                                          */
/* ------------------------------------------------------------------ */

function nameForPastedFile(file: File, fallback: string): File {
  if (file.name) return file;
  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/markdown': 'md',
    'application/pdf': 'pdf',
  };
  const ext = extMap[file.type] ?? 'bin';
  return new File([file], `pasted-${Date.now()}-${fallback}.${ext}`, { type: file.type });
}

function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const items = dt.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) out.push(nameForPastedFile(f, String(i)));
      }
    }
    if (out.length) return out;
  }
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      out.push(nameForPastedFile(dt.files[i], String(i)));
    }
  }
  return out;
}

function onPromptPaste(e: ClipboardEvent): void {
  const files = filesFromDataTransfer(e.clipboardData);
  if (files.length === 0) return;
  e.preventDefault();
  pendingFiles.value = [...pendingFiles.value, ...files];
}

/* 兜底: window 级 paste 监听 (textarea 失焦后仍可粘) */
function onWindowPaste(e: ClipboardEvent): void {
  if (!showNewTaskInput.value) return;
  const files = filesFromDataTransfer(e.clipboardData);
  if (files.length === 0) return;
  e.preventDefault();
  pendingFiles.value = [...pendingFiles.value, ...files];
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('paste', onWindowPaste);
  }
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('paste', onWindowPaste);
  }
});

function onDropZoneOver(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  draggingFiles.value = true;
}

function onDropZoneLeave(e: DragEvent): void {
  const next = e.relatedTarget as Node | null;
  if (next && dropZoneRef.value?.contains(next)) return;
  draggingFiles.value = false;
}

function onDropZoneDrop(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  draggingFiles.value = false;
  const files = filesFromDataTransfer(e.dataTransfer);
  if (files.length) pendingFiles.value = [...pendingFiles.value, ...files];
}

function onFileInputChange(files: FileList | null): void {
  const arr = Array.from(files ?? []);
  if (arr.length) pendingFiles.value = [...pendingFiles.value, ...arr];
  // 重置 input.value 让同名文件可再次选择.
  fileInputRef.value?.reset();
}

function removePendingFile(idx: number): void {
  pendingFiles.value = pendingFiles.value.filter((_, i) => i !== idx);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  Task selection                                                     */
/* ------------------------------------------------------------------ */

function selectTask(id: string): void {
  selectedTaskId.value = id;
  showNewTaskInput.value = false;
  mobilePanel.value = 'chat';
  /* sync URL: keep ?mode=chat, add taskId */
  void router.replace({ query: { ...route.query, mode: 'chat', taskId: id } });
}

function startNewTask(): void {
  showNewTaskInput.value = true;
  selectedTaskId.value = null;
  mobilePanel.value = 'chat';
  /* sync URL: keep mode=chat, drop taskId */
  const next = { ...route.query } as Record<string, string>;
  delete next.taskId;
  next.mode = 'chat';
  void router.replace({ query: next });
}

function backToList(): void {
  mobilePanel.value = 'list';
}

/* ------------------------------------------------------------------ */
/*  Create task                                                        */
/* ------------------------------------------------------------------ */

async function createTask(): Promise<void> {
  if (!newPrompt.value.trim() || creating.value) return;
  /* R220: 项目/版本走新建卡片选择器 (默认当前激活上下文), 不再硬绑 props —
     global 模式没选筛选也能选任意项目创建. */
  if (!effectiveProjectId.value) {
    toast.error(t('tasks.chat.errSelectProject'));
    return;
  }
  creating.value = true;
  try {
    const title = newPrompt.value.trim().slice(0, 60);
    const res = await post<TaskCreated>('/api/tasks', {
      title,
      prompt: newPrompt.value.trim(),
      project_id: effectiveProjectId.value,
      version_id: effectiveVersionId.value,
      autoApprove: advancedAutoApprove.value,
      effort: advancedEffort.value || 'high',
      maxTurns: advancedMaxTurns.value ? parseInt(advancedMaxTurns.value, 10) : undefined,
      model: advancedModel.value || undefined,
    });

    /* 上传附件 */
    const attIds: string[] = [];
    for (const file of pendingFiles.value) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        const attRes = await fetch(`/api/tasks/${res.id}/attachments`, { method: 'POST', body: fd });
        if (attRes.ok) {
          const data = await attRes.json();
          if (data?.attachment?.id) attIds.push(data.attachment.id);
        }
      } catch {
        /* 静默失败 — 单文件失败不阻断 */
      }
    }
    if (attIds.length > 0) {
      try {
        await fetch(`/api/tasks/${res.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ append_attachments: attIds }),
        });
      } catch {
        /* ignore */
      }
    }

    /* 自动启动 */
    try {
      await post(`/api/tasks/${res.id}/start`, {});
    } catch {
      /* ignore — start 失败不影响任务创建 */
    }

    emit('created', res);
    selectedTaskId.value = res.id;
    newPrompt.value = '';
    pendingFiles.value = [];
    showNewTaskInput.value = false;
    showAdvanced.value = false;
    mobilePanel.value = 'chat';

    void router.replace({ query: { ...route.query, mode: 'chat', taskId: res.id } });
  } catch (e: unknown) {
    const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : t('tasks.chat.errUnknown');
    toast.error(t('tasks.chat.errCreateFailed', { msg }));
  } finally {
    creating.value = false;
  }
}

function onPromptKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return;
  if ((e as KeyboardEvent & { isComposing?: boolean }).isComposing) return;
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    e.preventDefault();
    const t = e.target as HTMLTextAreaElement;
    const s = t.selectionStart;
    const end = t.selectionEnd;
    const v = t.value;
    const next = v.slice(0, s ?? 0) + '\n' + v.slice(end ?? 0);
    newPrompt.value = next;
    queueMicrotask(() => {
      t.selectionStart = t.selectionEnd = (s ?? 0) + 1;
    });
    return;
  }
  e.preventDefault();
  if (!creating.value && newPrompt.value.trim()) void createTask();
}

/* ------------------------------------------------------------------ */
/*  New prompt textarea resize handle (桌面 sm+)                        */
/* ------------------------------------------------------------------ */

function startResize(e: MouseEvent): void {
  e.preventDefault();
  const startY = e.clientY;
  const startH = newPromptHeight.value;
  const onMove = (ev: MouseEvent): void => {
    const delta = startY - ev.clientY;
    const next = Math.max(MIN_NEW_PROMPT_H_PX, Math.min(MAX_NEW_PROMPT_H_PX, startH + delta));
    newPromptHeight.value = next;
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
}

/* ------------------------------------------------------------------ */
/*  Selected task: 拉全量详情 + 父级 SSE (status / cost / approvals /  */
/*  dialogs). 镜像 master chat-view.tsx 嵌 TaskDetailClient 的形态;     */
/*  TaskTranscript 内部已经自己拉消息历史 + 走自己的 SSE 流消息, 这里  */
/*  父级 SSE 只补 TaskTranscript 不暴露的事件.                       */
/* ------------------------------------------------------------------ */

async function loadTaskDetail(id: string): Promise<void> {
  taskDetailLoading.value = true;
  taskDetailError.value = null;
  try {
    const data = await get<TaskDetail>(`/api/tasks/${id}`);
    taskDetail.value = data;
    liveStatus.value = data.status;
    liveCost.value = data.cost_usd;
    liveContext.value =
      data.context_tokens != null
        ? { tokens: data.context_tokens, max: data.context_max ?? 0 }
        : null;
    chatStreamSub.attach();
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      taskDetailError.value = e.message || t('tasks.chat.errRequestFailed', { status: e.status });
    } else if (e instanceof Error) {
      taskDetailError.value = t('tasks.chat.errNetwork', { msg: e.message });
    } else {
      taskDetailError.value = t('tasks.chat.errLoadFailed');
    }
    taskDetail.value = null;
  } finally {
    taskDetailLoading.value = false;
  }
}

/* R234 后续项: 任务流共享订阅 —— 与任务详情页的 TaskTranscript 共享同一条
   /api/tasks/{id}/stream 长连接 (同任务在详情页 + 看板聊天模式同开时原先
   各一条); 重连语义统一收口 hub (有界重连 20 次上限, 原先是原生无限重连). */
const chatStreamSub = createTaskStreamSubscription(
  () => (taskDetail.value ? `/api/tasks/${taskDetail.value.id}/stream` : ''),
  (ev) => handleStreamEvent(ev),
);

function handleStreamEvent(ev: any): void {
  switch (ev?.type) {
    case 'status_change':
      // R56-C2: 同 TaskDetailView — 后端字段是 `to` 不是 `status`.
      if (typeof ev.to === 'string') liveStatus.value = ev.to as TaskStatus;
      break;
    case 'cost':
      if (typeof ev.cost_usd === 'number') liveCost.value = ev.cost_usd;
      break;
    case 'context':
    case 'context_update':
      // R236: 同 TaskDetailView — 面包屑指标 chips 跟上下文占用实时刷新.
      if (typeof ev.context_tokens === 'number') {
        liveContext.value = {
          tokens: ev.context_tokens,
          max: ev.context_max ?? liveContext.value?.max ?? 0,
        };
      }
      break;
    case 'tool_approval_request':
      pendingApprovals.value = [
        ...pendingApprovals.value,
        {
          requestId: ev.request_id ?? ev.toolUseId ?? `req-${Date.now()}`,
          toolName: ev.tool_name ?? ev.toolName ?? 'unknown',
          toolInput: ev.tool_input ?? ev.toolInput ?? {},
        },
      ];
      break;
    case 'tool_approval_response':
      pendingApprovals.value = pendingApprovals.value.filter(
        (a) => a.requestId !== ev.request_id,
      );
      break;
    case 'user_dialog_request':
      pendingDialogs.value = [
        ...pendingDialogs.value,
        {
          requestId: ev.request_id ?? `dlg-${Date.now()}`,
          dialogKind: ev.dialog_kind ?? 'question',
          questions: ev.questions ?? [],
        },
      ];
      break;
    case 'user_dialog_response':
    case 'user_dialog_timeout':
      pendingDialogs.value = pendingDialogs.value.filter(
        (d) => d.requestId !== ev.request_id,
      );
      break;
  }
}

/** R56-B6: 切 task → 拉详情 + 重连 SSE. 配合 selectedTaskId 切换 + 选 null
    (回到列表 / 新建模式) 时清掉旧 detail 避免泄露. */
watch(selectedTaskId, (next, prev) => {
  if (next === prev) return;
  chatStreamSub.detach();
  taskDetail.value = null;
  taskDetailError.value = null;
  liveStatus.value = null;
  liveCost.value = null;
  liveContext.value = null;
  pendingApprovals.value = [];
  pendingDialogs.value = [];
  if (next) {
    void loadTaskDetail(next);
  }
}, { immediate: true });

onBeforeUnmount(() => {
  chatStreamSub.detach();
});

// R228: keep-alive 切走必须关 SSE —— HTTP/1.1 直连每域 6 并发名额, 后台 tab
// 的长连接不还会饿死所有 fetch (2026-10-09 实证接口全 pending). 切回时按
// 当前选中任务重开; 未选中 = 无流可开, watch 会在选中时拉起.
let chatStreamWasDeactivated = false;
onDeactivated(() => {
  chatStreamWasDeactivated = true;
  chatStreamSub.detach();
});
onActivated(() => {
  if (!chatStreamWasDeactivated) return; // 首次 mount 的 onActivated 跳过
  chatStreamWasDeactivated = false;
  if (taskDetail.value) chatStreamSub.attach();
});

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/* i18n (W3a): 状态文案走 t() — 键映射 + statusLabel() 兜底, 语言切换可即时生效. */
const STATUS_LABEL_KEYS: Record<TaskStatus, string> = {
  pending: 'tasks.chat.statusPending',
  queued: 'tasks.chat.statusQueued',
  running: 'tasks.chat.statusRunning',
  paused: 'tasks.chat.statusPaused',
  reviewing: 'tasks.chat.statusReviewing',
  verifying: 'tasks.chat.statusVerifying',
  await_user: 'tasks.chat.statusAwaitUser',
  completed: 'tasks.chat.statusCompleted',
  failed: 'tasks.chat.statusFailed',
  rejected: 'tasks.chat.statusRejected', // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策, 曾误标等待中)
  cancelled: 'tasks.chat.statusCancelled',
};

function statusLabel(status: TaskStatus): string {
  const key = STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

/* R230: 删除会话后端软删且无 SSE 广播, LifecycleActions 只 emit('changed','deleted') —
   宿主 tasks 要到下次全量拉取才不含被删项, 本地过滤层负责即时摘除. */
const locallyDeletedIds = ref<Set<string>>(new Set());
const liveTasks = computed<TaskTrimmed[]>(() =>
  props.tasks.filter((t) => !locallyDeletedIds.value.has(t.id)),
);

function formatUpdatedAt(iso: string): string {
  // R211 续: updated_at 是 SQLite 裸 UTC 串 ("YYYY-MM-DD HH:MM:SS"), 旧
  // new Date(iso) 按本地时区解析 → CST 显示早 8h. 走 parseDbTime 当 UTC
  // 处理 (BoardPage / GlobalBoard / TaskCard R205-R211 同口径).
  const d = parseDbTime(iso);
  if (!d) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const selectedTask = computed<TaskTrimmed | null>(() => {
  if (!selectedTaskId.value) return null;
  return liveTasks.value.find((t) => t.id === selectedTaskId.value) ?? null;
});

/** 桌面态 sm+ 用 CSS 高度 (用户拖拽过), 移动端 < 640px 让 auto-resize effect 直接
   操纵 el.style.height (避免 iOS Safari field-sizing 不可靠). 这里始终给像素值,
   CSS 端 sm: 端接 max-height: 400, min-height: 60. */
const newPromptStyle = computed<{ height: string }>(() => ({
  height: `${newPromptHeight.value}px`,
}));

/* ------------------------------------------------------------------ */
/*  R217: 左列表「项目 › 版本」行 + 右侧操作面板                        */
/* ------------------------------------------------------------------ */

/** 飞书 R217: 聊天模式左列表要能看到会话属于哪个 项目 › 版本.
    版本域内 chat (BoardPage / VersionDetailView 传入 version) 全列表同源,
    逐项重复 = 噪声, 只在未锁版本 (global chat) 时显示. */
const showScopeLine = computed<boolean>(() => !props.version);

/** project_id/version_id → 「项目名 › 版本名」. 取名顺序: 当前 scope 上下文
    (props.project/version, BoardPage 嵌入场景 name 已知) > names map (global
    filter 场景) > id 前 8 位兜底 (host 没给名的老嵌入). */
function scopeLabelOf(projectId: string | null | undefined, versionId: string | null | undefined): string {
  const pName = (projectId && props.project?.id === projectId && props.project.name)
    || (projectId ? props.projectNames[projectId] : undefined);
  const vName = (versionId && props.version?.id === versionId && props.version.name)
    || (versionId ? props.versionNames[versionId] : undefined);
  const p = pName || (projectId ? projectId.slice(0, 8) : '');
  const v = vName || (versionId ? versionId.slice(0, 8) : '');
  if (p && v) return `${p} › ${v}`;
  return p || v || t('tasks.chat.uncategorized');
}

/** 当前生效状态: SSE live > 已拉详情 > 列表行 > pending 兜底. 面板 chip / ResumeModal gate 用. */
const activeStatus = computed<TaskStatus>(
  () => liveStatus.value ?? taskDetail.value?.status ?? selectedTask.value?.status ?? 'pending',
);

const resumeOpen = ref<boolean>(false);

/** LifecycleActions changed → 本地同步 + 后台拉详情 (approve/refine 等
    会翻 awaiting_owner_review 等元数据, 不重拉面板就显示旧值).
    loadTaskDetail 的 spinner 只在 !taskDetail 时显示, 后台重拉无感.
    R230: 'deleted' 哨兵 → 摘列表项 + 清选中 + 清 URL taskId, 不停僵尸会话. */
function onSideStatusChanged(newStatus: string): void {
  if (newStatus === 'deleted') {
    const deletedId = selectedTaskId.value;
    if (deletedId) {
      locallyDeletedIds.value.add(deletedId);
      if (taskDetail.value?.id === deletedId) taskDetail.value = null;
    }
    selectedTaskId.value = null;
    liveStatus.value = null;
    const next = { ...route.query } as Record<string, string>;
    delete next.taskId;
    void router.replace({ query: next });
    return;
  }
  liveStatus.value = newStatus as TaskStatus;
  if (taskDetail.value) taskDetail.value.status = newStatus as TaskStatus;
  if (selectedTaskId.value) void loadTaskDetail(selectedTaskId.value);
}

function onResumed(newStatus: string): void {
  resumeOpen.value = false;
  onSideStatusChanged(newStatus);
}

function onResumeClose(): void {
  resumeOpen.value = false;
}

/* ------------------------------------------------------------------ */
/*  R217v2: 右面板 = 详情页同款 操作行(TaskStatusBar) + 信息面板(RightDock)  */
/*  状态机 1:1 从 TaskDetailView 移植; localStorage key 与详情页共用       */
/*  (task-right-dock-v1 / task-display-mode-v1) → 两处状态互通.           */
/* ------------------------------------------------------------------ */

type DockPanels = Record<'details' | 'timeline' | 'checkpoints' | 'commits', boolean>;
const DOCK_STATE_KEY = 'task-right-dock-v1';
const DEFAULT_DOCK_PANELS: DockPanels = {
  details: false,
  timeline: true,
  checkpoints: true,
  commits: true,
};

function loadDockPanels(): DockPanels {
  try {
    const raw = localStorage.getItem(DOCK_STATE_KEY);
    if (!raw) return { ...DEFAULT_DOCK_PANELS };
    const parsed = JSON.parse(raw) as Partial<DockPanels> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_DOCK_PANELS };
    return {
      details: typeof parsed.details === 'boolean' ? parsed.details : DEFAULT_DOCK_PANELS.details,
      timeline: typeof parsed.timeline === 'boolean' ? parsed.timeline : DEFAULT_DOCK_PANELS.timeline,
      checkpoints: typeof parsed.checkpoints === 'boolean' ? parsed.checkpoints : DEFAULT_DOCK_PANELS.checkpoints,
      commits: typeof parsed.commits === 'boolean' ? parsed.commits : DEFAULT_DOCK_PANELS.commits,
    };
  } catch {
    /* 静默 */
  }
  return { ...DEFAULT_DOCK_PANELS };
}

const dockPanelsCollapsed = ref<DockPanels>(loadDockPanels());

watch(dockPanelsCollapsed, (next) => {
  try {
    localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(next));
  } catch {
    /* 静默 */
  }
}, { deep: true });

/** RightDock 4 面板 accordion — 详情页 onToggleDockPanel 同款 (展开一个折叠其余). */
function onToggleDockPanel(panel: 'details' | 'timeline' | 'checkpoints' | 'commits'): void {
  const willExpand = dockPanelsCollapsed.value[panel];
  const next: Record<typeof panel, boolean> = {
    details: true,
    timeline: true,
    checkpoints: true,
    commits: true,
  };
  next[panel] = !willExpand;
  dockPanelsCollapsed.value = next;
}

/* 信息面板整体收/展 — TaskStatusBar ◨按钮承接, 与详情页共用
   task-right-dock-collapsed-v1. R217v4: 收 = 整个右栏 aside 收起 (详情页
   side-col 同语义; v2 时代只隐 RightDock 留标题头, damo 反馈「收不起来」). */
const DOCK_COLLAPSED_KEY = 'task-right-dock-collapsed-v1';
function loadDockCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(DOCK_COLLAPSED_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* 静默 */
  }
  return false;
}
const dockCollapsed = ref<boolean>(loadDockCollapsed());
watch(dockCollapsed, (v) => {
  try {
    localStorage.setItem(DOCK_COLLAPSED_KEY, String(v));
  } catch {
    /* 静默 */
  }
});

function onToggleDockCollapsed(): void {
  dockCollapsed.value = !dockCollapsed.value;
}

/* R217v5: H5 (≤900px) 右栏改抽屉 — 详情页 R59 同款 (damo「h5 模式下右侧
   面板都看不到, 参考详情页带 X 的信息面板」). ESC 关闭. */
function onDockEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !dockCollapsed.value) {
    dockCollapsed.value = true;
  }
}
onMounted(() => document.addEventListener('keydown', onDockEsc));
onBeforeUnmount(() => document.removeEventListener('keydown', onDockEsc));

/** R217v5: aside 内联 style — 桌面态挂 dockWidth (拖拽结果), ≤900px 抽屉走
    CSS width (详情页 dockInlineStyle 同款, 防内联 style 跟抽屉 CSS 抢).
    R236: 断口判断改走 useMediaQuery 响应式 ref (详情页同款) — 原来直接查
    matchMedia 非响应式, 桌面→H5 resize 后残留 inline width 把抽屉顶出屏. */
const isNarrowViewport = useMediaQuery('(max-width: 900px)');
const dockInlineStyle = computed<Record<string, string>>(() => {
  if (isNarrowViewport.value) {
    return {};
  }
  return { width: `${dockWidth.value}px` } as Record<string, string>;
});

/* ------------------------------------------------------------------ */
/*  R217v3: 右栏拖拽调宽 — 详情页 B243 同款实现照搬. 宽度 key 与详情页   */
/*  共用 task-right-dock-width-v1 → 两页拖过一次, 另一页自动同步.        */
/* ------------------------------------------------------------------ */
const DOCK_MIN_W = 280;
const DOCK_MAX_W = 800;
const DOCK_DEFAULT_W = 480;

function loadDockWidth(): number {
  try {
    const raw = localStorage.getItem('task-right-dock-width-v1');
    if (raw == null) return DOCK_DEFAULT_W;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DOCK_DEFAULT_W;
    return Math.max(DOCK_MIN_W, Math.min(DOCK_MAX_W, n));
  } catch {
    return DOCK_DEFAULT_W;
  }
}

const dockWidth = ref<number>(loadDockWidth());

/** 拖拽手柄统一入口 — mouse + touch 共用 (touchmove 用 { passive: false }
    才能 preventDefault 阻页面横滑; 向左拖 = 面板加宽). */
function startDockDrag(ev: MouseEvent | TouchEvent): void {
  ev.preventDefault();
  const startX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX;
  const startW = dockWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const onMove = (e: MouseEvent | TouchEvent): void => {
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    dockWidth.value = Math.max(
      DOCK_MIN_W,
      Math.min(DOCK_MAX_W, startW + (startX - cx)),
    );
  };
  const onUp = (): void => {
    try {
      localStorage.setItem('task-right-dock-width-v1', String(dockWidth.value));
    } catch {
      /* 静默 */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
}

/* 搜索条 / 评分条 — TaskStatusBar 🔍 ⭐ toggle 的承接态, 直通 transcript / 评分条. */
const searchOpen = ref<boolean>(false);
const searchQuery = ref<string>('');
const evalOpen = ref<boolean>(false);

function onToggleSearch(): void {
  searchOpen.value = !searchOpen.value;
}

function onClearSearch(): void {
  searchOpen.value = false;
  searchQuery.value = '';
}

/* 显示模式 — 与详情页共用 task-display-mode-v1 (damo R217「统一的那个」口径). */
type DisplayMode = 'text-only' | 'all' | 'expanded';
const DISPLAY_MODE_KEY = 'task-display-mode-v1';
const DISPLAY_MODES: DisplayMode[] = ['text-only', 'all', 'expanded'];
/* i18n (W3a): 显示模式文案走 t() — 键映射, displayModeLabel computed 见下方. */
const DISPLAY_MODE_LABEL_KEYS: Record<DisplayMode, string> = {
  'text-only': 'tasks.chat.displayModeTextOnly',
  all: 'tasks.chat.displayModeAll',
  expanded: 'tasks.chat.displayModeExpanded',
};
const DISPLAY_MODE_ICONS: Record<DisplayMode, string> = {
  'text-only': 'lines',
  all: 'list',
  expanded: 'expand-list',
};

function loadDisplayMode(): DisplayMode {
  try {
    const raw = localStorage.getItem(DISPLAY_MODE_KEY);
    if (raw && (DISPLAY_MODES as string[]).includes(raw)) return raw as DisplayMode;
  } catch {
    /* 静默 */
  }
  return 'all';
}

const displayMode = ref<DisplayMode>(loadDisplayMode());
const displayModeLabel = computed<string>(() => t(DISPLAY_MODE_LABEL_KEYS[displayMode.value]));

watch(displayMode, (m) => {
  try {
    localStorage.setItem(DISPLAY_MODE_KEY, m);
  } catch {
    /* 静默 */
  }
});

function cycleDisplayMode(): void {
  const idx = DISPLAY_MODES.indexOf(displayMode.value);
  displayMode.value = DISPLAY_MODES[(idx + 1) % DISPLAY_MODES.length];
}

/* session-level Fork — TaskStatusBar Fork 按钮触发, 详情页 R56-A4.1 同款. */
const forkModalRef = ref<InstanceType<typeof ForkModal> | null>(null);
const forkOpen = ref<boolean>(false);

function onOpenFork(): void {
  forkOpen.value = true;
  void nextTick(() => {
    forkModalRef.value?.setSessionHead();
  });
}

function onForkModalClose(): void {
  forkOpen.value = false;
}

function onForked(newTaskId: string): void {
  forkOpen.value = false;
  // 跳到新 task — 详情页同款 hash 路由.
  window.location.href = `#/tasks/${newTaskId}`;
}

/** RightDock checkpoints 面板「Fork from here」触发 — 详情页占位同款 (session 末尾 fork). */
function onForkFromCheckpoint(_checkpointId: number): void {
  onOpenFork();
}

/** 与 TaskStatusBar canFork / RightDock sessionIdAvailable 同口径. */
const isForkableStatus = computed<boolean>(() =>
  ['paused', 'reviewing', 'rejected', 'await_user', 'completed', 'failed', 'cancelled'].includes(activeStatus.value),
);
</script>

<script lang="ts">
/** R56-B6: TaskTranscriptEmbed 包裹层 (镜像 TaskDetailView 内的同名 wrapper).
   透传 forked_at + parent_task + result/error 给 TaskTranscript, 不带搜索
   v-model (chat 模式无搜索条), searchOpen=false + searchQuery='' 让
   transcript 不渲染搜索 input. */
import { defineComponent, h } from 'vue';
import TaskTranscriptComp from '@/components/TaskTranscript.vue';
export const TaskTranscriptEmbed = defineComponent({
  name: 'TaskTranscriptEmbed',
  props: {
    taskId: { type: String, required: true },
    forkedAt: { type: String as PropType<string | null>, default: null },
    parentTask: {
      type: Object as PropType<{ id: string; title: string; status: string } | null>,
      default: null,
    },
    parentTitle: { type: String, default: '' },
    parentPrompt: { type: String, default: '' },
    parentMaxTurns: { type: Number as PropType<number | null>, default: null },
    contextTokens: { type: Number as PropType<number | null>, default: null },
    searchOpen: { type: Boolean, default: false },
    searchQuery: { type: String, default: '' },
    displayMode: {
      type: String as PropType<'text-only' | 'all' | 'expanded'>,
      default: 'all',
    },
    projectId: { type: String as PropType<string | null>, default: null },
    taskResult: { type: String as PropType<string | null>, default: null },
    taskError: { type: String as PropType<string | null>, default: null },
  },
  emits: ['update:searchQuery'],
  setup(props, { emit }) {
    return () =>
      h(TaskTranscriptComp, {
        taskId: props.taskId,
        forkedAt: props.forkedAt,
        parentTask: props.parentTask,
        parentTitle: props.parentTitle,
        parentPrompt: props.parentPrompt,
        parentMaxTurns: props.parentMaxTurns,
        contextTokens: props.contextTokens,
        searchOpen: props.searchOpen,
        searchQuery: props.searchQuery,
        displayMode: props.displayMode,
        projectId: props.projectId,
        taskResult: props.taskResult,
        taskError: props.taskError,
        'onUpdate:searchQuery': (q: string) => emit('update:searchQuery', q),
      });
  },
});
</script>

<template>
  <div class="cv-page" :class="{ 'cv-dragging': chatListDragging }">
    <!-- Left column: task list -->
    <div
      id="chat-list-container"
      class="cv-list"
      :class="[mobilePanel === 'list' ? 'cv-show' : 'cv-hide', 'cv-md-show']"
      :style="{ width: dynamicChatListWidth }"
    >
      <div class="cv-list-head">
        <button type="button" class="cv-new-btn" @click="startNewTask">
          {{ t('tasks.chat.newChatBtn') }}
        </button>
      </div>
      <div class="cv-list-body">
        <div v-if="liveTasks.length === 0" class="cv-list-empty">{{ t('tasks.chat.emptyList') }}</div>
        <button
          v-for="t in liveTasks"
          :key="t.id"
          type="button"
          :class="['cv-task-item', { 'cv-task-item-active': selectedTaskId === t.id }]"
          @click="selectTask(t.id)"
        >
          <span class="cv-task-title">{{ t.title }}</span>
          <!-- R217: global chat 列表项标会话归属 (项目 › 版本), item 高一点可接受 -->
          <span v-if="showScopeLine" class="cv-task-scope">{{ scopeLabelOf(t.project_id, t.version_id) }}</span>
          <span class="cv-task-meta">
            <span :class="['cv-task-status', `cv-task-status--${t.status}`]">{{ statusLabel(t.status) }}</span>
            <span class="cv-task-time">{{ formatUpdatedAt(t.updated_at) }}</span>
          </span>
        </button>
      </div>
      <!-- 列宽拖动手柄 -->
      <div
        class="cv-resize-handle"
        @mousedown="startDrag"
      />
    </div>

    <!-- Right column: chat / new task / empty -->
    <div
      class="cv-main"
      :class="[mobilePanel === 'chat' ? 'cv-show' : 'cv-hide', 'cv-md-show']"
    >
      <!-- R59: 顶部永远就一行静态面包屑 — 用户反馈「不用张开收起了,
           全部放到一行里去」. 不再展开/折叠, 不再有 picker 触发器,
           不再有 pill content / task header / fold button 三段切换.
           内容固定: 项目上下文 › 项目名 [#taskid] 待审核. 换项目走左栏
           列表, 看完整 pill 跳任务详情页. 选了 task 显示 #id, 没选 (新建
           / 空态) 也照样显示一行, 给 chat 模式一个恒定锚点. -->
      <div class="cv-breadcrumb">
        <span class="cv-breadcrumb-label">{{ t('tasks.chat.breadcrumbContext') }}</span>
        <span class="cv-breadcrumb-sep">›</span>
        <span class="cv-breadcrumb-project">{{ selectedTask ? (props.project?.name ?? '—') : effectiveProjectName }}</span>
        <span v-if="selectedTask" class="cv-breadcrumb-id">#{{ selectedTask.id.slice(0, 8) }}</span>
        <!-- R217v3: 状态 chip 移入下方 TaskStatusBar 操作行, breadcrumb 不再重复显示 -->
        <!-- R217v4 (damo): 详情开关按钮删除 — 收/展统一走 TaskStatusBar ◨
             (与详情页同语义: 收 = 整个右栏收起, key 同为 task-right-dock-collapsed-v1)。
             R217v6: 标题放行尾改跟 #taskid 自然衔接。 -->
        <router-link
          v-if="selectedTask && taskDetail"
          :to="`/tasks/${taskDetail.id}`"
          class="cv-breadcrumb-title"
          :title="t('tasks.chat.openDetailTitle', { title: taskDetail.title })"
        >{{ taskDetail.title }}</router-link>
        <!-- R236 (damo): 聊天模式补任务指标 — 面包屑行尾 (标题右侧) 常驻小字
             chips: 模型 · 上下文(带阈值配色) · 成本. liveContext/liveCost 走
             父级 SSE 实时刷新, 无数据的 chip 自动隐藏 (组件内 v-if). 窄屏由
             .cv-breadcrumb flex-wrap 折到第二行, 不跟标题挤. -->
        <TaskMetaChips
          v-if="selectedTask && taskDetail"
          class="cv-meta-chips"
          :model="taskDetail.resolved_model || taskDetail.model"
          :context-tokens="liveContext?.tokens ?? taskDetail.context_tokens ?? null"
          :context-max="liveContext?.max ?? taskDetail.context_max ?? null"
          :cost="liveCost ?? taskDetail.cost_usd"
        />
      </div>

      <!-- R217v3 (damo 返工): 操作行挪出右栏 → 聊天内容上方全宽一行 (详情页
           TaskStatusBar 同款横排; damo「操作按钮在聊天内容的上方一排, 一行
           拍下来」). 状态 chip / LifecycleActions / 完整会话 / 聊天视图 / 搜索 /
           评分 / Fork / 新建 / 显示模式 全部随行; 右栏只留标题 + 信息面板. -->
      <div v-if="selectedTask && taskDetail" class="cv-statusbar-row">
        <!-- R217v6 (damo): 本来就在聊天视图, 「聊天视图」链接没意义 — 传
             task-view-href 让 TaskStatusBar 把它换成「任务视图」(跳详情页,
             效果同点面包屑标题). -->
        <TaskStatusBar
          :task-id="taskDetail.id"
          :status="activeStatus"
          :task-type="taskDetail.type ?? null"
          :deleted-at="taskDetail.deleted_at"
          :awaiting-owner-review="!!taskDetail.awaiting_owner_review"
          :project-id="taskDetail.project_id"
          :version-id="taskDetail.version_id"
          :task-view-href="`#/tasks/${taskDetail.id}`"
          :dock-open="{
            details: !dockPanelsCollapsed.details,
            timeline: !dockPanelsCollapsed.timeline,
            checkpoints: !dockPanelsCollapsed.checkpoints,
            commits: !dockPanelsCollapsed.commits,
          }"
          :dock-collapsed="dockCollapsed"
          :search-open="searchOpen"
          :search-query="searchQuery"
          :eval-open="evalOpen"
          :display-mode-mode="displayMode"
          :display-mode-label="displayModeLabel"
          :display-mode-icon="DISPLAY_MODE_ICONS[displayMode]"
          @toggle-dock-collapsed="onToggleDockCollapsed"
          @toggle-search="onToggleSearch"
          @clear-search="onClearSearch"
          @toggle-eval="evalOpen = !evalOpen"
          @open-fork="onOpenFork"
          @cycle-display-mode="cycleDisplayMode"
        >
          <template #actions>
            <LifecycleActions
              :task-id="taskDetail.id"
              :status="activeStatus"
              :deleted-at="taskDetail.deleted_at"
              :awaiting-owner-review="!!taskDetail.awaiting_owner_review"
              @changed="onSideStatusChanged"
              @open-resume="resumeOpen = true"
            />
          </template>
        </TaskStatusBar>
      </div>
      <TaskEvaluationBar
        v-if="evalOpen && selectedTask && taskDetail && (activeStatus === 'completed' || activeStatus === 'rejected')"
        :task-id="taskDetail.id"
        class="cv-evalbar-row"
      />

      <!-- R217: 聊天主体 + 右侧操作面板横向排布. cv-body 占 breadcrumb 以下
           全部高度, cv-chat-col 是原聊天列 (transcript + input), cv-side 是
           详情/操作面板 (与任务详情页同款 LifecycleActions, 版本 chat 与
           global chat 共用本组件 → 两处展示自动同步). -->
      <div class="cv-body">
      <div class="cv-chat-col">
      <!-- chat 主体 — 选 task 后拉详情 + 渲染 transcript + input. 镜像
           master chat-view.tsx 嵌 TaskDetailClient 形态. -->
      <div v-if="selectedTask" class="cv-task-detail">
        <div v-if="taskDetailLoading && !taskDetail" class="cv-task-detail-state">
          <Loading />
        </div>
        <div v-else-if="taskDetailError && !taskDetail" class="cv-task-detail-state">
          <div class="cv-task-detail-error">
            <p class="cv-task-detail-error-msg">{{ taskDetailError }}</p>
            <button type="button" class="cv-task-detail-retry" @click="selectedTaskId && loadTaskDetail(selectedTaskId)">
              {{ t('tasks.chat.retry') }}
            </button>
          </div>
        </div>
        <template v-else-if="taskDetail">
          <TaskTranscriptEmbed
            :task-id="taskDetail.id"
            :forked-at="taskDetail.forked_at ?? null"
            :parent-task="taskDetail.parent_task ?? null"
            :parent-title="selectedTask.title"
            :parent-prompt="taskDetail.prompt"
            :parent-max-turns="taskDetail.max_turns"
            :context-tokens="taskDetail.context_tokens ?? null"
            :search-open="searchOpen"
            :search-query="searchQuery"
            :display-mode="displayMode"
            :project-id="taskDetail.project_id"
            :task-result="taskDetail.result"
            :task-error="taskDetail.error"
            @update:search-query="(q: string) => (searchQuery = q)"
          />
          <TaskMessageInput
            :task-id="taskDetail.id"
            :status="liveStatus ?? taskDetail.status"
            :disabled="!!taskDetail.deleted_at"
            :disabled-reason="taskDetail.deleted_at ? t('tasks.chat.taskDeleted') : ''"
            :initial-auto-approve="!!taskDetail.auto_approve"
            :initial-model="taskDetail.model"
            :initial-effort="taskDetail.effort"
            :initial-max-turns="taskDetail.max_turns"
            :context-project-id="taskDetail.project_id"
            :context-version-id="taskDetail.version_id"
            :context-model="taskDetail.model"
            :context-effort="taskDetail.effort"
          />
        </template>
      </div>

      <!-- 新建 task 输入区 -->
      <div v-else-if="showNewTaskInput" class="cv-new">
        <div class="cv-new-inner">
          <div
            ref="dropZoneRef"
            class="cv-new-card"
            :class="{ 'cv-new-card-drag': draggingFiles }"
            @dragover="onDropZoneOver"
            @dragleave="onDropZoneLeave"
            @drop="onDropZoneDrop"
          >
            <div
              class="cv-new-resize"
              :title="t('tasks.chat.resizeInputTitle')"
              @mousedown="startResize"
            >
              <span class="cv-new-resize-bar" />
            </div>
            <!-- R220: 项目 › 版本 选择器 — 默认当前激活上下文 (global=筛选栏联动),
                 filterable 模糊搜索可切换任意项目/版本. 新建不再被 props 锁死. -->
            <div class="cv-ctx-row">
              <div class="cv-ctx-field">
                <label class="cv-ctx-label">{{ t('tasks.chat.projectLabel') }}</label>
                <Select
                  :model-value="ctxProjectId"
                  :options="ctxProjectOptions"
                  filterable
                  :placeholder="t('tasks.chat.projectPlaceholder')"
                  class-name="cv-ctx-select"
                  @update:model-value="onCtxProjectChange"
                />
              </div>
              <div class="cv-ctx-field">
                <label class="cv-ctx-label">{{ t('tasks.chat.versionLabel') }}</label>
                <Select
                  :model-value="ctxVersionId"
                  :options="ctxVersionOptions"
                  filterable
                  :placeholder="t('tasks.chat.noVersion')"
                  class-name="cv-ctx-select"
                  @update:model-value="onCtxVersionChange"
                />
              </div>
            </div>
            <!-- R64 豁免: chat 指令输入是交互式 prompt editor, 用了 Textarea 组件不
                 支持的能力 (@paste 文件粘贴 + @keydown Cmd+Enter 提交 + 自定义
                 resize handle + :style 动态高度). 强切会丢 3 个交互, 见
                 Pagination.vue / LifecycleActions.vue 的同款注释豁免. -->
            <textarea
              ref="newPromptRef"
              v-model="newPrompt"
              class="cv-new-textarea"
              :style="newPromptStyle"
              :placeholder="t('tasks.chat.promptPlaceholder')"
              :disabled="creating"
              rows="6"
              @paste="onPromptPaste"
              @keydown="onPromptKeyDown"
            />
            <div class="cv-new-toolbar">
              <!-- R220: 常显「模型 · 强度」— advanced 折在齿轮后导致「没法选模型、
                   思考程度」; 常显当前值后可发现性直接可见, 点击展开改. -->
              <button
                type="button"
                class="cv-advanced-chip"
                :class="{ 'cv-advanced-btn-on': showAdvanced }"
                :title="t('tasks.chat.advancedTitle')"
                @click="showAdvanced = !showAdvanced"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" class="cv-advanced-icon">
                  <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
                </svg>
                <span class="cv-advanced-chip-text">{{ advancedSummary }}</span>
              </button>
              <div class="cv-new-actions">
                <FileInput
                  ref="fileInputRef"
                  multiple
                  @change="onFileInputChange"
                />
                <button
                  type="button"
                  class="cv-attach-btn"
                  :title="t('tasks.chat.attachTitle')"
                  :disabled="creating"
                  @click="() => fileInputRef?.open()"
                >
                  📎
                </button>
                <button
                  type="button"
                  class="cv-send-btn"
                  :disabled="!newPrompt.trim() || creating"
                  @click="createTask"
                >
                  {{ creating ? t('tasks.chat.creating') : t('tasks.chat.send') }}
                </button>
              </div>
            </div>

            <!-- 附件 chips -->
            <div v-if="pendingFiles.length > 0" class="cv-attach-list">
              <span
                v-for="(f, i) in pendingFiles"
                :key="i"
                class="cv-attach-chip"
              >
                <span class="cv-attach-name">{{ f.name }}</span>
                <span class="cv-attach-size">({{ formatSize(f.size) }})</span>
                <button type="button" class="cv-attach-remove" @click="removePendingFile(i)">×</button>
              </span>
            </div>

            <!-- 高级配置 (master chat-view.tsx:849-891 同款 4 行: model + effort +
                 maxTurns + autoApprove, 2 列 sm+ grid). SPA 之前漏 model 行, 导致
                 advancedModel ref 在 POST body 写出但 UI 完全暴露 → 用户看不到模型
                 下拉. 接 useAvailableModels() 后 model 选项 = configured + builtin
                 + used 三源并集, 跟 TaskMessageInput/Templates/Settings 同源. -->
            <div v-if="showAdvanced" class="cv-advanced">
              <div class="cv-advanced-grid">
                <div class="cv-advanced-row">
                  <label class="cv-advanced-label">{{ t('tasks.chat.modelLabel') }}</label>
                  <Select
                    :model-value="advancedModel"
                    :options="modelOptions"
                    :disabled="modelOptionsLoading"
                    class-name="cv-advanced-select"
                    @update:model-value="(v: string | null) => { advancedModel = v ?? ''; }"
                  />
                </div>
                <div class="cv-advanced-row">
                  <label class="cv-advanced-label">{{ t('tasks.chat.effortLabel') }}</label>
                  <Select
                    :model-value="advancedEffort"
                    :options="EFFORT_OPTIONS_ADV"
                    class-name="cv-advanced-select"
                    @update:model-value="(v: string | null) => { advancedEffort = v ?? 'high'; }"
                  />
                </div>
                <div class="cv-advanced-row">
                  <label class="cv-advanced-label">{{ t('tasks.chat.maxTurnsLabel') }}</label>
                  <Input
                    v-model="advancedMaxTurns"
                    type="number"
                    :placeholder="t('tasks.chat.maxTurnsPlaceholder')"
                    class-name="cv-advanced-input"
                  />
                </div>
                <div class="cv-advanced-row cv-advanced-check">
                  <Checkbox
                    v-model="advancedAutoApprove"
                    :label="t('tasks.chat.autoApprove')"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 空态 -->
      <div v-else class="cv-empty">
        <svg viewBox="0 0 60 60" fill="currentColor" class="cv-empty-icon">
          <rect x="5" y="10" width="50" height="35" rx="4" />
          <path d="M18 45l6 8 6-8" />
        </svg>
        <p class="cv-empty-text">{{ t('tasks.chat.emptyText') }}</p>
        <p class="cv-empty-hint">{{ t('tasks.chat.emptyHint') }}</p>
      </div>
      </div>
      <!-- /cv-chat-col -->

      <!-- R217v5: H5 抽屉遮罩 — 点击关闭 (详情页 R59 同款; CSS 限 ≤900px 才有
           形态, PC 上无样式 0 高度不碍布局). -->
      <div
        v-if="selectedTask && taskDetail"
        v-show="!dockCollapsed"
        class="dock-backdrop"
        @click="onToggleDockCollapsed"
        aria-hidden="true"
      ></div>
      <!-- R217v3: 主区 ↔ 右栏拖拽手柄 — 详情页 B243 同款 (280/800/480 +
           task-right-dock-width-v1 共享持久化, 跨页宽度互通). DOM 顺序必须在
           cv-chat-col 与 cv-side 之间, 否则拖拽命中会漂到 viewport 边缘. -->
      <div
        v-if="selectedTask && taskDetail"
        v-show="!dockCollapsed"
        class="dock-resize-handle"
        :title="t('tasks.chat.dockResizeTitle')"
        @mousedown="startDockDrag"
        @touchstart="startDockDrag"
      />
      <!-- R217v2 (damo 返工): 右面板整体换成详情页同款 — 操作行 TaskStatusBar
           (状态 chip + LifecycleActions + 完整会话/聊天视图/面板/搜索/评分/Fork/
           新建/显示模式, damo「一行操作也都要拿过来直接」) + 信息面板 RightDock
           (详情/时间线/Checkpoints/Commits 4 accordion, damo「正常的应该是这个
           面板」). 元信息/时间展示全在 RightDock 内部 → 时间自动走统一
           parseDbTime 格式化. 仅选中 task 时挂载, 开/关走 v-show (H5 抽屉
           transition 需要元素常驻); <900px 抽屉化见 CSS.
           R217v4: 操作行已挪聊天内容上方; 标题挪面包屑行尾; aside 收/展 =
           TaskStatusBar ◨ (dockCollapsed, 与详情页同 key 同语义).
           R217v5: aside 顶部加详情页同款「信息面板 + ×」标题行 (R61: PC 也显
           示), ≤900px 整体抽屉化 (fixed + translateX + 遮罩 + ESC). -->
      <aside
        v-if="selectedTask && taskDetail"
        v-show="!dockCollapsed"
        class="cv-side"
        :class="{ 'cv-side--drawer-open': !dockCollapsed }"
        :style="dockInlineStyle"
      >
        <div class="dock-drawer-header">
          <h2 class="dock-drawer-title">{{ t('tasks.chat.dockTitle') }}</h2>
          <button
            type="button"
            class="dock-drawer-close"
            :title="t('tasks.chat.dockCloseTitle')"
            :aria-label="t('tasks.chat.dockCloseTitle')"
            @click="onToggleDockCollapsed"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>
        <div class="cv-side-dock">
          <RightDock
            :task-id="taskDetail.id"
            :task="{
              id: taskDetail.id,
              title: taskDetail.title,
              prompt: taskDetail.prompt,
              status: activeStatus,
              model: taskDetail.model,
              cwd: taskDetail.cwd ?? null,
              allowed_tools: taskDetail.allowed_tools ?? null,
              tags: taskDetail.tags ?? null,
              project_id: taskDetail.project_id,
              version_id: taskDetail.version_id,
              session_id: taskDetail.session_id ?? null,
              result: taskDetail.result,
              error: taskDetail.error,
              preflight_result: taskDetail.preflight_result ?? null,
              requirement_id: taskDetail.requirement_id ?? null,
              base_commit: taskDetail.base_commit ?? null,
              head_commit: taskDetail.head_commit ?? null,
              card_summary: taskDetail.card_summary ?? null,
              result_layers: taskDetail.result_layers ?? null,
            }"
            :parent-task="taskDetail.parent_task ?? null"
            :dispatcher-task="taskDetail.dispatcher_task ?? null"
            :dispatched-tasks="taskDetail.dispatched_tasks ?? []"
            :depends-on-tasks="taskDetail.depends_on_tasks ?? []"
            :dependent-tasks="taskDetail.dependent_tasks ?? []"
            :requirement-link="taskDetail.requirement_link ?? null"
            :requirement-siblings="taskDetail.requirement_siblings ?? []"
            :collapsed="dockPanelsCollapsed"
            :session-id-available="isForkableStatus"
            @toggle="onToggleDockPanel"
            @fork-from-checkpoint="onForkFromCheckpoint"
          />
        </div>
      </aside>
      <!-- /cv-side -->
      </div>
      <!-- /cv-body -->

      <!-- R52.9 同款: paused 态 ▶ 恢复执行 → ResumeModal 收 auto_approve/max_turns -->
      <ResumeModal
        v-if="resumeOpen && activeStatus === 'paused' && taskDetail"
        :task-id="taskDetail.id"
        :current-auto-approve="taskDetail.auto_approve ?? null"
        :current-max-turns="taskDetail.max_turns"
        @close="onResumeClose"
        @resumed="onResumed"
      />
      <!-- R217v2: 操作行 Fork 按钮触发 — 详情页 R56-A4.1 同款 session 末尾 fork -->
      <ForkModal
        v-if="forkOpen && taskDetail"
        ref="forkModalRef"
        :task-id="taskDetail.id"
        :parent-title="taskDetail.title"
        :parent-prompt="taskDetail.prompt"
        :parent-max-turns="taskDetail.max_turns"
        :context-tokens="taskDetail.context_tokens ?? null"
        :compact-threshold="180000"
        @close="onForkModalClose"
        @forked="onForked"
      />
    </div>
  </div>
</template>

<style scoped>
.cv-page {
  /* R59: 改用 absolute + inset: 0 覆盖 gb-body 的 padding box (包括 32px
     底部内边距). 之前 height: 100% 只填到 content box, 输入框距视口底
     有 32px 空白. absolute 要求父级 (gb-body) position: relative, 已在
     GlobalBoard.vue 配套加. 仅 chat 模式生效 (其他模式用自己的卡片/列表/
     看板容器, 不在 gb-body 里直接渲染 ChatView). */
  display: flex;
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.cv-page.cv-dragging {
  cursor: col-resize;
  user-select: none;
}

.cv-list {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg-elevated, #fff);
  position: relative;
  min-width: 0;
}

.cv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

/* ------------------------------------------------------------------ */
/*  Mobile panel toggle                                                */
/* ------------------------------------------------------------------ */

.cv-show { display: flex; }
.cv-hide { display: none; }

@media (min-width: 768px) {
  .cv-md-show { display: flex !important; }
}

/* ------------------------------------------------------------------ */
/*  Left column (task list)                                            */
/* ------------------------------------------------------------------ */

.cv-list-head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg, #fff);
}

.cv-new-btn {
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius, 6px);
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.cv-new-btn:hover {
  background: var(--color-primary-hover, #1d4ed8);
}

.cv-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cv-list-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted, #6b7280);
}

.cv-task-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius, 6px);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  min-width: 0;
}

.cv-task-item:hover {
  background: var(--color-bg, #f3f4f6);
}

.cv-task-item-active {
  background: var(--tw-blue-50);
  border-color: var(--color-primary, #2563eb);
}

.cv-task-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text, #111827);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cv-task-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-muted, #6b7280);
}

.cv-task-status {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  flex-shrink: 0;
}

/* R37: 对齐 master src/lib/constants.ts STATUS_COLORS, 11 个 task status
   各自独立配色 (SPA 没有 Tailwind, 写 hex). Tailwind v3 调色板:
   gray-100/700, blue-100/700, sky-100/700, yellow-100/700, purple-100/700,
   amber-100/700, emerald-100/700, red-100/700, orange-50/600, gray-100/500. */
.cv-task-status--pending { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.cv-task-status--queued { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.cv-task-status--running { background: var(--tw-sky-100); color: var(--tw-sky-700); }
.cv-task-status--paused { background: var(--tw-amber-100); color: var(--tw-yellow-700); }
.cv-task-status--reviewing { background: var(--tw-purple-100); color: var(--tw-purple-700); }
.cv-task-status--verifying { background: var(--tw-amber-100); color: var(--tw-yellow-700); }
.cv-task-status--await_user { background: var(--tw-amber-100); color: var(--tw-amber-700); }
.cv-task-status--completed { background: var(--tw-emerald-100); color: var(--tw-emerald-700); }
.cv-task-status--failed { background: var(--tw-red-100); color: var(--tw-red-700); }
.cv-task-status--rejected { background: var(--tw-orange-50); color: var(--tw-orange-600); }
.cv-task-status--cancelled { background: var(--tw-gray-100); color: var(--tw-gray-500); }

.cv-task-time {
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* R217: 列表项归属行 (项目 › 版本) — global chat 未锁版本时显示 */
.cv-task-scope {
  font-size: 10px;
  color: var(--color-text-muted, #9ca3af);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* Resize handle — R56-B11: 用户反馈两侧边界拖不动. 之前 width: 4px + 透明背景
   + z-index: 10 鼠标精确 hover 4px 才看到反馈 + 命中的概率低. 加宽到 6px,
   默认 4% 灰底视觉提示 (常驻可见, 不依赖 hover 才发现), hover/active 蓝.
   pointer-events: auto 兜底, 万一父级误设 pointer-events: none 也能命中.
   z-index 提到 50 高过 .cv-picker (40) 与其他内容层, 不再被遮. */
.cv-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 50;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.04);
  transition: background 0.15s;
}

.cv-resize-handle:hover {
  background: rgba(37, 99, 235, 0.5);
}

.cv-resize-handle:active {
  background: rgba(37, 99, 235, 0.7);
}

/* ------------------------------------------------------------------ */
/*  Breadcrumb (永久一行, R59 用户反馈)                                  */
/* ------------------------------------------------------------------ */

.cv-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg-elevated, #fff);
  flex-shrink: 0;
  overflow: hidden;
  /* R236: 行尾指标 chips (cv-meta-chips, flex-shrink:0) 窄屏放不下时折到
     第二行, 而不是把标题/项目名压没或被 overflow:hidden 裁掉. */
  flex-wrap: wrap;
}

.cv-breadcrumb-label {
  font-size: 11px;
  color: var(--color-text-muted, #9ca3af);
  flex-shrink: 0;
}

.cv-breadcrumb-sep {
  font-size: 11px;
  color: var(--color-text-muted, #9ca3af);
  flex-shrink: 0;
}

.cv-breadcrumb-project {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
}

.cv-breadcrumb-id {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--color-text-muted, #6b7280);
  flex-shrink: 0;
}

.cv-breadcrumb .cv-task-header-status {
  margin-left: auto;
  flex-shrink: 0;
}

/* R217v4 (damo): 面包屑任务标题 — 保持详情页超链接. 单行省略, 挤压时不把
   面包屑其他元素顶出. <900px 右栏隐藏时照常显示 (标题是纯链接, 不依赖面板).
   R217v6 (damo): 不用推到行尾 — 跟在 #taskid 后面自然排 (margin-left:auto 删). */
.cv-breadcrumb-title {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text, #111827);
  text-decoration: none;
}

.cv-breadcrumb-title:hover {
  color: var(--color-primary, #2563eb);
  text-decoration: underline;
}

/* R236: 行尾任务指标 chips — margin-left:auto 推到行尾 (与标题自然衔接),
   flex-shrink:0 保小字不被压缩变形; 窄屏放不下随 .cv-breadcrumb wrap 折行. */
.cv-meta-chips {
  margin-left: auto;
  flex-shrink: 0;
  padding: 2px 0;
}

/* ------------------------------------------------------------------ */
/*  R217: 聊天主体横排 (cv-chat-col + cv-side)                          */
/* ------------------------------------------------------------------ */

.cv-body {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.cv-chat-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}

/* R217v3: 操作行 — 聊天内容上方全宽一行 (详情页 TaskStatusBar 同款横排),
   窄窗口 wrap 换行不挤.
   R217v6 (damo): 背景铺满 — padding/border 从本行挪走 (tsb-root 自带
   bg-elevated + border-bottom), 本行只做 flex 容器, 子元素 flex:1 撑满全宽. */
.cv-statusbar-row {
  display: flex;
  align-items: flex-start;
  min-width: 0;
}

.cv-statusbar-row > * {
  min-width: 0;
  flex: 1;
}

/* R217v3: 评分条跟随操作行, 同宽横条. */
.cv-evalbar-row {
  padding: 6px 14px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
}

/* R217v3: 拖拽手柄 — 详情页 .dock-resize-handle 同款 (1px 瘦线 + hover/active 蓝). */
.dock-resize-handle {
  width: 8px;
  align-self: stretch;
  cursor: col-resize;
  pointer-events: auto;
  background: transparent;
  border-left: 1px solid rgba(156, 163, 175, 1); /* gray-400 常驻可见分隔线 */
  transition: background 0.15s, border-color 0.15s;
  touch-action: none;
}

.dock-resize-handle:hover {
  background: rgba(96, 165, 250, 0.15);
  border-left-color: rgba(59, 130, 246, 1);
}

.dock-resize-handle:active {
  background: rgba(96, 165, 250, 0.3);
  border-left-color: rgba(37, 99, 235, 1);
}

.cv-side {
  /* R217v3: 面板内部自己管滚动 — RightDock accordion 面板 flex-1 内滚
     (详情页 side-col 同款), 外层不再 overflow-y: auto 整页滚.
     宽度由 dockInlineStyle 桌面态给 (280~800 可拖); ≤900px 抽屉化见 media.
     R217v5: padding/gap 挪进 .cv-side-dock — 抽屉标题行要通栏贴顶 (详情页
     dock-drawer-header 同款 border-bottom 通栏). */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated, #fff);
  overflow: hidden;
  min-height: 0;
}

/* R217v5: 抽屉标题行 — 详情页 dock-drawer-header 同款移植 (R61: PC 也显示,
   × 收起整个右栏, 不用回状态栏找 ◨). */
.dock-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg, #fff);
  flex-shrink: 0;
}

.dock-drawer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.dock-drawer-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--color-text-muted, #6b7280);
  width: 30px;
  height: 30px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  flex-shrink: 0;
}

.dock-drawer-close:hover {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text);
}

@media (max-width: 899px) {
  .dock-resize-handle {
    display: none;
  }
  /* R217v5: H5 右栏 = 抽屉 overlay (详情页 R59 side-col 同款) — 原来
     display:none 整个藏掉 (damo「h5 模式下右侧面板都看不到」), 改 fixed
     右滑入, 不占主区宽度. top=AppHeader 44 (chat 无固定第二行, 详情页是
     88=AppHeader+TaskStatusBar). */
  .cv-side {
    position: fixed;
    top: 44px;
    right: 0;
    bottom: 0;
    /* R236: 同详情页 side-col — 内联 width (桌面拖拽 dockWidth) 在桌面→H5
       resize 后残留且 CSS 优先级压过普通规则, 必须 !important 兜底,
       否则 480px 抽屉在 390px 屏上整体出画 (damo 1011 实证). */
    width: min(360px, 90vw) !important;
    min-width: 0 !important;
    max-width: 90vw;
    z-index: 60;
    transform: translateX(100%);
    transition: transform 0.25s ease;
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.08);
  }
  .cv-side--drawer-open {
    transform: translateX(0);
  }
  /* 遮罩只在 ≤900px 有形态 (R59 回归教训: 规则进 media, 否则 PC 全屏蒙层). */
  .dock-backdrop {
    position: fixed;
    top: 44px;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 55;
    animation: dock-backdrop-in 0.2s ease;
  }
}
@keyframes dock-backdrop-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* R217v2: RightDock 容器 — 占 cv-side 剩余全部高度, accordion 内滚.
   flex:1 + min-height:0 让展开的面板撑满 (详情页 side-col 同款).
   R217v5: padding 从 .cv-side 挪到这里 (抽屉标题行通栏). */
.cv-side-dock {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.cv-side-dock > * {
  min-height: 0;
}

/* 状态 chip — 复用, breadcrumb / task-status 都用 */
.cv-task-header-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}

/* chat 主体 — transcript + input 容器. flex column 让 transcript 撑 flex:1,
   input 缩到底部. */
.cv-task-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* R56-B6: transcript + input loading/error 居中占位 (替代旧 cv-task-detail-body
   的 prompt_preview 小块). cv-task-detail 已经是 flex column + min-height: 0,
   TaskTranscriptEmbed 子元素自己撑 flex: 1, 这里只控 state 块的内边距. */
.cv-task-detail-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}

.cv-task-detail-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.cv-task-detail-error-msg {
  margin: 0;
  font-size: 13px;
  color: var(--color-danger, #b91c1c);
}

.cv-task-detail-retry {
  padding: 6px 14px;
  font-size: 12px;
  background: var(--color-primary, #2563eb);
  color: #fff;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

.cv-task-detail-retry:hover {
  background: var(--color-primary-hover, #1d4ed8);
}

/* ------------------------------------------------------------------ */
/*  New task input panel                                               */
/* ------------------------------------------------------------------ */

.cv-new {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--color-bg, #f9fafb);
  padding: 24px;
  min-height: 0;
}

.cv-new-inner {
  width: 100%;
  max-width: 720px;
  /* R220: 高度约束链 — cv-new-card 的 max-height:100% 相对本层, 本层不约束
     则 100% 失效, 卡片继续向上溢出 (ctx-row 顶出视口). */
  max-height: 100%;
  min-height: 0;
}

.cv-new-card {
  background: var(--color-bg-elevated, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s, background 0.15s;
  /* R220: 新增 ctx-row 后卡片内容变高, flex-end 对齐下超高会从顶部溢出
     (选择器行被顶出视口). max-height + 内滚兜住. */
  max-height: 100%;
  overflow-y: auto;
}

.cv-new-card-drag {
  border-color: var(--color-primary, #60a5fa);
  background: rgba(239, 246, 255, 0.5);
}

.cv-new-resize {
  display: none;
  height: 6px;
  cursor: ns-resize;
  align-items: center;
  justify-content: center;
  margin: -4px 0;
  border-radius: 3px;
}

.cv-new-resize:hover {
  background: rgba(37, 99, 235, 0.08);
}

.cv-new-resize-bar {
  display: block;
  width: 40px;
  height: 3px;
  background: var(--tw-gray-300);
  border-radius: 999px;
}

@media (min-width: 640px) {
  .cv-new-resize { display: flex; }
}

.cv-new-textarea {
  width: 100%;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5rem;
  resize: none;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.cv-new-textarea:focus {
  border-color: var(--color-primary, #93c5fd);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.cv-new-textarea:disabled {
  background: var(--color-bg, #f3f4f6);
}

@media (min-width: 640px) {
  .cv-new-textarea {
    min-height: 60px;
    max-height: 400px;
  }
}

.cv-new-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

/* R220: 新建卡片「项目 › 版本」选择器行 */
.cv-ctx-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.cv-ctx-field {
  flex: 1;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cv-ctx-label {
  font-size: 12px;
  color: var(--color-text-muted, #6b7280);
}

.cv-ctx-select {
  width: 100%;
}

/* R220: 常显「模型 · 强度」chip — 取代纯图标齿轮, 可发现性可见 */
.cv-advanced-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
  color: var(--color-text-muted, #6b7280);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.cv-advanced-chip:hover {
  background: var(--color-bg, #f3f4f6);
  border-color: var(--color-border-strong, #9ca3af);
}

.cv-advanced-chip-text {
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cv-advanced-btn {
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 6px;
  padding: 6px 8px;
  background: transparent;
  color: var(--color-text-muted, #6b7280);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.cv-advanced-btn:hover {
  background: var(--color-bg, #f3f4f6);
  border-color: var(--color-border-strong, #9ca3af);
}

.cv-advanced-btn-on {
  background: var(--tw-blue-50);
  border-color: var(--color-primary, #93c5fd);
  color: var(--color-primary, #2563eb);
}

.cv-advanced-icon {
  width: 16px;
  height: 16px;
}

.cv-new-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cv-attach-btn {
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
  color: var(--color-text-muted, #6b7280);
  cursor: pointer;
  transition: background 0.15s;
}

.cv-attach-btn:hover:not(:disabled) {
  background: var(--color-bg, #f3f4f6);
}

.cv-attach-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cv-send-btn {
  border: 0;
  border-radius: 6px;
  padding: 8px 16px;
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.cv-send-btn:hover:not(:disabled) {
  background: var(--color-primary-hover, #1d4ed8);
}

.cv-send-btn:disabled {
  background: var(--tw-gray-300);
  cursor: not-allowed;
}

/* 附件 chips */
.cv-attach-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cv-attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 4px;
  background: var(--color-bg, #f9fafb);
  font-size: 11px;
  color: var(--color-text-muted, #374151);
}

.cv-attach-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.cv-attach-size {
  color: var(--color-text-muted, #9ca3af);
}

.cv-attach-remove {
  border: 0;
  background: transparent;
  color: var(--color-text-muted, #9ca3af);
  cursor: pointer;
  margin-left: 2px;
  font-size: 13px;
  line-height: 1;
}

.cv-attach-remove:hover {
  color: var(--tw-red-500);
}

/* 高级配置 — master chat-view.tsx:849 grid grid-cols-1 sm:grid-cols-2 同款. */
.cv-advanced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border, #f3f4f6);
}

.cv-advanced-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

@media (min-width: 640px) {
  .cv-advanced-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.cv-advanced-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cv-advanced-label {
  font-size: 12px;
  color: var(--color-text-muted, #6b7280);
  flex-shrink: 0;
  width: 70px;
}

.cv-advanced-select {
  flex: 1;
  min-width: 0;
}

.cv-advanced-input {
  flex: 1;
  min-width: 0;
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

.cv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--color-bg, #f9fafb);
  color: var(--color-text-muted, #6b7280);
}

.cv-empty-icon {
  width: 60px;
  height: 60px;
  color: var(--tw-gray-300);
  margin-bottom: 12px;
}

.cv-empty-text {
  margin: 0;
  font-size: 14px;
}

.cv-empty-hint {
  margin: 4px 0 0;
  font-size: 12px;
}
</style>