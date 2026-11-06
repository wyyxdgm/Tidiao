// SPA 侧 markdown 渲染 + 链接解析 —— 单一真相源.
//
// 为什么独立成模块: ProjectWiki.vue 与 ProjectOverview.vue (项目概览看板) 都要
// 把 markdown 渲染成 HTML 并把链接改写成可点的平台内跳转. 两处各写一份链接规则
// 必然漂移 —— 一个支持跨项目跳转另一个不支持, 用户点链接才发现. 这里抽一份,
// 两个视图共用.
//
// 与 master src/lib/wiki-links.ts 的关系: 语义 1:1 对齐 (跨项目语法 / 绝对路径
// 命中 cwd / 相对路径解析), 但**不 import master 的** —— SPA 有独立 vite 构建
// (@/ 指 spa/src), 引 master 会把 node 依赖拖进浏览器 bundle. 所以这里是
// 手工移植的副本, 改语法时**两边都要改** (master src/lib/wiki-links.ts 有自己的
// 测试守; 本文件有 spa/src/lib/wiki-markdown.test.ts 守).
//
// 链接形态 (与 wiki 一致):
//   1. project:{UUID}?path={relpath}[&version=]  → 跨项目 wiki
//   2. /abs/path 命中某项目 cwd                   → 该项目 wiki
//   3. 相对 .md 路径                              → 同项目 wiki
//   4. task:{id}                                  → 任务详情 (概览看板专有)
//   5. 其余 (http/https/mailto/#)                 → 外链新窗口
//
// 关注点:
//   - html:false — markdown-it 默认转义 raw HTML, 防 XSS. 正文是用户自己写的
//     (含凭据备注), 仍不能让它带脚本.
//   - decodeSafeHref: markdown-it normalizeLink(encodeURI) 已把中文 href 预编码
//     一次, 不 decode 就再 encodeURIComponent = 双重编码 → wiki 404 (R231 实测).

import MarkdownIt, {
  type MarkdownIt as MarkdownItType,
  type MarkdownItOptions,
  type Renderer,
  type Token,
} from 'markdown-it';

/** 给绝对路径匹配用的最小项目信息. 与 master ProjectCwdRef 对齐. */
export interface ProjectCwdRef {
  id: string;
  cwd: string | null;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

/** 功能: 剥掉 fragment/query 后取小写扩展名. 无扩展名返回 "". */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  // i <= 0 覆盖两种情况: 没有点, 以及 ".env" 这种纯隐藏文件(点在 0 位).
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 功能: markdown-it 预编码过的 href 还原成原文. 畸形编码序列保持原串. */
export function decodeSafeHref(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** 功能: HTML 转义. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 功能: HTML 属性值转义 (同 escapeHtml, 语义不同处单列). */
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 功能: 解析跨项目 wiki 链接 `project:{UUID}?path={relpath}[&version=]`.
 *       失败返 null (调用方走外链判定).
 * 关注点:
 *  - projectId 必须是 UUID 形状.
 *  - path 不接受前导 `/` 或含 `..` 段 —— 失败早暴露, 不让非法路径穿过到后端.
 *  - fragment 静默丢弃 (跨项目锚点语义不明).
 */
export function parseCrossProjectHref(
  href: string,
): { projectId: string; path: string; version: string | null } | null {
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

/**
 * 功能: 解析 markdown 相对链接 (相对 base 所在目录), 返回 cwd 相对 posix 路径.
 * 关注点: `..` 段按目录语义弹出 (不是直接拒), 与 wiki 渲染一致.
 */
export function resolveMdPath(base: string, href: string): string {
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

/** 功能: 是否指向 markdown 文件 (ext = 'md' 或 'markdown'). */
export function isMarkdownLink(href: string): boolean {
  const e = extOf(href.split('#')[0].split('?')[0]);
  return e === 'md' || e === 'markdown';
}

/**
 * 功能: 是否为「同项目 wiki 内部相对链接」—— 非 http/https/#/mailto 且扩展名在
 *       放行集合内.
 * 关注点: 扩展名白名单来自项目配置 (默认只 md). SPA 的 ProjectWiki 历史上把
 *       allowedExts 硬编成 ['md'] —— 这里保留调用方传集合的口径, 由调用方决定.
 */
export function isRelativeWikiLink(href: string, allowed: Set<string>): boolean {
  if (!href) return false;
  if (
    href.startsWith('http://') ||
    href.startsWith('https://') ||
    href.startsWith('#') ||
    href.startsWith('mailto:')
  ) {
    return false;
  }
  const clean = href.split('#')[0].split('?')[0];
  return allowed.has(extOf(clean));
}

/**
 * 功能: 规范化 href 为服务端 cwd 同前缀的绝对路径形态.
 *   - /Users/user/X → /home/user/X   (mac 视角写的路径)
 *   - ~/X           → /home/user/X
 *   - /workspace/X  → /home/user/workspace/X
 * 关注点: homeDir 写死 /home/user —— 服务端跑在 WSL, cwd 都是 /home/user 形态.
 */
export function normalizeHrefForCwdMatch(href: string, homeDir = '/home/user'): string {
  if (!href || typeof href !== 'string') return href;
  if (href.startsWith('~/')) return `${homeDir}/${href.slice(2)}`;
  if (!href.startsWith('/')) return href;
  if (href.startsWith('//')) return href;
  if (/^\/[A-Za-z]:\//.test(href)) return href;
  if (href.startsWith('/Users/user/')) return `${homeDir}/${href.slice('/Users/user/'.length)}`;
  if (href.startsWith('/workspace/') && !href.startsWith(`${homeDir}/workspace/`)) {
    return `${homeDir}${href}`;
  }
  return href;
}

/**
 * 功能: 绝对路径命中某项目 cwd 子树 → (projectId, 相对路径); 否则 null.
 * 关注点: **最长前缀匹配** —— cwd 可能嵌套 (/ws/a 与 /ws/aa), 选最具体的那个,
 *       避免祖辈截胡. cwd 后面必须正好跟 '/' 才算子树, 防 /ws/a 截胡 /ws/abc.
 */
export function resolveAbsoluteProjectPath(
  href: string,
  projects: ProjectCwdRef[],
): { projectId: string; path: string } | null {
  if (!href || !href.startsWith('/')) return null;
  if (!Array.isArray(projects)) return null;
  // Windows / UNC 路径不当绝对路径处理, 统一走外链.
  if (href.startsWith('//') || /^\/[A-Za-z]:\//.test(href)) return null;
  const normalized = normalizeHrefForCwdMatch(href);
  const sorted = projects
    .filter((p): p is { id: string; cwd: string } => !!p.cwd)
    .slice()
    .sort((a, b) => b.cwd.length - a.cwd.length);
  for (const p of sorted) {
    if (normalized === p.cwd) return null;
    if (normalized.startsWith(`${p.cwd}/`)) {
      return { projectId: p.id, path: normalized.slice(p.cwd.length + 1) };
    }
  }
  return null;
}

/**
 * 功能: 解析任务链接 `task:{id}` — id 可为完整 UUID 或 8 位短前缀.
 *       返 null = 不是任务链接 (调用方走其他判定).
 * 关注点: 短前缀只做形状校验, 不查库确认存在 —— 平台侧 GET /api/tasks/[id]
 *       自己支持短 id 解析 (LIKE 查询), 短 id 歧义时后端返 409 提示.
 */
export function parseTaskHref(href: string): { taskId: string } | null {
  if (!href || !href.startsWith('task:')) return null;
  const id = href.slice('task:'.length).split('#')[0].split('?')[0].trim();
  if (!id) return null;
  if (UUID_RE.test(id)) return { taskId: id };
  // 8 位 hex 短 id (平台短 id 语义)
  if (/^[0-9a-f]{8}$/i.test(id)) return { taskId: id.toLowerCase() };
  return null;
}

/* ------------------------------------------------------------------ */
/*  Plain-text linkification                                          */
/* ------------------------------------------------------------------ */

/**
 * 功能: 把**正文里的纯文本** `task:{id}` / `project:{UUID}?path=` 变成可点链接.
 * 关注点:
 *  - 为什么需要: 人写概览时最自然的写法就是直接写「任务: task:2c364593」, 而不是
 *    特意写成 markdown 链接 `[x](task:2c364593)`. 只支持 markdown 链接的话, 一半
 *    的引用点不动 —— 实测 (2026-11-01 浏览器验证) 就是这个坑.
 *  - 只在**纯文本节点**里替换: 已渲染的 <a>/<pre>/<code> 内部跳过, 否则会把
 *    已经改写好的 href 再套一层 <a> (嵌套 a 非法).
 *  - 匹配不到合法 id 就原样留着 (不吞字符) —— `task:xyz` 不是链接.
 */
/* 🔴 顺序要紧: 完整 UUID 必须排在 8 位短 id **前面** —— 交替分支是正则从左到右
   第一个命中就停, 短 id 在前会把完整 UUID 截成前 8 位 (实测: task:2c364593-fc21-... 被
   链成 task:2c364593 + 一截尾巴). */
const TASK_TEXT_RE = /\btask:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})\b/gi;
const PROJECT_TEXT_RE = /\bproject:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\?path=([^\s)\]]+)/gi;
/** 无 /g 的副本 —— .test() 不能用带 lastIndex 的全局正则 (状态残留). */
const TASK_TEXT_RE_TEST = /\btask:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})\b/i;

/** 把 HTML 按标签拆成「文本段 / 标签」, 便于只在文本段做替换. */
function splitByTags(html: string): { part: string; inPre: boolean; inA: boolean; inCode: boolean }[] {
  const out: { part: string; inPre: boolean; inA: boolean; inCode: boolean }[] = [];
  let inPre = false;
  let inA = false;
  let inCode = false;
  const re = /<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) {
      out.push({ part: html.slice(last, m.index), inPre, inA, inCode });
    }
    const tag = m[0].toLowerCase();
    if (/^<pre[\s>]/.test(tag)) inPre = true;
    else if (/^<\/pre[\s>]/.test(tag)) inPre = false;
    else if (/^<a[\s>]/.test(tag)) inA = true;
    else if (/^<\/a[\s>]/.test(tag)) inA = false;
    else if (/^<code[\s>]/.test(tag)) inCode = true;
    else if (/^<\/code[\s>]/.test(tag)) inCode = false;
    out.push({ part: m[0], inPre, inA, inCode });
    last = m.index + m[0].length;
  }
  if (last < html.length) {
    out.push({ part: html.slice(last), inPre, inA, inCode });
  }
  return out;
}

/**
 * 功能: 渲染后的 HTML 上把纯文本的 `task:` / `project:` 引用变成可点链接.
 * 关注点:
 *  - 已渲染的 <a> 内部跳过 (避免嵌套 a —— 嵌套 a 是非法 HTML, 浏览器会把 DOM
 *    拆开, 链接文字就掉出来了).
 *  - <pre>/<code> 内部跳过 (代码块里的 `task:` 是内容不是引用).
 *  - 🔴 正则带 /g 标志时 .test() 是**有状态的** (lastIndex 残留) —— 用独立的
 *    非全局副本做判断, 否则同一段 HTML 连续处理两次结果不同.
 */
export function linkifyPlainRefs(html: string): string {
  return splitByTags(html)
    .map(({ part, inPre, inA, inCode }) => {
      if (part.startsWith('<') && part.endsWith('>')) return part;
      if (inPre || inA) return part;
      // code 段整体命中才算 (行内 code 里的 task: 是代码内容) —— 与 master
      // linkifyTaskPrefixes 同口径.
      if (inCode && !TASK_TEXT_RE_TEST.test(part.trim())) return part;
      let out = part.replace(TASK_TEXT_RE, (_m, id: string) => {
        const lower = id.toLowerCase();
        return `<a href="#/tasks/${lower}" class="md-link md-link-task">task:${lower}</a>`;
      });
      out = out.replace(PROJECT_TEXT_RE, (_m, pid: string, p: string) => {
        const params = new URLSearchParams();
        params.set('path', p);
        return `<a href="/#/${pid}/wiki?${params.toString()}" class="md-link md-link-cross">project:${pid}</a>`;
      });
      return out;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/*  Renderer                                                           */
/* ------------------------------------------------------------------ */

/** 链接渲染需要的实时上下文 —— 用 getter 而非值, 页面状态变了链接规则要跟着变. */
export interface LinkContext {
  /** 当前渲染的文档相对路径 (相对链接的 base). */
  getCurrentPath: () => string;
  /** 项目 cwd 列表 (绝对路径 → 项目匹配). */
  getProjectsWithCwd: () => ProjectCwdRef[];
  /** 放行扩展名集合 (决定哪些相对链接算「项目内 wiki 链接」). */
  getAllowedExts: () => Set<string>;
}

/**
 * 功能: 造一个配好链接规则的 markdown 渲染器.
 * 关注点:
 *  - linkify:true — 裸 URL 自动变链接 (飞书链接直接贴 URL 就能点).
 *  - breaks:false — wiki 与概览统一不把单换行当 <br> (markdown 标准行为);
 *    ProjectWiki 历史行为一致, 概览跟着走, 免得两页观感不同.
 *  - getProjectId 必传 —— 同项目相对链接要拼 `#/{projectId}/wiki?path=`.
 *  - 返回的是**包装过的** md (render 多一步 plain-text linkify) —— 因为纯文本
 *    里的 `task:` / `project:` 引用要在 markdown-it 渲染**之后**才能安全替换
 *    (要避开已生成的 <a>/<pre>/<code>). 调用方只管调 .render(src).
 *
 * 链接判定顺序 (不能换): 跨项目 → 绝对路径 → 任务 → 相对 wiki → 外链.
 *   `project:` 必须先判, 否则会被当成相对路径; `task:` 同理.
 */
export function createMarkdownRenderer(
  ctx: LinkContext & { getProjectId: () => string },
): MarkdownItType & { render: (src: string) => string } {  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  const defaultLinkRender =
    md.renderer.rules.link_open ||
    function defaultLink(
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string {
      return self.renderToken(tokens, idx, options as Required<MarkdownItOptions>);
    };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIdx = token.attrIndex('href');
    if (hrefIdx >= 0 && token.attrs) {
      const href = decodeSafeHref(String(token.attrs[hrefIdx][1]));

      // 1) 跨项目 wiki
      const cross = parseCrossProjectHref(href);
      if (cross) {
        const params = new URLSearchParams();
        params.set('path', cross.path);
        if (cross.version) params.set('version', cross.version);
        token.attrSet('href', `/#/${cross.projectId}/wiki?${params.toString()}`);
        token.attrSet('class', 'md-link md-link-cross');
        return defaultLinkRender(tokens, idx, options, env, self);
      }

      // 2) 绝对路径命中某项目 cwd
      const absHit = resolveAbsoluteProjectPath(href, ctx.getProjectsWithCwd());
      if (absHit) {
        const target =
          absHit.projectId === ctx.getProjectId()
            ? resolveMdPath(ctx.getCurrentPath(), absHit.path)
            : absHit.path;
        token.attrSet(
          'href',
          `#/${absHit.projectId}/wiki?path=${encodeURIComponent(target)}`,
        );
        token.attrSet('class', 'md-link md-link-internal');
        return defaultLinkRender(tokens, idx, options, env, self);
      }

      // 3) 任务链接
      const task = parseTaskHref(href);
      if (task) {
        token.attrSet('href', `#/tasks/${task.taskId}`);
        token.attrSet('class', 'md-link md-link-task');
        return defaultLinkRender(tokens, idx, options, env, self);
      }

      // 4) 同项目 wiki 相对链接
      if (isRelativeWikiLink(href, ctx.getAllowedExts())) {
        const target = resolveMdPath(ctx.getCurrentPath(), href);
        token.attrSet(
          'href',
          `#/${ctx.getProjectId()}/wiki?path=${encodeURIComponent(target)}`,
        );
        token.attrSet(
          'class',
          `md-link md-link-internal ${isMarkdownLink(href) ? 'is-md' : 'is-attachment'}`,
        );
        return defaultLinkRender(tokens, idx, options, env, self);
      }

      // 5) 外链
      token.attrSet('class', 'md-link md-link-external');
    }
    return defaultLinkRender(tokens, idx, options, env, self);
  };

  // 包装 render: markdown-it 渲染完再把纯文本里的 task:/project: 引用变成链接.
  // 关注点: 用 Object.create 继承原实例 (保住 markdown-it 的其他 API), 只覆盖
  //        render —— 调用方不需要知道这层包装.
  const origRender = md.render.bind(md);
  const wrapped = Object.create(md) as MarkdownItType & { render: (src: string) => string };
  wrapped.render = (src: string): string => linkifyPlainRefs(origRender(src));
  return wrapped;
}
