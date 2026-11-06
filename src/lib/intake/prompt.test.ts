import { describe, it, expect } from "vitest";
import { buildIntakePrompt } from "./prompt";

// 这组测试守的是 D2 的核心约束: 提问节奏必须按渠道分流.
// 两个渠道的约束正好相反, 混用任一方都会导致线程卡死:
//   wecom 用多回合 -> 烧光 5 条/轮配额, 之后发不出去
//   h5 用一次问完 -> 甲方读不完就不回
// 见 docs/plans/requirement-as-entity.md §7 D2 + §14.3

describe("buildIntakePrompt 渠道分流", () => {
  it("wecom: 一次问完(配额所迫), 且不能出现逐个问的指令", () => {
    const p = buildIntakePrompt("anflow", "登录页要改", "wecom");
    expect(p).toContain("一次把疑点问完");
    expect(p).not.toContain("一次只问一个问题");
  });

  it("h5: 一次只问一个, 且不能残留「一次问完」", () => {
    const p = buildIntakePrompt("anflow", "登录页要改", "h5");
    expect(p).toContain("一次只问一个问题");
    // 原来的 prompt 写的是「不要挤牙膏，一次问完」——D2 明确禁止, 不能漏改
    expect(p).not.toContain("一次把疑点问完");
    expect(p).not.toContain("不要挤牙膏");
  });

  it("h5 必须给出核心差异点 + 大概长什么样(damo 的两条硬要求)", () => {
    const p = buildIntakePrompt("anflow", "x", "h5");
    expect(p).toContain("核心差异点");
    expect(p).toContain("大概长什么样");
  });

  it("默认渠道是 wecom, 保持既有线上行为不变", () => {
    expect(buildIntakePrompt("anflow", "x")).toBe(buildIntakePrompt("anflow", "x", "wecom"));
  });

  it("两个渠道都保留 <<<REPLY>>> 出站契约", () => {
    for (const ch of ["wecom", "h5"] as const) {
      const p = buildIntakePrompt("anflow", "x", ch);
      expect(p).toContain("<<<REPLY>>>");
      expect(p).toContain("<<<END>>>");
    }
  });

  it("甲方原话进入 prompt", () => {
    expect(buildIntakePrompt("anflow", "订单列表要加筛选", "h5")).toContain("订单列表要加筛选");
  });

  it("feishu: 无配额窗口走逐个问节奏(同 h5), 自称飞书, 保留出站契约 (D2)", () => {
    const p = buildIntakePrompt("anflow", "登录页要改", "feishu");
    expect(p).toContain("一次只问一个问题");
    expect(p).not.toContain("一次把疑点问完");
    expect(p).toContain("甲方通过飞书给你发需求");
    expect(p).toContain("<<<REPLY>>>");
    expect(p).toContain("<<<END>>>");
  });
});
