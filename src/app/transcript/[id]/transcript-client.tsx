// Client component for /transcript/[id] — renders markdown transcript + metadata + download.

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { markdownToHtml } from "@/lib/markdown";
import { STATUS_LABELS, STATUS_DOT } from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useToastActions } from "@/components/Toast";

type Task = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  model: string | null;
  resolved_model: string | null;
  effort: string | null;
  cost_usd: number | null;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function formatDuration(ms: number): string {
  if (ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return "<1秒";
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}时${mins}分`;
}

function formatDateTime(iso: string | null): string {
  const d = parseDbTime(iso);
  if (!d) return "-";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TranscriptClient({
  task,
  markdown,
}: {
  task: Task;
  markdown: string;
}) {
  // Render markdown once on mount / when content changes.
  const html = useMemo(() => markdownToHtml(markdown), [markdown]);
  const [downloadingJsonl, setDownloadingJsonl] = useState(false);
  const toast = useToastActions();

  const startedAt = parseDbTime(task.started_at);
  const completedAt = parseDbTime(task.completed_at);
  const durationMs =
    startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : null;

  const fileSlug = task.title
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "transcript";

  function handleDownload() {
    // markdown 自带 task 元信息头 (formatSessionMarkdown), 直接落盘即自包含。
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    triggerDownload(blob, `${fileSlug}.md`);
  }

  // 功能: 拉 format=jsonl&verbosity=full 的机器可读会话并落盘。
  // 关注点: 页面 SSR 的 markdown 拿不到 jsonl, 只能再走一次 API; 首行是 meta,
  //   其余每行一条 SessionMessage。fetch 带同源 cookie 即鉴权, 失败走 Toast 不静默。
  async function handleDownloadJsonl() {
    if (downloadingJsonl) return;
    setDownloadingJsonl(true);
    try {
      const res = await fetch(
        `/api/tasks/${task.id}/transcript?format=jsonl&verbosity=full`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      triggerDownload(await res.blob(), `${fileSlug}.jsonl`);
    } catch (e) {
      toast.error(`导出 .jsonl 失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloadingJsonl(false);
    }
  }

  return (
    // 🆕 飞书 R139 第二批: 右滚修复 — 同 schedules 套路, 根容器改 h-full (旧 min-h-screen 撑 100vh 但外层已 overflow-hidden).
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/tasks/${task.id}`} className="text-gray-600 hover:text-gray-900 text-sm">
            ← 返回任务
          </Link>
          <h1 className="text-lg font-semibold text-gray-900 truncate max-w-xl">
            {task.title}
          </h1>
          <span className="flex items-center gap-1.5 text-sm">
            <span
              className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT[task.status] || "bg-gray-400"}`}
            />
            <span className="text-gray-700">{STATUS_LABELS[task.status] || task.status}</span>
          </span>
          <button
            onClick={handleDownload}
            className="ml-auto bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700"
            title="下载完整 Markdown 转录"
          >
            ⬇ 下载 .md
          </button>
          <button
            onClick={handleDownloadJsonl}
            disabled={downloadingJsonl}
            className="bg-white text-gray-700 border border-gray-300 px-3 py-1.5 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
            title="下载机器可读的完整会话 (每行一条消息, 含 thinking / tool_use / tool_result)"
          >
            {downloadingJsonl ? "导出中…" : "⬇ 下载 .jsonl"}
          </button>
        </div>

        {/* Metadata grid */}
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-xs text-gray-600">
          <div>
            <span className="text-gray-400">模型：</span>
            <span className="text-gray-800 font-medium">{task.resolved_model || task.model || "-"}</span>
          </div>
          <div>
            <span className="text-gray-400">强度：</span>
            <span className="text-gray-800 font-medium">{task.effort || "-"}</span>
          </div>
          <div>
            <span className="text-gray-400">花费：</span>
            <span className="text-gray-800 font-medium">
              {task.cost_usd != null ? `$${task.cost_usd.toFixed(4)}` : "-"}
            </span>
          </div>
          <div>
            <span className="text-gray-400">时长：</span>
            <span className="text-gray-800 font-medium">
              {durationMs != null ? formatDuration(durationMs) : "-"}
            </span>
          </div>
          <div>
            <span className="text-gray-400">创建：</span>
            <span className="text-gray-800 font-medium">{formatDateTime(task.created_at)}</span>
          </div>
          <div>
            <span className="text-gray-400">开始：</span>
            <span className="text-gray-800 font-medium">{formatDateTime(task.started_at)}</span>
          </div>
          <div>
            <span className="text-gray-400">完成：</span>
            <span className="text-gray-800 font-medium">{formatDateTime(task.completed_at)}</span>
          </div>
          {task.session_id && (
            <div className="truncate">
              <span className="text-gray-400">Session：</span>
              <span className="text-gray-800 font-mono text-[11px]">
                {task.session_id.slice(0, 16)}…
              </span>
            </div>
          )}
        </div>
      </header>

      {/* Body — 🆕 飞书 R139 第二批: min-h-0 + overflow-y-auto 让长 transcript 可滚动
          (父级 flex flex-col 已就位, 这里补上 overflow 闭环). */}
      <div className="flex-1 min-h-0 overflow-y-auto max-w-4xl w-full mx-auto p-6">
        <article
          className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 max-w-none break-words leading-relaxed text-sm text-gray-700
            [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-4 [&_h1]:pb-2 [&_h1]:border-b [&_h1]:border-gray-200 [&_h1]:text-gray-900
            [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-gray-800
            [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-gray-800
            [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-gray-700
            [&_p]:my-2
            [&_pre]:bg-gray-900 [&_pre]:text-gray-100 [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-3 [&_pre]:text-xs [&_pre]:whitespace-pre-wrap
            [&_code]:bg-blue-50 [&_code]:text-blue-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
            [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0 [&_pre_code]:whitespace-pre
            [&_strong]:font-semibold [&_strong]:text-gray-900
            [&_em]:italic
            [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2
            [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2
            [&_li]:my-0.5
            [&_br]:content-['']
            [&_a]:text-blue-600 [&_a]:underline
            "
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}