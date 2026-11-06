<script setup lang="ts">
/* 功能: 任务画布总控制台 (R177 / docs/plans/task-canvas-console.md) — 单项目
   全景画布: 顶部指标带 + 近期聚焦流 + 紧急×重要四象限散点 + 等我处理区 +
   排队区 + 右下 AI 派活/智能控制入口. 数据全走既有 REST 端点
   (GET /api/tasks?projectId= + GET /api/requirements?project_id=), 纯逻辑
   收在 lib/console/canvas-model.ts (单测覆盖), 本视图只做适配 + 渲染 + 派发.

   关注点:
   - 分区/象限/文案规则不在本文件 — 改判定去 canvas-model.ts (阈值/状态映射
     单测锁死), 本文件只改呈现.
   - AI 派活 = createTask({autoApprove: true}) + startTask, 遵循 L1 派发
     body 约定 (autoApprove 必含, 否则 canUseTool 拦写类工具 agent 干不了活).
   - 迭代4 卡片直观化: 等我处理卡片带「为什么」(GET messages 尾部 assistant
     消息) + 近期聚焦带「下一步」(GET checkpoints 尾部 summary), detailCache
     按 taskId+updated_at 防抖 — 60s 轮询不重拉没动的任务, 每轮上限
     waiting 8 + focus 6 个请求, 失败静默 (卡片只少一行摘要).
   - 迭代4 控制端: ① 确定性动作前端直调 (✓ 验收 = approve, 409 时先
     unset-awaiting-review; ✎ 回复 = POST message, sendUserMessage 按
     paused/reviewing/await_user/running 自动路由唤醒); ② 复杂指令走
     「🎛 智能控制」= 包成总控任务 (buildControllerPrompt 注入 origin +
     $AO_TOKEN 用法 + 端点清单 + 安全边界), 由 agent 代 damo 批量推进并
     汇报「需要 damo 评估的核心问题」— 汇报落「等我处理」, damo 回复即转达.
   - 60s 自动轮询刷新 (画布"动态"感的最低配; SSE 实时推进留 P2).
   - 动画全 CSS + prefers-reduced-motion 降级; 不引 PlayCanvas 引擎
     (取舍见 plan §5).
   - 迭代8 (damo 1004 N 列三条): ① 卡片撤「为什么」行 (干啥已体现) — 明细
     (为什么/下一步) 改详情弹窗打开时懒取, 轮询请求量砍半; ② 点击卡片原位
     缩放展开成详情弹窗 (FLIP: 记卡片 rect → transform 映射到弹窗终位过渡);
     ③ LLM 摘要禁 Rxxx 编号 (见 card-summary-llm.ts prompt 标准).
   - 迭代9 (damo 1004): 「为什么」整行撤掉 — 语义被「有啥用」覆盖, 弹窗只留
     干啥/有啥用/下一步/结果; ensureDetail 不再拉 messages.
   - 迭代10 (damo 1010 R238): 弹窗行不限 2 行完全展示 — .tm-line 撤 clamp;
     「下一步」存 checkpoint summary 全文 (卡片渲染时才 clip 120),
     原先 clip 120 + clamp 2 双重截断, 长 summary 在弹窗里大半不可见.
   - 行字段是 snake_case (API 返回 DB 原行), 适配层容错 camelCase. */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, HttpError, post } from '@/api/http';
import { useToast } from '@/composables/useToast';
import {
  createTask,
  startTask,
  statusLabel as sharedStatusLabel,
  unsetAwaitingReview,
} from '@/api/tasks';
import {
  listRequirements,
  type Requirement,
} from '@/api/requirements';
import { getProjectById } from '@/api/projects';
import { useTagsStore } from '@/stores/tags';
import { formatProjectWithLabel } from '@/lib/format-tab-title';
import {
  buildCanvasModel,
  QUADRANT_LABELS,
  type CanvasModel,
  type CanvasRequirementInput,
  type CanvasTaskInput,
  type QuadrantNode,
} from '@/lib/console/canvas-model';
import { clip, extractGain, stripRuntimeMarkers } from '@/lib/console/card-summary';
import {
  actionLabel,
  buildAgreeMessage,
  digestActionFor,
  groupDigestItems,
  urgencyClass,
  DIGEST_INERT_STATUSES,
  type ConsoleDigest,
  type DigestItem,
} from '@/lib/console/digest-model';
import { formatShortDateTime } from '@/lib/datetime';

const route = useRoute();
const router = useRouter();
const toast = useToast();
const { t } = useI18n();

const projectId = computed(() => String(route.params.projectId ?? ''));

const tags = useTagsStore();

const projectName = ref('');

// R189: tab 标题带项目名区分 — 多项目同开 console 全叫「总控制台」分不清.
// 对齐 Wiki/未挂版本同款 pattern (formatProjectWithLabel + applyTitle),
// applyTitle 标 customTitle 防 afterEach 用静态 meta.tagTitle 覆盖回来.
watch(
  () => projectName.value,
  (name) => {
    if (!name) return;
    tags.applyTitle(route.path, formatProjectWithLabel(name, t('misc.console.tabTitle')));
  },
);

const loading = ref(false);
const model = ref<CanvasModel | null>(null);
const lastRefreshed = ref<string>('');

/* ---------------- 数据加载 ---------------- */

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority?: number | null;
  updated_at?: string | null;
  requirement_id?: string | null;
  awaiting_owner_review?: number | boolean | null;
  /* R177 迭代6: 摘要直取字段 (listTasks = SELECT * 全量返回, 零后端改动) */
  description?: string | null;
  value_significance?: string | null;
  result?: string | null;
  prompt?: string | null;
}

/** 原始行索引 — 卡片「有啥用」同步提取 + result 兜底 messages 免拉取. */
const rowsById = ref<Map<string, TaskRow>>(new Map());

function toTaskInput(row: TaskRow): CanvasTaskInput {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority ?? null,
    updatedAt: row.updated_at ?? null,
    requirementId: row.requirement_id ?? null,
    awaitingOwnerReview: !!row.awaiting_owner_review,
  };
}

function toReqInput(r: Requirement): CanvasRequirementInput {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

async function refresh(): Promise<void> {
  if (!projectId.value || loading.value) return;
  loading.value = true;
  try {
    const [taskRows, reqResp] = await Promise.all([
      get<TaskRow[]>(`/api/tasks?projectId=${projectId.value}&limit=500`),
      // page_size API 上限 100 (>100 直接 400 PAGE_SIZE_INVALID); 项目级需求
      // 点量级远小于此, P1 不做翻页聚合.
      listRequirements({ project_id: projectId.value, page_size: 100 }),
    ]);
    rowsById.value = new Map(
      (taskRows as unknown as TaskRow[]).map((r) => [r.id, r]),
    );
    model.value = buildCanvasModel(
      (taskRows as unknown as TaskRow[]).map(toTaskInput),
      reqResp.items.map(toReqInput),
    );
    lastRefreshed.value = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    void loadDetails();
  } catch (err) {
    // 与 BoardPage 同款: 失败 toast, 保留上一次模型 (画布不清空).
    toast.error(err instanceof Error ? err.message : t('misc.console.loadFailed'));
  } finally {
    loading.value = false;
  }
}

/* ---------------- 任务明细 (是什么/怎么样/下一步) ---------------- */

/** GET /api/tasks/[id]/checkpoints 行投影 (checkpoints 表原行, 取尾部一条). */
interface CheckpointRow {
  step?: string;
  summary?: string | null;
}

interface TaskDetail {
  next: string; // 下一步/怎么样 = 最新 checkpoint summary
}

/** taskId → { updatedAt 缓存键, 明细 }. updated_at 不变不重拉 (60s 轮询防抖). */
const detailCache = new Map<string, { updatedAt: string; detail: TaskDetail }>();

/** 明细缓存版本号 — Map 非 reactive, bump 一下让 detailOf 的响应依赖失效. */
const detailVersion = ref(0);

/* clip / extractGain 已抽纯逻辑 lib/console/card-summary.ts (单测覆盖):
   「有啥用」= value_significance (派发登记) → description → prompt 目标句. */

/** 「有啥用」一行 — 优先 LLM 面向用户摘要 (R177 迭代7), 回退机械提取
 *  (value_significance → description → prompt 目标句), damo 1004 拍板:
 *  卡片摘要像飞书 M/V 列总结 = 「干了啥 + 有啥用」两行直取. */
function gainOf(id: string): string {
  const ai = aiSummaries.value.get(id);
  if (ai?.why) return ai.why;
  const row = rowsById.value.get(id);
  if (!row) return '';
  return extractGain({
    valueSignificance: row.value_significance,
    description: row.description,
    prompt: row.prompt,
    title: row.title,
  }, 160); // R190: 展示允许两行, 机械提取 cap 80→160 对齐 AI 摘要 96 字宽裕度
}

/** 「干啥」一行 — LLM 自包含摘要 (黑话展开成人话); 机械提取没有对应物, 拿不到就空. */
function whatOf(id: string): string {
  return aiSummaries.value.get(id)?.what ?? '';
}

/* ---------------- LLM 面向用户摘要 (R177 迭代7, damo 1004 N 列拍板) ----------------
 * 机械提取截 prompt 行到顶: 「更新布署13000」「bash ~/…」不看上下文读不懂.
 * GET /api/tasks/[id]/card-summary = LLM 生成自包含两行 (后端 metadata 缓存,
 * 一任务一次成本). 失败静默回退机械提取. 并发 3 封顶 (每次 = 一个 SDK 子进程). */
const aiSummaries = ref<Map<string, { what: string; why: string }>>(new Map());
const aiFailed = new Set<string>();
const aiQueue: string[] = [];
let aiRunning = 0;

function enqueueAiSummary(id: string): void {
  if (aiSummaries.value.has(id) || aiFailed.has(id) || aiQueue.includes(id)) return;
  aiQueue.push(id);
  void pumpAiSummary();
}

async function pumpAiSummary(): Promise<void> {
  if (aiRunning >= 3) return;
  const id = aiQueue.shift();
  if (!id) return;
  aiRunning++;
  try {
    const r = await get<{ what: string; why: string; source: string }>(
      `/api/tasks/${id}/card-summary`,
    );
    if (r.source !== 'failed' && (r.what || r.why)) {
      const next = new Map(aiSummaries.value);
      next.set(id, { what: r.what, why: r.why });
      aiSummaries.value = next;
    } else {
      aiFailed.add(id); // 后端明确失败 → 不再重试, 回退机械提取
    }
  } catch {
    aiFailed.add(id);
  } finally {
    aiRunning--;
    void pumpAiSummary();
  }
}

/** 拉前 N 个聚焦任务的明细 (下一步 checkpoint; LLM 摘要两区都预取).
 *  失败静默 — 卡片只少一行摘要, 不 toast 不阻断画布.
 *  R177 迭代6: 任务行自带 result (完成汇报全文) 时本地直取, 免拉 messages.
 *  R177 迭代8: 为什么行撤下卡片 (damo: 干啥已体现) → 轮询只服务聚焦卡
 *  「下一步」, 改详情弹窗打开时 ensureDetail 懒取, 轮询请求量砍半.
 *  R177 迭代9: 「为什么」整行撤 (有啥用覆盖该语义) → messages 拉取链路全拆. */
async function loadDetails(): Promise<void> {
  const m = model.value;
  if (!m) return;
  const targets = [
    ...m.waitingTasks.slice(0, 8),
    ...m.focusTasks.slice(0, 6),
  ];
  // LLM 面向用户摘要: 并发 3 懒加载, 命中后端缓存即时返回; 失败回退机械提取
  for (const t of targets) enqueueAiSummary(t.id);
  await Promise.all(m.focusTasks.slice(0, 6).map(ensureDetail));
}

/** 确保单任务明细已取 (下一步), updated_at 防抖; 弹窗打开也走这里.
 *  失败静默 — 弹窗里只少一行, 不 toast. */
async function ensureDetail(t: { id: string; updatedAt?: string | null }): Promise<void> {
  const key = t.updatedAt ?? '';
  const hit = detailCache.get(t.id);
  if (hit && hit.updatedAt === key) return; // 任务没动, 不重拉
  try {
    // 下一步: 最新 checkpoint summary (agent 每个里程碑写的进度线).
    // R238 (damo): 存全文 (剥运行时标记), 卡片渲染时 clip 120 保持两行口径,
    // 弹窗完全展示 — 原来在这里就 clip 120, 弹窗里长 summary 大半不可见.
    const cps = await get<CheckpointRow[]>(`/api/tasks/${t.id}/checkpoints`);
    const lastCp = cps.length ? cps[cps.length - 1] : null;
    const next = lastCp?.summary ? stripRuntimeMarkers(lastCp.summary) : '';
    detailCache.set(t.id, { updatedAt: key, detail: { next } });
    // 触发卡片重渲染 (Map 非 reactive, 换个 tick 值)
    detailVersion.value++;
  } catch {
    /* 拉不到就只显示标题 */
  }
}

function detailOf(id: string): TaskDetail | null {
  void detailVersion.value; // 建立响应依赖
  return detailCache.get(id)?.detail ?? null;
}

/* ---------------- 详情弹窗 (R177 迭代8, damo 1004 N 列第 3 条) ----------------
 * 点卡片 → 原位缩放展开成详情弹窗 (FLIP: 记卡片 getBoundingClientRect →
 * 面板挂载后 transform 从卡片 rect 映射到终位, 过渡 220ms)。内容 = 卡片没有
 * 的细节: 下一步 / 执行结果 (迭代9 起「为什么」撤, 有啥用覆盖该语义),
 * + 打开完整任务页 / 验收。prefers-reduced-motion → 跳过位移动画只淡入。 */

interface DetailModalTask {
  id: string;
  title: string;
  status: string;
  updatedAt?: string | null;
  awaitingOwnerReview?: boolean | null;
}

const detailModal = ref<DetailModalTask | null>(null);
const modalPanel = ref<HTMLElement | null>(null);
let modalStartRect: DOMRect | null = null;

function openTaskModal(t: DetailModalTask, ev?: MouseEvent): void {
  const el = ev?.currentTarget;
  const card = el instanceof HTMLElement ? el.closest('.task-card, .queued-chip') : null;
  modalStartRect = card instanceof HTMLElement ? card.getBoundingClientRect() : null;
  detailModal.value = { ...t };
  void ensureDetail(t); // 下一步 懒取 (卡片已不预拉, 见 loadDetails 注释)
  void ensureResultLayers(t.id); // R190 正文 3 层懒取 (LLM 生成几秒, 层内 loading)
  layerOpen.value = { brief: true, details: false, full: false }; // 每次打开重置到顶层
  void nextTick(animateModalIn);
}

/** 面板终位量好后, 从卡片 rect FLIP 到终位 (transform-origin 左上). */
function animateModalIn(): void {
  const panel = modalPanel.value;
  if (!panel) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!modalStartRect || reduce) return; // 无起点 rect / 用户降级 → CSS 淡入即可
  const final = panel.getBoundingClientRect();
  const dx = modalStartRect.left - final.left;
  const dy = modalStartRect.top - final.top;
  const sx = modalStartRect.width / Math.max(final.width, 1);
  const sy = modalStartRect.height / Math.max(final.height, 1);
  panel.style.transition = 'none';
  panel.style.transformOrigin = 'top left';
  panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  panel.style.opacity = '0.35';
  void panel.offsetWidth; // 强制 reflow, 让起始 transform 先生效
  panel.style.transition =
    'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease-out';
  panel.style.transform = 'translate(0, 0) scale(1, 1)';
  panel.style.opacity = '1';
}

function closeTaskModal(): void {
  if (!detailModal.value) return;
  const panel = modalPanel.value;
  const finish = () => {
    detailModal.value = null;
    modalStartRect = null;
  };
  if (!panel) {
    finish();
    return;
  }
  panel.style.transition = 'transform 0.16s ease-in, opacity 0.16s ease-in';
  panel.style.transform = 'scale(0.96)';
  panel.style.opacity = '0';
  window.setTimeout(finish, 160);
}

function onModalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeTaskModal();
}

watch(detailModal, (v) => {
  if (v) document.addEventListener('keydown', onModalKeydown);
  else document.removeEventListener('keydown', onModalKeydown);
});

/** 弹窗内验收 → 复用卡片验收逻辑, 成败都收弹窗 (画布已刷新). */
async function approveFromModal(): Promise<void> {
  const t = detailModal.value;
  if (!t) return;
  await approveFromCard({
    id: t.id,
    title: t.title,
    awaitingOwnerReview: t.awaitingOwnerReview,
  });
  closeTaskModal();
}

/** 弹窗正文兜底文案: 无 AI 摘要时显示派发要求; 有结果显示结果摘录.
 *  1007: result 先剥运行时标记 (<checkpoint .../> 等管线符号不进弹窗). */
const modalBody = computed(() => {
  const t = detailModal.value;
  if (!t) return { prompt: '', result: '' };
  const row = rowsById.value.get(t.id);
  return {
    prompt: whatOf(t.id) || gainOf(t.id) ? '' : clip(row?.prompt ?? '', 200),
    result: clip(stripRuntimeMarkers(row?.result ?? ''), 600),
  };
});

/* ---------------- 正文 3 层钻取 (R190, damo 1004 飞书拍板) ----------------
 * 弹窗正文 = result 原文一坨 → 按 3 层组织, 每层是对下一层的总结 (理念多叉树):
 *   L1 概览 (默认展开) = LLM ≤5 句讲干了啥/操作了啥
 *   L2 核心细节 (收起) = LLM 分条列全部关键细节
 *   L3 完整处理 (收起) = result 原文 (rowsById 直取, 免请求)
 * L1/L2 走 GET /api/tasks/[id]/result-layers (后端 metadata 缓存, 一任务一次
 * LLM 成本); 失败/skip → 概览层回退显示原文摘录, 不重试不加压. */

interface ResultLayers {
  brief: string;
  details: string[];
  next: string; // 下一步 = LLM 从 result 提取的后续 (空 = 无, 回退 checkpoint 口径)
  source: string;
}

const layersCache = new Map<string, ResultLayers>();
const layersFailed = new Set<string>();
const layersLoading = new Set<string>();
const layersVersion = ref(0);
/** 每层独立开合 (概览默认开, 符合「想看详细就打开下一层」) */
const layerOpen = ref<Record<string, boolean>>({ brief: true, details: false, full: false });

/** result 太短不值得分层 (与后端 skip 阈值一致) — 直接单层显示原文. */
const LAYERS_SKIP_CHARS = 200;

function layersOf(id: string): ResultLayers | null {
  void layersVersion.value; // 建立响应依赖
  return layersCache.get(id) ?? null;
}

function layersStateOf(id: string): 'loading' | 'failed' | 'ready' | 'skip' {
  void layersVersion.value;
  if (layersCache.has(id)) return 'ready';
  if (layersLoading.has(id)) return 'loading';
  if (layersFailed.has(id)) return 'failed';
  return 'skip';
}

/** 弹窗打开时懒取 (不进卡片摘要队列 — 弹窗一次只看一个任务, 单发即可).
 *  🔴 R190 线上反馈「一直卡在正在生成总结」: 后端已有 50s 竞速超时, 前端再兜
 *  45s (AbortController) — 网络/代理挂死等后端超时也够不到的场景不无限转圈. */
const LAYERS_FETCH_TIMEOUT_MS = 45_000;

async function ensureResultLayers(id: string): Promise<void> {
  if (layersCache.has(id) || layersFailed.has(id) || layersLoading.has(id)) return;
  const row = rowsById.value.get(id);
  if (!row?.result || row.result.trim().length < LAYERS_SKIP_CHARS) return; // 短结果不分层
  layersLoading.add(id);
  layersVersion.value++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LAYERS_FETCH_TIMEOUT_MS);
  try {
    const r = await get<{ brief: string; details: string[]; next?: string; source: string }>(
      `/api/tasks/${id}/result-layers`,
      { signal: ctrl.signal },
    );
    if (r.source === 'skip') {
      layersFailed.add(id); // 后端判定不分层 — 前端同样单层, 不再请求
    } else if (r.source === 'failed') {
      layersFailed.add(id);
    } else if (r.brief || r.details.length) {
      layersCache.set(id, { brief: r.brief, details: r.details, next: r.next ?? '', source: r.source });
    } else {
      layersFailed.add(id);
    }
  } catch {
    layersFailed.add(id);
  } finally {
    clearTimeout(timer);
    layersLoading.delete(id);
    layersVersion.value++;
  }
}

function toggleLayer(key: string): void {
  layerOpen.value = { ...layerOpen.value, [key]: !layerOpen.value[key] };
}

/** 弹窗「下一步」: 终态任务优先 LLM 从 result 提取的 next (v3 layers, 完成时
 *  已预热), 没有则回退 checkpoint 尾条 (running 任务的进度线口径). */
const modalNext = computed(() => {
  const t = detailModal.value;
  if (!t) return '';
  return layersOf(t.id)?.next || detailOf(t.id)?.next || '';
});

/** L3 完整处理 = result 全文 (listTasks SELECT * 全量返回, 零额外请求).
 *  1007: 剥运行时标记 — 管线符号不进「原始汇报全文」(给谁看呢). */
const modalResultFull = computed(() => {
  const t = detailModal.value;
  if (!t) return '';
  return stripRuntimeMarkers(rowsById.value.get(t.id)?.result ?? '');
});

/* ---------------- 卡片快捷操作: 验收 / 回复转达 ---------------- */

const acting = ref<Set<string>>(new Set());

function actingAdd(id: string): void {
  acting.value = new Set(acting.value).add(id);
}
function actingDel(id: string): void {
  const s = new Set(acting.value);
  s.delete(id);
  acting.value = s;
}

/** 验收 (reviewing → completed). awaiting_owner_review=1 时后端 approve 会被
 *  409 gate 拦 — 先 unset-awaiting-review 再 approve (与 LifecycleActions
 *  callApi 同款语义). */
async function approveFromCard(task: { id: string; title: string; awaitingOwnerReview?: boolean | null }): Promise<void> {
  // 改名 task: 原 const t 参数会遮蔽 i18n 的 t(), 调 t('...') 会炸 (i18n W3c B2 迁移时修)
  if (acting.value.has(task.id)) return;
  actingAdd(task.id);
  try {
    if (task.awaitingOwnerReview) {
      await unsetAwaitingReview(task.id);
    }
    await post(`/api/tasks/${task.id}/approve`);
    toast.success(t('misc.console.approved', { title: clip(task.title, 24) }));
    await refresh();
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      // awaiting flag 竞态 (刚被别处改) — 再试一次 approve
      try {
        await post(`/api/tasks/${task.id}/approve`);
        toast.success(t('misc.console.approved', { title: clip(task.title, 24) }));
        await refresh();
        return;
      } catch (err2) {
        toast.error(err2 instanceof Error ? err2.message : t('misc.console.approveFailed'));
      }
    } else {
      toast.error(err instanceof Error ? err.message : t('misc.console.approveFailed'));
    }
  } finally {
    actingDel(task.id);
  }
}

/** 回复转达: POST /api/tasks/[id]/message → sendUserMessage. runtime 按
 *  状态自动路由 (paused=入队 resume 重放 / reviewing+await_user=auto-start
 *  唤醒 / running=流式直投), 前端不用关心唤醒. */
const replyFor = ref<string | null>(null);
const replyText = ref('');
const sending = ref(false);

function toggleReply(id: string): void {
  if (replyFor.value === id) {
    replyFor.value = null;
  } else {
    replyFor.value = id;
    replyText.value = '';
  }
}

async function sendReply(): Promise<void> {
  const id = replyFor.value;
  const text = replyText.value.trim();
  if (!id || !text || sending.value) return;
  sending.value = true;
  try {
    await post(`/api/tasks/${id}/message`, { message: text, sender_type: 'user' });
    toast.success(t('misc.console.relayed'));
    replyFor.value = null;
    replyText.value = '';
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('misc.console.sendFailed'));
  } finally {
    sending.value = false;
  }
}

/* ---------------- AI 全局归纳 (R195) ----------------
 * 后端 GET /api/projects/[id]/console-digest: AI 结合项目业务文档
 * (CLAUDE.md 等) + 任务清单, 归纳 headline + 每任务分类/紧急度/建议.
 * 缓存在后端 (fingerprint 没变零成本), 前端 60s 轮询白拿. */

const digest = ref<ConsoleDigest | null>(null);
const digestSource = ref('');
const digestLoading = ref(false);
const digestFailed = ref(false);
const digestCollapsed = ref(false);

// R204: 终态 (completed/cancelled) 已了结 — 非「已交付」分类的条目不显示
// (旧缓存 / LLM 错分兜底; 新数据在解析端 parseDigestJson 已过滤). 已交付
// 条目保留展示但无动作按钮 (digestActionFor → none).
const digestGroups = computed(() => {
  if (!digest.value) return [];
  const items = digest.value.items.filter((it) => {
    const st = rowsById.value.get(it.id)?.status;
    return !(st && DIGEST_INERT_STATUSES.includes(st) && it.category !== 'delivery');
  });
  return groupDigestItems(items);
});

async function loadDigest(force = false): Promise<void> {
  if (!projectId.value || digestLoading.value) return;
  digestLoading.value = true;
  try {
    const r = await get<{ source: string; digest: ConsoleDigest | null }>(
      `/api/projects/${projectId.value}/console-digest${force ? '?refresh=true' : ''}`,
    );
    digest.value = r.digest;
    digestSource.value = r.source;
    digestFailed.value = r.source === 'failed' || !r.digest;
  } catch {
    digestFailed.value = true; // 保留上一次归纳 (有的话), 面板不闪空
  } finally {
    digestLoading.value = false;
  }
}

/** 归纳条目标题 (行数据没了兜底截 id 前 8 位, 同任务页短链口径). */
function digestTitle(item: DigestItem): string {
  return rowsById.value.get(item.id)?.title ?? item.id.slice(0, 8);
}

/** 归纳条目一键动作: approve=真验收 / agree=罐头同意消息 / reply=行内输入.
 *  同意 = POST message 带建议原文, runtime 按状态自动路由唤醒, 零打字. */
async function runDigestAction(item: DigestItem): Promise<void> {
  const row = rowsById.value.get(item.id);
  const action = digestActionFor(item, row ?? undefined);
  if (action === 'none') return; // R204: 终态惰性, 不做任何唤醒
  if (action === 'approve') {
    await approveFromCard({
      id: item.id,
      title: digestTitle(item),
      awaitingOwnerReview: !!row?.awaiting_owner_review,
    });
    void loadDigest(); // 验收后指纹变 → 拉新归纳
    return;
  }
  if (action === 'reply') {
    toggleReply(item.id);
    return;
  }
  if (acting.value.has(item.id)) return;
  actingAdd(item.id);
  try {
    await post(`/api/tasks/${item.id}/message`, {
      message: buildAgreeMessage(item.suggestion),
      sender_type: 'user',
    });
    toast.success(t('misc.console.agreed', { title: clip(digestTitle(item), 24) }));
    await refresh();
    void loadDigest();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('misc.console.sendFailed'));
  } finally {
    actingDel(item.id);
  }
}

let pollTimer: number | undefined;
let digestPollTimer: number | undefined;

onMounted(async () => {
  await refresh();
  pollTimer = window.setInterval(refresh, 60_000);
  void loadDigest(); // R195: AI 归纳后台拉, 不阻塞画布首屏
  digestPollTimer = window.setInterval(() => void loadDigest(), 120_000);
  try {
    const p = await getProjectById(projectId.value);
    projectName.value = p?.name ?? '';
  } catch {
    projectName.value = ''; // 名字拿不到不阻断画布
  }
});

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
  if (digestPollTimer) window.clearInterval(digestPollTimer);
  document.removeEventListener('keydown', onModalKeydown);
});

/* ---------------- 派生渲染数据 ---------------- */

interface ZoneChip {
  key: string;
  label: string;
  value: number;
  cls: string;
}

const chips = computed<ZoneChip[]>(() => {
  const s = model.value?.stats;
  return [
    { key: 'focus', label: t('misc.console.chipFocus'), value: s?.focus ?? 0, cls: 'chip-focus' },
    { key: 'waiting', label: t('misc.console.chipWaiting'), value: s?.waiting ?? 0, cls: 'chip-waiting' },
    { key: 'queued', label: t('misc.console.chipQueued'), value: s?.queued ?? 0, cls: 'chip-queued' },
    { key: 'open', label: t('misc.console.chipOpen'), value: s?.openRequirements ?? 0, cls: 'chip-open' },
  ];
});

const quadrantGroups = computed(() => {
  const nodes = model.value?.quadrantNodes ?? [];
  const pick = (q: QuadrantNode['quadrant']) =>
    nodes.filter((n) => n.quadrant === q).slice(0, 12);
  return [
    { key: 'q2', label: t(QUADRANT_LABELS.q2), hint: t('misc.console.q2Hint'), nodes: pick('q2') },
    { key: 'q1', label: t(QUADRANT_LABELS.q1), hint: t('misc.console.q1Hint'), nodes: pick('q1') },
    { key: 'q4', label: t(QUADRANT_LABELS.q4), hint: t('misc.console.q4Hint'), nodes: pick('q4') },
    { key: 'q3', label: t(QUADRANT_LABELS.q3), hint: t('misc.console.q3Hint'), nodes: pick('q3') },
  ] as const;
});

function statusLabel(s: string): string {
  // i18n (W4.5b): STATUS_LABELS 值已改 locale key, 走共享 statusLabel() (未知回落原值).
  return sharedStatusLabel(s);
}

function taskStatusClass(s: string): string {
  return `st-${s}`;
}

function openNode(node: QuadrantNode): void {
  if (node.kind === 'requirement') {
    router.push({
      path: `/requirements/${node.id}`,
      query: { project_id: projectId.value },
    });
  } else {
    router.push(`/tasks/${node.id}`);
  }
}

/** 任务卡 / 排队 chip 点击 → 详情弹窗 (原位缩放展开); 完整任务页从弹窗进. */
function openTask(id: string, ev?: MouseEvent): void {
  const row = rowsById.value.get(id);
  openTaskModal(
    {
      id,
      title: row?.title ?? id,
      status: row?.status ?? '',
      updatedAt: row?.updated_at ?? null,
      awaitingOwnerReview: !!row?.awaiting_owner_review,
    },
    ev,
  );
}

function openRequirement(id: string): void {
  router.push({
    path: `/requirements/${id}`,
    query: { project_id: projectId.value },
  });
}

/* ---------------- AI 派活 + 智能控制 (F6 / 迭代4) ---------------- */

const aiOpen = ref(false);
const aiText = ref('');
const dispatching = ref(false);
const controlling = ref(false);

async function dispatchFromChat(): Promise<void> {
  const text = aiText.value.trim();
  if (!text || dispatching.value) return;
  dispatching.value = true;
  try {
    const title = text.split('\n')[0].slice(0, 60) || t('misc.console.defaultCanvasTitle');
    const task = await createTask({
      title,
      prompt: text,
      project_id: projectId.value,
      autoApprove: true,
      priority: 2,
    });
    await startTask(task.id);
    toast.success(t('misc.console.dispatched'));
    aiText.value = '';
    aiOpen.value = false;
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('misc.console.dispatchFailed'));
  } finally {
    dispatching.value = false;
  }
}

/** 总控任务 prompt 模板 — agent 子进程 env 已注入 AO_TOKEN (buildEnv),
 *  拿着它就能以 task owner 身份调本平台 API. origin 用浏览器当前地址 =
 *  本实例 (13001 dev / 13000 prod / 公网域名), 不依赖 agent 侧猜. */
function buildControllerPrompt(instruction: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return [
    '你是本项目的总控 agent (controller)。项目主人 damo 从总控制台画布下达了控制指令，由你代为执行平台的任务推进操作。',
    '',
    '== damo 的指令 ==',
    instruction,
    '',
    '== 平台 API 调用方式 ==',
    `环境变量 $AO_TOKEN 已注入你的进程 (task owner 的不过期 bearer token)。用:`,
    `curl -s -H "Authorization: Bearer $AO_TOKEN" -H "Content-Type: application/json" ${origin}/api/...`,
    '',
    '== 常用端点 ==',
    `- 列项目任务: GET /api/tasks?projectId=${projectId.value}&limit=100  (按 status 过滤 reviewing / await_user / paused / running)`,
    `- 任务消息历史 (看 agent 在等什么/汇报了什么): GET /api/tasks/<id>/messages`,
    `- 验收任务 (reviewing → completed): POST /api/tasks/<id>/approve  (若返回 409 AWAITING_OWNER_REVIEW, 先 POST /api/tasks/<id>/unset-awaiting-review 再 approve)`,
    `- 回复/转达给某任务: POST /api/tasks/<id>/message  body {"message":"..."}  (runtime 会自动唤醒该任务继续跑)`,
    '',
    '== 安全边界 (硬约束) ==',
    '- 只 approve status=reviewing 的任务; 其他状态一律不动。',
    '- 禁止 deploy (R128)、禁止删数据、禁止 force push、禁止取消/删除任务。',
    '- 指令含糊或需要 damo 拍板的, 不要猜 — 列进「需要 damo 评估的核心问题」。',
    '',
    '== 收尾汇报格式 (最后一轮回复必须包含) ==',
    '0. 第一行必须是: `完成: <一句话 —— 做的啥, 有啥用>` (总控制台卡片直取这行当摘要; 摘要里不要出现「Rxxx」这类行号/编号, 换成它指代的具体功能语意)',
    '1. 已推进: 列出你实际做的操作 (哪个任务、做了什么、结果状态)',
    '2. 需要 damo 评估的核心问题: 编号列表, 每条 ≤2 行, 讲清「问题是什么 + 选项 + 你的建议」; 没有待拍板就写「无」',
    '(这份汇报会显示在总控制台「等我处理」卡片上, damo 会直接在画布上回复你)',
  ].join('\n');
}

/** 智能控制: 把指令包成总控任务派给本项目的 agent — 由它代 damo 批量
 *  approve / 汇总问题 / 派发后续. 完成后落「等我处理」, damo 在卡片上
 *  回复即转达 (sendUserMessage 唤醒). */
async function dispatchControl(): Promise<void> {
  const instruction = aiText.value.trim();
  if (!instruction || controlling.value) return;
  controlling.value = true;
  try {
    const title = `🎛 ${t('misc.console.controllerTitlePrefix')} · ${clip(instruction, 40)}`;
    const task = await createTask({
      title,
      prompt: buildControllerPrompt(instruction),
      project_id: projectId.value,
      autoApprove: true,
      priority: 2,
    });
    await startTask(task.id);
    toast.success(t('misc.console.controlSent'));
    aiText.value = '';
    aiOpen.value = false;
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('misc.console.controlFailed'));
  } finally {
    controlling.value = false;
  }
}
</script>

<template>
  <div class="console-page">
    <!-- 顶部指标带 (F4/F5) -->
    <header class="console-header">
      <div class="console-title">
        <h1>🎬 {{ projectName || t('misc.console.projectFallback') }} · {{ t('misc.console.title') }}</h1>
        <p class="headline">{{ model?.headline ?? t('misc.console.loading') }}</p>
      </div>
      <div class="console-chips">
        <div
          v-for="c in chips"
          :key="c.key"
          class="chip"
          :class="c.cls"
          :title="c.label"
        >
          <span class="chip-num">{{ c.value }}</span>
          <span class="chip-label">{{ c.label }}</span>
        </div>
        <div class="header-tools">
          <span v-if="lastRefreshed" class="refreshed">{{ lastRefreshed }}</span>
          <button class="btn btn-secondary" :disabled="loading" @click="refresh">
            {{ loading ? t('misc.console.refreshing') : t('misc.console.refresh') }}
          </button>
          <router-link class="btn btn-secondary" :to="`/${projectId}/unversioned`" :title="t('misc.console.navTasksTitle')">
            📋 {{ t('misc.console.navTasks') }}
          </router-link>
          <router-link class="btn btn-secondary" :to="`/${projectId}/unversioned/requirements`" :title="t('misc.console.navReqsTitle')">
            📋 {{ t('misc.console.navReqs') }}
          </router-link>
        </div>
      </div>
    </header>

    <!-- AI 全局归纳 (R195): 结合项目业务文档的分类/建议/一键同意 -->
    <section class="digest" :class="{ 'digest-collapsed': digestCollapsed }">
      <div class="digest-head">
        <span class="digest-badge">✦ {{ t('misc.console.digestBadge') }}</span>
        <p class="digest-headline">
          <template v-if="digest && digest.headline">{{ digest.headline }}</template>
          <template v-else-if="digestLoading">{{ t('misc.console.digestLoading') }}</template>
          <template v-else-if="digestFailed">{{ t('misc.console.digestFailed') }}</template>
          <template v-else>{{ t('misc.console.digestEmpty') }}</template>
        </p>
        <div class="digest-tools">
          <span
            v-if="digestSource === 'stale'"
            class="digest-stale"
            :title="t('misc.console.staleTitle')"
          >{{ t('misc.console.staleLabel') }}</span>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="digestLoading"
            :title="t('misc.console.recalcTitle')"
            @click="loadDigest(true)"
          >{{ digestLoading ? t('misc.console.recalcRunning') : t('misc.console.recalc') }}</button>
          <button
            class="btn btn-secondary btn-sm"
            @click="digestCollapsed = !digestCollapsed"
          >{{ digestCollapsed ? t('misc.console.expand') : t('misc.console.collapse') }}</button>
        </div>
      </div>
      <div v-if="!digestCollapsed && digestGroups.length" class="digest-body">
        <div v-for="g in digestGroups" :key="g.key" class="digest-group">
          <div class="digest-group-head">
            <span class="digest-group-icon">{{ g.icon }}</span>
            <b>{{ g.label }}</b>
            <span class="digest-group-count">{{ g.items.length }}</span>
          </div>
          <ul>
            <li
              v-for="item in g.items"
              :key="item.id"
              class="digest-item"
              @click="openTask(item.id, $event)"
            >
              <span class="digest-urgency" :class="urgencyClass(item.urgency)" />
              <span class="digest-item-title" :title="digestTitle(item)">{{ digestTitle(item) }}</span>
              <span v-if="item.suggestion" class="digest-suggestion" :title="item.suggestion">{{ item.suggestion }}</span>
              <button
                v-if="digestActionFor(item, rowsById.get(item.id)) !== 'none'"
                class="card-act"
                :class="{ 'digest-agree': digestActionFor(item, rowsById.get(item.id)) === 'agree' }"
                :disabled="acting.has(item.id)"
                :title="digestActionFor(item, rowsById.get(item.id)) === 'approve'
                  ? t('misc.console.actApproveTitle')
                  : digestActionFor(item, rowsById.get(item.id)) === 'agree'
                    ? t('misc.console.actAgreeTitle')
                    : t('misc.console.actReplyTitle')"
                @click.stop="runDigestAction(item)"
              >{{ acting.has(item.id) ? '…' : actionLabel(digestActionFor(item, rowsById.get(item.id))) }}</button>
            </li>
            <li v-if="replyFor && g.items.some((i) => i.id === replyFor)" class="digest-reply-row">
              <div class="card-reply" @click.stop>
                <input
                  v-model="replyText"
                  class="reply-input"
                  type="text"
                  :placeholder="t('misc.console.replyPlaceholder')"
                  :disabled="sending"
                  @keydown.enter.exact.prevent="sendReply"
                />
                <button class="card-act card-act-send" :disabled="sending || !replyText.trim()" @click="sendReply">
                  {{ sending ? t('misc.console.sending') : t('misc.console.relay') }}
                </button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 画布主体 -->
    <div v-if="model" class="console-canvas">
      <!-- 左: 近期聚焦 (F2) -->
      <section class="zone zone-focus" :title="t('misc.console.zoneFocusTitle')">
        <h2>⚡ {{ t('misc.console.zoneFocus') }}</h2>
        <p v-if="!model.focusTasks.length" class="empty">{{ t('misc.console.focusEmpty') }}</p>
        <ul class="task-flow">
          <li
            v-for="tk in model.focusTasks"
            :key="tk.id"
            class="task-card anim-pulse"
            @click="openTask(tk.id, $event)"
          >
            <div class="card-main">
              <span class="dot" :class="taskStatusClass(tk.status)" />
              <span class="task-title">{{ tk.title }}</span>
              <!-- R191: 任务时间上卡片 — 最后更新 (短格式, title 全量) -->
              <span
                v-if="formatShortDateTime(tk.updatedAt)"
                class="task-time"
                :title="t('misc.console.lastUpdated', { time: tk.updatedAt ?? '' })"
              >{{ formatShortDateTime(tk.updatedAt) }}</span>
              <span class="task-status">{{ statusLabel(tk.status) }}</span>
            </div>
            <p v-if="whatOf(tk.id)" class="card-sub" :title="t('misc.console.subWhatTitle')">
              <span class="sub-tag">{{ t('misc.console.tagWhat') }}</span>{{ whatOf(tk.id) }}
            </p>
            <p v-if="gainOf(tk.id)" class="card-sub" :title="t('misc.console.subGainTitle')">
              <span class="sub-tag sub-gain">{{ t('misc.console.tagGain') }}</span>{{ gainOf(tk.id) }}
            </p>
            <p v-if="detailOf(tk.id)?.next" class="card-sub" :title="t('misc.console.subNextTitle')">
              <span class="sub-tag">{{ t('misc.console.tagNext') }}</span>{{ clip(detailOf(tk.id)?.next ?? '', 120) }}
            </p>
          </li>
        </ul>
      </section>

      <!-- 中: 四象限 (F3) -->
      <section class="zone zone-quadrant">
        <h2>🎯 {{ t('misc.console.zoneQuadrant') }}</h2>
        <div class="quadrant-grid">
          <div
            v-for="q in quadrantGroups"
            :key="q.key"
            class="quad"
            :class="`quad-${q.key}`"
          >
            <div class="quad-head">
              <b>{{ q.label }}</b>
              <span class="quad-hint">{{ q.hint }}</span>
            </div>
            <div class="quad-nodes">
              <button
                v-for="n in q.nodes"
                :key="n.id"
                class="node"
                :class="n.kind === 'requirement' ? 'node-req' : 'node-task'"
                :title="`${n.kind === 'requirement' ? t('misc.console.nodeKindReq') : t('misc.console.nodeKindTask')} · ${statusLabel(n.status)}${n.updatedAt ? ` · ${t('misc.console.lastUpdated', { time: n.updatedAt })}` : ''}`"
                @click="openNode(n)"
              >
                <span class="node-tag">{{ n.kind === 'requirement' ? t('misc.console.tagReq') : t('misc.console.tagTask') }}</span>
                <span class="node-title">{{ n.title }}</span>
                <!-- R199: 象限节点补可见时间 (R191 只做了 tooltip, 漏了可见层;
                     僵尸任务无时间显示 = 看不出多老, 像"插队到最前面") -->
                <span
                  v-if="formatShortDateTime(n.updatedAt)"
                  class="node-time"
                >{{ formatShortDateTime(n.updatedAt) }}</span>
                <span v-if="n.activeTaskCount" class="node-count">{{ n.activeTaskCount }}</span>
              </button>
              <span v-if="!q.nodes.length" class="quad-empty">—</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 右: 等我处理 (F2) -->
      <section class="zone zone-waiting">
        <h2>🔔 {{ t('misc.console.zoneWaiting') }}</h2>
        <p
          v-if="!model.waitingTasks.length && !model.waitingRequirements.length"
          class="empty"
        >
          {{ t('misc.console.waitingEmpty') }}
        </p>
        <ul v-if="model.waitingTasks.length" class="task-flow">
          <li
            v-for="tk in model.waitingTasks.slice(0, 10)"
            :key="tk.id"
            class="task-card anim-bell"
            @click="openTask(tk.id, $event)"
          >
            <div class="card-main">
              <span class="dot" :class="taskStatusClass(tk.status)" />
              <span class="task-title">{{ tk.title }}</span>
              <!-- R191: 任务时间上卡片 — 最后更新 (短格式, title 全量) -->
              <span
                v-if="formatShortDateTime(tk.updatedAt)"
                class="task-time"
                :title="t('misc.console.lastUpdated', { time: tk.updatedAt ?? '' })"
              >{{ formatShortDateTime(tk.updatedAt) }}</span>
              <span class="task-status">{{ statusLabel(tk.status) }}</span>
              <!-- 快捷操作: reviewing=验收; 其余等待态=回复转达 (stop 冒泡防触发跳详情) -->
              <button
                v-if="tk.status === 'reviewing'"
                class="card-act"
                :disabled="acting.has(tk.id)"
                :title="t('misc.console.actApproveTitle')"
                @click.stop="approveFromCard(tk)"
              >{{ acting.has(tk.id) ? '…' : t('misc.console.actApprove') }}</button>
              <button
                v-else
                class="card-act"
                :title="t('misc.console.actReplyTitle')"
                @click.stop="toggleReply(tk.id)"
              >✎ {{ t('misc.console.actReply') }}</button>
            </div>
            <p v-if="whatOf(tk.id)" class="card-sub" :title="t('misc.console.subWhatTitle')">
              <span class="sub-tag">{{ t('misc.console.tagWhat') }}</span>{{ whatOf(tk.id) }}
            </p>
            <p v-if="gainOf(tk.id)" class="card-sub" :title="t('misc.console.subGainTitle')">
              <span class="sub-tag sub-gain">{{ t('misc.console.tagGain') }}</span>{{ gainOf(tk.id) }}
            </p>
            <!-- 迭代8 撤下卡片 / 迭代9 整行撤: 「为什么」语义由「有啥用」覆盖 -->
            <!-- 回复输入框: sendUserMessage 按状态自动路由 (paused 入队 / reviewing·await_user 唤醒 / running 直投) -->
            <div v-if="replyFor === tk.id" class="card-reply" @click.stop>
              <input
                v-model="replyText"
                class="reply-input"
                type="text"
                :placeholder="t('misc.console.replyPlaceholder')"
                :disabled="sending"
                @keydown.enter.exact.prevent="sendReply"
              />
              <button class="card-act card-act-send" :disabled="sending || !replyText.trim()" @click="sendReply">
                {{ sending ? t('misc.console.sending') : t('misc.console.relay') }}
              </button>
            </div>
          </li>
        </ul>
        <ul v-if="model.waitingRequirements.length" class="task-flow">
          <li
            v-for="r in model.waitingRequirements.slice(0, 8)"
            :key="r.id"
            class="task-card req-card anim-bell"
            @click="openRequirement(r.id)"
          >
            <span class="dot st-requirement" />
            <span class="task-title">{{ r.title }}</span>
            <span
              v-if="formatShortDateTime(r.updatedAt)"
              class="task-time"
              :title="t('misc.console.lastUpdated', { time: r.updatedAt ?? '' })"
            >{{ formatShortDateTime(r.updatedAt) }}</span>
            <span class="task-status">{{ t('misc.console.chipOpen') }}</span>
          </li>
        </ul>
      </section>

      <!-- 底: 排队区 (F2) -->
      <section class="zone zone-queued">
        <h2>🧊 {{ t('misc.console.zoneQueued') }} <span class="zone-count">{{ model.queuedTasks.length }}</span></h2>
        <p v-if="!model.queuedTasks.length" class="empty">{{ t('misc.console.queuedEmpty') }}</p>
        <div v-else class="queued-strip">
          <button
            v-for="tk in model.queuedTasks.slice(0, 14)"
            :key="tk.id"
            class="queued-chip anim-shimmer"
            :title="`${statusLabel(tk.status)}${tk.updatedAt ? ` · ${t('misc.console.lastUpdated', { time: tk.updatedAt })}` : ''}`"
            @click="openTask(tk.id, $event)"
          >
            <span class="queued-chip-title">{{ tk.title }}</span>
            <span
              v-if="formatShortDateTime(tk.updatedAt)"
              class="task-time"
            >{{ formatShortDateTime(tk.updatedAt) }}</span>
          </button>
          <span v-if="model.queuedTasks.length > 14" class="zone-count">
            +{{ model.queuedTasks.length - 14 }}
          </span>
        </div>
      </section>
    </div>

    <div v-else class="console-loading">{{ t('misc.console.canvasLoading') }}</div>

    <!-- AI 派活 / 智能控制入口 (F6 + 迭代4) -->
    <button class="ai-fab" :title="t('misc.console.fabTitle')" @click="aiOpen = !aiOpen">✦ {{ t('misc.console.fabLabel') }}</button>
    <div v-if="aiOpen" class="ai-panel">
      <div class="ai-panel-head">
        <b>{{ t('misc.console.panelTitle') }}</b>
        <button class="ai-close" @click="aiOpen = false">✕</button>
      </div>
      <textarea
        v-model="aiText"
        class="ai-input"
        rows="4"
        :placeholder="t('misc.console.aiPlaceholder')"
        @keydown.ctrl.enter.exact.prevent="dispatchFromChat"
      />
      <div class="ai-panel-foot">
        <span class="ai-hint">{{ t('misc.console.aiHint') }}</span>
        <div class="ai-actions">
          <button
            class="btn btn-secondary"
            :disabled="controlling || !aiText.trim()"
            :title="t('misc.console.controlBtnTitle')"
            @click="dispatchControl"
          >
            {{ controlling ? t('misc.console.controlling') : t('misc.console.controlBtn') }}
          </button>
          <button class="btn btn-primary" :disabled="dispatching || !aiText.trim()" @click="dispatchFromChat">
            {{ dispatching ? t('misc.console.dispatching') : t('misc.console.dispatchBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗 (迭代8): 卡片原位缩放展开; Esc / 点遮罩关闭 -->
    <Teleport to="body">
      <div v-if="detailModal" class="task-modal" @click.self="closeTaskModal">
        <div ref="modalPanel" class="task-modal-panel" role="dialog" aria-modal="true">
          <div class="tm-head">
            <span class="dot" :class="taskStatusClass(detailModal.status)" />
            <h3 :title="detailModal.title">{{ detailModal.title }}</h3>
            <!-- R191: 弹窗头部带最后更新时间 -->
            <span
              v-if="formatShortDateTime(detailModal.updatedAt)"
              class="task-time"
              :title="t('misc.console.lastUpdated', { time: detailModal.updatedAt ?? '' })"
            >{{ formatShortDateTime(detailModal.updatedAt) }}</span>
            <span class="task-status">{{ statusLabel(detailModal.status) }}</span>
            <button class="ai-close tm-close" :title="t('misc.console.closeTip')" @click="closeTaskModal">✕</button>
          </div>
          <div class="tm-body">
            <p v-if="whatOf(detailModal.id)" class="tm-line">
              <span class="sub-tag">{{ t('misc.console.tagWhat') }}</span>{{ whatOf(detailModal.id) }}
            </p>
            <p v-if="gainOf(detailModal.id)" class="tm-line">
              <span class="sub-tag sub-gain">{{ t('misc.console.tagGain') }}</span>{{ gainOf(detailModal.id) }}
            </p>
            <p v-if="modalNext" class="tm-line">
              <span class="sub-tag">{{ t('misc.console.tagNext') }}</span>{{ modalNext }}
            </p>
            <p v-if="modalBody.prompt" class="tm-line" :title="t('misc.console.tagPromptTitle')">
              <span class="sub-tag">{{ t('misc.console.tagPrompt') }}</span>{{ modalBody.prompt }}
            </p>
            <!-- R190 正文 3 层钻取: 概览 → 核心细节 → 完整处理, 每层是下一层的总结.
                 result 过短 (<200 字) 不分层, 直接单层显示原文. -->
            <div v-if="modalResultFull.length >= LAYERS_SKIP_CHARS" class="tm-layers">
              <div class="layer" :class="{ open: layerOpen.brief }">
                <button class="layer-head" @click="toggleLayer('brief')">
                  <span class="layer-tag">{{ t('misc.console.layerBrief') }}</span>
                  <span class="layer-hint">{{ t('misc.console.layerBriefHint') }}</span>
                  <span class="layer-caret">{{ layerOpen.brief ? '▾' : '▸' }}</span>
                </button>
                <div v-if="layerOpen.brief" class="layer-body">
                  <template v-if="layersStateOf(detailModal.id) === 'ready'">
                    <p class="layer-brief">{{ layersOf(detailModal.id)?.brief }}</p>
                  </template>
                  <p v-else-if="layersStateOf(detailModal.id) === 'loading'" class="layer-pending">
                    {{ t('misc.console.layerPending') }}
                  </p>
                  <p v-else class="layer-brief layer-fallback">{{ modalBody.result }}</p>
                </div>
              </div>
              <div class="layer" :class="{ open: layerOpen.details }">
                <button class="layer-head" @click="toggleLayer('details')">
                  <span class="layer-tag layer-tag-2">{{ t('misc.console.layerDetails') }}</span>
                  <span class="layer-hint">{{ t('misc.console.layerDetailsHint') }}</span>
                  <span class="layer-caret">{{ layerOpen.details ? '▾' : '▸' }}</span>
                </button>
                <!-- damo 1005 R 列拍板: 细节不要一堆文字, 画处理流程图 —— 竖向步骤图,
                     每节点 = 一个步骤 (序号圆点 + 连接线), commit id 必配含义 (LLM prompt 强制). -->
                <ol v-if="layerOpen.details" class="layer-body layer-flow">
                  <template v-if="layersStateOf(detailModal.id) === 'ready'">
                    <li v-for="(d, i) in layersOf(detailModal.id)?.details" :key="i" class="flow-node">
                      <span class="flow-dot">{{ i + 1 }}</span>
                      <span class="flow-text">{{ d }}</span>
                    </li>
                  </template>
                  <li v-else-if="layersStateOf(detailModal.id) === 'loading'" class="layer-pending">
                    {{ t('misc.console.layerPending') }}
                  </li>
                  <li v-else class="layer-pending">{{ t('misc.console.noDetails') }}</li>
                </ol>
              </div>
              <div class="layer" :class="{ open: layerOpen.full }">
                <button class="layer-head" @click="toggleLayer('full')">
                  <span class="layer-tag layer-tag-3">{{ t('misc.console.layerFull') }}</span>
                  <span class="layer-hint">{{ t('misc.console.layerFullHint') }}</span>
                  <span class="layer-caret">{{ layerOpen.full ? '▾' : '▸' }}</span>
                </button>
                <pre v-if="layerOpen.full" class="layer-body tm-result tm-result-full">{{ modalResultFull }}</pre>
              </div>
            </div>
            <pre v-else-if="modalBody.result" class="tm-result">{{ modalBody.result }}</pre>
          </div>
          <div class="tm-foot">
            <button class="btn btn-secondary" @click="router.push(`/tasks/${detailModal.id}`)">
              {{ t('misc.console.openFullTask') }}
            </button>
            <button
              v-if="detailModal.status === 'reviewing'"
              class="btn btn-primary"
              :disabled="acting.has(detailModal.id)"
              @click="approveFromModal"
            >
              {{ acting.has(detailModal.id) ? t('misc.console.approving') : t('misc.console.actApprove') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 画布整体: 深色渐变底 = "画板" 感 (与 app 浅色 chrome 区分, F1/F5). */
.console-page {
  min-height: 100%;
  padding: 16px 20px 80px;
  background:
    radial-gradient(1200px 500px at 15% -10%, rgba(37, 99, 235, 0.16), transparent 60%),
    radial-gradient(900px 420px at 95% 0%, rgba(124, 58, 237, 0.14), transparent 55%),
    var(--color-bg);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---- 顶部指标带 ---- */
.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.console-title h1 {
  margin: 0;
  font-size: 20px;
}
.headline {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: 14px;
}
.console-chips {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 58px;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
}
.chip-num { font-size: 18px; font-weight: 700; line-height: 1.1; }
.chip-label { font-size: 11px; color: var(--color-text-muted); }
.chip-focus .chip-num { color: var(--color-primary); }
.chip-waiting .chip-num { color: var(--color-danger); }
.chip-queued .chip-num { color: var(--color-warn); }
.chip-open .chip-num { color: var(--color-success); }
.header-tools { display: flex; align-items: center; gap: 8px; margin-left: 6px; }
.refreshed { font-size: 12px; color: var(--color-text-muted); }

/* ---- AI 全局归纳 (R195) ---- */
.digest {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-sm);
  padding: 10px 14px;
}
.digest-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.digest-badge {
  flex: none;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
  border-radius: 999px;
  padding: 2px 10px;
}
.digest-headline {
  flex: 1;
  min-width: 200px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.digest-tools { display: flex; align-items: center; gap: 8px; }
.digest-stale {
  font-size: 11px;
  color: var(--color-warn);
  border: 1px solid var(--color-warn);
  border-radius: 4px;
  padding: 0 6px;
}
.btn-sm { padding: 3px 10px; font-size: 12px; }
.digest-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px 18px;
  margin-top: 10px;
}
.digest-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--color-border);
}
.digest-group-count {
  font-size: 12px;
  color: var(--color-text-muted);
}
.digest-group ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.digest-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.digest-item:hover { background: var(--color-bg); }
.digest-urgency {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.urg-high { background: var(--color-danger); }
.urg-mid { background: var(--color-warn); }
.urg-low { background: var(--color-border); }
.digest-item-title {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.digest-suggestion {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}
.digest-agree { color: var(--color-success); border-color: var(--color-success); }
.digest-reply-row { padding: 2px 4px; }

/* ---- 画布网格 ---- */
.console-canvas {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(360px, 2.2fr) minmax(220px, 1fr);
  grid-template-areas:
    'focus quadrant waiting'
    'queued queued queued';
  gap: 14px;
  align-items: stretch;
}
.zone {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  padding: 12px 14px;
  min-height: 260px;
}
.zone h2 {
  margin: 0 0 10px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.zone-focus { grid-area: focus; }
.zone-quadrant { grid-area: quadrant; }
.zone-waiting { grid-area: waiting; }
.zone-queued { grid-area: queued; min-height: 0; }
.zone-count { color: var(--color-text-muted); font-size: 12px; }
.empty { color: var(--color-text-muted); font-size: 13px; margin: 24px 0; text-align: center; }

/* ---- 任务流 (左/右区) ---- */
.task-flow { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.task-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s, transform 0.15s;
}
.task-card:hover { border-color: var(--color-primary); transform: translateX(2px); }
.card-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.task-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-status { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
/* R191: 任务时间 (最后更新) — 弱化展示, 不与状态争注意力 */
.task-time {
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.85;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.req-card { border-style: dashed; }

/* 卡片摘要行 (迭代4: 下一步) */
.card-sub {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--color-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding-left: 16px;
}
.sub-tag {
  display: inline-block;
  font-size: 10px;
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
  border-radius: 3px;
  padding: 0 3px;
  margin-right: 5px;
  line-height: 1.5;
  flex-shrink: 0;
}
.sub-gain { color: var(--color-success); border-color: var(--color-success); }

/* 卡片快捷操作按钮 */
.card-act {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: 11px;
  border-radius: var(--radius);
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.card-act:hover:not(:disabled) { border-color: var(--color-success); color: var(--color-success); }
.card-act:disabled { opacity: 0.5; cursor: default; }
.card-act-send { border-color: var(--color-primary); color: var(--color-primary); }
.card-act-send:hover:not(:disabled) { background: var(--color-primary); color: #fff; }

/* 回复输入框 (迭代4: 转达) */
.card-reply { display: flex; gap: 6px; padding-left: 16px; }
.reply-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--radius);
  border: 1px solid var(--color-border-strong);
  font-family: inherit;
}
.reply-input:focus { outline: none; border-color: var(--color-primary); }

/* 状态点 */
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--color-text-muted); }
.st-running, .st-verifying { background: var(--color-primary); }
.st-reviewing, .st-await_user { background: var(--color-danger); }
.st-paused { background: var(--color-warn); }
.st-pending, .st-queued { background: var(--tw-cyan-600-solid); }
.st-requirement { background: var(--color-success); }

/* ---- 四象限 ---- */
.quadrant-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-areas: 'q2 q1' 'q4 q3';
  gap: 10px;
  height: calc(100% - 30px);
}
.quad { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 8px 10px; overflow: hidden; }
.quad-q1 { grid-area: q1; border-color: rgba(220, 38, 38, 0.35); background: rgba(220, 38, 38, 0.04); }
.quad-q2 { grid-area: q2; border-color: rgba(37, 99, 235, 0.3); background: rgba(37, 99, 235, 0.04); }
.quad-q3 { grid-area: q3; background: rgba(217, 119, 6, 0.04); }
.quad-q4 { grid-area: q4; opacity: 0.85; }
.quad-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
.quad-head b { font-size: 13px; }
.quad-hint { font-size: 10px; color: var(--color-text-muted); }
.quad-nodes { display: flex; flex-wrap: wrap; gap: 5px; }
.quad-empty { color: var(--color-text-muted); font-size: 12px; }
.node {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-elevated);
  cursor: pointer;
}
.node:hover { border-color: var(--color-primary); }
.node-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.node-tag { font-size: 10px; border-radius: 3px; padding: 0 3px; background: var(--color-bg); color: var(--color-text-muted); }
.node-req { border-style: solid; border-color: var(--color-success); }
.node-count { font-size: 10px; color: var(--color-warn); font-weight: 700; }
/* R199: 象限节点可见时间 — 与 .task-time 同口径 (弱化, tabular-nums) */
.node-time { font-size: 10px; color: var(--color-text-muted); opacity: 0.85; flex-shrink: 0; font-variant-numeric: tabular-nums; }

/* ---- 排队区 ---- */
.queued-strip { display: flex; flex-wrap: wrap; gap: 6px; }
.queued-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid rgba(8, 145, 178, 0.4);
  background: rgba(8, 145, 178, 0.06);
  cursor: pointer;
  max-width: 300px;
  overflow: hidden;
  white-space: nowrap;
}
/* R191: chip 内标题省略 + 时间并列 (原 ellipsis 挂 button 自身, 拆内层后移到这里) */
.queued-chip-title {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.queued-chip:hover { border-color: var(--tw-cyan-600); }

/* ---- 动效 (F2, prefers-reduced-motion 降级) ---- */
@keyframes aoPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.25); }
  50% { box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.08); }
}
@keyframes aoBell {
  0%, 88%, 100% { transform: translateX(0); }
  92% { transform: translateX(-1.5px); }
  96% { transform: translateX(1.5px); }
}
@keyframes aoShimmer {
  background-position: -200% 0;
}
.anim-pulse { animation: aoPulse 2.4s ease-in-out infinite; }
.anim-bell { animation: aoBell 4s ease-in-out infinite; }
.anim-shimmer {
  background-image: linear-gradient(100deg, rgba(8, 145, 178, 0.06) 30%, rgba(8, 145, 178, 0.22) 50%, rgba(8, 145, 178, 0.06) 70%);
  background-size: 200% 100%;
  animation: aoShimmer 2.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .anim-pulse, .anim-bell, .anim-shimmer { animation: none; }
  .task-modal { animation: none; }
}

/* ---- AI 派活 ---- */
.ai-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  padding: 10px 18px;
  border-radius: 999px;
  border: none;
  background: linear-gradient(120deg, var(--tw-blue-600-solid), var(--tw-violet-600-solid));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-md);
}
.ai-fab:hover { filter: brightness(1.08); }
.ai-panel {
  position: fixed;
  right: 24px;
  bottom: 70px;
  width: 340px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-panel-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.ai-close { border: none; background: none; cursor: pointer; color: var(--color-text-muted); }
.ai-input { width: 100%; box-sizing: border-box; resize: vertical; font-size: 13px; padding: 8px; border-radius: var(--radius); border: 1px solid var(--color-border-strong); }
.ai-panel-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.ai-hint { font-size: 11px; color: var(--color-text-muted); }
.ai-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* ---- 详情弹窗 (迭代8: 卡片原位缩放展开) ---- */
.task-modal {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.42);
  animation: aoFade 0.16s ease-out;
}
@keyframes aoFade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.task-modal-panel {
  width: min(720px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  will-change: transform, opacity;
}
.tm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}
.tm-head h3 {
  margin: 0;
  font-size: 15px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-close { font-size: 14px; }
.tm-body {
  padding: 12px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* R238 (damo): 弹窗行完全展示, 不限 2 行 — 小屏幕 2 行装不下, 长 summary
   (收尾总结这类) 在弹窗里必须全文可见; 卡片仍保持两行口径不动. */
.tm-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--color-text);
}
.tm-result {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  color: var(--color-text-muted);
  max-height: 240px;
  overflow-y: auto;
}
/* ---- R190 正文 3 层钻取 (概览 → 核心细节 → 完整处理) ---- */
.tm-layers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}
.layer {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  overflow: hidden;
}
.layer.open {
  border-color: color-mix(in srgb, var(--color-accent, #2563eb) 35%, var(--color-border));
}
.layer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text);
  text-align: left;
}
.layer-head:hover {
  background: color-mix(in srgb, var(--color-text) 4%, transparent);
}
.layer-tag {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: var(--color-accent, #2563eb);
}
.layer-tag-2 {
  background: var(--color-accent-2, #7c3aed);
}
.layer-tag-3 {
  background: var(--color-text-muted, #64748b);
}
.layer-hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-caret {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}
.layer-body {
  margin: 0;
  padding: 2px 12px 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text);
}
.layer-brief {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.layer-fallback {
  color: var(--color-text-muted);
  font-size: 12px;
}
.layer-pending {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
  animation: layer-pulse 1.4s ease-in-out infinite;
}
@keyframes layer-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
/* 核心细节 = 处理流程图解 (damo 1005 R 列拍板): 竖向步骤图, 序号圆点 + 连接线. */
.layer-flow {
  list-style: none;
  margin: 0;
  padding: 4px 12px 10px 8px;
  position: relative;
}
.flow-node {
  position: relative;
  display: flex;
  gap: 8px;
  padding: 0 0 12px 0;
  word-break: break-word;
}
.flow-node:last-child { padding-bottom: 0; }
/* 连接线: 圆点中心向下连到下一节点 (最后一个节点不画) */
.flow-node:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 10px;
  top: 16px;
  bottom: -2px;
  width: 2px;
  background: color-mix(in srgb, var(--color-accent-2, #7c3aed) 35%, transparent);
}
.flow-dot {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: var(--color-accent-2, #7c3aed);
  opacity: 0.85;
  z-index: 1;
}
.flow-text {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--color-text);
  padding-top: 1px;
}
.tm-result-full {
  margin: 0 10px 10px;
  padding: 8px 10px;
  max-height: 40vh;
}
@media (prefers-reduced-motion: reduce) {
  .layer-pending { animation: none; }
}
.tm-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--color-border);
}

/* ---- 窄屏降级: 单列 ---- */
@media (max-width: 980px) {
  .console-canvas {
    grid-template-columns: 1fr;
    grid-template-areas: 'focus' 'quadrant' 'waiting' 'queued';
  }
}
.console-loading { color: var(--color-text-muted); text-align: center; padding: 60px 0; }
</style>
