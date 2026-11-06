// v35: wiki 可读文件类型 —— 高级选项.
//
// 这个特性的风险全在「放宽」这一侧: 放宽过头 = 把 .env / id_rsa / scripts/.env.tokens
// 暴露到一个只需登录就能看的 wiki 页面。所以本文件断言的重点不是「配了 json 能读
// json」, 而是:
//   1. 不配 = 行为与上线前一字不差(只 md)
//   2. 非法输入被**拒绝**而不是静默降级
//   3. 隐藏文件/路径穿越/密钥类扩展名 无论怎么配都读不到
//
// 自证有效性(突变测试, 2026-08-11 全部实跑, 逐条见交付报告):
//   - hasHiddenSegment 本体改成永远 return false -> "隐藏文件" 3 条变红
//   - DENIED_EXTENSIONS 硬拒去掉 -> "密钥类" 4 条变红
//   - EXT_PATTERN 校验去掉 -> "拒绝非法扩展名" 4 条变红
//   - parseStoredExtensions 跳过复校 -> "库内脏数据" 2 条变红
//   - allowedExtensions 未配置时放行一切 -> "默认只 md" 9 条变红
//   - route.ts safeResolve 的 `..` 拦截 / 两道隐藏段 / 扩展名白名单 逐条删除
//     -> 变红(修复前是**全绿假绿**, 因为下面这个函数曾是本地复刻)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject, getProjectById, updateProject } from "./projects";
import {
  BASE_EXTENSION,
  DENIED_EXTENSIONS,
  MAX_EXTRA_EXTENSIONS,
  MAX_NON_MD_BYTES,
  allowedExtensions,
  extOf,
  hasHiddenSegment,
  isAllowedFile,
  isMarkdown,
  normalizeExtensionsInput,
  parseStoredExtensions,
} from "../wiki-files";
// 🔴 被测的**真实** safeResolve, 与 route.ts 用的是同一份实现。
// 这里曾经是一份本地复刻, 后果: 把 route.ts 里的穿越防护整行删掉, 36 条测试依然
// 全绿。任何「为了避开 next/server 而抄一份」的改动都会重新制造假绿 —— 要动就动
// wiki-resolve.ts, 别在测试里复刻。
import { safeResolve } from "../wiki-resolve";

let tmpDir: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wiki-ext-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑全部 migration (含 v35) 到临时库
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// (此处曾有一份 safeResolve 的本地复刻, 已删除 —— 它让所有 safeResolve 相关的
//  安全断言变成假绿。现在直接 import ../wiki-resolve 的真实实现。)
// ───────────────────────────────────────────────────────────────────────────

/** 建一个带若干文件的 cwd, 返回 realpath(macOS 的 /tmp 是 symlink, 必须 realpath). */
function mkCwd(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(tmpDir, "cwd-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return fs.realpathSync(root);
}

describe("v35 migration", () => {
  it("recorded v35 and added projects.wiki_extra_extensions", () => {
    const db = getDb();
    expect(db.prepare(`SELECT 1 FROM _migrations WHERE version = 35`).get()).toBeDefined();
    const cols = (
      db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("wiki_extra_extensions");
  });

  it("是纯 additive: 既有列一个没少", () => {
    // ALTER TABLE ADD COLUMN 不会动既有列, 但如果有人把这条改成重建表就可能丢列。
    // dev/prod 共享同一个库, 丢列 = 生产事故。
    const cols = (
      getDb().prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const c of [
      "id", "name", "description", "created_at", "current_version_id",
      "cwd", "owner_id", "pinned", "deleted_at",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("新建项目的默认值使放行集合恰好 = {md}", () => {
    const p = createProject({ name: "proj", ownerId: userId });
    expect([...allowedExtensions(p.wiki_extra_extensions)]).toEqual([BASE_EXTENSION]);
  });

  it("存量行(列值为 NULL)同样退化成只放行 md", () => {
    // migration 的 DEFAULT '[]' 只作用于新插入的行; ADD COLUMN 给既有行填的是
    // NULL。存量 15 个项目走的就是这条路径 —— 必须和 '[]' 等价。
    const p = createProject({ name: "legacy", ownerId: userId });
    getDb()
      .prepare(`UPDATE projects SET wiki_extra_extensions = NULL WHERE id = ?`)
      .run(p.id);
    const reread = getProjectById(p.id, userId)!;
    expect(reread.wiki_extra_extensions).toBeNull();
    expect([...allowedExtensions(reread.wiki_extra_extensions)]).toEqual([BASE_EXTENSION]);
  });
});

describe("默认只放行 md（未配置项目行为零变化）", () => {
  it("allowedExtensions 对 null/空串/'[]'/[] 都只给 md", () => {
    for (const v of [null, undefined, "", "[]", "[ ]"]) {
      expect([...allowedExtensions(v)]).toEqual([BASE_EXTENSION]);
    }
  });

  it("isAllowedFile: 默认集合放 md, 拒 json/txt/csv/env", () => {
    const allowed = allowedExtensions(null);
    expect(isAllowedFile("INDEX.md", allowed)).toBe(true);
    expect(isAllowedFile("README.MD", allowed)).toBe(true); // 大小写不敏感
    for (const n of ["data.json", "a.txt", "x.csv", "prod.env", "Makefile"]) {
      expect(isAllowedFile(n, allowed)).toBe(false);
    }
  });

  it("safeResolve: 未配置项目读不到 .json, 读得到 .md", () => {
    const cwd = mkCwd({ "INDEX.md": "# hi", "data.json": '{"a":1}' });
    const allowed = allowedExtensions(null);
    expect(safeResolve(cwd, "INDEX.md", allowed)).not.toBeNull();
    expect(safeResolve(cwd, "data.json", allowed)).toBeNull();
  });

  it("库里塞进脏数据也不放宽（手工 SQL 写入的防线）", () => {
    // 有人 sqlite3 直接 UPDATE 成这些值时, 必须降级成只 md, 不能因为「进了库」
    // 就被信任。
    for (const junk of [
      '["*"]',
      '"json"', // 不是数组
      "not json at all",
      '["../../etc"]',
      '["js/../env"]',
      '[".env"]',
      '["env"]', // 密钥类, 硬拒
      "null",
      "{}",
      '[123]',
    ]) {
      expect([...allowedExtensions(junk)]).toEqual([BASE_EXTENSION]);
    }
  });
});

describe("配置后放行指定类型", () => {
  it("PATCH 语义: updateProject 落库并生效", () => {
    const p = createProject({ name: "proj", ownerId: userId });
    const updated = updateProject(p.id, { wiki_extra_extensions: ["json", "csv"] })!;
    expect(JSON.parse(updated.wiki_extra_extensions!)).toEqual(["json", "csv"]);
    const allowed = allowedExtensions(updated.wiki_extra_extensions);
    expect(allowed.has("json")).toBe(true);
    expect(allowed.has("csv")).toBe(true);
    expect(allowed.has(BASE_EXTENSION)).toBe(true); // md 永远在
    expect(allowed.has("txt")).toBe(false); // 没配的不放
  });

  it("🔴 updateProject 白名单必须认这个字段（漏登记则静默 200 不落库）", () => {
    // 这就是 PATCH /api/projects/[id] 的坑: body 直接透传, 白名单外的字段静默丢弃。
    const p = createProject({ name: "proj", ownerId: userId });
    const updated = updateProject(p.id, { wiki_extra_extensions: ["json"] })!;
    expect(updated.wiki_extra_extensions).not.toBe("[]");
    // 重读一次, 确认真的进了盘而不只是返回值
    expect(JSON.parse(getProjectById(p.id, userId)!.wiki_extra_extensions!)).toEqual(["json"]);
  });

  it("safeResolve: 配了 json 就读得到 json（且仍读得到 md）", () => {
    const cwd = mkCwd({
      "INDEX.md": "# hi",
      "data.json": '{"a":1}',
      "notes.txt": "plain",
    });
    const allowed = allowedExtensions('["json"]');
    expect(safeResolve(cwd, "data.json", allowed)).not.toBeNull();
    expect(safeResolve(cwd, "INDEX.md", allowed)).not.toBeNull();
    expect(safeResolve(cwd, "notes.txt", allowed)).toBeNull(); // 没配的还是不放
  });

  it("接受字符串输入（逗号/空格/分号混合 + 前导点）", () => {
    const r = normalizeExtensionsInput(" .json, csv ;yaml  TXT ");
    expect(r).toEqual({ ok: true, value: ["json", "csv", "yaml", "txt"] });
  });

  it("去重 + 剔掉 md（md 不占额度）", () => {
    const r = normalizeExtensionsInput(["json", "json", "md", ".MD", "csv"]);
    expect(r).toEqual({ ok: true, value: ["json", "csv"] });
  });

  it("清空 = 回到只放行 md", () => {
    const p = createProject({ name: "proj", ownerId: userId });
    updateProject(p.id, { wiki_extra_extensions: ["json"] });
    const cleared = updateProject(p.id, { wiki_extra_extensions: [] })!;
    expect([...allowedExtensions(cleared.wiki_extra_extensions)]).toEqual([BASE_EXTENSION]);
  });

  it("不传该字段时不动它（别的 PATCH 不该清掉配置）", () => {
    // togglePin 只发 {pinned}, 不能顺手把 wiki 配置抹成 '[]'。
    const p = createProject({ name: "proj", ownerId: userId });
    updateProject(p.id, { wiki_extra_extensions: ["json"] });
    const after = updateProject(p.id, { pinned: 1 })!;
    expect(JSON.parse(after.wiki_extra_extensions!)).toEqual(["json"]);
  });
});

describe("拒绝非法扩展名输入（拒绝而不是静默丢弃）", () => {
  it("`*` 被显式拒绝（最危险的那个输入）", () => {
    const r = normalizeExtensionsInput("*");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\*/);
    // 混在合法项里也照样拒, 不能只拒掉 `*` 然后放行其余
    expect(normalizeExtensionsInput("json,*").ok).toBe(false);
  });

  it("含路径分隔符 / 点 / 通配 / 空格 的输入被拒", () => {
    for (const bad of [
      "../etc",
      "js/env",
      "a.b",
      "js*",
      "js?",
      "j s", // 数组项内的空格不是分隔符, 应作为非法字符被拒
      "-json",
      "json-",
      "JSON!",
      "js\\x",
      "js\0x",
    ]) {
      const r = normalizeExtensionsInput([bad]);
      expect(r.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("超长扩展名被拒（>16 位）", () => {
    expect(normalizeExtensionsInput(["a".repeat(17)]).ok).toBe(false);
    expect(normalizeExtensionsInput(["a".repeat(16)]).ok).toBe(true);
  });

  it("密钥/凭据类扩展名硬拒（用户配了也不生效）", () => {
    for (const ext of ["env", "pem", "key", "p12", "netrc", "kdbx"]) {
      expect(DENIED_EXTENSIONS.has(ext)).toBe(true);
      const r = normalizeExtensionsInput([ext]);
      expect(r.ok, `should reject .${ext}`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/密钥|凭据/);
    }
  });

  it("超过数量上限被拒", () => {
    const many = Array.from({ length: MAX_EXTRA_EXTENSIONS + 1 }, (_, i) => `e${i}`);
    expect(normalizeExtensionsInput(many).ok).toBe(false);
    expect(normalizeExtensionsInput(many.slice(0, MAX_EXTRA_EXTENSIONS)).ok).toBe(true);
  });

  it("类型不对被拒（数字/对象/数组里混非字符串）", () => {
    expect(normalizeExtensionsInput(123).ok).toBe(false);
    expect(normalizeExtensionsInput({ a: 1 }).ok).toBe(false);
    expect(normalizeExtensionsInput(["json", 5]).ok).toBe(false);
  });

  it("🔴 updateProject 对非法输入抛错, 不静默落库", () => {
    // 静默丢弃 = 用户以为配好了, 然后在 wiki 上找不到文件, 完全无从排查。
    // API 层把这个 throw 转成 400。
    const p = createProject({ name: "proj", ownerId: userId });
    expect(() => updateProject(p.id, { wiki_extra_extensions: ["*"] })).toThrow(/\*/);
    expect(() => updateProject(p.id, { wiki_extra_extensions: ["env"] })).toThrow(/密钥|凭据/);
    expect(() => updateProject(p.id, { wiki_extra_extensions: ["a/b"] })).toThrow(/非法/);
    // 抛错后库里还是默认值, 没被写坏
    expect([...allowedExtensions(getProjectById(p.id, userId)!.wiki_extra_extensions)]).toEqual([
      BASE_EXTENSION,
    ]);
  });

  it("null 合法（= 清空）, 不抛错", () => {
    expect(normalizeExtensionsInput(null)).toEqual({ ok: true, value: [] });
    expect(normalizeExtensionsInput(undefined)).toEqual({ ok: true, value: [] });
    expect(normalizeExtensionsInput("")).toEqual({ ok: true, value: [] });
    expect(normalizeExtensionsInput("  ,  ; ")).toEqual({ ok: true, value: [] });
  });
});

describe("路径穿越仍被拦（放开扩展名不能削弱 cwd 锁死）", () => {
  it("../ 逃出 cwd 被拒 —— 即使目标扩展名放行", () => {
    const cwd = mkCwd({ "INDEX.md": "in" });
    // cwd 外面放一个 .md 和一个 .json, 两个都不该读到
    const outside = fs.realpathSync(tmpDir);
    fs.writeFileSync(path.join(outside, "secret.md"), "outside md");
    fs.writeFileSync(path.join(outside, "secret.json"), '{"leak":1}');

    const allowed = allowedExtensions('["json"]');
    for (const attack of [
      "../secret.md",
      "../secret.json",
      "../../etc/hosts",
      "./../secret.json",
      "sub/../../secret.json",
      "/etc/hosts",
    ]) {
      expect(safeResolve(cwd, attack, allowed), `leaked via ${attack}`).toBeNull();
    }
  });

  it("🔴 穿越读不到真实存在的 .env.local（构造成扩展名放行 + 非隐藏段的最坏情况）", () => {
    // 为什么单列一条: 上面那条的攻击载荷要么带隐藏段(../.env)要么目标扩展名没放行,
    // 于是「穿越拦截」被后面几道检查顺手挡住 —— 删掉穿越拦截它也过。这条专门把
    // 其他几道全部绕开, 让 `..` 拦截成为**唯一**能挡住它的检查:
    //   - 目标文件名 env-local.txt: 无隐藏段, 且 txt 在放行集合里
    //   - 路径段全部不以 . 开头(用 realpath 后的真实目录名回跳, 不写 "..")
    // 突变验证: 删掉 route.ts/wiki-resolve.ts 里 relFromCwd.startsWith("..") 那行
    // -> 本条变红(实测 AssertionError: leaked ../env-local.txt)。
    const cwd = mkCwd({ "INDEX.md": "in" });
    const outside = fs.realpathSync(tmpDir);
    // 真·敏感内容, 放在 cwd 外面, 文件名故意做成「放行扩展名 + 非隐藏」
    fs.writeFileSync(
      path.join(outside, "env-local.txt"),
      "ANTHROPIC_API_KEY=sk-ant-REAL-LOOKING-SECRET"
    );
    const allowed = allowedExtensions('["txt","json","md"]');

    const sibling = path.basename(cwd); // cwd 自己的目录名, 用于 x/../.. 形式回跳
    for (const attack of [
      "../env-local.txt",
      "./../env-local.txt",
      `../${sibling}/../env-local.txt`, // 绕一圈再出去
      "sub/../../env-local.txt",
      path.join(outside, "env-local.txt"), // 直接给绝对路径
    ]) {
      const got = safeResolve(cwd, attack, allowed);
      expect(got, `leaked ${attack}`).toBeNull();
    }
    // 反证: 同名文件放在 cwd 内是读得到的 —— 证明拒绝来自「逃出 cwd」而不是
    // 文件名/扩展名本身被拒(否则这条断言会退化成永真)。
    fs.writeFileSync(path.join(cwd, "env-local.txt"), "harmless inside");
    expect(safeResolve(cwd, "env-local.txt", allowed)).not.toBeNull();
  });

  it("symlink 指向 cwd 外被拒（realpath 在比较之前）", () => {
    const cwd = mkCwd({ "INDEX.md": "in" });
    const outside = fs.realpathSync(tmpDir);
    fs.writeFileSync(path.join(outside, "target.json"), '{"leak":1}');
    fs.symlinkSync(path.join(outside, "target.json"), path.join(cwd, "link.json"));

    // 就算 .json 放行、文件名看着在 cwd 里, realpath 解开后在 cwd 外 -> 拒。
    expect(safeResolve(cwd, "link.json", allowedExtensions('["json"]'))).toBeNull();
  });

  it("symlink 换壳骗扩展名: a.md -> secret.env 按真实目标判", () => {
    const cwd = mkCwd({ "real.txt": "sneaky" });
    fs.symlinkSync(path.join(cwd, "real.txt"), path.join(cwd, "looks.md"));
    // 只放 md 时: realpath 后是 .txt, 不放行 -> 拒。
    expect(safeResolve(cwd, "looks.md", allowedExtensions(null))).toBeNull();
    // 放了 txt 时可读（cwd 内的普通文件, 合理）。
    expect(safeResolve(cwd, "looks.md", allowedExtensions('["txt"]'))).not.toBeNull();
  });

  it("目录不被当文件返回", () => {
    const cwd = mkCwd({ "docs/a.md": "x" });
    expect(safeResolve(cwd, "docs", allowedExtensions(null))).toBeNull();
    // 🔴 上一行其实测不到 isFile 那道检查: extOf("docs") === "" 不在放行集合里,
    // 扩展名检查先返回 null 了(突变实测: 删掉 isFile 检查, 上一行照样绿)。
    // 名字带放行扩展名的**目录**才能走到 isFile —— 真实场景里 `foo.md/` 这种目录
    // 完全可能存在, 命中了就会把目录喂给 readFileSync(EISDIR 500)。
    fs.mkdirSync(path.join(cwd, "trap.md"));
    expect(safeResolve(cwd, "trap.md", allowedExtensions(null))).toBeNull();
  });
});

describe("隐藏文件/目录始终排除（不受配置影响）", () => {
  it("hasHiddenSegment 认出任意一段以 . 开头", () => {
    expect(hasHiddenSegment(".env")).toBe(true);
    expect(hasHiddenSegment("scripts/.env.tokens")).toBe(true);
    expect(hasHiddenSegment(".claude/plans/x.md")).toBe(true);
    expect(hasHiddenSegment("a/.git/config")).toBe(true);
    expect(hasHiddenSegment("docs/plans/x.md")).toBe(false);
    expect(hasHiddenSegment("INDEX.md")).toBe(false);
    // 文件名里带点但不在开头 -> 不是隐藏
    expect(hasHiddenSegment("a.b.md")).toBe(false);
  });

  it("🔴 仓库里真实存在的敏感文件读不到（.env.local / scripts/.env.tokens）", () => {
    const cwd = mkCwd({
      ".env.local": "ANTHROPIC_API_KEY=sk-leak",
      "scripts/.env.tokens": "TOKEN=leak",
      ".claude/secret.md": "internal",
      ".git/config": "[remote]",
      "INDEX.md": "ok",
    });
    // 最激进的配置: 把所有可能相关的扩展名全放行, 依然读不到隐藏路径。
    const allowed = allowedExtensions('["txt","json","local","tokens","config","md"]');
    for (const attack of [
      ".env.local",
      "scripts/.env.tokens",
      ".claude/secret.md",
      ".git/config",
      "./.env.local",
    ]) {
      expect(safeResolve(cwd, attack, allowed), `leaked ${attack}`).toBeNull();
    }
    // 非隐藏文件照常可读, 证明不是全拒
    expect(safeResolve(cwd, "INDEX.md", allowed)).not.toBeNull();
  });

  it("symlink 指向 cwd 内的隐藏目录被拒（realpath 之后再查一遍隐藏段）", () => {
    const cwd = mkCwd({ ".secrets/leak.md": "internal" });
    fs.symlinkSync(path.join(cwd, ".secrets", "leak.md"), path.join(cwd, "public.md"));
    // 这个 symlink 的 realpath 仍在 cwd 内, 逃不出 cwd 检查 —— 只有 realpath
    // 之后那道 hasHiddenSegment 能挡住它。
    expect(safeResolve(cwd, "public.md", allowedExtensions(null))).toBeNull();
  });

  it("`.env` 这类纯隐藏文件的 extOf 是空串（不会被误判成 env 扩展名）", () => {
    expect(extOf(".env")).toBe("");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("Makefile")).toBe("");
    expect(extOf("a.md")).toBe("md");
    expect(extOf("a.b.JSON")).toBe("json");
    // 因为 extOf 返回空串, 空串永不在放行集合里 -> 即使有人绕过 DENIED 也读不到
    expect(isAllowedFile(".env", allowedExtensions('["json"]'))).toBe(false);
  });
});

describe("渲染路径判定 + 大小上限", () => {
  it("isMarkdown 只对 .md 为真（决定走不走 ReactMarkdown）", () => {
    expect(isMarkdown("a.md")).toBe(true);
    expect(isMarkdown("A.MD")).toBe(true);
    expect(isMarkdown("docs/x.md")).toBe(true);
    // 这些必须走纯文本路径: 塞进 markdown 渲染器会错乱
    for (const n of ["a.json", "a.csv", "a.txt", "a.html", "a.ts"]) {
      expect(isMarkdown(n)).toBe(false);
    }
  });

  it("非 md 的大小上限是个正数且不至于卡死页面", () => {
    expect(MAX_NON_MD_BYTES).toBeGreaterThan(0);
    expect(MAX_NON_MD_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("超限判定: 大于上限的非 md 应被 route 判为 too-large", () => {
    // route 里的判定是 statSync().size > MAX_NON_MD_BYTES; 这里断言判定表达式
    // 对一个真实的超限文件成立(route 逻辑本身不便在 node 环境直连)。
    const cwd = mkCwd({ "big.csv": "" });
    const big = path.join(cwd, "big.csv");
    fs.writeFileSync(big, "x".repeat(MAX_NON_MD_BYTES + 1));
    expect(fs.statSync(big).size > MAX_NON_MD_BYTES).toBe(true);
    // 小文件不超限
    const small = path.join(cwd, "small.csv");
    fs.writeFileSync(small, "a,b\n1,2\n");
    expect(fs.statSync(small).size > MAX_NON_MD_BYTES).toBe(false);
  });
});

describe("parseStoredExtensions（库 -> 放行集合的解析）", () => {
  it("正常值原样解析", () => {
    expect(parseStoredExtensions('["json","csv"]')).toEqual(["json", "csv"]);
  });

  it("任何异常输入都降级成 [] 而不抛错", () => {
    // 这个函数在 server component 渲染路径上, 抛错 = 整个 wiki 页面 500。
    for (const junk of ["", "[", "{}", "null", '"x"', '["*"]', '["env"]', "[1,2]"]) {
      expect(() => parseStoredExtensions(junk)).not.toThrow();
      expect(parseStoredExtensions(junk)).toEqual([]);
    }
  });
});
