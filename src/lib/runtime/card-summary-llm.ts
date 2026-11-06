// R177 迭代7 (damo 1004 N 列拍板): 画布卡片摘要「面向用户」 — 机械提取截 prompt
// 行到顶了, 「更新布署13000」「bash ~/…ao-platform-upgrade.sh」这类黑话/命令行
// 不看上下文读不懂. 标准 = 只看摘要就知道他要干什么、大致有什么用 → 上 LLM 理解.
//
// 复用统一 summary 链 (summary-llm.ts, R200 turn2): allowedTools=[] / maxTurns=1 /
// 失败返 null 不 throw / 模型走系统 summary 配置 fallback 链. 单次成本 ≈ $0.005,
// 调用方 (card-summary 路由) 用 tasks.metadata 缓存, 一个任务只花一次.

import { runSummaryLlmTurn } from "./summary-llm";
import { stripRuntimeMarkers } from "./runtime-markers";
import type { Task } from "../db/tasks";

const MAX_PROMPT_CHARS = 600; // prompt 头 (身份行/checkpoint 套话占大头, 600 字够模型看清意图)
const MAX_RESULT_CHARS = 1200; // result / 最后汇报 = 「实际做了什么」的权威来源
const MAX_FIELD_CHARS = 96; // 单行摘要 hard cap (R190: 展示允许两行, 96 字 ≈ 两行放得下)

export interface CardSummary {
  what: string; // 干啥: 任务要干什么 (自包含, 黑话展开)
  why: string; // 有啥用: 做成了/对用户有什么用
}

export interface CardSummaryLlmResult {
  summary: CardSummary | null; // null = LLM 失败 (caller 回退机械提取)
  model: string;
}

// 功能: 产出面向用户的自包含卡片摘要 (干啥/有啥用 两行).
// 关注点: LLM 失败/超字数解析不出 → null, caller 回退机械提取, 不重试 (429 加剧).
// R200 turn2: 双跳骨架换成统一 summary 链 (configKeyDead 进程级 hack 退役 —
//   链内死 key 自动跳下一跳, 「重启才重试」的限制随之消失).
export async function generateCardSummary(task: Task): Promise<CardSummaryLlmResult> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    title: task.title || "",
    prompt: task.prompt || "",
    result: task.result || "",
  });

  const { raw, model } = await runSummaryLlmTurn(systemPrompt, userPrompt, task);
  const summary = parseCardSummaryText(raw);
  if (!summary && raw) {
    // 诊断: 模型输出解析不出两行 — 打前 300 字定位格式问题 (后端日志)
    console.warn(
      `[card-summary] parse failed (model=${model}), raw head: ${raw.slice(0, 300)}`,
    );
  }
  return { summary, model };
}
function buildSystemPrompt(): string {
  return [
    "你是面向用户的任务摘要助手。读者不看任务详情、不懂内部术语，只看你这两行摘要。",
    "",
    "【硬约束】输出两行, 格式严格如下 (一行一个, 不多不少):",
    "干啥: <≤90字, 展示层最多两行, 别写成流水账>",
    "有啥用: <≤90字, 展示层最多两行, 别写成流水账>",
    "",
    "【质量要求】",
    "1. 自包含: 不看任何其他内容也能懂. 内部黑话要展开 —— 端口号/实例名写成人话",
    "   (如「13000」→「线上 ao-prod 服务」), 命令行/文件路径翻译成它达成的目的.",
    "2. 「干啥」= 这个任务做了什么; 「有啥用」= 做成之后的价值, 只写价值不复述动作 ——",
    "   从这些角度挑真实成立的写具体: 谁省了几步/省多少时间, 多了什么新能力,",
    "   什么坏结果被堵住不再发生, 哪个页面/哪步操作变得怎么好用.",
    "   🔴 两行禁止互为复述: 「有啥用」里不许再讲「干啥」那件事做了什么;",
    "   「验证通过/已完成/全链路跑通/体验升级/运行更稳定」这类完成态陈述不是价值, 禁止充当「有啥用」.",
    "   自检: 遮住「干啥」只读「有啥用」, 依然知道这事为什么值得做, 才算合格.",
    "   例 ✗(复述+空话): 「正式站热榜以轮播卡片呈现，全链路验证通过，浏览体验升级」",
    "      ✓(具体价值): 「访客停留首屏就能轮播看完热榜，不用翻页找热内容；派单重复查清是人为触发不是 bug，之后不用再派人盯防」",
    "3. 大白话, 不照抄命令行, 不写 checkpoint/commit hash 等过程细节.",
    "4. 禁止出现「R177」「Rxxx」这类表格行号/编号/单号 —— 读者不知道编号指什么,",
    "   直接换成它指代的具体功能或事情 (damo 1004 拍板).",
    "5. 🔴 禁止省略号 (…/...) —— 两行都说完说完整, 结尾带省略号 = 总结不到位.",
    "6. 🔴 输入里可能混有 <checkpoint .../> 等内部标记行, 那是系统管线符号,",
    "   忽略它们 —— 输出里禁止出现任何 XML 标签.",
    "",
    "【格式】纯文本两行, 无 markdown / 引号 / 编号 / 解释。信息不足时该行写「(信息不足)」。",
  ].join("\n");
}

function buildUserPrompt(input: { title: string; prompt: string; result: string }): string {
  const lines: string[] = [];
  lines.push("【任务标题】");
  lines.push(input.title.slice(0, 80) || "(无)");
  lines.push("");
  lines.push("【任务要求 (prompt 开头)】");
  lines.push(stripRuntimeMarkers(input.prompt).slice(0, MAX_PROMPT_CHARS).trim() || "(空)");
  lines.push("");
  lines.push("【执行结果 / 最后汇报】");
  // 存量任务 result 混着 <checkpoint .../> 等运行时标记, 输入前剥掉 (damo 1007)
  lines.push(stripRuntimeMarkers(input.result).slice(0, MAX_RESULT_CHARS).trim() || "(还没跑完, 只看标题和要求猜)");
  lines.push("");
  lines.push("请输出两行摘要 (干啥 / 有啥用):");
  return lines.join("\n");
}

// 功能: 解析模型输出 → {what, why}. 容忍 markdown 噪音 (加粗/引号/编号).
// 关注点: 行数不对或缺行 → 尽力取有值的一行, 两行全空 → null.
export function parseCardSummaryText(
  raw: string | null | undefined,
): CardSummary | null {
  if (!raw) return null;
  const clean = (s: string) =>
    s
      .replace(/[*`「」"'"]/g, "")
      .replace(/^[\-\*\d]+[.、)]?\s*/, "")
      .trim()
      .slice(0, MAX_FIELD_CHARS);
  let what = "";
  let why = "";
  for (const line of raw.split("\n")) {
    // 先剥行首 markdown/bullet 噪音 (「**1. 干啥: …」「- 有啥用: …」), 再匹配行头
    const t = line
      .trim()
      .replace(/^[\-\*•\d]+[.、)]?\s*/, "")
      .replace(/^\*+/, "")
      .trim();
    const m = /^(?:干啥|做什么|干了啥|做了啥)\s*[:：]\s*(.+)$/.exec(t);
    if (m && !what) what = clean(m[1]);
    const w = /^(?:有啥用|有什么用|用处|价值)\s*[:：]\s*(.+)$/.exec(t);
    if (w && !why) why = clean(w[1]);
  }
  what = what.replace(/^\(信息不足\)$/, "").trim();
  why = why.replace(/^\(信息不足\)$/, "").trim();
  if (!what && !why) return null;
  return { what, why };
}
