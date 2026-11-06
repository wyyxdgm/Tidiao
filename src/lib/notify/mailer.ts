// 邮件通知发送 —— 平台唯一的出站邮件出口。
//
// 配置全部来自环境变量(.env.local, 不落库不进 git):
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
//   NOTIFY_FROM          发信人(需与 SMTP_USER 同域, 否则被自建 maddy 拒)
//   NOTIFY_FALLBACK_TO   系统兜底收件人(用户没配 notify_email 时用它)
//
// 为什么是 env 而不是 app_settings: 含密码。app_settings 是明文表, LLM 配置那种
// 密文列要 ENCRYPTION_KEY 参与, 而 SMTP 凭据换机时本来就跟着 .env.local 走 ——
// 放 env 是这三者里唯一不需要新增加密链路的选择。
//
// 🔴 全局关注点: **本模块任何函数都不允许抛错到调用方**。调用点在任务超时回调里,
//   通知发不出去(SMTP 挂了/env 没配/域名解析失败)绝不能拖垮任务运行时 —— 一律
//   降级成 { sent: false, reason } + console.warn。唯一例外是「测试邮件」端点,
//   它需要把 reason 原样回给用户看, 但同样不抛。

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { getUserById } from "../db/users";

export interface SendResult {
  sent: boolean;
  /** 失败原因(sent:false 时必有), 直接给人看的短句 */
  reason?: string;
  /** SMTP 服务器的原始响应, 如 "250 2.0.0 OK ... queued" —— 留档/排障用 */
  response?: string;
  messageId?: string;
  /** 实际投递到的地址(经 resolveNotifyTo 解析后) */
  to?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

// 功能: 从 env 读齐 SMTP 配置, 缺任何一项返回 null(不抛).
// 关注点:
//  - 每次调用现读 process.env, **不在模块加载时求值**: Next.js 的模块可能在
//    .env 加载完成前就被 import, 提前求值会永久缓存一份空配置。
//  - SMTP_SECURE 语义: "true"/"1" = 465 隐式 TLS; 其余(含缺省) = false, 配合
//    requireTLS 走 587 STARTTLS。本平台实测用 587+STARTTLS(见交付报告)。
function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.NOTIFY_FROM?.trim() || user;
  const portRaw = process.env.SMTP_PORT?.trim();

  if (!host || !user || !pass || !from) return null;

  const port = portRaw ? Number(portRaw) : 587;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const secureRaw = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureRaw === "true" || secureRaw === "1";

  return { host, port, secure, user, pass, from };
}

let cachedTransporter: Transporter | null = null;
let cachedKey = "";

// 功能: 取(或懒建)单例 transporter. env 不全返回 null.
// 关注点: 用「配置指纹」做缓存 key —— env 变了(换机/改端口)会自动重建, 不用重启进程。
//   指纹里**不含密码明文**, 只含 host/port/user, 避免密码被带进任何可能被打印的变量。
function getTransporter(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}`;
  if (cachedTransporter && cachedKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // 587 明文端口必须强制升级到 TLS, 否则凭据会以明文过网。
    requireTLS: !cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // 自建 maddy, 连接慢时不要无限等 —— 通知不值得挂住调用方。
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cachedKey = key;
  return cachedTransporter;
}

// 功能: 解析某个用户的通知收件人. users.notify_email 非空则用它, 否则回落
//   env NOTIFY_FALLBACK_TO; 都没有返回 null(= 不发).
// 关注点: userId 传 null(系统任务/无归属)时直接走兜底邮箱; 读库失败同样降级到
//   兜底而不是抛错 —— 这个函数在超时回调里被调用。
export function resolveNotifyTo(userId: string | null | undefined): string | null {
  const fallback = process.env.NOTIFY_FALLBACK_TO?.trim() || null;
  if (!userId) return fallback;
  try {
    const own = getUserById(userId)?.notify_email?.trim();
    return own || fallback;
  } catch (err) {
    console.warn(`[mailer] 读取 user ${userId} 的 notify_email 失败, 回落系统邮箱:`, (err as Error).message);
    return fallback;
  }
}

export interface SendNotifyInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

// 功能: 发一封通知邮件. 成功返回 { sent:true, response, messageId }, 失败返回
//   { sent:false, reason } —— **永不抛错**.
// 关注点:
//  - env 不全 / to 为空都算失败但不是异常: 平台在没配 SMTP 的机器上也要能正常跑,
//    只是通知功能静默不可用(会 warn 一条)。
//  - 调用方若在任务生命周期里(如超时回调), 应该 void 掉这个 Promise 并 .catch(),
//    不要 await —— 见 agent-runtime.ts 的 notifyTaskTimeout。
export async function sendNotify(input: SendNotifyInput): Promise<SendResult> {
  const to = input.to?.trim();
  if (!to) {
    console.warn("[mailer] 没有收件人(用户未配 notify_email 且 NOTIFY_FALLBACK_TO 未设置), 跳过发送");
    return { sent: false, reason: "no recipient configured" };
  }

  const cfg = readSmtpConfig();
  if (!cfg) {
    console.warn("[mailer] SMTP env 不完整(需 SMTP_HOST/SMTP_USER/SMTP_PASS/NOTIFY_FROM), 跳过发送");
    return { sent: false, reason: "SMTP not configured", to };
  }

  try {
    const info = await getTransporter(cfg).sendMail({
      from: cfg.from,
      to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    // nodemailer 把服务器最后一行响应放在 info.response, 形如
    // "250 2.0.0 <id> Accepted" —— 留档时贴的就是这个。
    const response = (info as { response?: string }).response;
    console.log(`[mailer] 已投递 → ${to}: ${response ?? "(no response line)"}`);
    return { sent: true, response, messageId: info.messageId, to };
  } catch (err) {
    const reason = (err as Error).message || String(err);
    console.warn(`[mailer] 投递失败 → ${to}: ${reason}`);
    return { sent: false, reason, to };
  }
}

// 功能: 给某个用户发通知(自动解析收件人). 收件人解析不出来则跳过.
// 关注点: 同 sendNotify —— 不抛错。
export async function sendNotifyToUser(
  userId: string | null | undefined,
  mail: Omit<SendNotifyInput, "to">
): Promise<SendResult> {
  const to = resolveNotifyTo(userId);
  if (!to) {
    console.warn(`[mailer] user ${userId ?? "(none)"} 无可用收件人, 跳过发送`);
    return { sent: false, reason: "no recipient configured" };
  }
  return sendNotify({ ...mail, to });
}

// 功能: 报告 SMTP 是否已配置齐全, 给 UI 显示「未配置」提示用.
export function isMailerConfigured(): boolean {
  return readSmtpConfig() !== null;
}
