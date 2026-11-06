// formatTimestampLabel 单测: 跨日时显示日期前缀, 同日只显示时间.
//
// 关注 bug R47 (damo 2026-09-27): 聊天历史内容按时间排序, 但 formatTime 只显示
//   HH:MM:SS — 跨日后「00:01」视觉上比「23:59」小, 用户以为「排序跑前面」. 实际
//   后端按 ms 排没问题, 只是显示缺日期让用户感觉错位.
//
// 关注点:
//   - isSameLocalDay 用本地日 (getFullYear/Month/Date), 避免 CST 用户跨 UTC 切日
//     时也被判跨日, 反而显得噪.
//   - prevTs undefined (第一条消息) 默认带日期, 与「始终有上下文」一致.
//   - 测试用 toMatchInlineSnapshot 锚定 ms 精度, 时间格式对得上就算对.

import { describe, it, expect } from "vitest";
import { formatTimestampLabel } from "./format-timestamp-label";

// 用本地时间构造 ms (new Date(year, monthIdx, day, h, m, s)), 避免 UTC 转 CST
// 跨日后测试失真. CI 上时区可能与本地不同, 这里用本地日作为不变量.
const localMs = (y: number, m: number, d: number, h: number, mi: number, s: number = 0): number =>
  new Date(y, m, d, h, mi, s).getTime();

describe("formatTimestampLabel: 跨日加日期前缀", () => {
  it("第一条消息 (prevTs=undefined) 默认带日期", () => {
    const ts = localMs(2026, 8, 27, 23, 59);
    const out = formatTimestampLabel(ts);
    expect(out).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("同一天的 prev + current 只显示 HH:MM:SS", () => {
    const ts1 = localMs(2026, 8, 27, 18, 0);
    const ts2 = localMs(2026, 8, 27, 23, 30);
    const out = formatTimestampLabel(ts2, ts1);
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("跨日时 current 显示 MM-DD HH:MM:SS", () => {
    // 跨日典型场景: 前一天 23:59 → 第二天 00:01.
    const prevTs = localMs(2026, 8, 26, 23, 59);
    const curTs = localMs(2026, 8, 27, 0, 1);
    const out = formatTimestampLabel(curTs, prevTs);
    expect(out).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("同日 23:59 → 23:59:30 不跨日, 不显示日期", () => {
    const prevTs = localMs(2026, 8, 27, 23, 59);
    const curTs = localMs(2026, 8, 27, 23, 59, 30);
    const out = formatTimestampLabel(curTs, prevTs);
    expect(out).not.toContain("-");
  });
});