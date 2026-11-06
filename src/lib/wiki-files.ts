// Wiki 可读文件类型的白名单校验与解析（v35 `projects.wiki_extra_extensions`）。
//
// 为什么单独一个纯函数模块: 两个 wiki route(tree + 正文)、updateProject 的白名单
// 校验、以及前端的相对链接拦截都要用同一套判定。任何一处判定和别处不一致 = 要么
// 树里看得见但点开 404, 要么反过来。同 requirement-id.ts 的理由: 这里**不许**引
// node:fs / child_process, 前端会 import 它。
//
// 🔴 安全底线(改这个文件前先读):
//  1. 只接受 /^[a-z0-9]{1,16}$/ 形式的扩展名。`*` / 空串 / 含 `.` `/` 的输入一律
//     拒绝 —— 「空 = 全放行」会把 .env、id_rsa、token 文件直接暴露到 wiki 页面。
//  2. DENIED_EXTENSIONS 是硬拦截, 用户配了也不生效(直接报错)。
//  3. 隐藏文件/目录(. 开头)由 hasHiddenSegment 一律排除, **不受本配置影响**。
//  4. md 永远在放行集合里; 配置为空/NULL/垃圾数据时放行集合恰好 = {md}, 也就是
//     未配置项目的行为与本特性上线前完全一致。

/** 永远放行的扩展名。默认(未配置)项目的放行集合就只有它。 */
export const BASE_EXTENSION = "md";

/** 一个项目最多能配多少个额外扩展名。防止有人贴一整张 mime 表进来。 */
export const MAX_EXTRA_EXTENSIONS = 20;

/** 单个扩展名的形状: 纯小写字母数字, 1-16 位。 */
const EXT_PATTERN = /^[a-z0-9]{1,16}$/;

/**
 * 硬拒绝的扩展名 —— 密钥/凭据类。用户就算手填也不放行(报错, 不静默丢弃)。
 * 注意这不是安全的主防线(主防线是白名单 + 隐藏文件排除), 是防手滑的第二道闸。
 */
export const DENIED_EXTENSIONS = new Set([
  "env",
  "pem",
  "key",
  "p12",
  "pfx",
  "keystore",
  "jks",
  "ppk",
  "asc",
  "gpg",
  "kdbx",
  "netrc",
  "htpasswd",
  "cer",
  "der",
  "crt",
]);

/** 前端下拉里给的常见候选。不是限制 —— 用户可自己填别的。 */
export const SUGGESTED_EXTENSIONS = [
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "toml",
  "ini",
  "sql",
  "sh",
  "ts",
  "tsx",
  "js",
  "py",
  "log",
];

/**
 * 非 md 文件的单文件大小上限(字节)。
 *
 * 为什么只卡非 md: readFileSync 无上限, 放开 .json/.csv 后很容易读到几十 MB 的
 * 导出数据 —— 服务端一次性读进内存 + JSON 序列化 + 浏览器渲染成一个巨大 <pre>,
 * 页面直接卡死。md 保持无上限是为了「未配置项目行为零变化」这条硬要求。
 */
export const MAX_NON_MD_BYTES = 1024 * 1024; // 1 MiB

export type NormalizeResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

/**
 * 功能: 把用户输入(数组 或 逗号/空格分隔的字符串)规范化成合法的额外扩展名数组。
 *       返回的数组已去掉 md、去重、小写、按输入顺序保留。
 * 关注点:
 *  - 校验失败**返回错误而不是静默丢弃**: 静默丢弃会让用户以为配好了, 然后在 wiki
 *    上找不到文件, 无从排查。
 *  - null / undefined / [] / "" 都合法, 表示「清空配置」-> 回到只放行 md。
 *  - 显式拒绝 `*`, 因为它是最容易被当成「全放行」写进来的东西。
 */
export function normalizeExtensionsInput(raw: unknown): NormalizeResult {
  if (raw === null || raw === undefined) return { ok: true, value: [] };

  let parts: string[];
  if (Array.isArray(raw)) {
    if (raw.some((x) => typeof x !== "string")) {
      return { ok: false, error: "扩展名列表里含非字符串项" };
    }
    parts = raw as string[];
  } else if (typeof raw === "string") {
    parts = raw.split(/[,\s;]+/);
  } else {
    return { ok: false, error: "扩展名配置必须是字符串或字符串数组" };
  }

  const out: string[] = [];
  for (const p of parts) {
    // 去掉前导点 (".json" 和 "json" 都接受) 后再校验。
    const ext = p.trim().replace(/^\.+/, "").toLowerCase();
    if (ext === "") continue; // 分隔符产生的空段, 跳过不算错
    if (ext === "*") {
      return { ok: false, error: "不允许 `*`(放行一切) —— 必须逐个列出扩展名" };
    }
    if (!EXT_PATTERN.test(ext)) {
      return {
        ok: false,
        error: `非法扩展名 ${JSON.stringify(p)}：只允许小写字母和数字，1-16 位`,
      };
    }
    if (DENIED_EXTENSIONS.has(ext)) {
      return { ok: false, error: `扩展名 ${ext} 属密钥/凭据类，禁止放行到 wiki` };
    }
    if (ext === BASE_EXTENSION) continue; // md 本来就放行, 不占额度
    if (!out.includes(ext)) out.push(ext);
  }

  if (out.length > MAX_EXTRA_EXTENSIONS) {
    return {
      ok: false,
      error: `最多 ${MAX_EXTRA_EXTENSIONS} 个额外扩展名，当前 ${out.length} 个`,
    };
  }
  return { ok: true, value: out };
}

/**
 * 功能: 读库里存的 JSON 串, 返回额外扩展名数组。
 * 关注点: **宽容**, 任何解析失败/脏数据都降级成 [] (= 只放行 md), 绝不抛异常也
 *        绝不放宽。库里的值有可能是手工 SQL 写进去的, 这里必须再过一遍校验。
 */
export function parseStoredExtensions(stored: string | null | undefined): string[] {
  if (!stored) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const r = normalizeExtensionsInput(parsed);
  return r.ok ? r.value : [];
}

/**
 * 功能: 得到该项目 wiki 的放行扩展名集合。永远含 md。
 * 关注点: 这是唯一的判定入口 —— tree route 和正文 route 都必须走它, 否则两边会漂移。
 */
export function allowedExtensions(stored: string | null | undefined): Set<string> {
  return new Set([BASE_EXTENSION, ...parseStoredExtensions(stored)]);
}

/** 功能: 取小写扩展名(不含点)。无扩展名返回 ""。 */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  // i <= 0 覆盖两种情况: 没有点, 以及 ".env" 这种纯隐藏文件(点在 0 位)。
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

/** 功能: 文件名的扩展名是否在放行集合内。 */
export function isAllowedFile(name: string, allowed: Set<string>): boolean {
  return allowed.has(extOf(name));
}

/**
 * 功能: 判断 realpath 后的绝对路径是否仍在 cwd 之内。true = 安全。
 * 关注点:
 *  - 🔴 这是 cwd 锁死防线本身, 独立成函数只为可被单独测试。**调用方必须先
 *    realpathSync 再传进来**, 否则 symlink 能绕过。
 *  - 传入的 relFromCwd 必须来自 path.relative(cwdReal, fullReal)。
 *  - 注意别指望 hasHiddenSegment 顺手挡住穿越: 它对 "../x" 恰好也返回 true
 *    (".." 以 "." 开头), 这是巧合不是设计。两道检查各自独立, 都不能删。
 *  - 🔴 这个巧合有代价(2026-08-11 突变测试实测): 因为 hasHiddenSegment 会先把
 *    含 ".." 的载荷拦掉, 单独删除穿越拦截那一行时**测试全绿** —— 穿越断言无法
 *    单独杀死这个突变。要验证穿越防线本身, 必须先让 hasHiddenSegment 不把 ".."
 *    当隐藏段(去遮蔽), 再删穿越拦截, 那时断言才变红。别据此以为穿越拦截是死代码:
 *    它是唯一挡住「realpath 解开 symlink 后逃出 cwd」的检查(该场景 rel 里没有
 *    ".." 字样, 第一道 hasHiddenSegment 根本看不见)。
 */
export function isInsideCwd(relFromCwd: string): boolean {
  if (relFromCwd === "") return false; // cwd 自己不是文件
  const posix = relFromCwd.split("\\").join("/");
  if (posix === ".." || posix.startsWith("../")) return false;
  // 绝对路径意味着 path.relative 无法表达相对关系(如跨盘符), 一律拒。
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) return false;
  return true;
}

/**
 * 功能: 判断 posix 相对路径里是否有任何一段以 "." 开头(隐藏文件或隐藏目录)。
 * 关注点: 这条**不受项目配置影响**, 是硬排除。tree 扫描本来就跳过隐藏目录, 但正文
 *        route 之前只靠「必须 .md」间接挡住了 `?path=.claude/x.md` 这类直连,
 *        放开扩展名后必须显式挡。也顺手挡住了 scripts/.env.tokens。
 */
export function hasHiddenSegment(relPosix: string): boolean {
  return relPosix.split("/").some((seg) => seg.startsWith("."));
}

/** 功能: 该文件是否走 markdown 渲染(否则走纯文本/代码块渲染)。 */
export function isMarkdown(nameOrPath: string): boolean {
  return extOf(nameOrPath) === BASE_EXTENSION;
}

/**
 * 功能: 已知扩展名 → 浏览器友好的 Content-Type, 给 wiki 文件下载(route ?download=1)用。
 *       缺省 `application/octet-stream` —— 浏览器照样会下载, 只是不尝试用具体应用打开。
 * 关注点:
 *  - 只覆盖 SUGGESTED_EXTENSIONS 里的常见类型 + md; 任何自定义扩展名(用户在 wiki_extra_extensions
 *    里加的怪类型)走 octet-stream, 安全且不假装懂。
 *  - 文本类全带 charset=utf-8, 与 wiki 正文 JSON 渲染路径一致。
 *  - 不引 node:fs, 保持前端可 import(投影.client 可能也会展示图标→类型提示)。
 */
export function contentTypeFor(ext: string): string {
  const map: Record<string, string> = {
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    yaml: "application/yaml; charset=utf-8",
    yml: "application/yaml; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    ini: "text/plain; charset=utf-8",
    sql: "text/plain; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8",
    ts: "text/typescript; charset=utf-8",
    tsx: "text/typescript; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    py: "text/x-python; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}
