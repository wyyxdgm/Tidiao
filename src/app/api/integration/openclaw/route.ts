// /api/integration/openclaw - OpenClaw (mac openclaw-gateway) 入站派发端点.
//
// 功能: 接收 mac OpenClaw POST 指令, HMAC 验签, 解析 JSON, 按 trace_id 幂等派 task
//   到指定 project; 复用 intake_threads 落 (channel="openclaw", external_user_id="trace:<id>")
//   实现去重. 出站不回推 OpenClaw (board-R87: 通知统一走飞书).
// 关注点: 路由在 middleware public 白名单, 不走 session; 鉴权全靠 OPENCLAW_WEBHOOK_SECRET
//   HMAC-SHA256(`<ts>.<body>`); 时间戳漂移 > 5min 拒; 同 trace_id 重发走 UNIQUE(channel,
//   external_user_id) 兜底 (mode: replay); 不同 trace_id + 同 target 视为新派; 同 trace_id
//   + 不同 target 走 409 拒绝 (幂等优先于「retry 改派」); 不改 schema (intake_threads.channel
//   是 TEXT, 加 "openclaw" 只是 TS 字面量扩展).

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getDb } from "@/lib/db";
import { getProjectById } from "@/lib/db/projects";
import { createIntakeThread, getIntakeThreadByExternal } from "@/lib/db/intake-threads";

const WEBHOOK_SECRET = process.env.OPENCLAW_WEBHOOK_SECRET ?? "";
const FALLBACK_PROJECT_ID = process.env.INTAKE_OPENCLAW_PROJECT_ID ?? "";
const SKEW_MS = 5 * 60 * 1000; // 5 min

// 限默认工具集 = 仅 Read 类 (openclaw 是机器触发, 不该给 Bash/Write/Edit 默认值).
// 调用方显式传 payload.allowed_tools 时仍按调用方; 缺省 = 全开 (DEFAULT_TOOLS).
// 之所以这里不做默认限 = 设计选择: OpenClaw 派的多是「让 partner 干活」类任务,
// 需要 Bash/Write. 鉴权已通过 HMAC, 默认开更顺; 真要限在 payload 里传 allowed_tools.

const openclawRequestSchema = z
  .object({
    action: z.literal("dispatch"),
    trace_id: z.string().uuid(),
    source: z.string().min(1).max(128),
    ts: z.string().min(1),
    target: z
      .object({
        project_id: z.string().min(1).optional(),
        project_slug: z.string().min(1).optional(),
      })
      .optional(),
    payload: z.object({
      title: z.string().min(1).max(256).optional(),
      prompt: z.string().min(1),
      tags: z.array(z.string()).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      auto_approve: z.boolean().optional(),
      allowed_tools: z.array(z.string()).optional(),
    }),
    reply_to: z.literal("feishu").optional(),
  })
  .strict();

// 功能: HMAC-SHA256(`<ts>.<body>`) hex, 与 header 比对. 失败统一返 false, 错误原因走 403.
// 关注点: timingSafeEqual 要求等长 buffer; secret 未配置直接 false (防空 secret 比对通过).
function verifyHmac(rawBody: string, timestamp: string, signatureHeader: string | null): boolean {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  if (provided.length !== 64) return false;
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// 功能: 把 target 解析成 project_id. 优先 project_id; 否则按 name (UNIQUE) 查 projects 表;
//   都缺则回退 env FALLBACK_PROJECT_ID; 全无则返回 null (caller 返 400).
function resolveTargetProjectId(
  target: { project_id?: string; project_slug?: string } | undefined
): string | null {
  if (target?.project_id) return target.project_id;
  if (target?.project_slug) {
    const row = getDb()
      .prepare("SELECT id FROM projects WHERE name = ? AND deleted_at IS NULL")
      .get(target.project_slug) as { id: string } | undefined;
    return row?.id ?? null;
  }
  return FALLBACK_PROJECT_ID || null;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const ts = request.headers.get("x-openclaw-timestamp") ?? "";
  const sig = request.headers.get("x-openclaw-signature");

  // 1. 鉴权
  if (!ts || !sig || !verifyHmac(rawBody, ts, sig)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "signature or timestamp invalid" },
      { status: 403 }
    );
  }

  // 2. 时间戳漂移
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SKEW_MS) {
    return NextResponse.json(
      { ok: false, error: "stale", message: "timestamp skew > 5min" },
      { status: 408 }
    );
  }

  // 3. JSON 解析
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad_json", message: "body is not valid JSON" },
      { status: 400 }
    );
  }

  // 4. schema 校验
  const parsed = openclawRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "bad_schema",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
      { status: 400 }
    );
  }

  const req = parsed.data;
  const externalUserId = `trace:${req.trace_id}`;

  // 5. 幂等: 先查 intake_thread (channel + external_user_id UNIQUE).
  //    命中 → 同 target = 200 replay; 不同 target = 409 拒绝 (幂等优先).
  const existing = getIntakeThreadByExternal("openclaw", externalUserId);
  if (existing) {
    const project = getProjectById(req.target?.project_id ?? FALLBACK_PROJECT_ID);
    const resolvedTarget =
      (req.target?.project_id ?? null) ??
      (req.target?.project_slug
        ? (getDb()
            .prepare("SELECT id FROM projects WHERE name = ? AND deleted_at IS NULL")
            .get(req.target.project_slug) as { id: string } | undefined)?.id ?? null
        : null) ??
      FALLBACK_PROJECT_ID;
    if (resolvedTarget && existing.project_id !== resolvedTarget) {
      return NextResponse.json(
        {
          ok: false,
          error: "trace_conflict",
          message: `trace_id ${req.trace_id} already bound to project ${existing.project_id}`,
          task_id: existing.task_id,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        task_id: existing.task_id,
        mode: "replay",
        project_id: existing.project_id,
        trace_id: req.trace_id,
      },
      { status: 200 }
    );
  }

  // 6. 解析 target
  const projectId = resolveTargetProjectId(req.target);
  if (!projectId) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_target",
        message:
          "target missing and INTAKE_OPENCLAW_PROJECT_ID env not set; supply target.project_id or target.project_slug",
      },
      { status: 400 }
    );
  }

  const project = getProjectById(projectId);
  if (!project || !project.owner_id) {
    return NextResponse.json(
      {
        ok: false,
        error: "target_unreachable",
        message: `project ${projectId} not found or has no owner`,
      },
      { status: 502 }
    );
  }

  // 7. 派 task + 落 thread
  try {
    const task = getRuntime().createTask({
      title: req.payload.title ?? `OpenClaw: ${req.payload.prompt.slice(0, 60)}`,
      prompt: req.payload.prompt,
      project_id: project.id,
      auto_approve: req.payload.auto_approve ?? true,
      effort: req.payload.effort ?? "medium",
      tags: Array.from(new Set([...(req.payload.tags ?? []), "openclaw", `src:${req.source}`])),
      ...(req.payload.allowed_tools ? { allowedTools: req.payload.allowed_tools } : {}),
    });

    createIntakeThread({
      channel: "openclaw",
      external_user_id: externalUserId,
      task_id: task.id,
      project_id: project.id,
      owner_id: project.owner_id,
    });

    return NextResponse.json(
      {
        ok: true,
        task_id: task.id,
        mode: "created",
        project_id: project.id,
        trace_id: req.trace_id,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[integration/openclaw] dispatch failed:", err);
    return NextResponse.json(
      { ok: false, error: "internal", message: "createTask failed" },
      { status: 500 }
    );
  }
}

// GET 仅用于 mac 联通性探针 (无鉴权, 只回 200 + 配置状态). 真实业务必须 POST.
export async function GET() {
  return NextResponse.json({
    ok: true,
    mode: "probe",
    secret_configured: Boolean(WEBHOOK_SECRET),
    fallback_project_configured: Boolean(FALLBACK_PROJECT_ID),
  });
}

// 单元测试辅助: 暴露 verifyHmac + resolveTargetProjectId + schema.
// 关注点: 仅供 *.test.ts 引用, 不要在生产代码路径中调.
export const __test__ = { verifyHmac, resolveTargetProjectId, openclawRequestSchema };
