<script setup lang="ts">
/* 功能: Project Wiki 渲染页 — 对应 Next.js src/app/[projectId]/wiki/page.tsx +
   wiki-client.tsx 1:1 镜像。包含：
     - 左栏文件树（来自 GET /api/projects/[id]/wiki/tree，递归）
     - 右栏 markdown 渲染（master 用 react-markdown+remark-gfm，本组件用 markdown-it，
       覆盖 h1-h3 / 列表 / 表格 / code / blockquote / link / hr 等常用语法；mermaid
       代码块走 v-html 注入 SVG）
     - 跨项目跳转语法 project:{UUID}?path={relpath}（与 master parseCrossProjectHref
       同语义，整页跳转到目标项目 wiki；权限隔离由目标服务端把关）
     - frontmatter links 渲染为外链按钮条
     - 非 md 文件走纯文本路径（与 master kind:'text' 同步，<pre> 渲染）
     - 版本切换（GET ?version=<id> 影响 tree+正文；URL ?version= 同步）
     - 铺满/居中宽度切换（偏好存 localStorage 'ao-wiki-fullwidth'）
     - 下载原文（GET ?download=1 走 Content-Disposition；触发文件下载）
     - 左栏宽度拖拽调整（按项目存 localStorage 'ao-wiki-sidebar-{projectId}'，
       180-600px 范围限制）
     - H5 (≤900px) 左栏抽屉化：正文占满全宽，目录走 fixed 抽屉 + 遮罩
       （☰ 目录按钮开 / 选文件 / 遮罩 / ESC 关；详情页 R59 同款套路）
     - 顶部 R87 快捷入口（📊 Board / 📋 需求）一键跳项目级其他视图

   关注点 (R31 红线 + 拍板):
   - 复用 Layer 0 组件：Empty (R13) / ErrorView (R13) / Loading (R11) / Button (R7)
     / Select (R9)，不重复实现。
   - markdown-it html 设为 false (类似 react-markdown 默认禁 raw HTML)，非 md 文件
     走 <pre>{text}</pre> 纯文本路径与 master 同步。XSS 防护靠 markdown-it 默认转义 +
     路径白名单 (后端)，本组件不渲染 dangerouslySetInnerHTML 来自用户内容。
   - mermaid 块：markdown-it fence rule 检测 ```mermaid 输出占位 <div class="md-mermaid-block"
     data-mermaid-id=...>；watch 正文 HTML 变化 + onMounted 调 mermaid.render() 替换占位为
     SVG。失败显示原文 + 错误，与 master MermaidBlock UX 一致。
   - 跨项目跳转语义：与 master parseCrossProjectHref 对齐 —— href 前缀 "project:"，
     后跟 UUID + ?path= + 可选 &version=。解析失败的静默 fallback 到外链新窗口。
   - 绝对路径自动识别（与 master resolveAbsoluteProjectPath 对齐）：href 命中某个项目
     cwd 子树 → 自动跳到对应项目 wiki；最长前缀 cwd 匹配防止兄弟 cwd 截胡。
   - 路由参数：useRoute() 拿 projectId，?:path= / ?:version= 在 query 里。R31 挂上
     :projectId/wiki 路由（R31 红线 wiring 范围），URL 形态 1:1 镜像 Next。
   - 顶部 R87 入口：Board 跳 /{projectId}/board?path=boards/project-progress.md；
     需求走 versionId ? /{projectId}/{versionId}/requirements : /{projectId}/unversioned/requirements
     (与 master wiki-client.tsx:380-401 一致)。按钮触发 router.push，标签走 tags store。
   - 拖拽左栏：mousedown 接管 cursor + userSelect + 全局 mousemove/up，松手保存到
     localStorage（master 同款逻辑，详见 wiki-client.tsx:286-311）。 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTagsStore } from '@/stores/tags';
import { useTheme } from '@/lib/theme';
import MarkdownIt from 'markdown-it';
import type { Renderer, RendererRule, Token } from 'markdown-it';
import { get, HttpError } from '@/api/http';
import { useMediaQuery } from '@/composables/useMediaQuery';
import Button from '@/components/Button.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Select from '@/components/Select.vue';
import { formatProjectWithLabel } from '@/lib/format-tab-title';

// markdown-it 15.x RendererRule 类型: (tokens, idx, options, env, self) => string.
// options 是 Required<MarkdownItOptions>; env 是 Env | undefined. 直接用 RendererRule.

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** GET /api/projects/[id] 响应投影 — 拿 project.name 显示在 header.
    cwd / current_version_id 不在本视图用 (服务端会按 current_version_id 兜底), 但
    读一下避免额外请求 (元数据已由 server component 传过, SPA 走单条端点). */
interface ProjectDetail {
  id: string;
  name: string;
  cwd: string | null;
  current_version_id: string | null;
}

/** GET /api/versions?project=<id> 响应投影 — version 选择器 source.
    字段集对齐 master src/lib/db/versions.ts Version (R18 同款, is_current 是数字). */
interface Version {
  id: string;
  name: string;
  is_current: number;
}

/** 文件树节点 — master /api/.../wiki/tree 响应 { tree: TreeNode[] }.
    目录: name + path:'' + children. 文件: name + path: cwd 相对 posix. */
interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

/** 单条链接 (frontmatter links). */
interface WikiLink {
  label: string;
  url: string;
}

/** GET /api/.../wiki?path=<p> 响应 — 与 master route.ts 字段对齐.
    kind:'markdown' 走 md 渲染; kind:'text' 走 <pre> 纯文本.
    exists=false 时 markdown=null + reason 指示原因 (no-cwd/not-found/too-large). */
interface WikiData {
  path: string | null;
  markdown: string | null;
  kind?: 'markdown' | 'text';
  ext?: string;
  links: WikiLink[];
  title: string | null;
  exists: boolean;
  reason?: string;
  size?: number;
  limit?: number;
}

/** 给绝对路径自动识别用的项目 cwd 列表 — 与 master ProjectCwdRef 对齐. */
interface ProjectCwdRef {
  id: string;
  cwd: string | null;
}

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const tags = useTagsStore();
const { t } = useI18n();

/** vue-router 4 params 类型 = string | string[], 单段路由强转 string. */
const projectId = computed(() => String(route.params.projectId));

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const project = ref<ProjectDetail | null>(null);

/** R59: tab 标题 = 「项目(≤8)-Wiki」. project 已加载, 直接 watch name. */
watch(
  () => project.value?.name,
  (name) => {
    if (!name) return;
    tags.applyTitle(route.path, formatProjectWithLabel(name, 'Wiki'));
  },
);
const versions = ref<Version[]>([]);
const allowedExts = ref<string[]>(['md']);
const projectsWithCwd = ref<ProjectCwdRef[]>([]);
const tree = ref<TreeNode[]>([]);
const data = ref<WikiData | null>(null);
const currentPath = ref<string>('INDEX.md');

/** 最近一次 loadPath 请求/成功解析的 path — 守卫 query.path watcher 与
    loadPath 自身 router.replace 同步之间的回环. */
const pendingPath = ref<string>('');
const loading = ref<boolean>(true);
const wikiError = ref<string | null>(null);
const treeError = ref<string | null>(null);
const retrying = ref<boolean>(false);

/** 当前选中的 versionId. null = 用 project.cwd 默认. */
const versionId = ref<string | null>(null);

/** 铺满 vs 居中宽度. 偏好存 localStorage (key 与 master 'ao-wiki-fullwidth' 对齐). */
const fullWidth = ref<boolean>(true);

/** 左栏宽度: 可拖拽调整, 按项目存 localStorage (master 同款, 范围 180-600). */
const sidebarWidth = ref<number>(256);

/** R2xx: H5 (≤900px, 详情页 R59 / ChatView R217v5 同断点) 左栏抽屉化 — isMobile
    必须走 useMediaQuery (R236 教训: 裸 matchMedia 非响应式, computed 拿它当依赖
    永远不重算). */
const isMobile = useMediaQuery('(max-width: 900px)');
/** H5 抽屉开关 — 默认收起 (正文占满全宽); ☰ 目录按钮开, 选文件/遮罩/ESC 关. */
const drawerOpen = ref(false);

/** aside 内联 style — 桌面态才挂拖拽宽度 (详情页 dockInlineStyle 同款): 抽屉态若
    残留 inline width, min(320px,84vw) 的 CSS 宽度会被顶出 390px 屏 (damo 1011 实证). */
const sideStyle = computed(() => (isMobile.value ? undefined : { width: `${sidebarWidth.value}px` }));

/** 桌面→H5 resize 时复位抽屉打开态, 防残留. */
watch(isMobile, (m) => {
  if (m) drawerOpen.value = false;
});

/** R2xx: H5 抽屉打开时 ESC 关闭 (详情页 onDockEsc 同款). */
function onDrawerEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && drawerOpen.value) drawerOpen.value = false;
}

/** 渲染正文容器 ref — mermaid 占位替换 + scroll-to-top 都靠它. */
const mainRef = ref<HTMLElement | null>(null);
const bodyRef = ref<HTMLElement | null>(null);

/** R206: 当前主题 (解析后) — mermaid 图表随主题切 default/dark. */
const { resolved: themeResolved } = useTheme();

/** mermaid 加载态 — 第一次 await import('mermaid') 后才解锁. */
const mermaidReady = ref<boolean>(false);
let mermaidLib: typeof import('mermaid').default | null = null;
/* R206: mermaid 已初始化的主题 — 'default' (浅) / 'dark' (深). 主题切换时需
   re-initialize + 重渲染, 故记录上次用的主题做比对. */
let mermaidTheme: 'default' | 'dark' | null = null;
/* R206: 每次 mermaid.render 的自增序号 — 保证重渲染时 id 不重复. */
let mermaidRenderSeq = 0;

/* ------------------------------------------------------------------ */
/*  markdown-it instance                                               */
/* ------------------------------------------------------------------ */

/** 单例 markdown-it — html:false (禁 raw HTML, 与 master react-markdown 默认语义对齐).
    linkify:true 自动识别裸 URL. typographer:false 关闭排版替换 (中文 wiki 不需要). */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
});

/** markdown-it fence rule: ```mermaid 块替换为占位 <span class="md-mermaid">.
    用 random id 让 mermaid.render 唯一; 占位带 data-code 让客户端后续替换. */
function mermaidFence(tokens: { info: string; content: string }[], idx: number): string {
  const token = tokens[idx];
  if (token.info.trim().split(/\s+/)[0] !== 'mermaid') {
    // 非 mermaid fence 走默认 fence 渲染
    return `<pre class="md-pre"><code class="language-${escapeAttr(token.info.trim())}">${escapeHtml(token.content)}</code></pre>`;
  }
  const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
  // 占位带 data-code (经 escapeHtml 编码; mermaid.render 替换时读 innerText)
  return `<div class="md-mermaid-block" data-mermaid-id="${id}"><pre class="md-mermaid-source">${escapeHtml(token.content)}</pre></div>`;
}

md.renderer.rules.fence = mermaidFence;

/** markdown-it 默认 normalizeLink=encodeURI 会把 href 预编码一次（中文 → %E6..，
    源里手写的 %XX → %25XX）。后续跳 wiki 时再 encodeURIComponent 就成了双重编码，
    后端 decode 一次仍得 %XX 字面量 → 文件 404（R231 taoke 实证）。这里对称 decode
    还原原文；畸形编码序列 decodeURI 会 throw URIError，兜底返回原串。 */
function decodeSafeHref(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

const customLinkOpen: RendererRule = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  const hrefIdx = token.attrIndex('href');
  if (hrefIdx < 0 || !token.attrs) return self.renderToken(tokens, idx, options);
  const href = decodeSafeHref(String(token.attrs[hrefIdx][1]));

  // 1) 跨项目跳转: project:{UUID}?path=...
  const cross = parseCrossProjectHref(href);
  if (cross) {
    const params = new URLSearchParams();
    params.set('path', cross.path);
    if (cross.version) params.set('version', cross.version);
    // 🔴 hash 路由: /#/ 前缀, 点击落 SPA (裸 /{id}/wiki 会撞旧 Next 壳)
    token.attrSet('href', `/#/${cross.projectId}/wiki?${params.toString()}`);
    token.attrSet('class', 'md-link md-link-cross');
    return self.renderToken(tokens, idx, options);
  }

  // 2) 绝对路径命中某项目 cwd
  const absHit = resolveAbsoluteProjectPath(href, projectsWithCwd.value);
  if (absHit) {
    if (absHit.projectId === projectId.value) {
      const target = resolveMdPath(currentPath.value, absHit.path);
      // 同项目: hash 形态 (裸 ?path= 在 hash 路由下点击会丢 # fragment → 跳回 /global)
      // 🔴 必须 #/ 开头: hash 路由标准形态, #pid 缺 / 会让 vue-router 解析错乱 (R231)
      token.attrSet('href', `#/${projectId.value}/wiki?path=${encodeURIComponent(target)}`);
      token.attrSet('class', 'md-link md-link-internal');
      return self.renderToken(tokens, idx, options);
    }
    token.attrSet('href', `/#/${absHit.projectId}/wiki?path=${encodeURIComponent(absHit.path)}`);
    token.attrSet('class', 'md-link md-link-cross');
    return self.renderToken(tokens, idx, options);
  }

  // 3) 内部相对 wiki 链接 (allowedExts 范围内)
  if (isRelativeWikiLink(href, new Set(allowedExts.value))) {
    const target = resolveMdPath(currentPath.value, href);
    // 同项目: hash 形态 (同上, 裸 ?path= 会被 URL 解析丢 fragment)
    // 🔴 必须 #/ 开头: hash 路由标准形态, #pid 缺 / 会让 vue-router 解析错乱 (R231)
    token.attrSet('href', `#/${projectId.value}/wiki?path=${encodeURIComponent(target)}`);
    token.attrSet('class', `md-link md-link-internal ${isMarkdownLink(href) ? 'is-md' : 'is-attachment'}`);
    return self.renderToken(tokens, idx, options);
  }

  // 4) 其他 (http/https/mailto/#...) 走外链新窗口
  token.attrSet('class', 'md-link md-link-external');
  // target=_blank + rel=noopener 已由 markdown-it 默认行为产出 (默认 attribute)
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = customLinkOpen;

/** 把 markdown 渲染为 HTML 字符串 (含 fence 占位 + 自定义 link). */
function renderMarkdown(src: string): string {
  return md.render(src);
}

/* ------------------------------------------------------------------ */
/*  Helpers — port of master src/lib/wiki-links.ts + wiki-files.ts     */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 解析跨项目 wiki 链接. master parseCrossProjectHref 同语义 — 失败返 null. */
function parseCrossProjectHref(href: string): { projectId: string; path: string; version: string | null } | null {
  if (!href || !href.startsWith('project:')) return null;
  const rest = href.slice('project:'.length);
  const noFrag = rest.split('#')[0];
  const qIdx = noFrag.indexOf('?');
  const pid = qIdx >= 0 ? noFrag.slice(0, qIdx) : noFrag;
  if (!pid || !UUID_RE.test(pid)) return null;
  const query = qIdx >= 0 ? noFrag.slice(qIdx + 1) : '';
  let path: string | null = null;
  let version: string | null = null;
  if (query) {
    const params = new URLSearchParams(query);
    const rawPath = params.get('path');
    if (rawPath) path = rawPath;
    const rawVer = params.get('version');
    if (rawVer) version = rawVer;
  }
  if (!path) return null;
  if (path.startsWith('/')) return null;
  if (path.split('/').some((s) => s === '..')) return null;
  return { projectId: pid, path, version };
}

/** 解析 markdown 相对链接 (相对 currentPath), 返回 cwd 相对 posix 路径.
    master resolveMdPath 同语义. */
function resolveMdPath(base: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean) return base;
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const parts = (baseDir + clean).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

/** 提取链接扩展名. master extOf 同语义. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 是否为 markdown 链接. master isMarkdown 同语义 (ext = 'md' 或 'markdown'). */
function isMarkdownLink(href: string): boolean {
  const e = extOf(href.split('#')[0].split('?')[0]);
  return e === 'md' || e === 'markdown';
}

/** 是否为相对 wiki 链接 (allowed 扩展名 + 非 http/https/#/mailto).
    master isRelativeWikiLink 同语义. */
function isRelativeWikiLink(href: string, allowed: Set<string>): boolean {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.startsWith('mailto:')) {
    return false;
  }
  const clean = href.split('#')[0].split('?')[0];
  return allowed.has(extOf(clean));
}

/** 规范化 href 为 WSL 绝对路径形态, 便于 cwd 前缀匹配命中.
    master normalizeHrefForCwdMatch 同语义. */
function normalizeHrefForCwdMatch(href: string): string {
  if (!href || typeof href !== 'string') return href;
  if (href.startsWith('~/')) return `/home/user/${href.slice(2)}`;
  if (!href.startsWith('/')) return href;
  if (href.startsWith('//')) return href;
  if (/^\/[A-Za-z]:\//.test(href)) return href;
  // mac → wsl
  if (href.startsWith('/Users/user/')) return `/home/user/${href.slice('/Users/user/'.length)}`;
  // /workspace/x → /home/user/workspace/x
  if (href.startsWith('/workspace/') && !href.startsWith('/home/user/workspace/')) {
    return `/home/user${href}`;
  }
  return href;
}

/** 绝对路径命中项目 cwd → (projectId, 相对路径). master resolveAbsoluteProjectPath 同语义. */
function resolveAbsoluteProjectPath(href: string, projects: ProjectCwdRef[]): { projectId: string; path: string } | null {
  if (!href || !href.startsWith('/')) return null;
  if (!Array.isArray(projects)) return null;
  if (href.startsWith('//') || /^\/[A-Za-z]:\//.test(href)) return null;
  const normalized = normalizeHrefForCwdMatch(href);
  const sorted = projects
    .filter((p): p is { id: string; cwd: string } => !!p.cwd)
    .slice()
    .sort((a, b) => b.cwd.length - a.cwd.length);
  for (const p of sorted) {
    if (normalized === p.cwd) return null;
    if (normalized.startsWith(p.cwd + '/')) {
      return { projectId: p.id, path: normalized.slice(p.cwd.length + 1) };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  HTML escape helpers                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

/** 加载项目元数据 + 版本列表 + 可见项目 cwd 列表 (后端 wiki route 已透传 allowedExts
    与 projectsWithCwd; 当前 SPA 设计没 server component 注入, 走单条 GET 即可).
    这里走 /api/projects/[id] + /api/versions?project= + /api/projects 三路并行. */
async function loadMeta(): Promise<void> {
  try {
    const [projRes, verRes, allRes] = await Promise.all([
      get<{ project: ProjectDetail }>(`/api/projects/${projectId.value}`),
      get<{ versions: Version[] }>(`/api/versions?project=${encodeURIComponent(projectId.value)}`),
      get<{ projects: Array<{ id: string; cwd: string | null }> }>('/api/projects'),
    ]);
    project.value = projRes.project;
    versions.value = Array.isArray(verRes.versions) ? verRes.versions : [];
    projectsWithCwd.value = (allRes.projects ?? []).map((p) => ({ id: p.id, cwd: p.cwd }));
    // 解析 initial versionId: URL ?version= > current_version_id > 第一个 version > null
    const urlVersion = String(route.query.version ?? '');
    versionId.value = urlVersion || projRes.project.current_version_id || versions.value[0]?.id || null;
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      wikiError.value = e.message || t('projects.wiki.errHttp', { status: e.status });
    } else {
      wikiError.value = t('projects.wiki.errMeta');
    }
  }
}

/** 加载文件树. ?version= 影响取哪个 cwd. */
async function loadTree(): Promise<void> {
  treeError.value = null;
  try {
    const vParam = versionId.value ? `?version=${encodeURIComponent(versionId.value)}` : '';
    const r = await get<{ tree: TreeNode[] }>(`/api/projects/${projectId.value}/wiki/tree${vParam}`);
    tree.value = Array.isArray(r.tree) ? r.tree : [];
  } catch (e: unknown) {
    tree.value = [];
    if (e instanceof HttpError) {
      treeError.value = e.message || t('projects.wiki.errHttp', { status: e.status });
    } else {
      treeError.value = t('projects.wiki.errTree');
    }
  }
}

/** 加载指定 path 的正文. 同时维护 URL ?path= 同步.
    关注点: hash 路由下 query 必须落在 #/ 内 —— 旧实现 new URL+searchParams 会把
    ?path= 写到 hash 前面, 复制出来的 URL 重开后 router 读不到. 改走 router.replace.
    兼容: ?path= 传绝对路径时按项目 cwd 归一成相对路径 (服务端
    decideAbsolutePathRedirect 的 SPA 等价), 跨项目命中直接整跳目标项目 wiki. */
async function loadPath(raw: string): Promise<void> {
  pendingPath.value = raw;
  loading.value = true;
  try {
    let p = raw;
    if (p.startsWith('/')) {
      const hit = resolveAbsoluteProjectPath(p, projectsWithCwd.value);
      if (hit && hit.projectId !== projectId.value) {
        loading.value = false;
        await router.push({ path: `/${hit.projectId}/wiki`, query: { path: hit.path } });
        return;
      }
      if (hit) p = hit.path;
    }
    const vParam = versionId.value ? `&version=${encodeURIComponent(versionId.value)}` : '';
    let r = await get<WikiData>(`/api/projects/${projectId.value}/wiki?path=${encodeURIComponent(p)}${vParam}`);
    // 兜底: 旧版 bug 生成的 URL 里 path 是预编码形态 (%E6.., R231), decode 一次重试,
    // 让 damo 手持的历史链接/书签也能打开; 不存在且无 %XX 时跳过, 不多发请求.
    if (!r.exists && /%[0-9a-f]{2}/i.test(p)) {
      try {
        const p2 = decodeURIComponent(p);
        if (p2 !== p) {
          r = await get<WikiData>(`/api/projects/${projectId.value}/wiki?path=${encodeURIComponent(p2)}${vParam}`);
        }
      } catch {
        // 畸形编码序列, 保持第一次结果
      }
    }
    data.value = r;
    if (r.exists && r.path) {
      currentPath.value = r.path;
      pendingPath.value = r.path;
      // 同步地址栏 (query 落在 hash 内; catch 重复导航的 rejection)
      try {
        const q: Record<string, string> = { path: r.path };
        if (versionId.value) q.version = versionId.value;
        void router.replace({ query: q }).catch(() => {});
      } catch {
        // ignore
      }
    }
  } catch (e: unknown) {
    data.value = null;
    if (e instanceof HttpError) {
      wikiError.value = e.message || t('projects.wiki.errHttp', { status: e.status });
    } else {
      wikiError.value = t('projects.wiki.errDoc');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function retry(): void {
  retrying.value = true;
  void loadPath(currentPath.value);
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function selectPath(p: string): void {
  if (isMobile.value) drawerOpen.value = false; // H5: 选完文件收抽屉, 正文回到全宽
  void loadPath(p);
}

function toggleFullWidth(): void {
  fullWidth.value = !fullWidth.value;
  try {
    localStorage.setItem('ao-wiki-fullwidth', fullWidth.value ? '1' : '0');
  } catch {
    // localStorage 可能被禁用 (隐私模式等), 静默忽略 — 仅丢偏好, 不影响功能
  }
}

/** 拖拽左栏右边缘调整宽度; 松手按项目存 localStorage (master 同款逻辑).
    关注点: move/up 闭包定义在 mousedown 内, 用 startW+dx 避免状态闭包过期; 松手用
    函数式 setState 读最新值. cleanup 在 onBeforeUnmount 兜底 (keep-alive + 路由切换
    时若残留 cursor/userSelect 会卡死整个 UI). */
function handleSidebarDrag(ev: MouseEvent): void {
  ev.preventDefault();
  const startX = ev.clientX;
  const startW = sidebarWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const onMove = (e: MouseEvent) => {
    const next = Math.max(180, Math.min(600, startW + e.clientX - startX));
    sidebarWidth.value = next;
  };
  const onUp = () => {
    try {
      localStorage.setItem(`ao-wiki-sidebar-${projectId.value}`, String(sidebarWidth.value));
    } catch {
      // localStorage 可能被禁用, 静默忽略
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/** R87→R177: 顶部「🎬 控制台」快捷入口. 原跳 markdown 看板 (/board?
    path=boards/project-progress.md), damo 2026-10-03 拍板换掉 → console
    (路由层 /board 已 redirect 兜底, 这里直接指 /console 免一跳). */
function openBoard(): void {
  const path = `/${projectId.value}/console`;
  tags.visit({
    name: `project-console-${projectId.value}`,
    title: t('projects.wiki.consoleTab', { name: project.value?.name ?? projectId.value }),
    path,
  });
  void router.push(path);
}

/** R87: 顶部「📋 需求」快捷入口 — 当前 versionId 走版本下需求列表, 否则走未挂版本.
    与 master wiki-client.tsx:391-401 1:1 对齐. */
function openRequirements(): void {
  const path = versionId.value
    ? `/${projectId.value}/${versionId.value}/requirements`
    : `/${projectId.value}/unversioned/requirements`;
  tags.visit({
    name: versionId.value
      ? `version-requirements-${versionId.value}`
      : `project-unversioned-requirements-${projectId.value}`,
    title: t('projects.wiki.reqTab', { name: project.value?.name ?? projectId.value }),
    path,
  });
  void router.push(path);
}

function changeVersion(v: string | null): void {
  versionId.value = v || null;
  currentPath.value = 'INDEX.md';
  // 同步 URL ?version= (hash 路由: router.replace 把 query 落在 #/ 内; 跨版本旧 path 清掉)
  try {
    const q: Record<string, string> = {};
    if (v) q.version = v;
    void router.replace({ query: q }).catch(() => {});
  } catch {
    // ignore
  }
  void loadTree();
  void loadPath('INDEX.md');
}

function downloadCurrent(): void {
  if (!data.value || !data.value.exists || !data.value.path) return;
  const vParam = versionId.value ? `&version=${encodeURIComponent(versionId.value)}` : '';
  const url = `/api/projects/${projectId.value}/wiki?path=${encodeURIComponent(data.value.path)}${vParam}&download=1`;
  // 走 <a download> 触发浏览器下载 (与 master download 按钮同语义)
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** 字节数 → 人类可读 (KB/MB). master fmtBytes 同语义, 用于 too-large 提示. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  Computed — derived view state                                      */
/* ------------------------------------------------------------------ */

/** 渲染后的正文 HTML (markdown-it 输出 + 占位). */
const bodyHtml = computed<string>(() => {
  if (!data.value || !data.value.exists || data.value.markdown === null) return '';
  return renderMarkdown(data.value.markdown);
});

/** frontmatter links (顶部 chips). */
const frontmatterLinks = computed<WikiLink[]>(() => data.value?.links ?? []);

/** 是否显示 frontmatter links 区块. */
const hasFrontmatterLinks = computed(() => frontmatterLinks.value.length > 0);

/** 是否展示 version 选择器 (有版本时才显示). */
const hasVersions = computed(() => versions.value.length > 0);

/** 下载按钮可见性. */
const canDownload = computed(() => !!(data.value && data.value.exists && data.value.path));

/* ------------------------------------------------------------------ */
/*  Mermaid rendering                                                  */
/* ------------------------------------------------------------------ */

/** 异步加载 mermaid 库 (浏览器端 only; SPA 本身就是客户端组件, 无 SSR 顾虑, 但保留
    dynamic import 让 mermaid 不进初始 bundle, 加快首屏). */
async function ensureMermaid(): Promise<typeof import('mermaid').default | null> {
  const want: 'default' | 'dark' = themeResolved.value === 'dark' ? 'dark' : 'default';
  // 已加载且主题未变 → 直接复用; 主题变了 → 重新 initialize (mermaid 无 setTheme).
  if (mermaidLib && mermaidTheme === want) return mermaidLib;
  try {
    const mod = await import('mermaid');
    mermaidLib = mod.default;
    mermaidLib.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: want,
    });
    mermaidTheme = want;
    mermaidReady.value = true;
    return mermaidLib;
  } catch {
    mermaidReady.value = false;
    return null;
  }
}

/** 在 bodyRef 里找占位 <div class="md-mermaid-block" data-mermaid-id="..."> 并替换为 SVG.
    失败显示原文 + 错误 (与 master MermaidBlock 错误态一致). */
async function renderMermaidBlocks(): Promise<void> {
  if (!bodyRef.value) return;
  const mermaid = await ensureMermaid();
  if (!mermaid) return;
  const blocks = Array.from(bodyRef.value.querySelectorAll<HTMLElement>('.md-mermaid-block'));
  for (const block of blocks) {
    if (block.dataset.rendered === '1') continue;
    // R206: 首次渲染时把源码存进 dataset — 之后 innerHTML 被 SVG 替换, .md-mermaid-source
    // 已不存在; 主题切换重渲染时从 dataset 取回源码.
    const source = block.querySelector<HTMLPreElement>('.md-mermaid-source');
    if (source?.textContent != null) block.dataset.source = source.textContent;
    const code = block.dataset.source ?? '';
    // 每次渲染用新 id: mermaid.render 会临时建同 id 元素, 重渲染同 id 可能冲突.
    const id = `${block.dataset.mermaidId || 'mermaid'}-${++mermaidRenderSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      block.innerHTML = `<div class="mermaid-svg">${svg}</div>`;
      block.dataset.rendered = '1';
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      block.innerHTML = `<div class="mermaid-error"><div class="mermaid-error-title">${escapeHtml(t('projects.wiki.mermaidError'))}</div><pre class="mermaid-error-source">${escapeHtml(code)}</pre><div class="mermaid-error-msg">${escapeHtml(errMsg)}</div></div>`;
      block.dataset.rendered = '1';
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/** 挂载: 恢复偏好 → 拉元数据 → 拉树 → 拉初始文档.
    初始 path 走 URL ?path=, 否则 INDEX.md (master 行为). */
onMounted(async () => {
  try {
    const saved = localStorage.getItem('ao-wiki-fullwidth');
    if (saved !== null) fullWidth.value = saved === '1';
  } catch {
    // ignore
  }
  // 左栏宽度: 按项目恢复 (master wiki-client.tsx:271-277 同款).
  try {
    const savedW = localStorage.getItem(`ao-wiki-sidebar-${projectId.value}`);
    if (savedW) {
      const w = parseInt(savedW, 10);
      if (!isNaN(w) && w >= 180 && w <= 600) sidebarWidth.value = w;
    }
  } catch {
    // ignore
  }
  await loadMeta();
  await loadTree();
  const initialPath = String(route.query.path ?? '') || 'INDEX.md';
  await loadPath(initialPath);
  document.addEventListener('keydown', onDrawerEsc);
});

/** 清理: 拖拽中途组件被卸载, 还原 body cursor / userSelect 防止 UI 卡死.
    keep-alive 切走 / 路由切走 都会触发. */
onBeforeUnmount(() => {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.removeEventListener('keydown', onDrawerEsc);
});

/** 切换文档后: 滚回顶部 + 重渲染 mermaid. */
watch(bodyHtml, () => {
  nextTick(() => {
    mainRef.value?.scrollTo({ top: 0 });
    void renderMermaidBlocks();
  });
});

/** R206: 主题切换 → 重置 mermaid 已渲染标记, 用新主题重渲染 (mermaid 无 setTheme). */
watch(themeResolved, () => {
  const root = bodyRef.value;
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.md-mermaid-block').forEach((b) => {
    delete b.dataset.rendered;
  });
  void renderMermaidBlocks();
});

/** route.params.projectId 变化 (跨项目 hash 跳转) → 重拉全部.
    带 ?path= 深链时直接落到目标 path (projectsWithCwd 是全项目列表, 归一化不依赖 loadMeta). */
watch(projectId, () => {
  void loadMeta();
  void loadTree();
  const qp = route.query.path ? String(route.query.path) : 'INDEX.md';
  void loadPath(qp);
});

/** route.query.path 变化 (hash 形态内部链接 #/{pid}/wiki?path= 点击) → 重载正文.
    守卫: loadPath 成功后自己会 router.replace 同步 query.path, pendingPath /
    currentPath 命中即跳过, 防回环. */
watch(
  () => route.query.path,
  (np) => {
    const p = np == null ? null : String(np);
    if (!p) return;
    if (p === pendingPath.value || p === currentPath.value) return;
    void loadPath(p);
  },
);
</script>

<template>
  <div class="wiki-page">
    <!-- Header: breadcrumb + project name + toolbar -->
    <header class="wiki-header">
      <div class="wiki-breadcrumb">
        <span class="crumb">{{ t('projects.wiki.crumbProject') }}</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-active">{{ project?.name ?? projectId }}</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-active">Wiki</span>
      </div>
      <div class="wiki-title-row">
        <h1 class="wiki-title">{{ t('projects.wiki.title', { name: project?.name ?? t('projects.wiki.fallbackName') }) }}</h1>
        <div class="wiki-toolbar">
          <!-- R2xx: H5 目录抽屉开关 — 桌面态 display:none, ≤900px 显示. -->
          <Button variant="ghost" size="sm" class="wiki-tree-toggle" :title="t('projects.wiki.tocBtnTitle')" @click="drawerOpen = true">
            {{ t('projects.wiki.tocBtn') }}
          </Button>
          <!-- R87: 顶部快捷入口 — 与 Next.js wiki-client.tsx:380-401 1:1 镜像.
              样式与 ghost 按钮对齐, 桌面端显示 (R87 注释: 与左侧导航一致避免用户两边找入口). -->
          <Button variant="ghost" size="sm" class="wiki-shortcut-btn" :title="t('projects.wiki.consoleBtnTitle')" @click="openBoard">
            {{ t('projects.wiki.consoleBtn') }}
          </Button>
          <Button variant="ghost" size="sm" class="wiki-shortcut-btn" :title="t('projects.wiki.reqBtnTitle')" @click="openRequirements">
            {{ t('projects.wiki.reqBtn') }}
          </Button>
          <Select
            v-if="hasVersions"
            :model-value="versionId ?? ''"
            :options="versions.map((v) => ({ value: v.id, label: v.name }))"
            :placeholder="t('projects.wiki.selectVersion')"
            class-name="wiki-version-select"
            @update:model-value="changeVersion"
          />
          <Button variant="ghost" size="sm" @click="toggleFullWidth">
            {{ fullWidth ? t('projects.wiki.fullwidth') : t('projects.wiki.centered') }}
          </Button>
          <Button v-if="canDownload" variant="ghost" size="sm" @click="downloadCurrent">
            {{ t('projects.wiki.download') }}
          </Button>
        </div>
      </div>
    </header>

    <!-- Body: 左树 + 右正文 -->
    <div :class="['wiki-body', fullWidth ? 'full-width' : 'centered']">
      <!-- 左栏: 文件树 (可拖拽调宽, 宽度按项目存 localStorage; ≤900px 抽屉化) -->
      <div
        class="wiki-side"
        :class="{ 'wiki-side--drawer-open': drawerOpen }"
        :style="sideStyle"
      >
        <aside class="wiki-tree-card">
          <!-- R2xx: H5 抽屉标题行 — 详情页 dock-drawer-header 同款, 桌面 display:none. -->
          <div class="wiki-drawer-header">
            <span class="wiki-drawer-title">{{ t('projects.wiki.drawerTitle') }}</span>
            <button type="button" class="wiki-drawer-close" :title="t('common.close')" @click="drawerOpen = false">×</button>
          </div>
          <div class="wiki-tree-heading">{{ t('projects.wiki.docsHeading') }}</div>
          <Loading v-if="!treeError && tree.length === 0" size="sm" :label="t('projects.wiki.loadingTreeLabel')" />
          <Empty
            v-else-if="!treeError && tree.length === 0"
            illustration="folder"
            :title="t('projects.wiki.noFiles')"
            :description="t('projects.wiki.allowedExts', { exts: allowedExts.map((e) => '.' + e).join(' ') })"
            size="sm"
          />
          <p v-else-if="treeError" class="wiki-tree-error">{{ treeError }}</p>
          <WikiTree
            v-else
            :nodes="tree"
            :current-path="currentPath"
            @select="selectPath"
          />
        </aside>
        <!-- 拖拽手柄: 模仿 master wiki-client.tsx:456-460 绝对定位 + cursor-col-resize.
            mousedown 接管 cursor + userSelect, mousemove/up 在 window 上监听.
            H5 抽屉态不可拖 (CSS display:none). -->
        <div
          class="wiki-resize-handle"
          :title="t('projects.wiki.resizeTitle')"
          @mousedown="handleSidebarDrag"
        ></div>
      </div>

      <!-- R2xx: H5 抽屉遮罩 — 点击关闭. 桌面 display:none (详情页 R59 回归教训:
          显隐必须 CSS 限断点, 不能只靠 JS 状态, 防 resize 残留全屏蒙层). -->
      <div class="wiki-backdrop" :class="{ open: drawerOpen }" @click="drawerOpen = false"></div>

      <!-- 右栏: 正文 -->
      <main ref="mainRef" class="wiki-main">
        <Loading v-if="loading && !data" size="md" :label="t('projects.wiki.loadingDocLabel')" />

        <ErrorView
          v-else-if="wikiError && !data"
          variant="error"
          :title="t('projects.wiki.loadFailedTitle')"
          :description="wikiError"
          :retrying="retrying"
          @retry="retry"
        />

        <div
          v-else-if="!data || !data.exists"
          class="wiki-missing"
        >
          <!-- 文案含 <code>/<br/> 标签 — 走 locale 消息 + v-html (locale 内容可信,
               无用户输入; i18n W3b). -->
          <p v-if="data?.reason === 'no-cwd'" v-html="t('projects.wiki.noCwdHtml')"></p>
          <p v-else-if="data?.reason === 'too-large'" v-html="t('projects.wiki.tooLargeHtml', { path: currentPath, size: fmtBytes(data.size ?? 0), limit: fmtBytes(data.limit ?? 0) })"></p>
          <p v-else v-html="t('projects.wiki.notFoundHtml', { path: currentPath })"></p>
        </div>

        <!-- kind:text → 纯文本路径 (与 master 一致) -->
        <div v-else-if="data.kind === 'text'" class="wiki-text-block">
          <div class="wiki-text-head">
            <span class="wiki-text-ext">{{ (data.ext || 'text').toUpperCase() }}</span>
            <span class="wiki-text-path">{{ data.path }}</span>
          </div>
          <pre class="wiki-text-pre">{{ data.markdown || '' }}</pre>
        </div>

        <!-- kind:markdown → 渲染 -->
        <article v-else class="wiki-article">
          <div v-if="hasFrontmatterLinks" class="wiki-frontmatter-links">
            <a
              v-for="(l, i) in frontmatterLinks"
              :key="i"
              :href="l.url"
              target="_blank"
              rel="noopener noreferrer"
              class="wiki-frontmatter-link"
            >
              🔗 {{ l.label }}
            </a>
          </div>
          <div ref="bodyRef" class="wiki-body-md" v-html="bodyHtml"></div>
        </article>
      </main>
    </div>
  </div>
</template>

<script lang="ts">
/* ------------------------------------------------------------------ */
/*  WikiTree 子组件 — 递归渲染文件树 (h() 函数式组件，避免 JSX).       */
/*  单文件组件内嵌子组件 (与 master wiki-client.tsx 的 TreeView 同款): */
/*    - 目录用 <details open> 可折叠 (默认展开)                       */
/*    - 文件用 <button> 点击触发 select 事件                           */
/*  不放在外部 .vue 文件 = 严格遵守 R27 红线 "只动 Wiki.vue"。       */
/* ------------------------------------------------------------------ */

import { defineComponent, h, type PropType, type VNode } from 'vue';

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

export const WikiTree = defineComponent({
  name: 'WikiTree',
  props: {
    nodes: { type: Array as PropType<TreeNode[]>, required: true },
    currentPath: { type: String, required: true },
  },
  emits: {
    select: (_p: string) => true,
  },
  setup(props, { emit }) {
    return () => {
      const renderNode = (n: TreeNode): VNode => {
        if (n.children) {
          return h('details', { open: true }, [
            h('summary', { class: 'tree-folder' }, [
              h('span', { class: 'tree-icon' }, '📁'),
              n.name,
            ]),
            h(
              'ul',
              { class: 'tree-children' },
              n.children.map((c) => h('li', { key: c.path || c.name }, renderNode(c))),
            ),
          ]);
        }
        const isActive = n.path === props.currentPath;
        return h(
          'button',
          {
            type: 'button',
            class: ['tree-file', isActive ? 'active' : ''],
            title: n.path,
            onClick: () => emit('select', n.path),
          },
          n.name,
        );
      };

      return h(
        'ul',
        { class: 'wiki-tree' },
        props.nodes.map((n) => h('li', { key: n.path || n.name }, renderNode(n))),
      );
    };
  },
});
</script>

<style scoped>
.wiki-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

/* Header */
.wiki-header {
  flex-shrink: 0;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  padding: 14px 24px 12px;
}
.wiki-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.crumb-sep {
  color: var(--color-text-muted);
  opacity: 0.6;
}
.crumb-active {
  color: var(--color-text);
  font-weight: 500;
}
.wiki-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.wiki-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.wiki-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.wiki-version-select {
  min-width: 140px;
}

/* Body layout */
.wiki-body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 16px;
  padding: 16px 24px;
}
.wiki-body.full-width {
  flex-direction: row;
}
.wiki-body.centered {
  flex-direction: row;
  max-width: 1280px;
  margin: 0 auto;
  width: 100%;
}

/* Side (file tree) */
.wiki-side {
  flex-shrink: 0;
  width: 260px;
  position: relative;
  min-width: 180px;
  max-width: 600px;
}
.wiki-tree-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  height: 100%;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
}
.wiki-tree-heading {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}
.wiki-tree-error {
  font-size: 12px;
  color: var(--color-danger, #dc2626);
  margin: 0;
}

/* 拖拽手柄: 模仿 master wiki-client.tsx:456-460 (绝对定位右移 + cursor-col-resize). */
.wiki-resize-handle {
  position: absolute;
  top: 0;
  right: -4px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  border-radius: 3px;
  transition: background 0.15s;
}
.wiki-resize-handle:hover {
  background: var(--color-primary, #3b82f6);
  opacity: 0.6;
}
.wiki-resize-handle:active {
  background: var(--color-primary, #2563eb);
  opacity: 0.8;
}

/* R2xx: H5 抽屉三件套 — 桌面态全部 display:none, ≤900px media 里启用.
   (详情页 R59 同款: 显隐由 CSS 断点把关, JS 只管 open class) */
.wiki-tree-toggle {
  display: none;
}
.wiki-drawer-header {
  display: none;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  position: sticky;
  top: 0;
  z-index: 1;
}
.wiki-drawer-title {
  font-size: 14px;
  font-weight: 600;
}
.wiki-drawer-close {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  line-height: 1;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius);
}
.wiki-drawer-close:hover {
  background: var(--color-bg);
  color: var(--color-text);
}
.wiki-backdrop {
  display: none;
}

/* R87: 顶部 Board / 需求 快捷入口 (Next.js 桌面端 inline-flex 显示, <sm 隐藏).
    SPA Button ghost size=sm 已带 padding, 这里只补桌面端/移动端的可见性切换. */
@media (max-width: 640px) {
  .wiki-shortcut-btn {
    display: none !important;
  }
}

/* R2xx: H5 (≤900px) 左栏抽屉化 — 详情页 R59 / ChatView R217v5 同款套路.
   原来 fixed 260px 左栏在手机上把正文挤成一条竖线; 现在 H5 态正文占满全宽,
   目录走 fixed 抽屉 + 遮罩: ☰ 目录按钮开, 选文件 / 遮罩 / × / ESC 关. */
@media (max-width: 900px) {
  .wiki-header {
    padding: 10px 14px;
  }
  .wiki-title {
    font-size: 17px;
  }
  .wiki-title-row {
    flex-wrap: wrap;
    row-gap: 8px;
  }
  .wiki-toolbar {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .wiki-tree-toggle {
    display: inline-flex;
  }
  .wiki-body {
    padding: 12px 14px;
    gap: 0;
  }
  /* centered 模式的 1280 上限在 H5 无意义, 解除让正文通栏 */
  .wiki-body.centered {
    max-width: none;
  }
  .wiki-main {
    padding: 14px 16px;
  }
  .wiki-side {
    position: fixed;
    top: 80px; /* AppHeader 44 + tags tab 栏到 80 (H5 实测), 详情页 R59 top:88 同思路 */
    left: 0;
    bottom: 0;
    /* !important 兜底: 防任何残留 inline width 把 390px 屏上的抽屉顶出画 */
    width: min(320px, 84vw) !important;
    min-width: 0;
    max-width: none;
    z-index: 60;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .wiki-side--drawer-open {
    transform: translateX(0);
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.25);
  }
  .wiki-side .wiki-resize-handle {
    display: none;
  }
  .wiki-tree-card {
    max-height: none;
    height: 100%;
    border-radius: 0;
    padding-top: 0;
  }
  .wiki-drawer-header {
    display: flex;
  }
  .wiki-tree-heading {
    display: none;
  }
  .wiki-backdrop {
    display: block;
    position: fixed;
    top: 80px; /* 与抽屉同顶, 不盖全局 header / tab 栏 */
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 55;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  .wiki-backdrop.open {
    opacity: 1;
    pointer-events: auto;
  }
}

/* Main content area */
.wiki-main {
  flex: 1;
  min-height: 0;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 20px 28px;
  overflow-y: auto;
  min-width: 0;
}
.wiki-missing {
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1.7;
}
.wiki-missing code {
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  color: var(--color-text);
}

/* Text block (非 md) */
.wiki-text-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wiki-text-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border);
}
.wiki-text-ext {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg);
  color: var(--color-text-muted);
  padding: 2px 8px;
  border-radius: 3px;
}
.wiki-text-path {
  font-size: 12px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wiki-text-pre {
  background: var(--tw-gray-800);
  color: var(--tw-gray-100);
  padding: 16px;
  border-radius: var(--radius-md);
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre;
  margin: 0;
}

/* Markdown article */
.wiki-article {
  max-width: none;
  color: var(--color-text);
  font-size: 15px;
  line-height: 1.7;
}
.wiki-frontmatter-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--color-border);
}
.wiki-frontmatter-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--color-primary-bg, #eff6ff);
  color: var(--color-primary);
  border-radius: var(--radius-md);
  font-size: 13px;
  text-decoration: none;
  border: 1px solid var(--color-primary-border, #dbeafe);
}
.wiki-frontmatter-link:hover {
  background: var(--color-primary-border, #dbeafe);
}

/* Markdown body styling — 与 master MD_STYLES 对齐 */
.wiki-body-md :deep(h1) { font-size: 1.75rem; font-weight: 700; margin: 24px 0 12px; }
.wiki-body-md :deep(h2) { font-size: 1.4rem; font-weight: 700; margin: 20px 0 10px; }
.wiki-body-md :deep(h3) { font-size: 1.15rem; font-weight: 600; margin: 16px 0 8px; }
.wiki-body-md :deep(h4),
.wiki-body-md :deep(h5),
.wiki-body-md :deep(h6) { font-weight: 600; margin: 14px 0 6px; }
.wiki-body-md :deep(p) { margin: 12px 0; }
.wiki-body-md :deep(ul) { list-style: disc; padding-left: 24px; margin: 12px 0; }
.wiki-body-md :deep(ol) { list-style: decimal; padding-left: 24px; margin: 12px 0; }
.wiki-body-md :deep(li) { margin: 4px 0; }
.wiki-body-md :deep(code) {
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
  color: var(--tw-pink-600);
}
.wiki-body-md :deep(pre) {
  background: var(--tw-gray-800);
  color: var(--tw-gray-100);
  padding: 16px;
  border-radius: var(--radius-md);
  overflow-x: auto;
  margin: 16px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.6;
}
.wiki-body-md :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
}
.wiki-body-md :deep(blockquote) {
  border-left: 4px solid var(--color-border);
  padding-left: 16px;
  color: var(--color-text-muted);
  margin: 16px 0;
}
.wiki-body-md :deep(a) { color: var(--color-primary); text-decoration: none; }
.wiki-body-md :deep(a:hover) { text-decoration: underline; }
/* 跨项目链接 + 内部相对链接 + 附件链接的 ::after 装饰 (避免注入 inline text token 弄乱 markup) */
.wiki-body-md :deep(.md-link-cross)::after { content: ' ↗'; opacity: 0.6; font-size: 0.85em; }
.wiki-body-md :deep(.md-link-internal.is-md)::after { content: ' 📄'; opacity: 0.6; font-size: 0.85em; }
.wiki-body-md :deep(.md-link-internal.is-attachment)::after { content: ' 📎'; opacity: 0.6; font-size: 0.85em; }
.wiki-body-md :deep(.md-link-external)::after { content: ' ↗'; opacity: 0.6; font-size: 0.85em; }
.wiki-body-md :deep(table) { border-collapse: collapse; margin: 16px 0; }
.wiki-body-md :deep(th),
.wiki-body-md :deep(td) {
  border: 1px solid var(--color-border);
  padding: 6px 12px;
}
.wiki-body-md :deep(th) { background: var(--color-bg); font-weight: 600; }
.wiki-body-md :deep(hr) { border: none; border-top: 1px solid var(--color-border); margin: 24px 0; }
.wiki-body-md :deep(img) { max-width: 100%; border-radius: var(--radius-md); }

.md-link-icon {
  font-size: 0.75em;
  margin-left: 2px;
  opacity: 0.7;
}

/* Mermaid blocks */
.wiki-body-md :deep(.md-mermaid-block) {
  margin: 16px 0;
  display: flex;
  justify-content: center;
}
.wiki-body-md :deep(.mermaid-svg) {
  display: flex;
  justify-content: center;
  overflow-x: auto;
}
.wiki-body-md :deep(.mermaid-svg svg) {
  max-width: 100%;
  height: auto;
}
.wiki-body-md :deep(.mermaid-error) {
  border: 1px solid var(--tw-red-200);
  background: var(--tw-red-50);
  border-radius: var(--radius-md);
  padding: 12px;
}
.wiki-body-md :deep(.mermaid-error-title) {
  font-size: 13px;
  color: var(--tw-red-700);
  font-weight: 600;
  margin-bottom: 8px;
}
.wiki-body-md :deep(.mermaid-error-source) {
  font-size: 12px;
  color: var(--tw-red-900);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.wiki-body-md :deep(.mermaid-error-msg) {
  font-size: 11px;
  color: var(--tw-red-700);
  margin-top: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>

<style>
/* 非 scoped: 文件树子组件的样式 — 用 :deep() 跨 scope 不好用, 这里走全局. */
.wiki-tree {
  list-style: none;
  margin: 0;
  padding: 0;
}
.wiki-tree .wiki-tree {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid var(--color-border);
}
.wiki-tree > li {
  margin: 2px 0;
}
.tree-folder {
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text-muted);
  padding: 4px 0;
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.tree-folder::-webkit-details-marker { display: none; }
.tree-folder::before {
  content: '▾';
  display: inline-block;
  font-size: 10px;
  transition: transform 0.15s;
  width: 12px;
}
details:not([open]) .tree-folder::before {
  content: '▸';
}
.tree-icon {
  font-size: 12px;
}
.tree-file {
  display: block;
  width: 100%;
  text-align: left;
  font-size: 13px;
  padding: 4px 8px;
  border-radius: var(--radius);
  background: transparent;
  border: none;
  color: var(--color-text);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-file:hover {
  background: var(--color-bg);
}
.tree-file.active {
  background: var(--color-primary-bg, #eff6ff);
  color: var(--color-primary);
  font-weight: 500;
}
.tree-children {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>