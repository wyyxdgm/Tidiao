// GET    /api/requirements/[id] - 单条 + 关联 task 列表
// PATCH  /api/requirements/[id] - 白名单局部更新
// DELETE /api/requirements/[id] - 软删 (status='closed')
//
// 飞书 R60 P0 §4.2:
//   - GET 返回 requirement + 关联 task 列表 (含 status/depends_on)
//   - PATCH 严格按白名单, id/project_id/source/created_at/updated_at 禁改
//   - DELETE 不物理删, 走 status='closed' (软删, GET 仍可见但前端按 status 渲染)

import { NextRequest, NextResponse } from "next/server";
import {
  getRequirementById,
  updateRequirement,
  softDeleteRequirement,
  getRequirementTasks,
  hasCompletedImplementationTask,
  REQUIREMENT_UPDATE_FIELDS,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from "@/lib/db/requirements";
import { getVersionById } from "@/lib/db/versions";
import { parseActorFromRequest } from "@/lib/server-actor";

type Params = { params: Promise<{ id: string }> };

// GET: 单条 + 关联 task 列表 + invariant 提示字段 (R78 W1 §4.3)
export async function GET(_request: NextRequest, { params }: Params) {
  const userId = _request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const req = getRequirementById(id, userId);
  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  // 关联 task + 依赖图 (森林 API 内联, 避免前端两次调用).
  const tasks = getRequirementTasks(id);
  // R78 W1 §4.3: 让 UI 一次拿全 — eligible_for_done 是 UI 「标记完成」按钮 disabled 的判据.
  return NextResponse.json({
    ...req,
    tasks: tasks.tasks,
    eligible_for_done: hasCompletedImplementationTask(id, userId),
  });
}

// PATCH: 白名单局部更新
export async function PATCH(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // 拒收非白名单字段 (显式拒, 不静默, 让前端知道哪些被拒)
  const allowedSet = new Set<string>(REQUIREMENT_UPDATE_FIELDS);
  const rejected: string[] = [];
  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) rejected.push(key);
  }
  if (rejected.length > 0) {
    return NextResponse.json(
      {
        error: `fields not allowed: ${rejected.join(",")}`,
        code: "FIELDS_NOT_ALLOWED",
        allowed: [...REQUIREMENT_UPDATE_FIELDS],
      },
      { status: 400 }
    );
  }

  // status 校验 (DB CHECK 兜底, 应用层显式校验, 报错更友好)
  if (body.status !== undefined && body.status !== null) {
    if (!REQUIREMENT_STATUSES.includes(body.status as RequirementStatus)) {
      return NextResponse.json(
        { error: `status must be one of: ${REQUIREMENT_STATUSES.join(",")}`, code: "STATUS_INVALID" },
        { status: 400 }
      );
    }
  }

  // priority 校验 (PATCH 越界由 DB 层 updateRequirement 静默忽略; 这里显式拒更友好)
  if (body.priority !== undefined && body.priority !== null) {
    if (typeof body.priority !== "number" || body.priority < 1 || body.priority > 5 || !Number.isInteger(body.priority)) {
      return NextResponse.json(
        { error: "priority must be integer 1-5", code: "PRIORITY_OUT_OF_RANGE" },
        { status: 400 }
      );
    }
  }

  // tags 校验
  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags) || !body.tags.every((t: unknown) => typeof t === "string" && t.length > 0)) {
      return NextResponse.json(
        { error: "tags must be non-empty string[]", code: "TAGS_INVALID" },
        { status: 400 }
      );
    }
  }

  // progress 校验 (v517 / R196): null = 清空(未评估); 整数 0-100 = 写入.
  if (body.progress !== undefined && body.progress !== null) {
    if (
      typeof body.progress !== "number" ||
      !Number.isInteger(body.progress) ||
      body.progress < 0 ||
      body.progress > 100
    ) {
      return NextResponse.json(
        { error: "progress must be integer 0-100 or null", code: "PROGRESS_INVALID" },
        { status: 400 }
      );
    }
  }

  // R64: version_id 校验. null = 显式置空 (跨版本迁移); string = 必须存在 +
  // 属当前 requirement 的 project. 校验交由 updateRequirement 内部做 (404/跨
  // project 静默忽略, 与 priority 越界同口径).
  if (body.version_id !== undefined && body.version_id !== null) {
    if (typeof body.version_id !== "string" || body.version_id.length === 0) {
      return NextResponse.json(
        { error: "version_id must be non-empty string or null", code: "VERSION_ID_INVALID" },
        { status: 400 }
      );
    }
    // 提前查一次, 给前端更明确 404 (与 POST 行为对齐). updateRequirement 内部
    // 仍会再校验 (防并发).
    const ver = getVersionById(body.version_id, userId);
    if (!ver) {
      return NextResponse.json(
        { error: "Version not found", code: "VERSION_NOT_FOUND" },
        { status: 404 }
      );
    }
    const existing = getRequirementById(id, userId);
    if (existing && ver.project_id !== existing.project_id) {
      return NextResponse.json(
        { error: "version_id must belong to the same project as this requirement", code: "VERSION_PROJECT_MISMATCH" },
        { status: 400 }
      );
    }
  }

  // 存在性 + owner 校验: updateRequirement 内部会做, 返回 null = 不存在或跨 owner.
  // 一律 404 (no existence leak).

  // R78 W1 §4.4 幂等性: 同 status 重复 PATCH = 短路 (返 200 + 不动 DB, 防死循环).
  // M reject 修复 (Bug 1): 仅当 body 只有 status 一个字段时才短路 — 否则
  // PATCH {status: current.status, title: "新"} 会静默丢 title. 多字段 PATCH 必须
  // 走 updateRequirement 把 title 等其他改动一并落库.
  if (body.status !== undefined && body.status !== null) {
    // undefined 不算字段 (与 updateRequirement 的"undefined = 不写"语义对齐).
    const definedKeys = Object.keys(body).filter(
      (k) => body[k] !== undefined
    );
    const isStatusOnlyPatch = definedKeys.length === 1 && definedKeys[0] === "status";
    if (isStatusOnlyPatch) {
      const current = getRequirementById(id, userId);
      if (current && current.status === (body.status as RequirementStatus)) {
        return NextResponse.json(current);
      }
    }
  }

  // R78 W1 §4.3 (a) invariant: status 想从非 done 跳 done 时, 必须已有 ≥1 个
  // type ∈ {dev,test,deploy} + status='completed' 的 task. 设计/调研 task 完成
  // (含 reviewing) 不能把 requirement 标 done (damo 痛点核心).
  // 注意: PATCH 路径上 isIncomingDone 检测, 不看 "from" 状态 (current.status 已是
  // done 也算合法 idempotent 短路在上一步已返 200). 这里只挡"想变 done 但没实现".
  if (body.status === "done") {
    const eligible = hasCompletedImplementationTask(id, userId);
    if (!eligible) {
      return NextResponse.json(
        {
          error: "Cannot mark requirement as done: at least one task with type ∈ {dev,test,deploy} must be completed first.",
          code: "REQUIREMENT_DONE_GUARD",
          hint: "Check GET /api/requirements/[id] response field `eligible_for_done` before patching.",
        },
        { status: 400 }
      );
    }
  }

  // progress_source 不在白名单 (API 层禁改, 防伪造来源): route 按语义固定 'manual'
  // (人工/agent 经 API 修正都算 manual; 规则算走 POST /progress 内部传 'rule').
  const patch = { ...body };
  if (patch.progress !== undefined) {
    patch.progress_source = "manual";
  }
  const updated = updateRequirement(id, patch, userId, parseActorFromRequest(request, userId));
  if (!updated) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}

// DELETE: 软删 (status='closed')
export async function DELETE(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ok = softDeleteRequirement(id, userId, parseActorFromRequest(request, userId));
  if (!ok) {
    return NextResponse.json({ error: "Requirement not found or already closed" }, { status: 404 });
  }
  return NextResponse.json({ id, status: "closed" });
}
