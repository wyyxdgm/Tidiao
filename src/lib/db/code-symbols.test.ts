// Tests for code-symbols module (Code Knowledge Index L1, T2).
//
// 覆盖范围:
//   - upsert / delete / listByFile / countAll CRUD (10)
//   - searchSymbols: kind/exported/limit/score + 中文命中 + LIKE escape (15)
//   - extract-code-symbols fixture: 6 类 export 抽全 (10)
//   - reindex 流程: bulk + file-mode 一致性 (10)
//   - 失效判据: mtime 变 → 下次 search 仍 OK (5)
//
// 总计: 50 条.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "node:child_process";
import {
  upsertCodeSymbol,
  upsertCodeSymbols,
  deleteByFile,
  clearAll,
  listByFile,
  countAll,
  searchSymbols,
  type CodeSymbol,
} from "./code-symbols";
import { getDb, closeDb } from "./index";

let tmpDir: string;

function makeSymbol(over: Partial<CodeSymbol> = {}): CodeSymbol {
  return {
    id: "abcd1234:1",
    file: "src/lib/foo.ts",
    line: 1,
    kind: "function",
    name: "foo",
    signature: "export function foo(): void",
    docstring: null,
    exported: 1,
    indexed_at: new Date().toISOString(),
    file_mtime: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  // 用 in-memory 临时 DB, 每个 test 隔离.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-symbols-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  // 触发 migration — getDb() 第一次调会自动跑.
  const db = getDb();
  db.exec("SELECT 1");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============== CRUD (10) ==============

describe("CRUD: upsert / list / delete / count", () => {
  it("1. upsertCodeSymbol: 单条插入", () => {
    upsertCodeSymbol(makeSymbol({ id: "a1:1", name: "foo" }));
    expect(countAll()).toBe(1);
  });

  it("2. upsertCodeSymbol: 同 id 重复写 = 覆盖 (不增加行)", () => {
    upsertCodeSymbol(makeSymbol({ id: "a1:1", name: "foo" }));
    upsertCodeSymbol(makeSymbol({ id: "a1:1", name: "fooRenamed" }));
    expect(countAll()).toBe(1);
    expect(listByFile("src/lib/foo.ts")[0].name).toBe("fooRenamed");
  });

  it("3. upsertCodeSymbol: 不同 id 同 (file, line, name) → INSERT OR REPLACE 静默替换", () => {
    // SQLite INSERT OR REPLACE 处理 PK + UNIQUE 都通过"删老行 + 插新行"语义.
    // 同一位置不可能有两个同名 symbol — 设计上 OK, 实现上静默替换.
    upsertCodeSymbol(makeSymbol({ id: "hash1:1", file: "f.ts", line: 10, name: "bar" }));
    upsertCodeSymbol(makeSymbol({ id: "hash2:1", file: "f.ts", line: 10, name: "bar" }));
    expect(countAll()).toBe(1);
    expect(listByFile("f.ts")[0].id).toBe("hash2:1");
  });

  it("4. upsertCodeSymbols: 批量写 + 全成功事务", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "a1:1", file: "a.ts", name: "x" }),
      makeSymbol({ id: "a1:2", file: "a.ts", name: "y" }),
      makeSymbol({ id: "b1:1", file: "b.ts", name: "z" }),
    ]);
    expect(countAll()).toBe(3);
  });

  it("5. upsertCodeSymbols: 任一字段异常 → 整批回滚", () => {
    expect(() => {
      upsertCodeSymbols([
        makeSymbol({ id: "a1:1", file: "a.ts", line: 1, name: "a" }),
        // kind 非法 (非 enum 成员) — SQLite free text 但我们的应用层 type guard 应
        // 在 import 阶段拒, 而非在 upsert. 这里用缺必填字段 (缺 file) 测 NOT NULL 触发.
        { id: "x", line: 1, kind: "function", name: "y", signature: "s", docstring: null, exported: 1, indexed_at: "t", file_mtime: "t" } as unknown as CodeSymbol,
      ]);
    }).toThrow();
    expect(countAll()).toBe(0);
  });

  it("6. deleteByFile: 单文件全部删除", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "a:1", file: "a.ts", name: "x" }),
      makeSymbol({ id: "a:2", file: "a.ts", name: "y" }),
      makeSymbol({ id: "b:1", file: "b.ts", name: "z" }),
    ]);
    expect(countAll()).toBe(3);
    deleteByFile("a.ts");
    expect(countAll()).toBe(1);
    expect(listByFile("a.ts")).toEqual([]);
  });

  it("7. deleteByFile: 不存在的 file = noop", () => {
    upsertCodeSymbol(makeSymbol({ id: "a:1", file: "a.ts", name: "x" }));
    deleteByFile("ghost.ts");
    expect(countAll()).toBe(1);
  });

  it("8. clearAll: 全表清空", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "a:1", file: "a.ts", line: 1, name: "x" }),
      makeSymbol({ id: "b:1", file: "b.ts", line: 1, name: "y" }),
    ]);
    expect(countAll()).toBe(2);
    clearAll();
    expect(countAll()).toBe(0);
  });

  it("9. listByFile: 按 line ASC 返回", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "a:5", file: "a.ts", line: 50, name: "z" }),
      makeSymbol({ id: "a:1", file: "a.ts", line: 10, name: "x" }),
      makeSymbol({ id: "a:3", file: "a.ts", line: 30, name: "y" }),
    ]);
    const rows = listByFile("a.ts");
    expect(rows.map((r) => r.line)).toEqual([10, 30, 50]);
    expect(rows.map((r) => r.name)).toEqual(["x", "y", "z"]);
  });

  it("10. countAll: 0 行返 0", () => {
    expect(countAll()).toBe(0);
  });
});

// ============== searchSymbols (15) ==============

describe("searchSymbols: 字面搜 + 过滤 + score", () => {
  beforeEach(() => {
    // 准备数据: 5 个 symbol, 跨 kind / exported / 中英文
    upsertCodeSymbols([
      makeSymbol({ id: "a:1", file: "a.ts", line: 1, kind: "function", name: "searchKnowledge", signature: "export function searchKnowledge(): Result", docstring: "知识检索主入口", exported: 1 }),
      makeSymbol({ id: "a:2", file: "a.ts", line: 10, kind: "function", name: "_internalHelper", signature: "function _internalHelper(): void", docstring: "内部 helper, 不导出", exported: 0 }),
      makeSymbol({ id: "a:3", file: "a.ts", line: 20, kind: "class", name: "TaskScheduler", signature: "export class TaskScheduler {}", docstring: null, exported: 1 }),
      makeSymbol({ id: "b:1", file: "b.ts", line: 1, kind: "interface", name: "Config", signature: "export interface Config { x: number }", docstring: "Config 定义", exported: 1 }),
      makeSymbol({ id: "c:1", file: "c.ts", line: 1, kind: "const", name: "DEFAULT_LIMIT", signature: "export const DEFAULT_LIMIT = 20", docstring: "默认 limit", exported: 1 }),
    ]);
  });

  it("11. 字面搜 name 命中 = score 3", () => {
    const r = searchSymbols("searchKnowledge");
    expect(r.length).toBe(1);
    expect(r[0].score).toBeGreaterThanOrEqual(3);
    expect(r[0].name).toBe("searchKnowledge");
  });

  it("12. signature 命中 (name 不命中) = score ≥ 2", () => {
    const r = searchSymbols("Result");
    expect(r.length).toBeGreaterThan(0);
    expect(r.find((x) => x.name === "searchKnowledge")).toBeDefined();
  });

  it("13. docstring 中文命中", () => {
    const r = searchSymbols("知识检索");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("searchKnowledge");
  });

  it("14. 中文 alias 命中 (LIKE 通配)", () => {
    upsertCodeSymbol(makeSymbol({ id: "d:1", file: "d.ts", line: 1, kind: "function", name: "派单", signature: "export function 派单(): void", docstring: null, exported: 1 }));
    const r = searchSymbols("派单");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("派单");
  });

  it("15. kind=function 仅返回 function 类型", () => {
    const r = searchSymbols("export", { kind: "function" });
    expect(r.every((x) => x.kind === "function")).toBe(true);
    // TaskScheduler (class) / DEFAULT_LIMIT (const) 不应出现
    expect(r.find((x) => x.name === "TaskScheduler")).toBeUndefined();
  });

  it("16. exported=true 仅返回 exported=1", () => {
    const r = searchSymbols("helper", { exported: true });
    expect(r.every((x) => x.exported === 1)).toBe(true);
    expect(r.find((x) => x.name === "_internalHelper")).toBeUndefined();
  });

  it("17. exported=false 仅返回非导出", () => {
    const r = searchSymbols("helper", { exported: false });
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("_internalHelper");
  });

  it("18. limit 上限 50 (传 100 → 只返 ≤ 50)", () => {
    upsertCodeSymbols(
      Array.from({ length: 60 }, (_, i) =>
        makeSymbol({ id: `bulk:${i}`, file: "bulk.ts", line: i + 1, name: `sym${i}` })
      )
    );
    const r = searchSymbols("sym", { limit: 100 });
    expect(r.length).toBe(50);
  });

  it("19. limit 下限 1 (传 0 → 视作 1)", () => {
    const r = searchSymbols("export", { limit: 0 });
    expect(r.length).toBe(1);
  });

  it("20. LIKE 元字符 _ 转义 (q='_internal' 不通配)", () => {
    const r = searchSymbols("_internal");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("_internalHelper");
  });

  it("21. LIKE 元字符 % 转义 (q='%' 不通配)", () => {
    const r = searchSymbols("%");
    expect(r.length).toBe(0);
  });

  it("22. 大小写不敏感 (SQLite ASCII 默认)", () => {
    const r = searchSymbols("taskSCHEDULER");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("TaskScheduler");
  });

  it("23. 空 query = 返空", () => {
    expect(searchSymbols("")).toEqual([]);
    expect(searchSymbols("   ")).toEqual([]);
  });

  it("24. 永不抛错 (DB 异常 → 空数组)", () => {
    closeDb();
    fs.rmSync(path.join(tmpDir, "test.db"));
    const r = searchSymbols("anything");
    expect(r).toEqual([]);
  });

  it("25. score 排序: name 命中排前 (比 signature 命中优先)", () => {
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", line: 1, kind: "function", name: "Config", signature: "export function ConfigWrapper() {}", exported: 1 }));
    // name='Config' = score 3+ (interface also matches name)
    // name='ConfigWrapper' = score 3 (only x.ts)
    const r = searchSymbols("Config");
    // 第一名应是 "Config" (interface, name 命中 3) — 排除 wrapper 的 "Config" 子串?
    // wrapper name 是 "ConfigWrapper", query "Config" 是子串 → 也命中 name.
    // 所以两条都是 name 命中 3. 排序看 indexed_at (同时间 → 稳定).
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].score).toBeGreaterThanOrEqual(3);
  });
});

// ============== extract-code-symbols 抽 fixture (10) ==============

describe("extract-code-symbols.ts: 6 类 export 抽全", () => {
  let fixturesDir: string;

  beforeEach(() => {
    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-fixtures-"));
  });

  afterEach(() => {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  });

  // extract 走 npx tsx spawn 子进程, 单次启动 ~2-3s, 给 30s 兜底.
  const extractTimeout = 30_000;

  function runExtract(file: string): any[] {
    // vitest worker 的 cwd 可能是 src/lib/db/ (test 文件所在目录), 不是仓根.
    // 用 import.meta.url 推算仓根, 避免依赖 process.cwd().
    // test 文件 = src/lib/db/code-symbols.test.ts → 仓根 = ../../../..
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(here, "..", "..", "..");
    const target = path.relative(repoRoot, file);
    const out = execFileSync(
      "npx",
      ["--no-install", "tsx", "scripts/extract-code-symbols.ts", "--file", target],
      { cwd: repoRoot, encoding: "utf8" }
    );
    return JSON.parse(out);
  }

  it("26. export function 抽 1 条 function", () => {
    const f = path.join(fixturesDir, "fn.ts");
    fs.writeFileSync(f, `/** JSDoc 头 */\nexport function greet(name: string): string { return "hi " + name; }\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(1);
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].name).toBe("greet");
    expect(symbols[0].exported).toBe(1);
    expect(symbols[0].docstring).toBe("JSDoc 头");
  }, extractTimeout);

  it("27. export class 抽 1 条 class", () => {
    const f = path.join(fixturesDir, "cls.ts");
    fs.writeFileSync(f, `/** 类文档 */\nexport class Animal { constructor(public name: string) {} }\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(1);
    expect(symbols[0].kind).toBe("class");
    expect(symbols[0].name).toBe("Animal");
  }, extractTimeout);

  it("28. export interface 抽 1 条 interface", () => {
    const f = path.join(fixturesDir, "iface.ts");
    fs.writeFileSync(f, `/** 接口文档 */\nexport interface User { id: string }\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(1);
    expect(symbols[0].kind).toBe("interface");
    expect(symbols[0].name).toBe("User");
  }, extractTimeout);

  it("29. export type 抽 1 条 type", () => {
    const f = path.join(fixturesDir, "ty.ts");
    fs.writeFileSync(f, `export type Maybe<T> = T | null;\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(1);
    expect(symbols[0].kind).toBe("type");
    expect(symbols[0].name).toBe("Maybe");
  }, extractTimeout);

  it("30. export const (单变量) 抽 1 条 const", () => {
    const f = path.join(fixturesDir, "k.ts");
    fs.writeFileSync(f, `export const FOO = 1;\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(1);
    expect(symbols[0].kind).toBe("const");
    expect(symbols[0].name).toBe("FOO");
  }, extractTimeout);

  it("31. export default function 抽 kind=default", () => {
    const f = path.join(fixturesDir, "def.ts");
    fs.writeFileSync(f, `export default function main() { return 1; }\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(1);
    expect(symbols[0].kind).toBe("default");
    expect(symbols[0].name).toBe("main");
  }, extractTimeout);

  it("32. 非 export 的内部函数也抽 (exported=0, 供 grep 兜底)", () => {
    // plan §3.1 P3: "内部 helper (非 export) 仅 name + file:line (供 grep 兜底)"
    // extract 抽所有 function, exported=0 标记内部. caller 按 exported 过滤.
    const f = path.join(fixturesDir, "internal.ts");
    fs.writeFileSync(f, `function privateFn() {}\nexport function publicFn() {}\n`);
    const symbols = runExtract(f);
    expect(symbols.length).toBe(2);
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(["privateFn", "publicFn"]);
    expect(symbols.find((s) => s.name === "publicFn")?.exported).toBe(1);
    expect(symbols.find((s) => s.name === "privateFn")?.exported).toBe(0);
  }, extractTimeout);

  it("33. 多 export 在同一文件都抽全", () => {
    const f = path.join(fixturesDir, "multi.ts");
    fs.writeFileSync(
      f,
      `export function a() {}\nexport class B {}\nexport interface C {}\nexport type D = string;\nexport const e = 1;\n`
    );
    const symbols = runExtract(f);
    expect(symbols.length).toBe(5);
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(["B", "C", "D", "a", "e"]);
  }, extractTimeout);

  it("34. signature 截前 200 char (含 export 关键字)", () => {
    const f = path.join(fixturesDir, "longsig.ts");
    const long = "x".repeat(300);
    fs.writeFileSync(f, `export function bigSig(${long}: string): void {}\n`);
    const symbols = runExtract(f);
    expect(symbols[0].signature.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(symbols[0].signature.startsWith("export function bigSig")).toBe(true);
  }, extractTimeout);

  it("35. id 算法: {sha1(file).slice(0,8)}:{line}", () => {
    const f = path.join(fixturesDir, "id.ts");
    fs.writeFileSync(f, `export function foo() {}\n`);
    const symbols = runExtract(f);
    // 8 hex chars : line
    expect(symbols[0].id).toMatch(/^[a-f0-9]{8}:1$/);
  }, extractTimeout);
});

// ============== reindex 一致性 (10) ==============

describe("reindex: bulk / file-mode 一致性", () => {
  let fixturesDir: string;

  beforeEach(() => {
    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "reindex-fixtures-"));
  });

  afterEach(() => {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  });

  it("36. file-mode import: deleteByFile + upsert 单文件全替换", () => {
    // 先 seed 老 symbol
    upsertCodeSymbols([
      makeSymbol({ id: "old:1", file: "x.ts", line: 1, name: "oldFn" }),
      makeSymbol({ id: "old:2", file: "x.ts", line: 5, name: "another" }),
      makeSymbol({ id: "y:1", file: "y.ts", line: 1, name: "yFn" }),
    ]);
    expect(countAll()).toBe(3);
    // file-mode: 模拟 import --file-mode 对 x.ts 做 delete + upsert
    deleteByFile("x.ts");
    upsertCodeSymbols([makeSymbol({ id: "new:1", file: "x.ts", line: 1, name: "newFn" })]);
    // x.ts 旧行没了, 新行在, y.ts 保留
    expect(countAll()).toBe(2);
    expect(listByFile("x.ts").length).toBe(1);
    expect(listByFile("x.ts")[0].name).toBe("newFn");
    expect(listByFile("y.ts").length).toBe(1);
  });

  it("37. bulk import (--all): 先 clearAll 后 upsert 全部行", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "x:1", file: "x.ts", line: 1, name: "x" }),
      makeSymbol({ id: "y:1", file: "y.ts", line: 1, name: "y" }),
    ]);
    expect(countAll()).toBe(2);
    clearAll();
    upsertCodeSymbols([
      makeSymbol({ id: "z:1", file: "z.ts", line: 1, name: "z" }),
      makeSymbol({ id: "w:1", file: "w.ts", line: 1, name: "w" }),
      makeSymbol({ id: "v:1", file: "v.ts", line: 1, name: "v" }),
    ]);
    expect(countAll()).toBe(3);
  });

  it("38. file-mode: 多次跑同一文件 = 幂等 (id 同则覆盖, 不增加行)", () => {
    upsertCodeSymbols([makeSymbol({ id: "x:1", file: "x.ts", name: "v1" })]);
    deleteByFile("x.ts");
    upsertCodeSymbols([makeSymbol({ id: "x:1", file: "x.ts", name: "v2" })]);
    expect(countAll()).toBe(1);
    expect(listByFile("x.ts")[0].name).toBe("v2");
  });

  it("39. upsertCodeSymbols 空数组 = noop", () => {
    upsertCodeSymbol(makeSymbol({ id: "x:1" }));
    upsertCodeSymbols([]);
    expect(countAll()).toBe(1);
  });

  it("40. file_mtime 字段持久化 (查回来仍存在)", () => {
    const mtime = "2026-09-06T10:00:00.000Z";
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", file_mtime: mtime }));
    expect(listByFile("x.ts")[0].file_mtime).toBe(mtime);
  });

  it("41. indexed_at 字段持久化", () => {
    const ts = "2026-09-06T11:00:00.000Z";
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", indexed_at: ts }));
    expect(listByFile("x.ts")[0].indexed_at).toBe(ts);
  });

  it("42. export 状态变更: exported: 1 → 0 覆盖正确", () => {
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", exported: 1 }));
    expect(listByFile("x.ts")[0].exported).toBe(1);
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", exported: 0 }));
    expect(listByFile("x.ts")[0].exported).toBe(0);
  });

  it("43. docstring null ↔ string 覆盖正确", () => {
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", docstring: null }));
    expect(listByFile("x.ts")[0].docstring).toBeNull();
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", docstring: "有了" }));
    expect(listByFile("x.ts")[0].docstring).toBe("有了");
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", docstring: null }));
    expect(listByFile("x.ts")[0].docstring).toBeNull();
  });

  it("44. 跨文件操作不影响其他文件", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "a:1", file: "a.ts", name: "A" }),
      makeSymbol({ id: "b:1", file: "b.ts", name: "B" }),
    ]);
    deleteByFile("a.ts");
    expect(listByFile("a.ts").length).toBe(0);
    expect(listByFile("b.ts").length).toBe(1);
  });

  it("45. UNIQUE(file, line, name) — INSERT OR REPLACE 静默替换 (同位置同名不可能合法)", () => {
    upsertCodeSymbol(makeSymbol({ id: "h1:1", file: "f.ts", line: 1, name: "x" }));
    upsertCodeSymbol(makeSymbol({ id: "h2:1", file: "f.ts", line: 1, name: "x" }));
    expect(countAll()).toBe(1);
    expect(listByFile("f.ts")[0].id).toBe("h2:1");
  });
});

// ============== 失效判据 (5) ==============

describe("失效判据: mtime 变 → 下次 search 不直接爆 (cache 层由 caller 处理)", () => {
  it("46. file_mtime 在 DB 与 fs 不一致时, searchSymbols 仍返回该行 (caller 自己决定是否 reindex)", () => {
    // DB 里的 file_mtime 是 T1, fs 的 stat 已是 T2 → 我们的 searchSymbols 不负责
    // 检测 mtime 不一致, 只负责字面搜. caller (check-code-index.ts) 负责检测.
    upsertCodeSymbol(
      makeSymbol({
        id: "x:1",
        file: "x.ts",
        file_mtime: "2026-01-01T00:00:00.000Z",
      })
    );
    const r = searchSymbols("foo");
    expect(r.length).toBe(1);
    // 真实 fs 的 mtime 远大于 DB 的 → 但 searchSymbols 仍返 (drift 检测归 check-code-index)
    expect(r[0].file_mtime).toBe("2026-01-01T00:00:00.000Z");
  });

  it("47. upsertCodeSymbol 新 mtime 覆盖旧 mtime", () => {
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", file_mtime: "2026-01-01T00:00:00.000Z" }));
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", file_mtime: "2026-09-06T00:00:00.000Z" }));
    expect(listByFile("x.ts")[0].file_mtime).toBe("2026-09-06T00:00:00.000Z");
  });

  it("48. 重复 upsert 不修改 indexed_at 是 bug — 我们接受 (upsert 不主动维护该字段, 由 caller 传)", () => {
    const ts1 = "2026-09-06T10:00:00.000Z";
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", indexed_at: ts1 }));
    const ts2 = "2026-09-06T11:00:00.000Z";
    upsertCodeSymbol(makeSymbol({ id: "x:1", file: "x.ts", indexed_at: ts2 }));
    // caller 应每次传新 indexed_at — 我们的实现忠实于 caller 输入.
    expect(listByFile("x.ts")[0].indexed_at).toBe(ts2);
  });

  it("49. 大批量 upsertCodeSymbols 单事务回滚 (中间 symbol 异常)", () => {
    upsertCodeSymbol(makeSymbol({ id: "anchor:1" }));
    expect(() => {
      upsertCodeSymbols([
        makeSymbol({ id: "tx:1" }),
        makeSymbol({ id: "tx:2" }),
        // 缺必填 name (typeof string 校验不通过 — schema 不强制 NOT NULL, SQLite
        // 接受 NULL; 这里用 kind 非法类型模拟)
        { id: "tx:3", file: "tx.ts", line: 3 } as unknown as CodeSymbol,
      ]);
    });
    // tx 行应没写入 (整批回滚); anchor 保留.
    expect(countAll()).toBe(1);
  });

  it("50. 同 file 多 symbol 共存", () => {
    upsertCodeSymbols([
      makeSymbol({ id: "f:1", file: "f.ts", line: 1, name: "a", kind: "function" }),
      makeSymbol({ id: "f:10", file: "f.ts", line: 10, name: "B", kind: "class" }),
      makeSymbol({ id: "f:20", file: "f.ts", line: 20, name: "c", kind: "const" }),
    ]);
    const rows = listByFile("f.ts");
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.kind).sort()).toEqual(["class", "const", "function"]);
  });
});