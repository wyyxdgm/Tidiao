// Transcript visualization page - /transcript/[id]
// Server component: fetches task metadata + markdown transcript and hands off to client.

import { notFound } from "next/navigation";
import os from "os";
import TranscriptClient from "./transcript-client";
import { getTaskById } from "@/lib/db/tasks";
import { getEventsByTaskId } from "@/lib/db/events";
import { formatTranscriptMarkdown, formatSessionMarkdown } from "@/lib/transcript";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getServerUserId } from "@/lib/server-auth";

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

export default async function TranscriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getServerUserId();
  const task = getTaskById(id, userId) as Task | null;
  if (!task) return notFound();

  // 页面看的是完整会话(SDK transcript), verbosity=full 逐字呈现. SDK jsonl
  // 读不到时(session 未分配 / 文件被清) 退回 events 表的稀疏日志, 不让页面 500.
  let markdown: string;
  try {
    const messages = await getRuntime().getSessionHistory(id);
    markdown = formatSessionMarkdown(
      { ...task, source: os.hostname() },
      messages,
      { verbosity: "full" },
    );
  } catch {
    markdown = formatTranscriptMarkdown(id, getEventsByTaskId(id));
  }

  return <TranscriptClient task={task} markdown={markdown} />;
}