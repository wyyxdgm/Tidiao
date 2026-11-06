<script setup lang="ts">
/* 功能: 项目列表 + 新建 modal — 对应 master src/app/projects-client.tsx 的 list + create 段.
   R41-C1 落地: SPA ProjectsView 之前是 56 行 stub 只读列表, 本轮加 create 流程 + 「是否同时建 v1.0 版本」
   一键提示. master ProjectsClient 完整 1795 行含 LLM / Runner / Wiki 高级选项 — SPA 不强求 1:1 镜像,
   只交付 R41-C1 范围 (name + description + cwd + ports + 一键 v1.0 版本提示).

   关注点:
   - sheet 红线 "version + wiki 同建 一键" — SPA 当前没有新建版本 UI (VersionDetailView 只读),
     master ProjectsClient 两步也分两个 modal. 本轮走「项目创建成功 → 弹小提示 → 一键跳项目详情
     (R17 已挂) → 用户在项目详情内点 + 版本」, 这是 SPA 当前可执行的最短路径, 比纯 toast 强一步.
   - ports 字段按 master 接受逗号分隔字符串 (前端 split → number[]), R18 R 列拍板同上.
   - 复用 Layer 0 全套: R7 Button + R8 Input/Textarea + R5 Modal + useToast. 不引 R13 Empty /
     ErrorView (项目创建是操作面板, 列表加载失败走 R11 Loading + inline error, 不阻 UI).
   - 创建成功后 refresh 列表 (projectsStore.load(true) 强制重拉) + 跳到新建项目的详情页 (R17
     已挂路由), 与 master ProjectsClient 重置 selectedId + scrollIntoView 同口径. */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/stores/projects';
import { createProject, deleteProject as apiDeleteProject, deleteVersion as apiDeleteVersion, listAvailablePorts, listProjectTemplates, updateProject as apiUpdateProject, updateVersion as apiUpdateVersion, type CreateProjectBody, type Project, type ProjectTemplate, type Version } from '@/api/projects';
import { isHttpError } from '@/api/http';
import { getScopeCounts, type ScopeCounts } from '@/api/stats';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/components/ConfirmDialog.vue';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import NewVersionForm from '@/components/NewVersionForm.vue';
import Modal from '@/components/Modal.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import type { SelectOption } from '@/components/Select.vue';
import ProjectLlmConfigPanel from '@/components/ProjectLlmConfigPanel.vue';
import ProjectAdvancedOptionsPanel from '@/components/ProjectAdvancedOptionsPanel.vue';

const projectsStore = useProjectsStore();
const router = useRouter();
const toast = useToast();
const { confirm: confirmDialog } = useConfirm();

/* ------------------------------------------------------------------ */
/*  Sort (R49.1 — B003/B048)                                           */
/* ------------------------------------------------------------------ */

type SortKey = 'created_at' | 'recent_activity';

const SORT_KEY = 'ao-projects-sort';
const SORT_OPTIONS: SelectOption[] = [
  { value: 'created_at', label: '按创建时间' },
  { value: 'recent_activity', label: '按最近活跃' },
];

const sort = ref<SortKey>('created_at');

// 关注点: 在 onMounted 后从 localStorage 读, 避免 SSR/CSR mismatch — SPA 是 CSR only,
// 此处 hydrate 只为支持 reload 后保留用户上次偏好.
onMounted(() => {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved === 'created_at' || saved === 'recent_activity') {
      sort.value = saved;
    }
  } catch {
    // localStorage 不可用 (private mode / blocked) — 用默认.
  }
});

// sort 变更 → 写 localStorage + 重拉列表.
watch(sort, async (next) => {
  try {
    localStorage.setItem(SORT_KEY, next);
  } catch {
    // ignore
  }
  await projectsStore.load(true, next);
});

function onSortChange(v: string | null): void {
  if (v === 'created_at' || v === 'recent_activity') {
    sort.value = v;
  }
}

/* ------------------------------------------------------------------ */
/*  R70 inline panel state (LLM 配置 + 高级选项)                         */
/* ------------------------------------------------------------------ */

/** 互斥: 同时只允许展开一个项目的一种面板. 切换项目或切换类型时先关旧.
    关联 - master editingLlmProject / editingWikiProject 各为单 string|null,
    不是 set. master 没有 cross-mutex, 是因为一个项目内 editingLlmProject ===
    editingWikiProject 同时成立的 case 罕见. 本组件显式 mutex 防止同一项目同时
    展开两个 (UI 会占很多空间). */
const editingLlmProjectId = ref<string | null>(null);
const editingAdvancedProjectId = ref<string | null>(null);

function toggleLlmPanel(projectId: string): void {
  if (editingLlmProjectId.value === projectId) {
    editingLlmProjectId.value = null;
  } else {
    editingLlmProjectId.value = projectId;
    editingAdvancedProjectId.value = null;
  }
}
function toggleAdvancedPanel(projectId: string): void {
  if (editingAdvancedProjectId.value === projectId) {
    editingAdvancedProjectId.value = null;
  } else {
    editingAdvancedProjectId.value = projectId;
    editingLlmProjectId.value = null;
  }
}

/** R70: scope counts (running / reviewing / paused / total per scope key
    "{projectId}:{versionId}" 或 "{projectId}:" unversioned) — 卡片徽章
    数据源. 与 sidebar 共享同一 fetch endpoint (api/stats.ts getScopeCounts),
    各视图独立拉一次, 失败静默 -> 徽章不渲染. */
const scopeCounts = ref<Record<string, ScopeCounts>>({});

async function loadScopeCounts(force = false): Promise<void> {
  if (!force && Object.keys(scopeCounts.value).length > 0) return;
  try {
    scopeCounts.value = await getScopeCounts();
  } catch {
    // 静默失败 — 徽章不渲染, 不阻塞主流程.
  }
}

/** 项目级 task counts = 该项目所有 scope 累加 (running / reviewing / total),
    忽略 paused (用户主视线看运行态). key 前缀 = "{projectId}:". */
function projectTaskCounts(p: Project): ScopeCounts {
  const prefix = `${p.id}:`;
  const acc: ScopeCounts = { running: 0, reviewing: 0, paused: 0, total: 0 };
  for (const [key, counts] of Object.entries(scopeCounts.value)) {
    if (key.startsWith(prefix)) {
      acc.running += counts.running;
      acc.reviewing += counts.reviewing;
      acc.paused += counts.paused;
      acc.total += counts.total;
    }
  }
  return acc;
}

/** 已配 runner 条数 (server JSON 字符串 / array 兼容) — 给徽章用. */
function runnerCount(p: Project): number {
  const stored = p.runners;
  if (!stored) return 0;
  if (Array.isArray(stored)) return stored.length;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** R70: 面板保存/更新后父视图统一刷新: 项目列表 (advanced 改字段) +
   loadAllVersions (顺序/pinned 跟新) + scopeCounts (任务数理论上不动, 但保险). */
async function refreshAfterPanelUpdate(): Promise<void> {
  await projectsStore.load(true, sort.value);
  await projectsStore.loadAllVersions(true);
  await loadScopeCounts(true);
}

/* ------------------------------------------------------------------ */
/*  Pin toggle (R49.5 — B012, R49.6 — B060)                            */
/* ------------------------------------------------------------------ */

/** R49.5 (B012) UI + R49.6 (B060) handler — 乐观更新 + PATCH + 失败回滚.
    关注点: master projects-client.tsx:462-483 togglePin — 立即改 UI, 失败回滚.
    SPA 走 projectsStore.projects 直接覆盖数组 (ref<Project[]>) — 与 master
    setProjects((prev) => prev.map(...)) 同口径. PATCH 成功后 refetch 让顺序跟上
    (pinned 1 的项目 master line 467 总是排在前). */
async function togglePin(p: Project): Promise<void> {
  const currentPinned = p.pinned ?? 0;
  const next = currentPinned ? 0 : 1;
  // 乐观更新: 直接覆盖 store 数组, UI 立刻反馈.
  projectsStore.projects = projectsStore.projects.map((x) =>
    x.id === p.id ? { ...x, pinned: next } : x,
  );
  try {
    await apiUpdateProject(p.id, { pinned: next });
    // 成功后 refetch — 后端 listProjects 总是 ORDER BY pinned DESC, 顺序可能变.
    await projectsStore.load(true, sort.value);
  } catch {
    // 失败回滚: 把这条改回原值, 弹 toast.
    projectsStore.projects = projectsStore.projects.map((x) =>
      x.id === p.id ? { ...x, pinned: currentPinned } : x,
    );
    toast.error('置顶失败, 已回滚');
  }
}

/* ------------------------------------------------------------------ */
/*  Set current version (飞书 AO-DEV R6)                                */
/* ------------------------------------------------------------------ */

/** 飞书 AO-DEV R6 — 版本行「设为当前」按钮: PATCH /api/projects/[id]
    {current_version_id}（后端 updateProject 白名单早已支持, 此前只能命令行调）.
    关注点: 可逆操作(把另一行再点一遍就是改回), 不弹确认框; 乐观更新 + 失败
    回滚与 togglePin 同口径; 成功后 refetch projects 让「⭐ 当前: name」徽章
    跟着刷新（current_version_name 由后端 JOIN versions 返回）. */
async function setCurrentVersion(p: Project, v: Version): Promise<void> {
  if (v.id === p.current_version_id) return;
  const prevId = p.current_version_id ?? null;
  const prevName = p.current_version_name ?? null;
  projectsStore.projects = projectsStore.projects.map((x) =>
    x.id === p.id ? { ...x, current_version_id: v.id, current_version_name: v.name } : x,
  );
  try {
    await apiUpdateProject(p.id, { current_version_id: v.id });
    toast.success(`已将「${v.name}」设为当前版本`);
    await projectsStore.load(true, sort.value);
  } catch {
    projectsStore.projects = projectsStore.projects.map((x) =>
      x.id === p.id ? { ...x, current_version_id: prevId, current_version_name: prevName } : x,
    );
    toast.error('设为当前失败, 已回滚');
  }
}

/* ------------------------------------------------------------------ */
/*  Delete project (R49.7 — B013, R49.8 — B061)                        */
/* ------------------------------------------------------------------ */

/** R49.7 (B013) UI + R49.8 (B061) handler — ConfirmDialog 二次确认 + DELETE.
    关注点: master projects-client.tsx:488-510 deleteProject — setPendingConfirm 后
    onConfirm 异步调 DELETE, 失败 toast 报错. SPA 走 useConfirm().confirm() 命令式
    API (返回 Promise<boolean>) 省一个 ref 状态. master line 491-494 警告文案 +
    '数据保留在数据库中, 可通过数据库恢复' 是 SPA 也带的提示. */
async function deleteProject(p: Project): Promise<void> {
  const ok = await confirmDialog(
    '将隐藏该项目及其下所有版本和任务，从列表中消失。数据保留在数据库中，可通过数据库恢复。继续？',
    { title: '删除项目', type: 'danger', confirmText: '删除' },
  );
  if (!ok) return;
  try {
    await apiDeleteProject(p.id);
    toast.success(`项目「${p.name}」已删除`);
    await projectsStore.load(true, sort.value);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`删除项目失败: ${e.message}`);
    } else {
      toast.error('删除项目失败');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Version edit form (R49.11 — B016, R49.12 — B053)                   */
/* ------------------------------------------------------------------ */

const editingVersion = ref<string | null>(null);
// v513 (飞书 R172): 版本描述可编辑.
const editVersionDescription = ref<string>('');
const editFeishuUrl = ref<string>('');
const editFeishuSheet = ref<string>('');
/** v512: sheetwatch 开关. true = 自动派发扫这张飞书表; false = 跳过(停掉).
    默认 true —— 后端与 partner scripts/sheetwatch 都按'缺字段=启用'处理. */
const editVersionEnable = ref<boolean>(true);

/** R49.11 (B016) UI + R49.12 (B053) handler — 点编辑 → 展开折叠面板, 预填
    feishu_url + feishu_sheet. R49.13 接 saveEditVersion (PATCH /api/versions/[id]).
    关注点: master projects-client.tsx:1644-1649 — setEditingVersion + populate
    editFeishuUrl/editFeishuSheet. SPA 走 editingVersion: ref<string|null> 表达
    '哪条 version 在编辑态', null = 都不编辑. */
function startEditVersion(v: Version): void {
  editingVersion.value = v.id;
  editVersionDescription.value = v.description ?? '';
  editFeishuUrl.value = v.feishu_url ?? '';
  editFeishuSheet.value = v.feishu_sheet ?? '';
  editVersionEnable.value = v.enable !== 0;
}

function cancelEditVersion(): void {
  editingVersion.value = null;
  editVersionDescription.value = '';
  editFeishuUrl.value = '';
  editFeishuSheet.value = '';
  editVersionEnable.value = true;
}

/** R49.13 (B017) — PATCH /api/versions/[id] {feishu_url, feishu_sheet} 保存.
    关注点: master projects-client.tsx:446-460 updateVersionFeishu — trim + 空串
    转 null ('留空保存即清除绑定'). SPA 落地: 成功后 toast + cancelEditVersion
    + force reload 该项目版本列表 + refetch projects (current_version_name 可能
    不变但保险起见). 失败 toast 报错, 不动 UI (用户可改完再保存).
    v512: 一并 PATCH enable —— 勾掉 = 停掉此 version 的 sheetwatch 自动派发. */
async function saveEditVersion(v: Version): Promise<void> {
  try {
    await apiUpdateVersion(v.id, {
      description: editVersionDescription.value.trim() || null,
      feishu_url: editFeishuUrl.value.trim() || null,
      feishu_sheet: editFeishuSheet.value.trim() || null,
      enable: editVersionEnable.value,
    });
    toast.success(
      editVersionEnable.value
        ? `版本「${v.name}」飞书绑定已更新`
        : `版本「${v.name}」已保存, 自动派发已关闭`,
    );
    cancelEditVersion();
    await projectsStore.loadAllVersions(true);
    await projectsStore.load(true, sort.value);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`保存失败: ${e.message}`);
    } else {
      toast.error('保存失败');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  New version toggle (R49.15 — B021)                                 */
/* ------------------------------------------------------------------ */

/** R49.15 (B021) — 版本列表底部 '+ 新建版本' 按钮 → 切换内联表单.
    关注点: master projects-client.tsx:1763 setCreating('version') + newProjectId —
    一份表单 state 复用到所有项目, 通过 newProjectId 标记哪条在编辑.
    SPA 走 newVersionProjectId: ref<string|null>, null = 都关闭, 项目 id = 该项目表单展开.
    R49.16 加 name/feishu_url/feishu_sheet inputs, R49.17 接 submit handler. */
const newVersionProjectId = ref<string | null>(null);

function toggleNewVersionForm(projectId: string): void {
  newVersionProjectId.value =
    newVersionProjectId.value === projectId ? null : projectId;
}

/** R49.17 (B023) — 创建成功后刷新 (表单本体在 NewVersionForm 组件内,
    R172 迭代抽出供 ProjectsView + ProjectDetailView 两处共用). */
async function onNewVersionCreated(): Promise<void> {
  newVersionProjectId.value = null;
  await projectsStore.loadAllVersions(true);
  await projectsStore.load(true, sort.value);
}

function versionsOf(projectId: string): Version[] {
  return projectsStore.versionsByProject[projectId] ?? [];
}

/* ------------------------------------------------------------------ */
/*  Version delete (R49.14 — B018/B063)                                */
/* ------------------------------------------------------------------ */

/** R49.14 (B018/B063) — ConfirmDialog 二次确认 + DELETE /api/versions/[id].
    关注点: master projects-client.tsx:512-534 deleteVersion — setPendingConfirm 后
    onConfirm 异步调 DELETE. SPA 走命令式 useConfirm().confirm() (同 R49.8 deleteProject
    同口径). 成功后 toast + loadAllVersions(true) + load projects refetch (current
    version 可能变了). */
async function deleteVersion(v: Version): Promise<void> {
  const ok = await confirmDialog(
    '将隐藏该版本及其下所有任务，从列表中消失。数据保留在数据库中，可通过数据库恢复。继续？',
    { title: '删除版本', type: 'danger', confirmText: '删除' },
  );
  if (!ok) return;
  try {
    await apiDeleteVersion(v.id);
    toast.success(`版本「${v.name}」已删除`);
    if (editingVersion.value === v.id) cancelEditVersion();
    await projectsStore.loadAllVersions(true);
    await projectsStore.load(true, sort.value);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`删除版本失败: ${e.message}`);
    } else {
      toast.error('删除版本失败');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Project templates (R49.2 — B004)                                   */
/* ------------------------------------------------------------------ */

const projectTemplates = ref<ProjectTemplate[]>([]);
const showTemplatePicker = ref<boolean>(false);
const templateHint = ref<string>('');

async function loadTemplates(): Promise<void> {
  if (projectTemplates.value.length > 0) return;
  projectTemplates.value = await listProjectTemplates();
}

onMounted(() => {
  void loadTemplates();
});

function toggleTemplatePicker(): void {
  showTemplatePicker.value = !showTemplatePicker.value;
}

function applyProjectTemplate(t: ProjectTemplate): void {
  createForm.name = t.project?.name ?? t.id;
  createForm.description = t.project?.description ?? t.description ?? '';
  if (t.project?.cwd) {
    createForm.cwd = t.project.cwd;
    createForm.ports = '';
  }
  templateHint.value =
    t.id === 'requirement-collab'
      ? '（记得建 version 时填 feishu_url + feishu_sheet）'
      : t.id === 'long-running-dev'
        ? '（建完后看 19-templates.md §长跑开发 手动建 dev/test 角色 + DAG 任务）'
        : '';
  createOpen.value = true;
  showTemplatePicker.value = false;
  toast.success(`已预填 ${t.icon ?? '📦'} ${t.name} 模板`);
}

/* ------------------------------------------------------------------ */
/*  Create modal state                                                  */
/* ------------------------------------------------------------------ */

interface CreateFormState {
  name: string;
  description: string;
  cwd: string;
  ports: string; // 逗号分隔, 提交前 split → number[] (master 接受两种格式)
}

const EMPTY_CREATE: CreateFormState = {
  name: '',
  description: '',
  cwd: '',
  ports: '',
};

const createOpen = ref<boolean>(false);
const createForm = reactive<CreateFormState>({ ...EMPTY_CREATE });
const creating = ref<boolean>(false);
const pickingPorts = ref<boolean>(false);

/** R41-C1 一键提示: 创建成功后弹 toast + 跳项目详情 (R17 已挂路由), 让用户在项目详情内 + 版本. */
const pendingProjectId = ref<string | null>(null);

/** R49.4 (B009): 调 GET /api/port-pool/available?n=5, 拿前 N 个可用端口回填到 ports 输入框.
    关注点: 后端返 {available: number[]}, 失败 (网络/HTTP) toast 报错 + 不动 ports;
    返回空数组弹「端口池已无可用端口」. */
async function autoPickPorts(): Promise<void> {
  pickingPorts.value = true;
  try {
    const list = await listAvailablePorts(5);
    if (list.length === 0) {
      toast.error('端口池已无可用端口, 请联系 admin 扩容');
      return;
    }
    createForm.ports = list.join(', ');
    toast.success(`已选 ${list.length} 个可用端口: ${list.join(', ')}`);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`自动选端口失败: ${e.message}`);
    } else {
      toast.error('自动选端口失败');
    }
  } finally {
    pickingPorts.value = false;
  }
}

function openCreate(): void {
  Object.assign(createForm, EMPTY_CREATE);
  templateHint.value = '';
  createOpen.value = true;
}

function closeCreate(): void {
  if (creating.value) return;
  createOpen.value = false;
}

function validateCreate(f: CreateFormState): string | null {
  if (!f.name.trim()) return '请填写项目名';
  if (f.ports.trim()) {
    const parts = f.ports.split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        return `端口 "${p}" 非法: 需 1024-65535 整数`;
      }
    }
  }
  return null;
}

async function submitCreate(): Promise<void> {
  const err = validateCreate(createForm);
  if (err) {
    toast.error(err);
    return;
  }
  creating.value = true;
  const body: CreateProjectBody = { name: createForm.name.trim() };
  if (createForm.description.trim()) body.description = createForm.description.trim();
  if (createForm.cwd.trim()) body.cwd = createForm.cwd.trim();
  if (createForm.ports.trim()) {
    body.ports = createForm.ports
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((n) => Number.isInteger(n));
  }
  try {
    const created: Project = await createProject(body);
    toast.success(`项目「${created.name}」已创建`);
    pendingProjectId.value = created.id;
    closeCreate();
    // 重拉列表 (强制刷新 store, 排除缓存)
    void projectsStore.load(true, sort.value);
    // 一键跳项目详情 — 用户在 R17 详情页内可继续 + 版本 (与 master ProjectsClient
    // 创建后跳 selectedId + scrollIntoView 同口径; SPA 路由形态 1:1).
    await router.push(`/projects/${created.id}`);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || `创建失败 (HTTP ${e.status})`);
    } else if (e instanceof Error) {
      toast.error(`网络异常: ${e.message}`);
    } else {
      toast.error('创建失败');
    }
  } finally {
    creating.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Derived                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Search (客户端 includes 过滤, 不打后端 — 列表小/搜索瞬时)             */
/* ------------------------------------------------------------------ */

const searchText = ref<string>('');

/** 匹配范围: name + description + cwd + 各版本名 — 卡片上所有可见文本字段.
    关注点: 纯客户端 computed, 无 debounce / 无 URL 同步 — 项目列表通常 < 100
    项, includes() 即时返回, 不增加 localStorage 噪声 (与 sort 持久化相反 —
    sort 是偏好, search 是瞬时动作). */
const filteredProjects = computed<Project[]>(() => {
  const q = searchText.value.trim().toLowerCase();
  if (!q) return projectsStore.projects;
  return projectsStore.projects.filter((p) => {
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.description && p.description.toLowerCase().includes(q)) return true;
    if (p.cwd && p.cwd.toLowerCase().includes(q)) return true;
    const versions = versionsOf(p.id);
    for (const v of versions) {
      if (v.name.toLowerCase().includes(q)) return true;
    }
    return false;
  });
});

/** 过滤态计数: 有搜索词时显示 "X / Y", 直观告诉用户筛掉了多少. */
const projects = computed<Project[]>(() => filteredProjects.value);
const isSearching = computed<boolean>(() => searchText.value.trim().length > 0);

function clearSearch(): void {
  searchText.value = '';
}

function onRetry(): void {
  void projectsStore.load(true, sort.value);
}

/* ------------------------------------------------------------------ */
/*  v532: 已归档区块 — 侧栏右键「归档」的项目在列表页可见 / 恢复 / 删除.  */
/* ------------------------------------------------------------------ */
/* 归档 ≠ 删除: 归档项目数据完整, 主列表不显示但这里可一键恢复;
   删除 = 级联软删 (项目+版本+任务全 deleted_at), ConfirmDialog 二次确认. */
const archivedOpen = ref(false);
const archivedList = computed<Project[]>(() => projectsStore.archivedProjects);

function toggleArchivedOpen(): void {
  archivedOpen.value = !archivedOpen.value;
  // force=true: 恢复/归档动作后重进页面要拿最新列表 (store 有缓存默认跳过).
  if (archivedOpen.value) void projectsStore.loadArchived(true);
}

async function unarchiveProject(p: Project): Promise<void> {
  try {
    await projectsStore.unarchiveProject(p.id);
    toast.success(`已恢复「${p.name}」`);
  } catch {
    toast.error('恢复失败, 已回滚');
  }
}

async function deleteArchivedProject(p: Project): Promise<void> {
  const ok = await confirmDialog(
    '将隐藏该项目及其下所有版本和任务，从列表中消失。数据保留在数据库中，可通过数据库恢复。继续？',
    { title: `删除项目「${p.name}」`, type: 'danger', confirmText: '删除' },
  );
  if (!ok) return;
  try {
    await apiDeleteProject(p.id);
    projectsStore.removeProjectLocally(p.id);
    toast.success(`项目「${p.name}」已删除`);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`删除项目失败: ${e.message}`);
    } else {
      toast.error('删除项目失败');
    }
  }
}

onMounted(() => {
  // 静默预拉归档列表 (徽章数字要显示). 失败 = 分组不显示, 不阻塞主列表.
  void projectsStore.loadArchived();
});

function projectMetaText(p: Project): string {
  const parts: string[] = [];
  if (p.cwd) parts.push(p.cwd);
  // p.ports 来自 master listProjects 的 DB 列 (JSON 字符串如 "[13001,13002]"),
  // 跟 ProjectDetailView.formatPorts 同款兼容 string / number[] / null. master
  // 这边没解析, 我们读端不能假设一定是数组.
  if (p.ports != null) {
    let arr: number[];
    if (Array.isArray(p.ports)) arr = p.ports;
    else if (typeof p.ports === 'string') {
      const s = p.ports.trim();
      try {
        const parsed = s.startsWith('[') ? JSON.parse(s) : s.split(',');
        arr = Array.isArray(parsed) ? parsed.map((x) => Number(x)).filter(Number.isFinite) : [];
      } catch { arr = []; }
    } else arr = [];
    if (arr.length > 0) parts.push(`端口 ${arr.join('/')}`);
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                           */
/* ------------------------------------------------------------------ */

onMounted(() => {
  void projectsStore.load(true, sort.value);
  void projectsStore.loadAllVersions(false);
  void loadScopeCounts();
});
</script>

<template>
  <div class="projects-view">
    <header class="page-header">
      <div class="header-text">
        <h2 class="page-title">项目</h2>
        <p class="muted subtitle">
          管理你的 agent 项目. 每个项目绑定一个工作目录, 任务在该目录下执行.
        </p>
      </div>
      <div class="header-meta">
        <div class="sort-group">
          <span class="sort-label">排序</span>
          <Select
            :model-value="sort"
            :options="SORT_OPTIONS"
            placeholder="请选择"
            class-name="sort-select"
            @change="onSortChange"
          />
        </div>
        <span class="meta-count">
          <template v-if="isSearching">匹配 {{ projects.length }} / {{ projectsStore.projects.length }}</template>
          <template v-else>共 {{ projects.length }} 个项目</template>
        </span>
        <router-link to="/settings" class="quick-link" title="设置">⚙️ 设置</router-link>
        <router-link to="/import" class="quick-link" title="批量导入">
          批量导入
        </router-link>
        <div v-if="projectTemplates.length > 0" class="template-wrap">
          <button
            type="button"
            class="quick-link"
            :title="'从 docs/project-templates/ 选一套模板预填'"
            @click="toggleTemplatePicker"
          >
            📦 从模板建 ▾
          </button>
          <div v-if="showTemplatePicker" class="template-dropdown">
            <div
              v-for="t in projectTemplates"
              :key="t.id"
              class="template-item"
              role="button"
              tabindex="0"
              @click="applyProjectTemplate(t)"
              @keydown.enter="applyProjectTemplate(t)"
            >
              <div class="template-name">
                {{ t.icon ?? '📦' }} {{ t.name }}
                <span
                  v-if="t.estimated_minutes != null"
                  class="template-eta"
                >
                  ~{{ t.estimated_minutes }}min
                </span>
              </div>
              <div class="template-desc">{{ t.description }}</div>
            </div>
          </div>
        </div>
        <Button variant="primary" size="sm" @click="openCreate">+ 新建项目</Button>
      </div>
    </header>

    <div class="search-bar">
      <Input
        v-model="searchText"
        placeholder="搜索项目名 / 描述 / cwd / 版本名…"
        clearable
        class-name="projects-search-input"
      />
    </div>

    <div v-if="projectsStore.loading && projects.length === 0" class="state-block">
      <p class="muted">加载中…</p>
    </div>

    <div v-else-if="projectsStore.error" class="state-block">
      <p class="form-error">{{ projectsStore.error }}</p>
      <Button size="sm" variant="secondary" :loading="projectsStore.loading" @click="onRetry">
        重试
      </Button>
    </div>

    <div v-else-if="projects.length === 0" class="empty-block">
      <template v-if="isSearching">
        <p class="muted empty-title">没有匹配的项目</p>
        <p class="muted empty-hint">
          搜索「{{ searchText }}」无结果.
          <button type="button" class="link-btn" @click="clearSearch">清除搜索</button>
        </p>
      </template>
      <template v-else>
        <p class="muted empty-title">还没有项目</p>
        <p class="muted empty-hint">点右上角「+ 新建项目」创建第一个项目</p>
      </template>
    </div>

    <div v-else class="project-list">
      <div
        v-for="p in projects"
        :key="p.id"
        :class="[
          'card',
          'project-item',
          p.pinned === 1 ? 'is-pinned' : '',
        ]"
      >
        <div class="project-row">
          <div class="project-main">
            <div class="project-name">
              <span v-if="p.pinned === 1" class="pin-badge" title="已置顶">📌</span>
              {{ p.name }}
            </div>
            <div v-if="p.description" class="muted project-desc">{{ p.description }}</div>
            <div v-if="projectMetaText(p)" class="muted project-meta">
              {{ projectMetaText(p) }}
            </div>
            <!-- R70: 项目级徽章 (版本数 / 任务计数 / 并发 / 超时 / 当前版本) -->
            <div class="project-badges">
              <span class="project-badge muted">{{ versionsOf(p.id).length }} 个版本</span>
              <template v-if="projectTaskCounts(p).total > 0">
                <span v-if="projectTaskCounts(p).running > 0" class="project-badge project-badge-running">
                  {{ projectTaskCounts(p).running }} 运行
                </span>
                <span v-if="projectTaskCounts(p).reviewing > 0" class="project-badge project-badge-reviewing">
                  {{ projectTaskCounts(p).reviewing }} 审核
                </span>
                <span class="project-badge muted">{{ projectTaskCounts(p).total }} 个任务</span>
              </template>
              <template v-else>
                <span class="project-badge muted">0 个任务</span>
              </template>
              <span
                v-if="(p.parallel_limit ?? 1) > 1"
                class="project-badge project-badge-warn"
                :title="'本项目共享同一工作目录的任务可并发数'"
              >⚡ 同目录并发 {{ p.parallel_limit }}</span>
              <span
                v-if="runnerCount(p) > 0"
                class="project-badge project-badge-warn"
                :title="`已配 ${runnerCount(p)} 个 runner entry (高级选项 · Runners)`"
              >🛰️ {{ runnerCount(p) }} runners</span>
              <span
                v-if="p.timeout_minutes != null"
                class="project-badge project-badge-warn"
                :title="'本项目任务的壁钟超时(覆盖全局默认)'"
              >⏱ 超时 {{ p.timeout_minutes }}min</span>
              <span
                v-if="p.current_version_name"
                class="project-badge project-badge-current"
              >⭐ 当前: {{ p.current_version_name }}</span>
            </div>
          </div>
          <div class="project-actions">
            <button
              type="button"
              :class="['icon-btn', p.pinned === 1 ? 'is-active' : '']"
              :title="p.pinned === 1 ? '取消置顶' : '置顶到顶部'"
              @click="togglePin(p)"
            >
              {{ p.pinned === 1 ? '📌 已置顶' : '📌 置顶' }}
            </button>
            <button
              type="button"
              :class="['icon-btn', editingLlmProjectId === p.id ? 'is-active' : '']"
              title="项目级 LLM 配置 (可多份)"
              @click="toggleLlmPanel(p.id)"
            >
              📡 LLM 配置
            </button>
            <button
              type="button"
              :class="['icon-btn', editingAdvancedProjectId === p.id ? 'is-active' : '']"
              title="高级选项：同目录并发上限 + 任务超时 + 端口 + wiki 可读取的文件类型 + runners"
              @click="toggleAdvancedPanel(p.id)"
            >
              ⚙️ 高级选项
            </button>
            <button
              type="button"
              class="icon-btn icon-btn-danger"
              title="删除项目"
              @click="deleteProject(p)"
            >
              删除
            </button>
          </div>
        </div>

        <div class="version-list">
          <div v-for="v in versionsOf(p.id)" :key="v.id" class="version-row">
            <div class="version-head">
              <span class="version-current">{{ v.id === p.current_version_id ? '⭐' : '' }}</span>
              <router-link
                :to="`/projects/${p.id}/versions/${v.id}`"
                class="version-name"
              >
                {{ v.name }}
              </router-link>
              <!-- v513 (飞书 R172): 版本描述（「版本干啥的」）小字展示 -->
              <span
                v-if="v.description"
                class="version-desc"
                :title="v.description"
              >{{ v.description }}</span>
              <span
                v-if="v.feishu_url"
                class="version-feish-badge"
                :title="`飞书: ${v.feishu_url}`"
              >
                🔗
              </span>
              <!-- R176 (飞书): 正向标志 — enable=1(或缺字段按 1)也显示"自动派发中",
                   让"是否激活"一眼可见, 不再只有关闭态才有标记. -->
              <span
                v-if="v.feishu_url && v.enable !== 0"
                class="version-watch-on"
                title="sheetwatch 自动派发已开启 — 这张飞书表的改动会自动派任务"
              >
                自动派发中
              </span>
              <span
                v-if="v.feishu_url && v.enable === 0"
                class="version-watch-off"
                title="自动派发已关闭 — sheetwatch 不会扫这张飞书表"
              >
                自动派发已关
              </span>
              <span v-if="v.is_released === 1" class="version-stable">stable</span>
              <!-- R176 迭代 (飞书): 编辑/删除推到行尾 + 适当隔开, 不再挤在
                   徽章后面 (damo: 「编辑 和 +任务 尽量都放在尾部，适当隔开，
                   而不是一个在中间」— 详情页 +任务 已在尾部, 此处对齐). -->
              <div v-if="editingVersion !== v.id" class="version-head-actions">
                <!-- 飞书 AO-DEV R6: 非当前版本给「设为当前」— 点击 PATCH
                     current_version_id, ⭐ 标记 + 项目徽章随之刷新. -->
                <button
                  v-if="v.id !== p.current_version_id"
                  type="button"
                  class="icon-btn-small"
                  title="设为当前版本 — 新建任务默认预填此版本"
                  @click="setCurrentVersion(p, v)"
                >
                  设为当前
                </button>
                <button
                  type="button"
                  class="icon-btn-small"
                  @click="startEditVersion(v)"
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="icon-btn-small icon-btn-danger"
                  @click="deleteVersion(v)"
                >
                  删除
                </button>
              </div>
            </div>
            <div v-if="editingVersion === v.id" class="version-edit">
              <div class="version-edit-row">
                <Input
                  v-model="editFeishuUrl"
                  placeholder="飞书 sheet URL"
                  class-name="version-edit-input"
                />
                <Input
                  v-model="editFeishuSheet"
                  placeholder="Sheet2"
                  class-name="version-edit-sheet"
                />
              </div>
              <div class="version-edit-row">
                <Checkbox
                  v-model="editVersionEnable"
                  label="开启 sheetwatch 自动派发（关掉后这张表改了也不会自动派任务）"
                />
              </div>
              <div class="version-edit-row">
                <Input
                  v-model="editVersionDescription"
                  placeholder="版本干啥的（可选）"
                />
              </div>
              <div class="version-edit-actions">
                <Button size="sm" @click="saveEditVersion(v)">保存</Button>
                <Button size="sm" variant="secondary" @click="cancelEditVersion">
                  取消
                </Button>
                <span class="muted version-edit-hint">留空保存即清除绑定</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            class="version-new-toggle"
            @click="toggleNewVersionForm(p.id)"
          >
            + 新建版本
          </button>
          <div v-if="newVersionProjectId === p.id">
            <NewVersionForm
              :project-id="p.id"
              @created="onNewVersionCreated"
              @cancel="newVersionProjectId = null"
            />
          </div>
        </div>

        <!-- R70: inline-expand 面板 (LLM 配置 + 高级选项). 互斥: 同时只一个展开.
             镜像 master src/app/projects-client.tsx editingLlmProject +
             editingWikiProject 同款 inline 模式. -->
        <ProjectLlmConfigPanel
          :project-id="p.id"
          :open="editingLlmProjectId === p.id"
          @close="editingLlmProjectId = null"
          @updated="refreshAfterPanelUpdate"
        />
        <ProjectAdvancedOptionsPanel
          :project="p"
          :open="editingAdvancedProjectId === p.id"
          @close="editingAdvancedProjectId = null"
          @updated="refreshAfterPanelUpdate"
        />
      </div>
    </div>

    <!-- v532: 已归档区块 — 与活跃列表视觉分层 (虚线分隔 + 弱化行). 恢复按钮
        走 store.unarchiveProject (PATCH archived:0 + 回活跃列表); 删除走
        ConfirmDialog 二次确认 + 级联软删, 与卡片删除按钮同文案. -->
    <div v-if="archivedList.length" class="archived-section">
      <button type="button" class="archived-toggle" :aria-expanded="archivedOpen" @click="toggleArchivedOpen">
        {{ archivedOpen ? '▼' : '▶' }} 🗂 已归档 ({{ archivedList.length }})
      </button>
      <div v-if="archivedOpen" class="archived-items">
        <div v-for="p in archivedList" :key="p.id" class="archived-item">
          <div class="archived-item-name">
            {{ p.name }}
          </div>
          <div class="muted archived-item-desc">{{ p.description || '无描述' }}</div>
          <div class="archived-item-actions">
            <button type="button" class="icon-btn" title="恢复到主列表" @click="unarchiveProject(p)">
              📤 恢复
            </button>
            <button type="button" class="icon-btn icon-btn-danger" title="删除项目" @click="deleteArchivedProject(p)">
              删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- R41-C1: 新建项目 modal -->
    <Modal
      :model-value="createOpen"
      title="新建项目"
      size="md"
      @update:model-value="(v: boolean) => { if (!v) closeCreate(); }"
    >
      <div class="create-form">
        <div class="form-row">
          <label class="form-label">项目名 <span class="required">*</span></label>
          <Input v-model="createForm.name" placeholder="例如: 智能体中台" :disabled="creating" />
        </div>
        <div class="form-row">
          <label class="form-label">描述（可选）</label>
          <Textarea
            v-model="createForm.description"
            :rows="2"
            placeholder="给项目的备注"
            :disabled="creating"
          />
        </div>
        <div class="form-row">
          <label class="form-label">工作目录 cwd（可选）</label>
          <Input
            v-model="createForm.cwd"
            placeholder="/path/to/project"
            class-name="form-mono"
            :disabled="creating"
          />
          <p class="form-hint">任务的执行根目录。留空 = 自动用 <code>~/.agent-orchestrator/projects/<项目 id></code>。</p>
        </div>
        <div class="form-row">
          <label class="form-label">端口（可选）</label>
          <div class="port-row">
            <Input
              v-model="createForm.ports"
              placeholder="例如: 13001, 13002"
              class-name="form-mono port-input"
              :disabled="creating"
            />
            <Button
              size="sm"
              variant="secondary"
              :loading="pickingPorts"
              :disabled="creating"
              @click="autoPickPorts"
            >
              🎯 自动选可用
            </Button>
          </div>
          <p class="form-hint">逗号分隔, 1024-65535, 最多 5 个. 默认端口池由平台分配.</p>
        </div>
        <p v-if="templateHint" class="form-hint form-hint-emphasis">
          {{ templateHint }}
        </p>
        <p v-else class="form-hint form-hint-emphasis">
          创建后可一键建 v1.0 版本（在项目详情页点「+ 新建版本」）.
        </p>
      </div>

      <template #footer>
        <Button variant="secondary" :disabled="creating" @click="closeCreate">取消</Button>
        <Button :loading="creating" :disabled="creating" @click="submitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.projects-view {
  padding: 18px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}
.header-text { min-width: 0; width: 100%; }
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  /* R??: header-text 与 header-meta 同 row 时 h2 会被挤到 0 宽, 中文字符按字
     宽断行. 改 column 方向后 header-text 独占一行, 但 vw 缩到 <700px 时
     父容器 960px max-width 容纳 18 字"管理你的 agent 项目..." 仍会折行 —
     nowrap 兜底, 强制单行 (超长会撑出滚动, 比折行美观). */
  white-space: nowrap;
}
.subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
/* R??: 旧版 @ ≤1023px 改 column, 现 column 已成默认, media 仅保留
   header-meta 自适应 wrap (搜索框挪出后此处只剩 6 个控件, wrap 主要是
   给窄屏做兜底). */
/* R59+: header-meta 内所有交互元素统一 30px (跟 Button / .quick-link /
   .sort-select 等同档). 之前 font 12px + padding 3px 10px 自然高 ~20-22px,
   比 Button 30px 矮. 现在 inline-flex + height:30px + padding:0 12px +
   align-items:center, 文本垂直居中. */
.meta-count {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: var(--color-bg-elevated);
  border-radius: 999px;
  box-sizing: border-box;
}

.sort-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sort-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
:deep(.sort-select) {
  width: 130px;
}
/* R59+: header-meta 内 Select 触发器对齐 30px 档 — Select 默认 trigger
   是 font 14 + padding 7px 10px ~36px 高, 比 Button 30px 高出 10px, 同 row
   flex 错位. 通过 class-name="sort-select" 注入, 只在 header-meta 内
   这一个 Select 上覆盖, 其他视图 Select 不受影响. */
:deep(.sort-select .select-trigger) {
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.2;
  height: 30px;
  box-sizing: border-box;
}

/* 项目搜索: 独立行, 跨满 960px 内容宽, 不挤 header 标题. 复用 Input.vue,
   通过 class-name 注入 30px 高度, 跟其他 header-meta 控件同档视觉对齐. */
.search-bar {
  width: 100%;
  max-width: 360px;
}
:deep(.projects-search-input) {
  width: 100%;
}
:deep(.projects-search-input input) {
  height: 30px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.2;
  box-sizing: border-box;
}
.link-btn {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: underline;
}
.link-btn:hover {
  color: var(--color-primary-hover, #1d4ed8);
}

.template-wrap {
  position: relative;
}
.template-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  width: 280px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
  max-height: 360px;
  overflow-y: auto;
  z-index: 30;
}
.template-item {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background 0.15s;
}
.template-item:hover {
  background: var(--color-bg-elevated);
}
.template-item:last-child {
  border-bottom: 0;
}
.template-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.template-eta {
  margin-left: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 400;
}
.template-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}

/* R59+: header-meta 内所有交互元素统一 30px (跟 Button.vue 默认 +
   .sort-select / .meta-count 同档). 之前 5px 10px / 13px 自然高 ~24-28px
   (用户反馈「批量导入 设置 都是 28 高度」). 现在 4px 10px / 12px +
   min-height 30 + box-sizing border-box, 视觉齐. */
.quick-link {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  min-height: 30px;
  box-sizing: border-box;
  color: var(--color-text);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.quick-link:hover {
  border-color: var(--color-primary);
  background: var(--color-bg-elevated);
}

.muted { color: var(--color-text-muted); }
.form-error {
  color: var(--tw-red-700);
  font-size: 13px;
  margin: 0 0 8px;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 16px;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 64px 16px;
}
.empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}
.empty-hint {
  margin: 0;
  font-size: 12px;
}

.project-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}
.project-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.project-item:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}
.project-item.is-pinned {
  border-color: var(--tw-amber-400);
  box-shadow: 0 0 0 1px var(--tw-amber-200) inset;
}

.project-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
}
.project-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.project-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: 4px;
}
.pin-badge { font-size: 13px; }
.project-desc {
  font-size: 12px;
  line-height: 1.5;
}
.project-meta {
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* R70: 项目级徽章行 (版本数 / 任务计数 / 并发 / 超时 / 当前版本).
   flex-wrap: 窄屏自动 wrap; gap 跟 master text-xs gap-3 同款节奏. */
.project-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.project-badge {
  display: inline-block;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
.project-badge-running {
  color: var(--tw-blue-600);
}
.project-badge-reviewing {
  background: var(--tw-purple-100);
  color: var(--tw-violet-600);
  border-radius: 999px;
  padding: 0 6px;
  font-weight: 600;
  font-size: 10px;
}
.project-badge-warn {
  color: var(--tw-amber-700);
}
.project-badge-current {
  color: var(--color-primary);
}

.project-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.project-item:hover .project-actions {
  opacity: 1;
}
.icon-btn {
  background: transparent;
  border: 0;
  padding: 2px 6px;
  font-size: 11.5px;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius);
}
.icon-btn:hover {
  background: var(--color-bg);
  color: var(--color-text);
}
.icon-btn.is-active {
  color: var(--tw-amber-600);
  font-weight: 500;
}
.icon-btn.is-active:hover {
  color: var(--tw-amber-700);
}
.icon-btn-danger:hover {
  color: var(--tw-red-600);
  background: var(--tw-red-50);
}

.icon-btn-small {
  background: transparent;
  border: 0;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius);
}
.icon-btn-small:hover {
  color: var(--color-text);
  background: var(--color-bg);
}
.icon-btn-small.icon-btn-danger:hover {
  color: var(--tw-red-600);
  background: var(--tw-red-50);
}

.version-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0 0;
  border-top: 1px dashed var(--color-border);
}
.version-row {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
}
.version-row:last-child {
  border-bottom: 0;
}
.version-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
/* R176 迭代 (飞书): 编辑/删除按钮组 — 锁行尾 + 内部适当隔开 (gap 8),
   与左侧徽章串分离, 不再挤成一团. */
.version-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.version-current {
  width: 16px;
  font-size: 12px;
}
.version-name {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  color: var(--color-text);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* v513 (飞书 R172): 版本描述小字 */
.version-desc {
  max-width: 280px;
  font-size: 11px;
  color: var(--color-text-secondary, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.version-name:hover {
  color: var(--color-primary);
}
.version-feish-badge {
  font-size: 12px;
}
.version-stable {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--tw-green-100);
  color: var(--tw-green-700);
  border-radius: 999px;
}
/* v512: 自动派发已关 —— 与 stable 绿徽章同款胶囊, 用琥珀色表"注意但非错误" */
.version-watch-off {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--tw-amber-100);
  color: var(--tw-amber-700);
  border-radius: 999px;
  cursor: help;
}

/* R176: 正向激活标志 — 与 .version-watch-off 对偶, 绿色. */
.version-watch-on {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--tw-green-100);
  color: var(--tw-green-700);
  border-radius: 999px;
  cursor: help;
}

.version-edit {
  background: var(--color-bg);
  border-radius: var(--radius);
  padding: 8px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.version-edit-row {
  display: flex;
  gap: 6px;
}
:deep(.version-edit-input) {
  flex: 1;
}
:deep(.version-edit-sheet) {
  width: 110px;
}
.version-edit-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-edit-hint {
  font-size: 11px;
}

.version-new-toggle {
  margin-top: 6px;
  background: transparent;
  border: 0;
  padding: 6px 0;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  text-align: left;
}
.version-new-toggle:hover {
  color: var(--color-primary);
}

/* version-new 表单样式已迁 NewVersionForm.vue (R172 迭代抽出共用) */

.create-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-label {
  font-size: 13px;
  color: var(--color-text);
}
.required { color: var(--tw-red-600); margin-left: 2px; }
.form-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}
.form-hint-emphasis {
  padding: 8px 10px;
  background: var(--tw-blue-50);
  border: 1px solid var(--tw-blue-200);
  border-radius: var(--radius);
  color: var(--tw-blue-800);
}

.port-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
:deep(.port-input) {
  flex: 1;
}
:deep(.form-mono input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* v532: 已归档区块 — 虚线分隔 + 弱化配色, 与活跃卡片视觉分层. */
.archived-section {
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
}
.archived-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius);
}
.archived-toggle:hover {
  background: var(--tw-gray-100);
}
.archived-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.archived-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
}
.archived-item-name {
  font-weight: 600;
  min-width: 160px;
}
.archived-item-desc {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.archived-item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
