// 真 optimistic UI 的纯函数: 任务详情页 chat 在 POST /api/tasks/[id]/message
// 之前就把用户消息塞进 messages state, POST 失败时按 clientId 撤回.
// 关注点:
//   - 抽到独立文件方便单测 (项目未配 jsdom, 直接测 React 组件不现实).
//   - MessageItem 在 task-detail-client.tsx 是 file-local 类型, 这里再定义一份
//     仅含乐观插入关心的字段 (type / text / timestamp / clientId / role) — 与
//     组件内的完整类型结构兼容, 调用时按结构子集传入.
//   - 同文本已存在 → 直接跳过, 避免与历史回放/SSE push 重复渲染.

export type OptimisticMessageItem = {
  type: string;
  role?: string;
  text?: string;
  timestamp?: number;
  // 客户端为这条 optimistic 消息生成的本地 id. POST 失败按它撤回, SSE /
  // loadHistory 不会带这个字段, 因此不会被它们误删.
  clientId?: string;
  uuid?: string;
};

// 功能: 把用户消息立即加入 messages state. 同文本已存在 (含历史回放或 SSE
//       推送) → 跳过; 否则追加 temp message, 带 clientId 供失败回滚.
// 关注点: 调用前应清空输入框 + 附件预览; POST 失败时调 removeOptimisticMessage
//         按 clientId 撤回; SSE message 事件仍按 text 去重不会重复渲染.
// 变更 (R156, damo 2026-09-20): 去掉 text dedup. 之前「prev 含同文本 user 消息
//   → 直接 return prev」会让用户连续发同一条消息时, 第二次 send 在前端静默吞掉
//   (prev.some 命中上一条同 text 的 user 消息 → 不追加), 后端却收到并落 events
//   表 + agent 收到并处理, 用户感知「消息没发出去, 刷新可见」. 每次 send 都产
//   生新 bubble + 新 clientId, 重复由后续 SSE / loadHistory 按各自规则合并.
export function appendOptimisticUserMessage(
  prev: OptimisticMessageItem[],
  text: string,
  clientId: string,
  now: number = Date.now(),
): OptimisticMessageItem[] {
  return [
    ...prev,
    { type: "user", role: "user", text, timestamp: now, clientId },
  ];
}

// 功能: 按 clientId 撤回一条 optimistic 消息 (POST 失败回滚).
// 关注点: 不动其它消息; 没有 clientId 的消息不会被误删.
export function removeOptimisticMessage(
  prev: OptimisticMessageItem[],
  clientId: string,
): OptimisticMessageItem[] {
  return prev.filter((m) => m.clientId !== clientId);
}