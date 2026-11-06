"use client";

// Board 客户端渲染器 (R61 / P0 + P5 scaffold).
//
// 功能: 拉取 board 数据源 + iframe sandbox 渲染 AI 写的 HTML + 顶部时间线胶囊 (P5 拍板).
// 关注点:
//  - iframe sandbox="allow-scripts" **不给 allow-same-origin** —— AI 写的 JS 拿不到宿主
//    cookie / localStorage / DOM (冷启动源 §5.1).
//  - 数据通过 window.postMessage 注入, iframe 端用 window.addEventListener('message', ...)
//    接收, window.__DATA__ = msg.data. iframe 主动 fetch 不通 (CSP connect-src 'none').
//  - 高度自适应: iframe 内容用 ResizeObserver 通知宿主, 宿主重设 iframe.height.
//  - P5 时间线胶囊: 鼠标 hover 看 commits 列表 + role (agent/user), 点开看 commit 详情.
//  - refresh interval: 定时重拉 data, 不重渲染 iframe (iframe 自己处理).
//  - SSE: 当前用 setInterval 兜底, P2 改成 /api/events 增量流.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardConfig } from "@/lib/board";

interface ProjectRef {
  id: string;
  name: string;
  cwd: string;
}

interface BoardClientProps {
  project: { id: string; name: string };
  boardPath: string;
  versionId: string | null;
  projects: ProjectRef[];
  initialConfig: BoardConfig;
  initialBody: string;
}

interface SourceDataResponse {
  data?: Record<string, unknown>;
  errors?: Record<string, string>;
  meta?: { fetchedAt: string; sources: Array<{ name: string; ok: boolean; ms?: number }> };
}

interface CommitEntry {
  sha: string;
  author: string;
  email: string;
  time: string;
  message: string;
  authorRole: "agent" | "user";
}

export default function BoardClient({
  project,
  boardPath,
  versionId,
  initialConfig,
  initialBody,
}: BoardClientProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(600);
  const [lastFetched, setLastFetched] = useState<string | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 构造 board API URL (version 透传)
  const boardQuery = useMemo(() => {
    const qs = new URLSearchParams({ path: boardPath });
    if (versionId) qs.set("version", versionId);
    return `/api/projects/${project.id}/board?${qs.toString()}`;
  }, [project.id, boardPath, versionId]);

  // 拉数据 + postMessage 到 iframe
  const fetchAndInject = useCallback(async () => {
    try {
      const r = await fetch(boardQuery, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: boardPath }),
      });
      if (!r.ok) return;
      const j = (await r.json()) as SourceDataResponse;
      setLastFetched(j.meta?.fetchedAt ?? new Date().toISOString());
      setSourceErrors(j.errors ?? {});
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage(
          { type: "board-data", data: j.data ?? {}, errors: j.errors ?? {}, meta: j.meta },
          window.location.origin
        );
      }
    } catch {
      /* 静默失败, 下轮再试 */
    }
  }, [boardQuery, boardPath]);

  // 拉 git 历史 (P5 时间线)
  const fetchHistory = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ path: boardPath, history: "1" });
      if (versionId) qs.set("version", versionId);
      const r = await fetch(`/api/projects/${project.id}/board?${qs.toString()}`);
      if (!r.ok) return;
      const j = await r.json();
      setCommits(Array.isArray(j.commits) ? j.commits : []);
    } catch {
      /* 静默 */
    }
  }, [project.id, boardPath, versionId]);

  // 初次 + 定时刷新
  useEffect(() => {
    fetchAndInject();
    fetchHistory();
    if (initialConfig.refresh.kind === "interval") {
      const ms = initialConfig.refresh.seconds * 1000;
      const t = setInterval(fetchAndInject, ms);
      return () => clearInterval(t);
    }
    // sse / manual: 不开 timer
  }, [fetchAndInject, fetchHistory, initialConfig.refresh]);

  // 监听 iframe 自适应高度 + postMessage ack
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; height?: number };
      if (data?.type === "board-resize" && typeof data.height === "number") {
        setIframeHeight(Math.max(200, Math.min(4000, data.height)));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 把 inline script 提取出来: AI 写的 HTML 可能含 <script>, iframe srcdoc 直接 inline,
  // 不能直接 innerHTML 到主文档 (XSS). 用 srcdoc 让浏览器在隔离环境跑.
  const srcDoc = useMemo(() => buildSrcDoc(initialBody, initialConfig.sources.map((s) => s.name)), [initialBody, initialConfig.sources]);

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-medium">{initialConfig.title}</span>
          <span className="text-xs text-gray-500 font-mono">{boardPath}</span>
          {initialConfig.refresh.kind === "interval" && (
            <span className="text-xs text-gray-400">每 {initialConfig.refresh.seconds}s 刷新</span>
          )}
          {lastFetched && (
            <span className="text-xs text-gray-400">最后更新: {new Date(lastFetched).toLocaleTimeString()}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {Object.keys(sourceErrors).length > 0 && (
            <span className="text-xs text-amber-600" title={Object.entries(sourceErrors).map(([k, v]) => `${k}: ${v}`).join("\n")}>
              ⚠ {Object.keys(sourceErrors).length} source 失败
            </span>
          )}
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="text-xs text-blue-600 hover:underline"
          >
            时间线 ({commits.length})
          </button>
        </div>
      </div>

      {/* P5 时间线胶囊 (折叠面板) */}
      {historyOpen && (
        <div className="border-b bg-gray-50 px-4 py-2 max-h-64 overflow-auto">
          <h3 className="text-xs font-medium text-gray-600 mb-2">最近 20 次改动</h3>
          {commits.length === 0 ? (
            <p className="text-xs text-gray-400">无 git 历史</p>
          ) : (
            <ul className="space-y-1">
              {commits.map((c) => (
                <li key={c.sha} className="text-xs flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.authorRole === "agent" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                    {c.authorRole}
                  </span>
                  <code className="text-gray-500">{c.sha.slice(0, 7)}</code>
                  <span className="text-gray-700 flex-1 truncate">{c.message}</span>
                  <span className="text-gray-400">{c.author}</span>
                  <span className="text-gray-400">{new Date(c.time).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* iframe sandbox (D2: AI 写完整 HTML, 沙箱隔离, 不给 allow-same-origin) */}
      <iframe
        ref={iframeRef}
        title={initialConfig.title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ width: "100%", height: iframeHeight, border: "none" }}
        className="flex-1 bg-white"
      />
    </div>
  );
}

// 功能: 把 AI 写的 body 包成一个 srcdoc, 头部注入 board-data 监听器 + CSP.
// 关注点:
//  - CSP connect-src 'none' 阻止 iframe 内 fetch 跨域 (数据只能来自 postMessage).
//  - script-src 'unsafe-inline' 是因为 AI 写的 HTML 可能直接含 <script> 标签.
//  - 默认样式 + 数据注入监听器在前, 业务 body 在后 —— 这样业务代码可以监听 'message'.
function buildSrcDoc(body: string, sourceNames: string[]): string {
  const sourcesJson = JSON.stringify(sourceNames);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-src 'none';">
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#1f2937}h1,h2,h3{margin:0.4em 0}table{border-collapse:collapse}td,th{border:1px solid #e5e7eb;padding:4px 8px;font-size:13px}pre{background:#f3f4f6;padding:8px;border-radius:4px;overflow:auto;font-size:12px}.err{color:#dc2626}</style>
</head><body>
<div id="__board_pending__">加载中…</div>
<script>
(function(){
  var SOURCES = ${sourcesJson};
  window.__DATA__ = {};
  window.__ERRORS__ = {};
  window.__META__ = {};
  window.addEventListener('message', function(e){
    if (!e.data || e.data.type !== 'board-data') return;
    window.__DATA__ = e.data.data || {};
    window.__ERRORS__ = e.data.errors || {};
    window.__META__ = e.data.meta || {};
    var pending = document.getElementById('__board_pending__');
    if (pending) pending.remove();
    if (window.__renderBoard) window.__renderBoard();
  });
  // 高度自适应: 内容变化时通知宿主
  function notify(){
    var h = document.documentElement.scrollHeight;
    parent.postMessage({type:'board-resize', height: h}, '*');
  }
  new ResizeObserver(notify).observe(document.documentElement);
  setTimeout(notify, 100);
  setTimeout(notify, 500);
})();
</script>
${body}
</body></html>`;
}
