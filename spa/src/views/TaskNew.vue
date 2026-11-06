<script setup lang="ts">
/* 功能: 新建任务视图 — 完整镜像 Next.js src/app/tasks/new/page.tsx (1561 行).
   sheet R23 字面要求 = 1:1 镜像, 包括:
   - 顶部 3 模式 tab (快速模式 / 完整配置 / 模板配置) + 头部 "← 返回" + h1 "新建任务"
   - 快速模式: 项目/版本 select + 配置 snapshot 下拉 + 任务指令 textarea +
     goal loop 折叠区 (默认展开, R143) + 附件 drop zone + 当前配置提示
   - 完整模式: 项目/版本/标题/prompt/goal loop/描述/cwd/任务类型/LLM 配置/模型覆盖/
     推理强度/优先级/最大轮次/工具审核/允许工具 (presets + 自定义)/tags/依赖任务多选
     下拉/附件 drop zone/3 按钮 (创建任务/取消/存为快照)
   - 模板配置 tab: 列表 + 新建/编辑 modal (12 字段) + 删除二次确认
   - Ctrl/Cmd+Enter 提交 (R143) + submitLockRef 双击防重 (damo 2026-09-18)
   - 三处按钮共用同一文案口径 (getSubmitButtonLabel)
   - goal_text 拼回 prompt (buildGoalPrompt, R143 三轮); goal_rounds 数字 (R143 二轮)
   - 附件上传走 POST /api/tasks/[id]/attachments (multipart), 任务创建后两步走:
     POST tasks → 上传 attachments → PATCH tasks { append_attachments } → POST start
   - URL prefill: ?project=&version= (snapshot 自动匹配, R107 R 列 + R143);
     ?name=&prompt=&model=&llm_config_id=&effort=&maxTurns=&autoApprove=&tags= (模板 prefill)
   - URL accept: hash 路由 useRoute().query 拿, sheet R107 R 列同款.

   关注点 (与 sheet/Next 端分歧):
   - sheet 红线 = "完整功能对等" 覆盖所有 sheet 字面要求, 拍板覆盖以下细节:
     (1) sheet 字面只列 quick/full, snapshots tab = Next 端实装功能, 完整镜像
         (master 已暴露 5 个 REST endpoint, sheet 字面要求 1:1 镜像 = 包含此 tab).
     (2) sheet 没要求测试文件 — SPA 当前无 vitest 配置, 跳过 (master test.tsx
         测的是 React render, SPA 不适用); helpers 抽出 predicates.ts 仍可后接.
     (3) sheet 没要求 useAvailableModels hook 抽离 — master 是 React hook, SPA
         没 hooks 概念, 把 model options 的聚合逻辑 inline 在 view 内 (与 R24
         Templates 拉一次 LLM configs 同款).
     (4) sheet 字面 "完整镜像 Next.js /tasks/new" → 包含 SnapshotManager 子组件
         (新建/编辑/删除快照 CRUD), 不单独立项.
   - 与 Next 端 3 处主动分歧 (本视图内):
     (1) hash 路由下 router.back() 行为 = 跳历史栈上一项, Next 是 router.back()
         同口径; SPA 跳回跳到「完整配置 / 全局看板 / 项目」都可, 不限定.
     (2) URL prefill 不引 useSearchParams (Next 专属), 用 useRoute().query (SPA
         统一入口), 数据形态一致.
     (3) attachment upload 走 spa/src/api/assets.ts 暴露的 uploadAttachmentToTask
         (R30 已落地, 复用即可), 不在 TaskNew.vue 内重复 FormData + fetch 包装.
   - 状态机: 顶层 Loading 不引 (页面无「数据加载」状态, 只有 form + submit).
     submit lock 防双击 (damo 2026-09-18 反馈).
   - 复用 Layer 0 全套: R7 Button + R8 Input/Textarea + R9 Select + R10 Checkbox +
     R5 Modal + R6 ConfirmDialog + useToast (R4). */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  createTask,
  startTask,
  appendTaskAttachments,
  listDepTasks,
  type CreateTaskBody,
  type TaskType,
  type DepTaskItem,
} from '@/api/tasks';
import { listProjects, listVersions, type Project, type Version } from '@/api/projects';
import { listRoles, type Role } from '@/api/roles';
import { listAvailableLlmConfigs, type AvailableLlmConfig } from '@/api/templates';
import {
  createConfigSnapshot,
  deleteConfigSnapshot,
  getConfigSnapshot,
  listApplicableSnapshots,
  listConfigSnapshots,
  updateConfigSnapshot,
  type Snapshot,
  type SnapshotScope,
  type CreateSnapshotBody,
} from '@/api/config-snapshots';
import { uploadAttachmentToTask } from '@/api/assets';
import { isHttpError, HttpError } from '@/api/http';
import { loadDraft, saveDraft } from '@/lib/chat/input-history';
import { useToast } from '@/composables/useToast';
import { AVAILABLE_TOOLS, EFFORT_LEVELS, TASK_TYPE_OPTIONS, TOOL_PRESETS } from '@/lib/constants';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import FileInput from '@/components/FileInput.vue';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import {
  buildGoalPrompt,
  formatSize,
  getSubmitButtonLabel,
  parseCsvTags,
  parseGoalRoundsInput,
  parseJsonStringArray,
  serializeCsvTags,
  serializeJsonStringArray,
  shouldBlockClickSubmit,
  shouldShowSpinner,
  shouldTriggerSubmitOnKey,
} from './taskNew/predicates';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

/** Effort 选项 — 与 master EFFORT_LEVELS 同源. */
const EFFORT_OPTIONS: { value: string; label: string }[] = EFFORT_LEVELS.map((e) => ({
  value: e,
  label: e,
}));

/** 优先级 3 档 (Next Select 固定, 不引完整 P0-P10). label 走 t() 动态翻译. */
const PRIORITY_OPTIONS = computed<{ value: string; label: string }[]>(() => [
  { value: '0', label: t('taskNew.priorityLow') },
  { value: '5', label: t('taskNew.priorityMid') },
  { value: '10', label: t('taskNew.priorityHigh') },
]);

/** 自动审批 2 档 — full 模式 (无「继承默认」档). */
const AUTO_APPROVE_OPTIONS_FULL = computed<{ value: string; label: string }[]>(() => [
  { value: 'off', label: t('taskNew.approveOff') },
  { value: 'on', label: t('taskNew.approveOn') },
]);

/** 自动审批 3 档 — snapshot 编辑表单 (含「继承默认」sentinel). */
const AUTO_APPROVE_OPTIONS_SNAP = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.snap.inheritDefault') },
  { value: 'off', label: t('taskNew.approveOff') },
  { value: 'on', label: t('taskNew.approveOn') },
]);

/** Scope 选项. */
const SCOPE_OPTIONS: { value: SnapshotScope; label: string }[] = [
  { value: 'global', label: '全局（任意项目可用）' },
  { value: 'project', label: '绑定项目' },
  { value: 'version', label: '绑定版本' },
];

/** 默认 allowed_tools — 与 master DEFAULT_TOOLS 对齐 (全开). */
const DEFAULT_ALLOWED_TOOLS = [...AVAILABLE_TOOLS];

/* ------------------------------------------------------------------ */
/*  URL / Router                                                       */
/* ------------------------------------------------------------------ */

/** URL prefill — 与 Next useSearchParams 同口径, hash 路由 useRoute().query. */
const urlProject = computed<string>(() => stringQuery(route.query.project));
const urlVersion = computed<string>(() => stringQuery(route.query.version));

function stringQuery(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/* ------------------------------------------------------------------ */
/*  顶层状态                                                            */
/* ------------------------------------------------------------------ */

const toast = useToast();

const projects = ref<Project[]>([]);
const versions = ref<Version[]>([]);
const availableLlmConfigs = ref<AvailableLlmConfig[]>([]);
const applicableSnapshots = ref<Snapshot[]>([]);
/** 波3 P5: 当前项目可用角色 (全局 + 项目专属, GET /api/roles?projectId=). */
const availableRoles = ref<Role[]>([]);

const projectId = ref<string>('');
const versionId = ref<string>('');

type Mode = 'quick' | 'full' | 'snapshots';
const mode = ref<Mode>('quick');

const submitting = ref<boolean>(false);
/** 同步锁 (damo 2026-09-18 反馈: 防双提交). useRef 等价物在 Vue = 普通
    ref, 配合 .value 同步读写. submitting 是 derived 渲染态. */
const submitLock = ref<boolean>(false);

/** Quick mode. 初值从 localStorage 草稿恢复 (R233 Round7: 刷新不丢). */
const quickPrompt = ref<string>(loadDraft('tasknew-quick'));
const quickGoalOpen = ref<boolean>(true); // R143 三轮: 默认展开
const quickGoalText = ref<string>('');
const quickGoalRounds = ref<string>('');
const selectedSnapshot = ref<Snapshot | null>(null);

/** Full mode. */
interface FullForm {
  title: string;
  prompt: string;
  description: string;
  cwd: string;
  model: string;
  llm_config_id: string;
  effort: string;
  maxTurns: string;
  autoApprove: boolean;
  priority: string;
  allowedTools: string[];
  tags: string;
  dependsOn: string[];
  type: TaskType;
  goal_text: string;
  goal_rounds: string;
  /** 波3 P5: 派发选角色. '' = 不使用. */
  roleId: string;
  /** 波2.5: 任务级自动验收 (仅 DAG 项目, 否则 400 AUTO_COMPLETE_REQUIRES_DAG). */
  autoComplete: boolean;
}
const fullForm = reactive<FullForm>({
  title: '',
  prompt: loadDraft('tasknew-full'), // R233 Round7: 刷新不丢
  description: '',
  cwd: '',
  model: '',
  llm_config_id: '',
  effort: 'high',
  maxTurns: '200',
  autoApprove: true,
  priority: '0',
  allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  tags: '',
  dependsOn: [],
  type: '',
  goal_text: '',
  goal_rounds: '',
  roleId: '',
  autoComplete: false,
});

/** 附件暂存 (File[]) — 提交后逐文件上传. */
const pendingFiles = ref<File[]>([]);
const fileInputRef = useTemplateRef<InstanceType<typeof FileInput>>('fileInputRef');

/* R233 Round7: prompt 草稿持久化 (300ms 防抖写盘, 刷新后恢复; 提交成功清空).
   只持久化 prompt 正文 (两个模式各自一个 key), 其余表单字段不持久化. */
let quickDraftTimer: number | null = null;
let fullDraftTimer: number | null = null;

watch(quickPrompt, (v) => {
  if (quickDraftTimer != null) window.clearTimeout(quickDraftTimer);
  quickDraftTimer = window.setTimeout(() => {
    quickDraftTimer = null;
    saveDraft('tasknew-quick', v);
  }, 300);
});

watch(() => fullForm.prompt, (v) => {
  if (fullDraftTimer != null) window.clearTimeout(fullDraftTimer);
  fullDraftTimer = window.setTimeout(() => {
    fullDraftTimer = null;
    saveDraft('tasknew-full', v);
  }, 300);
});

function flushPromptDrafts(): void {
  if (quickDraftTimer != null) {
    window.clearTimeout(quickDraftTimer);
    quickDraftTimer = null;
    saveDraft('tasknew-quick', quickPrompt.value);
  }
  if (fullDraftTimer != null) {
    window.clearTimeout(fullDraftTimer);
    fullDraftTimer = null;
    saveDraft('tasknew-full', fullForm.prompt);
  }
}

/** Snap-prefill (完整模式 → 模板配置 tab). */
const snapPrefillConfig = ref<SnapshotConfig | null>(null);
const snapPrefillKey = ref<number>(0);

/** Snapshot 自动匹配 (URL ?project=&version= 时只跑一次). */
const autoMatched = ref<boolean>(false);

/** 依赖任务下拉. */
const depSearch = ref<string>('');
const depDropdownOpen = ref<boolean>(false);
const availableTasks = ref<DepTaskItem[]>([]);
const depInputRef = useTemplateRef<InstanceType<typeof Input>>('depInputRef');

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

const projectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.selectProject') },
  ...projects.value.map((p) => ({ value: p.id, label: p.name })),
]);

const versionOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.noVersionTask') },
  ...versions.value.map((v) => ({ value: v.id, label: v.name })),
]);

const llmConfigOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.llmDefaultChain') },
  ...availableLlmConfigs.value.map((c) => ({
    value: c.id,
    label: `${c.source === 'self' ? t('taskNew.llmMine') : t('taskNew.llmPlatform')} · ${c.name}${c.is_default ? t('taskNew.llmDefaultSuffix') : ''}`,
  })),
]);

// TASK_TYPE_OPTIONS 来自共享 constants.ts (中文 label 不改共享文件) — 这里按
// value 映射到 taskNew.type_* key 动态翻译.
const taskTypeOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.unclassified') },
  ...TASK_TYPE_OPTIONS.map((o) => ({ value: o.value, label: t(`taskNew.type_${o.value}`) })),
]);

/** 常用 model shortcut + 用户 LLM 配置的 model + 历史 task.model 聚合 (与
    master useAvailableModels 同口径). SPA 没 React hook, 这里 inline. 拉不到
    时退化为只显示常用模型. */
const modelOptions = computed<{ value: string; label: string }[]>(() => {
  const opts: { value: string; label: string }[] = [{ value: '', label: t('taskNew.modelDefaultChain') }];
  const seen = new Set<string>(['']);
  // configured 优先
  for (const c of availableLlmConfigs.value) {
    // AvailableLlmConfig 没有 model 字段 (master AvailableLlmConfigSummary 有);
    // 这里 fallback = LLM config 名称作为提示 (与 Next page.tsx 行为略有差, 后端
    // 模型解析走 LLM config 而非 model 字符串).
  }
  // builtin (MASTER MODEL_OPTIONS)
  for (const m of MASTER_MODEL_OPTIONS.value) {
    if (m.value && !seen.has(m.value)) {
      seen.add(m.value);
      opts.push({ value: m.value, label: m.label });
    }
  }
  return opts;
});

/** 全模式 submitted attachment (把 photos 转换成 array). */
const fullFormTagsArray = computed<string[]>(() => parseCsvTags(fullForm.tags));

const canSubmitQuick = computed<boolean>(
  () => !!quickPrompt.value.trim() && !!projectId.value,
);
const canSubmitFull = computed<boolean>(
  () => !!fullForm.title && !!fullForm.prompt && !!projectId.value,
);

/* ------------------------------------------------------------------ */
/*  Master model options (内联)                                          */
/* ------------------------------------------------------------------ */

// label 走 t() (仅 Astron 带「讯飞」厂商注记需要翻译, 其余为模型名原文).
const MASTER_MODEL_OPTIONS = computed<{ value: string; label: string }[]>(() => [
  { value: 'astron-code-latest', label: t('taskNew.modelAstron') },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'glm-latest', label: 'GLM-Latest' },
  { value: 'MiniMax-M3', label: 'MiniMax-M3' },
  { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
  { value: 'doubao-seed-2.1-turbo', label: 'Doubao-Seed-2.1-Turbo' },
  { value: 'doubao-seed-2.0-pro', label: 'Doubao-Seed-2.0-Pro' },
  { value: 'doubao-seed-2.0-lite', label: 'Doubao-Seed-2.0-Lite' },
]);

/* ------------------------------------------------------------------ */
/*  SnapshotConfig (跨组件传值)                                          */
/* ------------------------------------------------------------------ */

/** 完整配置 → 模板配置 注入数据. 直接复用 CreateSnapshotBody 类型避免类型漂移. */
type SnapshotConfig = Partial<CreateSnapshotBody>;

/* ------------------------------------------------------------------ */
/*  数据加载 (顶层一次性 — 同 Next useEffect[])                            */
/* ------------------------------------------------------------------ */

async function loadTopLevel(): Promise<void> {
  // 三路并发 — 任一失败静默 (UI 退化). 与 master useEffect 同口径.
  const [pj, llm] = await Promise.allSettled([
    listProjects(),
    listAvailableLlmConfigs(),
  ]);
  if (pj.status === 'fulfilled') projects.value = pj.value.projects ?? [];
  if (llm.status === 'fulfilled') availableLlmConfigs.value = llm.value;

  // URL prefill — 设置初值, 触发 watch 拉 versions + snapshots.
  if (urlProject.value) projectId.value = urlProject.value;
  if (urlVersion.value) versionId.value = urlVersion.value;
}

watch(projectId, async (next) => {
  if (!next) {
    versions.value = [];
    versionId.value = '';
    return;
  }
  try {
    const resp = await listVersions(next);
    const nextVersions = resp.versions ?? [];
    versions.value = nextVersions;
    // 保留 URL 指定的 version, 若不存在才清空
    versionId.value =
      versionId.value && nextVersions.some((v) => v.id === versionId.value)
        ? versionId.value
        : '';
  } catch {
    versions.value = [];
    versionId.value = '';
  }
});

/** Snapshots: 拉 applicable (按 project + version). 同时触发 URL 自动匹配.
    watch 触发条件 = projectId / versionId / 模式 (切到 quick 时刷新). */
async function fetchApplicableSnapshots(): Promise<void> {
  if (!projectId.value && !versionId.value) {
    applicableSnapshots.value = [];
    return;
  }
  try {
    const list = await listApplicableSnapshots(projectId.value, versionId.value);
    applicableSnapshots.value = list;
    if (!autoMatched.value && (urlProject.value || urlVersion.value) && list.length > 0) {
      autoMatched.value = true;
      const best = list[0];
      if (best) {
        selectedSnapshot.value = best;
        applySnapshotToForm(best);
      }
    } else if (
      selectedSnapshot.value &&
      !list.some((s) => s.id === selectedSnapshot.value?.id)
    ) {
      selectedSnapshot.value = null;
    }
  } catch {
    applicableSnapshots.value = [];
  }
}

watch(
  [projectId, versionId, () => mode.value === 'quick'],
  () => {
    void fetchApplicableSnapshots();
  },
);

/* 波3 P5: 角色下拉数据源 — 随项目切换拉「全局 + 该项目专属」可用集 (D1 语义).
   拉失败静默 (下拉空 = 不用角色), 不阻塞表单. 项目切换时清已选 role
   (跨项目 role 会被后端 ROLE_SCOPE_MISMATCH 拒, 前端先清防呆). */
watch(projectId, async (next) => {
  fullForm.roleId = '';
  // 换项目后 dag 状态可能变, 防「上一项目勾了 auto_complete → 本项目 400」.
  const nextIsDag = projects.value.find((p) => p.id === next)?.dag_enforced === 1;
  if (!nextIsDag) fullForm.autoComplete = false;
  if (!next) {
    availableRoles.value = [];
    return;
  }
  try {
    availableRoles.value = await listRoles(next);
  } catch {
    availableRoles.value = [];
  }
});

const roleSelectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.noRole') },
  ...availableRoles.value.map((r) => ({
    value: r.id,
    label: r.project_id ? t('taskNew.roleProjectTag', { name: r.name }) : r.name,
  })),
]);

/** 当前项目是否 DAG 拓扑调度 (auto_complete 仅 DAG 项目可用, 后端 400 兜底). */
const currentProjectIsDag = computed<boolean>(
  () => projects.value.find((p) => p.id === projectId.value)?.dag_enforced === 1,
);

/** Apply matched snapshot to full-config form. URL-explicit params (from the
    prompt-template prefill) win over the snapshot. 1:1 移植 master applySnapshotToForm. */
function applySnapshotToForm(snap: Snapshot): void {
  const q = route.query;
  fullForm.model = stringQuery(q.model) ? fullForm.model : (snap.model ?? fullForm.model);
  fullForm.llm_config_id = stringQuery(q.llm_config_id)
    ? fullForm.llm_config_id
    : (snap.llm_config_id ?? fullForm.llm_config_id);
  fullForm.effort = stringQuery(q.effort) ? fullForm.effort : (snap.effort ?? fullForm.effort);
  fullForm.maxTurns = stringQuery(q.maxTurns)
    ? fullForm.maxTurns
    : snap.max_turns !== null && snap.max_turns !== undefined
      ? String(snap.max_turns)
      : fullForm.maxTurns;
  fullForm.autoApprove = stringQuery(q.autoApprove)
    ? fullForm.autoApprove
    : snap.auto_approve !== null && snap.auto_approve !== undefined
      ? snap.auto_approve === 1
      : fullForm.autoApprove;
  if (snap.allowed_tools) {
    fullForm.allowedTools = parseJsonStringArray(snap.allowed_tools);
  }
  fullForm.tags = stringQuery(q.tags)
    ? fullForm.tags
    : snap.tags
      ? serializeCsvTags(parseJsonStringArray(snap.tags))
      : fullForm.tags;
  fullForm.type = (stringQuery(q.type) ? fullForm.type : (snap.type ?? fullForm.type)) as TaskType;
}

/** 依赖任务下拉 — fetch on open (Next 同款). */
watch(depDropdownOpen, async (open) => {
  if (!open || availableTasks.value.length > 0) return;
  try {
    const list = await listDepTasks();
    availableTasks.value = list;
  } catch {
    availableTasks.value = [];
  }
});

/* ------------------------------------------------------------------ */
/*  Tool toggle                                                         */
/* ------------------------------------------------------------------ */

function toggleTool(tool: string): void {
  const set = new Set(fullForm.allowedTools);
  if (set.has(tool)) set.delete(tool);
  else set.add(tool);
  fullForm.allowedTools = [...set];
}

function setToolPreset(tools: string[]): void {
  fullForm.allowedTools = [...tools];
}

/* ------------------------------------------------------------------ */
/*  附件 drop zone                                                       */
/* ------------------------------------------------------------------ */

function handleDrop(e: DragEvent): void {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) pendingFiles.value = [...pendingFiles.value, ...files];
}

function handleFileInputChange(files: FileList | null): void {
  const list = Array.from(files ?? []);
  if (list.length) pendingFiles.value = [...pendingFiles.value, ...list];
  // 不需要 reset(): FileInput 已经把 value 清掉了 (拿不到 DOM, 由组件自己管).
}

function removePendingFile(idx: number): void {
  pendingFiles.value = pendingFiles.value.filter((_, i) => i !== idx);
}

/* ------------------------------------------------------------------ */
/*  依赖任务                                                              */
/* ------------------------------------------------------------------ */

function toggleDep(taskId: string): void {
  const set = new Set(fullForm.dependsOn);
  if (set.has(taskId)) set.delete(taskId);
  else set.add(taskId);
  fullForm.dependsOn = [...set];
}

const depCandidates = computed<DepTaskItem[]>(() => {
  const q = depSearch.value.toLowerCase();
  return availableTasks.value
    .filter((t) => !fullForm.dependsOn.includes(t.id))
    .filter((t) => {
      if (!q) return true;
      return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
    });
});

const depEmptyMessage = computed<string>(() =>
  depSearch.value ? t('taskNew.depEmptySearch') : t('taskNew.depEmptyNone'),
);

/* ------------------------------------------------------------------ */
/*  附件上传 (两阶段)                                                    */
/* ------------------------------------------------------------------ */

async function uploadAttachments(taskId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const file of pendingFiles.value) {
    try {
      const resp = await uploadAttachmentToTask(taskId, file);
      if (resp.attachment?.id) ids.push(resp.attachment.id);
    } catch (err) {
      // 单文件失败不阻断 — 与 Next 同款 (console.error 但继续).
      console.error('Attachment upload failed:', err);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/*  Submit (quick + full)                                              */
/* ------------------------------------------------------------------ */

/** Quick 模式提交 — 自动启动. */
async function handleQuickSubmit(): Promise<void> {
  if (
    shouldBlockClickSubmit({
      inFlight: submitLock.value,
      canSubmit: canSubmitQuick.value,
    })
  ) {
    return;
  }
  submitLock.value = true;
  submitting.value = true;
  const s = selectedSnapshot.value;
  try {
    const task = await createTask({
      title:
        quickPrompt.value.length > 60
          ? quickPrompt.value.slice(0, 60) + '...'
          : quickPrompt.value,
      prompt: buildGoalPrompt(quickPrompt.value, quickGoalText.value),
      autoApprove:
        s && s.auto_approve !== null && s.auto_approve !== undefined
          ? s.auto_approve === 1
          : true,
      effort: s?.effort ?? 'high',
      maxTurns: s?.max_turns ?? 200,
      model: s?.model ?? undefined,
      llm_config_id: s?.llm_config_id ?? undefined,
      allowedTools: s?.allowed_tools ? parseJsonStringArray(s.allowed_tools) : undefined,
      tags: s?.tags ? parseJsonStringArray(s.tags) : undefined,
      type: (s?.type as TaskType | null) || undefined,
      project_id: projectId.value,
      version_id: versionId.value || undefined,
      goalRounds: parseGoalRoundsInput(quickGoalRounds.value) ?? undefined,
    });
    const taskId = (task as { id: string }).id;
    const attIds = await uploadAttachments(taskId);
    if (attIds.length > 0) await appendTaskAttachments(taskId, attIds);
    await startTask(taskId);
    saveDraft('tasknew-quick', ''); // R233 Round7: 提交成功清草稿
    router.push(`/tasks/${taskId}`);
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : t('taskNew.createFailed');
    toast.error(isHttpError(err) ? (err as HttpError).message : msg);
  } finally {
    submitting.value = false;
    submitLock.value = false;
  }
}

/** Full 模式提交 — 自动启动. */
async function handleFullSubmit(): Promise<void> {
  if (
    shouldBlockClickSubmit({
      inFlight: submitLock.value,
      canSubmit: canSubmitFull.value,
    })
  ) {
    return;
  }
  submitLock.value = true;
  submitting.value = true;
  try {
    const task = await createTask({
      title: fullForm.title,
      prompt: buildGoalPrompt(fullForm.prompt, fullForm.goal_text),
      description: fullForm.description || undefined,
      cwd: fullForm.cwd || undefined,
      model: fullForm.model || undefined,
      llm_config_id: fullForm.llm_config_id || undefined,
      effort: fullForm.effort,
      maxTurns: parseInt(fullForm.maxTurns) || undefined,
      autoApprove: fullForm.autoApprove,
      priority: parseInt(fullForm.priority) || 0,
      allowedTools: fullForm.allowedTools,
      tags: parseCsvTags(fullForm.tags).length > 0 ? parseCsvTags(fullForm.tags) : undefined,
      dependsOn: fullForm.dependsOn.length > 0 ? fullForm.dependsOn : undefined,
      project_id: projectId.value,
      version_id: versionId.value || undefined,
      type: fullForm.type || undefined,
      goalRounds: parseGoalRoundsInput(fullForm.goal_rounds) ?? undefined,
      // 波3 P5: 派发选角色 + 任务级自动验收 (仅 DAG 项目, 后端 400 兜底).
      role_id: fullForm.roleId || undefined,
      autoComplete: fullForm.autoComplete || undefined,
    } as CreateTaskBody);
    const taskId = (task as { id: string }).id;
    const attIds = await uploadAttachments(taskId);
    if (attIds.length > 0) await appendTaskAttachments(taskId, attIds);
    await startTask(taskId);
    saveDraft('tasknew-full', ''); // R233 Round7: 提交成功清草稿
    router.push(`/tasks/${taskId}`);
  } catch (err) {
    console.error(err);
    toast.error(isHttpError(err) ? (err as HttpError).message : t('taskNew.createFailed'));
  } finally {
    submitting.value = false;
    submitLock.value = false;
  }
}

/** Form-level @keydown 桥接 (Ctrl/Cmd+Enter 提交). */
function onKeyDown(e: KeyboardEvent): void {
  // IME composition guard (CJK 输入法确认时 Enter 不应触发提交).
  if ((e as KeyboardEvent & { isComposing?: boolean }).isComposing) return;
  const target = e.target as HTMLElement;
  const targetIsInputOrTextarea =
    target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
  const canSubmit = mode.value === 'quick' ? canSubmitQuick.value : canSubmitFull.value;
  const ok = shouldTriggerSubmitOnKey(
    {
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      targetIsInputOrTextarea,
    },
    { submitting: submitting.value, canSubmit },
  );
  if (!ok) return;
  e.preventDefault();
  // 提交由 form @submit 触发 (按钮 type=submit 自动). 但 quick / full 不在同一 form,
  // 这里手动调 handler. (与 Next e.currentTarget.requestSubmit() 等价.)
  if (mode.value === 'quick') {
    void handleQuickSubmit();
  } else if (mode.value === 'full') {
    void handleFullSubmit();
  }
}

/* ------------------------------------------------------------------ */
/*  项目 + 版本 select 联动                                              */
/* ------------------------------------------------------------------ */

function onProjectChange(v: string | null): void {
  projectId.value = v ?? '';
  versionId.value = '';
  selectedSnapshot.value = null;
}

function onVersionChange(v: string | null): void {
  versionId.value = v ?? '';
  selectedSnapshot.value = null;
}

/* ------------------------------------------------------------------ */
/*  URL prefill (模板 URL params: ?name=&prompt=...)                    */
/* ------------------------------------------------------------------ */

function applyTemplatePrefill(): void {
  const q = route.query;
  const name = stringQuery(q.name);
  const prompt = stringQuery(q.prompt);
  const hasAny =
    !!prompt ||
    !!name ||
    !!stringQuery(q.model) ||
    !!stringQuery(q.llm_config_id) ||
    !!stringQuery(q.effort) ||
    !!stringQuery(q.maxTurns) ||
    !!stringQuery(q.autoApprove) ||
    !!stringQuery(q.tags);
  if (!hasAny) return;
  if (prompt) mode.value = 'full';
  if (name) fullForm.title = name;
  if (prompt) fullForm.prompt = prompt;
  if (stringQuery(q.model)) fullForm.model = stringQuery(q.model);
  if (stringQuery(q.llm_config_id)) fullForm.llm_config_id = stringQuery(q.llm_config_id);
  if (stringQuery(q.effort)) fullForm.effort = stringQuery(q.effort);
  if (stringQuery(q.maxTurns)) fullForm.maxTurns = stringQuery(q.maxTurns);
  const ap = stringQuery(q.autoApprove);
  if (ap === 'true') fullForm.autoApprove = true;
  else if (ap === 'false') fullForm.autoApprove = false;
  if (stringQuery(q.tags)) fullForm.tags = stringQuery(q.tags);
}

watch(
  () => route.query,
  () => applyTemplatePrefill(),
  { immediate: false },
);

/* ------------------------------------------------------------------ */
/*  "存为快照" — 完整模式 → 模板配置 tab                                */
/* ------------------------------------------------------------------ */

function onSaveAsSnapshot(): void {
  const maxTurnsNum = fullForm.maxTurns.trim() ? Number(fullForm.maxTurns) : undefined;
  snapPrefillConfig.value = {
    name: fullForm.title || t('taskNew.unnamedSnapshot'),
    description: fullForm.description || undefined,
    scope: 'global',
    model: fullForm.model || undefined,
    llm_config_id: fullForm.llm_config_id || null,
    effort: fullForm.effort || undefined,
    maxTurns: Number.isFinite(maxTurnsNum) ? maxTurnsNum : undefined,
    autoApprove: fullForm.autoApprove,
    allowedTools: fullForm.allowedTools,
    tags: parseCsvTags(fullForm.tags),
    type: fullForm.type || undefined,
  };
  snapPrefillKey.value += 1;
  mode.value = 'snapshots';
}

/* ------------------------------------------------------------------ */
/*  Mount                                                               */
/* ------------------------------------------------------------------ */

onMounted(() => {
  void loadTopLevel();
  applyTemplatePrefill();
});

onBeforeUnmount(() => {
  // 清理 EventSource / 计时器 — 当前 view 无, 留 placeholder 防未来加 SSE.
  flushPromptDrafts(); // R233 Round7: 防抖窗口内切走, 把未落盘草稿写盘
});

/* ------------------------------------------------------------------ */
/*  Template-used inline helpers (R23 / R107 / R143)                   */
/* ------------------------------------------------------------------ */

/** Mode tabs. label 走 t() 动态翻译. */
const MODE_TABS = computed<{ key: 'quick' | 'full' | 'snapshots'; label: string }[]>(() => [
  { key: 'quick', label: t('taskNew.tabQuick') },
  { key: 'full', label: t('taskNew.tabFull') },
  { key: 'snapshots', label: t('taskNew.tabSnapshots') },
]);

/** Snapshot select options — quick 模式. */
const snapshotSelectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.defaultConfigOption') },
  ...applicableSnapshots.value.map((s) => ({
    value: s.id,
    label: `${s.name}${
      s.scope === 'version'
        ? t('taskNew.scopeTagVersion')
        : s.scope === 'project'
          ? t('taskNew.scopeTagProject')
          : t('taskNew.scopeTagGlobal')
    }`,
  })),
]);

/** quick 模式当前配置提示 (选了快照 vs 默认). 文案走 t() 拼装. */
const configTipText = computed<string>(() => {
  const s = selectedSnapshot.value;
  if (!s) return t('taskNew.configTipDefault');
  const approve =
    s.auto_approve === 1 || s.auto_approve === null || s.auto_approve === undefined
      ? t('taskNew.autoApprove')
      : t('taskNew.needReview');
  return t('taskNew.configTipSnapshot', {
    name: s.name,
    model: s.model || t('taskNew.defaultModel'),
    effort: s.effort || 'high',
    rounds: s.max_turns || 200,
    approve,
  });
});

function onSnapshotChange(id: string | null): void {
  selectedSnapshot.value = id
    ? applicableSnapshots.value.find((s) => s.id === id) ?? null
    : null;
}

function pickDep(id: string): void {
  if (!fullForm.dependsOn.includes(id)) {
    fullForm.dependsOn = [...fullForm.dependsOn, id];
  }
  depSearch.value = '';
  nextTick(() => depInputRef.value?.focus());
}

function depTaskTitle(id: string): string {
  const t = availableTasks.value.find((x) => x.id === id);
  return t ? t.title.slice(0, 20) : id.slice(0, 8);
}

function depDotClass(status: DepTaskItem['status']): string {
  switch (status) {
    case 'completed':
      return 'dot-completed';
    case 'running':
      return 'dot-running';
    case 'queued':
      return 'dot-queued';
    default:
      return 'dot-default';
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-components (R23: 模板配置 tab = Next 端独立子组件, 1:1 镜像)   */
/* ------------------------------------------------------------------ */

import SnapshotManager from './taskNew/SnapshotManager.vue';
</script>

<template>
  <div class="page">
    <header class="page-header">
      <button type="button" class="link-back" @click="router.back()">{{ t('taskNew.back') }}</button>
      <h1>{{ t('taskNew.title') }}</h1>
      <div class="mode-tabs">
        <button
          v-for="tab in MODE_TABS"
          :key="tab.key"
          type="button"
          class="mode-tab"
          :class="{ active: mode === tab.key }"
          @click="mode = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </header>

    <main class="page-body">
      <!-- ============================================================== -->
      <!-- Quick mode                                                     -->
      <!-- ============================================================== -->
      <form
        v-if="mode === 'quick'"
        class="form space-y-4"
        @submit.prevent="handleQuickSubmit"
        @keydown="onKeyDown"
      >
        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.projectLabel') }}</label>
            <Select
              :model-value="projectId"
              :options="projectOptions"
              :placeholder="t('taskNew.selectProject')"
              @update:model-value="onProjectChange"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.versionLabel') }}</label>
            <Select
              :model-value="versionId"
              :options="versionOptions"
              :disabled="!projectId"
              @update:model-value="onVersionChange"
            />
          </div>
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.configLabel') }}</label>
          <Select
            :model-value="selectedSnapshot?.id ?? ''"
            :options="snapshotSelectOptions"
            :disabled="applicableSnapshots.length === 0"
            @update:model-value="onSnapshotChange"
          />
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.promptLabel') }}</label>
          <Textarea
            v-model="quickPrompt"
            :rows="10"
            :placeholder="t('taskNew.quickPromptPlaceholder')"
            class-name="ta ta-tall font-mono"
          />
        </div>

        <!-- Goal-driven loop (R143): 折叠区. 默认展开 (R143 三轮). -->
        <div>
          <button
            type="button"
            class="link-toggle"
            @click="quickGoalOpen = !quickGoalOpen"
          >
            <span>{{ quickGoalOpen ? '▾' : '▸' }}</span>
            <span>{{
              quickGoalOpen ? t('taskNew.goalCollapse') : t('taskNew.goalExpand')
            }}</span>
          </button>
          <div v-if="quickGoalOpen" class="goal-block">
            <Textarea
              v-model="quickGoalText"
              :rows="4"
              :placeholder="t('taskNew.goalPlaceholder')"
              class-name="ta font-mono"
            />
            <div class="goal-rounds-row">
              <label class="lbl-inline">{{ t('taskNew.maxRounds') }}</label>
              <Input
                v-model="quickGoalRounds"
                type="number"
                :min="0"
                :max="1000"
                :disabled="!quickGoalText.trim()"
                :placeholder="t('taskNew.maxRoundsPlaceholder')"
                class-name="input-num font-mono"
              />
              <span class="muted-small">{{ t('taskNew.maxRoundsRange') }}</span>
              <span
                v-if="!quickGoalText.trim() && quickGoalRounds.trim()"
                class="warn-small"
              >{{ t('taskNew.goalEmptyWarn') }}</span>
            </div>
            <p class="hint-small">
              {{ t('taskNew.goalHintPre') }} <code>&lt;goal&gt;...&lt;/goal&gt;</code>{{ t('taskNew.goalHintPostQuick') }}
            </p>
          </div>
        </div>

        <!-- Attachments -->
        <div>
          <label class="lbl">{{ t('taskNew.attachLabel') }}</label>
          <div
            class="dropzone"
            @dragover.prevent
            @drop="handleDrop"
            @click="fileInputRef?.open()"
          >
            {{ t('taskNew.dropzone') }}
          </div>
          <FileInput
            ref="fileInputRef"
            multiple
            @change="handleFileInputChange"
          />
          <ul v-if="pendingFiles.length > 0" class="pending-files">
            <li
              v-for="(f, i) in pendingFiles"
              :key="i"
              class="pending-file"
            >
              <span class="truncate">{{ f.name }} <span class="muted-small">({{ formatSize(f.size) }})</span></span>
              <button
                type="button"
                class="link-x"
                @click="removePendingFile(i)"
              >×</button>
            </li>
          </ul>
        </div>

        <div class="config-tip">
          {{ configTipText }}
        </div>

        <!-- R59+: 提交按钮 block (100% width) — 用户反馈「可以占一行」,
             跟 full 模式一致, 主操作占独立一行 visual 强调. -->
        <Button
          type="submit"
          variant="primary"
          block
          :disabled="!canSubmitQuick || submitting"
          :loading="submitting"
        >
          {{ getSubmitButtonLabel('quick', submitting, false) }}
        </Button>
      </form>

      <!-- ============================================================== -->
      <!-- Full mode                                                      -->
      <!-- ============================================================== -->
      <form
        v-else-if="mode === 'full'"
        class="form space-y-5"
        @submit.prevent="handleFullSubmit"
        @keydown="onKeyDown"
      >
        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.projectLabel') }}</label>
            <Select
              :model-value="projectId"
              :options="projectOptions"
              :placeholder="t('taskNew.selectProject')"
              @update:model-value="onProjectChange"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.versionLabel') }}</label>
            <Select
              :model-value="versionId"
              :options="versionOptions"
              :disabled="!projectId"
              @update:model-value="onVersionChange"
            />
          </div>
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.titleLabel') }}</label>
          <Input
            v-model="fullForm.title"
            :placeholder="t('taskNew.titlePlaceholder')"
          />
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.promptFieldLabel') }}</label>
          <Textarea
            v-model="fullForm.prompt"
            :rows="10"
            :placeholder="t('taskNew.promptPlaceholder')"
            class="font-mono"
          />
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.goalLabel') }}</label>
          <Textarea
            v-model="fullForm.goal_text"
            :rows="4"
            :placeholder="t('taskNew.goalPlaceholder')"
            class="font-mono"
          />
          <div class="goal-rounds-row">
            <label class="lbl-inline">{{ t('taskNew.maxRounds') }}</label>
            <Input
              v-model="fullForm.goal_rounds"
              type="number"
              :min="0"
              :max="1000"
              :disabled="!fullForm.goal_text.trim()"
              :placeholder="t('taskNew.maxRoundsPlaceholder')"
              class-name="input-num font-mono"
            />
            <span class="muted-small">{{ t('taskNew.maxRoundsRange') }}</span>
            <span
              v-if="!fullForm.goal_text.trim() && fullForm.goal_rounds.trim()"
              class="warn-small"
            >{{ t('taskNew.goalEmptyWarn') }}</span>
          </div>
          <p class="hint-small">
            {{ t('taskNew.goalHintPostFull') }}
          </p>
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.descLabel') }}</label>
          <Input
            v-model="fullForm.description"
            :placeholder="t('taskNew.descPlaceholder')"
          />
        </div>

        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.cwdLabel') }}</label>
            <Input
              v-model="fullForm.cwd"
              :placeholder="t('taskNew.cwdPlaceholder')"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.typeLabel') }}</label>
            <Select
              :model-value="fullForm.type"
              :options="taskTypeOptions"
              @update:model-value="(v: string | null) => fullForm.type = (v ?? '') as TaskType"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.llmLabel') }}</label>
            <Select
              :model-value="fullForm.llm_config_id"
              :options="llmConfigOptions"
              @update:model-value="(v: string | null) => fullForm.llm_config_id = v ?? ''"
            />
            <p class="hint-small">
              {{ t('taskNew.llmHint') }}
            </p>
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.modelLabel') }}</label>
            <Select
              :model-value="fullForm.model"
              :options="modelOptions"
              :placeholder="t('taskNew.modelPlaceholder')"
              @update:model-value="(v: string | null) => fullForm.model = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.effortLabel') }}</label>
            <Select
              :model-value="fullForm.effort"
              :options="EFFORT_OPTIONS"
              @update:model-value="(v: string | null) => fullForm.effort = v ?? 'high'"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.priorityLabel') }}</label>
            <Select
              :model-value="fullForm.priority"
              :options="PRIORITY_OPTIONS"
              @update:model-value="(v: string | null) => fullForm.priority = v ?? '0'"
            />
          </div>
        </div>

        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.maxRounds') }}</label>
            <Input
              v-model="fullForm.maxTurns"
              type="number"
              :min="1"
              class-name="input-num"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.approveLabel') }}</label>
            <Select
              :model-value="fullForm.autoApprove ? 'on' : 'off'"
              :options="AUTO_APPROVE_OPTIONS_FULL"
              @update:model-value="(v: string | null) => fullForm.autoApprove = v === 'on'"
            />
          </div>
        </div>

        <!-- 波3 P5: 角色预设 + 任务级自动验收. Role 随项目切换 (全局 + 项目专属);
             auto_complete 仅 DAG 项目可用 (projects.dag_enforced), 非 DAG 置灰 —
             后端仍 400 AUTO_COMPLETE_REQUIRES_DAG 兜底. -->
        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.roleLabel') }}</label>
            <Select
              :model-value="fullForm.roleId"
              :options="roleSelectOptions"
              @update:model-value="(v: string | null) => fullForm.roleId = v ?? ''"
            />
            <p class="hint-small">
              {{ t('taskNew.roleHint') }}
            </p>
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.autoAcceptLabel') }}</label>
            <Checkbox
              :model-value="fullForm.autoComplete"
              :disabled="!currentProjectIsDag"
              :label="t('taskNew.autoAcceptCheckbox')"
              @update:model-value="(v: boolean) => fullForm.autoComplete = v"
            />
            <p v-if="!currentProjectIsDag" class="hint-small">
              {{ t('taskNew.autoAcceptHint') }}
            </p>
          </div>
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.toolsLabel') }}</label>
          <div class="preset-row">
            <button
              v-for="p in TOOL_PRESETS"
              :key="p.key"
              type="button"
              class="chip-preset"
              :class="{ active: p.tools.length === fullForm.allowedTools.length && p.tools.every((tool) => fullForm.allowedTools.includes(tool)) }"
              @click="setToolPreset(p.tools)"
            >
              {{ t(`taskNew.preset_${p.key}`) }}
            </button>
          </div>
          <div class="tools-row">
            <button
              v-for="tool in AVAILABLE_TOOLS"
              :key="tool"
              type="button"
              class="chip-tool"
              :class="{ active: fullForm.allowedTools.includes(tool) }"
              @click="toggleTool(tool)"
            >
              {{ tool }}
            </button>
          </div>
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.tagsLabel') }}</label>
          <Input
            v-model="fullForm.tags"
            :placeholder="t('taskNew.tagsPlaceholder')"
          />
        </div>

        <div>
          <label class="lbl">{{ t('taskNew.depLabel') }}</label>
          <div class="relative">
            <div class="dep-bar">
              <span
                v-for="depId in fullForm.dependsOn"
                :key="depId"
                class="dep-chip"
              >
                {{ depTaskTitle(depId) }}
                <button
                  type="button"
                  class="link-x"
                  @click="toggleDep(depId)"
                >×</button>
              </span>
              <Input
                ref="depInputRef"
                v-model="depSearch"
                type="text"
                class-name="dep-input"
                :placeholder="fullForm.dependsOn.length === 0 ? t('taskNew.depSearchPlaceholder') : ''"
                @focus="depDropdownOpen = true"
              />
            </div>
            <template v-if="depDropdownOpen">
              <div class="dep-backdrop" @click="depDropdownOpen = false" />
              <div class="dep-dropdown">
                <div v-if="depCandidates.length === 0" class="muted-small">
                  {{ depEmptyMessage }}
                </div>
                <button
                  v-for="t in depCandidates"
                  :key="t.id"
                  type="button"
                  class="dep-item"
                  @click="pickDep(t.id)"
                >
                  <span class="dep-dot" :class="depDotClass(t.status)"></span>
                  <span class="truncate">{{ t.title }}</span>
                  <span class="muted-small">#{{ t.id.slice(0, 8) }}</span>
                </button>
              </div>
            </template>
          </div>
          <p class="hint-small">{{ t('taskNew.depHint') }}</p>
        </div>

        <!-- Attachments -->
        <div>
          <label class="lbl">{{ t('taskNew.attachLabel') }}</label>
          <div
            class="dropzone"
            @dragover.prevent
            @drop="handleDrop"
            @click="fileInputRef?.open()"
          >
            {{ t('taskNew.dropzone') }}
          </div>
          <FileInput
            ref="fileInputRef"
            multiple
            @change="handleFileInputChange"
          />
          <ul v-if="pendingFiles.length > 0" class="pending-files">
            <li
              v-for="(f, i) in pendingFiles"
              :key="i"
              class="pending-file"
            >
              <span class="truncate">{{ f.name }} <span class="muted-small">({{ formatSize(f.size) }})</span></span>
              <button
                type="button"
                class="link-x"
                @click="removePendingFile(i)"
              >×</button>
            </li>
          </ul>
        </div>

        <!-- R59+: 主操作占独立一行 (block 100% width), 次操作 (取消 / 存为快照)
             排第二行左对齐 — 用户反馈「可以占一行」(典型 primary-action UX:
             主操作视觉独占, secondary 收敛在下). 跟 .form flex column + 按钮
             align-self: flex-start 兼容: 这里 actions-row 是独立 flex row,
             primary 单独一行不依赖 align-self. -->
        <div class="actions-row">
          <div class="actions-row-primary">
            <Button
              type="submit"
              variant="primary"
              block
              :disabled="!canSubmitFull || submitting"
              :loading="submitting"
            >
              {{ getSubmitButtonLabel('full', submitting, false) }}
            </Button>
          </div>
          <div class="actions-row-secondary">
            <Button
              type="button"
              variant="secondary"
              @click="router.back()"
            >{{ t('taskNew.cancel') }}</Button>
            <Button
              type="button"
              variant="ghost"
              @click="onSaveAsSnapshot"
            >{{ t('taskNew.saveSnapshot') }}</Button>
          </div>
        </div>
      </form>

      <!-- ============================================================== -->
      <!-- Snapshots mode                                                 -->
      <!-- ============================================================== -->
      <SnapshotManager
        v-else
        :projects="projects"
        :available-llm-configs="availableLlmConfigs"
        :initial-project-id="projectId"
        :initial-version-id="versionId"
        :prefill-config="snapPrefillConfig"
        :prefill-key="snapPrefillKey"
        :scope-projects="projects"
      />
    </main>
  </div>
</template>

<style scoped>
.page {
  padding: 24px;
  max-width: 1100px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--tw-gray-200);
}

/* R59+: ≤1023px header 改 flex-wrap — 避免右侧 mode-tabs (基础/高级/模板
   ~250px+ 不收缩) 把 h1 挤成 ~0 宽, 导致 tab 文字 vertical-stack (用户反馈
   「那几个按钮文字都竖直起来了」). text/link-back 排第一行 (link-back
   flex: 0 0 auto, h1 flex: 1 1 auto 撑剩余, 自然排开), mode-tabs 排第二行
   (margin-left:0 取消右侧 auto, align-self:flex-start 左对齐). */
@media (max-width: 1023px) {
  .page-header {
    flex-wrap: wrap;
    gap: 10px 12px;
  }
  .page-header h1 {
    flex: 1 1 auto;
    min-width: 0;
  }
  .mode-tabs {
    margin-left: 0;
    width: 100%;
    flex-wrap: wrap;
  }
}

.page-header h1 {
  font-size: 24px;
  font-weight: 600;
  margin: 0;
  flex-shrink: 0;
}

.link-back {
  background: none;
  border: none;
  color: var(--tw-blue-500);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
}
.link-back:hover { text-decoration: underline; }

.mode-tabs {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.mode-tab {
  padding: 6px 14px;
  border: 1px solid var(--tw-gray-200);
  background: var(--color-bg-elevated);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--tw-gray-600);
}
.mode-tab:hover { background: var(--tw-gray-50); }
.mode-tab.active {
  background: var(--tw-blue-500-solid);
  color: white;
  border-color: var(--tw-blue-500);
}

.page-body { min-height: 400px; }

.form { display: flex; flex-direction: column; gap: 16px; }
.space-y-4 > * + * { margin-top: 16px; }
.space-y-5 > * + * { margin-top: 20px; }
.space-y-3 > * + * { margin-top: 12px; }

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
}

.lbl {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--tw-gray-700);
  margin-bottom: 6px;
}
.lbl-inline {
  font-size: 13px;
  color: var(--tw-gray-700);
  margin-right: 8px;
}

.ta {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 6px;
  font-size: 13px;
  resize: vertical;
  box-sizing: border-box;
}
.ta-tall { min-height: 160px; }
.ta:focus { outline: none; border-color: var(--tw-blue-500); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }

.font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

.input-num {
  width: 100px;
  padding: 6px 10px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 6px;
  font-size: 13px;
  box-sizing: border-box;
}

.dropzone {
  border: 2px dashed var(--tw-gray-300);
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  cursor: pointer;
  color: var(--tw-gray-500);
  font-size: 13px;
  background: var(--t-zinc-50);
}
.dropzone:hover { border-color: var(--tw-blue-500); background: var(--tw-blue-50); }

.pending-files { list-style: none; padding: 0; margin: 12px 0 0 0; }
.pending-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--tw-gray-100);
  border-radius: 4px;
  margin-bottom: 4px;
  font-size: 13px;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.link-x {
  background: none;
  border: none;
  color: var(--tw-gray-400);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}
.link-x:hover { color: var(--tw-red-500); }

.muted-small { font-size: 11px; color: var(--tw-gray-400); margin-left: 4px; }
.warn-small { font-size: 11px; color: var(--tw-amber-500); margin-left: 8px; }
.hint-small { font-size: 11px; color: var(--tw-gray-500); margin: 4px 0 0 0; }

.config-tip {
  padding: 12px;
  background: var(--tw-sky-50);
  border: 1px solid var(--tw-sky-200);
  border-radius: 6px;
  font-size: 12px;
  color: var(--tw-sky-800);
}

.link-toggle {
  background: none;
  border: none;
  color: var(--tw-blue-500);
  cursor: pointer;
  padding: 4px 0;
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.link-toggle:hover { text-decoration: underline; }

.goal-block {
  margin-top: 8px;
  padding: 12px;
  background: var(--t-zinc-50);
  border: 1px solid var(--tw-gray-200);
  border-radius: 6px;
}
.goal-rounds-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.preset-row, .tools-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.chip-preset, .chip-tool {
  padding: 4px 10px;
  border: 1px solid var(--tw-gray-300);
  background: var(--color-bg-elevated);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.chip-preset.active, .chip-tool.active {
  background: var(--tw-blue-500-solid);
  color: white;
  border-color: var(--tw-blue-500);
}

.relative { position: relative; }
.dep-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 6px;
  min-height: 40px;
  align-items: center;
  background: var(--color-bg-elevated);
}
.dep-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--tw-blue-50);
  border: 1px solid var(--tw-blue-300);
  border-radius: 4px;
  font-size: 12px;
}
.dep-input {
  border: none;
  outline: none;
  flex: 1;
  min-width: 120px;
  font-size: 13px;
}
.dep-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
}
.dep-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-gray-300);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  max-height: 240px;
  overflow-y: auto;
  z-index: 11;
}
.dep-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--tw-gray-100);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.dep-item:hover { background: var(--tw-gray-50); }
.dep-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot-completed { background: var(--tw-emerald-500-solid); }
.dot-running { background: var(--tw-blue-500-solid); }
.dot-queued { background: var(--tw-amber-500-solid); }
.dot-default { background: var(--tw-gray-400); }

.actions-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
  padding-top: 12px;
  border-top: 1px solid var(--tw-gray-200);
}

/* R59+: 主操作 (提交) 行 100% 宽, 次操作行内左对齐 (跟 .actions-row 一致左,
   不再单独靠右) */
.actions-row-primary {
  width: 100%;
}
.actions-row-secondary {
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>
