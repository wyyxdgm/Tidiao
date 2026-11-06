// /api/projects/[id]/config/[key] — 单条 config 的 GET / PUT / DELETE.
//   GET 返明文 value; PUT 写 (upsert, 加密存); DELETE 删.
// 关注点: PUT body = {value: string}. 任何 string 都接受, 不强制 schema — caller
//   自己按 key 命名约定组织 (如 reuse-pool 用 bank_account_holder / bank_card_no
//   / bank_branch / payee_phone). 解密失败 404 而非 500 — 防止 ENCRYPTION_KEY 漂移
//   把整个列表接口炸掉.
//
// 🔴 owner 隔离 (2026-11-01 补): 本路由原先只校验「用户存在」, **没校验项目归属**
//   —— 任何登录用户都能读别人项目的明文凭据 (bank_card_no 等) 或改写它. 与
//   /api/projects/[id] 的既有口径对齐: 先 getProjectById(id, userId) 校验归属,
//   不过返 404 (不暴露项目存在性). admin **不**豁免 —— 凭据写操作仍严格 owner 隔离.
//
// 关注点: overview_md 也走这个表 (见 /api/projects/[id]/overview) — 但概览有自己
//   的专用路由 (带大小上限校验), 本路由对 overview_md 不做特殊处理 (通用 KV 语义).

import { NextRequest, NextResponse } from "next/server";
import { requireExistingUser } from "@/lib/auth-user-exists";
import { getProjectById } from "@/lib/db/projects";
import { OVERVIEW_CONFIG_KEY } from "@/lib/db/project-overview";
import {
  getProjectConfig,
  setProjectConfig,
  deleteProjectConfig,
} from "@/lib/db/project-configs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; key: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const { id, key } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const entry = getProjectConfig(id, key);
  if (!entry) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(entry);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; key: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const { id, key } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // 🔴 overview_md 走专用路由 (/api/projects/[id]/overview) —— 那里有大小上限 +
  //   「空串 = 清空但保留 key」的语义. 本通用 KV 接口放行它会造成两条写路径
  //   (通用 KV 不限大小) 与专用路由的语义分叉, 页面读到超限内容时行为不可预期.
  if (key === OVERVIEW_CONFIG_KEY) {
    return NextResponse.json(
      { error: "overview_md 请走 /api/projects/{id}/overview" },
      { status: 409 }
    );
  }
  let body: { value?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.value !== "string") {
    return NextResponse.json(
      { error: "value must be a string" },
      { status: 400 }
    );
  }
  const entry = setProjectConfig(id, key, body.value, userId);
  return NextResponse.json(entry);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; key: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const { id, key } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const deleted = deleteProjectConfig(id, key);
  if (!deleted) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}