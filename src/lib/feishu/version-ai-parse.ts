// v513 (飞书 R172): 新建版本弹窗「AI 解析输入」的解析核心.
//
// 用途: 用户往弹窗里粘一段自由文本（项目 URL / 飞书 sheet URL / sheet 名或 id /
//   版本用途描述…）, 这里把它解析成新版本表单的建议值 {name, description,
//   feishu_url, feishu_sheet}. 分两层:
//     1. 确定性解析 (纯函数, 可单测): 抽 URL + sheet id/name 兼容匹配
//     2. LLM 解析 (runSingleTurnLlm): 剩余字段生成 (name 语义化 / description /
//        从候选 sheet 里挑正确的)
//
// sheet id/name 兼容口径 (需求原文「实际都转成 name」): feishu_sheet 落库永远是
//   sheet name; 用户给 id 时查 workbook-info 映射回 name, 查不到再让 LLM 从候选挑.

import { runSingleTurnLlm } from "../runtime/llm-summarize";
import { resolveLlmConfig } from "../db/llm-configs";
import { runLarkCli } from "./lark-cli";
import { normalizeSheetUrl } from "./url";

/** 从文本里抽出的飞书 URL 信息 (normalizeSheetUrl 结果 + 原始串). */
export interface ExtractedUrl {
  raw: string;
  wikiUrl: string;
  sheetIdFromQuery: string | null;
}

/** 抽 URL 的正则 — http(s) 开头, 排除空白 + 常见中文标点 (URL 常紧贴中文逗号句号). */
const URL_RE = /https?:\/\/[^\s，,；;。．）)】\]》"']+/g;

/** 功能: 从自由文本抽所有疑似飞书 URL. 纯函数. */
export function extractFeishuUrls(text: string): ExtractedUrl[] {
  const out: ExtractedUrl[] = [];
  for (const token of text.match(URL_RE) ?? []) {
    // 去掉常见的贴贴尾巴 (中文标点 / 括号)
    const cleaned = token.replace(/[,，;；)）》\]]+$/, "");
    try {
      const n = normalizeSheetUrl(cleaned);
      if (!n.wikiUrl || !/feishu\.cn|larksuite\.com/.test(n.wikiUrl)) continue;
      out.push({ raw: cleaned, wikiUrl: n.wikiUrl, sheetIdFromQuery: n.sheetIdFromQuery });
    } catch {
      // 非法 URL → 跳过, 交给 LLM 兜底
    }
  }
  return out;
}

/** workbook-info 返回的子表元数据 (只取用到的字段). */
export interface SheetMeta {
  sheet_id: string;
  title: string;
  index: number;
  is_hidden?: boolean;
}

/** 功能: sheet id 或 name → 统一转 name. 纯函数 (匹配逻辑), 元数据 caller 查好传入. */
export function matchSheetToName(
  idOrName: string,
  sheets: SheetMeta[],
): string | null {
  const q = idOrName.trim();
  if (!q) return null;
  const byId = sheets.find((s) => s.sheet_id === q);
  if (byId) return byId.title;
  const byName = sheets.find((s) => s.title === q);
  if (byName) return byName.title;
  // 模糊: name 前缀匹配 (用户只写了 tab 名一部分)
  const fuzzy = sheets.find((s) => s.title.startsWith(q));
  return fuzzy ? fuzzy.title : null;
}

/** 功能: 调 lark-cli +workbook-info 拿一张表的所有子表元数据. 失败返 null (不阻断). */
export async function fetchSheetMetas(wikiUrl: string): Promise<SheetMeta[] | null> {
  try {
    const stdout = await runLarkCli(["sheets", "+workbook-info", "--url", wikiUrl]);
    const parsed = JSON.parse(stdout) as { ok?: boolean; data?: { sheets?: SheetMeta[] } };
    return parsed?.data?.sheets ?? null;
  } catch {
    return null;
  }
}

/** AI 解析产出的建议值. `source` 标注每个字段怎么来的, 前端据此显示徽标. */
export interface VersionSuggestion {
  name: string | null;
  description: string | null;
  feishu_url: string | null;
  feishu_sheet: string | null;
  sources: {
    name: "ai" | "none";
    description: "ai" | "none";
    feishu_url: "text" | "none";
    feishu_sheet: "id-mapped" | "ai" | "none";
  };
}

export interface AiParseContext {
  projectName: string;
  projectCwd: string | null;
  /** 同项目现有版本 (name + description), 供 LLM 排重 / 起名对齐风格. */
  existingVersions: Array<{ name: string; description: string | null }>;
  userText: string;
  /** 从 text 抽到并查好元数据的表 (0 或 1 张, 取第一张飞书 URL). */
  url: ExtractedUrl | null;
  sheets: SheetMeta[] | null;
  /** id→name 确定性映射结果 (text 里给了 sheet id 且查到了). */
  idMappedSheetName: string | null;
}

/** 功能: 构造 LLM 解析的 system prompt. 纯函数. */
export function buildParseSystemPrompt(): string {
  return [
    "你是版本配置解析器。用户会粘贴一段与「新建版本」相关的自由文本, 你把它解析成 JSON 表单值。",
    "只输出 JSON 对象, 不输出任何其他文字或代码块标记。字段:",
    '- "name": 版本名, 简短 (如 v1.7); 若文本无法推断则 null',
    '- "description": 版本用途一句话说明 (「版本干啥的」, ≤100字); 无法推断则 null',
    '- "feishu_sheet": 若上下文给了候选 sheet 列表, 从中选出文本指向的那个的 title; 候选只有一个时直接用它; 没有候选且文本没提 sheet 则 null',
    "规则: 保守——文本里没有明确依据的字段一律 null, 不要编造。",
  ].join("\n");
}

/** 功能: 构造 LLM 解析的 user prompt (拼上下文). 纯函数. */
export function buildParseUserPrompt(ctx: AiParseContext): string {
  const lines: string[] = [];
  lines.push(`所属项目: ${ctx.projectName}`);
  if (ctx.projectCwd) lines.push(`项目 cwd: ${ctx.projectCwd}`);
  if (ctx.existingVersions.length) {
    lines.push(
      `现有版本: ${ctx.existingVersions.map((v) => `${v.name}${v.description ? `(${v.description})` : ""}`).join("; ")}`,
    );
  }
  if (ctx.url) lines.push(`文本中的飞书 URL: ${ctx.url.wikiUrl}`);
  if (ctx.sheets?.length) {
    lines.push(
      `候选 sheet (id<TAB>title): ${ctx.sheets.map((s) => `${s.sheet_id}\t${s.title}`).join("; ")}`,
    );
  }
  if (ctx.idMappedSheetName) {
    lines.push(`(已确定) sheet id 已映射为 name: ${ctx.idMappedSheetName}`);
  }
  lines.push("--- 用户文本 ---");
  lines.push(ctx.userText.slice(0, 2000));
  return lines.join("\n");
}

/** 功能: 从 LLM 输出抽 JSON (容忍 ```json 代码块 / 前后杂文字). 纯函数. */
export function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const MAX_TEXT_CHARS = 2000;

/** 功能: 端到端解析 — 确定性层 + LLM 层. LLM 失败返 null (caller 回退到纯确定性结果). */
export async function parseVersionInput(opts: {
  projectName: string;
  projectCwd: string | null;
  existingVersions: Array<{ name: string; description: string | null }>;
  userText: string;
  userId: string;
  projectId: string;
}): Promise<{ suggestion: VersionSuggestion; llmFailed: boolean }> {
  const userText = opts.userText.slice(0, MAX_TEXT_CHARS);
  const urls = extractFeishuUrls(userText);
  const url = urls[0] ?? null;

  let sheets: SheetMeta[] | null = null;
  if (url) sheets = await fetchSheetMetas(url.wikiUrl);

  // 确定性: sheet id / name 兼容 → 都转 name
  let idMappedSheetName: string | null = null;
  if (url?.sheetIdFromQuery && sheets) {
    idMappedSheetName = matchSheetToName(url.sheetIdFromQuery, sheets);
  }

  const suggestion: VersionSuggestion = {
    name: null,
    description: null,
    feishu_url: url?.wikiUrl ?? null,
    feishu_sheet: idMappedSheetName,
    sources: {
      name: "none",
      description: "none",
      feishu_url: url ? "text" : "none",
      feishu_sheet: idMappedSheetName ? "id-mapped" : "none",
    },
  };

  // LLM 层: 解析 name / description / 挑 sheet
  const config = resolveLlmConfig({
    model: null,
    owner_id: opts.userId,
    project_id: opts.projectId,
    llm_config_id: null,
  });
  if (!config.api_key || !config.model) {
    return { suggestion, llmFailed: true };
  }

  const ctx: AiParseContext = {
    projectName: opts.projectName,
    projectCwd: opts.projectCwd,
    existingVersions: opts.existingVersions,
    userText,
    url,
    sheets,
    idMappedSheetName,
  };

  const envOverrides: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: config.api_key,
  };
  if (config.base_url) envOverrides.ANTHROPIC_BASE_URL = config.base_url;
  if (config.model) envOverrides.ANTHROPIC_MODEL = config.model;

  const resultText = await runSingleTurnLlm(
    buildParseSystemPrompt(),
    buildParseUserPrompt(ctx),
    config.model,
    envOverrides,
  );
  if (!resultText) return { suggestion, llmFailed: true };

  const json = extractJson(resultText);
  if (!json) return { suggestion, llmFailed: true };

  const asStr = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const aiName = asStr(json.name);
  const aiDesc = asStr(json.description);
  const aiSheet = asStr(json.feishu_sheet);

  if (aiName) {
    suggestion.name = aiName.slice(0, 80);
    suggestion.sources.name = "ai";
  }
  if (aiDesc) {
    suggestion.description = aiDesc.slice(0, 500);
    suggestion.sources.description = "ai";
  }
  // sheet: LLM 挑的 title 必须在候选列表里 (防编造); 确定性映射优先.
  if (!suggestion.feishu_sheet && aiSheet && sheets) {
    const hit = sheets.find((s) => s.title === aiSheet);
    if (hit) {
      suggestion.feishu_sheet = hit.title;
      suggestion.sources.feishu_sheet = "ai";
    }
  }
  return { suggestion, llmFailed: false };
}
