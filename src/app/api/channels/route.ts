// GET /api/channels - list channel configs (owner-scoped)
//   连带 bound project 名 + bound version 名 + 默认 role 名 (二次查询, 前端免拼);
//   secret / webhook_secret 不回传 → has_secret 布尔 (掩码语义).
// POST /api/channels - create channel config (docs/plans/channel-role-ui.md D1)
//   channel ∈ INTAKE_CHANNELS; secret 走 db 层 encrypt; role_id 可选,
//   校验存在 + 同 owner (db 层 assertRoleUsable, 抛错 → 400 ROLE_NOT_FOUND,
//   no existence leak: 不存在与跨 owner 同码); bound_version_id 可选 (v529),
//   必须属于 bound_project_id → 400 VERSION_PROJECT_MISMATCH.

import { NextRequest, NextResponse } from "next/server";
import { INTAKE_CHANNELS } from "@/lib/db/intake-threads";
import {
  createChannelConfig,
  getChannelConfigsByOwner,
  type ChannelConfig,
} from "@/lib/db/channel-configs";
import { getProjectById } from "@/lib/db/projects";
import { getRoleById } from "@/lib/db/roles";
import { getVersionById } from "@/lib/db/versions";

export interface PublicChannelConfig {
  id: string;
  channel: string;
  name: string;
  bound_project_id: string;
  project_name: string | null;
  bound_version_id: string | null;
  version_name: string | null; // null = 跟随项目 current_version
  bind_code: string;
  role_id: string | null;
  role_name: string | null;
  enabled: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
}

// 功能: config → 对外形态. 剥掉 secret / webhook_secret 凭据, 换 has_secret 布尔;
//   连带 project 名 + version 名 + role 名 (role 用行 owner 查, 与 db 层 assertRoleUsable 同口径).
export function toPublicChannelConfig(config: ChannelConfig): PublicChannelConfig {
  const project = getProjectById(config.bound_project_id);
  const role = config.role_id ? getRoleById(config.role_id, config.owner_id) : null;
  // 版本名连带 (v529): 行 owner 查 (与 role 同口径), 跨 owner 版本查不到 → 名落 null,
  // id 照回 (编辑表单需要 id 回显, 不做 existence leak 防护 —— owner 数据不出域).
  const version = config.bound_version_id
    ? getVersionById(config.bound_version_id, config.owner_id)
    : null;
  return {
    id: config.id,
    channel: config.channel,
    name: config.name,
    bound_project_id: config.bound_project_id,
    project_name: project?.name ?? null,
    bound_version_id: config.bound_version_id,
    version_name: version?.name ?? null,
    bind_code: config.bind_code,
    role_id: config.role_id,
    role_name: role?.name ?? null,
    enabled: config.enabled,
    has_secret: config.secret !== null && config.secret !== "",
    created_at: config.created_at,
    updated_at: config.updated_at,
  };
}

// 功能: 校验 bound_version_id (v529) —— 存在且属于 boundProjectId.
// 关注点: 空/undefined 由调用方归一, 这里只管非空值; 不归属抛 Error,
//   由 route catch 转 400 VERSION_PROJECT_MISMATCH.
export function assertVersionInProject(versionId: string, boundProjectId: string): void {
  const version = getVersionById(versionId);
  if (!version || version.project_id !== boundProjectId) {
    throw new VersionProjectMismatchError();
  }
}

export class VersionProjectMismatchError extends Error {
  constructor() {
    super("bound_version_id does not belong to bound_project_id");
  }
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const configs = getChannelConfigsByOwner(userId);
  return NextResponse.json(configs.map(toPublicChannelConfig));
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json();
  if (!body.channel || !body.name || !body.bound_project_id) {
    return NextResponse.json(
      { error: "channel, name and bound_project_id are required" },
      { status: 400 },
    );
  }
  if (!(INTAKE_CHANNELS as readonly string[]).includes(String(body.channel))) {
    return NextResponse.json(
      { error: `channel must be one of: ${INTAKE_CHANNELS.join(", ")}`, code: "INVALID_CHANNEL" },
      { status: 400 },
    );
  }
  try {
    // 绑定版本校验 (v529): 传了非空值必须属于 bound_project_id, 否则 intake 线路
    // 会把 task 建到别的项目下 —— route 层硬校验, db 层不重复.
    const boundVersionId = body.bound_version_id ? String(body.bound_version_id) : null;
    if (boundVersionId) {
      assertVersionInProject(boundVersionId, String(body.bound_project_id));
    }
    const config = createChannelConfig({
      channel: String(body.channel),
      name: String(body.name).trim(),
      secret: body.secret ? String(body.secret) : undefined,
      bound_project_id: String(body.bound_project_id),
      bound_version_id: boundVersionId,
      role_id: body.role_id ? String(body.role_id) : null,
      owner_id: userId,
    });
    return NextResponse.json(toPublicChannelConfig(config), { status: 201 });
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
