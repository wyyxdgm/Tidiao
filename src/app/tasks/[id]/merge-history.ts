// 合并 loadHistory 拉到的 history 与客户端 state (prev), 防止 SSE 已经推
// 到 state 但 history 还没同步的「中间态」消息被冲掉.
// 关注点:
//   - 抽到独立文件方便单测 (项目未配 jsdom/happy-dom, 直接测 React 组件不现实).
//   - OptimisticMessageItem 类型只取乐观合并关心的字段; 调用方按结构子集传入.
//   - 两条去重键:
//       a) user 且无 uuid (optimistic, 加 clientId) → 按 text 与 history user 去重
//       b) 任何带 uuid 的 prev 消息 → 按 uuid 与 history 去重
//     这样 SSE 推送的 assistant_message / tool_use / warning 等只要 uuid 还没落
//     到 history, 都不会被 loadHistory 覆盖.
//   - prev 中既无 uuid 也无 clientId 的「prompt 注入」(isPrompt=true) 不算 pending,
//     避免重复 (task.prompt 已经在 history 末尾检查并插过).
//   - 警告/warning 这类 ephemeral 消息 (无 uuid 也无 clientId) 不应持久化 —
//     真有需要可后续加显式保留列表; 现在保守不保留, 与原行为一致.

export type MergeHistoryItem = {
  type: string;
  role?: string;
  text?: string;
  timestamp?: number;
  clientId?: string;
  uuid?: string;
  isPrompt?: boolean;
};

// 功能: 合并 history 与 prev, 返回新数组. 保留 prev 中「history 尚未追上」的消息:
//       - optimistic user (无 uuid) → 按 text 去重, history 没有同 text user 才保留
//       - 任何带 uuid 的 prev → 按 uuid 去重, history 没有同 uuid 才保留
// 关注点: 不修改 history; prev 不动 (返回新数组).
export function mergeHistory(
  prev: MergeHistoryItem[],
  history: MergeHistoryItem[],
): MergeHistoryItem[] {
  if (prev.length === 0) return history;

  const historyUserTexts = new Set(
    history.filter((m) => m.type === "user" && typeof m.text === "string").map((m) => m.text!),
  );
  const historyUuids = new Set(
    history.filter((m) => typeof m.uuid === "string" && m.uuid).map((m) => m.uuid!),
  );

  const pending = prev.filter((m) => {
    if (m.isPrompt) return false;
    if (typeof m.uuid === "string" && m.uuid) {
      return !historyUuids.has(m.uuid);
    }
    // Optimistic user message (no uuid): dedupe by text against history user
    if (m.type === "user" && typeof m.text === "string") {
      return !historyUserTexts.has(m.text);
    }
    return false;
  });

  return pending.length > 0 ? [...history, ...pending] : history;
}
