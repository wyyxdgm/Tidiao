// console-digest 单测 — 纯逻辑层 (parse / fingerprint / taskLines / context).
// LLM 调用不测 (SDK 网络依赖, 同 card-summary 路线: 行为契约在 llm-summarize.test.ts).

import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DIGEST_CATEGORIES,
  buildDigestPrompt,
  buildTaskLines,
  collectProjectContext,
  digestFingerprint,
  parseDigestJson,
  type ConsoleDigest,
} from "./console-digest";
import type { Task } from "../db/tasks";

function mkTask(partial: Partial<Task> & { id: string }): Task {
  return {
    title: "t",
    status: "running",
    priority: 0,
    updated_at: "2026-10-05 10:00:00",
    result: "",
    ...partial,
  } as Task;
}

const IDS = new Set(["a", "b", "c"]);

describe("parseDigestJson", () => {
  it("正常 JSON 解析出 headline + items", () => {
    const raw = JSON.stringify({
      headline: "修 2 个 bug，1 个方案等拍板",
      items: [
        { id: "a", category: "fix", urgency: "high", suggestion: "先复现再改", need_owner: false },
        { id: "b", category: "decision", urgency: "mid", suggestion: "选 Redis 还是 DB", need_owner: true },
      ],
    });
    const d = parseDigestJson(raw, IDS);
    expect(d).not.toBeNull();
    expect(d!.headline).toContain("bug");
    expect(d!.items).toHaveLength(2);
    expect(d!.items[0]).toMatchObject({ id: "a", category: "fix", urgency: "high" });
    expect(d!.items[1].need_owner).toBe(true);
  });

  it("容忍 markdown 代码块包裹 + 前后噪声", () => {
    const raw = '好的，以下是归纳：\n```json\n{"headline":"h","items":[{"id":"a","category":"fix","urgency":"low","suggestion":"s"}]}\n```\n完毕';
    const d = parseDigestJson(raw, IDS);
    expect(d).not.toBeNull();
    expect(d!.items[0].id).toBe("a");
  });

  it("幻觉 id (不在 validIds) 被丢弃", () => {
    const raw = JSON.stringify({
      headline: "h",
      items: [
        { id: "a", category: "fix", urgency: "low", suggestion: "s" },
        { id: "hallucinated", category: "fix", urgency: "low", suggestion: "s" },
      ],
    });
    const d = parseDigestJson(raw, IDS);
    expect(d!.items).toHaveLength(1);
    expect(d!.items[0].id).toBe("a");
  });

  it("非法 category/urgency 回落默认值; 全部 item 无效 → null", () => {
    const bad = JSON.stringify({
      headline: "h",
      items: [{ id: "a", category: "nonsense", urgency: "extreme", suggestion: "s" }],
    });
    const d = parseDigestJson(bad, IDS);
    expect(d!.items[0].category).toBe("other");
    expect(d!.items[0].urgency).toBe("mid");

    const none = JSON.stringify({ headline: "h", items: [{ id: "zzz" }] });
    expect(parseDigestJson(none, IDS)).toBeNull();
  });

  it("null / 空 / 非JSON / 缺 items → null", () => {
    expect(parseDigestJson(null, IDS)).toBeNull();
    expect(parseDigestJson("", IDS)).toBeNull();
    expect(parseDigestJson("模型走神了", IDS)).toBeNull();
    expect(parseDigestJson('{"headline":"h"}', IDS)).toBeNull();
  });

  it("headline/suggestion 超长被截断", () => {
    const raw = JSON.stringify({
      headline: "长".repeat(200),
      items: [{ id: "a", category: "fix", urgency: "low", suggestion: "长".repeat(200) }],
    });
    const d = parseDigestJson(raw, IDS)!;
    expect(d.headline.length).toBeLessThanOrEqual(60);
    expect(d.items[0].suggestion.length).toBeLessThanOrEqual(80);
  });

  // R204 (damo 2026-10-06): 终态任务 (completed/cancelled) 不需要继续处理 —
  // 实证事故 384e9e1e: completed 任务被 LLM 错分进 fix + need_owner → 一键
  // 同意经 terminal auto-resume 重跑终态任务.
  describe("终态守门 (statusById)", () => {
    const raw = JSON.stringify({
      headline: "h",
      items: [
        { id: "a", category: "fix", urgency: "high", suggestion: "s", need_owner: true },
        { id: "b", category: "delivery", urgency: "low", suggestion: "交付了 X", need_owner: true },
      ],
    });
    const STATUS = new Map([
      ["a", "completed"],
      ["b", "cancelled"],
    ]);

    it("completed/cancelled 错分进非 delivery 分类 → 丢弃", () => {
      const d = parseDigestJson(raw, IDS, STATUS)!;
      expect(d.items.map((i) => i.id)).toEqual(["b"]);
    });

    it("delivery 保留但 need_owner 强制 false", () => {
      const d = parseDigestJson(raw, IDS, STATUS)!;
      expect(d.items[0]).toMatchObject({ id: "b", category: "delivery", need_owner: false });
    });

    it("不传 statusById → 行为与旧版一致 (向后兼容)", () => {
      const d = parseDigestJson(raw, IDS)!;
      expect(d.items).toHaveLength(2);
      expect(d.items[0].need_owner).toBe(true);
    });
  });
});

describe("digestFingerprint", () => {
  it("同任务集稳定, 状态/时间变了就变, 与顺序无关", () => {
    const t1 = [mkTask({ id: "a" }), mkTask({ id: "b", status: "queued" })];
    const t1reordered = [t1[1], t1[0]];
    expect(digestFingerprint(t1)).toBe(digestFingerprint(t1reordered));

    const t2 = [mkTask({ id: "a" }), mkTask({ id: "b", status: "running" })];
    expect(digestFingerprint(t1)).not.toBe(digestFingerprint(t2));

    const t3 = [mkTask({ id: "a" }), mkTask({ id: "b", status: "queued", updated_at: "2026-10-06 09:00:00" })];
    expect(digestFingerprint(t1)).not.toBe(digestFingerprint(t3));
  });
});

describe("buildTaskLines", () => {
  it("活跃任务优先且保留 id/状态/标题; 终态只留 14 天内", () => {
    const now = new Date("2026-10-05T12:00:00Z").getTime();
    const tasks = [
      mkTask({ id: "old-done", status: "completed", updated_at: "2026-09-01 10:00:00" }),
      mkTask({ id: "recent-done", status: "completed", updated_at: "2026-10-04 10:00:00" }),
      mkTask({ id: "queued-1", status: "queued", updated_at: "2026-10-01 10:00:00" }),
    ];
    const lines = buildTaskLines(tasks, now);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("id=queued-1"); // 活跃排前
    expect(lines[1]).toContain("id=recent-done");
    expect(lines.join("\n")).not.toContain("old-done");
  });

  it("超 MAX 截断; result 附带进行", () => {
    const now = Date.now();
    const many = Array.from({ length: 60 }, (_, i) =>
      mkTask({ id: `t${i}`, status: "queued", updated_at: "2026-10-05 10:00:00" }),
    );
    expect(buildTaskLines(many, now)).toHaveLength(50);

    const withResult = [
      mkTask({ id: "r1", status: "reviewing", result: "已完成 X 修复，等验收。" }),
    ];
    expect(buildTaskLines(withResult, now)[0]).toContain("等验收");
  });
});

describe("collectProjectContext", () => {
  it("读到 CLAUDE.md 并截断; 缺文件静默跳过; cwd 空 → 空串", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-ctx-"));
    try {
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "C".repeat(5000));
      fs.writeFileSync(path.join(dir, "INDEX.md"), "# wiki");
      const ctx = collectProjectContext(dir);
      expect(ctx).toContain("CLAUDE.md");
      expect(ctx).toContain("# wiki");
      expect(ctx.length).toBeLessThan(6000); // clip 生效
      expect(ctx).not.toContain("C".repeat(4000)); // 3000 clip

      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-empty-"));
      try {
        expect(collectProjectContext(emptyDir)).toBe("");
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
      expect(collectProjectContext(null)).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDigestPrompt", () => {
  it("拼入项目名/文档/任务清单, 无文档时明示", () => {
    const withCtx = buildDigestPrompt({
      projectName: "P",
      context: "【文档】业务规则",
      taskLines: ["id=a | 状态=running | 标题=t"],
    });
    expect(withCtx).toContain("P");
    expect(withCtx).toContain("业务规则");
    expect(withCtx).toContain("id=a");

    const noCtx = buildDigestPrompt({ projectName: "P", context: "", taskLines: [] });
    expect(noCtx).toContain("无 — 只能依据任务清单归纳");
    expect(noCtx).toContain("(无任务)");
  });
});

describe("DIGEST_CATEGORIES", () => {
  it("固定 6 类 (UI chips 顺序依赖)", () => {
    expect(DIGEST_CATEGORIES).toEqual(["fix", "design", "delivery", "iterate", "decision", "other"]);
  });
});

describe("缓存结构", () => {
  it("CachedDigest 序列化回读一致 (app_settings KV 契约)", () => {
    const payload = {
      fingerprint: "abc123",
      digest: {
        headline: "h",
        items: [{ id: "a", category: "fix", urgency: "high", suggestion: "s", need_owner: false }],
      } satisfies ConsoleDigest,
      at: "2026-10-05T00:00:00Z",
      model: "m",
    };
    const back = JSON.parse(JSON.stringify(payload));
    expect(back.fingerprint).toBe("abc123");
    expect(back.digest.items[0].id).toBe("a");
  });
});
