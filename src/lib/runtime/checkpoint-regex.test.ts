// R108 CHECKPOINT_RE 扩 by/status 正则匹配回归测试.
//
// 关注点:
//   - 老 <checkpoint step=N summary="..."/> 形态仍匹配 (向后兼容, 老 task
//     transcript 不破).
//   - 新 <checkpoint step=N by="X" status="Y"/> 形态按 group 顺序解析出
//     step(1) / summary(2) / by(3) / status(4).
//   - 引号可选 (quoted/unquoted) 都匹配.
//   - charset 超长 / 含特殊字符不匹配, 防注入.
//   - 同一 block 多个 marker 全部解析.
//
// CHECKPOINT_RE 在 active-session.ts 是 private static, 测试通过
// `(ActiveSession as any).CHECKPOINT_RE` 触达 (跟 active-session.test.ts:79
// 触达 createCanUseTool 的 private 同款姿势, 显式 ts-expect-error 标注).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 不需要 SDK, mock 掉防 import 链抖.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));
vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { closeDb } from "../db";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cp-regex-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 私有 static 触达: 跟 active-session.test.ts:79 同样姿势.
const CHECKPOINT_RE = (ActiveSession as unknown as {
  CHECKPOINT_RE: RegExp;
}).CHECKPOINT_RE;
const parseCheckpointAttrs = (ActiveSession as unknown as {
  parseCheckpointAttrs: (attrText: string) => {
    step: string;
    summary: string | null;
    by: string | null;
    status: string | null;
  } | null;
}).parseCheckpointAttrs.bind(ActiveSession);

// 复制 parseCheckpointsInBlock 的 .exec 循环.
//
// R108 T4 起改两段式: CHECKPOINT_RE 框住 `<checkpoint ...>` + 属性串,
//   parseCheckpointAttrs 逐属性抽 → **属性顺序无关**. 老实现单条顺序固定
//   正则, damo 拍的模板 (step,status,by,summary) 整条 NO MATCH → 4 个测试
//   task 的 marker 全静默丢失 (实测 checkpoints 表 0 行), 故改。
function parseMarkers(text: string): Array<{
  step: string;
  summary: string | null;
  by: string | null;
  status: string | null;
}> {
  const out: Array<{ step: string; summary: string | null; by: string | null; status: string | null }> = [];
  const re = new RegExp(CHECKPOINT_RE.source, CHECKPOINT_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const parsed = parseCheckpointAttrs(m[1] || "");
    if (parsed) out.push(parsed);
  }
  return out;
}

describe("CHECKPOINT_RE 正则匹配 (R108 by/status 扩展)", () => {
  it("老 marker (step + summary, 无 by/status) 仍匹配 (向后兼容)", () => {
    const markers = parseMarkers(`<checkpoint step=1 summary="调研完成"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].step).toBe("1");
    expect(markers[0].summary).toBe("调研完成");
    expect(markers[0].by).toBeNull();
    expect(markers[0].status).toBeNull();
  });

  it("新 marker (step + by + status, 无 summary) 解析出 by/status, summary = null", () => {
    const markers = parseMarkers(`<checkpoint step=2 by="ao-dev" status="waiting_reply"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].step).toBe("2");
    expect(markers[0].summary).toBeNull();
    expect(markers[0].by).toBe("ao-dev");
    expect(markers[0].status).toBe("waiting_reply");
  });

  it("完整形态 (step + summary + by + status) 全部解析正确", () => {
    const markers = parseMarkers(
      `<checkpoint step="final" summary="全部完工" by="partner" status="has_suggestion"/>`,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "全部完工",
      by: "partner",
      status: "has_suggestion",
    });
  });

  it("引号可选: by / status 支持 unquoted 形态", () => {
    const markers = parseMarkers(`<checkpoint step=3 by=partner status=blocked/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].by).toBe("partner");
    expect(markers[0].status).toBe("blocked");
  });

  it("🔴 R108 T4: 属性顺序无关 — damo 模板 (step,status,by,summary) 必须解析", () => {
    // 实测事故: 老正则顺序敏感, damo R108 拍的模板顺序是
    //   step → status → by → summary, 老正则只认 step → summary → by → status
    //   → 整条 NO MATCH → 4 个测试 task 的 marker 全丢 (checkpoints 表 0 行).
    // 现在两段式解析, 任意顺序都等价.
    const damoTemplate = parseMarkers(
      `<checkpoint step="final" status="需拍板" by="damo" summary="R108 T4 测试"/>`,
    );
    expect(damoTemplate).toEqual([
      { step: "final", summary: "R108 T4 测试", by: "damo", status: "需拍板" },
    ]);
    // 另一种乱序同样等价
    expect(parseMarkers(`<checkpoint step=1 by="ao-dev" summary="abc" status="等回复"/>`)).toEqual([
      { step: "1", summary: "abc", by: "ao-dev", status: "等回复" },
    ]);
  });

  it("同一 block 多个 marker 全部解析", () => {
    const text = `
      <checkpoint step=1 summary="first"/>
      <checkpoint step=2 by="ao-dev"/>
      <checkpoint step=3 status="blocked"/>
      <checkpoint step=4 by="partner" status="waiting_reply"/>
    `;
    const markers = parseMarkers(text);
    expect(markers).toHaveLength(4);
    expect(markers[0]).toEqual({ step: "1", summary: "first", by: null, status: null });
    expect(markers[1]).toEqual({ step: "2", summary: null, by: "ao-dev", status: null });
    expect(markers[2]).toEqual({ step: "3", summary: null, by: null, status: "blocked" });
    expect(markers[3]).toEqual({ step: "4", summary: null, by: "partner", status: "waiting_reply" });
  });

  it("charset 受限: by/status 含特殊字符 (空格 / 引号 / < ) 降级为 null, 不拖累整条 marker", () => {
    // R108 T4 行为变更: 老实现「非法 by → 整条 marker 丢弃」→ 一个坏属性
    //   吞掉整个 checkpoint. 两段式后 step 合法即入库, 坏属性单独降级 null.
    expect(parseMarkers(`<checkpoint step=1 by="has space"/>`)).toEqual([
      { step: "1", summary: null, by: null, status: null },
    ]);
    // R132: 单引号合法值 — 老实现 by='single-quote' 因 [^\s"/>]+ 贪婪吞引号变
    //   "'single-quote'" → charset 拒绝 → 降级 null. 修后单引号等价双引号,
    //   'single-quote' 是合法 charset [A-Za-z0-9_-] → 应解析为 "single-quote".
    expect(parseMarkers(`<checkpoint step=1 by='single-quote'/>`)[0].by).toBe(
      "single-quote",
    );
    expect(parseMarkers(`<checkpoint step=1 by="bad<chars"/>`)[0].by).toBeNull();
  });

  // R132: 三种引号形态都解析. damo 在飞书 R108 实测发现 marker chip
  //   没显示, 根因 CHECKPOINT_ATTR_RE 贪婪吞单引号. 新加单引号测试 +
  //   双引号回归 + 无引号 + 混合.
  it("R132 双引号 (R108 主流形态) 仍匹配", () => {
    const markers = parseMarkers(`<checkpoint step="final" summary="调研完成"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "调研完成",
      by: null,
      status: null,
    });
  });

  it("R132 单引号 (本次新增) — damo R108 实测丢的形态", () => {
    const markers = parseMarkers(`<checkpoint step='final' summary='单引号测试'/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "单引号测试",
      by: null,
      status: null,
    });
  });

  it("R132 单引号 + 中文 status 完整形态", () => {
    const markers = parseMarkers(
      `<checkpoint step='final' summary='R108 修复完成' by='ao-dev' status='等回复'/>`,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "R108 修复完成",
      by: "ao-dev",
      status: "等回复",
    });
  });

  it("R132 无引号 bare value 形态", () => {
    const markers = parseMarkers(`<checkpoint step=final summary=无引号测试/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "无引号测试",
      by: null,
      status: null,
    });
  });

  it("R132 混合引号 (双引号 step + 单引号 status)", () => {
    const markers = parseMarkers(
      `<checkpoint step="final" status='等回复' summary="混合引号测试"/>`,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "混合引号测试",
      by: null,
      status: "等回复",
    });
  });

  // R108 T6: 4 个中文 status 必须直通 parser. damo R108 拍板的
  // 「等回复 / 有建议 / 需拍板 / 卡住」是 reviewing 卡片的核心 4 态,
  // 旧 regex [A-Za-z0-9_-] 不接受中文 → 整个 marker 不解析 →
  // checkpoints 表无数据. 现在 [\p{L}\p{N}_-] 接受 unicode letters/numbers,
  // 中文 status 直通. UI 映射走 status-display.ts (T2 已落地).
  it("中文 status 等回复 (waiting)", () => {
    const markers = parseMarkers(`<checkpoint step=1 status="等回复"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].status).toBe("等回复");
  });

  it("中文 status 有建议 (suggestion)", () => {
    const markers = parseMarkers(`<checkpoint step=1 status="有建议"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].status).toBe("有建议");
  });

  it("中文 status 需拍板 (decision)", () => {
    const markers = parseMarkers(`<checkpoint step=1 status="需拍板"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].status).toBe("需拍板");
  });

  it("中文 status 卡住 (blocked)", () => {
    const markers = parseMarkers(`<checkpoint step=1 status="卡住"/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].status).toBe("卡住");
  });

  it("中文 by + 中文 status 组合 (全 marker 形态)", () => {
    // 模拟 damo 实际使用形态: 中文 by (e.g. "ao-dev-agent" agent 标识
    // 也可中文) + 中文 status + 中文 summary 一起塞.
    const markers = parseMarkers(
      `<checkpoint step="final" summary="调研完了,等 damo 拍板" by="ao-dev" status="等回复"/>`,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      step: "final",
      summary: "调研完了,等 damo 拍板",
      by: "ao-dev",
      status: "等回复",
    });
  });

  it("中文 status unquoted 形态也匹配 (引号可选)", () => {
    // agent 偶尔省略引号, 老 charset 也允许 unquoted, T6 保持兼容.
    const markers = parseMarkers(`<checkpoint step=1 status=等回复/>`);
    expect(markers).toHaveLength(1);
    expect(markers[0].status).toBe("等回复");
  });

  it("step 仍 ASCII only (R108 T6 约束: step charset 不放开)", () => {
    // step 是机器 tag (final / 1 / milestone-1 等), 中文 step 语义不对.
    // 验证 step 仍受 [A-Za-z0-9_-] 限制 → 中文 step 不匹配.
    expect(parseMarkers(`<checkpoint step="第一步" status="等回复"/>`)).toHaveLength(0);
    expect(parseMarkers(`<checkpoint step=第一步 status="等回复"/>`)).toHaveLength(0);
  });

  it("self-closing 和非 self-closing 都匹配", () => {
    expect(parseMarkers(`<checkpoint step=1 summary="a"/>`)).toHaveLength(1);
    expect(parseMarkers(`<checkpoint step=1 summary="a">`)).toHaveLength(1);
    expect(parseMarkers(`<checkpoint step=1 summary="a"></checkpoint>`)).toHaveLength(1);
  });

  it("step 必填: 缺 step 不匹配", () => {
    // 缺 step → 整个 marker 不匹配
    expect(parseMarkers(`<checkpoint summary="no-step"/>`)).toHaveLength(0);
    expect(parseMarkers(`<checkpoint by="no-step"/>`)).toHaveLength(0);
  });
});
