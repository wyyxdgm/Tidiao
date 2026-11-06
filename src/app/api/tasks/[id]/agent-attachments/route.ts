// POST /api/tasks/[id]/agent-attachments - agent 端把本地文件注册成 task attachment
//
// R121 设计: agent 子进程 (mmx / minimax-cli / 其他) 调本端点把已写到磁盘的
// 文件 (例如 mmx --out 输出的图) 注册成 attachment. 走 JSON body 不走
// multipart — 避免 10MB base64 序列化, agent 端 `curl --data-binary '{...}'`
// 一行就够. 服务端 fs.copyFileSync 到 storageDir + symlink + DB row, 然后
// emitAttachment 触发 SSE, chat timeline 自动显示.
//
// 与现成 multipart 端点 /api/tasks/[id]/attachments 的关系:
//   - 现成 multipart = 用户上传路径 (前端 File 走 FormData)
//   - 本端点 = agent 上传路径 (curl JSON body 走 file_path)
//   - 两端点共享 saveAttachmentFromFile / linkIntoTaskCwd / emitAttachment / 白名单
//
// 鉴权: 与现成 API 一致, 中间件把 Authorization: Bearer $AO_TOKEN 翻译为 x-user-id.
// agent buildEnv() 自动注入 AO_TOKEN (per-user bearer, 跨进程跨用户隔离).

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import { registerAttachmentFromPath } from "@/lib/db/attachments";
import { getRuntime } from "@/lib/runtime/agent-runtime";

interface AgentAttachmentRequest {
  file_path: string;             // 必填, agent 端文件绝对路径
  filename?: string;             // 可选, 默认 basename(file_path)
  media_type?: string;           // 可选, 默认按扩展名推断
  source?: "agent_generated";    // 默认 agent_generated
  metadata?: {                   // 可选, JSON.stringify 后落 attachments.metadata
    tool?: string;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    model?: string;
    prompt?: string;
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: AgentAttachmentRequest;
  try {
    body = (await request.json()) as AgentAttachmentRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.file_path || typeof body.file_path !== "string") {
    return NextResponse.json({ error: "file_path is required (string)" }, { status: 400 });
  }

  const filename = body.filename || body.file_path.split("/").pop() || "attachment";
  const mediaType = body.media_type || "";
  const metadata = body.metadata ? JSON.stringify(body.metadata) : undefined;

  const result = registerAttachmentFromPath(task, userId, body.file_path, {
    filename,
    mediaType,
    source: body.source || "agent_generated",
    metadata,
  });

  if (!result.ok) {
    // 区分越界 vs 文件不存在 vs 大小超限 vs 白名单挡 —— 给 agent 端可读的错误
    const status = result.reason.startsWith("file_path must be inside") ? 400
      : result.reason.startsWith("source") ? 400
      : result.reason.startsWith("file too large") ? 413
      : result.reason.startsWith("unsupported media type") ? 415
      : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }

  const { attachment } = result;

  // 触发 SSE —— 与 multipart 端点完全相同的 emit 路径, chat timeline 自动显示
  getRuntime().emitAttachment(id, {
    id: attachment.id,
    filename: attachment.filename,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
  });

  return NextResponse.json({ attachment }, { status: 201 });
}
