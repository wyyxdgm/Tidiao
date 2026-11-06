// R195 (damo 1005 飞书): 总控制台「AI 全局归纳」— 不只是按状态分紧急重要,
// 而是 AI 结合项目真实业务文档 (CLAUDE.md 等 agent 环境都会加载到的文档) +
// 现有任务数据 (标题/上下文/处理情况), 全部先给出建议, 再归纳分类:
// 修复什么 / 设计什么 / 交付什么 / 迭代什么 / 哪些要选方案 —— 一目了然.
//
// 复用 runSingleTurnLlm (llm-summarize.ts) 单次调用模式 (同 card-summary-llm.ts):
// allowedTools=[] / maxTurns=1 / 失败返 null 不 throw / 配置链走 resolveLlmConfig
// (project 维度: model=null 走项目/owner/全局链). 缓存进 app_settings KV
// (console_digest:<projectId>, 带 fingerprint — 任务集 id/status/updated_at 没
// 变就直接吃缓存, 一个项目一轮只花一次 LLM 成本 ≈ $0.01).

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { resolveLlmConfig } from "../db/llm-configs";
import { runSingleTurnLlm } from "./llm-summarize";
import type { Task } from "../db/tasks";

/** 缓存键前缀 (app_settings), 完整键 = console_digest:<projectId>. */
export const DIGEST_CACHE_PREFIX = "console_digest:";

/** 固定 6 类工作类型 — UI chips 按 MODULE 顺序渲染, LLM 只能从中选. */
export const DIGEST_CATEGORIES = [
  "fix",
  "design",
  "delivery",
  "iterate",
  "decision",
  "other",
] as const;
export type DigestCategory = (typeof DIGEST_CATEGORIES)[number];

// 终态惰性集合 (R204, damo 2026-10-06): completed/cancelled 已经了结, 不需要
// 继续处理任何问题. LLM 口径: 只许归 delivery (已交付展示), 其余分类的条目在
// 解析端直接丢弃 — 否则一键同意会经 terminal auto-resume 把终态任务拉起重跑
// (实证事故: 任务 384e9e1e completed 后被「✓ 同意」重新唤醒). 前端镜像:
// spa/src/lib/console/digest-model.ts 的 DIGEST_INERT_STATUSES, 两处必须同步.
export const DIGEST_INERT_STATUSES: readonly string[] = ["completed", "cancelled"];

export interface DigestItem {
  id: string; // task id
  category: DigestCategory;
  urgency: "high" | "mid" | "low";
  suggestion: string; // ≤48 字下一步建议 (面向 damo 的大白话)
  need_owner: boolean; // true = 需要 damo 拍板/同意与否
}

export interface ConsoleDigest {
  headline: string; // ≤40 字系统状态一句话
  items: DigestItem[]; // 每个活跃任务一条
}

export interface ConsoleDigestResult {
  digest: ConsoleDigest | null; // null = LLM 失败 (caller 返回 failed, 不写缓存)
  model: string;
}

const MAX_HEADLINE_CHARS = 60;
const MAX_SUGGESTION_CHARS = 80;
/** 活跃任务上限 (防 prompt 爆炸; 50 任务 ≈ 6k token 输入, 单次成本可控). */
const MAX_TASK_LINES = 50;
const MAX_TASK_LINE_CHARS = 160;
const MAX_RESULT_CHARS = 200; // 非终态任务附 result 头, agent 汇报是「处理情况」权威源

/* ---------------- 项目业务文档上下文 ---------------- */

// agent 环境都会加载到的文档 = 项目 cwd 的 CLAUDE.md (主) + INDEX.md (wiki 入口)
// + docs/plans/README.md (进行中任务索引). 各自带 clip, 总量 ≤ ~5k 字.
const CONTEXT_FILES: Array<{ rel: string; clip: number; label: string }> = [
  { rel: "CLAUDE.md", clip: 3000, label: "项目说明 (CLAUDE.md)" },
  { rel: "INDEX.md", clip: 600, label: "Wiki 入口 (INDEX.md)" },
  { rel: "docs/plans/README.md", clip: 1000, label: "进行中任务索引" },
];

// 功能: 读项目 cwd 下的业务文档, 拼成带标题的上下文块.
// 关注点: cwd 为空 / 文件不存在 / 读失败都静默跳过 (单文件失败不拖垮整体);
// 总量靠各文件 clip 控制, 防 prompt 爆炸.
export function collectProjectContext(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const blocks: string[] = [];
  for (const f of CONTEXT_FILES) {
    try {
      const raw = fs.readFileSync(path.join(cwd, f.rel), "utf-8");
      const text = raw.trim();
      if (!text) continue;
      blocks.push(`【${f.label}】\n${text.slice(0, f.clip)}`);
    } catch {
      // 文件不存在 / 无权限 → 跳过
    }
  }
  return blocks.join("\n\n");
}

/* ---------------- 任务清单行 ---------------- */

const ACTIVE_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "reviewing",
  "paused",
  "await_user",
]);

// 功能: 任务数组 → LLM 可读的清单行 (每行一条, 活跃优先, 截 MAX_TASK_LINES).
// 关注点: 非终态全量 + completed 只留 14 天内 (交付物归纳要新鲜); 行内
// id 必须原样保留 — 解析端靠 id 对账过滤模型幻觉.
export function buildTaskLines(tasks: Task[], now = Date.now()): string[] {
  const sorted = [...tasks].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 1 : 0;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });
  const lines: string[] = [];
  for (const t of sorted) {
    if (lines.length >= MAX_TASK_LINES) break;
    if (!ACTIVE_STATUSES.has(t.status)) {
      // 终态只留 14 天内 (交付/完成归纳)
      const age = now - new Date(t.updated_at || 0).getTime();
      if (!Number.isFinite(age) || age > 14 * 24 * 3600 * 1000) continue;
    }
    const parts = [
      `id=${t.id}`,
      `状态=${t.status}`,
      `优先级=${t.priority ?? 0}`,
      `标题=${(t.title || "(无)").slice(0, 100)}`,
    ];
    const result = (t.result || "").trim();
    if (result) parts.push(`最近汇报=${result.slice(0, MAX_RESULT_CHARS)}`);
    const line = parts.join(" | ");
    lines.push(line.slice(0, MAX_TASK_LINE_CHARS * 4)); // 行级硬上限 (~640 字), 单行爆炸兜底
  }
  return lines;
}

/* ---------------- fingerprint (缓存失效判据) ---------------- */

// 功能: 任务集指纹 — id:status:updated_at 排序后 md5. 任一任务状态/更新时间
// 变了指纹就变, 缓存自动失效重算; 都没变则直接吃缓存 (0 LLM 成本).
export function digestFingerprint(tasks: Task[]): string {
  const canonical = tasks
    .map((t) => `${t.id}:${t.status}:${t.updated_at ?? ""}`)
    .sort()
    .join("|");
  return createHash("md5").update(canonical).digest("hex").slice(0, 16);
}

/* ---------------- LLM 生成 ---------------- */

function buildSystemPrompt(): string {
  return [
    "你是项目总控制台的归纳助手。读者是项目 owner, 他要看懂整个项目当下的状态并快速拍板。",
    "",
    "【输入】项目业务文档摘录 + 任务清单 (id/状态/优先级/标题/最近汇报)。",
    "【输出】严格 JSON (无 markdown 代码块包裹, 无解释), 结构:",
    '{"headline":"<一句话总结项目当前状态, ≤40字>","items":[{"id":"<任务id原样>","category":"fix|design|delivery|iterate|decision|other","urgency":"high|mid|low","suggestion":"<≤48字下一步建议, 大白话>","need_owner":true|false}]}',
    "",
    "【分类口径】按真实业务含义分, 不是按状态:",
    "- fix=修复/bug/报错; design=设计/规划/方案; delivery=交付/已完成(14天内); iterate=功能迭代/优化; decision=需要 owner 选方案/拍板方向; other=其他。",
    "- need_owner=true 的判据: 任务在等 owner 回复/验收, 或 AI 判断下一步存在方案分歧需要 owner 选。",
    "- suggestion: 结合业务文档给出具体下一步 (不是复述状态); 已完成的说交付了什么价值。",
    "",
    "【硬约束】",
    "1. items 必须覆盖输入清单里的每个任务 (id 原样照抄, 不许编造不存在的 id)。",
    "2. headline ≤40 字, 中文, 结论式 (不是「有N个任务」这种废话)。",
    "3. suggestion ≤48 字。urgency: 等owner/阻塞/报错=high, 在跑/待办=mid, 其余=low。",
    "4. completed/cancelled 是终态任务, 只能进 delivery 分类 (已交付展示); 不许归入 fix/iterate/decision 等其他分类, need_owner 一律 false (终态不需要继续处理任何问题)。",
  ].join("\n");
}

interface DigestPromptInput {
  projectName: string;
  context: string;
  taskLines: string[];
}

export function buildDigestPrompt(input: DigestPromptInput): string {
  const parts: string[] = [];
  parts.push(`【项目名】${input.projectName || "(未命名)"}`);
  if (input.context) {
    parts.push(`【项目业务文档摘录】\n${input.context}`);
  } else {
    parts.push("【项目业务文档摘录】(无 — 只能依据任务清单归纳)");
  }
  parts.push(
    `【任务清单 (${input.taskLines.length} 条)】\n${input.taskLines.join("\n") || "(无任务)"}`,
  );
  parts.push("请输出严格 JSON (headline + items):");
  return parts.join("\n\n");
}

// 功能: 解析模型 JSON 输出 → ConsoleDigest. 容错: 剥 markdown 代码块 / 截取
// 首个 { 到末个 } / 逐字段校验.
// 关注点: 幻觉 id 过滤 (不在 validIds 的 item 丢弃) — 模型偶尔编 id, 前端
// 点按钮会 404; 全部无效 → 返回 null (caller 当失败).
// 🆕 R204: 传 statusById 时做终态守门 — completed/cancelled 任务错分进
// 非 delivery 分类 → 丢弃; 归 delivery → 保留但 need_owner 强制 false
// (终态不需要继续处理, 防一键同意唤醒终态任务).
export function parseDigestJson(
  raw: string | null | undefined,
  validIds: Set<string>,
  statusById?: Map<string, string>,
): ConsoleDigest | null {
  if (!raw) return null;
  let text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const headline =
    typeof obj.headline === "string" ? obj.headline.trim().slice(0, MAX_HEADLINE_CHARS) : "";
  if (!Array.isArray(obj.items)) return null;
  const items: DigestItem[] = [];
  for (const it of obj.items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id || !validIds.has(id)) continue; // 幻觉 id 丢弃
    const category = DIGEST_CATEGORIES.includes(o.category as DigestCategory)
      ? (o.category as DigestCategory)
      : "other";
    // R204 终态守门: 错分进非 delivery 分类 → 丢弃; delivery 保留但降级 need_owner.
    const inert =
      !!statusById?.get(id) && DIGEST_INERT_STATUSES.includes(statusById.get(id)!);
    if (inert && category !== "delivery") continue;
    const urgency =
      o.urgency === "high" || o.urgency === "mid" || o.urgency === "low" ? o.urgency : "mid";
    const suggestion =
      typeof o.suggestion === "string" ? o.suggestion.trim().slice(0, MAX_SUGGESTION_CHARS) : "";
    items.push({
      id,
      category,
      urgency,
      suggestion,
      need_owner: o.need_owner === true && !inert,
    });
  }
  if (!items.length) return null;
  return { headline, items };
}

// 进程级缓存: 配置链鉴权失败置位, 跳过后续配置链调用 (同 card-summary-llm).
let configKeyDead = false;

// 功能: 生成项目级 AI 归纳 (headline + 每任务分类/建议). 单次 LLM 调用.
// 关注点: 失败返 {digest:null} 不 throw (route 返 source:failed 且不写缓存);
// 第一跳项目配置链 401 → 兜底 server env 凭据 (同 card-summary-llm 双跳).
export async function generateConsoleDigest(input: {
  project: { id: string; name: string; owner_id: string | null };
  tasks: Task[];
  context: string;
}): Promise<ConsoleDigestResult> {
  const config = resolveLlmConfig({
    model: null,
    owner_id: input.project.owner_id,
    project_id: input.project.id,
    llm_config_id: null,
  });
  if (!config.api_key) return { digest: null, model: config.model || "" };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildDigestPrompt({
    projectName: input.project.name,
    context: input.context,
    taskLines: buildTaskLines(input.tasks),
  });
  // 🔴 runSingleTurnLlm 的 systemPrompt 参数不进 SDK — 指令拼进 user prompt.
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const envOverrides: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: config.api_key,
  };
  if (config.base_url) envOverrides.ANTHROPIC_BASE_URL = config.base_url;
  if (config.model) envOverrides.ANTHROPIC_MODEL = config.model;

  const validIds = new Set(input.tasks.map((t) => t.id));
  const statusById = new Map(input.tasks.map((t) => [t.id, t.status as string])); // R204 终态守门
  let raw: string | null = null;
  if (!configKeyDead) {
    raw = await runSingleTurnLlm(
      systemPrompt,
      fullPrompt,
      config.model || process.env.ANTHROPIC_MODEL || "",
      envOverrides,
    );
    if (raw && /failed to authenticate|invalid api key|unauthorized|401/i.test(raw.slice(0, 200))) {
      raw = null;
      configKeyDead = true;
    }
  }
  if (!raw) {
    const base = process.env.ANTHROPIC_BASE_URL || "";
    const envModel =
      process.env.ANTHROPIC_MODEL ||
      (base.includes("bigmodel") ? "glm-5.3" : "") ||
      config.model ||
      "";
    raw = await runSingleTurnLlm(systemPrompt, fullPrompt, envModel, {});
  }
  const digest = parseDigestJson(raw, validIds, statusById);
  if (!digest && raw) {
    console.warn(
      `[console-digest] parse failed (model=${config.model}), raw head: ${raw.slice(0, 300)}`,
    );
  }
  return { digest, model: config.model || "" };
}
