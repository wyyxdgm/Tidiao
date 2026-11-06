// POST /api/requirements/[id]/auto-dispatch
//   R78 W1 §4.5: in-app requirement 改动触发自动派发的接缝. W2 cron/sheetwatch 集成时复用.
//   内部行为: 创建一条 linked root task 并立刻启动 (autoStart=true). 重复触发 = 创建多条 task
//   (不查重, 调用方按场景决定去重 — 如 sheetwatch 已经做过 "diff since last poll" 判定).
//
// 设计要点:
//   - 入参: { title?, prompt?, type?, effort?, autoApprove?, maxTurns?, allowedTools? }
//     全部 optional, 不传 = 走默认 (type='dev', effort='high', autoApprove=true, maxTurns=200).
//   - 不传 title/prompt = 自动生成:
//       title = `[auto] ${requirement.title.slice(0, 80)}`
//       prompt = 复用 requirement.description (若有) + requirement_id 锚定指令, 提示 agent 读详情页.
//   - POST 后立刻调 runtime.startTask(). 启动失败不阻塞响应 (200 + 标识 started=false), 由
//     调用方决定是否重试 (sheetwatch 通常不会重试, 怕堆积).
//   - 校验 requirement.status != 'closed' (与 createTask 走同一防御, 这里复用 DB error 码).
//   - owner 隔离: 跨 owner / 不存在返 404 (与现有 API 口径一致, 不泄露存在性).
//   - quota: 走与 POST /api/tasks 同口径 (checkUserQuota), 拦截返 403 + QUOTA_BLOCKED.

import { NextRequest, NextResponse } from "next/server";
import {
  getRequirementById,
  type Requirement,
} from "@/lib/db/requirements";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { checkUserQuota } from "@/lib/db/users";
import type { TaskDefinition } from "@/lib/runtime/types";
import { AVAILABLE_TOOLS } from "@/lib/constants";

type Params = { params: Promise<{ id: string }> };

const ALLOWED_TASK_TYPES = ["design", "dev", "test", "deploy"] as const;
type AllowedTaskType = (typeof ALLOWED_TASK_TYPES)[number];

function buildPrompt(req: Requirement, requirementId: string): string {
  const desc = req.description?.trim();
  const base =
    `[auto-dispatch] 本任务由 R78 §4.5 自动派发接缝触发, 关联到需求点 ` +
    `"${req.title}" (requirement_id=${requirementId}).\n\n` +
    (desc
      ? `需求点描述:\n${desc}\n\n`
      : "需求点无 description 字段, 请直接访问详情页查看上下文.\n\n") +
    `请按需求点推进实现, 完成后回到本任务提交结论; 由需求点层做验收决策.`;
  return base;
}

export async function POST(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const req = getRequirementById(id, userId);
  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  // 闭需求点拒绝 — 与 POST /api/tasks 同口径 (REQUIREMENT_CLOSED 防御).
  if (req.status === "closed") {
    return NextResponse.json(
      { error: `Requirement ${id} is closed`, code: "REQUIREMENT_CLOSED" },
      { status: 400 }
    );
  }

  // quota 拦截 — 与 POST /api/tasks 入口同套判据.
  const quota = checkUserQuota(userId);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: quota.detail ?? "quota blocked",
        code: "QUOTA_BLOCKED",
        reason: quota.reason,
        quota,
      },
      { status: 403 }
    );
  }

  // 解析 body (允许空 body).
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    /* empty body OK */
  }

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : `[auto] ${req.title.slice(0, 80)}`;
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt
      : buildPrompt(req, id);
  // M reject 修复 (Bug 2): 与 POST /api/tasks 同口径, 显式校验 type.
  // 不传 / null → 走默认 "dev" (保持现有行为); 传非 string (排除 null) 或不在 ALLOWED_TASK_TYPES → 400 TYPE_INVALID.
  // 不静默回落 = 防止拼错的 "desin" 被悄悄当成 "dev" 跑实现.
  let type: AllowedTaskType | null = "dev";
  if (body.type !== undefined && body.type !== null) {
    if (typeof body.type !== "string") {
      return NextResponse.json(
        {
          error: `type must be one of: design,dev,test,deploy`,
          code: "TYPE_INVALID",
        },
        { status: 400 }
      );
    }
    if (!(ALLOWED_TASK_TYPES as readonly string[]).includes(body.type)) {
      return NextResponse.json(
        {
          error: `type must be one of: design,dev,test,deploy`,
          code: "TYPE_INVALID",
        },
        { status: 400 }
      );
    }
    type = body.type as AllowedTaskType;
  }
  const effort =
    typeof body.effort === "string" ? body.effort : "high";
  const autoApprove = body.autoApprove !== false; // 默认 true
  const maxTurns =
    typeof body.maxTurns === "number" && Number.isInteger(body.maxTurns) && body.maxTurns > 0
      ? body.maxTurns
      : 200;
  const allowedTools = Array.isArray(body.allowedTools)
    ? body.allowedTools.filter((t: unknown) => typeof t === "string")
    : [...AVAILABLE_TOOLS];
  // 启动开关: 默认 true (与 create-task-button 的「立即启动」对齐). cron/sheetwatch
  // 批量派发时可传 false = 只创建不启动, 后面再批量启动.
  const shouldStart = body.start !== false;

  if (!req.project_id) {
    return NextResponse.json(
      { error: "Requirement has no project_id (legacy data)", code: "PROJECT_REQUIRED" },
      { status: 400 }
    );
  }

  const def: TaskDefinition = {
    title,
    prompt,
    type,
    effort: effort as TaskDefinition["effort"],
    auto_approve: autoApprove,
    maxTurns,
    allowedTools,
    project_id: req.project_id,
    version_id: req.version_id ?? null,
    requirement_id: id,
    // 不挂 dispatched_by_task_id — auto-dispatch 由 cron/sheetwatch 触发,
    // 它们的 task_id 不一定在 owner 作用域 (跨进程派发可能). 留空 = null = 设计预期.
    dispatched_by_task_id: null,
  };

  try {
    const task = getRuntime().createTask(def);

    // 自动启动: 立即让 agent SDK 进入调度队列. 启动失败不抛 (task 已存在), 仅
    // 返 started=false 让调用方决定下一步 (sheetwatch 通常跳过重试).
    let started = false;
    let startedStatus: string | null = task.status;
    if (shouldStart) {
      try {
        getRuntime().startTask(task.id, undefined, "auto_dispatch");
        const refreshed = getTaskById(task.id, userId);
        startedStatus = refreshed?.status ?? task.status;
        started = true;
      } catch (startErr) {
        started = false;
        console.warn(
          `[auto-dispatch] task created but start failed: ${task.id} - ${(startErr as Error).message}`
        );
      }
    }

    return NextResponse.json(
      {
        task: { id: task.id, title: task.title, status: startedStatus, type: task.type },
        started,
        requirement_id: id,
      },
      { status: 201 }
    );
  } catch (err: any) {
    const code = (err as { code?: string })?.code;
    if (
      code &&
      [
        "PROJECT_REQUIRED",
        "PROJECT_NOT_FOUND",
        "VERSION_NOT_FOUND",
        "VERSION_PROJECT_MISMATCH",
        "DISPATCHER_NOT_FOUND",
        "REQUIREMENT_NOT_FOUND",
        "REQUIREMENT_CLOSED",
      ].includes(code)
    ) {
      return NextResponse.json(
        { error: (err as Error).message, code },
        { status: 400 }
      );
    }
    throw err;
  }
}