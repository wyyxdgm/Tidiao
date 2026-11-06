// /api/intake/telegram - Telegram bot 入站 webhook (飞书 R184, P0).
//
// 功能: 接收 Telegram update, 验 secret_token 头, 处理两类消息:
//   1. "bind <码>" -> 校验 channel_configs.bind_code, 建 intake_thread (绑定 chat 到 project)
//   2. 普通文本 -> 查 thread: 有则续聊 (sendUserMessage 触发 auto-resume),
//      无则提示先绑定 (不自动建 task, 防陌生人消息白烧 agent 额度)
// 关注点: webhook URL 形态 /api/intake/telegram?c=<config_id>, config id 定位渠道实例;
//   Telegram 服务器对 webhook 无重试风暴问题 (2xx 即 ack), 出错也回 200 防重复投递;
//   路由在 middleware public 白名单 (与 /api/intake 同段, 各自验签).

import { NextRequest, NextResponse } from "next/server";
import { getChannelConfigById, getChannelConfigByBindCode } from "@/lib/db/channel-configs";
import {
  getIntakeThreadByExternal,
  createIntakeThread,
} from "@/lib/db/intake-threads";
import { getChannelAdapter } from "@/lib/intake/channels/registry";
import { getProjectById } from "@/lib/db/projects";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { buildIntakePrompt } from "@/lib/intake/prompt";
import { EXPLORE_TOOLS } from "@/lib/constants";

export async function POST(request: NextRequest) {
  const configId = request.nextUrl.searchParams.get("c");
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: true, skipped: "invalid json" });
  }

  try {
    const config = configId ? getChannelConfigById(configId) : null;
    const adapter = config ? getChannelAdapter(config.channel) : null;
    if (!config || !config.enabled || !adapter) {
      return NextResponse.json({ ok: true, skipped: "config not found or disabled" });
    }
    if (!adapter.verifyRequest(request, config)) {
      return NextResponse.json({ ok: true, skipped: "verify failed" }, { status: 403 });
    }

    const msg = adapter.parseInbound(payload);
    if (!msg) return NextResponse.json({ ok: true, skipped: "not a handled message" });

    // 绑定码: "bind ABCD1234" 或 "/start ABCD1234" (大小写不敏感, 允许多空格).
    // /start 是扫码 QR 深链 (https://t.me/<bot>?start=<码>) 的落地动作, 与 bind 并存.
    const bindMatch = msg.text.match(/^\/?(?:bind|start)\s+([A-Za-z0-9]{6,16})\s*$/i);
    if (bindMatch) {
      return NextResponse.json(
        await handleBind(config, adapter, msg.externalUserId, msg.externalUserName, bindMatch[1]),
      );
    }

    // 已绑定 -> 续聊; 未绑定 -> 引导
    const existing = getIntakeThreadByExternal("telegram", msg.externalUserId);
    if (!existing) {
      await adapter.sendMessage(config, { externalUserId: msg.externalUserId }, "尚未绑定项目。请先发送绑定码：bind <码>");
      return NextResponse.json({ ok: true, skipped: "not bound" });
    }

    getRuntime().sendUserMessage(existing.task_id, msg.text);
    return NextResponse.json({ ok: true, resumed: existing.task_id });
  } catch (err) {
    console.error("[intake/telegram] error:", err);
    return NextResponse.json({ ok: true });
  }
}

// 功能: 校验绑定码 -> 建 thread + 首个 task (同 wecom 模式: 首条绑定消息即需求起点).
async function handleBind(
  config: NonNullable<ReturnType<typeof getChannelConfigById>>,
  adapter: NonNullable<ReturnType<typeof getChannelAdapter>>,
  externalUserId: string,
  externalUserName: string | undefined,
  code: string,
): Promise<{ ok: boolean; bound?: boolean }> {
  const target = getChannelConfigByBindCode(code);
  if (!target) {
    await adapter.sendMessage(config, { externalUserId }, "绑定码无效。");
    return { ok: true };
  }

  // 同一 chat 换绑: 旧 thread 保留 (task 不动), 新建 thread 指向新 project
  const project = getProjectById(target.bound_project_id);
  if (!project?.owner_id) {
    await adapter.sendMessage(target, { externalUserId }, "绑定目标项目不存在。");
    return { ok: true };
  }

  const task = getRuntime().createTask({
    title: `甲方需求线程（${externalUserName ?? externalUserId.slice(-6)}）`,
    prompt: buildIntakePrompt(project.name, "（用户刚完成渠道绑定，此条无实际需求内容）", adapter.askStyleChannel),
    project_id: project.id,
    effort: "medium",
    maxTurns: 60,
    auto_approve: true,
    // 外部渠道任意文本输入, 只给只读探索集 (同 wecom, 见 constants.ts EXPLORE_TOOLS)
    allowedTools: EXPLORE_TOOLS,
    tags: ["intake", "telegram"],
    // 渠道默认角色 (v526 D3): 绑定码所属渠道配了 role 则首 task 挂上;
    // role 随 task 定型, 后续消息进已有 thread 走 resume 不再变.
    // 未配 (role_id NULL) 时不传, createTask 走原逻辑 (行为不变).
    ...(target.role_id ? { role_id: target.role_id } : {}),
    // 绑定版本 (v529): 渠道行钉了 bound_version_id 则首 task 落该 version;
    // NULL 时不传, createTask 走项目 current_version (行为不变).
    ...(target.bound_version_id ? { version_id: target.bound_version_id } : {}),
  });
  getRuntime().startTask(task.id, undefined, "intake_telegram");

  createIntakeThread({
    channel: "telegram",
    external_user_id: externalUserId,
    external_user_name: externalUserName,
    task_id: task.id,
    project_id: project.id,
    owner_id: project.owner_id,
  });

  await adapter.sendMessage(
    target,
    { externalUserId },
    `已绑定项目「${project.name}」。直接发消息即可，我会定位模块、拆解需求并回复。`,
  );
  return { ok: true, bound: true };
}
