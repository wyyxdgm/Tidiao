"use client";

// 项目 Wiki client: 左栏文件树 + 右栏 (frontmatter links + 正文).
// 关注点:
//  - 正文相对链接拦截为内部跳转(树状 wiki), 判定跟随项目放行的扩展名(见 wiki-files.ts);
//    外链新窗口.
//  - 🔴 XSS: markdown 走 react-markdown (默认不渲染 raw HTML). 非 md 走 <pre>{text}</pre>
//    的纯文本路径 —— React 的 {} 插值自动转义, **绝不能**改成 dangerouslySetInnerHTML,
//    否则 .json/.html 里的 <script> 会直接执行.

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Select from "@/components/Select";
import { extOf, isMarkdown } from "@/lib/wiki-files";
import {
  parseCrossProjectHref,
  resolveAbsoluteProjectPath,
  type ProjectCwdRef,
} from "@/lib/wiki-links";
import { detectMermaid } from "@/lib/wiki-mermaid";

// 功能: 客户端动态加载 mermaid 并把源码渲染成 SVG (覆盖 erDiagram / flowchart /
//       sequenceDiagram / classDiagram / stateDiagram / gantt 等全部图类型).
// 关注点:
//  - mermaid 库本体只在客户端加载 (dynamic import), 避免 SSR 阶段炸 (浏览器环境才有 window).
//  - SVG 是 mermaid 库可信输出, 用 dangerouslySetInnerHTML 注入; 不可信来源
//    (用户直接粘贴的 html) 不能走这里 —— markdown 主体仍走 react-markdown 默认转义.
//  - 用 ref 保证多次 React Strict Mode 下重复执行 useEffect 也不重复挂 mermaid.
//  - 解析失败显示原文 + 错误, 不静默吞错.
function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaidMod = await import("mermaid");
        const mermaid = mermaidMod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
        });
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) setSvg(out);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (error) {
    return (
      <div className="my-4 border border-red-200 bg-red-50 rounded-lg p-3">
        <div className="text-sm text-red-700 font-semibold mb-2">
          ⚠️ Mermaid 渲染失败
        </div>
        <pre className="text-xs text-red-900 whitespace-pre-wrap break-all">
          {code}
        </pre>
        <div className="text-xs text-red-600 mt-2 font-mono">{error}</div>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="my-4 border border-gray-200 bg-gray-50 rounded-lg p-4 text-center text-sm text-gray-400">
        渲染 Mermaid 中…
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="my-4 flex justify-center overflow-x-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// 功能: ReactMarkdown `pre` 组件覆盖 — 检测内部 `code.language-mermaid`, 改走
//       MermaidBlock; 普通 pre 沿用默认深色代码块样式.
// 关注点: 检测逻辑下沉到 lib/wiki-mermaid 的 detectMermaid, 这里只做转换.
function MarkdownPre(
  props: ComponentPropsWithoutRef<"pre"> & { children?: ReactNode }
) {
  const { isMermaid, code } = detectMermaid(props.children);
  if (isMermaid) return <MermaidBlock code={code} />;
  return <pre {...props} />;
}

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}
interface WikiLink {
  label: string;
  url: string;
}
interface WikiData {
  path: string | null;
  // md: 去掉 frontmatter 的正文; 非 md: 文件原文(由 kind 决定怎么渲染).
  markdown: string | null;
  kind?: "markdown" | "text";
  ext?: string;
  links: WikiLink[];
  title: string | null;
  exists: boolean;
  reason?: string;
  size?: number;
  limit?: number;
}

interface Props {
  project: { id: string; name: string };
  versionId: string | null;
  versions: { id: string; name: string }[];
  // 该项目 wiki 放行的扩展名(含 md), 由 server component 从项目配置解析后传入.
  // 用途: 判定正文里的相对链接是否该拦成内部跳转.
  allowedExts: string[];
  // 当前用户可见的项目 cwd 列表(仅用于绝对路径笔记链接的自动识别, server
  // component 注入; cwd 缺失的项目已被过滤, 这里都是非空字符串).
  projects: ProjectCwdRef[];
}

// 功能: 解析 markdown 相对链接(相对 currentPath), 返回 cwd 相对 posix 路径.
function resolveMdPath(base: string, href: string): string {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return base;
  const baseDir = base.includes("/")
    ? base.slice(0, base.lastIndexOf("/") + 1)
    : "";
  const parts = (baseDir + clean).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

// 功能: 字节数格式化成人类可读(KB/MB), 用于「文件太大」提示.
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 功能: 判断 href 是否为「指向本 wiki 内可读文件」的相对链接(需拦成内部跳转).
// 关注点: 放行集合由项目配置决定, 必须和后端 allowedExtensions 一致 —— 这里判宽了
//        点开就 404, 判窄了本该内部跳转的链接会变成外链新窗口打不开.
function isRelativeWikiLink(href: string, allowed: Set<string>): boolean {
  if (!href) return false;
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("#") ||
    href.startsWith("mailto:")
  )
    return false;
  const clean = href.split("#")[0].split("?")[0];
  return allowed.has(extOf(clean));
}

// 功能: 递归渲染文件树. 目录用 <details> 可折叠(默认展开).
function TreeView({
  nodes,
  currentPath,
  onSelect,
}: {
  nodes: TreeNode[];
  currentPath: string;
  onSelect: (p: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <li key={n.path || n.name}>
          {n.children ? (
            <details open>
              <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-900 py-1 select-none flex items-center gap-1">
                <span className="text-gray-400">📁</span>
                {n.name}
              </summary>
              <ul className="ml-4 space-y-0.5 border-l border-gray-200 pl-2">
                <TreeView nodes={n.children} currentPath={currentPath} onSelect={onSelect} />
              </ul>
            </details>
          ) : (
            <button
              onClick={() => onSelect(n.path)}
              className={`text-sm py-1 px-1.5 rounded text-left w-full truncate ${
                n.path === currentPath
                  ? "bg-blue-50 text-blue-700 font-medium"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
              title={n.path}
            >
              {n.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const MD_STYLES =
  "max-w-none text-gray-800 " +
  "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3 " +
  "[&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-5 [&_h2]:mb-2 " +
  "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 " +
  "[&_p]:my-3 [&_p]:leading-7 " +
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 " +
  "[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 " +
  "[&_li]:my-1 " +
  "[&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono [&_code]:text-pink-600 " +
  "[&_pre]:bg-gray-900 [&_pre]:text-gray-100 [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:my-4 " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-gray-100 " +
  "[&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:pl-4 [&_blockquote]:text-gray-600 [&_blockquote]:my-4 " +
  "[&_a]:text-blue-600 [&_a]:hover:underline " +
  "[&_table]:my-4 [&_table]:border-collapse " +
  "[&_th]:border [&_th]:border-gray-300 [&_th]:px-3 [&_th]:py-1.5 [&_th]:bg-gray-50 [&_th]:font-semibold " +
  "[&_td]:border [&_td]:border-gray-300 [&_td]:px-3 [&_td]:py-1.5 " +
  "[&_hr]:my-6 [&_hr]:border-gray-200 " +
  "[&_img]:max-w-full [&_img]:rounded";

export default function WikiClient({
  project,
  versionId: initialVersionId,
  versions,
  allowedExts,
  projects,
}: Props) {
  // Set 化一次, 供正文链接判定用. allowedExts 是 server 传下来的 props, 不会变.
  const allowedSet = useMemo(() => new Set(allowedExts), [allowedExts]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [data, setData] = useState<WikiData | null>(null);
  const [currentPath, setCurrentPath] = useState("INDEX.md");
  const [loading, setLoading] = useState(true);
  const [versionId, setVersionId] = useState<string | null>(initialVersionId);
  // 布局模式: true=铺满(左目录居左+正文占满剩余), false=居中(当前 max-w-7xl). 默认铺满, 偏好存 localStorage.
  const [fullWidth, setFullWidth] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("ao-wiki-fullwidth");
    if (saved !== null) setFullWidth(saved === "1");
  }, []);

  const toggleFullWidth = useCallback(() => {
    setFullWidth((v) => {
      const next = !v;
      localStorage.setItem("ao-wiki-fullwidth", next ? "1" : "0");
      return next;
    });
  }, []);

  // 左栏宽度: 可拖拽调整, 按项目存 localStorage (有的项目文档多需更宽).
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(`ao-wiki-sidebar-${project.id}`);
    if (saved) {
      const w = parseInt(saved, 10);
      if (!isNaN(w) && w >= 180 && w <= 600) setSidebarWidth(w);
    }
  }, [project.id]);

  // 切换文档时把右栏滚回顶部 (独立滚动后不重置会停在旧位置).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [currentPath]);

  // 功能: 拖拽左栏右边缘调整宽度; 松手按项目存 localStorage.
  // 关注点: move/up 闭包定义在 mousedown 内, 用 startW+dx 避免状态闭包过期; 松手用函数式 setState 读最新值.
  const handleSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(180, Math.min(600, startW + ev.clientX - startX));
        setSidebarWidth(next);
      };
      const onUp = () => {
        setSidebarWidth((w) => {
          localStorage.setItem(`ao-wiki-sidebar-${project.id}`, String(w));
          return w;
        });
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, project.id]
  );

  const loadPath = useCallback(
    (p: string) => {
      setLoading(true);
      const vParam = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
      fetch(`/api/projects/${project.id}/wiki?path=${encodeURIComponent(p)}${vParam}`)
        .then((r) => r.json())
        .then((d: WikiData) => {
          setData(d);
          if (d.exists && d.path) {
            setCurrentPath(d.path);
            // 同步地址栏 ?path=, 让当前文档 URL 可分享/刷新保持.
            try {
              const u = new URL(window.location.href);
              u.searchParams.set("path", d.path);
              window.history.replaceState(null, "", u);
            } catch {}
          }
        })
        .catch(() => setData(null))
        .finally(() => setLoading(false));
    },
    [project.id, versionId]
  );

  useEffect(() => {
    const vParam = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
    fetch(`/api/projects/${project.id}/wiki/tree${vParam}`)
      .then((r) => r.json())
      .then((d) => setTree(Array.isArray(d.tree) ? d.tree : []))
      .catch(() => setTree([]));
    // 支持深链接: URL 带 ?path= 时直接打开该文档, 否则回退 INDEX.md.
    // 版本切换时 handleVersionChange 已清掉 ?path=, 这里回退 INDEX.md (跨版本旧 path 无意义).
    const initial = new URLSearchParams(window.location.search).get("path") || "INDEX.md";
    loadPath(initial);
  }, [project.id, versionId, loadPath]);

  // 功能: 切换版本 -> 更新 state + URL, 清掉 ?path= (跨版本旧 path 无意义), useEffect 随 versionId 变化重新加载 tree+正文.
  const handleVersionChange = useCallback((v: string) => {
    setVersionId(v);
    setCurrentPath("INDEX.md");
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("path");
      u.searchParams.set("version", v);
      window.history.replaceState(null, "", u);
    } catch {}
  }, []);

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden flex flex-col bg-gray-50">
      <header className="shrink-0 bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
          <Link href="/" className="hover:text-blue-600">
            项目
          </Link>
          <span>›</span>
          <Link href={`/${project.id}`} className="hover:text-blue-600">
            {project.name}
          </Link>
          <span>›</span>
          <span className="text-gray-700 font-medium">Wiki</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">
            📖 {project.name} Wiki
          </h1>
          <div className="flex items-center gap-2">
            {/* 飞书 R87: 顶部加「Board / 需求」快捷入口, 让浏览 wiki 时也能一键
                跳到需求列表和进度看板. Board 用 boards/project-progress.md 默认
                模板 (R66 引擎定义). 需求走当前 versionId, 无 version 时回退
                unversioned. 与左侧导航一致, 避免用户两边找入口. */}
            <Link
              href={`/${project.id}/board?path=boards/project-progress.md${versionId ? `&version=${encodeURIComponent(versionId)}` : ""}`}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
              title="项目进度看板"
            >
              📊 Board
            </Link>
            <Link
              href={
                versionId
                  ? `/${project.id}/${versionId}/requirements`
                  : `/${project.id}/unversioned/requirements`
              }
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
              title="需求点列表"
            >
              📋 需求
            </Link>
            {versions.length > 0 && (
              <Select
                value={versionId ?? ""}
                onChange={handleVersionChange}
                options={versions.map((v) => ({ value: v.id, label: v.name }))}
                className="w-36"
                title="切换版本查看"
              />
            )}
            <button
              onClick={toggleFullWidth}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
              title={fullWidth ? "当前: 铺满宽度, 点击切换居中" : "当前: 居中宽度, 点击切换铺满"}
            >
              {fullWidth ? "🔲 铺满" : "📐 居中"}
            </button>
            {/* download 按钮: 浏览器走 <a download> + Content-Disposition 直接下载原文
                (含 frontmatter). 仅在正文存在时显示, 404 / too-large 状态不出现. */}
            {data && data.exists && data.path && (
              <a
                href={`/api/projects/${project.id}/wiki?path=${encodeURIComponent(data.path)}${versionId ? `&version=${encodeURIComponent(versionId)}` : ""}&download=1`}
                download
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
                title="下载原文(含 frontmatter, 与 git 仓库文件一致)"
              >
                ⬇ 下载
              </a>
            )}
          </div>
        </div>
      </header>

      <div
        className={
          fullWidth
            ? "flex-1 md:min-h-0 flex flex-col md:flex-row gap-4 p-4 md:p-6"
            : "flex-1 md:min-h-0 flex flex-col md:flex-row max-w-7xl mx-auto gap-4 p-4 md:p-6"
        }
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      >
        {/* 左栏: 文件树 (可拖拽调宽, 宽度按项目存 localStorage) */}
        <div className="md:shrink-0 md:w-[var(--sidebar-w)] relative">
          <aside className="md:h-full min-h-0 bg-white rounded-lg border border-gray-200 p-3 md:overflow-y-auto">
            <div className="text-xs font-semibold text-gray-400 uppercase mb-2">
              文档
            </div>
            {tree.length === 0 ? (
              <p className="text-sm text-gray-400">
                无可读文件({allowedExts.map((e) => `.${e}`).join(" ")})
              </p>
            ) : (
              <TreeView nodes={tree} currentPath={currentPath} onSelect={loadPath} />
            )}
          </aside>
          <div
            onMouseDown={handleSidebarDrag}
            className="hidden md:block absolute -right-2 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 rounded transition-colors z-10"
            title="拖拽调整宽度"
          />
        </div>

        {/* 右栏: links + 正文 */}
        <main ref={mainRef} className="flex-1 min-h-0 bg-white rounded-lg border border-gray-200 p-5 md:p-8 md:overflow-y-auto min-w-0">
          {loading ? (
            <p className="text-gray-400">加载中…</p>
          ) : !data || !data.exists ? (
            <div className="text-gray-500 text-sm leading-7">
              {data?.reason === "no-cwd" ? (
                <p>
                  该项目未设置 <code className="bg-gray-100 px-1 rounded">cwd</code>
                  ,无法浏览文档。
                  <br />
                  请在项目设置中配置工作目录。
                </p>
              ) : data?.reason === "too-large" ? (
                <p>
                  <code className="bg-gray-100 px-1 rounded">{currentPath}</code> 太大
                  ({fmtBytes(data.size ?? 0)}),超过 {fmtBytes(data.limit ?? 0)} 上限,
                  未加载。
                  <br />
                  非 .md 文件有大小上限,避免几十 MB 的数据文件把页面卡死。
                </p>
              ) : (
                <p>
                  未找到 <code className="bg-gray-100 px-1 rounded">{currentPath}</code>
                  。可在项目 cwd 根目录创建{" "}
                  <code className="bg-gray-100 px-1 rounded">INDEX.md</code>{" "}
                  作为 Wiki 入口(支持 frontmatter links)。
                </p>
              )}
            </div>
          ) : data.kind === "text" ? (
            /* 非 md: 纯文本/代码块渲染. 绝不进 markdown 渲染器 —— json 的 {}、csv
               的逗号、代码里的 < 会被 markdown 吃掉或错乱. React 的 {} 插值自动
               转义, 这里**不能**换成 dangerouslySetInnerHTML. */
            <div>
              <div className="flex items-center gap-2 mb-3 pb-3 border-b border-gray-100">
                <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded uppercase">
                  {data.ext || "text"}
                </span>
                <span className="text-xs text-gray-400 truncate">{data.path}</span>
              </div>
              <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm font-mono leading-6 whitespace-pre">
                {data.markdown || ""}
              </pre>
            </div>
          ) : (
            <article className={MD_STYLES}>
              {data.links.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-6 pb-4 border-b border-gray-100 not-prose">
                  {data.links.map((l, i) => (
                    <a
                      key={i}
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm hover:bg-blue-100 border border-blue-200"
                    >
                      🔗 {l.label}
                    </a>
                  ))}
                </div>
              )}
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: MarkdownPre,
                  a: ({ href, children }) => {
                    // 绝对路径自动识别: 笔记/外部工具常贴绝对路径, 若落在当前
                    // 用户某项目 cwd 子树内, 当作跨项目跳转或同项目相对跳转.
                    if (href) {
                      const absHit = resolveAbsoluteProjectPath(href, projects);
                      if (absHit) {
                        if (absHit.projectId === project.id) {
                          // 同项目: 重写为相对路径, 走原 isRelativeWikiLink 流.
                          const target = resolveMdPath(currentPath, absHit.path);
                          return (
                            <a
                              href={`?path=${target}`}
                              onClick={(e) => {
                                e.preventDefault();
                                loadPath(target);
                              }}
                              className="text-blue-600 hover:underline cursor-pointer"
                            >
                              {children} 📄
                            </a>
                          );
                        }
                        // 跨项目: 与下方 cross 分支同 UX.
                        // 🔴 hash 路由: 跳 SPA (裸 /{id}/wiki 落旧壳)
                        const targetUrl = `/#/${absHit.projectId}/wiki?path=${encodeURIComponent(absHit.path)}`;
                        return (
                          <a
                            href={targetUrl}
                            className="text-blue-600 hover:underline"
                          >
                            {children} ↗
                          </a>
                        );
                      }
                    }
                    // 跨项目链接: 整页跳到目标项目的 wiki(不同树/不同 allowedExts,
                    // 软切换会留下旧 state, 直接 pagenav 最稳). 权限由目标 wiki
                    // 的服务端 getProjectById(id, userId) 把关 —— 没权限则目标页
                    // 直接 404, 与点错链接 UX 一致.
                    if (href) {
                      const cross = parseCrossProjectHref(href);
                      if (cross) {
                        const params = new URLSearchParams();
                        params.set("path", cross.path);
                        if (cross.version) params.set("version", cross.version);
                        const targetUrl = `/${cross.projectId}/wiki?${params.toString()}`;
                        return (
                          <a
                            href={targetUrl}
                            className="text-blue-600 hover:underline"
                          >
                            {children} ↗
                          </a>
                        );
                      }
                    }
                    if (href && isRelativeWikiLink(href, allowedSet)) {
                      const target = resolveMdPath(currentPath, href);
                      return (
                        <a
                          href={`?path=${target}`}
                          onClick={(e) => {
                            e.preventDefault();
                            loadPath(target);
                          }}
                          className="text-blue-600 hover:underline cursor-pointer"
                        >
                          {children} {isMarkdown(href) ? "📄" : "📎"}
                        </a>
                      );
                    }
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {data.markdown || ""}
              </ReactMarkdown>
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
