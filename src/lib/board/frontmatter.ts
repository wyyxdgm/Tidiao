// Board 文件 frontmatter 解析 (R61 / P0).
//
// 功能: 把 boards/*.md 的 frontmatter 解析成结构化的 BoardConfig.
// 关注点:
//  - frontmatter 是 YAML, 正文是原始 HTML (D2 拍板 —— AI 写完整 HTML, 不限 DSL).
//  - sources[] 描述数据源: name 唯一, kind ∈ {api, sql}, 各自有不同字段.
//  - refresh: 时间间隔字符串 ("30s"/"5m"/"1h") 或 "sse" 走增量流; 非法值降级为 30s.
//  - layout: 可选, 给宿主 / iframe 路由判别 ('page' | 'panel'); 不写默认 'page'.
//  - 与 wiki 共用 yaml 包, 但解析路径独立 (board frontmatter 没有 links / title).

import YAML from "yaml";

export type SourceKind = "api" | "sql";

export interface ApiSource {
  name: string;
  kind: "api";
  path: string; // 例如 "/api/projects", 相对于平台根.
  /** 可选 query string, 直接拼到 path 后面. 留空 = 不拼. */
  query?: Record<string, string>;
}

export interface SqlSource {
  name: string;
  kind: "sql";
  query: string; // 单条 SELECT, 已在执行器侧强校验 (SELECT-only + no semicolons).
}

export type Source = ApiSource | SqlSource;

export interface BoardConfig {
  title: string;
  refresh: { kind: "interval"; seconds: number } | { kind: "sse" } | { kind: "manual" };
  sources: Source[];
  layout: "page" | "panel";
}

export interface ParsedBoardFile {
  config: BoardConfig;
  body: string; // 原始 HTML (D2: AI 直接写完整 HTML, 宿主用 iframe sandbox 隔离).
}

// 功能: 把 "30s"/"5m"/"1h"/"45" 解析成秒数. 非法输入返回 null (调用方降级).
// 关注点: 用 ^(\d+)\s*([smh])?$ 一次性匹配, 单位缺省按秒; 与前端 API 风格保持一致.
export function parseIntervalSeconds(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d+)\s*([smh])?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return n * mult;
}

// 功能: 把单个 source 节点解析成 Source. 不合法返回 null (调用方决定是否丢弃).
function parseSource(raw: unknown): Source | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null; // name 必填, 留给 __DATA__ 做 key
  if (obj.kind === "api") {
    const path = typeof obj.path === "string" ? obj.path.trim() : "";
    if (!path.startsWith("/")) return null; // 必须是绝对路径, 防被解析成相对 cwd
    let query: Record<string, string> | undefined;
    if (obj.query && typeof obj.query === "object") {
      query = {};
      for (const [k, v] of Object.entries(obj.query as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          query[k] = String(v);
        }
      }
    }
    return { name, kind: "api", path, query };
  }
  if (obj.kind === "sql") {
    const query = typeof obj.query === "string" ? obj.query.trim() : "";
    if (!query) return null;
    return { name, kind: "sql", query };
  }
  return null;
}

// 功能: 解析 board frontmatter + 分离正文. 失败时给最小可用 config, 不抛异常.
// 关注点:
//  - 整个解析做宽容降级 —— frontmatter 不存在 / 解析失败 / sources 空 → 仍返回 config
//    (sources=[]). 这样 UI 能渲染「空看板 + 提示」，而不是 502.
//  - sources 同名 / kind 不识别 → 静默丢弃 (写日志的位置留给调用方).
//  - 不做 SQL 安全校验 (那是执行器职责). 这里只看 schema.
export function parseBoardFile(content: string): ParsedBoardFile {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[2] : content;

  if (!fmMatch) {
    return {
      config: { title: "Untitled Board", refresh: { kind: "interval", seconds: 30 }, sources: [], layout: "page" },
      body,
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(fmMatch[1]);
  } catch {
    return {
      config: { title: "Untitled Board", refresh: { kind: "interval", seconds: 30 }, sources: [], layout: "page" },
      body,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      config: { title: "Untitled Board", refresh: { kind: "interval", seconds: 30 }, sources: [], layout: "page" },
      body,
    };
  }
  const obj = parsed as Record<string, unknown>;

  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "Untitled Board";

  let refresh: BoardConfig["refresh"];
  if (obj.refresh === "sse") {
    refresh = { kind: "sse" };
  } else if (obj.refresh === "manual" || obj.refresh === "off" || obj.refresh === false) {
    refresh = { kind: "manual" };
  } else {
    const sec = parseIntervalSeconds(obj.refresh);
    // 兜底: 缺省 30s, 最小 10s (冷启动源 §5.4: 26 项目 × 多 board 会打爆调度器)
    const finalSec = sec === null || sec < 10 ? 30 : sec;
    refresh = { kind: "interval", seconds: finalSec };
  }

  const sources: Source[] = [];
  if (Array.isArray(obj.sources)) {
    const seen = new Set<string>();
    for (const raw of obj.sources) {
      const s = parseSource(raw);
      if (!s) continue;
      if (seen.has(s.name)) continue; // 同名静默丢弃, 不阻断整个 board
      seen.add(s.name);
      sources.push(s);
    }
  }

  const layout: BoardConfig["layout"] = obj.layout === "panel" ? "panel" : "page";

  return { config: { title, refresh, sources, layout }, body };
}
