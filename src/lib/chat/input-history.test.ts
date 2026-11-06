// R179 (飞书 AO-DEV R179, damo 2026-10-03): 输入框历史回溯单测.
//   被测实现 = spa/src/lib/chat/input-history.ts (SPA 无 test runner, 根仓
//   vitest 跨树 import 直接测 — 单一实现, 不复制避免 drift; 与 slash-command
//   两树各一份的做法不同, 这里只有 SPA 一份实现).
//   localStorage 包装函数除降级路径外不在此测 (node 环境无 localStorage,
//   loadInputHistory 应回 [] 证静默降级).

import { describe, it, expect } from "vitest";
import {
  pushHistoryEntry,
  InputHistoryBrowser,
  loadInputHistory,
  loadGlobalInputHistory,
  pushGlobalInputHistory,
} from "../../../spa/src/lib/chat/input-history";

describe("pushHistoryEntry (R179 输入历史)", () => {
  it("追加新条目到末尾 (最新在尾)", () => {
    expect(pushHistoryEntry(["a"], "b")).toEqual(["a", "b"]);
  });

  it("连续重复跳过 (重发同一条不刷屏)", () => {
    expect(pushHistoryEntry(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("非连续重复保留 (a→b→a 是合法轨迹)", () => {
    expect(pushHistoryEntry(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  });

  it("尾随空白去掉后入史, 纯空白不入史", () => {
    expect(pushHistoryEntry([], "hi\n  ")).toEqual(["hi"]);
    expect(pushHistoryEntry(["a"], "   ")).toEqual(["a"]);
  });

  it("超上限从最旧端裁剪", () => {
    expect(pushHistoryEntry(["1", "2", "3"], "4", 3)).toEqual(["2", "3", "4"]);
  });

  it("返回新数组, 不改入参 (immutable)", () => {
    const src = ["a"];
    pushHistoryEntry(src, "b");
    expect(src).toEqual(["a"]);
  });
});

describe("InputHistoryBrowser (R179 ↑/↓ 状态机)", () => {
  it("空历史: up 原样返回, 不进浏览态", () => {
    const b = new InputHistoryBrowser([]);
    expect(b.up("draft")).toBe("draft");
    expect(b.active).toBe(false);
  });

  it("首次 up 捕获 draft 并落到最新一条", () => {
    const b = new InputHistoryBrowser(["a", "b", "c"]);
    expect(b.up("我的草稿")).toBe("c");
    expect(b.active).toBe(true);
  });

  it("连续 up 递减到最旧后卡住", () => {
    const b = new InputHistoryBrowser(["a", "b", "c"]);
    b.up("d");
    expect(b.up("c")).toBe("b");
    expect(b.up("b")).toBe("a");
    expect(b.up("a")).toBe("a"); // 最旧端卡住
  });

  it("down 逐条回新, 翻过最新退回 draft 并退出浏览态", () => {
    const b = new InputHistoryBrowser(["a", "b", "c"]);
    b.up("我的草稿"); // → c
    b.up("c"); // → b
    expect(b.down("b")).toBe("c");
    expect(b.down("c")).toBe("我的草稿");
    expect(b.active).toBe(false);
  });

  it("非浏览态 down 原样返回", () => {
    const b = new InputHistoryBrowser(["a"]);
    expect(b.down("x")).toBe("x");
  });

  it("reset 退出浏览态 + 丢弃 draft", () => {
    const b = new InputHistoryBrowser(["a", "b"]);
    b.up("草稿");
    b.reset();
    expect(b.active).toBe(false);
    // reset 后重新 up 仍捕获当前文本为新 draft
    expect(b.up("新草稿")).toBe("b"); // → 最新 b
    b.reset();
    b.up("新草稿"); // → b (idx=1)
    b.up("b"); // → a (idx=0)
    expect(b.down("a")).toBe("b"); // → b (idx=1)
    expect(b.down("b")).toBe("新草稿"); // 翻过最新 → draft
  });
});

describe("localStorage 降级 (R179)", () => {
  it("node 环境无 localStorage → loadInputHistory 静默返回 []", () => {
    expect(loadInputHistory("task-x")).toEqual([]);
  });
});

describe("全局共享输入历史 (R233 Round7)", () => {
  it("node 环境无 localStorage → loadGlobalInputHistory 静默返回 []", () => {
    expect(loadGlobalInputHistory()).toEqual([]);
  });

  it("pushGlobalInputHistory 静默降级下仍返回含新条目的数组 (不阻断发送)", () => {
    expect(pushGlobalInputHistory("hello world")).toEqual(["hello world"]);
  });

  it("pushGlobalInputHistory 空白串不记 (pushHistoryEntry 同口径)", () => {
    expect(pushGlobalInputHistory("   ")).toEqual([]);
  });
});
