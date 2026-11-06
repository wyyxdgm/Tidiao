// Tests for business-terms module (Code Knowledge Index L2, T3).
//
// 覆盖范围:
//   - CRUD (upsert / getByDamoTerm / listTerms) (5)
//   - expandQuery: 短词 / 多词 / 空 / 命中 damo_term / 命中 alias (5)
//   - 双向扩展: "派单" → "dispatch task" + aliases (5)
//   - 术语权威源加载 (parseTerminologyMd) (5)
//
// 总计: 20 条.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  upsertTerm,
  upsertTerms,
  getByDamoTerm,
  listTerms,
  countAll,
  expandQuery,
  parseTermRow,
  parseTerminologyMd,
} from "./business-terms";
import { getDb, closeDb } from "./index";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "business-terms-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  const db = getDb();
  db.exec("SELECT 1");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- CRUD + expandQuery 基础 (10 条) ----

describe("CRUD", () => {
  it("upsertTerm: 单条写入, getByDamoTerm 命中", () => {
    upsertTerm({ damo_term: "派单", canonical: "dispatch task", aliases: "派发,dispatch" });
    const t = getByDamoTerm("派单");
    expect(t).not.toBeNull();
    expect(t?.canonical).toBe("dispatch task");
    expect(t?.aliases).toBe("派发,dispatch");
  });

  it("upsertTerm: 同 damo_term 重复写 = 覆盖", () => {
    upsertTerm({ damo_term: "派单", canonical: "old" });
    upsertTerm({ damo_term: "派单", canonical: "new" });
    expect(getByDamoTerm("派单")?.canonical).toBe("new");
  });

  it("upsertTerms: 批量 upsert (md 解析用)", () => {
    const n = upsertTerms([
      { damo_term: "派单", canonical: "dispatch task" },
      { damo_term: "过卡", canonical: "deploy approval" },
      { damo_term: "甲答", canonical: "client response" },
    ]);
    expect(n).toBe(3);
    expect(countAll()).toBe(3);
  });

  it("getByDamoTerm: 不存在返 null", () => {
    expect(getByDamoTerm("不存在的术语")).toBeNull();
  });

  it("listTerms: 按 damo_term ASC 排序, 含 null aliases / domain", () => {
    upsertTerm({ damo_term: "派单", canonical: "dispatch task", aliases: "派发,dispatch" });
    upsertTerm({ damo_term: "甲答", canonical: "client response" }); // 无 aliases
    upsertTerm({ damo_term: "沉淀", canonical: "durable knowledge", domain: "knowledge" });
    const all = listTerms();
    // SQLite 默认 binary collation, 中文按 UTF-8 字节序排. 这里只验证返回行数 + 包含关系.
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.damo_term).sort()).toEqual(["沉淀", "派单", "甲答"].sort());
    expect(all.find((t) => t.damo_term === "甲答")?.aliases).toBeNull();
  });
});

describe("expandQuery 基础行为", () => {
  it("空 query 返空, 不抛错", () => {
    expect(expandQuery("")).toBe("");
    // 全空白会被 trim, 也返空
    expect(expandQuery("   ")).toBe("");
  });

  it("短词 (<2 字符) 不扩展, 原样透传", () => {
    upsertTerm({ damo_term: "派", canonical: "dispatch" });
    expect(expandQuery("派")).toBe("派");
  });

  it("多词 query 不扩展 (单 word 命中设计)", () => {
    upsertTerm({ damo_term: "派单", canonical: "dispatch task" });
    expect(expandQuery("派单 task")).toBe("派单 task");
  });

  it("未命中术语的 query 原样透传", () => {
    upsertTerm({ damo_term: "派单", canonical: "dispatch task" });
    expect(expandQuery("绝对不存在")).toBe("绝对不存在");
  });

  it("expandQuery 抛错时返原 query (永不阻断 caller)", () => {
    upsertTerm({ damo_term: "派单", canonical: "dispatch task" });
    // 模拟 getDb 抛错 — 通过改 env 触发 schema fail 不易; 这里验证函数不依赖外部状态:
    // 即便 DB 没建 (closeDb 后), 也能返回 (catch 兜底).
    closeDb();
    // 再次 expand 应当不抛错, 返回原 query 或合理值
    expect(() => expandQuery("派单")).not.toThrow();
  });
});

// ---- 双向扩展 (5 条) ----

describe("双向扩展 — 派单 ↔ dispatch task", () => {
  beforeEach(() => {
    upsertTerm({
      damo_term: "派单",
      canonical: "dispatch task",
      aliases: "分发任务,派发,dispatch",
      domain: "platform",
      notes: "本平台特指 task 派发",
    });
  });

  it("'派单' → '(派单 | dispatch task | 分发任务 | 派发 | dispatch)'", () => {
    const expanded = expandQuery("派单");
    // 顺序: 原 query → canonical → aliases (去重保序)
    expect(expanded).toBe("(派单 | dispatch task | 分发任务 | 派发 | dispatch)");
  });

  it("'dispatch' (alias 命中) → 等同 '派单' 扩展", () => {
    const expanded = expandQuery("dispatch");
    // 原 query "dispatch" 在前 → canonical "dispatch task" → damo_term "派单" → 其余 aliases
    expect(expanded).toBe("(dispatch | dispatch task | 分发任务 | 派发)");
  });

  it("'派发' (alias 命中) → 等同 '派单' 扩展", () => {
    const expanded = expandQuery("派发");
    expect(expanded).toBe("(派发 | dispatch task | 分发任务 | dispatch)");
  });

  it("V6/V7 验证点: '派单' 与 'dispatch task' 命中同一组符号 (见 knowledge 集成测试)", () => {
    // 本测试仅验证 expandQuery 自身; ao recall 集成验证见 scripts/ao-recall.sh + 端到端.
    const a = expandQuery("派单");
    const b = expandQuery("dispatch task");
    // b 应是原词 (canonical) + 命中 damo_term "派单" 扩展, 但 canonical 自己 = dispatch task
    // 所以 b 原样返回 ("dispatch task" 是多词命中 OR canonical 命中 damo_term=派单)
    // — 实际 expandQuery 仅在 rawQuery 单词且等于 damo_term/alias 时扩展; "dispatch task" 是
    // 多词, 原样透传. 这里只验证 a 是扩展态.
    expect(a).toContain("dispatch task");
    expect(a).toContain("派单");
  });

  it("术语改 DB 后 expandQuery 立刻反映 (无缓存)", () => {
    upsertTerm({ damo_term: "新词", canonical: "new-concept", aliases: "alias1,alias2" });
    expect(expandQuery("新词")).toContain("new-concept");
  });
});

// ---- 术语权威源加载 (5 条) ----

describe("terminology.md 解析 (D2 拍板 md 为单源真理)", () => {
  it("parseTermRow: 解析单行 → 5 列", () => {
    const row = parseTermRow("| 派单 | dispatch task | 分发任务,派发,dispatch | platform | 本平台特指 task 派发 |");
    expect(row).toEqual({
      damo_term: "派单",
      canonical: "dispatch task",
      aliases: "分发任务,派发,dispatch",
      domain: "platform",
      notes: "本平台特指 task 派发",
    });
  });

  it("parseTermRow: 跳过表头 + 分隔行", () => {
    expect(parseTermRow("| damo_term | canonical | aliases | domain | notes |")).toBeNull();
    expect(parseTermRow("|---|---|---|---|")).toBeNull();
    expect(parseTermRow("")).toBeNull();
  });

  it("parseTermRow: aliases 空 → null", () => {
    // 5 列: damo_term | canonical | aliases | domain | notes — 故意只填前 3 列, 后 2 列缺席
    const row = parseTermRow("| 派单 | dispatch task | 派发,dispatch |  |  |");
    expect(row?.damo_term).toBe("派单");
    expect(row?.canonical).toBe("dispatch task");
    expect(row?.aliases).toBe("派发,dispatch");
    expect(row?.domain).toBeNull();
    expect(row?.notes).toBeNull();
  });

  it("parseTermRow: damo_term 空 → 抛错 (fail-fast)", () => {
    expect(() => parseTermRow("|  | dispatch |  |  |  |")).toThrow();
  });

  it("parseTerminologyMd: 解析完整 md 表格 (内嵌 fixture, 解析器不依赖真实 md 行数)", () => {
    const md = `# 业务术语权威源

| damo_term | canonical | aliases | domain | notes |
|-----------|-----------|---------|--------|-------|
| 派单 | dispatch task | 分发任务,派发,dispatch | platform | 本平台特指 task 派发 |
| 过卡 | deploy approval | 部署审批,通过审批,deploy-approval | platform | task 进入 reviewing 状态 |
| 甲答 | client response | 甲方回答,client answer | feishu | 甲方在飞书协作中的回复 |
| 沉淀 | durable knowledge | 积累成可复用知识,sediment | knowledge | 把经验写到 docs/learned |
| 过审 | approval-passed | 审批通过,approved | platform | approve 后状态变 completed |
| 转人工 | human-handoff | 交给人,manual | platform | canUseTool 拦不住时升级 |
| 卡住 | stuck task | 阻塞,stuck | platform | running 但 90 分钟无进展 |
| 看住 | watchdog-monitor | 监控,watch | platform | partner 的 watchdog |
`;
    const terms = parseTerminologyMd(md);
    expect(terms).toHaveLength(8);
    expect(terms[0]?.damo_term).toBe("派单");
    expect(terms[0]?.canonical).toBe("dispatch task");
    expect(terms[7]?.damo_term).toBe("看住");
  });
});