// insertByTimestamp 单测: 没时间戳的 item 不再排到首位.
//
// 关注 bug R155 (damo 2026-09-20): 旧实现 `item.timestamp ?? 0` 让没时间戳的
//   item 排第一 (task 700d5434 "直接触发发送。我看看" 跑到 prompt 前). 修复:
//   兜底改 Number.MAX_SAFE_INTEGER → 没时间戳的 item 排末尾.
//
// 关注点:
//   - ts 兜底方向与 backend agent-runtime.ts tsOf 完全一致, 都是 MAX_SAFE_INTEGER.
//   - 等时间戳的 item 按插入顺序排 (stable sort), SDK 顺序保留.
//   - 数组初值本身就是 timestamp 升序; insertByTimestamp 维持这个不变量.

import { describe, it, expect } from "vitest";
import { insertByTimestamp, type WithTimestamp } from "./insert-by-timestamp";

const mk = (ts?: number): WithTimestamp & { id: string } => ({ id: `m-${ts ?? "no"}`, timestamp: ts });

describe("insertByTimestamp: 没时间戳 item 的兜底排序", () => {
  it("无 timestamp 的 item 排到末尾 (修复前排最前)", () => {
    // 模拟 task 700d5434 场景: 3 条 SDK uuid v7 (ts 1.7T+) + 1 条 DB event 没 ts.
    const sdk1 = mk(1_700_000_000_000);
    const sdk2 = mk(1_700_000_010_000);
    const sdk3 = mk(1_700_000_020_000);
    const noTs = mk(undefined); // DB event 没 timestamp

    const arr: typeof sdk1[] = [sdk1, sdk2, sdk3];
    insertByTimestamp(arr, noTs);

    // 关键断言: noTs 排到最后, 不是第一.
    expect(arr.map((m) => m.id)).toEqual(["m-1700000000000", "m-1700000010000", "m-1700000020000", "m-no"]);
  });

  it("SDK 时间戳升序 + 无 ts item 插入中间位置仍按真实时序", () => {
    // 修复前 noTs 会跑到第一个; 修复后 noTs 兜底 MAX_SAFE_INTEGER → 末尾.
    const sdk1 = mk(1_700_000_000_000);
    const sdk2 = mk(1_700_000_020_000);
    const arr: typeof sdk1[] = [sdk1, sdk2];

    insertByTimestamp(arr, mk(undefined));

    expect(arr[arr.length - 1].id).toBe("m-no");
  });

  it("有 timestamp 的 item 按 ts 二分插入正确位置", () => {
    const sdk1 = mk(1_700_000_000_000);
    const sdk2 = mk(1_700_000_020_000);
    const sdk3 = mk(1_700_000_040_000);
    const arr: typeof sdk1[] = [sdk1, sdk2, sdk3];

    // 插在 sdk1 和 sdk2 之间
    insertByTimestamp(arr, mk(1_700_000_010_000));
    expect(arr.map((m) => m.timestamp)).toEqual([
      1_700_000_000_000,
      1_700_000_010_000,
      1_700_000_020_000,
      1_700_000_040_000,
    ]);

    // 插在 sdk3 之后
    insertByTimestamp(arr, mk(1_700_000_050_000));
    expect(arr.map((m) => m.timestamp)).toEqual([
      1_700_000_000_000,
      1_700_000_010_000,
      1_700_000_020_000,
      1_700_000_040_000,
      1_700_000_050_000,
    ]);

    // 插在最前
    insertByTimestamp(arr, mk(1_699_999_999_000));
    expect(arr[0].timestamp).toBe(1_699_999_999_000);
  });

  it("等时间戳 item 按插入顺序 (stable sort)", () => {
    const a = mk(1_700_000_000_000);
    const b = mk(1_700_000_000_000); // 同 ts, 后插
    const arr: typeof a[] = [a];

    insertByTimestamp(arr, b);
    expect(arr.map((m) => m.id)).toEqual(["m-1700000000000", "m-1700000000000"]);
  });

  it("空数组也能插入", () => {
    const arr: WithTimestamp[] = [];
    insertByTimestamp(arr, mk(undefined));
    expect(arr).toHaveLength(1);
    expect(arr[0].timestamp).toBeUndefined();
  });
});