/* 功能: SQLite DATETIME → JS Date 转换, 显式当 UTC 处理.
   关注点:
   - SQLite `datetime('now')` 返回 UTC, 形态 "YYYY-MM-DD HH:MM:SS" 无时区标记.
     JS `new Date("2026-08-25 23:03:06")` 按 spec 视为本地时间 (浏览器时区),
     渲染时本地化访问器 (getHours / toLocaleString) 会把同一时刻显示成错位的
     当地时间 (CST 环境下偏 8 小时, UTC 环境下反而对). 这是经典坑.
   - master 等价物: src/lib/datetime.ts:14 parseDbTime — append "Z" 后再 new Date(),
     然后所有 getHours() / getMinutes() / toLocaleString() 走的是用户实际时区.
   - 本文件复刻同一口径, SPA 三处 (GlobalBoard formatUpdatedAt, TaskCard
     formatDateTime, RightDock parseDbTime) 都通过它, 防止再有人直接 new Date(). */
export function parseDbTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  // 已带 Z 或已是 ISO (含 T) → 直接解析 (浏览器按 UTC 处理 Z 形式).
  const normalized =
    iso.endsWith('Z') || iso.includes('T')
      ? iso
      : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DB 时间 → 卡片短格式 "MM-DD HH:mm" (本地时区). GlobalBoard 卡片 /
 *  ConsoleCanvas (R191) 同款口径. 非法 / 缺省返回 '' (调用方 v-if 隐藏). */
export function formatShortDateTime(iso: string | null | undefined): string {
  const d = parseDbTime(iso);
  if (!d) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}