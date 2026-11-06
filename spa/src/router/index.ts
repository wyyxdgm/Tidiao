import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useTagsStore } from '@/stores/tags';

const LoginView = () => import('@/views/LoginView.vue');
const RegisterView = () => import('@/views/RegisterView.vue');
const RootView = () => import('@/views/Root.vue');
const ProjectsView = () => import('@/views/ProjectsView.vue');
const ProjectDetailView = () => import('@/views/ProjectDetailView.vue');
const ProjectDetail = () => import('@/views/ProjectDetail.vue');
const VersionDetailView = () => import('@/views/VersionDetailView.vue');
const TaskDetailView = () => import('@/views/TaskDetailView.vue');
const TaskNew = () => import('@/views/TaskNew.vue');
const Schedules = () => import('@/views/Schedules.vue');
const Templates = () => import('@/views/Templates.vue');
const Webhooks = () => import('@/views/Webhooks.vue');
const WebhookDetail = () => import('@/views/WebhookDetail.vue');
const Settings = () => import('@/views/Settings.vue');
const Requirements = () => import('@/views/Requirements.vue');
const RequirementNew = () => import('@/views/RequirementNew.vue');
const RequirementDetail = () => import('@/views/RequirementDetail.vue');
const VersionRequirements = () => import('@/views/VersionRequirements.vue');
const VersionRequirementDetail = () => import('@/views/VersionRequirementDetail.vue');
const Assets = () => import('@/views/Assets.vue');
const Import = () => import('@/views/Import.vue');
const Runners = () => import('@/views/Runners.vue');
const Uncategorized = () => import('@/views/Uncategorized.vue');
const Progress = () => import('@/views/Progress.vue');
const Stats = () => import('@/views/Stats.vue');
const GlobalBoard = () => import('@/views/GlobalBoard.vue');
const Usage = () => import('@/views/Usage.vue');
const Transcript = () => import('@/views/Transcript.vue');
const ProjectUnversioned = () => import('@/views/ProjectUnversioned.vue');
const ProjectUnversionedRequirements = () => import('@/views/ProjectUnversionedRequirements.vue');
// R177: 任务画布总控制台 (单项目全景画布).
const ConsoleCanvas = () => import('@/views/ConsoleCanvas.vue');
const ProjectWiki = () => import('@/views/ProjectWiki.vue');
const VersionBoard = () => import('@/views/VersionBoard.vue');

const MainLayout = () => import('@/layouts/MainLayout.vue');

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { hideInTabs: true },
  },
  {
    // R4: 注册视图, 与 /login 同级 (auth 页面, 不进 MainLayout).
    // hideInTabs=true: 注册是单次动作, 不需要 keep-alive 缓存.
    // 顶部路由级 auth 豁免 (beforeEach 的 to.path !== '/login' 分支) 故意把
    // /register 也加进豁免名单 —— 见下面 beforeEach 注释.
    path: '/register',
    name: 'register',
    component: RegisterView,
    meta: { hideInTabs: true },
  },
  {
    path: '/',
    component: MainLayout,
    children: [
      {
        // 根入口 (R2): 已登录跳 /global, 未登录跳 /login.
        // Root.vue 内部 replace, 不开 keep-alive (hideInTabs).
        path: '',
        name: 'root',
        component: RootView,
        meta: { hideInTabs: true },
      },
      {
        path: 'projects',
        name: 'projects',
        component: ProjectsView,
        meta: { tagTitle: '项目列表', tagTitleKey: 'nav.tabs.projects', tagName: 'projects' },
      },
      {
        // detail-view is a stub for M1 — proves the sidebar click → tag
        // registration → keep-alive cache flow works for dynamic paths.
        path: 'projects/:projectId',
        name: 'project-detail',
        component: ProjectDetailView,
        meta: { tagTitle: '项目', tagTitleKey: 'nav.tabs.projectDetail', tagName: 'project-detail' },
      },
      {
        path: 'projects/:projectId/versions/:versionId',
        name: 'version-detail',
        component: VersionDetailView,
        meta: { tagTitle: '版本', tagTitleKey: 'nav.tabs.versionDetail', tagName: 'version-detail' },
      },
      {
        // R26: 项目+版本下需求列表 — 完整镜像 Next.js /[projectId]/[versionId]/
        // requirements/page.tsx. 顶部条 (项目面包屑 + 清空版本 / 恢复版本 /
        // 重置 / 总入口) + status 过滤 chip + 列表 + 分页 + 创建 modal.
        // URL 接受 ?clear=1 (清空 version 看项目全量) + ?status=xxx (状态过滤,
        // 保留 path + clear 标记). 列表默认按 path 上的 projectId + versionId 锁死.
        path: 'projects/:projectId/versions/:versionId/requirements',
        name: 'version-requirements',
        component: VersionRequirements,
        meta: { tagTitle: '需求点', tagTitleKey: 'nav.tabs.versionRequirements', tagName: 'version-requirements' },
      },
      {
        path: 'tasks/:taskId',
        name: 'task-detail',
        component: TaskDetailView,
        meta: { tagTitle: '任务', tagTitleKey: 'nav.tabs.taskDetail', tagName: 'task-detail' },
      },
      {
        // R23: 新建任务视图 — 完整镜像 Next.js /tasks/new (1561 行).
        // hash 路由下 URL = #/tasks/new?project=&version=&name=&prompt=&...
        // hideInTabs=true: 创建页是单次动作, 不需要 keep-alive 缓存 (与 R15
        // RequirementNew 同款 — 列表 + "新建" 按钮进, 不是主导航常驻).
        // tagName='task-new' 允许多开但 Tab 不持久, 与需求点 R15 对齐.
        path: 'tasks/new',
        name: 'task-new',
        component: TaskNew,
        meta: { tagTitle: '新建任务', tagTitleKey: 'nav.tabs.taskNew', tagName: 'task-new', hideInTabs: true },
      },
      {
        path: 'schedules',
        name: 'schedules',
        component: Schedules,
        meta: { tagTitle: '定时任务', tagTitleKey: 'nav.tabs.schedules', tagName: 'schedules' },
      },
      {
        path: 'templates',
        name: 'templates',
        component: Templates,
        meta: { tagTitle: '模板管理', tagTitleKey: 'nav.tabs.templates', tagName: 'templates' },
      },
      {
        path: 'webhooks',
        name: 'webhooks',
        component: Webhooks,
        meta: { tagTitle: 'Webhooks', tagName: 'webhooks' },
      },
      {
        // R11: webhook 详情视图 — 完整镜像 Next.js /webhooks/[id] 布局
        // (面包屑 + 标题 + 状态 + URL + 订阅事件 + 投递历史).
        // 数据源 GET /api/webhooks/[id]; 投递历史 UI 完整复刻, 数据列暂未对接
        // deliveries REST (master 无此端点, SaaS 跨页过渡, 与 R25 同款).
        path: 'webhooks/:webhookId',
        name: 'webhook-detail',
        component: WebhookDetail,
        meta: { tagTitle: 'Webhook 详情', tagTitleKey: 'nav.tabs.webhookDetail', tagName: 'webhook-detail' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: Settings,
        meta: { tagTitle: '设置', tagTitleKey: 'nav.tabs.settings', tagName: 'settings' },
      },
      {
        path: 'requirements',
        name: 'requirements',
        component: Requirements,
        meta: { tagTitle: '需求点', tagTitleKey: 'nav.tabs.versionRequirements', tagName: 'requirements' },
      },
      {
        // R16: 需求点详情 — 完整镜像 Next.js /requirements/[id] 布局
        // (回链 + 标题 + 状态 dropdown + 描述 + 元信息 + 状态进程条 + 反馈时间线
        //  + 附件列表 + 关联任务森林). URL: #/requirements/[id]?project_id=&version_id=
        // (R107 R 列跟进, 与 R15 RequirementNew 同款 context 携带).
        path: 'requirements/:requirementId',
        name: 'requirement-detail',
        component: RequirementDetail,
        meta: { tagTitle: '需求点详情', tagTitleKey: 'nav.tabs.requirementDetail', tagName: 'requirement-detail' },
      },
      {
        // R15: 新建需求点视图 — 完整镜像 Next.js /requirements/new.
        // hash 路由下 URL = #/requirements/new?project_id=X&version_id=Y.
        // 不在 ProjectSidebar 加入口 (创建页从列表 + "新建" 按钮进, 不是主导航);
        // tagName='requirement-new' 允许多开, 但 hideInTabs 让标签不持久 (单次动作).
        path: 'requirements/new',
        name: 'requirement-new',
        component: RequirementNew,
        meta: { tagTitle: '新建需求点', tagTitleKey: 'nav.tabs.requirementNew', tagName: 'requirement-new', hideInTabs: true },
      },
      {
        path: 'assets',
        name: 'assets',
        component: Assets,
        meta: { tagTitle: '资源池', tagTitleKey: 'nav.tabs.assets', tagName: 'assets' },
      },
      {
        path: 'import',
        name: 'import',
        component: Import,
        meta: { tagTitle: '批量导入', tagTitleKey: 'nav.tabs.import', tagName: 'import' },
      },
      {
        path: 'runners',
        name: 'runners',
        component: Runners,
        meta: { tagTitle: 'Runners', tagTitleKey: 'nav.tabs.runners', tagName: 'runners' },
      },
      {
        path: 'uncategorized',
        name: 'uncategorized',
        component: Uncategorized,
        meta: { tagTitle: '未分类任务', tagTitleKey: 'nav.tabs.uncategorized', tagName: 'uncategorized' },
      },
      {
        path: 'progress',
        name: 'progress',
        component: Progress,
        meta: { tagTitle: '实时进度', tagTitleKey: 'nav.tabs.progress', tagName: 'progress' },
      },
      {
        path: 'stats',
        name: 'stats',
        component: Stats,
        meta: { tagTitle: '统计看板', tagTitleKey: 'nav.tabs.stats', tagName: 'stats' },
      },
      {
        // R5: 全局看板 — 跨项目跨版本汇总所有 task, 8 维筛选 + cards/list/grouped
        // 三视图模式 (kanban/chat 留后续 R+ task). 详情见 vue-spa-migration.md §6.
        path: 'global',
        name: 'global',
        component: GlobalBoard,
        meta: { tagTitle: '全局看板', tagTitleKey: 'nav.tabs.global', tagName: 'global' },
      },
      {
        // idea-canvas P2 (docs/plans/idea-canvas.md): 构思画布 — 跨项目构思层,
        // playcanvas 3D 球体 (关联度/时间线两视图) + 人工分拣列表 + 详情抽屉.
        path: 'ideas',
        name: 'ideas',
        component: () => import('@/views/IdeasView.vue'),
        meta: { tagTitle: '构思画布', tagTitleKey: 'nav.tabs.ideas', tagName: 'ideas' },
      },
      {
        // R8: 用量统计 — 完整镜像 Next.js src/app/usage/page.tsx.
        // 积压概览 (与粒度无关) + 粒度切换 (hour/day/week/month/year) +
        // admin 口径切换 (全部用户/仅我的/仅某用户) + 总量三卡 +
        // 分桶表格 (行展开 by_model) + 各模型总量 + admin scope=all 才出按用户汇总.
        path: 'usage',
        name: 'usage',
        component: Usage,
        meta: { tagTitle: '用量统计', tagTitleKey: 'nav.tabs.usage', tagName: 'usage' },
      },
      {
        // R20: 任务完整会话转录视图 — 完整镜像 Next.js /transcript/[id] 布局
        // (返回任务链接 + 标题 + 状态 chip + 下载 .md/.jsonl + 8 项元数据 +
        // markdown-it 渲染的完整 SDK transcript). 数据源:
        // GET /api/tasks/[id] (元信息) + GET /api/tasks/[id]/transcript?format=markdown
        // (markdown 文本, master route 默认) + .jsonl 下载同路径换 format=jsonl.
        // 不进 ProjectSidebar (task 专属子页, 从 task-detail 进).
        path: 'transcript/:id',
        name: 'transcript',
        component: Transcript,
        meta: { tagTitle: '转录', tagTitleKey: 'nav.tabs.transcript', tagName: 'transcript' },
      },
      {
        // R24: 镜像 Next.js /[projectId] 的 307 redirect 行为 (SPA 用 hash 路由
        // → URL = #/[projectId], 与 Next.js /[projectId] 1:1 镜像). 该页本身
        // 无 UI, 进入即跳到当前版本:
        //   1) current_version_id 存在 → /projects/[id]/versions/[current_version_id]
        //   2) 缺 current_version_id + 有 versions → /projects/[id]/versions/[v0]
        //   3) 完全无 versions → Empty (SPA 无 /unversioned 路由, 落 Empty)
        //   4) project 不存在 → ErrorView + 跳 /projects
        // hideInTabs=true: redirect 单次完成, 不需要 keep-alive 缓存.
        // 必须放在 `/` 子路由最后: Vue Router 按声明顺序匹配, 静态路径 (projects /
        // tasks / ...) 先于 :projectId, 不冲突.
        // 与 R17 ProjectDetailView.vue /projects/:projectId 共存: 两者 URL 不同,
        // R17 走丰富 UI (元数据 + 版本列表), R24 走 redirect-only 镜像 Next 行为.
        path: ':projectId',
        name: 'project-detail-redirect',
        component: ProjectDetail,
        meta: { hideInTabs: true },
      },
      {
        // R177: /board → /console redirect — damo 拍板「直接换掉, 换成 console」.
        // 原 R28 ProjectBoard (board 文件 iframe markdown 看板) 视图退役,
        // 组件文件保留在 views/ (git 可恢复), 老书签/侧栏/wiki 入口自动落到画布.
        path: ':projectId/board',
        redirect: (to) => ({ path: `/${to.params.projectId}/console` }),
      },
      {
        // R29: 项目未挂版本任务视图 — 完整镜像 Next.js /[projectId]/unversioned.
        // hash 路由 → URL = #/[projectId]/unversioned (与 Next.js 1:1 镜像).
        // 数据源: GET /api/projects/[id] 校验项目存在 + 嵌入 R14 BoardPage 走
        // unversioned 模式 (本任务给 BoardPage 加 'unversioned' mode 分支, 发
        // unversioned=true 不发 version, 与 master /api/tasks/page route 协议
        // 对齐).
        // 路由声明顺序: 放在 :projectId/board (R28) 之后, 与它并列都是 2 段
        // 模式 (不同 static 第二段 'board' / 'unversioned', Vue Router 按
        // static 优先级匹配, 无冲突). 与 :projectId (R24 redirect) 共存: R24
        // 只匹配 1 段, 本条 2 段, 不冲突.
        path: ':projectId/unversioned',
        name: 'project-unversioned',
        component: ProjectUnversioned,
        meta: { tagTitle: '其他任务', tagTitleKey: 'nav.tabs.projectUnversioned', tagName: 'project-unversioned' },
      },
      {
        // R30: 项目未挂版本需求点列表 — 完整镜像 Next.js /[projectId]/unversioned/
        // requirements. hash 路由 → URL = #/{projectId}/unversioned/requirements
        // (与 Next.js 1:1 镜像). 强制 version_id=null 过滤未挂版本的需求.
        // 数据源: GET /api/projects/[id] 拿名字 + GET /api/requirements?
        // project_id=&version_id=null&status=xxx 拿列表 + GET /api/requirements/
        // [id]/revisions?limit=1 拿每行最新变更 (R63 时间胶囊). 创建走
        // POST /api/requirements body {project_id, version_id: null, ...}.
        // 路由声明顺序: 放在 :projectId/unversioned (R29) 之后, 与它并列
        // 都是 /{projectId}/unversioned prefix, 但本条 3 段 (多 requirements),
        // R29 是 2 段 (匹配 static 第二段后即停), Vue Router 按段数匹配,
        // 无冲突. 与 :projectId/:versionId/requirements/:id (R27) 共存:
        // 那条 4 段且 static 第二段是 :versionId, 本条 static 第二段是
        // 'unversioned', 不冲突.
        path: ':projectId/unversioned/requirements',
        name: 'project-unversioned-requirements',
        component: ProjectUnversionedRequirements,
        meta: { tagTitle: '未挂版本需求', tagTitleKey: 'nav.tabs.projectUnversionedRequirements', tagName: 'project-unversioned-requirements' },
      },
      {
        // R177: 任务画布总控制台 — 单项目全景画布 (近期聚焦/四象限/等我处理/
        // 排队 + AI 派活入口). URL: #/{projectId}/console. 数据源:
        // GET /api/tasks?projectId= + GET /api/requirements?project_id=,
        // 纯逻辑在 lib/console/canvas-model.ts. 设计文档:
        // docs/plans/task-canvas-console.md. 路由与 :projectId/unversioned
        // (2 段 static 第二段) 并列, static 第二段 'console' 无冲突.
        path: ':projectId/console',
        name: 'project-console',
        component: ConsoleCanvas,
        meta: { tagTitle: '总控制台', tagTitleKey: 'nav.tabs.projectConsole', tagName: 'project-console' },
      },
      {
        // R31: 项目 Wiki 视图 — 完整镜像 Next.js /[projectId]/wiki. hash 路由 →
        // URL = #/{projectId}/wiki (?path= 可选, 缺省 INDEX.md; ?version= 可选,
        // 缺省 current_version_id → 第一个 version). 数据源: GET /api/projects/
        // [id]/wiki/tree (文件树) + /api/projects/[id]/wiki?path= (正文).
        // 渲染走 markdown-it + custom link_open (master react-markdown+remark-gfm
        // 同语义; mermaid 块走 fence 占位 + 客户端 renderMermaidBlocks 替换 SVG).
        // 路由声明顺序: 放在 :projectId/unversioned/requirements (R30) 之后.
        // 与 :projectId (R24 1 段 redirect) / :projectId/board (R28 2 段) /
        // :projectId/unversioned (R29 2 段) / :projectId/unversioned/requirements
        // (R30 3 段) / :projectId/:versionId/requirements/:id (R27 4 段) 共存:
        // 本条 2 段 static 第二段 'wiki', Vue Router 按段数 + static 优先级匹配,
        // 全部互不干扰.
        path: ':projectId/wiki',
        name: 'project-wiki',
        component: ProjectWiki,
        meta: { tagTitle: 'Wiki', tagTitleKey: 'nav.tabs.projectWiki', tagName: 'project-wiki' },
      },
      {
        // R25: 版本看板视图 — 完整镜像 Next.js /[projectId]/[versionId]
        // (该页本身是 RSC wrapper → BoardClient, 不渲染版本元数据 dl).
        // hash 路由 → URL = #/[projectId]/[versionId] (与 Next.js 1:1 镜像).
        // 顶部 chrome = 项目名 + 版本名 + 返回项目, 不展开元数据 dl (元数据展示
        // 走 R18 VersionDetailView.vue, URL = /projects/:projectId/versions/:versionId,
        // 两个 entry 共存). 数据源: GET /api/projects/[id] + GET /api/versions/[id]
        // 并发拿元数据 (master route 两段校验对齐: project 不存在 / version 不存在 /
        // version.project_id 不匹配都视为 404). 复用 R14 BoardPage 走 version 模式
        // (useRoute() 自取 projectId/versionId, 不需要 props 透传).
        // 路由声明顺序: 放在 :projectId/wiki (R31) 之后、:projectId/:versionId/
        // requirements/:id (R27) 之前. 段数 2 vs 4 不冲突; 与 :projectId/wiki 同
        // 为 2 段, 但 wiki 是 static 第二段优先匹配; 与 :projectId/board (R28,
        // static 'board') / :projectId/unversioned (R29, static 'unversioned')
        // 同理互不干扰. 与 R18 VersionDetailView `/projects/:projectId/versions/
        // :versionId` 共存: 两者 URL 不同 (本条 /[projectId]/[versionId], R18
        // /projects/:projectId/versions/:versionId), 走不同 meta.tagName,
        // 各自单独 tag (R18 tagName='version-{vId}', 本条 'version-board-{vId}',
        // 允许多版本同开多个 tab).
        path: ':projectId/:versionId',
        name: 'version-board',
        component: VersionBoard,
        meta: { tagTitle: '版本看板', tagTitleKey: 'nav.tabs.versionBoard', tagName: 'version-board' },
      },
      {
        // R27: 镜像 Next.js /[projectId]/[versionId]/requirements/[id] 的
        // redirect 行为 (SPA hash 路由 → URL = #/[projectId]/[versionId]/requirements/[id],
        // 与 Next.js 1:1 镜像). Next.js 该页面本身无 UI, 进入即跳到全局需求点
        // 详情: redirect(`/requirements/${id}`).
        // SPA 适配: router.replace → /requirements/[id] (?project_id=&version_id= 携带
        // 版本上下文, 与 R16 RequirementDetail URL 形态同款). hideInTabs=true:
        // redirect 单次完成, 不需要 keep-alive 缓存 (与 R24/R15 同款).
        // 必须放在 `:projectId` 之后: Vue Router 按声明顺序匹配, 静态路径 (projects /
        // tasks / ...) + 静态细分 (:projectId/:versionId/requirements/:id) 先于
        // :projectId 单段, 不冲突 (后者只匹配 1 段, 前者要 4 段, 不会误吞).
        // 与 VersionRequirements.vue /projects/:projectId/versions/:versionId/
        // requirements 共存: 那条走 list view (R26), 本条走 detail view redirect.
        // 与 RequirementDetail.vue /requirements/:requirementId 共存: 那条走丰富
        // UI (R16), 本条是 redirect-only 壳, 用户从版本下点进详情时走本条, 最终
        // 落到那条.
        path: ':projectId/:versionId/requirements/:id',
        name: 'version-requirement-detail',
        component: VersionRequirementDetail,
        meta: { hideInTabs: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// Two responsibilities in beforeEach:
// 1. Auth gate: bounce unauth'd users to /login. /login + /register are
//    exempt — both are auth pages that must be reachable without a session
//    (else unauth user clicking "注册" on /login would loop back to /login).
// 2. Tag registration: every non-hideInTabs route registers itself in the
//    tags store so the tab bar shows it and keep-alive caches it.
const PUBLIC_PATHS = new Set(['/login', '/register']);
router.beforeEach(async (to, _from, next) => {
  const auth = useAuthStore();

  // Auth gate.
  if (!PUBLIC_PATHS.has(to.path)) {
    if (auth.sessionState === 'unknown') {
      await auth.checkSession();
    }
    if (auth.sessionState === 'no') {
      return next({ path: '/login', query: { redirect: to.fullPath } });
    }
  }

  next();
});

router.afterEach((to) => {
  // Skip tag registration for routes that opt out (e.g. /login) or that
  // don't carry tag metadata (the layout shell itself).
  if (to.meta?.hideInTabs) return;
  if (!to.meta?.tagName || !to.meta?.tagTitle) return;
  if (to.matched.some((r) => r.meta?.hideInTabs)) return;

  const tags = useTagsStore();
  // R57: <keep-alive :include=...> 用 tag.name 做 cache key. meta.tagName 是
  // 静态字符串 (e.g. 'version-detail'), 同一个路由多实例 (不同 projectId /
  // versionId) 共享同一个 name → keep-alive 只保留一个槽 → 切 tab 触发旧实例
  // 销毁 + 新实例 mount, state (input/scroll) 蒸发. 跟 ProjectSidebar.open*
  // 已用的 path-based key ('version-{vId}' 等) 对齐: 带 params 的路由改用
  // to.path 作 name (天然唯一); 静态路由继续用 meta.tagName (路径唯一 = 单实例
  // = 不冲突). 跟 R56-B23 同一根因线 (keep-alive 缓存复用), 那里是 ProjectDetail
  // 路由参数变了没重拉数据, 这里是不同路由参数本来该独立缓存却被合并.
  //
  // R165 追加 (damo 反馈「任意 tab 点击还是转圈圈蛮久」的根因, prod 实测切
  // tab 触发 6 个请求): keep-alive 的 include 按**组件名**匹配 (comp.name ??
  // comp.__name, SFC 编译器从文件名推断), 旧实现的 name 存的是 to.path /
  // meta.tagName, 与组件名永不相等 → include 从未命中 → 缓存从未生效 → 每次
  // 切 tab 整页重挂载 + 全量重拉 (lanproxy 下每请求 ~200ms 串行瀑布 = 转圈
  // 圈). 改存组件名; 多实例靠 MainLayout 里 <component :key="route.path">
  // 分槽 (include 匹配组件名, 缓存槽按 vnode key 区分), 关 tab 时若同组件
  // 还有别的 tab 开着, 名字仍在 include 里, 其余槽不受影响.
  // lazy 组件在导航完成时已被 vue-router 换成真实组件对象
  // (extractComponentsGuards 回写 record.components.default), 这里拿到的
  // 不是加载函数.
  const lastRecord = to.matched[to.matched.length - 1];
  const comp = lastRecord?.components?.default as
    | { name?: unknown; __name?: unknown }
    | undefined;
  const compName =
    typeof comp?.name === 'string' && comp.name
      ? comp.name
      : typeof comp?.__name === 'string' && comp.__name
        ? comp.__name
        : undefined;
  const cacheName = compName ?? String(to.meta.tagName ?? to.path);
  // query 快照: 切回这个 tab 时还原, 否则 URL-driven 输入 (e.g. BoardPage
  // searchText 绑 route.query.q) 切走就丢. 把数组形态 query 拍平成 string map
  // (hash history 下 to.query 已是 record<string, string|array>, 我们只取
  // 单值场景, 多值用 join 兜底).
  const querySnapshot: Record<string, string> = {};
  for (const [k, v] of Object.entries(to.query)) {
    if (v == null) continue;
    querySnapshot[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  tags.visit({
    name: cacheName,
    title: String(to.meta.tagTitle),
    // i18n (W4.5a): meta.tagTitleKey 存在时 tab 渲染走 locale (语言切换即时跟新),
    // tagTitle 保留作 zh 兜底 (持久化列表恢复 / 未知 key 回落).
    titleKey: typeof to.meta.tagTitleKey === 'string' ? to.meta.tagTitleKey : undefined,
    path: to.path,
    query: querySnapshot,
  });
  tags.currentPath = to.path;
});