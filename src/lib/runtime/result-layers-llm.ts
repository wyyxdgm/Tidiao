// R190 (damo 1004 飞书): 任务详情弹窗正文分层总结 — result 原文一坨不好读,
// 按 3 层组织 (damo 原话: 每一层都是对下一层的总结, 理念上像多叉树):
//   L1 概览   = 简单几句话讲干了啥/操作了啥 (≤5 句, 步骤多允许加)
//   L2 核心细节 = 体现所有核心细节 (分条; 前端渲染成处理流程图解, damo 1005 R 列拍板)
// 本模块负责 L1+L2: LLM 读 title + result 一次性生成两级, 输出标记行分隔.
//
// 复用统一 summary 链 (summary-llm.ts): runSingleTurnLlm (allowedTools=[] /
// maxTurns=1 / 失败返 null 不 throw) + 系统 summary 配置 fallback 链 (R200 turn2:
// summary 配置 + fallback_ids → 任务配置链 → env). 调用方 (result-layers 路由)
// tasks.metadata 缓存, 一任务一次 LLM 成本.
// 与 card-summary 的区别: card-summary 面向「卡片一行」(输入 result 头 1200 字,
// 输出两行 ≤48 字); 本模块面向「弹窗正文」(输入 result 头 12000 字, 输出多句+分条).

import { runSummaryLlmTurn } from "./summary-llm";
import { stripRuntimeMarkers } from "./runtime-markers";
import type { Task } from "../db/tasks";

const MAX_RESULT_CHARS = 12000; // 弹窗正文要覆盖完整处理, 12k 字够绝大多数任务汇报
// 概览 hard cap. damo 1007: 概览 3~5 句讲清、越少越好 (prompt 1~3 句优先) —
// cap 只防模型失控, 不是目标长度 (命中截断 = 模型没听话, 不补省略号).
const MAX_BRIEF_CHARS = 300;
const MAX_DETAIL_ITEMS = 20; // 细节条数 cap (防模型失控输出上百条)
// 单条细节 hard cap (只防失控; prompt 要求每条说完说完整, 禁省略号 —
// damo 1007: 结尾带「…」= 总结不到位, 宁可全量展示也不截断).
const MAX_DETAIL_ITEM_CHARS = 500;
// 🔴 R190 线上反馈「一直卡在正在生成总结」: LLM 配置链死 key 时 SDK 网络层重试
//   实测拖 3+ 分钟/次 (card-summary 同款坑), 前端一直 loading. 整体竞速超时兜底
//   —— 超时当失败返 null (路由回 source:failed 不写缓存, 下次打开还能重试).
const GENERATION_TIMEOUT_MS = 50_000;

export interface ResultLayers {
  brief: string; // L1 概览: 3~5 句内讲干了啥/操作了啥, 越少越好
  details: string[]; // L2 核心细节: 分条 = 流程步骤 (前端渲染步骤流程图)
  next: string; // 下一步: 后续要做什么/建议, 没有则空串 (damo 1007 追加)
}

export interface ResultLayersLlmResult {
  layers: ResultLayers | null; // null = LLM 失败 (caller 不写缓存, 前端回退单层)
  model: string;
}

// 功能: 产出任务 result 的分层总结 (L1 概览 + L2 核心细节).
// 关注点: LLM 失败/解析不出 → null, caller 不写缓存, 不重试 (429 加剧).
// R200 turn2: 模型走系统 summary 链 (summary-llm.ts: summary 配置 + fallback_ids
//   → 任务配置链 → env), 不再本地双跳 — 链序统一一处维护.
export async function generateResultLayers(
  task: Task,
  opts: { timeoutMs?: number } = {},
): Promise<ResultLayersLlmResult> {
  // 整体竞速超时: 链上多跳挂死时超时放弃, caller 回退. 默认 50s (用户点开场景);
  // 批量回填场景传大值 (非交互, 慢模型跑长 result 需要更宽窗口).
  const timeoutMs = opts.timeoutMs ?? GENERATION_TIMEOUT_MS;
  const withTimeout = Promise.race([
    generateViaSummaryChain(task),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  const layers = await withTimeout;
  if (!layers) {
    console.warn(`[result-layers] generation failed or timed out (task=${task.id})`);
    return { layers: null, model: "" };
  }
  return layers;
}

// 功能: 走统一 summary 链生成 + 解析.
// 关注点: 从 generateResultLayers 拆出仅为挂超时竞速; 链内死 key 自动跳下一跳
//   (summary-llm.ts), 这里只管解析失败打日志.
async function generateViaSummaryChain(task: Task): Promise<{ layers: ResultLayers; model: string } | null> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    title: task.title || "",
    result: task.result || "",
  });

  const { raw, model } = await runSummaryLlmTurn(systemPrompt, userPrompt, task);
  const layers = parseResultLayersText(raw);
  if (!layers && raw) {
    console.warn(
      `[result-layers] parse failed (model=${model}), raw head: ${raw.slice(0, 300)}`,
    );
  }
  if (!layers) return null;
  return { layers, model };
}

function buildSystemPrompt(): string {
  return [
    "你是面向用户的任务结果总结助手。读者在任务详情弹窗里逐层往下钻取:",
    "先看概览, 想知道更多再看核心细节, 还不够再看完整原文。",
    "你负责写前三层 —— 每一层都是对下一层的总结。",
    "",
    "【硬约束】输出格式严格如下 (标记行原样输出, 一个不多一个不少):",
    "【概览】",
    "<3~5 句以内, 讲清这个任务干了啥、按什么顺序操作了啥、最后怎么了>",
    "【核心细节】",
    "• <流程步骤 1>",
    "• <流程步骤 2>",
    "• <流程步骤 N, 按需增加>",
    "【下一步】",
    "<一行: 后续要做什么 / 有什么建议; 没有后续就写「无」>",
    "",
    "【质量要求】",
    "1. 概览: 越少越好 —— 1~3 句优先, 上限 5 句, 每句都承载信息, 删掉客套和",
    "   过程性废话。按实际操作顺序讲, 大白话, 黑话展开 (端口号/实例名写成人话,",
    "   命令行翻译成它达成的目的)。",
    "2. 核心细节 = 处理流程图解 (前端渲染成步骤流程图): 每条 = 流程里的一个步骤,",
    "   按实际处理顺序排, 每步写「做了什么动作 → 得到什么结果」, 尽量覆盖全部",
    "   关键细节 (改了什么文件/做了什么决策/拿到什么数据/有什么坑)。",
    "   条数按内容定, 通常 5~15 条。",
    "3. 🔴 禁止省略号 (…/...) —— 每条都说完说完整, 结尾带省略号 = 总结不到位,",
    "   宁可多写一条也不要半句话。表达形式不限, 但必须完整。",
    "4. 禁止出现「R190」「Rxxx」这类表格行号/编号 —— 换成它指代的具体事情。",
    "5. 🔴 commit id / hash / checkpoint 代号不允许单独出现 —— 必须配上实际含义的",
    "   描述 (如「提交了部署脚本修复 (commit a1b2c3)」可以, 光写「a1b2c3」不行)。",
    "6. 🔴 输入里可能混有 <checkpoint .../> <awaiting .../> 等内部标记行, 那是",
    "   系统管线符号, 忽略它们, 绝不原样复述进输出 —— 输出里禁止出现任何 XML 标签。",
    "7. 纯文本输出, 除「•」外不用任何 markdown 记号。",
  ].join("\n");
}

function buildUserPrompt(input: { title: string; result: string }): string {
  const lines: string[] = [];
  lines.push("【任务标题】");
  lines.push(input.title.slice(0, 80) || "(无)");
  lines.push("");
  lines.push("【执行结果 / 完整汇报原文】");
  // 存量任务 result 里混着 <checkpoint .../> 等运行时标记 (落库剥标签只管新任务),
  // 输入前剥掉, 防模型把管线符号当内容总结进概览 (damo 1007 线上反馈).
  lines.push(stripRuntimeMarkers(input.result).slice(0, MAX_RESULT_CHARS) || "(空)");
  lines.push("");
  lines.push("请按格式输出【概览】+【核心细节】+【下一步】三层总结:");
  return lines.join("\n");
}

// 功能: 解析模型输出 → {brief, details[], next}. 按【概览】/【核心细节】/【下一步】标记切段.
// 关注点: 容忍 markdown 噪音 (加粗/引号/bullet 变体); 缺段尽力取有值的段,
//   三段全空 → null; details 无 bullet 时整段按句拆 (防模型忘写 bullet 全粘一起);
//   截断不加省略号 (damo 1007: 带「…」= 总结不到位, cap 只防失控).
export function parseResultLayersText(
  raw: string | null | undefined,
): ResultLayers | null {
  if (!raw) return null;

  const stripMd = (s: string) =>
    s
      .replace(/[*`#>]/g, "")
      .replace(/[「」"'"]/g, "")
      .trim();

  // 按标记行切段 (容忍标记行带 markdown 噪音 / 冒号变体)
  let brief = "";
  let next = "";
  const details: string[] = [];
  let section: "none" | "brief" | "details" | "next" = "none";
  const detailBuf: string[] = [];

  for (const lineRaw of raw.split("\n")) {
    // 先剥行首 markdown 噪音 (「## 【概览】」), 再匹配标记行
    const line = lineRaw.trim().replace(/^[#*>\s]+/, "").trim();
    if (/^【概览】/.test(line) || /^(?:概览|简短总结|总结)\s*[:：]\s*$/.test(line)) {
      section = "brief";
      continue;
    }
    if (/^【核心细节】/.test(line) || /^(?:核心细节|细节)\s*[:：]\s*$/.test(line)) {
      section = "details";
      continue;
    }
    if (/^【下一步】/.test(line) || /^下一步\s*[:：]\s*$/.test(line)) {
      section = "next";
      continue;
    }
    if (!line || /^[-=—*_]{3,}$/.test(line)) continue; // 空行 / 分隔线
    if (section === "brief") {
      brief += (brief ? "" : "") + line;
    } else if (section === "details") {
      detailBuf.push(line);
    } else if (section === "next") {
      next += (next ? " " : "") + line;
    }
    // section === none: 标记前的寒暄/复述, 丢弃
  }

  brief = stripMd(brief).slice(0, MAX_BRIEF_CHARS);

  // details: 剥 bullet 前缀, 合并属同一 bullet 的续行 (非 bullet 开头的行粘到上一条)
  for (const line of detailBuf) {
    const m = /^(?:[•·●◦\-–*]|\d{1,2}[.、)])\s*/.exec(line);
    if (m) {
      details.push(line.slice(m[0].length));
    } else if (details.length > 0) {
      details[details.length - 1] += ` ${line}`; // 续行 (补空格防两词粘死)
    } else {
      details.push(line); // 无 bullet 且是第一条
    }
  }

  const cleaned = details
    .map((d) => stripMd(d))
    .filter((d) => d.length > 0 && !/^\(信息不足\)$/.test(d))
    .slice(0, MAX_DETAIL_ITEMS)
    .map((d) => (d.length > MAX_DETAIL_ITEM_CHARS ? d.slice(0, MAX_DETAIL_ITEM_CHARS) : d));

  // next: 「无」/「(无)」/空 → 空串 (前端回退 checkpoint 口径); cap 防失控不补省略号
  next = stripMd(next).replace(/^\(?(无|暂无|没有)\)?$/, "").trim();
  next = next.slice(0, MAX_DETAIL_ITEM_CHARS);

  brief = brief.replace(/^\(信息不足\)$/, "").trim();
  if (!brief && cleaned.length === 0) return null;
  return { brief, details: cleaned, next };
}
