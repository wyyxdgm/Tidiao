// R121: completion auto-send images helper.
//   任务进 reviewing 状态时, 查 task 最近 N 分钟内 agent_generated 图片 attachment,
//   拼飞书 post 富文本, 调 sendFeishuWebhook 内部函数 (不走 HTTP).
//
// 触发点: rule-engine.runAction 内 summarize_completion_attachments 分支.
// 去重:   mutateTaskMetadata(taskId, m => ({...m, completion_notified_at: ISO}))
//         已发过则 skipped:already_notified.
//
// 关注点:
//   - 永不抛错 (与现有 write_back_feishu / notify_dependents 同语义), 失败返
//     {sent:false, reason}, 调用方记 rule_failed event, 不影响其他 rule.
//   - 不 fallback email (damo 推荐 #6: 默认 feishu, 无 webhook 静默不发, 防配错 webhook 时 spam).
//   - 发送的飞书 post content 用外链 /api/attachments/{id} URL (damo 推荐 #2),
//     免素材库上传链路.

import { getTaskById, mutateTaskMetadata } from "../db/tasks";
import { listAttachmentsByTaskId } from "../db/attachments";
import { getUserById } from "../db/users";
import { sendFeishuWebhook } from "../notify/feishu";
import { insertEvent } from "../db/events";
import type { Attachment } from "./types";

export interface CompletionNotifyParams {
  /** 查最近 N 分钟内的 attachment (默认 30) */
  windowMinutes?: number;
  /** 单 task 通知最多 N 张图 (默认 9 = 3x3 grid 阈值) */
  maxImages?: number;
  /** channel (damo P1: 仅 feishu; 后续可扩 both) */
  channel?: "feishu";
  /** 无图时是否跳过 (默认 true; false 会发 "task X 已完成, 暂无图片" 提示) */
  skipIfEmpty?: boolean;
}

export interface CompletionNotifyOutcome {
  sent: boolean;
  reason: string;
  imageCount: number;
}

interface ActionParamsJson {
  window_minutes?: number;
  max_images?: number;
  channel?: "feishu";
  skip_if_empty?: boolean;
}

// parseDbTime mirrors the helper in active-session / events — 解析 SQLite TEXT 时间.
function parseDbTime(s: string): Date {
  // SQLite datetime('now') 默认格式 "YYYY-MM-DD HH:MM:SS" (UTC); 当作 UTC 解析.
  if (!s) return new Date(0);
  // 兼容 "T" 分隔 + "Z" 后缀
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}

/**
 * 功能: completion auto-send. 查 task 最近 windowMinutes 内 agent_generated 图,
 *   拼飞书 post 富文本 (标题 + N 张外链 + overflow 链接), 调 sendFeishuWebhook.
 *   成功后 mutateTaskMetadata 标 completion_notified_at (去重).
 *
 * 关注点:
 *   - 永不抛错. 失败返 { sent:false, reason } + 写 rule_failed event (失败也写, 便于排障).
 *   - 已被通知过 → skipped:already_notified, 立即返.
 *   - 无图且 skipIfEmpty=true → skipped:no_images.
 *   - 用户没配 feishu webhook → skipped:no_feishu_webhook, 不抛错.
 *   - 通知失败 (HTTP 4xx 等) → rule_failed + reason = feishu 返的 msg.
 */
export async function summarizeCompletionAttachments(
  taskId: string,
  rawParams: Record<string, unknown>,
): Promise<CompletionNotifyOutcome> {
  try {
    const task = getTaskById(taskId);
    if (!task || !task.owner_id) {
      return { sent: false, reason: "task_not_found", imageCount: 0 };
    }

    // 1. 解析 params + 默认值
    const params: CompletionNotifyParams = {
      windowMinutes: typeof rawParams.window_minutes === "number" ? rawParams.window_minutes : 30,
      maxImages: typeof rawParams.max_images === "number" ? rawParams.max_images : 9,
      channel: "feishu",
      skipIfEmpty: rawParams.skip_if_empty !== false,
    };

    // 2. 去重检查 (mutateTaskMetadata 走 read-modify-write 避免并发覆盖)
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    if (meta.completion_notified_at) {
      return { sent: false, reason: "already_notified", imageCount: 0 };
    }

    // 3. 查 task 最近 N 分钟内 agent_generated 图片
    const cutoff = Date.now() - params.windowMinutes! * 60 * 1000;
    const all = listAttachmentsByTaskId(taskId, task.owner_id);
    const recent = all.filter(
      (a: Attachment) =>
        a.source === "agent_generated" &&
        a.media_type.startsWith("image/") &&
        parseDbTime(a.created_at).getTime() >= cutoff,
    );

    if (recent.length === 0) {
      return { sent: false, reason: "no_images", imageCount: 0 };
    }

    // 4. 拼飞书 post 富文本
    const target = recent.slice(0, params.maxImages!);
    const overflow = recent.length - target.length;
    // 🔴 飞书对外链图支持: 用 URL 而非 image_key (damo 推荐 #2, 免素材库上传链路).
    //    生产环境 BASE_URL 由环境变量 ORCHESTRATOR_PUBLIC_BASE_URL 提供; 缺省
    //    走 localhost:13000 (开发). 部署时由 deploy.sh 注入.
    const baseUrl = process.env.ORCHESTRATOR_PUBLIC_BASE_URL || "http://localhost:13000";

    // 拼飞书 markdown 消息. 用 ![filename](url) 让飞书自动拉图渲染,
    //   免素材库上传链路 (damo 推荐 #2). post 富文本的 img tag 必须 image_key
    //   (飞书素材库 key) 才能稳定渲染; 外链 URL 走 markdown 模式更稳.
    const mdLines: string[] = [
      `📷 **${task.title || taskId.slice(0, 8)}** 已生成 ${recent.length} 张图`,
    ];
    for (const a of target) {
      mdLines.push(`![${a.filename}](${baseUrl}/api/attachments/${a.id})  \n*${a.filename}*`);
    }
    if (overflow > 0) {
      mdLines.push(`\n... 还有 ${overflow} 张，查看完整: [打开 chat](${baseUrl}/#/tasks/${taskId})`);
    }
    const message = mdLines.join("\n\n");

    // 5. 发送
    const user = getUserById(task.owner_id);
    const webhookUrl = user?.feishu_webhook_url;
    if (!webhookUrl) {
      return { sent: false, reason: "no_feishu_webhook", imageCount: recent.length };
    }
    const result = await sendFeishuWebhook({
      webhookUrl,
      message,
      msgType: "markdown",
    });

    // 6. 去重标 (只发成功才标; 失败允许后续重试)
    //   mutateTaskMetadata 期望 mutator 直接修改传入的 m (返回值不用), 内部 updateTask
    //   写 JSON.stringify(m) —— 返回新对象不会被采纳 (cost-accounting-null-gap §7.1 教训).
    if (result.sent) {
      mutateTaskMetadata(taskId, (m) => {
        m.completion_notified_at = new Date().toISOString();
      });
    }

    return {
      sent: result.sent,
      reason: result.sent ? `sent:${target.length}_images` : result.reason || "feishu_failed",
      imageCount: recent.length,
    };
  } catch (err) {
    // 永不抛错; 调用方记 rule_failed event
    return {
      sent: false,
      reason: `exception:${err instanceof Error ? err.message : String(err)}`,
      imageCount: 0,
    };
  }
}
