// digest-model 单测 — 分组 / 动作判定 / 罐头消息.

import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  CATEGORY_META,
  actionLabel,
  buildAgreeMessage,
  digestActionFor,
  groupDigestItems,
  type DigestItem,
} from "./digest-model";

const it1 = (p: Partial<DigestItem> & { id: string }): DigestItem => ({
  category: "other",
  urgency: "mid",
  suggestion: "",
  need_owner: false,
  ...p,
});

describe("groupDigestItems", () => {
  it("按固定 6 类顺序分组, 空组不出现", () => {
    const groups = groupDigestItems([
      it1({ id: "a", category: "iterate" }),
      it1({ id: "b", category: "fix" }),
      it1({ id: "c", category: "fix" }),
      it1({ id: "d", category: "decision" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["fix", "iterate", "decision"]);
    expect(groups[0].items).toHaveLength(2);
    // i18n (W4.5b): label 走 locale (默认 zh-CN) — 对齐 t(CATEGORY_META.fix.labelKey).
    expect(groups[0].label).toBe(i18n.global.t(CATEGORY_META.fix.labelKey));
  });

  it("组内 high 紧急度排前; 空输入 → 空组", () => {
    const groups = groupDigestItems([
      it1({ id: "low", category: "fix", urgency: "low" }),
      it1({ id: "high", category: "fix", urgency: "high" }),
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["high", "low"]);
    expect(groupDigestItems([])).toEqual([]);
  });
});

describe("digestActionFor", () => {
  const needOwner = it1({ id: "x", need_owner: true });

  it("reviewing / await_user → approve (真验收)", () => {
    expect(digestActionFor(needOwner, { id: "x", status: "reviewing" })).toBe("approve");
    expect(digestActionFor(needOwner, { id: "x", status: "await_user" })).toBe("approve");
  });

  it("非终态等待 + need_owner → agree (一键同意罐头消息)", () => {
    expect(digestActionFor(needOwner, { id: "x", status: "paused" })).toBe("agree");
    expect(digestActionFor(needOwner, { id: "x", status: "running" })).toBe("agree");
  });

  it("其余 → reply; 任务查不到时 need_owner 仍 agree", () => {
    expect(digestActionFor(it1({ id: "x" }), { id: "x", status: "running" })).toBe("reply");
    expect(digestActionFor(needOwner, undefined)).toBe("agree");
  });

  // R204 (damo 2026-10-06): completed/cancelled = 终态惰性, 不许有任何唤醒
  // 动作 (一键同意会重跑终态任务, 实证事故 384e9e1e). failed 不在内.
  it("completed/cancelled → none (终态惰性, 含已交付条目)", () => {
    expect(digestActionFor(needOwner, { id: "x", status: "completed" })).toBe("none");
    expect(digestActionFor(needOwner, { id: "x", status: "cancelled" })).toBe("none");
    const delivered = it1({ id: "x", category: "delivery" });
    expect(digestActionFor(delivered, { id: "x", status: "completed" })).toBe("none");
  });

  it("failed 仍可一键同意 (失败恰恰是要修的来源)", () => {
    expect(digestActionFor(needOwner, { id: "x", status: "failed" })).toBe("agree");
  });
});

describe("actionLabel", () => {
  it("三动作文案", () => {
    expect(actionLabel("approve")).toContain("验收");
    expect(actionLabel("agree")).toContain("同意");
    expect(actionLabel("reply")).toContain("回复");
  });

  it("none → 空文案 (按钮不渲染)", () => {
    expect(actionLabel("none")).toBe("");
  });
});

describe("buildAgreeMessage", () => {
  it("带建议原文; 空建议退化纯同意", () => {
    expect(buildAgreeMessage("先跑回归再修导出")).toBe("同意，按建议推进：先跑回归再修导出");
    expect(buildAgreeMessage("  ")).toBe("同意，按你的建议继续推进。");
  });
});
