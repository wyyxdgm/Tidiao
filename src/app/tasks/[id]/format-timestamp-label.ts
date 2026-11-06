// 聊天历史消息时间戳标签格式化. 同日只显示 HH:MM:SS, 跨日显示 MM-DD 前缀.
//
// 关注 bug R47 (damo 2026-09-27): 聊天历史内容按时间排序, 但 formatTime 只显示
//   HH:MM:SS — 跨日后「00:01」视觉上比「23:59」小, 用户以为「排序跑前面」. 实际
//   后端按 ms 排没问题, 只是显示缺日期让用户感觉错位.
//
// 关注点:
//   - isSameLocalDay 用本地日 (getFullYear/Month/Date), 避免 CST 用户跨 UTC 切日
//     时也被判跨日, 反而显得噪.
//   - prevTs undefined (第一条消息) 默认带日期, 与「始终有上下文」一致.
//   - ts 是 number ms (来自 messageTimestamp, 已含 ms 精度).
//   - 抽到独立文件 = 便于 vitest 单测 (项目未配 jsdom, 直接测 React 组件不现实).

export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function formatTimestampLabel(ts: number, prevTs?: number): string {
  const showDate = prevTs === undefined || !isSameLocalDay(prevTs, ts);
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return showDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}` : hms;
}