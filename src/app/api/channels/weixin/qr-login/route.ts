// POST /api/channels/weixin/qr-login - 微信扫码登录: 建登录会话 (D3)
//
// 功能: owner 校验 → 调 iLink get_bot_qrcode → 服务端把 qrcode_img_content 编码成
//   QR SVG → 存内存 Map (TTL 10min) → 返回 { login_id, qr_svg, qr_url, expires_in }.
//   前端弹窗展示 SVG, 3s 轮询 GET .../qr-login/status.
// 关注点: bound_project_id 必填 (success 建渠道行时写入, channel 行归属必填);
//   role_id / bound_version_id 可选 (同 /api/channels POST 语义). iLink 不可达 → 502.

import { NextRequest, NextResponse } from "next/server";
import { createLoginSession } from "@/lib/intake/weixin-qr-login";
import { getProjectById } from "@/lib/db/projects";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const boundProjectId = typeof body.bound_project_id === "string" ? body.bound_project_id : "";
  if (!boundProjectId) {
    return NextResponse.json({ error: "bound_project_id is required" }, { status: 400 });
  }
  // 项目归属校验: 防跨 owner 建 channel 行 (与 /api/channels POST 同防线)
  const project = getProjectById(boundProjectId);
  if (!project || project.owner_id !== userId) {
    return NextResponse.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
  }
  try {
    const result = await createLoginSession({
      owner_id: userId,
      bound_project_id: boundProjectId,
      role_id: typeof body.role_id === "string" && body.role_id ? body.role_id : null,
      bound_version_id: typeof body.bound_version_id === "string" && body.bound_version_id ? body.bound_version_id : null,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[channels/weixin/qr-login] iLink error:", err);
    return NextResponse.json(
      { error: "微信 iLink 服务不可达，请稍后重试", code: "ILINK_UNREACHABLE" },
      { status: 502 },
    );
  }
}
