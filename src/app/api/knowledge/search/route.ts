// POST /api/knowledge/search — 跨源知识检索 (飞书 R92, 2026-09-06 拍板).
//
// 入参 (JSON body):
//   - query (必填, 非空字符串)
//   - project_id (可选, 限定到单 project; 不传 = 搜当前 user 全部可见 project)
//   - sources (可选, KnowledgeSource[] 子集; 不传 = 4 个源全跑)
//   - limit_per_source (可选, 默认 20, max 50)
//
// 出参:
//   - { query, total_hits, by_source: {tasks, requirements, requirement_cache, docs}, warnings }
//
// 关注点:
//   - 鉴权: x-user-id header (同 /api/notify 模式).
//   - 多租户: 全部走 searchKnowledge(input, userId) 让 DB 层做 owner_id 隔离.
//   - 永不抛错: 任一源失败 → 该源空 + warnings[], HTTP 仍 200 (前端可走 warnings 兜底).
//   - 不接 admin 跨 user 字段 (与 notify 一致: 不开放中继).
//   - 不落任何审计/事件: 检索是高频低敏操作, 写 events 表会爆.

import { NextRequest, NextResponse } from "next/server";
import {
  searchKnowledge,
  type KnowledgeSource,
  type SearchKnowledgeInput,
} from "@/lib/db/knowledge";

const ALLOWED_SOURCES: KnowledgeSource[] = [
  "tasks",
  "requirements",
  "requirement_cache",
  "docs",
  "symbols",
];

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

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { error: "query is required and must be non-empty", code: "QUERY_REQUIRED" },
      { status: 400 }
    );
  }
  if (query.length > 200) {
    return NextResponse.json(
      { error: "query too long (max 200 chars)", code: "QUERY_TOO_LONG" },
      { status: 400 }
    );
  }

  // project_id: 字符串校验, 非空才用
  const projectId =
    typeof body?.project_id === "string" && body.project_id.trim().length > 0
      ? body.project_id.trim()
      : undefined;

  // sources: 数组校验, 元素必须在白名单
  let sources: KnowledgeSource[] | undefined;
  if (Array.isArray(body?.sources)) {
    const invalid = body.sources.filter((s: unknown) => !ALLOWED_SOURCES.includes(s as KnowledgeSource));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `invalid sources: ${invalid.join(",")}`, code: "SOURCES_INVALID" },
        { status: 400 }
      );
    }
    sources = body.sources as KnowledgeSource[];
  }

  // limit_per_source: 数字校验, 范围 [1, 50]
  let limitPerSource: number | undefined;
  if (body?.limit_per_source !== undefined && body?.limit_per_source !== null) {
    const n = body.limit_per_source;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) {
      return NextResponse.json(
        { error: "limit_per_source must be integer 1-50", code: "LIMIT_INVALID" },
        { status: 400 }
      );
    }
    limitPerSource = n;
  }

  const input: SearchKnowledgeInput = {
    query,
    project_id: projectId,
    sources,
    limit_per_source: limitPerSource,
  };

  try {
    // T4: searchKnowledge 改 async (embeddings 源需 await embed); await 此处.
    const r = await searchKnowledge(input, userId);
    return NextResponse.json(r);
  } catch (e) {
    // searchKnowledge 内部已 try/catch 所有源, 走到这里 = 真·未预期错误
    console.error("[api/knowledge/search] unexpected error", e);
    return NextResponse.json(
      { error: "internal error", code: "INTERNAL" },
      { status: 500 }
    );
  }
}