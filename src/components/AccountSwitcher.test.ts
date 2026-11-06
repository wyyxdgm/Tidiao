// AccountSwitcher.computeDropdownPosition 纯函数单测 — R120 修复回归.
//
// 功能: 验证 dropdown 定位逻辑: trigger 底部对齐 (无中间 gap), 视口右溢出
//   自动左移, 视口下溢出自动向上 + 底部对齐, 菜单比视口高时 clamp top=8.
//
// 关注点:
//   - 纯函数导出, 无 React 依赖, 不需要 jsdom. 直接 import 调.
//   - trigger rect 是 plain object (DOMRect-like), 不是 DOMRect 实例, 避免
//     vitest 在不同环境下 DOMRect 不可用的麻烦.
//   - R120 bug 复现场景 = "trigger 在侧栏底部" → dropdown 应该底对齐, gap=0.
//   - 历史行为 (bug) = 翻转时 dropdown.bottom ≈ trigger.top - 4, 中间空 ~200px.
//     现在断言 dropdown.bottom === trigger.bottom (或相差 < 1px).

import { describe, it, expect } from "vitest";
import { computeDropdownPosition } from "./AccountSwitcher";

type Rect = Parameters<typeof computeDropdownPosition>[0];
const rect = (o: Partial<Rect>): Rect => ({
  top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, ...o,
});

describe("AccountSwitcher.computeDropdownPosition", () => {
  it("trigger 在视口中部, 下方够放 → dropdown 在 trigger 下方, top 对齐 + 4px gap", () => {
    // 视口 1440x900, trigger 在中段 y=400-440 (侧栏展开态典型位置),
    // 1 个账号 → menuHeight = min(720, 80+48+80) = 208.
    // distToBottom = 900-440 = 460 ≥ 208+16=224 → canDown=true.
    const pos = computeDropdownPosition(
      rect({ top: 400, right: 240, bottom: 440, left: 0, width: 240, height: 40 }),
      { width: 1440, height: 900 },
      1,
    );
    expect(pos.top).toBe(444); // 440 + 4
    expect(pos.left).toBe(240); // 默认 rect.right
    expect(pos.width).toBe(256);
  });

  it("R120 复现: trigger 在侧栏底部, 下方不够放 → dropdown **底对齐** trigger.bottom (gap=0)", () => {
    // 视口 1440x900, trigger 在侧栏底部 y=856-892 (侧栏 56px 高),
    // 2 个账号 → menuHeight = min(720, 80+96+80) = 256.
    // distToBottom = 900-892 = 8 < 256+16=272 → canDown=false.
    // 历史 bug: top = rect.top - menuHeight - 4 = 856-256-4 = 596 → dropdown.bottom = 852,
    //   trigger.top = 856, 中间 4px gap (看起来"偏右上方").
    // 修复后: top = rect.bottom - menuHeight = 892-256 = 636 → dropdown.bottom = 892 = trigger.bottom ✓
    const pos = computeDropdownPosition(
      rect({ top: 856, right: 240, bottom: 892, left: 0, width: 240, height: 36 }),
      { width: 1440, height: 900 },
      2,
    );
    const menuHeight = Math.min(900 * 0.8, 80 + 2 * 48 + 80); // = 256
    // 关键断言: dropdown.bottom === trigger.bottom (gap=0, 底对齐)
    expect(pos.top + menuHeight).toBe(892);
    expect(pos.left).toBe(240);
  });

  it("trigger 在视口底部, 菜单比剩余空间高 → clamp top=8, dropdown 顶部对齐视口顶", () => {
    // 视口 1440x400 (短视口/手机), trigger y=380-396 (底部),
    // 5 个账号 → menuHeight = min(320, 80+240+80) = 320.
    // distToBottom = 400-396 = 4 < 320+16 → canDown=false.
    // 翻转: top = max(8, 396-320) = max(8, 76) = 76 (NOT 8).
    const pos = computeDropdownPosition(
      rect({ top: 380, right: 240, bottom: 396, left: 0, width: 240, height: 16 }),
      { width: 1440, height: 400 },
      5,
    );
    expect(pos.top).toBe(76);
  });

  it("trigger 在视口极底部 + 菜单巨高 → clamp top=8", () => {
    // 视口 1440x300, trigger y=288-300 (几乎贴底),
    // 10 个账号 → menuHeight = min(240, 80+480+80) = 240.
    // distToBottom = 0 < 256 → canDown=false.
    // 翻转: top = max(8, 300-240) = max(8, 60) = 60.
    // 再极端: 视口 200, trigger y=190-200, 10 账号 → menuHeight=min(160, 640)=160.
    // top = max(8, 200-160) = max(8, 40) = 40.
    // 极端: 视口 100, trigger y=95-100, menuHeight=min(80, 640)=80.
    // top = max(8, 100-80) = max(8, 20) = 20. 还是不命中 clamp.
    // 真要 clamp: 视口 80, trigger y=78-80, menuHeight=min(64, 640)=64.
    // top = max(8, 80-64) = max(8, 16) = 16. 不命中.
    // 再极端: 视口 50, trigger y=48-50, menuHeight=min(40, 640)=40.
    // top = max(8, 50-40) = max(8, 10) = 10. 不命中.
    // 视口 30, trigger y=28-30, menuHeight=min(24, 640)=24.
    // top = max(8, 30-24) = max(8, 6) = 8. 命中 clamp!
    const pos = computeDropdownPosition(
      rect({ top: 28, right: 240, bottom: 30, left: 0, width: 240, height: 2 }),
      { width: 1440, height: 30 },
      10,
    );
    expect(pos.top).toBe(8);
  });

  it("视口右溢出 → dropdown 左移, 留 8px 右边距", () => {
    // 视口宽 1440, trigger 在右半屏 right=1400.
    // desiredLeft = 1400, dropdown 宽 256 → 1400+256+8 = 1664 > 1440, overflow=224.
    // left = 1400 - 224 = 1176. dropdown 右沿 = 1176+256 = 1432, 视口右沿 = 1440, 间距 8 ✓
    const pos = computeDropdownPosition(
      rect({ top: 400, right: 1400, bottom: 440, left: 1160, width: 240, height: 40 }),
      { width: 1440, height: 900 },
      1,
    );
    expect(pos.left).toBe(1176);
    expect(pos.left + pos.width + 8).toBeLessThanOrEqual(1440);
  });

  it("trigger 在视口左半 + 下方够 → 不翻转, left=rect.right", () => {
    const pos = computeDropdownPosition(
      rect({ top: 100, right: 200, bottom: 140, left: 16, width: 184, height: 40 }),
      { width: 1440, height: 900 },
      3,
    );
    expect(pos.top).toBe(144);
    expect(pos.left).toBe(200);
  });

  it("0 个账号 (没历史登录) → menuHeight = 80+0+80 = 160, 仍按规则定位", () => {
    // menuHeight = min(720, 80+0+80) = 160.
    // 视口 900, trigger y=400-440 → distToBottom=460 ≥ 176 → canDown=true, top=444.
    const pos = computeDropdownPosition(
      rect({ top: 400, right: 240, bottom: 440, left: 0, width: 240, height: 40 }),
      { width: 1440, height: 900 },
      0,
    );
    expect(pos.top).toBe(444);
  });

  it("多账号 (6+) → menuHeight 触顶 80vh, 不溢出视口", () => {
    // 视口 900, 20 个账号 → menuHeight = min(720, 80+960+80) = 720 (= 80vh).
    // 视口高度足够 (900), 但 menuHeight 触顶 → 视口下放不下时上翻.
    // trigger 在底部 y=856-892 → distToBottom=8 < 720+16=736 → canDown=false.
    // top = max(8, 892-720) = 172. dropdown.bottom = 172+720 = 892 ✓
    const pos = computeDropdownPosition(
      rect({ top: 856, right: 240, bottom: 892, left: 0, width: 240, height: 36 }),
      { width: 1440, height: 900 },
      20,
    );
    expect(pos.top + 720).toBe(892); // dropdown.bottom === trigger.bottom
  });

  it("边界: trigger 完全贴视口底 (rect.bottom === vh) → canDown=false, 翻转向上", () => {
    // distToBottom = 0 < menuHeight+16 → 必翻转.
    const pos = computeDropdownPosition(
      rect({ top: 880, right: 240, bottom: 900, left: 0, width: 240, height: 20 }),
      { width: 1440, height: 900 },
      1,
    );
    // menuHeight = 208, top = max(8, 900-208) = 692. dropdown.bottom = 692+208 = 900 = trigger.bottom ✓
    expect(pos.top + 208).toBe(900);
  });
});
