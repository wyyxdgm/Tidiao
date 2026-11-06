// R108 T2: status-display 纯函数单测.
//
// 关注点:
//   - 4 个中文 alias 命中 → 对应 tone + 中文 label.
//   - 4 个英文 alias 命中 → 对应 tone (label 仍是中文, UI 统一展示).
//   - 大小写不敏感 (trim + toLowerCase).
//   - null / undefined / 空串 → null (UI 不渲染 chip).
//   - 不在 8 个别名内的值 (含 T1 测试用过的 "waiting_reply"/"has_suggestion")
//     → unknown tone + 灰色 class (兜底, 不解读).

import { describe, it, expect } from "vitest";
import { getStatusDisplay } from "./status-display";

describe("getStatusDisplay", () => {
  it("中文别名: 等回复 → waiting tone + 蓝色", () => {
    const d = getStatusDisplay("等回复");
    expect(d?.tone).toBe("waiting");
    expect(d?.label).toBe("等回复");
    expect(d?.bgClass).toBe("bg-blue-100");
    expect(d?.textClass).toBe("text-blue-700");
  });

  it("中文别名: 有建议 / 需拍板 / 卡住 各对应 tone + class", () => {
    expect(getStatusDisplay("有建议")?.tone).toBe("suggestion");
    expect(getStatusDisplay("有建议")?.bgClass).toBe("bg-purple-100");

    expect(getStatusDisplay("需拍板")?.tone).toBe("decision");
    expect(getStatusDisplay("需拍板")?.bgClass).toBe("bg-orange-100");

    expect(getStatusDisplay("卡住")?.tone).toBe("blocked");
    expect(getStatusDisplay("卡住")?.bgClass).toBe("bg-red-100");
  });

  it("英文别名 (lowercase): waiting/suggestion/decision/blocked 命中", () => {
    expect(getStatusDisplay("waiting")?.tone).toBe("waiting");
    expect(getStatusDisplay("suggestion")?.tone).toBe("suggestion");
    expect(getStatusDisplay("decision")?.tone).toBe("decision");
    expect(getStatusDisplay("blocked")?.tone).toBe("blocked");
    // 英文 alias 也用中文 label, UI 渲染统一
    expect(getStatusDisplay("waiting")?.label).toBe("等回复");
  });

  it("大小写不敏感: WAITING / Suggestion / DECISION trim+lowercase 后命中", () => {
    expect(getStatusDisplay("WAITING")?.tone).toBe("waiting");
    expect(getStatusDisplay("  Suggestion  ")?.tone).toBe("suggestion");
    expect(getStatusDisplay("DECISION")?.tone).toBe("decision");
  });

  it("自然措辞 alias (damo 1007): 待拍板/请选择 → decision 档, 不落 unknown 灰", () => {
    expect(getStatusDisplay("待拍板")?.tone).toBe("decision");
    expect(getStatusDisplay("待拍板")?.label).toBe("需拍板");
    expect(getStatusDisplay("待拍板")?.bgClass).toBe("bg-orange-100");
    expect(getStatusDisplay("请选择")?.tone).toBe("decision");
    expect(getStatusDisplay("请选择")?.label).toBe("请选择");
    // 前后空格也归一 (同 trim+lowercase 路径)
    expect(getStatusDisplay(" 请选择 ")?.tone).toBe("decision");
  });

  it("null / undefined / 空串 → 返回 null (UI 不渲染 chip)", () => {
    expect(getStatusDisplay(null)).toBeNull();
    expect(getStatusDisplay(undefined)).toBeNull();
    expect(getStatusDisplay("")).toBeNull();
    expect(getStatusDisplay("   ")).toBeNull();
  });

  it("其他 status (含 T1 测试用过的 waiting_reply / has_suggestion) → unknown 灰色", () => {
    const u1 = getStatusDisplay("waiting_reply");
    expect(u1?.tone).toBe("unknown");
    expect(u1?.bgClass).toBe("bg-gray-100");
    expect(u1?.textClass).toBe("text-gray-600");

    const u2 = getStatusDisplay("has_suggestion");
    expect(u2?.tone).toBe("unknown");

    // 完全未知字符串
    const u3 = getStatusDisplay("foo_bar");
    expect(u3?.tone).toBe("unknown");
  });
});
