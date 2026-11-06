/* 聊天历史消息时间戳标签格式化. 同日只显示 HH:MM:SS, 跨日显示 MM-DD 前缀.

   关注 bug R47 (damo 2026-09-27): 聊天历史内容按时间排序, 但 formatTime 只显示
     HH:MM:SS — 跨日后「00:01」视觉上比「23:59」小, 用户以为「排序跑前面」. 实际
     后端按 ms 排没问题, 只是显示缺日期让用户感觉错位.

   关注点:
   - isSameLocalDay 用本地日 (getFullYear/Month/Date), 避免 CST 用户跨 UTC 切日
     时也被判跨日, 反而显得噪.
   - prevTs undefined (第一条消息) 默认带日期, 与「始终有上下文」一致.
   - ts 是 number ms (来自后端 messageTimestamp, 已含 ms 精度).

   master 等价物: src/app/tasks/[id]/format-timestamp-label.ts (TaskDetailClient
     MessageView 同步引用). 两边同源逻辑但分别维护 (本仓无 vitest, 改动后跑
     root 仓 vitest 验证). */

export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function formatTimestampLabel(ts: number | undefined, prevTs?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const showDate = prevTs === undefined || !isSameLocalDay(prevTs, ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return showDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}` : hms;
}