// POST /api/requirements - 创建一条 in_app requirement
// GET  /api/requirements - 列需求 (信封装 {items, total, has_more, page, page_size})
//
// 飞书 R60 P0 新 spec (docs/plans/feishu-alternative-data-source.md §4.2):
//   - source 固定 'in_app' (DB CHECK 兜底; 接口层不接外部入参)
//   - status 默认 'pending'
//   - 多租户硬隔离: 所有读写带 owner_id

import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/db/projects";
import {
  createRequirement,
  listRequirements,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
  type RequirementSource,
} from "@/lib/db/requirements";
import { getVersionById } from "@/lib/db/versions";
import { parseActorFromRequest } from "@/lib/server-actor";

// POST: 新建一条 in_app 需求点
export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.project_id || typeof body.project_id !== "string") {
    return NextResponse.json(
      { error: "project_id is required", code: "PROJECT_REQUIRED" },
      { status: 400 }
    );
  }
  if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json(
      { error: "title is required", code: "TITLE_REQUIRED" },
      { status: 400 }
    );
  }

  // project 必须存在 + 属当前 user (no existence leak → 404)
  const project = getProjectById(body.project_id, userId);
  if (!project) {
    return NextResponse.json(
      { error: "Project not found", code: "PROJECT_NOT_FOUND" },
      { status: 404 }
    );
  }

  // priority 范围 1-5, 越界拒收 (与 DB 层 updateRequirement 的「越界忽略」不同:
  // POST 是新建, 不该静默吞; 显式 400 让前端立刻修).
  let priority: number | null = null;
  if (body.priority !== undefined && body.priority !== null) {
    if (typeof body.priority !== "number" || body.priority < 1 || body.priority > 5 || !Number.isInteger(body.priority)) {
      return NextResponse.json(
        { error: "priority must be integer 1-5", code: "PRIORITY_OUT_OF_RANGE" },
        { status: 400 }
      );
    }
    priority = body.priority;
  }

  // tags: 必须是 string[], 元素非空
  let tags: string[] | null = null;
  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags)) {
      return NextResponse.json(
        { error: "tags must be string[]", code: "TAGS_INVALID" },
        { status: 400 }
      );
    }
    if (!body.tags.every((t: unknown) => typeof t === "string" && t.length > 0)) {
      return NextResponse.json(
        { error: "tags must be non-empty string[]", code: "TAGS_INVALID" },
        { status: 400 }
      );
    }
    tags = body.tags as string[];
  }

  // R64: version_id 可选. 不传 = 默认 projects.current_version_id (DB 层兜);
  //   传 null = 显式不挂; 传字符串 = 必须存在 + 属当前 project.
  let versionId: string | null | undefined = undefined;
  if (body.version_id !== undefined) {
    if (body.version_id === null) {
      versionId = null;
    } else if (typeof body.version_id !== "string" || body.version_id.length === 0) {
      return NextResponse.json(
        { error: "version_id must be non-empty string or null", code: "VERSION_ID_INVALID" },
        { status: 400 }
      );
    } else {
      const ver = getVersionById(body.version_id, userId);
      if (!ver) {
        return NextResponse.json(
          { error: "Version not found", code: "VERSION_NOT_FOUND" },
          { status: 404 }
        );
      }
      if (ver.project_id !== body.project_id) {
        return NextResponse.json(
          { error: "version_id must belong to the same project as project_id", code: "VERSION_PROJECT_MISMATCH" },
          { status: 400 }
        );
      }
      versionId = body.version_id;
    }
  }

  const created = createRequirement(
    body.project_id,
    {
      title: body.title.trim(),
      description: body.description ?? null,
      priority,
      tags,
      version_id: versionId,
    },
    userId,
    parseActorFromRequest(request, userId)
  );

  return NextResponse.json(created, { status: 201 });
}

// GET: 列需求 (多租户过滤 + 分页)
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id") || undefined;
  const statusRaw = searchParams.get("status") || undefined;
  const sourceRaw = searchParams.get("source") || undefined;
  // R64: ?version_id=xxx 过滤某 version; ?version_id=null 过滤无 version; 不传 = 不过滤.
  const versionIdRaw = searchParams.get("version_id");
  let versionIdFilter: string | null | undefined = undefined;
  if (versionIdRaw !== null) {
    versionIdFilter = versionIdRaw === "null" ? null : versionIdRaw;
  }

  // status 支持逗号分隔多值 (例: ?status=done,blocked)
  let status: RequirementStatus | RequirementStatus[] | undefined;
  if (statusRaw) {
    const arr = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = arr.filter((s) => !REQUIREMENT_STATUSES.includes(s as RequirementStatus));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `invalid status: ${invalid.join(",")}`, code: "STATUS_INVALID" },
        { status: 400 }
      );
    }
    status = arr.length === 1 ? (arr[0] as RequirementStatus) : (arr as RequirementStatus[]);
  }

  // source 限定为 'in_app' (新 spec 唯一支持源)
  let source: RequirementSource | undefined;
  if (sourceRaw) {
    if (sourceRaw !== "in_app") {
      return NextResponse.json(
        { error: "source must be 'in_app'", code: "SOURCE_INVALID" },
        { status: 400 }
      );
    }
    source = "in_app";
  }

  const page = searchParams.get("page") ? parseInt(searchParams.get("page")!) : undefined;
  const pageSize = searchParams.get("page_size") ? parseInt(searchParams.get("page_size")!) : undefined;

  // page/page_size 类型校验
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    return NextResponse.json(
      { error: "page must be positive integer", code: "PAGE_INVALID" },
      { status: 400 }
    );
  }
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    return NextResponse.json(
      { error: "page_size must be 1-100", code: "PAGE_SIZE_INVALID" },
      { status: 400 }
    );
  }

  const out = listRequirements(
    { project_id: projectId, status, source, version_id: versionIdFilter, page, page_size: pageSize },
    userId
  );
  return NextResponse.json(out);
}
