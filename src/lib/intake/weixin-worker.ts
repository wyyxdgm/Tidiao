// 微信渠道长轮询 worker (docs/plans/channel-qr-bind.md D3).
//
// 功能: 进程内常驻轮询 —— 每 TICK 2s 扫一次 channel_configs 里 enabled=1 的
//   weixin 行, 每行无在跑轮询则起一轮 getUpdates 长轮询 (90s 挂起) → 逐条
//   handleInbound (bind 命令 / 续聊 / 未绑引导 / 语音转写 / 非文本兜底话术) → 整批
//   成功后提交游标.
// 挂载点: instrumentation.ts register() (server 启动), 单例 interval.
//
// 关注点:
// - 🔴 游标纪律 (ZCode 同款): get_updates_buf 是服务端 ack 语义 —— 只有本批消息
//   全部业务处理成功才持久化; 失败不提交, 下轮 getUpdates 重投本批 (at-least-once).
//   重投由内存 msgId 去重兜住 (bind 重复建 task / 续聊重复 resume).
// - 多行各自独立游标 (KV key 按 channelId 隔离); 渠道行停用/删除后自然不再轮询.
// - processMessage 对外发消息走 iLink sendmessage (国内直连可达, 无代理依赖);
//   与 telegram webhook 形态不同, 本 worker 是唯一入站消费方, 无 webhook 路由.

import {
  getChannelConfigByBindCode,
  listChannelConfigs,
  type ChannelConfig,
} from "@/lib/db/channel-configs";
import {
  createIntakeThread,
  getIntakeThreadByExternal,
  markInbound,
} from "@/lib/db/intake-threads";
import { getProjectById } from "@/lib/db/projects";
import { getSetting, setSetting } from "@/lib/db/settings";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { EXPLORE_TOOLS } from "@/lib/constants";
import { buildIntakePrompt } from "@/lib/intake/prompt";
import { transcribeAudio } from "@/lib/intake/weixin-asr";
import { downloadWeixinAudio, getUpdates, parseWeixinSecret, sendText, type WeixinAudioSource, type WeixinInbound } from "@/lib/intake/weixin";

const TICK_INTERVAL_MS = 2_000;

// 非文本消息兜底话术 (damo 2026-10-15: 发语音/图片毫无反应 = 对着空气说话, 必须回一句)
const FALLBACK_MEDIA_TEXT = "图片/视频等非文字消息暂不支持，请直接发文字 🙏";
const FALLBACK_VOICE_TEXT = "语音转写暂时不可用，请直接发文字 🙏";
// KV 游标 key (app_settings 表): 每渠道行一个, 服务重启游标保留 (不重投已 ack 消息)
function bufKey(channelId: string): string {
  return `weixin_get_updates_buf:${channelId}`;
}

// ---------------------------------------------------------------------------
// msgId 去重 (内存, at-least-once 重投兜底)
// ---------------------------------------------------------------------------

// Map<channelId, Map<msgId, firstSeenTs>>; 每渠道最多 200 条, 10 分钟过期
const seenMessages = new Map<string, Map<string, number>>();
const SEEN_MAX_PER_CHANNEL = 200;
const SEEN_TTL_MS = 10 * 60 * 1000;

// 功能: msgId 幂等检查. 返回 true = 本 worker 已处理过 (跳过); false = 新消息 (记录).
// 关注点: 无 msgId 的消息形态 (iLink 部分响应无 id) 不去重 —— 会重复处理, 但
//   at-least-once 下重复 bind/续聊是幂等的 (bind 已有线程走换绑, 续聊只是多 resume 一次),
//   比丢消息安全.
export function isDuplicateMessage(channelId: string, msgId: string): boolean {
  if (!msgId) return false;
  let seen = seenMessages.get(channelId);
  if (!seen) {
    seen = new Map();
    seenMessages.set(channelId, seen);
  }
  const now = Date.now();
  // 顺手清过期
  for (const [id, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(id);
  }
  if (seen.has(msgId)) return true;
  seen.set(msgId, now);
  if (seen.size > SEEN_MAX_PER_CHANNEL) {
    // 淘汰最早的一条 (Map 迭代序 = 插入序)
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 入站消息处理 (导出供测试)
// ---------------------------------------------------------------------------

// bind 码 regex: 与 feishu route 同款 (bind <码>, 大小写不敏感, 6-16 位字母数字).
// 微信无 /start 深链场景 (QR 是登录 QR, 不是绑定深链), 只认 bind.
const BIND_RE = /^bind\s+([A-Za-z0-9]{6,16})\s*$/i;

// 功能: 发渠道回执. secret 解析失败 / bot id 缺失 → 记日志放弃 (不抛, 不阻断游标提交).
async function sendReply(config: ChannelConfig, msg: WeixinInbound, text: string): Promise<void> {
  const cred = parseWeixinSecret(config.secret);
  if (!cred) {
    console.error(`[weixin-worker] channel ${config.id} secret invalid, reply dropped`);
    return;
  }
  await sendText(cred.bot_token, cred.ilink_bot_id, msg.fromUserId, text, msg.contextToken);
}

// 功能: bind 命令处理 —— 码必须属于当前收到消息的渠道行 (防串渠道: 拿 telegram 行
//   的码在微信里绑定会造成跨渠道线程). 通过 → 建 thread + 首 task (feishu 模式:
//   首条 prompt 要求 agent 回绑定成功确认).
export async function handleBind(
  config: ChannelConfig,
  msg: WeixinInbound,
  code: string,
): Promise<void> {
  const target = getChannelConfigByBindCode(code);
  if (!target || target.channel !== "weixin" || target.id !== config.id) {
    await sendReply(config, msg, "绑定码无效。请核对渠道管理页展示的绑定码后重试。");
    return;
  }
  const project = getProjectById(target.bound_project_id);
  if (!project?.owner_id) {
    console.error(`[weixin-worker] bind target project ${target.bound_project_id} missing (channel=${target.id})`);
    await sendReply(config, msg, "绑定目标项目不存在，请联系管理员。");
    return;
  }
  const task = getRuntime().createTask({
    title: `甲方需求线程（${msg.displayName ?? msg.fromUserId.slice(-6)}）`,
    prompt: buildIntakePrompt(
      project.name,
      "（用户刚完成渠道绑定，此条无实际需求内容。请先回复一句绑定成功确认，告知直接发需求即可。）",
      "h5", // 个人微信无窗口/条数限制, 多回合逐个问 (同 telegram/h5 节奏)
    ),
    project_id: project.id,
    effort: "medium",
    maxTurns: 60,
    auto_approve: true,
    // 外部渠道任意文本输入, 只给只读探索集 (同 wecom/telegram/feishu)
    allowedTools: EXPLORE_TOOLS,
    tags: ["intake", "weixin"],
    ...(target.role_id ? { role_id: target.role_id } : {}),
    ...(target.bound_version_id ? { version_id: target.bound_version_id } : {}),
  });
  getRuntime().startTask(task.id, undefined, "intake_weixin");
  createIntakeThread({
    channel: "weixin",
    external_user_id: msg.fromUserId,
    external_user_name: msg.displayName,
    task_id: task.id,
    project_id: project.id,
    owner_id: project.owner_id,
  });
  await sendReply(
    config,
    msg,
    `已绑定项目「${project.name}」。直接发消息即可，我会定位模块、拆解需求并回复。`,
  );
}

// 功能: 语音消息 → 转写文字, 失败 resolve null (走兜底话术).
// 关注点: 下载 + ASR 全程 catch, 任何失败只记日志 —— 不能让语音挂掉整条收消息链
//   (processMessage 抛错 = 游标不推 = 整批重投).
async function transcribeVoice(msg: WeixinInbound, audio: WeixinAudioSource): Promise<string | null> {
  try {
    const bytes = await downloadWeixinAudio(audio);
    const text = await transcribeAudio(bytes);
    if (!text) {
      console.warn(`[weixin-worker] voice transcribe empty (msgId=${msg.msgId || "none"})`);
    }
    return text;
  } catch (err) {
    console.error(`[weixin-worker] voice transcribe failed (msgId=${msg.msgId || "none"}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// 功能: 单条入站消息分发 (两段式: 未绑只回引导不进任务流; bind 建线程; 已绑续聊).
// 非文本分支 (damo 2026-10-15): 语音先尝试 ASR 转写, 以「[语音转写] 文本」进现有文本
//   链路; 转写失败 / 其他媒体 (图片/视频) → 回兜底话术, 不再静默忽略.
export async function processMessage(config: ChannelConfig, msg: WeixinInbound): Promise<void> {
  if (isDuplicateMessage(config.id, msg.msgId)) return;

  let text = msg.text;
  if (!text && msg.audio) {
    const transcribed = await transcribeVoice(msg, msg.audio);
    if (transcribed) {
      text = `[语音转写] ${transcribed}`;
    }
  }
  if (!text) {
    await sendReply(config, msg, msg.audio ? FALLBACK_VOICE_TEXT : FALLBACK_MEDIA_TEXT);
    return;
  }

  const bindMatch = text.match(BIND_RE);
  if (bindMatch) {
    await handleBind(config, msg, bindMatch[1]);
    return;
  }

  const existing = getIntakeThreadByExternal("weixin", msg.fromUserId);
  if (existing) {
    markInbound(existing.id);
    getRuntime().sendUserMessage(existing.task_id, text);
    return;
  }

  // 未绑 + 非 bind = 主动送达本渠道绑定码 (damo 2026-10-14: 绑定码要流程给出, 不让用户来问).
  // 不建 task, 防陌生人消息白烧 agent 额度. 谁给 bot 发消息谁收到码 —— bot 账号是
  // 扫码登录者本人的个人微信, 收件人天然限于其联系人, 接受此暴露面.
  await sendReply(
    config,
    msg,
    `你好！我是提调需求接收助手。本渠道绑定码：${config.bind_code}\n请回复 bind ${config.bind_code} 完成绑定。`,
  );
}

// ---------------------------------------------------------------------------
// 轮询循环
// ---------------------------------------------------------------------------

// 功能: 单渠道行一轮轮询. 读游标 → getUpdates → 逐条处理 → 全部成功提交游标.
// 关注点: 任何一步失败只记日志不抛 —— interval 下一 tick 重起 (失败不推游标,
//   未 ack 消息下轮重投); secret 无效的行每 tick 会静默跳过 (避免对空 token 打 API).
async function pollChannel(config: ChannelConfig): Promise<void> {
  const cred = parseWeixinSecret(config.secret);
  if (!cred) return;
  const buf = getSetting(bufKey(config.id)) ?? "";
  const result = await getUpdates(cred.bot_token, buf);
  for (const msg of result.messages) {
    await processMessage(config, msg);
  }
  // 整批成功才提交游标 (🔴 游标纪律)
  if (result.buf && result.buf !== buf) {
    setSetting(bufKey(config.id), result.buf, "weixin-worker");
  }
}

// inflight 表: Map<channelId, Promise> —— tick 只对无在跑轮询的行起新轮询
const inflight = new Map<string, Promise<void>>();
let tickHandle: ReturnType<typeof setInterval> | null = null;

// 功能: 一次 tick —— 扫 enabled weixin 行, 无 inflight 的起 pollChannel.
// 关注点: 暴露给测试 (避免真实 interval 时钟); pollChannel 结束后从 inflight 移除.
export async function tickWeixinWorker(): Promise<void> {
  const rows = listChannelConfigs().filter((c) => c.channel === "weixin" && c.enabled);
  for (const config of rows) {
    if (inflight.has(config.id)) continue;
    const p = pollChannel(config)
      .catch((err) => {
        console.error(`[weixin-worker] poll failed (channel=${config.id}):`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        inflight.delete(config.id);
      });
    inflight.set(config.id, p);
  }
  // 测试友好: 等 inflight 全部落定再返回 (生产 interval 不 await, 无影响)
  await Promise.allSettled([...inflight.values()]);
}

// 功能: 启动 worker 单例 interval. 重复调用先清旧 (与 runners/registry 同语义);
//   立即跑一次 tick (启动即消费, 不等 2s).
export function startWeixinWorker(): void {
  if (tickHandle) clearInterval(tickHandle);
  void tickWeixinWorker();
  tickHandle = setInterval(() => {
    void tickWeixinWorker();
  }, TICK_INTERVAL_MS);
  console.log("[weixin-worker] started (long-polling weixin channels)");
}

// 功能: 停 worker (测试 / 单测隔离用; 生产不调).
export function stopWeixinWorker(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  inflight.clear();
  seenMessages.clear();
}

// 测试辅助: 清去重表 (worker 单例状态跨测试用例隔离)
export function _resetWeixinWorkerForTest(): void {
  seenMessages.clear();
  inflight.clear();
}
