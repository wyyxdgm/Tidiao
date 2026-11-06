// 任务超时通知 —— 组装邮件正文 + 去重 + 投递。
//
// 调用点只有一个: agent-runtime.ts 里已有的超时 setTimeout 回调(任务被 pause 之后)。
// 不要另造超时检测 —— 阈值解析链(project.timeout_minutes → app_settings → 30min)
// 已经在 resolveTaskTimeoutMs 里了。
//
// 🔴 去重用 **DB 标记**(tasks.metadata.timeout_notified_at)而不是内存 Set:
//   - 内存 Set 在 pm2 restart 后清空。而超时任务落 paused 是**非终态**, 会被恢复,
//     恢复后可能再次超时 —— 重启 + 再超时就会重复发, 而这正是要挡的场景。
//   - 另一个理由: 平台在多实例(WSL ao-prod / ao-dev / pulu)上各跑一个进程,
//     内存标记天然不共享; metadata 跟着任务本身走, 语义是「这个任务已经就超时
//     通知过一次了」, 与进程无关。
//   代价: 一次读 + 一次写库(mutateTaskMetadata, 无事务)。并发窗口存在但极窄 ——
//   同一个 task 的超时 timer 只有一个, 不存在两个回调同时进来。
//
// 关注点: 本模块所有出错路径都吞掉并 warn, 绝不让通知失败影响任务状态机。

import { getTaskById, mutateTaskMetadata } from "../db/tasks";
import { getProjectById } from "../db/projects";
import { getVersionById } from "../db/versions";
import { parseDbTime } from "../datetime";
import { sendNotifyToUser, type SendResult } from "./mailer";
import type { Task } from "../runtime/types";

const METADATA_KEY = "timeout_notified_at";

// 功能: 判断这个 task 是否已经发过超时通知; 没发过就打上标记并返回 true(表示
//   「该发」). 读库/写库失败时返回 false(宁可漏发也不重复轰炸收件箱).
// 关注点: 判据是「投过没有」的直接记录(metadata 里的时间戳), 不拿 status/
//   reject_count 之类旁证凑 —— 见 docs/resume-contract.md 的教训。
function claimTimeoutNotification(taskId: string): boolean {
  try {
    let shouldSend = false;
    mutateTaskMetadata(taskId, (meta) => {
      if (meta[METADATA_KEY]) return false; // 已发过, 不写库
      meta[METADATA_KEY] = new Date().toISOString();
      shouldSend = true;
    });
    return shouldSend;
  } catch (err) {
    console.warn(`[notify] 认领 task ${taskId} 超时通知标记失败, 跳过发送:`, (err as Error).message);
    return false;
  }
}

// 功能: 已运行时长的人话表示. started_at 缺失时回落 created_at, 都没有返回 "未知".
function formatElapsed(task: Task): string {
  const start = parseDbTime(task.started_at) ?? parseDbTime(task.created_at);
  if (!start) return "未知";
  const ms = Date.now() - start.getTime();
  if (ms < 0) return "未知";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  return `${h} 小时 ${mins % 60} 分钟`;
}

// 功能: 拼任务详情页链接. NEXT_PUBLIC_APP_URL 没配时只回任务 id(不编造 host).
// 关注点: SPA hash 路由 — 链接必须带 /#/ 前缀, 否则点开落旧壳.
function taskLink(taskId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/#/tasks/${taskId}` : `（未配置 NEXT_PUBLIC_APP_URL）task id: ${taskId}`;
}

// 功能: 任务超时后发一封通知给 task.owner_id 解析出的邮箱. 已发过 / 无收件人 /
//   SMTP 未配置都静默跳过.
// 关注点:
//  - 调用方**不要 await**: 走 void + catch, 通知的网络往返(最坏 20s socket 超时)
//    不该压在任务状态机的路径上。
//  - 只在「真的超时」的那个回调里调用。正常结束路径(runTask 的 finally 里
//    clearTimeout)不会走到这里 —— 这是「正常完成的任务不发邮件」的结构性保证。
export async function notifyTaskTimeout(
  taskId: string,
  timeoutMs: number
): Promise<SendResult> {
  try {
    if (!claimTimeoutNotification(taskId)) {
      return { sent: false, reason: "already notified" };
    }

    const task = getTaskById(taskId);
    if (!task) return { sent: false, reason: "task not found" };

    const projectName = task.project_id
      ? getProjectById(task.project_id)?.name ?? task.project_id
      : "（无项目）";
    const versionName = task.version_id
      ? getVersionById(task.version_id)?.name ?? task.version_id
      : "（无版本）";
    const minutes = Math.round(timeoutMs / 60000);
    const shortId = taskId.slice(0, 8);
    const link = taskLink(taskId);

    const lines = [
      `任务「${task.title}」已超时被自动暂停。`,
      "",
      `任务 ID：${shortId}（完整：${taskId}）`,
      `项目：${projectName}`,
      `版本：${versionName}`,
      `超时阈值：${minutes} 分钟`,
      `已运行：${formatElapsed(task)}`,
      "",
      `查看任务：${link}`,
      "",
      "说明：超时走的是「暂停」而不是「取消」——session 上下文已保住，",
      "在任务页点恢复即可从断点继续（不会重跑已完成的部分）。",
    ];

    return await sendNotifyToUser(task.owner_id, {
      subject: `【AO 任务超时】${task.title}（${shortId}）`,
      text: lines.join("\n"),
    });
  } catch (err) {
    // 兜底: 上面每步都可能读库失败, 但通知绝不能把异常抛回超时回调。
    console.warn(`[notify] 组装/发送 task ${taskId} 超时通知失败:`, (err as Error).message);
    return { sent: false, reason: (err as Error).message };
  }
}
