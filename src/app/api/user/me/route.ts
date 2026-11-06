// GET /api/user/me — current user profile (role + admin LLM grant status).
// PATCH /api/user/me — update current user's settings. v27: preflight_enabled.
//   v41: notify_email（通知收件邮箱）。
//   v47: feishu_webhook_url（飞书自定义机器人 webhook URL）。
//   v515: git_name + git_email（账号级 git 提交身份，飞书 R178）—— 俩字段一次写。
//   v518: nickname + bio（用户身份：昵称 + 自我介绍，飞书 R222）—— 俩字段一次写。

import { NextRequest, NextResponse } from "next/server";
import {
  getUserById,
  toSafeUser,
  setUserPreflightEnabled,
  setUserNotifyEmail,
  isValidNotifyEmail,
  setUserFeishuWebhook,
  isValidFeishuWebhookUrl,
  setUserGitIdentity,
  isValidGitName,
  setUserProfile,
  isValidNickname,
  isValidBio,
  getUserByEmail,
} from "@/lib/db/users";
import { isUserGrantedAdminLlm } from "@/lib/db/llm-configs";
import { isMailerConfigured } from "@/lib/notify/mailer";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  const safe = toSafeUser(user);
  const adminLlmGranted = isUserGrantedAdminLlm(user.id, user.role);
  // mailer_configured 让 UI 能显示「平台未配 SMTP, 填了也发不出」而不是让用户
  // 点了测试才发现。只回布尔, **不回任何 SMTP 明文**。
  // feishu_configured (v47): 同样口径 —— webhook URL 是半秘密, GET 不回明文,
  //   设置 UI 看已配状态走单独 /api/user/me/webhook-meta 拿脱敏值。
  return NextResponse.json({
    ...safe,
    // 显式置 null, 不把 webhook 明文字段透出去 (与 mailer_configured 同款)
    feishu_webhook_url: undefined,
    admin_llm_granted: adminLlmGranted,
    mailer_configured: isMailerConfigured(),
    feishu_configured: !!safe.feishu_webhook_url,
    notify_fallback_to: process.env.NOTIFY_FALLBACK_TO?.trim() || null,
  });
}

export async function PATCH(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json();

  // v27: per-user preflight toggle. Only field exposed for now; future
  // user-level settings can extend the same body.
  if (typeof body.preflight_enabled === "boolean") {
    const updated = setUserPreflightEnabled(userId, body.preflight_enabled);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(toSafeUser(updated));
  }

  // v41: 通知收件邮箱。null / "" = 清空(回落系统邮箱 NOTIFY_FALLBACK_TO)。
  // 关注点: 用 "notify_email" in body 判断而不是真值判断 —— 否则传 "" 清空会被
  //   当成「没传这个字段」而落到下面的 400。
  if ("notify_email" in body) {
    const raw = body.notify_email;
    if (raw !== null && typeof raw !== "string") {
      return NextResponse.json(
        { error: "notify_email 必须是字符串或 null" },
        { status: 400 }
      );
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed && !isValidNotifyEmail(trimmed)) {
      return NextResponse.json(
        { error: "邮箱格式不正确" },
        { status: 400 }
      );
    }
    const updated = setUserNotifyEmail(userId, trimmed || null);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(toSafeUser(updated));
  }

  // v515: 账号级 git 提交身份. 任一字段出现在 body 即触发, 缺的那个保持现值
  //   (便于 UI 只改一处). null / "" = 清空回落默认 (email→账号邮箱, name→前缀).
  //   关注点: 校验 name 禁 < > 换行(git 硬性要求), email 复用 notify 的格式校验;
  //   email 额外查重 —— 填别人的账号邮箱会把提交冒名到他人头上, 直接拒绝.
  if ("git_name" in body || "git_email" in body) {
    const current = getUserById(userId);
    if (!current) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    const rawName = "git_name" in body ? body.git_name : current.git_name;
    const rawEmail = "git_email" in body ? body.git_email : current.git_email;
    for (const [field, raw] of [
      ["git_name", rawName],
      ["git_email", rawEmail],
    ] as const) {
      if (raw !== null && typeof raw !== "string") {
        return NextResponse.json(
          { error: `${field} 必须是字符串或 null` },
          { status: 400 }
        );
      }
    }
    const trimmedName = typeof rawName === "string" ? rawName.trim() : "";
    const trimmedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";
    if (trimmedName && !isValidGitName(trimmedName)) {
      return NextResponse.json(
        { error: "git 用户名不合法 (≤128 字符, 不能含 < > 或换行)" },
        { status: 400 }
      );
    }
    if (trimmedEmail && !isValidNotifyEmail(trimmedEmail)) {
      return NextResponse.json({ error: "git 邮箱格式不正确" }, { status: 400 });
    }
    if (trimmedEmail) {
      const clash = getUserByEmail(trimmedEmail);
      if (clash && clash.id !== userId) {
        return NextResponse.json(
          { error: "该邮箱已是其他账号的注册邮箱, 不能用作 git 提交邮箱" },
          { status: 409 }
        );
      }
    }
    const updated = setUserGitIdentity(userId, trimmedName || null, trimmedEmail || null);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(toSafeUser(updated));
  }

  // v518: 用户身份 (昵称 + 自我介绍, 飞书 R222). 任一字段出现在 body 即触发,
  //   缺的那个保持现值 (便于 UI 只改一处). null / "" = 清空回落默认
  //   (昵称→「用户」, 自我介绍→注入时省略整行).
  //   关注点: 昵称禁换行/控制字符 (单行展示字段); bio 多行自由文本只卡 2000 上限
  //   (防灌 agent 上下文). 与 v515 同款 "field in body" 判断 —— 传 "" 清空不能被
  //   当成「没传这个字段」.
  if ("nickname" in body || "bio" in body) {
    const current = getUserById(userId);
    if (!current) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    const rawNickname = "nickname" in body ? body.nickname : current.nickname;
    const rawBio = "bio" in body ? body.bio : current.bio;
    if (rawNickname !== null && typeof rawNickname !== "string") {
      return NextResponse.json(
        { error: "nickname 必须是字符串或 null" },
        { status: 400 }
      );
    }
    if (rawBio !== null && typeof rawBio !== "string") {
      return NextResponse.json(
        { error: "bio 必须是字符串或 null" },
        { status: 400 }
      );
    }
    const trimmedNickname = typeof rawNickname === "string" ? rawNickname.trim() : "";
    const trimmedBio = typeof rawBio === "string" ? rawBio.trim() : "";
    if (trimmedNickname && !isValidNickname(trimmedNickname)) {
      return NextResponse.json(
        { error: "昵称不合法 (≤64 字符, 不能含换行)" },
        { status: 400 }
      );
    }
    if (trimmedBio && !isValidBio(trimmedBio)) {
      return NextResponse.json(
        { error: "自我介绍过长 (≤2000 字符)" },
        { status: 400 }
      );
    }
    const updated = setUserProfile(userId, trimmedNickname || null, trimmedBio || null);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(toSafeUser(updated));
  }

  // v47: 飞书 webhook URL. null / "" = 清空(未配飞书渠道).
  //   关注点与 v41 一样: "feishu_webhook_url" in body 判断, 传 "" 视为清空.
  if ("feishu_webhook_url" in body) {
    const raw = body.feishu_webhook_url;
    if (raw !== null && typeof raw !== "string") {
      return NextResponse.json(
        { error: "feishu_webhook_url 必须是字符串或 null" },
        { status: 400 }
      );
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed && !isValidFeishuWebhookUrl(trimmed)) {
      return NextResponse.json(
        {
          error:
            "飞书 webhook URL 格式不正确, 必须是 https://open.feishu.cn/open-apis/bot/v2/hook/<token>",
        },
        { status: 400 }
      );
    }
    const updated = setUserFeishuWebhook(userId, trimmed || null);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(toSafeUser(updated));
  }

  return NextResponse.json(
    { error: "no supported fields to update" },
    { status: 400 }
  );
}
