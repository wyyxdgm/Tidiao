// PATCH/DELETE /api/channels/[id] - owner-scoped (docs/plans/channel-role-ui.md D1)
//   PATCH 部分更新: undefined = 不改; secret 留空 ('' / null) = 不改 (route 层语义,
//   与 db 层 '' = 清除不同 — UI 密码框留空即不改, 清空凭据场景未开放);
//   role_id: undefined = 不改, null = 清除默认角色, string = 设置 (校验同 owner);
//   bound_version_id (v529): undefined = 不改, null/'' = 清除 (跟随 current_version),
//   string = 设置 (校验属于生效 bound_project_id → 400 VERSION_PROJECT_MISMATCH).
//   DELETE: owner 校验后删, 不级联 (intake thread 历史保留, 渠道只是失效).
//   错误: 404 CHANNEL_NOT_FOUND (no existence leak, 跨 owner 同码);
//         400 ROLE_NOT_FOUND (db 层 assertRoleUsable 抛错转码).

import { NextRequest, NextResponse } from "next/server";
import {
  deleteChannelConfig,
  getChannelConfigById,
  updateChannelConfig,
} from "@/lib/db/channel-configs";
import { toPublicChannelConfig, assertVersionInProject, VersionProjectMismatchError } from "../route";

async function getOwnedConfig(id: string, userId: string) {
  const config = getChannelConfigById(id);
  if (!config || config.owner_id !== userId) return null;
  return config;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = await getOwnedConfig(id, userId);
  if (!existing) {
    return NextResponse.json(
      { error: "Channel not found", code: "CHANNEL_NOT_FOUND" },
      { status: 404 },
    );
  }
  const body = await request.json();
  try {
    // 绑定版本校验 (v529): 校验「生效版本 ∈ 生效项目」—— 不只看本次传了什么,
    // 换绑项目 (bound_project_id) 而不动版本时, 存量版本也要跟着新项目复核,
    // 否则会出现版本挂在别的项目下的脏行 (intake 建 task 会被 createTask 拒).
    const rawVersion = body.bound_version_id;
    const boundVersionId =
      rawVersion === undefined
        ? undefined // 不改
        : rawVersion === null || rawVersion === ""
          ? null // 清除 = 跟随项目 current_version
          : String(rawVersion);
    const effectiveProjectId =
      body.bound_project_id !== undefined ? String(body.bound_project_id) : existing.bound_project_id;
    const effectiveVersionId = boundVersionId !== undefined ? boundVersionId : existing.bound_version_id;
    if (effectiveVersionId) {
      assertVersionInProject(effectiveVersionId, effectiveProjectId);
    }
    const config = updateChannelConfig(id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      // secret 留空 = 不改 (route 层把 '' / null 归一成 undefined; db 层 '' 是清除语义)
      secret:
        body.secret !== undefined && body.secret !== null && String(body.secret) !== ""
          ? String(body.secret)
          : undefined,
      bound_project_id:
        body.bound_project_id !== undefined ? String(body.bound_project_id) : undefined,
      bound_version_id: boundVersionId,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
      role_id:
        body.role_id === undefined
          ? undefined
          : body.role_id === null || body.role_id === ""
            ? null
            : String(body.role_id),
    });
    if (!config) {
      return NextResponse.json(
        { error: "Channel not found", code: "CHANNEL_NOT_FOUND" },
        { status: 404 },
      );
    }
    return NextResponse.json(toPublicChannelConfig(config));
  } catch (err: any) {
    if (err instanceof VersionProjectMismatchError) {
      return NextResponse.json(
        { error: err.message, code: "VERSION_PROJECT_MISMATCH" },
        { status: 400 },
      );
    }
    if (err.message?.includes("Role") && err.message?.includes("not found")) {
      return NextResponse.json(
        { error: "Role not found for this owner", code: "ROLE_NOT_FOUND" },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = await getOwnedConfig(id, userId);
  if (!existing) {
    return NextResponse.json(
      { error: "Channel not found", code: "CHANNEL_NOT_FOUND" },
      { status: 404 },
    );
  }
  deleteChannelConfig(id);
  return NextResponse.json({ ok: true });
}
