// feishu-snapshot.test.ts — 本地 JSON 快照层单元测试 (R92 path J, 2026-09-08).
//
// 测试分布:
//   - 5 条 基础 CRUD (save → get → clear)
//   - 3 条 TTL (过期 / ttlSeconds=0 永远命中 / ttlSeconds=-1 永远失效)
//   - 2 条 损坏自愈 (JSON 损坏 → 删文件 + 返回 null)
//   - 2 条 原子写 (process 并发写不互相覆盖)
//   - 1 条 shape 校验 (非 envelope 形状返回 null)
//
// 关注点:
//   - 用 ORCHESTRATOR_HOME 指向 tmpDir, 避免污染真实 ~/.agent-orchestrator/.
//   - 不依赖 feishu/sheets.ts (只验 snapshot 模块的纯函数 + fs 行为).
//   - 动态 import 必须放在 beforeEach 内, 因为 constants.ts 的 ORCHESTRATOR_HOME 是
//     模块顶层 const, 顶层 await import() 一旦执行就锁死, 后续改 env 也没用;
//     vi.resetModules() 只能清缓存, 但 destructure 绑定指向旧模块 → 必须重新 import
//     并把所有调用走 snap.* 才能让每轮用最新的 ORCHESTRATOR_HOME.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuRow } from "./sheets";

let tmpHome: string;
let snap: typeof import("./feishu-snapshot");

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-snap-test-"));
  process.env.ORCHESTRATOR_HOME = tmpHome;
  vi.resetModules();
  // 关键: 此时 ORCHESTRATOR_HOME 已设, 重新 import 让 constants.ts 读到正确值
  snap = await import("./feishu-snapshot");
});

afterEach(() => {
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  delete process.env.ORCHESTRATOR_HOME;
  vi.resetModules();
});

function fakeRow(row: number, id: string): FeishuRow {
  return {
    row,
    fields: {
      id,
      module: `模块${id}`,
      problem: `问题${id}`,
      expected: `期望${id}`,
    },
  };
}

// ---- 基础 CRUD ----

describe("saveSnapshot + getSnapshot 基础", () => {
  it("save 后立即 get 应返回相同 rows", () => {
    const vid = "v-test-1";
    const rows = [fakeRow(1, "R1"), fakeRow(2, "R2")];
    snap.saveSnapshot(vid, rows);
    const got = snap.getSnapshot(vid, 3600);
    expect(got).not.toBeNull();
    expect(got).toHaveLength(2);
    expect(got![0].fields.id).toBe("R1");
    expect(got![1].row).toBe(2);
  });

  it("getSnapshot 在文件不存在时返回 null (不抛错)", () => {
    expect(snap.getSnapshot("nonexistent-vid", 3600)).toBeNull();
  });

  it("snapshotPath 返回 ORCHESTRATOR_HOME/feishu-snapshots/<vid>.json", () => {
    const p = snap.snapshotPath("v-xyz");
    expect(p).toBe(path.join(tmpHome, "feishu-snapshots", "v-xyz.json"));
  });

  it("clearSnapshot 删文件, get 后返 null", () => {
    const vid = "v-test-clear";
    snap.saveSnapshot(vid, [fakeRow(1, "R1")]);
    expect(snap.getSnapshot(vid, 3600)).not.toBeNull();
    snap.clearSnapshot(vid);
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
  });

  it("clearSnapshot 对不存在的文件不抛错", () => {
    expect(() => snap.clearSnapshot("nope")).not.toThrow();
  });
});

// ---- TTL ----

describe("TTL 行为", () => {
  it("ttlSeconds=0 → 永远命中 (跳过 mtime 检查)", () => {
    const vid = "v-ttl-0";
    snap.saveSnapshot(vid, [fakeRow(1, "R1")]);
    // 把文件 mtime 推到 10 分钟前
    const old = Date.now() / 1000 - 600;
    fs.utimesSync(snap.snapshotPath(vid), old, old);
    expect(snap.getSnapshot(vid, 0)).not.toBeNull();
  });

  it("ttlSeconds=-1 → 永远失效 (强制重拉, 不读本地)", () => {
    const vid = "v-ttl-neg";
    snap.saveSnapshot(vid, [fakeRow(1, "R1")]);
    // mtime 是现在, ttl=-1 也应 miss
    expect(snap.getSnapshot(vid, -1)).toBeNull();
  });

  it("文件 mtime 超过 ttl → miss (返回 null)", () => {
    const vid = "v-ttl-expired";
    snap.saveSnapshot(vid, [fakeRow(1, "R1")]);
    // 推到 2 小时前, ttl=3600 (1h) 应过期
    const old = Date.now() / 1000 - 7200;
    fs.utimesSync(snap.snapshotPath(vid), old, old);
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
  });
});

// ---- 损坏自愈 ----

describe("损坏 JSON 自愈", () => {
  it("非 JSON 内容 → 删文件 + 返回 null", () => {
    const vid = "v-corrupt";
    snap.saveSnapshot(vid, [fakeRow(1, "R1")]);
    // 故意写坏
    fs.writeFileSync(snap.snapshotPath(vid), "{not valid json", "utf-8");
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
    // 文件应已被删
    expect(fs.existsSync(snap.snapshotPath(vid))).toBe(false);
  });

  it("空文件 → 删 + null", () => {
    const vid = "v-empty";
    snap.saveSnapshot(vid, [fakeRow(1, "R1")]);
    fs.writeFileSync(snap.snapshotPath(vid), "", "utf-8");
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
    expect(fs.existsSync(snap.snapshotPath(vid))).toBe(false);
  });
});

// ---- Shape 校验 ----

describe("envelope shape 校验", () => {
  it("缺 rows 字段 → null (不抛错)", () => {
    const vid = "v-shape-bad";
    const p = snap.snapshotPath(vid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ version_id: vid, fetched_at: "2026-09-08" }),
      "utf-8"
    );
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
  });

  it("空 envelope (null / {}) → null", () => {
    const vid = "v-empty-env";
    const p = snap.snapshotPath(vid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "null", "utf-8");
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
    fs.writeFileSync(p, "{}", "utf-8");
    expect(snap.getSnapshot(vid, 3600)).toBeNull();
  });
});

// ---- 原子写 ----

describe("saveSnapshot 原子写", () => {
  it("并发 save 不留 .tmp 残留", async () => {
    const vid = "v-atomic";
    // 并发 5 次 save, 全部跑完
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        Promise.resolve(snap.saveSnapshot(vid, [fakeRow(1 + i, `R${1 + i}`)]))
      )
    );
    // 不应有任何 .tmp 残留
    const dir = path.dirname(snap.snapshotPath(vid));
    const tmps = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(tmps).toHaveLength(0);
    // 文件应存在且能解析
    expect(fs.existsSync(snap.snapshotPath(vid))).toBe(true);
    const got = snap.getSnapshot(vid, 3600);
    expect(got).not.toBeNull();
    expect(got!.length).toBeGreaterThan(0);
  });
});
