// R107 父子任务通知机制 (damo 0825 拍板实施).
//
// 痛点: 父 task 派了若干子 task 后自己 completed, 子 task 完成时无人接棒
//   → 产物无人接管. 设计稿 docs/designs/2026-08-25-parent-notify.md §3.
//
// 触发: 子 task 进入「会结束」的状态 (reviewing/failed/cancelled/rejected)
//   时, 自动让父 task 知道. 由 AgentRuntime.emitEvent() inline 调用本文件入口.
//
// 三分支:
//   - 父 alive (running/paused/reviewing)            → sendUserMessage(直发)
//   - 父 terminal + session_id 非空                  → sendUserMessage
//                                                    (走 canAutoStart 自动 resume)
//   - 父 terminal + session_id 为空 (从未启动过)     → webhook 兜底
//                                                    (event = task.parent_child_notify)
//
// 边界:
//   - 父 deleted_at 非空 → 静默 + 落 parent_notify_dropped event
//   - 子任务 dispatched_by_task_id 为 null → 不通知 (非派发关系)
//   - 跨 owner 的子任务 → 不通知 (理论上不该存在; 兜底)
//   - 本函数异常 → catch + 落 parent_notify_failed event, 绝不冒泡影响
//     主 emitEvent 流 (webhook / runRules 已经 fire-and-forget, 本函数保持同款).

import { getTaskById } from "../db/tasks";
import { insertEvent, isRedundantParentNotify } from "../db/events";
import { dispatchWebhook } from "../webhooks/dispatcher";
import type { Task, TaskStatus } from "./types";

// 触发通知的目标状态集. damo 原话「最好是等待审核的那个事件」= reviewing 是底线,
//   失败类也通知是为了避免子任务静默失效.
//   R127 §3.4 洞2: completed 也加进 NOTIFY_STATUSES, 但走「血缘判据」白名单 — 只在
//   父 metadata.waiting_child_id === 子.id 命中时才通知 + 触发 auto-resume. 无关子
//   completed 仍不刷屏 (与 damo R107 原口径一致), 命中时再推 + 调 helper.
const NOTIFY_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "reviewing",
  "failed",
  "cancelled",
  "rejected",
  "completed",
]);

export const PARENT_CHILD_NOTIFY_EVENT = "task.parent_child_notify" as const;

// 功能: 子 task 进入 NOTIFY_STATUSES 时调用. 自动让父 task 知道.
// 关注点:
//   - 函数所有路径都不抛异常 (catch 兜底). 父 agent 进程跑得起飞时我们不想再背锅.
//   - 父软删 / 跨 owner / 子无 parent 字段 都是静默路径 + 落 dropped event, 便于后续追踪.
//   - 走 sendUserMessage 的路径会触发 agent-runtime.ts §sendUserMessage 的 auto-resume
//     分支 (终态 + session_id 非空), 父 agent 真的会被唤醒读到通知.
//   - webhook 兜底 event = PARENT_CHILD_NOTIFY_EVENT (task.parent_child_notify),
//     新加进 WEBHOOK_EVENTS 数组, 默认不被任何 webhook 订阅, 不破坏现有契约.
export function notifyParentOfChildStatusChange(
  childTaskId: string,
  from: TaskStatus,
  to: TaskStatus,
): void {
  try {
    if (!NOTIFY_STATUSES.has(to)) return;
    // 同态 status_change (from === to) 短路: emitEvent 允许同态事件 (例如 PATCH
    //   timeout 写 DB 会触发 reviewing → reviewing), 但 notify 视角 = 同态 = 状态
    //   没变, 不该再推一次父. 不在 emitEvent 处挡 = 合法 DB 写入不受影响. M 复核
    //   W2 reject 抓到, 加最小接收端防御 (damo 0904 拍).
    if (from === to) return;

    const child = getTaskById(childTaskId);
    if (!child) return;

    // 非派发关系: 子任务没父, 不通知 (绝大多数 task 都走这条路 → 早返不浪费)
    const parentId = child.dispatched_by_task_id;
    if (!parentId) return;

    const parent = getTaskById(parentId, undefined, { includeDeleted: true });
    if (!parent) {
      // 父已被硬删 (物理上不可能, tasks 表是软删模型). 视为 dropped.
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_dropped",
        data: JSON.stringify({
          parent_id: parentId,
          reason: "parent_not_found",
          child_to: to,
          child_from: from,
        }),
      });
      return;
    }

    // 跨 owner 兜底: createTask 已经校验同 owner (DB 层), 理论上不会发生.
    // 但如果手动 SQL 写脏, 这里兜一道, 避免误给别 owner 的父 task 推消息.
    if (
      parent.owner_id &&
      child.owner_id &&
      parent.owner_id !== child.owner_id
    ) {
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_dropped",
        data: JSON.stringify({
          parent_id: parentId,
          reason: "cross_owner",
          child_to: to,
          child_from: from,
        }),
      });
      return;
    }

    // 父软删: 不打扰.
    if (parent.deleted_at) {
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_dropped",
        data: JSON.stringify({
          parent_id: parentId,
          reason: "parent_deleted",
          child_to: to,
          child_from: from,
        }),
      });
      return;
    }

    // R107 重复通知抑制 (damo 0908, R6 守护轮 R100 实证): 同一 (parent, child, child_to)
    //   已经推过、且此后子任务没被真正处置过 → 不再推. 不抑制的话父会被反复从 reviewing
    //   拽回 queued 重烧一整轮 agent (48h 实测 41 次纯冗余 ≈ $31, 且沿父链级联放大).
    //   判据实现见 db/events.ts:isRedundantParentNotify (零 migration, 只读 events 表).
    //   放行面: 子被 approve/reject/人工 resume 后重跑再进 reviewing = 新信息, 必推;
    //   上次通知 >24h 仍未处置 = 逃生窗口, 放行一次.
    if (isRedundantParentNotify(childTaskId, parentId, to)) {
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_suppressed",
        data: JSON.stringify({
          parent_id: parentId,
          reason: "duplicate_unhandled",
          child_to: to,
          child_from: from,
        }),
      });
      return;
    }

    // R127 §3.4 洞2: 子 completed 仅在父显式等待时通知. 读父 metadata.waiting_child_id,
    //   不等于 child.id = 无关子完成, 静默 + 落 dropped event (留痕, 不影响 R107 其它
    //   通知). 这里要放在 buildNotifyMessage 之前, 否则会去推父.
    if (to === "completed") {
      let waitingChildId: unknown = null;
      if (parent.metadata) {
        try {
          const parsed = JSON.parse(parent.metadata);
          if (parsed && typeof parsed === "object") {
            waitingChildId = (parsed as Record<string, unknown>).waiting_child_id;
          }
        } catch {
          /* 坏 metadata 视作无 waiting_child_id */
        }
      }
      if (waitingChildId !== child.id) {
        insertEvent({
          task_id: childTaskId,
          type: "parent_notify_dropped",
          data: JSON.stringify({
            parent_id: parentId,
            reason: "completed_but_parent_not_waiting",
            child_to: to,
            child_from: from,
            waiting_child_id: typeof waitingChildId === "string" ? waitingChildId : null,
          }),
        });
        return;
      }
      // 血缘命中: 推父 + 触发 auto-resume helper (R127 §3.4 洞3). helper 内部会清
      //   waiting_child_id + approve 父 (skipReviewGate=true), 即使父没在 reviewing
      //   helper 也是静默 no-op (见 agent-runtime.ts:autoResumeParentAfterChildComplete).
      //   走 _autoResumeSender 间接调用 (同 _sender 防循环模式), 生产 = setupParentNotify
      //   时一起注入; 测试时通过 setupParentNotify 注入 mock.
      try {
        autoResumeViaSender(childTaskId);
      } catch (err) {
        console.warn(
          `[ParentNotify] autoResumeParentAfterChildComplete failed for child=${childTaskId}:`,
          (err as Error).message,
        );
      }
    }

    const message = buildNotifyMessage(child, to);

    // 兜底: 父从未启动过 (session_id=null). sendUserMessage 会抛
    //   "No active session for task ${taskId}", 我们转走 webhook.
    if (!parent.session_id) {
      dispatchParentChildNotify(parent, child, to);
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_dispatched",
        data: JSON.stringify({
          parent_id: parentId,
          channel: "webhook",
          child_to: to,
          child_from: from,
        }),
      });
      return;
    }

    // 父 alive / 父 terminal+session_id 都走 sendUserMessage. agent-runtime.ts
    //   §sendUserMessage 已经处理:
    //     - session alive (running/paused/reviewing) → 直发
    //     - terminal + session_id 非空 → queuePendingMessage + startTask (auto-resume)
    //   我们不需要在这里区分, 一并交给它.
    try {
      notifyViaSendUserMessage(parentId, message);
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_dispatched",
        data: JSON.stringify({
          parent_id: parentId,
          channel: "send_user_message",
          child_to: to,
          child_from: from,
        }),
      });
    } catch (err) {
      // 兜底: sendUserMessage 理论上不会抛 (终态+session 已经走 auto-resume 分支),
      //   但万一某个 status 组合被漏过 (例如父 status='pending' + session_id 恰好非空),
      //   我们这里再降级到 webhook, 永远不让父错过这条通知.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ParentNotify] sendUserMessage failed for parent=${parentId} child=${childTaskId}:`,
        errMsg,
      );
      dispatchParentChildNotify(parent, child, to);
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_dispatched",
        data: JSON.stringify({
          parent_id: parentId,
          channel: "webhook_fallback",
          child_to: to,
          child_from: from,
          send_user_message_error: errMsg,
        }),
      });
    }
  } catch (err) {
    // 兜底中的兜底: 不让本函数任何路径冒泡影响主 emitEvent 流.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ParentNotify] notifyParentOfChildStatusChange failed for child=${childTaskId}:`,
      errMsg,
    );
    try {
      insertEvent({
        task_id: childTaskId,
        type: "parent_notify_failed",
        data: JSON.stringify({
          error: errMsg,
          child_from: from,
          child_to: to,
        }),
      });
    } catch {
      // events 表也写不进 (DB 挂了?) — 已经尽力, 不再尝试.
    }
  }
}

// R59 (damo 0830 + 0903 迭代): 子任务 agent 收尾前可自决写 task.metadata.result_summary;
//   不写时回退读 child.result (子任务最后一段 assistant message 文本).
//   截断到 800 字符防 prompt 膨胀. 父通知 message 拼接「**子任务自述**: ...」一行.
//   R107 「不强制带 result」原意保留 — 子任务两边都没内容就跟原版一致 (返回 null → 无 summaryLine).
const RESULT_SUMMARY_MAX_LEN = 800;

// 功能: 截断字符串到 RESULT_SUMMARY_MAX_LEN, 超长加 "…" 后缀.
// 关注点: 纯函数, 与读源解耦, fallback 和 primary 共用同一截断规则.
function truncateSummary(s: string): string {
  if (s.length <= RESULT_SUMMARY_MAX_LEN) return s;
  return s.slice(0, RESULT_SUMMARY_MAX_LEN) + "…";
}

// 功能: 读子任务结果摘要, 返回截断后的字符串或 null.
// 关注点:
//   - Primary: child.metadata.result_summary (子任务 agent 自决写的浓缩). metadata 是字符串
//     (DB 列就是 TEXT); 坏 JSON / 非对象 / 字段不存在 / 非字符串 → 当没填, 走 fallback.
//   - Fallback: child.result (子任务最后一段 assistant message 文本). R59 二轮: damo
//     0903 实测「看着没啥变化, result 没有给」 = 子任务没写 result_summary 也得有内容.
//     这里 fallback 自动读 child.result, 父通知就一定有浓缩结果, 不依赖 agent 自觉.
//   - 两边都没内容 → null, 父通知与 R107 原版一致.
//   - 超长截断到 800 字符 + "…" 后缀, 父 agent 想看完整就点链接.
function readChildResultSummary(child: Task): string | null {
  // Primary: metadata.result_summary
  if (child.metadata) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(child.metadata);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).result_summary;
      if (typeof value === "string" && value.length > 0) {
        return truncateSummary(value);
      }
    }
  }
  // Fallback: child.result (最后一段 assistant message)
  if (child.result && child.result.length > 0) {
    return truncateSummary(child.result);
  }
  return null;
}

// 功能: 拼父子通知 message. 单行格式, 父 agent 看到即感知.
// 关注点:
//   - 头部 [subtask-notify] tag 是契约 — 父 agent 可以 grep 这个 tag 决定是否特殊处理.
//   - 不带子任务 result 全文 (限速 + 避免 prompt 膨胀). 想看就点链接.
//   - R59: summary 非空 → 在第二行拼接「**子任务自述**: ...」一段 (800 字截断).
//     summary 来源优先级: metadata.result_summary (子任务自决) > child.result (自动 fallback).
//     两边都没内容就跟 R107 原版一模一样, 向后兼容.
//   - 短 ID 用前 8 字符 (与 status-transitions.test.ts 的 session_id 短格式一致).
function buildNotifyMessage(child: Task, to: TaskStatus): string {
  const shortId = child.id.slice(0, 8);
  const title = child.title || "(无标题)";
  const summary = readChildResultSummary(child);
  const summaryLine = summary ? `\n**子任务自述**: ${summary}` : "";
  return (
    `[subtask-notify] 子任务 ${shortId}（标题: ${title}）已进入 ${to}。${summaryLine}\n` +
    `如需要继续,先 approve 或 reject 本子任务,再派下一个。\n` +
    `子任务链接: /#/tasks/${child.id}`
  );
}

// 功能: 走 webhook 兜底. 把子任务摘要放在 note 字段 (WebhookPayload 可选 note).
// 关注点: dispatchWebhook 是 fire-and-forget, 5s timeout, 内部已经 try/catch,
//   我们这里不用再包一层. 加 PARENT_CHILD_NOTIFY_EVENT 是枚举扩大, 默认无订阅方.
//   R59: 子任务若写了 metadata.result_summary, 一并放进 note.child_result_summary
//   字段 (已截断). 订阅方按字段存在与否自取, 不读也不影响 webhook 派发本身.
function dispatchParentChildNotify(
  parent: Task,
  child: Task,
  to: TaskStatus,
): void {
  const notePayload: Record<string, unknown> = {
    child_id: child.id,
    child_short_id: child.id.slice(0, 8),
    child_title: child.title,
    child_to: to,
    child_url: `/#/tasks/${child.id}`,
  };
  const summary = readChildResultSummary(child);
  if (summary !== null) {
    notePayload.child_result_summary = summary;
  }
  const note = JSON.stringify(notePayload);
  // dispatchWebhook 签名: (event, task, status?, note?). status 不传 → payload 不带
  // from/to. 这里我们走自定义事件, 不该强行套 task 自己的 status. note 字段携带子任务摘要.
  // task.parent_child_notify 已加入 WEBHOOK_EVENTS, event 类型安全; note 是 dispatchWebhook
  //   v2026-08-25 扩的可选参数, 与 WebhookPayload.note 对齐 (dispatchEvaluatedWebhook 已用).
  dispatchWebhook(PARENT_CHILD_NOTIFY_EVENT, parent, undefined, note);
}

// 功能: 通过 AgentRuntime.sendUserMessage 推消息到父 task.
// 关注点: 故意不直接 import runtime (循环依赖 — runtime 引 parent-notify,
//   parent-notify 不能反向引 runtime). 改用 dynamic require / runtime registry.
//
// 实现: 通过全局 runtime 单例拿 sendUserMessage. 测试时通过 setupParentNotify()
//   注入 mock (见 parent-notify.test.ts).
// reason 是给 AgentRuntime.sendUserMessage 标注 "parent_notify" 用, 让 status_change
// 事件的 data 字段带上原因, timeline 上能区分「R107 自动唤醒」vs「人工发消息」.
// 测试无需关心, 留默认 undefined 即可.
// R55 B1 fix: R107 parent-notify injects user messages on behalf of the
// platform (child task status change → parent task wakeup). These are system
// events, not real conversation, so the transcript UI should show ⚙️系统 not
// 👤你. Sender signature picks up an optional senderType; production caller
// passes "system".
type Sender = (taskId: string, message: string, reason?: string, senderType?: "user" | "script" | "system") => void;
let _sender: Sender | null = null;
// R127 §3.4 洞3: auto-resume helper 间接调用, 同 _sender 防循环模式.
type AutoResumeSender = (childTaskId: string) => void;
let _autoResumeSender: AutoResumeSender | null = null;

// 功能: 注入 sendUserMessage (生产 = AgentRuntime.getRuntime().sendUserMessage).
// 关注点: 仅在生产启动路径 (agent-runtime.ts 引入本文件处) 调用一次.
//   测试通过此函数注入 mock. 不导出为 public 是为了避免被业务代码误用.
export function setupParentNotify(sender: Sender, autoResume?: AutoResumeSender): void {
  _sender = sender;
  if (autoResume) _autoResumeSender = autoResume;
}

function notifyViaSendUserMessage(parentId: string, message: string): void {
  if (!_sender) {
    throw new Error(
      "ParentNotify sender not initialized — call setupParentNotify() at runtime boot.",
    );
  }
  // R107 = platform event, mark as system so transcript UI shows ⚙️系统.
  _sender(parentId, message, "parent_notify", "system");
}

function autoResumeViaSender(childTaskId: string): void {
  if (!_autoResumeSender) {
    throw new Error(
      "ParentNotify autoResume sender not initialized — call setupParentNotify(sender, autoResume) at runtime boot.",
    );
  }
  _autoResumeSender(childTaskId);
}
