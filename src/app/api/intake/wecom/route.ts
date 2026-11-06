// /api/intake/wecom - 企微微信客服入站回调.
//
// 功能: 接收企微回调（GET URL 验证 + POST 消息通知），解密验签，
//   sync_msg 拉取甲方消息，按 external_userid 查/建 intake thread task，
//   sendUserMessage 触发 agent 处理.
// 关注点: 企微要求 5s 内回 200; syncMessages 是异步 fetch 但通常 <2s;
//   处理出错也回 200（防企微重试风暴），靠 cursor 去重 + 甲方重发兜底;
//   路由在 middleware public 白名单里，不走 session，靠企微签名验签.

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getProjectById } from "@/lib/db/projects";
import {
  createIntakeThread,
  getIntakeThreadByExternal,
  markInbound,
} from "@/lib/db/intake-threads";
import {
  handleUrlVerification,
  isUrlVerification,
  decryptCallbackBody,
  extractCallbackCursor,
  syncMessages,
  ensureBotServiceState,
  getWecomChannelByKfId,
  listWecomCandidates,
  type WecomResolved,
} from "@/lib/intake/wecom";
import { buildIntakePrompt } from "@/lib/intake/prompt";
import { EXPLORE_TOOLS } from "@/lib/constants";

const INTAKE_PROJECT_ID = process.env.INTAKE_PROJECT_ID ?? "";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  if (!isUrlVerification(query)) {
    return NextResponse.json(
      { error: "missing verification params" },
      { status: 400 },
    );
  }
  // 凭据候选: channel 行在前逐个试, env 兜底殿后 (D1) —— 谁验签通过用谁
  for (const cand of listWecomCandidates()) {
    const plain = handleUrlVerification(query, cand.creds);
    if (plain !== null) {
      // 企微 URL 验证: 返回解密后的 echostr 明文
      return new NextResponse(plain, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }
  return NextResponse.json({ error: "signature mismatch" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const body = await request.text();

  try {
    // 凭据定位 (D1): wecom channel 行逐候选试解密 (谁验签通过用谁), env 兜底殿后
    // —— 查不到表行走旧 env 五常量, 现网回调行为不回退
    let resolved: WecomResolved | null = null;
    let plain: string | null = null;
    for (const cand of listWecomCandidates()) {
      plain = decryptCallbackBody(body, query, cand.creds);
      if (plain !== null) {
        resolved = cand;
        break;
      }
    }
    if (!resolved || plain === null) {
      return NextResponse.json(
        { error: "decrypt/signature failed" },
        { status: 403 },
      );
    }

    const cursor = extractCallbackCursor(plain);
    if (cursor === null) {
      // 非消息事件（如 enter_session），忽略
      return NextResponse.json({ ok: true });
    }

    // 拉取实际消息内容（微信客服 sync_msg 模式）
    const messages = await syncMessages(cursor, resolved.creds);
    if (messages.length === 0) {
      return NextResponse.json({ ok: true });
    }

    for (const msg of messages) {
      // 按消息 kf_id 精确定位渠道实例 (多账号场景); 消息没带 kf_id 或查不到
      // 表行时沿用解密时命中的来源 (唯一实例行或 env 兜底)
      let per = resolved;
      if (msg.kfId && msg.kfId !== resolved.creds.kfId) {
        per = getWecomChannelByKfId(msg.kfId) ?? resolved;
      }
      const projectId = per.boundProjectId ?? INTAKE_PROJECT_ID;
      const project = getProjectById(projectId);
      if (!project || !project.owner_id) {
        console.error(
          `[intake/wecom] project ${projectId} not found or has no owner (source=${per.channelId ?? "env"})`,
        );
        continue;
      }

      await processMessage(
        msg.externalUserId,
        msg.content,
        project.id,
        project.name,
        project.owner_id,
        per,
      );
    }
  } catch (err) {
    // 出错也回 200，防企微重试风暴; cursor 未推进，下次回调重拉
    console.error("[intake/wecom] callback error:", err);
  }

  return NextResponse.json({ ok: true });
}

// 功能: 按甲方 external_user_id 查/建 intake thread，触发 agent 处理.
// 关注点: 先把会话置为「智能助手接待」，否则会话流入人工/待接入池后 send_msg 发不出去.
async function processMessage(
  externalUserId: string,
  content: string,
  projectId: string,
  projectName: string,
  ownerId: string,
  resolved: WecomResolved,
): Promise<void> {
  await ensureBotServiceState(externalUserId, resolved.creds);

  const existing = getIntakeThreadByExternal("wecom", externalUserId);

  if (existing) {
    // 续聊: 重置 48h 窗口 + 发消息触发 auto-resume
    markInbound(existing.id);
    getRuntime().sendUserMessage(existing.task_id, content);
    return;
  }

  // 新甲方: 建 task + 启动 + 记 thread
  const prompt = buildIntakePrompt(projectName, content);
  const task = getRuntime().createTask({
    title: `甲方需求线程（${externalUserId.slice(-6)}）`,
    prompt,
    project_id: projectId,
    effort: "medium",
    maxTurns: 60,
    auto_approve: true,
    // 这条通道的 prompt 含外部甲方任意文本. 不显式传 allowedTools 会落到
    // DEFAULT_TOOLS(全开, 含 Bash/Write/Edit) —— 只读探索集足够售前问答.
    allowedTools: EXPLORE_TOOLS,
    tags: ["intake", "wecom"],
    // 渠道默认角色 (v526 D3): channel 行配了 role 则首 task 挂上 (照抄 telegram
    // route 的条件展开); role 随 task 定型, 后续消息进已有 thread 走 resume 不再变.
    // env 兜底路径 roleId=null 不传 → createTask 走原逻辑 (行为不回退).
    ...(resolved.roleId ? { role_id: resolved.roleId } : {}),
    // 绑定版本 (v529): 渠道行钉了 bound_version_id 则首 task 落该 version;
    // NULL (含 env 兜底路径) 时不传, createTask 走项目 current_version (行为不变).
    ...(resolved.versionId ? { version_id: resolved.versionId } : {}),
  });
  getRuntime().startTask(task.id, undefined, "intake_wecom");

  createIntakeThread({
    channel: "wecom",
    external_user_id: externalUserId,
    task_id: task.id,
    project_id: projectId,
    owner_id: ownerId,
  });
}
