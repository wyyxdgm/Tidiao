<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useProjectsStore } from '@/stores/projects';
import { deleteProject as apiDeleteProject, type Project } from '@/api/projects';
import { useTagsStore } from '@/stores/tags';
import { useAuthStore } from '@/stores/auth';
import AccountSwitcher from '@/components/AccountSwitcher.vue';
import { useConfirm } from '@/components/ConfirmDialog.vue';
import { useToast } from '@/composables/useToast';
import { getScopeCounts, type ScopeCounts } from '@/api/stats';
import { get } from '@/api/http';
import { resolveProjectExpanded } from '@/lib/resolve-project-expanded';
import { useSidebarDrawer } from '@/composables/useSidebarDrawer';
import { useTaskEventSource, type GlobalEvent } from '@/composables/useTaskEventSource';

const projects = useProjectsStore();
const tags = useTagsStore();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const { drawerOpen, toggleDrawer, closeDrawer } = useSidebarDrawer();
const toast = useToast();
const { confirm: confirmDialog } = useConfirm();
const { t } = useI18n();

/* R59+ fix: H5 (≤1023px) drawer 必须展示完整项目列表 — 之前 v-if="collapsed"
   在 H5 + collapsed=true (用户桌面端曾点过 ◀ 收起, localStorage 写
   nav-sidebar-collapsed=1, 同浏览器切到手机/平板后状态被恢复) 时, v-else
   展开态 aside 整个不渲染, drawer 在 DOM 里没有内容 → 用户反馈「左侧
   侧栏显示不了? 我点左上角 3 条线」. 修复: H5 下忽略 collapsed, 强制走
   v-else 路径; 桌面端保留 R56-B14 折叠态行为不变. localStorage 值不动 —
   桌面用户跨设备同步状态时仍看到自己之前选的折叠态.

   matchMedia 跨断点监听 (只在 ≤1023px 切换时触发, 比 resize 监听性能好),
   isMobile 在 setup 阶段同步初始化 (matchMedia 是同步 API), template 立即可用. */
const isMobile = ref<boolean>(
  typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 1023px)').matches,
);
const mobileMql =
  typeof window !== 'undefined'
    ? window.matchMedia('(max-width: 1023px)')
    : null;
if (mobileMql) {
  const onChange = (e: MediaQueryListEvent): void => {
    isMobile.value = e.matches;
  };
  mobileMql.addEventListener('change', onChange);
  onBeforeUnmount(() => {
    mobileMql.removeEventListener('change', onChange);
  });
}

/* R59: 镜像 master NavigationTree.tsx 的 userExpanded + auto-expand 拆分.
   userExpanded 记用户显式偏好 (没动过的项目 = 没 key). 没 key 的项目在当前
   路由命中时自动展开 — 这样用户主动折叠后不会被 auto-expand 拽回去
   ("页面激活态下菜单收不起来"). Session 内保留, 不写 localStorage. */
const userExpanded = ref<Record<string, boolean>>({});

/** 2026-10-31: auto-expand 提升为用户偏好 (sticky). 旧版 auto-expand 是纯派生
 *  (没 key 的项目 展开 ⟺ 是当前路由项目), 每次导航都会把「只是路过被自动
 *  展开」的项目收起 — 用户在项目/任务页间正常切换时, 侧栏项目一直在自动
 *  展开收起 (headless 实证: 进 agent-orchestrator 页自动展开, 切到 autorev
 *  页上一行自动收起). 修法: 项目成为当前路由项目时, 若用户没动过 (没 key),
 *  当场写入 userExpanded=true. 之后导航离开不再收起; 折叠只能由用户显式
 *  操作 (▼/▶ 或点项目名). 只填空 key, 不覆盖已显式折叠的 false (R59 语义
 *  不回归: 点 ▼ 收起当前项目后不会被 auto-expand 拽回去). */
function promoteExpand(id: string): void {
  if (Object.prototype.hasOwnProperty.call(userExpanded.value, id)) return;
  userExpanded.value = { ...userExpanded.value, [id]: true };
}

/** 当前路由高亮 + 自动展开的目标 project + version. 走 route.params
 *  而非正则 — Vue Router 4 已按声明顺序把 projectId/versionId param
 *  填好, 不管是 /projects/:projectId/... (R17) 还是 :projectId/...
 *  (R24-31 老的顶层子路由), 都能命中. 比正则更稳 — 加新 project 路由
 *  不用改侧栏.
 *  - /projects/:projectId                       → project 命中, version null
 *  - /projects/:projectId/versions/:versionId   → project + version 都命中
 *  - /:projectId/unversioned 等老路由           → project 命中
 *  - /:projectId/:versionId (version-board)     → 都命中
 *  - 其他路由 (无 projectId param)                → null (全局看板 / 设置 / etc.) */
const activeProjectId = ref<string | null>(
  route.params.projectId ? String(route.params.projectId) : null,
);
// 首次挂载就提升 (watch 不回放初始路由): 直接打开项目页刷新时同样 sticky.
if (activeProjectId.value) promoteExpand(activeProjectId.value);
// 任务页直开刷新同理: watch 不回放初始路由, setup 时手动跑一次 resolveTaskProject,
// 否则直接刷新 /tasks/:id 时归属项目永远不高亮/不展开 (watch 只在路由变化时触发).
if (route.path.startsWith('/tasks/')) void resolveTaskProject(route.path);
const activeVersionId = ref<string | null>(
  route.params.versionId ? String(route.params.versionId) : null,
);

/** /tasks/:taskId 路由不带 projectId param — 拉一次 task 拿 project_id
 *  写进 activeProjectId. 拉失败/短 ID 都不动 (跟 next 同款: 短 ID 等
 *  server redirect 后这个 effect 再跑一次). */
async function resolveTaskProject(path: string): Promise<void> {
  const taskMatch = path.match(/^\/tasks\/([^/]+)/);
  if (!taskMatch) return;
  const taskId = taskMatch[1];
  if (taskId.length < 36) return;
  try {
    const data = await get<{ project_id: string | null }>(
      `/api/tasks/${taskId}`,
    );
    activeProjectId.value = data?.project_id ?? null;
    // 任务页不带 projectId param, 拉到归属项目后同样 sticky 提升.
    if (activeProjectId.value) promoteExpand(activeProjectId.value);
  } catch {
    // 拉失败不高亮也不展开 (不挡用户)
  }
}

watch(
  () => [route.params.projectId, route.params.versionId, route.path] as const,
  ([proj, ver, path]) => {
    activeProjectId.value = proj ? String(proj) : null;
    activeVersionId.value = ver ? String(ver) : null;
    // sticky: 路由命中的项目当场提升为用户偏好, 导航离开不再自动收起.
    if (proj) promoteExpand(String(proj));
    if (path.startsWith('/tasks/')) {
      void resolveTaskProject(path);
    }
  },
);

/** 纯函数见 spa/src/lib/resolve-project-expanded.ts (镜像 master). */
function isProjectExpanded(projectId: string): boolean {
  return resolveProjectExpanded(
    userExpanded.value,
    projectId,
    activeProjectId.value,
  );
}

/** R57: 镜像 master NavSidebar.tsx:191-200 + NavigationTree.tsx:141-150.
    收到任意任务 status_change 时强制刷新 scopeCounts, 让侧栏徽章 (全局看板 /
    项目级 / 版本级 / 其他任务链接) 近实时更新. 复用 useTaskEventSource 模块
    单例, 与 GlobalBoard / BoardPage 共享同一条 /api/events 长连接.
    R234: 2s 尾随去抖 — 多任务并发状态翻转时事件秒级突发, 逐事件全量刷
    counts = 每个事件都打一次 /api/stats/counts; 合并后一次. 徽章最迟 2s 跟上.
    R245: SSE 断线重连即强刷 — 服务端无 Last-Event-ID 回放, 断线窗口内的
    status_change 事件永久丢失, 事件驱动刷新在断线期间停摆 (徽章僵死根因).
    重连是罕见事件, 直接 force 绕过去抖. */
let countsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
useTaskEventSource('/api/events', (event: GlobalEvent) => {
  if (event.type !== 'status_change') return;
  if (countsRefreshTimer) clearTimeout(countsRefreshTimer);
  countsRefreshTimer = setTimeout(() => {
    countsRefreshTimer = null;
    void loadScopeCounts(true);
  }, 2_000);
}, () => {
  void loadScopeCounts(true);
});

/** R245: 慢速兜底轮询 — 每 60s 强刷一次 counts, 覆盖未知未知 (服务端漏推 /
    其他原因导致事件驱动刷新失效). 页面隐藏时暂停 (省请求), 恢复可见立即
    强刷一次再续轮. onBeforeUnmount 清理. */
const COUNTS_POLL_MS = 60_000;
let countsPollTimer: ReturnType<typeof setInterval> | null = null;
function startCountsPolling(): void {
  if (countsPollTimer) return;
  countsPollTimer = setInterval(() => void loadScopeCounts(true), COUNTS_POLL_MS);
}
function stopCountsPolling(): void {
  if (countsPollTimer) {
    clearInterval(countsPollTimer);
    countsPollTimer = null;
  }
}
function onCountsVisibilityChange(): void {
  if (document.hidden) {
    stopCountsPolling();
  } else {
    void loadScopeCounts(true);
    startCountsPolling();
  }
}

/** R39: 镜像 v2.0-spa NavSidebar.tsx 的「侧栏可调宽度」能力.
   默认 240 保持 SPA 旧行为不变, MIN/MAX 与 next 版一致, 拖动松开写 localStorage.
   key 复用 `nav-sidebar-width` 跟 next 版对齐 (同 key 跨部署不冲突, 同浏览器
   通常不同时打开两边; 万一冲突 = 用户最后拖动为准, 不会爆错). */
const WIDTH_KEY = 'nav-sidebar-width';
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 200;
const MAX_WIDTH = 448;
const sidebarWidth = ref(DEFAULT_WIDTH);
const isDragging = ref(false);

/** R56-B14: 侧栏收起/展开 (镜像 master NavSidebar.tsx 顶部 ◀ 按钮 + 折叠态).
   - 展开态 (默认): 完整侧栏, 顶部 ◀ 按钮, 右侧 resizer 可拖宽.
   - 折叠态: 48px 宽图标列, 顶部 ▶ 按钮展开; 项目变成蓝圆头像 (前 2 字符),
     AccountSwitcher 走 sidebar-collapsed 变体.
   - localStorage key 复用 master `nav-sidebar-collapsed`, 同浏览器跨部署共享偏好. */
const COLLAPSED_KEY = 'nav-sidebar-collapsed';
const COLLAPSED_WIDTH = 48; // master w-12 = 3rem = 48px
const collapsed = ref(false);

/** R56-B13: 顶部「快速入口」固定/活动 toggle (镜像 master NavSidebar.tsx R34).
   - 固定态 (默认): 4 项贴侧栏顶部, 项目列表滚动时仍可见 (sticky inside .sidebar-middle).
   - 活动态: 4 项随项目列表一起滚动走, 保留 R33 加 3 项之前的「老行为」.
   - landscape 横屏 + 上下都固定会让中间滚动区消失, 保留开关给用户自己取舍.
   key 复用 master `nav-top-pinned` (同浏览器跨部署共享偏好). */
const TOP_PINNED_KEY = 'nav-top-pinned';
const topPinned = ref(true);

/** R38: scope counts 数据源 — 镜像 master NavigationTree.tsx 同款 fetch.
    key 形如 "projectId:versionId" 或 "projectId:" (unversioned). */
const scopeCounts = ref<Record<string, ScopeCounts>>({});

async function loadScopeCounts(force = false) {
  if (!force && Object.keys(scopeCounts.value).length > 0) return;
  try {
    scopeCounts.value = await getScopeCounts();
  } catch {
    // 静默失败: 失败时所有徽章不渲染, 不阻塞侧栏其他功能.
  }
}

onMounted(() => {
  projects.load();
  projects.loadAllVersions();
  loadScopeCounts();
  // R245: 兜底轮询启动 + 页面可见性联动
  startCountsPolling();
  document.addEventListener('visibilitychange', onCountsVisibilityChange);
  // R39: 从 localStorage 恢复上次拖动宽度. 范围校验避免脏值/手动改盘导致侧栏
  // 消失或撑爆屏幕.
  try {
    const saved = localStorage.getItem(WIDTH_KEY);
    if (saved) {
      const n = parseInt(saved, 10);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) sidebarWidth.value = n;
    }
  } catch {
    /* 隐私模式或盘满: 静默回退 DEFAULT_WIDTH */
  }
  // R56-B13: 恢复顶部 4 项固定/活动偏好. null (新用户) 走默认 true (固定),
  // 显式存了 "0" 的老用户保持活动态 — 不强推新行为. master NavSidebar.tsx:111-112
  // 同款口径.
  try {
    const pinned = localStorage.getItem(TOP_PINNED_KEY);
    if (pinned !== null) topPinned.value = pinned === '1';
  } catch {
    /* 静默回退 true */
  }
  // R56-B14: 恢复侧栏收起/展开偏好. "1" = 收起, 其他 = 展开. 默认展开.
  try {
    collapsed.value = localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    /* 静默回退 false */
  }
});

/* R232 Round6: 维护模式横幅 — SPA port 补齐 (master NavSidebar.tsx:157-170 同款,
   SPA 搬家时丢了, damo 2026-10-10 指出「没有那小块维护中的展示」).
   轮询 /api/maintenance/status (最小公开版, 全员可读, 只回 active/reason/entered_at):
   进入维护 → 首轮拉取即现; 退出 → 最迟 30s 内横幅消失. 失败/401 静默,
   保留旧值不清空 (网络抖动不闪断横幅). */
const maintenance = ref<{ active: boolean; reason: string | null; entered_at: string | null } | null>(null);
let maintTimer: ReturnType<typeof setInterval> | null = null;
async function pollMaintenance(): Promise<void> {
  try {
    maintenance.value = await get('/api/maintenance/status');
  } catch {
    /* 静默: 未登录 / 网络抖动, 横幅保持现状 */
  }
}
function formatMaintTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
onMounted(() => {
  void pollMaintenance();
  maintTimer = setInterval(() => void pollMaintenance(), 30_000);
});
onBeforeUnmount(() => {
  if (maintTimer) clearInterval(maintTimer);
  maintTimer = null;
  if (countsRefreshTimer) clearTimeout(countsRefreshTimer);
  countsRefreshTimer = null;
  // R245: 兜底轮询清理 + 可见性监听移除
  stopCountsPolling();
  document.removeEventListener('visibilitychange', onCountsVisibilityChange);
});

/** R56-B13: 顶部固定/活动切换. 立即更新 state + 写盘, 不依赖下次 load. */
function toggleTopPinned() {
  topPinned.value = !topPinned.value;
  try {
    localStorage.setItem(TOP_PINNED_KEY, topPinned.value ? '1' : '0');
  } catch {
    /* 写盘失败不阻断: 至少本次会话内行为正确 */
  }
}

/** R56-B14: 侧栏收起/展开切换. master NavSidebar.tsx:267-275 同款,
   立即更新 state + 写盘. */
function toggleCollapse() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed.value ? '1' : '0');
  } catch {
    /* 写盘失败不阻断: 本次会话内行为正确 */
  }
}

/* R59+ fix: sidebar-collapse-btn click 不依赖 reactive isMobile ref — 实时
   用 window.matchMedia 判断当前 viewport, 避免 ref 错判 (初始化时机错 /
   change 事件没触发 / 边界 1023-1024px 抖动) 导致 click 调错函数 (用户原话
   「点了三角形, 没反应」). H5 调 toggleDrawer (跟 hamburger 完全一致);
   桌面调 toggleCollapse (写 localStorage 折叠成 48px). 字符 ◀ 不变 (用户
   原话「不是让你改 x」).

   realtime check 比 reactive ref 更稳: 每次 click 取当下真实 viewport,
   不依赖 setup-time 初始化 + change 事件 listener 链路. matchMedia 是
   sync API, 性能开销忽略不计. */
function onCollapseClick(): void {
  if (window.matchMedia('(max-width: 1023px)').matches) {
    toggleDrawer();
  } else {
    toggleCollapse();
  }
}

// R39: window 级监听让鼠标移出侧栏也能继续拖动. 用 mousedown/mouseup/touchstart
// 三事件 (PC + 触屏), 触发立即锁定光标样式 + 文本选择, 避免拖动过程中出现选字
// 或光标跳回箭头.
let onMouseMove: ((e: MouseEvent) => void) | null = null;
let onMouseUp: ((e: MouseEvent) => void) | null = null;
let onTouchMove: ((e: TouchEvent) => void) | null = null;
let onTouchEnd: ((e: TouchEvent) => void) | null = null;

function clampWidth(n: number) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

function startDrag(e: MouseEvent | TouchEvent) {
  isDragging.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
  onMouseMove = (ev: MouseEvent) => {
    sidebarWidth.value = clampWidth(ev.clientX);
  };
  onMouseUp = (ev: MouseEvent) => {
    finishDrag(clampWidth(ev.clientX));
  };
  onTouchMove = (ev: TouchEvent) => {
    if (ev.touches.length) sidebarWidth.value = clampWidth(ev.touches[0].clientX);
  };
  onTouchEnd = (ev: TouchEvent) => {
    const t = ev.changedTouches[0];
    finishDrag(t ? clampWidth(t.clientX) : sidebarWidth.value);
  };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd);
}

function finishDrag(finalWidth: number) {
  sidebarWidth.value = finalWidth;
  try {
    localStorage.setItem(WIDTH_KEY, String(finalWidth));
  } catch {
    /* 写盘失败不阻断拖动: 至少本次会话内宽度正确 */
  }
  isDragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  if (onMouseMove) window.removeEventListener('mousemove', onMouseMove);
  if (onMouseUp) window.removeEventListener('mouseup', onMouseUp);
  if (onTouchMove) window.removeEventListener('touchmove', onTouchMove);
  if (onTouchEnd) window.removeEventListener('touchend', onTouchEnd);
  onMouseMove = onMouseUp = onTouchMove = onTouchEnd = null;
}

onBeforeUnmount(() => {
  // 组件卸载时清理残留监听 (路由切换 ProjectSidebar 不卸载, 但 SPA 卸载场景兜底)
  if (isDragging.value) {
    if (onMouseMove) window.removeEventListener('mousemove', onMouseMove);
    if (onMouseUp) window.removeEventListener('mouseup', onMouseUp);
    if (onTouchMove) window.removeEventListener('touchmove', onTouchMove);
    if (onTouchEnd) window.removeEventListener('touchend', onTouchEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

const sidebarStyle = computed(() => ({ width: `${sidebarWidth.value}px` }));

/** R59+: "未分类" 项目 (每个用户自动拥有一个, 后端 src/lib/db/projects.ts:715
   UNCATEGORIZED_NAME) 若 0 task + 0 version 就纯是噪声 — 侧栏渲染成
   "未分类  (0)", 用户已经创建别项目后这种空未分类就堆一排. 这里过滤掉:
   只过滤自己 + 是未分类 + 无 version + 无 unversioned task 三件套. 入口仍可
   通过 /uncategorized 路由访问, 不破 master 一致 (master 侧栏也有同问题,
   但本 fix 只动 SPA, master 跟进是后续 task). */
const UNCATEGORIZED_NAME = '未分类';

function isProjectEmpty(p: Project): boolean {
  if (p.name !== UNCATEGORIZED_NAME) return false;
  const versions = projects.versionsByProject[p.id] || [];
  if (versions.length > 0) return false;
  const unversioned = scopeCounts.value[`${p.id}:`];
  if (unversioned && unversioned.total > 0) return false;
  return true;
}

const list = computed(() => projects.projects.filter((p) => !isProjectEmpty(p)));

/** R38: 全局看板数字 = 当前用户名下所有 project 的 scope counts 累加.
    master NavSidebar.tsx:257-266 同款 reduce. admin 视图下走 ownedProjects
    过滤避免别家任务污染; 普通用户没 userId 兜底 = 全量.
    2026-10-11: 累加 queued (可选字段, 旧响应无则按 0) 供徽章区分显示. */
const globalCounts = computed<ScopeCounts>(() => {
  const userId = auth.user?.id;
  const owned = userId ? list.value.filter((p) => p.owner_id === userId) : list.value;
  const ownedIds = new Set(owned.map((p) => p.id));
  return Object.entries(scopeCounts.value)
    .filter(([key]) => ownedIds.has(key.split(':')[0]))
    .reduce<ScopeCounts>(
      (acc, [, c]) => ({
        running: acc.running + c.running,
        queued: (acc.queued ?? 0) + (c.queued ?? 0),
        reviewing: acc.reviewing + c.reviewing,
        paused: acc.paused + c.paused,
        total: acc.total + c.total,
      }),
      { running: 0, queued: 0, reviewing: 0, paused: 0, total: 0 },
    );
});

/** R56-B14: 折叠态用的「自己的项目」列表 (master NavSidebar.tsx:366 同款
    userId 过滤). admin 视图下避免堆出别家项目; 普通用户没 userId 兜底 = 全量.
    R59+: base 已经过滤掉空 "未分类", 这里只做 userId 二次过滤. */
const ownedProjects = computed(() => {
  const userId = auth.user?.id;
  return userId ? list.value.filter((p) => p.owner_id === userId) : list.value;
});

/** R38: 镜像 master NavigationTree.tsx:280-301 renderCountBadge — 纯数字徽章,
    蓝=运行, 紫=审核, 黄=暂停, 末尾灰色总数. 全 0 返回 null (调用方回退). */
function renderCountBadge(counts: ScopeCounts | undefined): { parts: Array<{ n: number; cls: string; title: string }>; total: number } | null {
  if (!counts) return null;
  const parts: Array<{ n: number; cls: string; title: string }> = [];
  if (counts.running > 0) parts.push({ n: counts.running, cls: 'count-running', title: t('nav.statusRunning') });
  if (counts.reviewing > 0) parts.push({ n: counts.reviewing, cls: 'count-reviewing', title: t('nav.statusReviewing') });
  if (counts.paused > 0) parts.push({ n: counts.paused, cls: 'count-paused', title: t('nav.statusPaused') });
  if (parts.length === 0 && counts.total === 0) return null;
  return { parts, total: counts.total };
}

/** R38: 镜像 master NavSidebar.tsx:54-77 renderGlobalCountsBadge — 全局看板
    徽章形状 (parts 中间斜杠 + 末尾灰色总数).
    2026-10-12 (damo v2, 推翻 10-11 括号形态「5(2)」): 有排队时改两段拼接
    「{排队}/{运行}」——排队段在最左, 各段纯数字, 颜色按状态标签色区分
    (排队=count-queued 蓝 / 运行=sky 青, 对齐 TaskStatusBar queued/running);
    无排队整段不显示, running 保持合并数原样 (= 纯运行, 因为 queued=0).
    例: 2 运行 + 3 排队 → 「3/2」; 全在排队 → 「3」; 无排队 → 「2」.
    项目/版本徽章走 renderCountBadge 原路径 (合并口径蓝字), 不受影响. */
function renderGlobalBadge(counts: ScopeCounts) {
  const badge = renderCountBadge(counts);
  if (!badge) return null;
  const q = counts.queued ?? 0;
  if (q <= 0) return { ...badge, total: counts.total };
  const pureRunning = counts.running - q;
  const runningPart = pureRunning > 0
    ? [{ n: pureRunning, cls: 'count-running', title: t('nav.statusRunning') }]
    : [];
  const parts = [
    { n: q, cls: 'count-queued', title: t('nav.statusQueued') },
    ...runningPart,
    ...badge.parts.filter((p) => p.cls !== 'count-running'),
  ];
  return { parts, total: counts.total };
}

/** R38 v2: 项目级徽章 = scopeCounts 里所有以 projectId: 开头的 key 累加
   (unversioned + 所有版本). 不再依赖 projects.versionsByProject —— 后者只
   在 toggle() 展开项目时才调 loadVersions 加载, 折叠态为空, 导致徽章只
   算 unversioned 的 counts, running 数 (running/reviewing/paused) 大多为 0,
   折叠态只显示 total 灰色, 看着"数字小". scopeCounts 已经一次性拉全, 用
   key 前缀过滤更直接, 跟折叠/展开状态解耦. master NavigationTree.tsx:327
   走 versions 列表是 master 启动时 fetch /api/versions 一次拿全, SPA 没这
   一步所以算法不同. 镜像 master 的"累加 running/reviewing/paused/total
   四段"逻辑, 没任务时 renderCountBadge 返回 null → 调用方回退显示版本数. */
function projectCounts(pId: string): ScopeCounts | null {
  const own: ScopeCounts[] = [];
  for (const [key, c] of Object.entries(scopeCounts.value)) {
    if (key.split(':')[0] === pId) own.push(c);
  }
  const sum = own.reduce<ScopeCounts>(
    (acc, c) => ({
      running: acc.running + c.running,
      reviewing: acc.reviewing + c.reviewing,
      paused: acc.paused + c.paused,
      total: acc.total + c.total,
    }),
    { running: 0, reviewing: 0, paused: 0, total: 0 },
  );
  if (sum.total === 0 && sum.running === 0 && sum.reviewing === 0 && sum.paused === 0) return null;
  return sum;
}

function toggle(id: string) {
  const next = !isProjectExpanded(id);
  userExpanded.value = { ...userExpanded.value, [id]: next };
  if (next) projects.loadVersions(id);
}

async function openProject(id: string, name: string) {
  // R56-B26: 无条件 toggle — 之前只在收起时展开, 已展开状态点项目名毫无反馈.
  // 用户原话 "点项目名称, 尽量能够在收起, 如果是展开状态的话". 跟 master
  // NavigationTree.tsx:363 行为对齐 — 项目行整行点击都 toggle (master 不跳转,
  // SPA 这里同时跳详情保留侧栏入口语义, 但 toggle 行为按 master 来).
  // toggle() 已内部判 loadVersions 缓存, 重复展开不重发 fetch.
  toggle(id);
  const tagName = `project-${id}`;
  tags.visit({ name: tagName, title: name, path: `/projects/${id}` });
  await router.push(`/projects/${id}`);
}

async function openVersion(pId: string, pName: string, vId: string, vName: string) {
  const tagName = `version-${vId}`;
  tags.visit({
    name: tagName,
    title: `${pName} / ${vName}`,
    path: `/projects/${pId}/versions/${vId}`,
  });
  await router.push(`/projects/${pId}/versions/${vId}`);
}

/** R26: 跳到某版本下的需求点列表 (镜像 Next.js /[projectId]/[versionId]/requirements).
    入口放在侧栏每个 version 行, 让用户从项目树直接进入版本级需求视图, 不必先
    打开版本详情再切需求 tab. */
async function openVersionRequirements(pId: string, pName: string, vId: string, vName: string) {
  const tagName = `version-requirements-${vId}`;
  const path = `/projects/${pId}/versions/${vId}/requirements`;
  tags.visit({
    name: tagName,
    title: t('nav.tabVersionRequirements', { project: pName, version: vName }),
    path,
  });
  await router.push(path);
}

/** R25: 跳到某版本的任务看板 (镜像 Next.js /[projectId]/[versionId]).
   入口放在侧栏每个 version 行, 与 R26 version-requirements 同款 inline 图标
   button + @click.stop 阻止冒泡到 version-row. tagName 加 versionId 区分
   (允许多版本 board tab 同时开, 与 R26 同款 'version-requirements-{vId}'). */
async function openVersionBoard(pId: string, pName: string, vId: string, vName: string): Promise<void> {
  const tagName = `version-board-${vId}`;
  const path = `/${pId}/${vId}`;
  tags.visit({
    name: tagName,
    title: t('nav.tabVersionBoard', { project: pName, version: vName }),
    path,
  });
  await router.push(path);
}

async function openDashboard() {
  // 兼容旧入口 (R33 之前)— /global 是真正的全局看板; 留空 handler 防止死链.
  // R56-B5: 移除侧栏里的「📊 仪表盘」按钮, master NavSidebar.tsx 没有这个入口.
  // (master 顶部/底部都直接叫「全局看板」「用量统计」, 没有「仪表盘」.)
  // 调用方已被删, 函数保留空壳以防外部 import 残留, 直接走 openGlobal().
}

async function openSchedules() {
  tags.visit({ name: 'schedules', title: t('nav.schedules'), path: '/schedules' });
  await router.push('/schedules');
}

async function openSettings() {
  tags.visit({ name: 'settings', title: t('nav.settings'), path: '/settings' });
  await router.push('/settings');
}

async function openRequirements() {
  tags.visit({ name: 'requirements', title: t('nav.requirements'), path: '/requirements' });
  await router.push('/requirements');
}

async function openAssets() {
  tags.visit({ name: 'assets', title: t('nav.assets'), path: '/assets' });
  await router.push('/assets');
}

async function openImport() {
  tags.visit({ name: 'import', title: t('nav.import'), path: '/import' });
  await router.push('/import');
}

async function openGlobal() {
  tags.visit({ name: 'global', title: t('nav.globalBoard'), path: '/global' });
  await router.push('/global');
}

/** R56-B5: 跳项目列表 (镜像 master NavSidebar.tsx:477-484 "所有项目" 入口).
   SPA Root.vue 仍是 /global 重定向 (sheet R2 字面, 与 master `/` 渲染
   ProjectsClient 不同), 所以这里指 /projects = ProjectsView, 含新建 + 飞书
   配置等 master ProjectsClient 的 SPA 简化版. */
async function openProjects() {
  tags.visit({ name: 'projects', title: t('nav.projects'), path: '/projects' });
  await router.push('/projects');
}

/** R28→R177: 跳到某项目的总控制台画布. 原跳 markdown 看板 (/board),
    damo 2026-10-03 拍板换掉 → console (路由层 /board 已 redirect 兜底,
    这里直接指 /console 免一跳). 入口放侧栏每个 project 行, inline 小图标
    button + @click.stop 阻止冒泡到 project-row 跳转. */
async function openProjectBoard(pId: string, pName: string): Promise<void> {
  const path = `/${pId}/console`;
  tags.visit({
    name: `project-console-${pId}`,
    title: t('nav.tabProjectConsole', { name: pName }),
    path,
  });
  await router.push(path);
}

/** R29: 跳到某项目的未挂版本任务视图 (镜像 Next.js /[projectId]/unversioned).
    入口放在侧栏每个 project 行, 与 R28 board 入口并列, 用 inline 小图标
    button + @click.stop 阻止冒泡. tagName 加 projectId 区分 (允许多项目
    unversioned tab 同时开, 与 R28 board 同款). */
async function openProjectUnversioned(pId: string, pName: string): Promise<void> {
  const tagName = `project-unversioned-${pId}`;
  const path = `/${pId}/unversioned`;
  tags.visit({
    name: tagName,
    title: t('nav.tabProjectUnversioned', { name: pName }),
    path,
  });
  await router.push(path);
}

/** R30: 跳到某项目的未挂版本需求点列表 (镜像 Next.js /[projectId]/unversioned/
    requirements). 与 R29 unversioned 任务视图并列, 入口放同一行 inline 小图标
    (用 📋 与 R26 version-requirements 同款符号 — 需求点统一图标). tagName 加
    projectId 区分 (允许多项目 unversioned-requirements tab 同时开). */
async function openProjectUnversionedRequirements(pId: string, pName: string): Promise<void> {
  const tagName = `project-unversioned-requirements-${pId}`;
  const path = `/${pId}/unversioned/requirements`;
  tags.visit({
    name: tagName,
    title: t('nav.tabProjectUnversionedReq', { name: pName }),
    path,
  });
  await router.push(path);
}

/** R31: 跳到某项目的 Wiki 视图 (镜像 Next.js /[projectId]/wiki). 入口放侧栏项目行,
    与 R28 board / R29 unversioned / R30 unversioned-requirements 并列, 用 inline
    小图标 button + @click.stop 阻止冒泡到 project-row. tagName 加 projectId 区分
    (允许多项目 wiki tab 同时开, 与 R28/R29/R30 同款). */
async function openProjectWiki(pId: string, pName: string): Promise<void> {
  const tagName = `project-wiki-${pId}`;
  const path = `/${pId}/wiki`;
  tags.visit({
    name: tagName,
    title: `${pName} · Wiki`,
    path,
  });
  await router.push(path);
}

async function openUsage() {
  tags.visit({ name: 'usage', title: t('nav.usage'), path: '/usage' });
  await router.push('/usage');
}

// idea-canvas P2 (docs/plans/idea-canvas.md): 构思画布入口 — 跨项目构思层.
async function openIdeas() {
  tags.visit({ name: 'ideas', title: t('nav.ideas'), path: '/ideas' });
  await router.push('/ideas');
}

/* R56-B6: 侧栏项目拖拽重排 — mirror master NavigationTree.tsx:63-70 +
   214-265. draggingId = 正在拖的项目 id; overId = 当前 hover 目标 id;
   overPos = 'before' | 'after' (鼠标在目标行的上半/下半区). dragClientY
   记录拖动坐标 (dragover 时用). 拖动手柄在 .project-row 内部 hover 显示,
   落点指示器 (2px 蓝线) 在 project-node-inner 顶部/底部条件渲染.

   projectRowRefs: 存储每个项目 row 的 DOM ref (template 里通过 :ref callback
   设置), 让 onDragStart 直接拿到 row 元素 clone 出 ghost image. 用 ref
   而不是 $event.currentTarget 是因为 dispatchEvent 不会自动设置 currentTarget
   (read-only), Vue 模板里 $event.currentTarget 在 dragstart 实际触发时
   才是 row 元素, 但用户代码要拿它 clone 需要 closure 引用. */
const draggingId = ref<string | null>(null);
const overId = ref<string | null>(null);
const overPos = ref<'before' | 'after' | null>(null);
const projectRowRefs = ref<Record<string, HTMLElement | null>>({});

function onDragStart(e: DragEvent, id: string, rowEl?: HTMLElement | null) {
  if (!e.dataTransfer || !rowEl) return;
  e.dataTransfer.setData('text/plain', id);
  e.dataTransfer.effectAllowed = 'move';
  // R56-B6 + R170: 自定义拖拽虚影 — 默认浏览器只用一个超小图标当 ghost, 看着
  // 别扭. 复制整个 row 元素当 ghost 让用户清楚拖的什么 (虚影 = 当前项目行的样子).
  //
  // R170 实证: detached (不挂到 DOM) 的 ghost 在 Chromium 不渲染 — Chrome 只给
  // 文档树内的元素做 paint snapshot, detached 时 setDragImage 静默失效, 回退到
  // 浏览器默认拖拽图标 (damo 看到的「地球图形」). 修法 = 挂到 body 但移出视口
  // (position:fixed + top/left -9999px), Chrome 正常渲染且应用 scoped CSS
  // (clone 带 data-v 属性, 挂载后样式命中, 虚影和真行长得一样). 这是 SortableJS
  // 等库的标准做法.
  //
  // 为什么安全: Chromium cancel drag 的条件是 dragstart 内 mutation **源拖拽节点
  // 自身** (隐藏/移除/改布局). 往 body append 一个 fixed 定位、视口外的独立元素
  // 不影响源行布局, 不会 cancel (R56-B6 当时的「appendChild 会 cancel」实测结论
  // 对应的是无定位 in-flow append, 引发了整体 reflow — 不是 off-screen append
  // 的问题).
  //
  // 关键: draggingId state 修改推迟到 setTimeout(0) — 在 handler 内同步改 Vue
  // ref 会 next tick patch 源行 (加 project-row--dragging class), 同样可能触发
  // drag cancel. 视觉上 dim 效果延迟 ~5ms, 体感无感.
  const rect = rowEl.getBoundingClientRect();
  const ghost = rowEl.cloneNode(true) as HTMLElement;
  ghost.setAttribute('data-drag-ghost', '1');
  ghost.style.position = 'fixed';
  ghost.style.top = '-9999px';
  ghost.style.left = '-9999px';
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.margin = '0';
  ghost.style.opacity = '0.9';
  ghost.style.background = 'var(--color-bg-elevated, #ffffff)';
  ghost.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  ghost.style.borderRadius = '4px';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, rect.width / 2, rect.height / 2);
  setTimeout(() => { draggingId.value = id; }, 0);
}

function onDragOver(e: DragEvent, id: string) {
  if (!draggingId.value || draggingId.value === id) return;
  e.preventDefault(); // 必须 preventDefault 才能在目标上触发 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // 上半区 = before, 下半区 = after; 中点 ±0 抖动容差跟 master 一致.
  const mid = rect.top + rect.height / 2;
  const pos: 'before' | 'after' = e.clientY < mid ? 'before' : 'after';
  if (overId.value !== id || overPos.value !== pos) {
    overId.value = id;
    overPos.value = pos;
  }
}

function onDragLeave(e: DragEvent, id: string) {
  // 离开时不要立刻清 overId, 经过子节点会闪烁 (draggable 子元素也触发
  // dragleave); 兜底: 进入 dragend 时统一清.
  const target = e.currentTarget as HTMLElement | null;
  const related = e.relatedTarget as Node | null;
  if (target && !target.contains(related)) {
    if (overId.value === id) overId.value = null;
  }
}

async function onDrop(e: DragEvent, targetId: string) {
  e.preventDefault();
  const dragId = e.dataTransfer?.getData('text/plain') || draggingId.value;
  const pos = overPos.value;
  draggingId.value = null;
  overId.value = null;
  overPos.value = null;
  if (!dragId || dragId === targetId || !pos) return;
  await projects.reorderProject(dragId, targetId, pos);
}

function onDragEnd() {
  // 兜底: 用户拖到非 drop 区域 (e.g. 拖出侧栏) 也清状态.
  draggingId.value = null;
  overId.value = null;
  overPos.value = null;
  // R56-B6: 清理拖拽 ghost 元素 (onDragStart 创建的). dragend fire 时浏览器
  // 不再需要 ghost, 此时移除让 DOM 干净. (drop 成功的话, setDragImage 已被
  // 浏览器内部释放, 移除 ghost 不影响视觉.)
  document.querySelectorAll('[data-drag-ghost]').forEach(el => el.remove());
}

/* ------------------------------------------------------------------ */
/*  v532: 项目右键菜单 (展开态项目行 + 折叠态圆头像 + 归档行共用).      */
/* ------------------------------------------------------------------ */
/* 菜单动作清单: 置顶(附收藏) / 收藏 / 重命名 / 归档 / 删除 (活跃项目);
   恢复 / 删除 (归档项目). 归档 vs 删除的边界:
   - 归档 = 项目藏起来但活着 (数据不动, 归档分组可见, 一键恢复, URL 仍可访问).
   - 删除 = 级联软删 (项目+版本+任务全部 deleted_at, 一切视图消失,
     只能手工 SQL 恢复) — 后端 DELETE /api/projects/[id] v33 已有, 这里接 UI. */

const menuProject = ref<Project | null>(null);
const menuKind = ref<'live' | 'archived'>('live');
const menuPos = ref({ x: 0, y: 0 });

/** 右键打开菜单. 位置收口在视口内 (菜单约 168px 宽 × 236px 高, 靠右/靠底翻转),
    避免「项目在侧栏底部 → 菜单弹出屏幕外点不到」. */
function openContextMenu(e: MouseEvent, p: Project, kind: 'live' | 'archived' = 'live'): void {
  e.preventDefault();
  menuProject.value = p;
  menuKind.value = kind;
  const MENU_W = 168;
  const MENU_H = 236;
  menuPos.value = {
    x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
    y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
  };
}

function closeContextMenu(): void {
  menuProject.value = null;
}

/* 菜单动作 — 先取 menuProject 快照再关菜单 (handler 之后全局 click 关闭,
   闭包引用不受置 null 影响, 但显式快照让依赖一目了然). */
function menuTogglePin(): void {
  const p = menuProject.value;
  closeContextMenu();
  if (p && menuKind.value === 'live') void projects.togglePin(p.id, p.pinned ?? 0);
}

function menuToggleStar(): void {
  const p = menuProject.value;
  closeContextMenu();
  if (p && menuKind.value === 'live') void projects.toggleStar(p.id, p.starred ?? 0);
}

/* v532: 行内重命名 — 菜单点「重命名」→ 项目名变 input, Enter/blur 确认,
   Esc 取消. 不用原生 prompt (R64 红线: 弹窗一律封装组件/自绘). */
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameInputEl = ref<HTMLInputElement | null>(null);

async function menuStartRename(): Promise<void> {
  const p = menuProject.value;
  closeContextMenu();
  if (!p || menuKind.value === 'archived') return;
  renamingId.value = p.id;
  renameValue.value = p.name;
  await nextTick();
  renameInputEl.value?.focus();
  renameInputEl.value?.select();
}

async function submitRename(): Promise<void> {
  // blur 与 Enter 会连触发 — 首次调用已置 renamingId=null, 二次进来直接返回.
  const id = renamingId.value;
  if (!id) return;
  const name = renameValue.value.trim();
  if (!name || !/\S/.test(name)) {
    renamingId.value = null;
    return;
  }
  try {
    await projects.renameProject(id, name);
    toast.success(t('nav.renamedTo', { name }));
  } catch (e) {
    toast.error((e as Error).message || t('nav.renameFailed'));
  } finally {
    renamingId.value = null;
  }
}

function cancelRename(): void {
  renamingId.value = null;
}

function menuArchive(): void {
  const p = menuProject.value;
  closeContextMenu();
  if (!p || menuKind.value === 'archived') return;
  void projects.archiveProject(p.id).then(() => {
    toast.success(t('nav.archivedToast', { name: p.name }));
  });
}

function menuUnarchive(): void {
  const p = menuProject.value;
  closeContextMenu();
  if (!p || menuKind.value === 'live') return;
  void projects.unarchiveProject(p.id).then(() => {
    toast.success(t('nav.unarchivedToast', { name: p.name }));
  });
}

async function menuDelete(): Promise<void> {
  const p = menuProject.value;
  const kind = menuKind.value;
  closeContextMenu();
  if (!p) return;
  const ok = await confirmDialog(
    t('nav.deleteConfirmBody'),
    { title: t('nav.deleteConfirmTitle', { name: p.name }), type: 'danger', confirmText: t('nav.deleteConfirmBtn') },
  );
  if (!ok) return;
  try {
    await apiDeleteProject(p.id);
    projects.removeProjectLocally(p.id);
    toast.success(t('nav.deletedToast', { name: p.name }));
    // 删的是当前路由项目 → 项目页会 404, 拉回项目列表.
    if (activeProjectId.value === p.id) {
      void router.push('/projects');
    }
  } catch (e) {
    toast.error((e as { error?: string; message?: string }).error || (e as Error).message || t('nav.deleteFailed'));
  }
}

/* v532: 归档分组折叠状态. 首次展开才拉归档列表 (loadArchived 有缓存,
   重复展开不重发). 折叠时只显示数量徽章. */
const archivedOpen = ref(false);

function toggleArchivedOpen(): void {
  archivedOpen.value = !archivedOpen.value;
  if (archivedOpen.value) void projects.loadArchived();
}

/* 全局关闭菜单: 左键点别处 / Esc / 任意滚动 (capture — scroll 不冒泡,
   侧栏内部滚动也要关, 否则菜单悬空在滚动前的坐标上). */
function onGlobalClick(): void {
  closeContextMenu();
}
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    closeContextMenu();
    if (renamingId.value) cancelRename();
  }
}
function onGlobalScroll(): void {
  if (menuProject.value) closeContextMenu();
}
onMounted(() => {
  document.addEventListener('click', onGlobalClick);
  document.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('scroll', onGlobalScroll, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onGlobalClick);
  document.removeEventListener('keydown', onGlobalKeydown);
  document.removeEventListener('scroll', onGlobalScroll, true);
});
</script>

<template>
  <!-- R59: ≤1023px 浮层 (drawer overlay) — sidebar 改 position:fixed + transform
       translateX 滑入/滑出, 不占 main-content 宽度 (cv-main 不被挤). backdrop
       点一下关闭. AppHeader 汉堡按钮 toggleDrawer() 触发. -->
  <div v-if="drawerOpen" class="sidebar-backdrop" @click="closeDrawer" aria-hidden="true"></div>
  <!-- R56-B14: 折叠态 — 48px 宽图标列 (master NavSidebar.tsx:298-385 collapsedContent
       同款). 顶部 ▶ 展开按钮 + 8 个图标入口 + 项目蓝圆头像 + AccountSwitcher.
       项目圆按 userId 过滤避免 admin 视图下堆出别家项目 (与展开态 NavigationTree
       同规则). -->
  <aside v-if="collapsed && !isMobile" class="sidebar sidebar--collapsed">
    <button
      class="sidebar-collapse-btn"
      :title="t('nav.expandNav')"
      :aria-label="t('nav.expandNav')"
      @click="toggleCollapse"
    >▶</button>
    <div class="sidebar-divider" />
    <button class="sidebar-icon-btn" :title="t('nav.allProjects')" @click="openProjects">🏠</button>
    <button class="sidebar-icon-btn" :title="t('nav.globalBoard')" @click="openGlobal">🌐</button>
    <button class="sidebar-icon-btn" :title="t('nav.import')" @click="openImport">📥</button>
    <button class="sidebar-icon-btn" :title="t('nav.requirements')" @click="openRequirements">📋</button>
    <button class="sidebar-icon-btn" :title="t('nav.assets')" @click="openAssets">📦</button>
    <button class="sidebar-icon-btn" :title="t('nav.schedules')" @click="openSchedules">⏰</button>
    <button class="sidebar-icon-btn" :title="t('nav.ideas')" @click="openIdeas">💡</button>
    <button class="sidebar-icon-btn" :title="t('nav.usage')" @click="openUsage">📊</button>
    <button class="sidebar-icon-btn" :title="t('nav.settings')" @click="openSettings">⚙️</button>
    <div class="sidebar-divider" />
    <a
      v-for="p in ownedProjects"
      :key="p.id"
      class="sidebar-project-circle"
      :title="p.name"
      :href="p.current_version_id ? `/${p.id}/${p.current_version_id}` : `/${p.id}/unversioned`"
      @click.prevent="openProject(p.id, p.name)"
      @contextmenu.prevent="openContextMenu($event, p)"
    >{{ p.name.slice(0, 2) }}</a>
    <AccountSwitcher v-if="auth.user" variant="sidebar-collapsed" />
    <!-- R232 Round6: 折叠态维护指示 — 右缘琥珀条 (master NavSidebar.tsx:377-383 同款). -->
    <div
      v-if="maintenance?.active"
      class="maint-strip"
      :title="maintenance.reason || t('nav.maintenance')"
      :aria-label="t('nav.maintenance')"
    />
  </aside>

  <aside v-else class="sidebar" :class="{ 'sidebar--drawer-open': drawerOpen }" :style="sidebarStyle">
    <!-- R56-B14: 展开态右上角 ◀ 收起按钮 (master NavSidebar.tsx:398-406 同款).
         absolute top-2 right-2, 移动端抽屉自带 ✕ 所以 hidden md:block —
         但 SPA 没有抽屉, 直接桌面+触屏都显示 (master 这条隐藏规则不适用).

         R59+: H5 下跟 AppHeader hamburger 完全协同 — 同一个 toggle 语义,
         字符保持 ◀ 不变 (用户原话「不是让你改 x」). click handler 用
         onCollapseClick 实时查 window.matchMedia (不依赖 reactive isMobile
         ref, 避免 setup-time 初始化错 / change 事件没触发 / 1023-1024px
         边界抖动导致 click 调错函数 — 用户原话「点了三角形, 没反应」).
         桌面端走 toggleCollapse (写 localStorage nav-sidebar-collapsed=1).
         H5 + toggleDrawer 不写 localStorage, 下次切桌面仍是用户之前选
         的折叠态. -->
    <button
      class="sidebar-collapse-btn"
      :title="t('nav.collapseNav')"
      :aria-label="t('nav.collapseNav')"
      @click="onCollapseClick"
    >◀</button>

    <!-- R33: 中间可滚动区 = 顶部「快速入口」+ 项目列表. flex: 1 + overflow-y
        才能在项目多时只让这一段内部滚动, 不挤压底部固定区.

        R56-B5: 删掉「工具」分类 (master NavSidebar.tsx 没有这一段). 6 项
        (统计看板/实时进度/未分类任务/模板管理/Webhooks/Runners) 都是 SPA
        legacy, master 侧栏顶部=快速入口4项, 中间=项目树, 底部=系统4项.
        之前 SPA 在中间硬塞了一个 7 项「工具」分类 + 实际只有 6 项,
        master 完全没有 → 删. 这些功能还在路由里 (/stats 等), 只是
        不在侧栏展示; 真要进从 URL 走.

        R56-B13: 顶部「快速入口」从 sidebar 外 sibling 改为 sidebar-middle
        内首 child, 镜像 master NavSidebar.tsx R34. 固定态加 sticky 贴
        .sidebar-middle 顶, 活动态去掉 sticky 跟项目列表一起滚走. -->
    <div class="sidebar-middle">
      <!-- R232 Round6: 维护模式横幅 (master NavSidebar.tsx:408-429 同款 port).
           挂 .sidebar-middle 首 child, 展开态(含 H5 drawer)可见. -->
      <div v-if="maintenance?.active" class="maint-banner" role="status" aria-live="polite">
        <div class="maint-banner-head">
          <span class="maint-dot" aria-hidden="true" />
          <span>🔧 {{ t('nav.maintenance') }}</span>
        </div>
        <div v-if="maintenance.reason" class="maint-banner-reason">{{ maintenance.reason }}</div>
        <div v-if="maintenance.entered_at" class="maint-banner-time">{{ t('nav.maintStartedAt', { time: formatMaintTime(maintenance.entered_at) }) }}</div>
      </div>
      <!-- R56-B13: 顶部「快速入口」区. 镜像 master NavSidebar.tsx R34:
           固定态 topPinned=true 加 sticky 贴 .sidebar-middle 顶部 (项目列表
           滚动时仍可见); 活动态去掉 sticky 跟项目列表一起滚走 (R33 之前的
           「老行为」). bg 必须不透明 (变量 --color-bg-elevated), 否则滚动时
           项目列表会从下面穿透显示. -->
      <div
        class="sidebar-section sidebar-section--top"
        :class="{ 'sidebar-section--top-sticky': topPinned }"
      >
        <div class="sidebar-top-header">
          <span class="sidebar-heading">{{ t('nav.quickEntry') }}</span>
          <button
            class="top-pinned-toggle"
            :class="{ 'top-pinned-toggle--pinned': topPinned }"
            :title="topPinned ? t('nav.toAutoTitle') : t('nav.toPinnedTitle')"
            :aria-pressed="topPinned"
            @click="toggleTopPinned"
          >{{ topPinned ? '📌 ' + t('nav.pinnedLabel') : '📍 ' + t('nav.autoLabel') }}</button>
        </div>
        <button class="btn sidebar-link" @click="openSchedules">⏰ {{ t('nav.schedules') }}</button>
        <button class="btn sidebar-link" @click="openRequirements">📋 {{ t('nav.requirements') }}</button>
        <button class="btn sidebar-link" @click="openAssets">📦 {{ t('nav.assets') }}</button>
        <button class="btn sidebar-link" @click="openIdeas">💡 {{ t('nav.ideas') }}</button>
        <button class="btn sidebar-link" @click="openUsage">📊 {{ t('nav.usage') }}</button>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-heading">
          <span>{{ t('nav.projectNav') }}</span>
          <span class="sidebar-heading-count" :title="t('nav.projectCountTitle', { n: ownedProjects.length })">{{ ownedProjects.length }}</span>
        </div>
        <div v-if="projects.loading" class="muted small">{{ t('nav.loading') }}</div>
      <div v-else-if="projects.error" class="form-error small">{{ projects.error }}</div>
      <div v-else-if="!list.length" class="muted small">{{ t('nav.noProjects') }}</div>
      <ul v-else class="project-tree">
        <li v-for="p in list" :key="p.id" class="project-node">
          <!-- R56-B6: 内层 div 承载 drop indicator (上下蓝线), outer div (project-row)
              承载 draggable + handlers. master NavigationTree.tsx:347-356 用外层 div 作
              draggable, 内层 button 渲染内容. SPA 改用同款: project-row 是 draggable
              div (用户实际拖拽接触的视觉), 内层 div 仅作 relative 定位放 indicator.
              draggable 绑在 row 而非整个 inner 是因为 row 已经占满交互面积, 浏览器
              drag 检测更稳定 (避免拖到 toggle/drag-handle 子元素时 dragstart 吞掉). -->
          <div class="project-node-inner" :class="{ 'project-node-inner--dragging': draggingId === p.id }">
            <!-- 上方落点指示器 (before) -->
            <div v-if="overId === p.id && overPos === 'before'" class="drop-indicator" aria-hidden="true" />
            <!-- R56-B6: project-row 不挂 @click. 之前挂 click 会让浏览器 mousedown
                 在子元素时优先走 click 而非 drag, dragstart 不触发. click 挪到
                 project-name span 上, 让 draggable 父级能正常 fire dragstart. -->
            <div
              :ref="(el) => projectRowRefs[p.id] = el as HTMLElement | null"
              class="project-row"
              :class="{ 'project-row--dragging': draggingId === p.id, 'project-row--active': p.id === activeProjectId }"
              :draggable="true"
              @dragstart="(e) => onDragStart(e, p.id, projectRowRefs[p.id])"
              @dragover="(e) => onDragOver(e, p.id)"
              @dragleave="(e) => onDragLeave(e, p.id)"
              @drop="(e) => onDrop(e, p.id)"
              @dragend="onDragEnd"
              @contextmenu.prevent="openContextMenu($event, p)"
            >
              <button
                class="toggle"
                :aria-expanded="isProjectExpanded(p.id)"
                @click.stop="toggle(p.id)"
              >
                {{ isProjectExpanded(p.id) ? '▼' : '▶' }}
              </button>
              <!-- R56-B16: 项目置顶 toggle — pinned 用 ★ / 未 pin 用 ☆ (纯字符,
                  CSS color 可控, 不会被 emoji 自带彩色字形吃掉; master 卡片用
                  📌 emoji 是文字包裹, 侧栏紧凑只 1 字符, ★/☆ 更合适).
                  pinned=1 时常驻 amber, pinned=0 hover 时浮出. click.stop 走
                  store.togglePin (乐观更新 + PATCH, 失败 rollback).
                  R169: 移到行尾 (数字右侧) — 之前夹在拖拽手柄和项目名之间, 跟名字抢视觉. -->
              <!-- R56-B17+R56-B20: name + (N) 视觉打包 (镜像 master NavigationTree.tsx:380-385).
                  name 在左, (N) 紧贴 name 右侧 shrink-0 不被吃, group flex:1 + min-width:0
                  让 name 长名 truncate 时 (N) 仍贴名字尾巴. count-badge ml-auto
                  推行末. -->
              <span class="project-name-group">
                <!-- v532: 重命名态 — 右键菜单「重命名」→ 名字变行内 input.
                     Enter/blur 确认, Esc 取消; blur 与 Enter 连触发由
                     submitRename 的 renamingId guard 兜住. -->
                <input
                  v-if="renamingId === p.id"
                  :ref="(el) => renameInputEl = el as HTMLInputElement | null"
                  v-model="renameValue"
                  class="rename-input"
                  type="text"
                  maxlength="100"
                  @click.stop
                  @keydown.enter.prevent="submitRename"
                  @keydown.esc.prevent="cancelRename"
                  @blur="submitRename"
                />
                <span v-else class="project-name" @click="openProject(p.id, p.name)">{{ p.name }}</span>
                <!-- 版本数常驻 — onMounted 已 loadAllVersions 一次拿全 (跟 master 同口径),
                    折叠态也显示. 无版本时显示 (0), 跟 master 一致. -->
                <span
                  class="project-version-count"
                  :title="t('nav.versionCountTitle', { n: (projects.versionsByProject[p.id] || []).length })"
                >
                  ({{ (projects.versionsByProject[p.id] || []).length }})
                </span>
              </span>
            <!-- R169: 行尾容器 = 数字徽章 + 置顶五角星. 用一个 wrapper 承载 ml-auto,
                而不是给两个子元素各挂一个 auto margin (flex 里多个 auto margin 会
                平分剩余空间 = 徽章被推到中间). wrapper 空时 (无徽章) 置顶星仍贴最右. -->
            <span class="project-row-end">
              <!-- R38: 项目级徽章 (镜像 master NavigationTree.tsx:388 renderCountBadge).
                  仅显示有任务的 scope. 全 0 不渲染 (回退显示版本数). -->
              <span
                v-if="projectCounts(p.id) && renderCountBadge(projectCounts(p.id)!)"
                class="count-badge"
                :aria-label="t('nav.ariaBadge', { running: projectCounts(p.id)!.running, review: projectCounts(p.id)!.reviewing, paused: projectCounts(p.id)!.paused })"
              >
                <template v-for="(part, i) in renderCountBadge(projectCounts(p.id)!)!.parts" :key="part.title">
                  <span v-if="i > 0" class="count-sep">/</span>
                  <span :class="part.cls" :title="part.title">{{ part.n }}</span>
                </template>
                <span
                  v-if="renderCountBadge(projectCounts(p.id)!)!.total > 0"
                  :class="renderCountBadge(projectCounts(p.id)!)!.parts.length > 0 ? 'count-total count-total--with-parts' : 'count-total'"
                  :title="t('nav.totalCount')"
                >{{ renderCountBadge(projectCounts(p.id)!)!.total }}</span>
              </span>
              <!-- v532: 收藏 toggle — 行尾与置顶星并列. 未收藏 hover 浮出灰 ♥,
                  收藏时常驻红 ♥ (与置顶 amber ★ 双色区分: ★=排最顶, ♥=排次段).
                  click.stop 走 store.toggleStar (乐观更新 + PATCH, 失败回滚;
                  取消收藏时若还置顶着会联动取消置顶 — 不变量 pin ⇒ star). -->
              <button
                class="star-toggle"
                :class="{ 'star-toggle--starred': !!p.starred }"
                :title="p.starred ? t('nav.unstar') : t('nav.star')"
                :aria-pressed="!!p.starred"
                @click.stop="(e) => { e.preventDefault(); projects.toggleStar(p.id, p.starred ?? 0); }"
              >♥</button>
              <button
                class="pin-toggle"
                :class="{ 'pin-toggle--pinned': !!p.pinned }"
                :title="p.pinned ? t('nav.unpin') : t('nav.pinRowTitle')"
                :aria-pressed="!!p.pinned"
                @click.stop="(e) => { e.preventDefault(); projects.togglePin(p.id, p.pinned ?? 0); }"
              >{{ p.pinned ? '★' : '☆' }}</button>
            </span>
          </div>
          <ul v-if="isProjectExpanded(p.id)" class="version-list">
            <li
              v-for="v in projects.versionsByProject[p.id] || []"
              :key="v.id"
              class="version-row"
              :class="{ 'version-row--active': v.id === activeVersionId && p.id === activeProjectId }"
              @click="openVersion(p.id, p.name, v.id, v.name)"
            >
              <!-- R56-B22: current 版本前 ⭐ 五角星 (镜像 master NavigationTree.tsx:414
                  shrink-0). 之前用 v.is_current 但 versions 表没这列 (后端只返
                  project.current_version_id), 所以一直没渲染; 现在改用
                  v.id === p.current_version_id 跟 master 一致. ⭐ 跟名字前靠,
                  一眼可识别 "默认版本". shrink-0 保 emoji 不被 truncate 吃. -->
              <span v-if="v.id === p.current_version_id" class="version-current-star" :title="t('nav.currentVersion')">⭐</span>
              <span class="version-name">{{ v.name }}</span>
              <!-- R38: 版本级徽章 (镜像 master NavigationTree.tsx:419). -->
              <span
                v-if="renderCountBadge(scopeCounts[`${p.id}:${v.id}`])"
                class="count-badge count-badge--version"
                :aria-label="t('nav.ariaBadge', { running: scopeCounts[`${p.id}:${v.id}`]?.running, review: scopeCounts[`${p.id}:${v.id}`]?.reviewing, paused: scopeCounts[`${p.id}:${v.id}`]?.paused })"
              >
                <template v-for="(part, i) in renderCountBadge(scopeCounts[`${p.id}:${v.id}`])!.parts" :key="part.title">
                  <span v-if="i > 0" class="count-sep">/</span>
                  <span :class="part.cls" :title="part.title">{{ part.n }}</span>
                </template>
                <span
                  v-if="renderCountBadge(scopeCounts[`${p.id}:${v.id}`])!.total > 0"
                  :class="renderCountBadge(scopeCounts[`${p.id}:${v.id}`])!.parts.length > 0 ? 'count-total count-total--with-parts' : 'count-total'"
                  :title="t('nav.totalCount')"
                >{{ renderCountBadge(scopeCounts[`${p.id}:${v.id}`])!.total }}</span>
              </span>
            </li>
            <li v-if="!(projects.versionsByProject[p.id] || []).length" class="muted small">
              {{ t('nav.noVersions') }}
            </li>
            <!-- R38: 镜像 Next.js NavigationTree.tsx 展开后底部 4 条项目级入口
                (其他任务/Board/需求/Wiki, master 把这 4 个挂版本列表下方作
                完整 link, 而非 inline icon button). 之前 SPA 走 R28-R31 把
                4 个入口塞在项目行右侧, R25/R26 又把 2 个入口塞在版本行右侧,
                视觉密集 + 与 master 不一致; 现统一下放到版本列表下方,
                与 master 一一对应 (顺序/emoji/链接目标 1:1). -->
            <li class="project-link-row">
              <button type="button" class="project-link" @click.stop="openProjectUnversioned(p.id, p.name)">
                <span>📁</span><span>{{ t('nav.unversionedTasks') }}</span>
                <!-- R38: 其他任务链接右侧徽章 (镜像 master NavigationTree.tsx:456). -->
                <span
                  v-if="renderCountBadge(scopeCounts[`${p.id}:`])"
                  class="count-badge count-badge--link"
                  :aria-label="t('nav.ariaBadge', { running: scopeCounts[`${p.id}:`]?.running, review: scopeCounts[`${p.id}:`]?.reviewing, paused: scopeCounts[`${p.id}:`]?.paused })"
                >
                  <template v-for="(part, i) in renderCountBadge(scopeCounts[`${p.id}:`])!.parts" :key="part.title">
                    <span v-if="i > 0" class="count-sep">/</span>
                    <span :class="part.cls" :title="part.title">{{ part.n }}</span>
                  </template>
                  <span
                    v-if="renderCountBadge(scopeCounts[`${p.id}:`])!.total > 0"
                    :class="renderCountBadge(scopeCounts[`${p.id}:`])!.parts.length > 0 ? 'count-total count-total--with-parts' : 'count-total'"
                    :title="t('nav.totalCount')"
                  >{{ renderCountBadge(scopeCounts[`${p.id}:`])!.total }}</span>
                </span>
              </button>
            </li>
            <li class="project-link-row">
              <button type="button" class="project-link" @click.stop="openProjectBoard(p.id, p.name)">
                <span>🎬</span><span>{{ t('nav.console') }}</span>
              </button>
            </li>
            <li class="project-link-row">
              <button type="button" class="project-link" @click.stop="openProjectUnversionedRequirements(p.id, p.name)">
                <span>📋</span><span>{{ t('nav.projectRequirements') }}</span>
              </button>
            </li>
            <li class="project-link-row">
              <button type="button" class="project-link" @click.stop="openProjectWiki(p.id, p.name)">
                <span>📖</span><span>Wiki</span>
              </button>
            </li>
          </ul>
            <!-- 下方落点指示器 (after) — 放在展开列表后, 仍属于 project-node-inner
                内层, 让 after 落点指向 project 行尾 -->
            <div v-if="overId === p.id && overPos === 'after'" class="drop-indicator" aria-hidden="true" />
          </div>
        </li>
      </ul>
      <!-- v532: 已归档分组 — 归档项目从主列表消失后在这里可见 (默认折叠,
          只显示数量). 展开列归档项目行: 点击仍可打开项目 (归档 ≠ 删除,
          数据不动 URL 可访问), 右键 → 恢复 / 删除. 有归档项目才渲染整块,
          没归档时零视觉占用. -->
      <div v-if="projects.archivedProjects.length" class="archived-block">
        <button
          class="archived-header"
          :aria-expanded="archivedOpen"
          @click="toggleArchivedOpen"
        >
          <span>{{ archivedOpen ? '▼' : '▶' }} 🗂 {{ t('nav.archivedGroup') }}</span>
          <span class="archived-count">{{ projects.archivedProjects.length }}</span>
        </button>
        <ul v-if="archivedOpen" class="archived-list">
          <li
            v-for="p in projects.archivedProjects"
            :key="p.id"
            class="archived-row"
            :class="{ 'archived-row--active': p.id === activeProjectId }"
            :title="t('nav.archivedRowTitle', { name: p.name })"
            @click="openProject(p.id, p.name)"
            @contextmenu.prevent="openContextMenu($event, p, 'archived')"
          >
            <span class="archived-name">{{ p.name }}</span>
          </li>
        </ul>
      </div>
    </div>
    </div>

    <!-- R33: 底部固定「系统」区 (镜像 Next.js NavSidebar.tsx 底部 4 项 fixed 区).
        border-top 跟中间可滚动区视觉分层, 让用户一眼分辨"全局工具 vs 项目".

        R56-B5: 顶部加「🏠 所有项目」入口 (master NavSidebar.tsx:477-484 同款,
        链接到 /projects = ProjectsView 项目列表, 含新建/飞书配置等).
        顺序与 master 一致: 所有项目 → 全局看板 → 批量导入 → 设置.

        R38: 全局看板右侧加数字徽章 (镜像 master NavSidebar.tsx:485-493
        renderGlobalCountsBadge), 数据 = 当前用户名下所有 scope 累加. -->
    <div class="sidebar-section sidebar-section--bottom">
      <button class="btn sidebar-link" @click="openProjects">🏠 {{ t('nav.allProjects') }}</button>
      <button class="btn sidebar-link sidebar-link--global" @click="openGlobal">
        <span class="sidebar-link-label">🌐 {{ t('nav.globalBoard') }}</span>
        <span
          v-if="renderGlobalBadge(globalCounts)"
          class="count-badge count-badge--global"
          :aria-label="t('nav.globalAriaBadge', { queued: globalCounts.queued ?? 0, running: globalCounts.running - (globalCounts.queued ?? 0), review: globalCounts.reviewing, paused: globalCounts.paused })"
        >
          <template v-for="(part, i) in renderGlobalBadge(globalCounts)!.parts" :key="part.title">
            <span v-if="i > 0" class="count-sep">/</span>
            <span :class="part.cls" :title="part.title">{{ part.n }}</span>
          </template>
          <span
            v-if="renderGlobalBadge(globalCounts)!.total > 0"
            :class="renderGlobalBadge(globalCounts)!.parts.length > 0 ? 'count-total count-total--with-parts' : 'count-total'"
            :title="t('nav.totalCount')"
          >{{ renderGlobalBadge(globalCounts)!.total }}</span>
        </span>
      </button>
      <button class="btn sidebar-link" @click="openImport">📥 {{ t('nav.import') }}</button>
      <button class="btn sidebar-link" @click="openSettings">⚙️ {{ t('nav.settings') }}</button>
    </div>

    <!-- R56-B5: 底部账号区 (镜像 master NavSidebar.tsx:511-513 AccountSwitcher
   sidebar 变体). 这次用真 AccountSwitcher 替代上轮的静态 email 渲染,
   用户能 hover/单击 trigger 弹 dropdown, 看切换账号列表 / 登录其他账号 /
   退出登录 — 与 master 行为对齐.

   variant="sidebar" 走 AccountSwitcher.vue 的 sidebar 态: 整行 button
   (avatar + email + ▾), hover 浅灰反馈, Teleport dropdown 浮在 body 顶层
   (避开侧栏 overflow-hidden). -->
    <div v-if="auth.user" class="sidebar-section sidebar-section--user">
      <AccountSwitcher variant="sidebar" />
    </div>

    <!-- R39: 侧栏右侧拖动手柄 (镜像 v2.0-spa NavSidebar.tsx 的 1px 透明 hit
        zone + hover 蓝色提示). mousedown 启动拖动, touchstart 兼容触屏
        (R56-B5 让 SPA 移动端可用, 触屏拖宽度同样有意义). 桌面优先显示
        (hit area 永远存在, 触屏不需要 hover 提示). -->
    <div
      class="sidebar-resizer"
      :class="{ 'sidebar-resizer--dragging': isDragging }"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="sidebarWidth"
      :aria-valuemin="MIN_WIDTH"
      :aria-valuemax="MAX_WIDTH"
      :aria-label="t('nav.resizerAria')"
      :title="t('nav.resizerTitle')"
      @mousedown="startDrag"
      @touchstart="startDrag"
    />
  </aside>

  <!-- v532: 项目右键菜单 — Teleport body + fixed 定位 (侧栏 overflow:hidden
      会裁剪内部浮层). menuKind 区分活跃/归档两套动作. 全局 click / Esc /
      scroll(capture) 关闭 (script 段注册). @click.stop 防菜单自身点击冒泡
      触发 document click 提前关闭动作项执行前的状态 (handler 已先取快照,
      这里 stop 只是让关闭统一发生在动作之后, 视觉不闪). -->
  <Teleport to="body">
    <div
      v-if="menuProject"
      class="ctx-menu"
      :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
      role="menu"
      @click.stop
      @contextmenu.prevent.stop
    >
      <template v-if="menuKind === 'live'">
        <button class="ctx-item" role="menuitem" @click="menuTogglePin">
          <span class="ctx-glyph" :class="{ 'ctx-glyph--amber': !!menuProject.pinned }">★</span>
          <span>{{ menuProject.pinned ? t('nav.unpin') : t('nav.pinMenu') }}</span>
        </button>
        <button class="ctx-item" role="menuitem" @click="menuToggleStar">
          <span class="ctx-glyph" :class="{ 'ctx-glyph--red': !!menuProject.starred }">♥</span>
          <span>{{ menuProject.starred ? t('nav.unstar') : t('nav.star') }}</span>
        </button>
        <button class="ctx-item" role="menuitem" @click="menuStartRename">
          <span class="ctx-glyph">✎</span>
          <span>{{ t('nav.rename') }}</span>
        </button>
        <div class="ctx-sep" aria-hidden="true" />
        <button class="ctx-item" role="menuitem" @click="menuArchive">
          <span class="ctx-glyph">🗂</span>
          <span>{{ t('nav.archive') }}</span>
        </button>
        <button class="ctx-item ctx-item--danger" role="menuitem" @click="menuDelete">
          <span class="ctx-glyph">🗑</span>
          <span>{{ t('nav.delete') }}</span>
        </button>
      </template>
      <template v-else>
        <button class="ctx-item" role="menuitem" @click="menuUnarchive">
          <span class="ctx-glyph">📤</span>
          <span>{{ t('nav.restore') }}</span>
        </button>
        <button class="ctx-item ctx-item--danger" role="menuitem" @click="menuDelete">
          <span class="ctx-glyph">🗑</span>
          <span>{{ t('nav.delete') }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
/* R33: sidebar 从 "padding + overflow-y: auto" 改成 flex column, 高度撑满
   .main-body 可用空间. 顶部/底部固定, 中间 (sidebar-middle) 内部滚动.
   配合 .main-body flex + min-height: 0 让侧栏能拿到 100% 高度.

   R39: width 由 inline style 控制 (拖动调整), 这里保留 240px 作为无 JS 时的
   CSS fallback, 并加 position: relative 让 resizer 绝对定位挂到侧栏右边. */
.sidebar {
  width: 240px;
  flex-shrink: 0;
  background: var(--color-bg-elevated);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* R59+: ≤1023px 浮层 (drawer overlay) — sidebar 改 position:fixed, 不占
   main-content 宽度 (用户反馈「现在的比例 1:3 最好是浮层状态」).
   展开态 (.sidebar 240px) 从左侧滑入覆盖 cv-main, 不推开. 折叠态
   (.sidebar--collapsed 48px) 默认收起不显示 — H5 顶 AppHeader 汉堡按钮
   触发 drawer. transform 0.25s ease. backdrop 点击关闭.

   R59+ fix: 用 height: calc(100dvh - 44px) 替代 bottom: 0 — bottom: 0 在
   iOS Safari 早期版本被地址栏遮住 (地址栏在物理 viewport 底部, 视觉上盖住
   fixed bottom 元素), AccountSwitcher (sidebar 最底, sidebar-section--user)
   邮箱掉一半出可见 viewport. height 用 dvh 让 sidebar 跟 dynamic viewport
   走, 地址栏缩进时自动更新. fallback calc(100vh - 44px) 兜旧浏览器
   (Safari <15.4 / Android Chrome 早期不识别 dvh). */
@media (max-width: 1023px) {
  .sidebar {
    position: fixed;
    top: 44px;       /* AppHeader 高度 — sidebar 从 header 下方开始 */
    left: 0;
    width: 240px;
    height: calc(100vh - 44px);
    height: calc(100dvh - 44px);
    z-index: 60;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: 4px 0 12px rgba(0, 0, 0, 0.08);
  }
  /* drawer 打开态 (AppHeader 汉堡按钮 toggleDrawer 后) */
  .sidebar.sidebar--drawer-open {
    transform: translateX(0);
  }
  /* 折叠态在 H5 上默认藏 — 用户开抽屉要看完整列表, 不需要 48px 图标列 */
  .sidebar--collapsed {
    display: none;
  }
}

.sidebar-backdrop {
  position: fixed;
  top: 44px;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 55;       /* 在 sidebar (60) 下方, 在内容 (0) 上方 */
  animation: sidebar-backdrop-in 0.2s ease;
}
@keyframes sidebar-backdrop-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
/* R39: 拖动手柄 — 4px 透明 hit zone, 紧贴侧栏右侧. hover 时亮出蓝色提示
   (与 next 版 1px + bg-blue-400 行为对齐; 这里 4px 更易抓, 触屏命中率更高).
   dragging 态锁色避免快速划过时颜色闪. */
.sidebar-resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 4px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  transition: background-color 0.15s ease;
}
.sidebar-resizer:hover,
.sidebar-resizer--dragging {
  background: rgba(59, 130, 246, 0.5); /* blue-500/50 */
}
/* R56-B14: 折叠态 — 48px 宽图标列 (master NavSidebar.tsx:300 w-12 同款).
   flex column + items-center 让图标/按钮居中堆叠; overflow-y: auto 让项目
   头像多时只滚这一段, 跟展开态一样不挤压 (master 也是 overflow-y: auto). */
.sidebar--collapsed {
  width: 48px;
  padding: 8px 0;
  gap: 4px;
  overflow-y: auto;
  overflow-x: hidden;
  align-items: center;
  position: relative; /* R232 Round6: maint-strip absolute 定位锚点 */
}

/* R232 Round6: 维护模式横幅 (master NavSidebar.tsx:408-429 同款 port).
   琥珀色调 + 呼吸点, 双主题可读 (半透明底 + amber-500 前景不依赖主题变量). */
.maint-banner {
  margin: 8px 8px 2px;
  padding: 7px 10px;
  border: 1px solid rgba(245, 158, 11, 0.5);
  background: rgba(245, 158, 11, 0.1);
  border-radius: var(--radius-md);
}
.maint-banner-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #f59e0b;
}
.maint-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #f59e0b;
  animation: maint-pulse 1.6s ease-in-out infinite;
}
@keyframes maint-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.maint-banner-reason {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text);
  opacity: 0.85;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.maint-banner-time {
  margin-top: 2px;
  font-size: 10px;
  color: var(--color-text-muted);
}
/* 折叠态: 右缘 3px 琥珀条 (master 同款 w-1 amber animate-pulse). */
.maint-strip {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #f59e0b;
  animation: maint-pulse 1.6s ease-in-out infinite;
}
/* R56-B14: 收起/展开按钮 (展开态右上角 ◀, 折叠态顶部 ▶). master NavSidebar.tsx:398-406
   absolute top-2 right-2 p-1 rounded hover:bg-gray-200 text-gray-500 text-xs z-10.
   折叠态下 absolute 不需要 (顶部 ▶, flex 居中堆叠). */
.sidebar-collapse-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  background: transparent;
  border: none;
  color: var(--tw-gray-500); /* gray-500 */
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  z-index: 10;
}
.sidebar-collapse-btn:hover {
  background: var(--tw-gray-200); /* gray-200 */
}
/* 折叠态下 collapse-btn 不 absolute, 改为普通 flex item (顶部 ▶) */
.sidebar--collapsed .sidebar-collapse-btn {
  position: static;
}
/* R56-B14: 折叠态图标按钮 (8 个系统入口) — 方块点击区, 圆角, hover 浅灰. */
.sidebar-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: transparent;
  border: none;
  color: var(--tw-gray-600); /* gray-600 */
  font-size: 16px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  padding: 0;
}
.sidebar-icon-btn:hover {
  background: var(--tw-gray-200); /* gray-200 */
}
/* R56-B14: 折叠态项目头像圆 (master NavSidebar.tsx:366-375 同款 —
   w-8 h-8 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold) */
.sidebar-project-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--tw-blue-100); /* blue-100 */
  color: var(--tw-blue-700); /* blue-700 */
  font-size: 11px;
  font-weight: 600;
  text-decoration: none;
  transition: background-color 0.15s ease;
  cursor: pointer;
}
.sidebar-project-circle:hover {
  background: var(--tw-blue-200); /* blue-200 */
}
/* R56-B14: 折叠态分割线 — 8 个图标按钮和项目头像之间的视觉分层 (master
   NavSidebar.tsx:308 w-8 border-t border-gray-300 my-1) */
.sidebar-divider {
  width: 32px;
  border-top: 1px solid var(--tw-gray-300); /* gray-300 */
  margin: 4px 0;
}
/* 中间可滚动区: flex: 1 抢占剩余高度, overflow-y: auto 让项目多时只滚这一段.
   min-height: 0 防止 flex 子项默认 min-height: auto 撑破容器.

   R56-B13: 横向 padding 0 8px 保留 — 让项目树 (sidebar-section 内层) 仍在
   侧栏边内 8px, 视觉跟 master 16px 边框对齐. 顶部 section--top 自身用
   margin: 0 -8px + padding: 12px 16px 8px 抵消: bg 撑到 sidebar 边缘
   (sticky 必备, 不透明覆盖滚动内容), 内容仍跟项目树同位 16px. */
.sidebar-middle {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px;
}
.sidebar-section + .sidebar-section {
  margin-top: 14px;
}
/* R56-B13: 顶部 section 从 sidebar 外 sibling 改为 sidebar-middle 内首 child.
   - margin: 0 -8px 把 bg 拉到 sidebar 边缘 (sticky 时背景必须撑满, 不透明覆盖
     下面滚动上来的项目列表, 否则穿透显示).
   - padding: 4px 36px 8px 16px 让 toggle centerY 与 ◀ 对齐 (实测 section
     paddingTop=12 + header paddingTop=4 时 toggle centerY 比 ◀ 低 9px;
     调到 4 + 4 = 8px 后两者齐平), 同时 right=36px 给右上角 ◀ 留位
     (master NavSidebar.tsx pr-8=32px 同款思路 — toggle 跟 ◀ 在 z-index
     都是 10, 不留位 toggle 会盖住 ◀; master pr-8=32 已实测留 2-4px 间距,
     这里加到 36px 更保险).
   - border-bottom 跟中间区视觉分层. */
.sidebar-section--top {
  margin: 0 -8px;
  padding: 4px 36px 8px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}
/* R56-B13: 固定态 — sticky 贴 .sidebar-middle 顶部. bg 来自基础规则, 已经
   不透明. 项目列表滚动时这一段留在视口顶部. */
.sidebar-section--top-sticky {
  position: sticky;
  top: 0;
  z-index: 10;
}
/* R56-B13: header flex 行 — 「快速入口」标题在左, 切换按钮在右. */
.sidebar-top-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 6px;
}
/* R56-B13: 切换按钮 (镜像 master NavSidebar.tsx:449-454 text-xs px-1.5 py-0.5
   rounded transition-colors). 固定态蓝 (text-blue-600 + bg-blue-50 hover),
   活动态灰 (text-gray-500 + bg-gray-200 hover). */
.top-pinned-toggle {
  font-size: 11px; /* text-xs = 12px ≈ SPA 11px, 微调贴近 master */
  padding: 2px 6px; /* px-1.5 py-0.5 */
  border-radius: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  color: var(--tw-gray-500); /* gray-500 */
}
.top-pinned-toggle:hover {
  background: var(--tw-gray-200); /* gray-200 */
}
.top-pinned-toggle--pinned {
  color: var(--tw-blue-600); /* blue-600 */
}
.top-pinned-toggle--pinned:hover {
  background: var(--tw-blue-50); /* blue-50 */
}
/* R33: 底部固定区 (系统) — border-top 与中间区视觉分层, 始终可见. */
.sidebar-section--bottom {
  padding: 4px 8px 6px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  flex-shrink: 0;
}
/* R56-B5: 底部账号区 (master NavSidebar.tsx:511-513 AccountSwitcher sidebar
   变体槽位). AccountSwitcher.vue 自带 .sidebar-trigger 样式, 这里只负责
   section 容器 (border-top 分层 + bg 与 header 同色). */
.sidebar-section--user {
  padding: 4px 8px 22px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  flex-shrink: 0;
}
.sidebar-heading {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 4px 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* R56-B18: heading 右侧项目总数 (镜像 master NavigationTree.tsx:439-442
   ml-auto font-normal tabular-nums). admin 视图下走 ownedProjects 数量,
   跟下方项目循环同口径. */
.sidebar-heading-count {
  margin-left: auto;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
.sidebar-link {
  /* R38 v3: 居左对齐 — 覆盖 .btn 的 justify-content: center (assets/main.css:64),
     让侧栏链接内容贴左不居中, 与 master NavSidebar.tsx:458 flex items-center gap-2
     默认 flex-start 1:1 对齐. 同时保留 display: flex 给 emoji + 文字 + 徽章
     横向排列. */
  display: flex;
  width: 100%;
  /* 覆盖 .btn 全局 justify-content: center —— .btn 在 main.css 是 inline-flex+center,
     会让 sidebar 文字居中而不是左对齐. scoped .sidebar-link 已胜出 display/width,
     但 justify-content 没显式声明被 .btn 中心化穿透. */
  justify-content: flex-start;
  text-align: left;
  align-items: center;
  margin-bottom: 2px;
  padding: 4px 10px;
  border: none;
  background: transparent;
  gap: 8px; /* 镜像 master Tailwind gap-2: emoji span 与文字 span 之间 8px */
  font-size: 13px; /* 镜像 master text-sm: 默认 .btn 14px 偏大, 4 项按钮 × 2px = 省 8px */
}
.sidebar-link:hover {
  background: var(--tw-gray-100);
}
.muted {
  color: var(--color-text-muted);
}
.small {
  font-size: 12px;
  padding: 4px 8px;
}
.project-tree,
.version-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* R56-B6: project-node-inner — draggable handlers + drop indicator 容器.
   position: relative 让上下 drop indicator 绝对定位挂在项目区边缘.
   master NavigationTree.tsx:347 同款做法. */
.project-node-inner {
  position: relative;
}
.project-node-inner--dragging {
  /* 拖拽中半透明, 跟 master opacity-40 同款; R169 拖拽手柄已删, 整行 draggable. */
  opacity: 0.4;
  pointer-events: none;
}
/* 落点指示器 — 上下 2px 蓝线, 在 project-node-inner 边缘. 跟 master
   NavigationTree.tsx:357-360 + 391-393 一致 (h-0.5 bg-blue-500). */
.drop-indicator {
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: var(--tw-blue-500-solid); /* blue-500 */
  border-radius: 1px;
  z-index: 1;
}
.project-node-inner > .drop-indicator:first-child {
  top: -1px;
}
.project-node-inner > .drop-indicator:last-child {
  bottom: -1px;
}
/* R56-B6 + R169: 拖拽手柄已删 (整行 draggable=true 直接拖项目名即可),
   下面只留置顶 toggle 的样式. */
/* R56-B16: 项目置顶 toggle — 默认隐藏感, hover 整行显示; pinned=1 时常驻 amber
   提示用户它排在 pinned DESC 段. cursor: pointer + click.stop 走 store.togglePin
   (乐观更新 + PATCH, 失败 rollback).
   R169: 位于行尾 (count-badge 之后), 用 ml-auto 前的行内 gap 隔开. */
.pin-toggle {
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  color: var(--tw-gray-400); /* gray-400, hover 前 */
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s, color 0.1s;
}
.project-row:hover .pin-toggle {
  opacity: 1;
  pointer-events: auto;
  color: var(--tw-amber-500); /* amber-500 on hover, 提示这是置顶动作 */
}
/* pinned=1: 常驻显示 + 暖色, 不靠 hover; hover 时变深. 跟 master
   text-amber-600 font-medium 同款色调 (这里 font-weight 保持普通以贴侧栏紧凑度). */
.pin-toggle--pinned {
  opacity: 1;
  pointer-events: auto;
  color: var(--tw-amber-600); /* amber-600 */
}
.project-row:hover .pin-toggle--pinned {
  color: var(--tw-amber-700); /* amber-700 */
}
.project-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  /* R56-B6: 13 → 14px, 跟 master text-sm 对齐. +1px 后侧栏整体更接近 master. */
  font-size: 14px;
  /* R56-B6 fix: row.userSelect 实际是 'none' (继承自子树累加, drag-handle
     上设了 user-select: none 让整 row 子树累加 none). 浏览器在 user-select: none
     元素上禁用 HTML5 native drag, 真实鼠标拖拽 dragstart 不触发, 程序化
     dispatchEvent 能绕过. 显式恢复 auto 让 row 上 draggable 真正生效. */
  user-select: auto;
  -webkit-user-select: auto;
}
/* R56-B6: 拖动时 row 整行虚化 (opacity 0.4), 让用户清楚哪一行在拖.
   master NavigationTree.tsx:355 把 opacity-40 放在 wrapper div 上, 但用户
   视角看是"整片" (含展开的 version list). 这里只作用在 row 自己, 视觉
   更精准, 不会让展开列表一起虚化. */
.project-row--dragging {
  opacity: 0.4;
  cursor: grabbing;
}
/* R59: 当前路由命中的项目高亮. 比 :hover 视觉强 (用 primary 蓝边) —
   用户从 URL 直接进 /projects/:id 时一眼看出哪行是当前上下文. */
.project-row--active {
  background: var(--tw-blue-50);
  border-left: 2px solid var(--color-primary);
  padding-left: 6px;
}
.project-row--active:hover {
  background: var(--tw-blue-50);
}
.project-row:hover {
  background: var(--tw-gray-100);
}
.toggle {
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  /* R56-B6: 11 → 12px, 跟 master text-xs 对齐. 三角看着更清晰. */
  font-size: 12px;
  padding: 0;
  /* R56-B6 fix: 子元素 draggable=true 让 mousedown 在 toggle/drag-handle/
     project-name 等子元素时浏览器能从最近的 draggable 祖先发起 dragstart.
     HTML5 drag 规范: mousedown 在子元素上时, 浏览器会查找最近的 draggable
     祖先 (含自身), 从那里发起 drag. 但前提是子元素自身 draggable=true 或
     子元素没阻止默认行为. 显式声明更稳, 避免 mousedown 在 project-name
     时浏览器只走 click 不走 drag. */
  -webkit-user-drag: element;
}
.project-name {
  /* 不要 flex:1 (group 已被 inline-flex 不占满, name 再 flex:1 就成空白).
     truncate 三件套让长名截断, shrink-1 配合 group max-width:100% 生效. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
  min-width: 0;
  -webkit-user-drag: element;
}
/* R56-B17: name + (N) 视觉打包组 (镜像 master NavigationTree.tsx:380-385 flex
   items-center min-w-0 + truncate + shrink-0). 整个 group flex:1 占 name 区,
   name 内 truncate 长名时 (N) 不被吃 (因为 (N) 在 group 内 shrink-0). */
/* R56-B21: name + (N) 视觉打包组. 不要 flex:1 — 否则 group 把整个 row
   占满, (N) 被推右挨 count-badge (用户反馈 "跑到右边去, 隔离太远").
   group 仅 min-width:0 + inline-flex, 整体靠左; count-badge 仍 ml-auto 推到行末.
   name 内 truncate 三件套让长名不撑爆 row. */
.project-name-group {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
  max-width: 100%;
  gap: 4px;
}
/* R169: 行尾 = 数字徽章 + 置顶星. margin-left:auto 挂这里 (单一 auto margin),
   徽章自身的 ml-auto 在 project-row 内被清掉 (见下一条), 否则两个 auto margin
   平分剩余空间把徽章顶到中间. */
.project-row-end {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.project-row .count-badge {
  margin-left: 0;
  padding-left: 0;
}
.version-list {
  margin-left: 22px;
}
.version-row {
  padding: 4px 8px;
  /* R56-B6: 12 → 13px, 跟 master version-row text-sm (略小) 接近. */
  font-size: 13px;
  color: var(--color-text-muted);
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.version-row:hover {
  background: var(--tw-gray-100);
  color: var(--color-text);
}
/* R59: 当前路由命中的版本高亮 (与 .tag.active 蓝边风格一致, 让「侧栏反映
   URL 状态」一眼可读). 优先级比 :hover 高避免被覆盖. */
.version-row--active {
  background: var(--color-bg-elevated);
  color: var(--color-primary);
  font-weight: 500;
}
.version-row--active:hover {
  background: var(--color-bg-elevated);
  color: var(--color-primary);
}
/* R56-B22: 版本名 truncate (跟 master NavigationTree.tsx:415 同款), ⭐
   shrink-0 + margin-right 4px 紧贴名字前. */
.version-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
/* R56-B22: current 版本前的 ⭐ 五角星 (镜像 master NavigationTree.tsx:414).
   放在版本名前, 跟 master 一眼可识别 "默认版本". shrink-0 让长版本名 truncate
   时不被吃掉. font-size 跟版本名一致 (12px), margin-right 4px 跟 emmanagment
   留呼吸. */
.version-current-star {
  flex-shrink: 0;
  font-size: 12px;
  margin-right: 4px;
  line-height: 1;
}
/* R38: 项目级入口行 (其他任务/Board/需求/Wiki 镜像 master NavigationTree
   版本列表下方完整 link). 整行 li + 内嵌 button + 两段 span (emoji + 文字),
   与 version-row 同字号缩进, hover 走浅灰反馈. */
.project-link-row {
  list-style: none;
  margin: 0;
  padding: 0;
}
.project-link {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px 4px 8px;
  margin: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius);
  /* R56-B6: 12 → 13px, 跟 master project-link text-sm 对齐. */
  font-size: 13px;
  color: var(--color-text-muted);
  cursor: pointer;
  text-align: left;
}
.project-link:hover {
  background: var(--tw-gray-100);
  color: var(--color-text);
}

/* R38: 项目名旁版本数 (N) (镜像 master NavigationTree.tsx:384 ml-1 shrink-0
   text-xs text-gray-400 font-normal). */
.project-version-count {
  margin-left: 4px;
  /* R56-B6: 11 → 12px, 跟 master text-xs 对齐. */
  font-size: 12px;
  color: var(--color-text-muted);
  font-weight: 400;
  flex-shrink: 0;
}
/* R38: 数字徽章通用样式 (镜像 master NavigationTree.tsx:280-300 + NavSidebar.tsx
   :54-77). 颜色复用 STATUS_DOT 口径: 蓝=运行, 紫=审核, 黄=暂停; 末尾灰色总数.
   ml-auto 把徽章推到行尾, 与 master flex 布局对齐; 版本行走 ml-1 替代. */
.count-badge {
  margin-left: auto;
  /* R56-B6: 11 → 12px, 跟 master text-xs 对齐 (之前 master 也是 text-xs 12px). */
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  padding-left: 6px;
}
.count-badge--version {
  margin-left: auto;
  padding-left: 6px;
}
.count-badge--link {
  margin-left: auto;
  padding-left: 6px;
  font-size: 11px;
}
.count-badge--global {
  padding-left: 6px;
  font-size: 11px;
}
/* 全局看板 link 走 ml-auto 推徽章到行尾 (与 master NavSidebar.tsx 同款), 不
   必再 justify-content: space-between — 那只对 2 子项生效, 跟现在的「label +
   badge」结构不匹配. */
.sidebar-link--global {
  display: flex;
  align-items: center;
  justify-content: flex-start;
}
.sidebar-link--global .sidebar-link-label {
  flex-shrink: 0;
}
.count-sep {
  color: var(--tw-gray-300);
  margin: 0 1px;
}
.count-running {
  color: var(--tw-blue-500);     /* blue-500 */
}
.count-reviewing {
  color: var(--tw-purple-600);     /* purple-600 */
}
.count-paused {
  color: var(--tw-yellow-600);     /* yellow-600 */
}
.count-total {
  color: var(--tw-gray-400);     /* gray-400 */
}
.count-total--with-parts {
  margin-left: 4px;
}
/* 2026-10-12 全局看板徽章排队段 (damo): 排队=蓝 (对齐状态标签 queued=blue-400 族),
   同徽章内运行段改青 sky (对齐 running=sky-400), 两段可区分. 只作用于全局徽章
   (.count-badge--global 前缀), 项目/版本徽章 running 段仍蓝不受影响. */
.count-queued {
  color: var(--tw-blue-500);     /* blue-500, 同旧 count-running 蓝 */
}
.count-badge--global .count-running {
  color: var(--tw-sky-500-solid);     /* #0ea5e9, 状态标签 running=sky 族 */
}

/* ------------------------------------------------------------------ */
/*  v532: 右键菜单配套样式                                              */
/* ------------------------------------------------------------------ */

/* v532: 行内重命名输入框 — 替换 project-name 位置, 与名字同字号不跳版. */
.rename-input {
  font-size: 14px;
  line-height: 1.2;
  padding: 1px 4px;
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  background: var(--color-bg-elevated);
  color: var(--color-text);
  outline: none;
  min-width: 0;
  width: 100%;
}

/* v532: 行尾收藏 toggle — 与 pin-toggle 同布局口径 (hover 浮出, starred 常驻).
   红色 ♥ 与置顶 amber ★ 双色区分: ★=置顶段, ♥=收藏段. */
.star-toggle {
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  color: var(--tw-gray-400);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s, color 0.1s;
}
.project-row:hover .star-toggle {
  opacity: 1;
  pointer-events: auto;
  color: var(--tw-gray-500);
}
.star-toggle--starred {
  opacity: 1;
  pointer-events: auto;
  color: #e0447c; /* 玫红 — 与 amber ★ 区分 */
}
.project-row:hover .star-toggle--starred {
  color: #c9356b;
}

/* v532: 已归档分组 — 折叠头 (灰、小字) + 展开列表 (缩进与 version-list 对齐,
   行样式弱化: 斜体 + 灰, 视觉上和活跃项目分开). */
.archived-block {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--color-border);
}
.archived-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--radius);
  text-align: left;
}
.archived-header:hover {
  background: var(--tw-gray-100);
}
.archived-count {
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
.archived-list {
  list-style: none;
  margin: 2px 0 0;
  padding: 0 0 0 14px;
}
.archived-row {
  padding: 4px 8px;
  font-size: 13px;
  color: var(--color-text-muted);
  font-style: italic;
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  align-items: center;
}
.archived-row:hover {
  background: var(--tw-gray-100);
  color: var(--color-text);
}
.archived-row--active {
  color: var(--color-primary);
}
.archived-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* v532: 右键菜单 — Teleport body 的 fixed 浮层 (scoped data-v 仍命中:
   Teleport 内容在编译期属于本组件). 深浅主题都走变量. */
.ctx-menu {
  position: fixed;
  z-index: 200; /* 高于侧栏 (60) / drawer backdrop (55) */
  min-width: 168px;
  padding: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 6px;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--tw-gray-100);
}
.ctx-item--danger {
  color: #d64545;
}
.ctx-item--danger:hover {
  background: rgba(214, 69, 69, 0.08);
}
.ctx-glyph {
  width: 18px;
  text-align: center;
  flex-shrink: 0;
  color: var(--color-text-muted);
}
.ctx-glyph--amber {
  color: var(--tw-amber-600);
}
.ctx-glyph--red {
  color: #e0447c;
}
.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--color-border);
}
</style>