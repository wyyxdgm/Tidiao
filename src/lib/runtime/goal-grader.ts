// Goal-driven loop 阶段 2 (D19, damo 2026-09-14 拍板):
//   gradeGoal() — 调小模型评判「goal 是否达成」, 返回三态 verdict + reason.
//   阶段 3 active-session 集成时, result.subtype=success 路径拦截 → 调本函数
//   决策续跑 (resume / fork / failed-impossible).
//
// 设计点 (见 docs/plans/goal-loop.md §9.1 + §9.2 + §10.2):
//   - prompt 文本: §9.1 完整定稿 (D28 改用 self-report 替代 transcript). 中文 +
//     80 字 reason + JSON 一行输出 + 三态精确字面 + 判断原则三条.
//   - 接口签名: §9.2 GoalGradeInput (含 taskId 用于日志关联) + GoalGradeResult
//     (含 model/durationMs/costUsd 便于阶段 4 cost 归因).
//   - 🆕 D28: selfReport 替代 transcriptSummary 作主依据. transcriptSummary
//     改 optional, 仅在 selfReport 缺失时走 fallback (transcript 4KB 截断).
//   - 调模型 = getGoalGraderModel() (默认 Haiku 4.5, 单次成本 ≈ $0.001).
//   - LLM 凭证 (D26 修复, P0 根因): 解析 task owner 的 api_key/base_url 走
//     resolveLlmConfig 注入 SDK 子进程 env. 不传 = SDK 走 process.env 真
//     Anthropic endpoint → "Not logged in" → grader_json_parse_failed →
//     reach max_goal_rounds → failed. 凭证解耦: grader 永远用小模型
//     (cost 控制), key 走用户 (谁发 task 谁付钱).
//   - JSON 解析 regex 兜底 (/\{[\s\S]*?"verdict"[\s\S]*?"reason"[\s\S]*?\}/):
//     模型可能在 JSON 外加解释 / markdown fence / leading text, regex 抓第一对
//     大括号
//   - verdict 越界 (D14): 不在三态 → 视为 not_yet_met, reason 写
//     "grader_verdict_invalid: <raw>" + console.warn 日志 (不抛错, 不阻断 task).
//   - 抛错: SDK 网络/鉴权/JSON 解析失败/goalText 空/无 api_key → throw 给 caller,
//     caller (阶段 3 active-session) 视为 not_yet_met 续跑.
//
// 关注点:
//   - throw 而非 return null: 与 summarizeTitle 的「失败返 null, caller 回退」语义
//     不同 — 这里 caller 想区分「LLM 评判成功但条件没达成」vs「LLM 调失败」, throw
//     让两个语义在调用栈上一目了然. 阶段 3 active-session 的 catch 块专管 throw.
//   - 不写 DB: gradeGoal 是纯函数, 不读 task / 不写 task. caller (active-session)
//     决定要不要把 reason 落库.
//   - 不调 verification-runner: 这是 goal 语义评判, 与 verification (编译/测试
//     命令) 正交, 并存串行 (plan D4).
//   - costUsd 阶段 2 留 0 占位: 真实成本归因依赖 goal_history 累计 (阶段 4).
//     阶段 3 caller 拿到 costUsd=0 不要误以为是 bug — 后续 goal_history cap 阶段
//     会补完.

import { runSingleTurnLlm } from "./llm-summarize";
import { resolveLlmConfig } from "../db/llm-configs";
import { getGoalGraderModel } from "../db/settings";

// 🆕 D28: prompt 重写 — self-report 替代 transcript 作主依据. transcriptSummary
//   仅在 self-report 缺失时 fallback (旧 D27 截断盲区: Write/Bash content 字段
//   在 4KB 截断范围外, grader 看不到写文件证据, 永远判 not_yet_met).
// 关注点: 三态字面含义仍不动 (D14 越界兜底依据 — 改了字面会让所有模型输出被
//   regex 抓到但被判越界 = 全走 not_yet_met).
const SYSTEM_PROMPT = `你是一个 task 完成度评判员。用户给你一个目标描述（goal）和 agent 的自我报告 (self-report)。
self-report 是 agent 在 result 中明确写出的, 包含它做了哪些动作 + 产出物的内容/路径。
你需要判断 self-report 中目标是否已经达成。
只输出严格的 JSON, 不要任何解释或 markdown 代码块包裹:
{"verdict": "met" | "not_yet_met" | "impossible", "reason": "<一句中文解释, ≤80 字>"}

verdict 含义:
- "met": agent self-report 写 done 且产出内容与 goal 描述一致 (文件被修改且内容匹配 /
  命令执行且退出 0 / 字段写入且值正确 / 文案已修正等).
- "not_yet_met": agent self-report 写 not_done 或描述不完整, 或当前 self-report
  信息不足以判断.
- "impossible": agent self-report 写 impossible, 或 self-report 显示目标与
  agent 物理/权限/资源边界冲突 (例如要求访问无权限的环境或工具) /
  目标自相矛盾 / 目标依赖不可能的前提.
  注意区分 "agent 不会做" 与 "做了也不可能达成" — 前者是 not_yet_met, 后者才是 impossible.

判定依据 (优先级从高到低):
1. agent self-report: 报告 done + 产出内容与 goal 描述一致 → met
2. agent self-report: 报告 not_done 或描述不完整 → not_yet_met
3. agent self-report: 报告 impossible (任务自相矛盾 / 物理不可能) → impossible
4. self-report 缺失: 视为信息不足 → not_yet_met (D13 不对称兜底保留)

不再依赖 transcript 历史 (D28 起 transcript 只作辅助 fallback).`;

function buildUserPrompt(
  goalText: string,
  selfReport: string,
  transcriptSummary?: string,
): string {
  // 🆕 D28: 模板改为 self-report 为主, transcript fallback 可选.
  //   self-report 存在 → 用 self-report; 缺失 → 用 transcript (D27 旧路径).
  //   都没有 → "(无报告/对话历史)" 占位 (D13 不对称兜底走 not_yet_met).
  const goal = goalText.trim();
  const hasSelfReport = selfReport && selfReport.trim().length > 0;
  const hasTranscript = transcriptSummary && transcriptSummary.trim().length > 0;

  let evidenceSection: string;
  if (hasSelfReport) {
    evidenceSection = `## Agent 自我报告 (self-report, 由 agent 在 result 中明确写出)
${selfReport.trim()}`;
  } else if (hasTranscript) {
    evidenceSection = `## 对话历史摘要 (transcript summary, ≤4KB, self-report 缺失时的 fallback)
${transcriptSummary!.trim()}`;
  } else {
    evidenceSection = `(无 self-report 且无对话历史)`;
  }

  return `## 目标 (goal)
${goal}

${evidenceSection}

请输出 JSON (只一行):

判断原则:
- 证据优先: 只在 self-report 里有与 goal 一一对应的可观察证据时, 才输出 met.
- 目标自相矛盾 (如 "等待永远不会发生的事件 X") → impossible (即使 self-report 缺失).
- impossible 严判: 仅当目标与物理/权限/资源边界冲突 / 自相矛盾 / 依赖不可能前提才判.
- agent self-report 缺失 + goal 描述无明显 impossible 信号 → not_yet_met (D13 兜底保留, 但范围缩小).
- "agent 不会做" 不是 impossible, 是 not_yet_met.`;
}

// regex 兜底: 模型可能在 JSON 前后加 markdown fence / 解释 / 编号. 抓第一个
// 含 verdict 字段的 {…} 块 (reason 字段 D30 起 optional — 见下方注释). 非贪婪匹配
// 避免吃到下一段 JSON.
//
// 🆕 D30: reason 改 optional. 旧 regex 强制要求 JSON 同时含 verdict + reason 两字段,
//   但 grader 收到 self-report 明确信号 (done/not_done/impossible) 后可能输出简化
//   JSON `{"verdict": "met"}` — 没 reason → regex 不匹 → throw grader_json_parse_failed
//   → caller catch 当 not_yet_met → 5 轮 → failed (根因 D29 case1: 文件真写对了, 仅
//   grader JSON regex 不匹). 新 regex 只要求 verdict 字段, reason 缺失由解析逻辑
//   line 240-243 兜底为空串.
const VERDICT_REASON_JSON_RE = /\{[\s\S]*?"verdict"[\s\S]*?\}/;

// reason 上限 80 字 (§9.1 系统 prompt 字面: "<一句中文解释, ≤80 字>").
const MAX_REASON_CHARS = 80;

export type GoalVerdict = "met" | "not_yet_met" | "impossible";

const VALID_VERDICTS: ReadonlySet<GoalVerdict> = new Set([
  "met",
  "not_yet_met",
  "impossible",
]);

// §9.2 D6 定稿接口签名: 对象入参 (含 taskId 用于日志/event 关联), 结果带
//   model/durationMs/costUsd 便于阶段 4 cost 归因. warning 不在 result 里 —
//   越界时 console.warn 即可 (§9.2 写 "warning 日志", 不是字段).
// 🆕 D26: 新增 taskModel/taskOwnerId/taskProjectId/llmConfigId 用于解析 LLM
//   凭证 (api_key/base_url), 注入 SDK 子进程 env. 没有这四个字段时
//   resolveLlmConfig 走 env 兜底 (system task); task 有 owner 时必须传,
//   否则 SDK 走真 Anthropic endpoint 鉴权失败 = grader 永远 "Not logged in".
// 🆕 D28: selfReport 替代 transcriptSummary 作主依据. transcriptSummary 改 optional,
//   仅在 self-report 缺失时由 caller 传 fallback. 实证 (D27): 旧 transcript 4KB
//   截断范围不含 Write/Bash content 字段, grader 看不到写文件证据, 永远判
//   not_yet_met → task 进 max_goal_rounds 兜底后翻 failed.
export interface GoalGradeInput {
  goalText: string;             // 从 prompt 解析出的 marker 内容
  // 🆕 D28: agent 在 result 中写出的 goal_report 块内容 (由 caller 从 resultText
  //   regex 提取). grader 主依据.
  selfReport: string;
  // transcriptSummary 可选 fallback. 当 selfReport 为空时由 caller 传, grader
  //   仍可基于 transcript 4KB 摘要判 (旧行为, 仅作兜底).
  transcriptSummary?: string;
  taskId: string;               // 仅用于日志/event 关联
  // D26: 解析 task owner 的 LLM 凭证
  taskModel?: string | null;
  taskOwnerId?: string | null;
  taskProjectId?: string | null;
  llmConfigId?: string | null;
}

export interface GoalGradeResult {
  verdict: GoalVerdict;
  reason: string;               // 1-2 句解释, 落 task.metadata.goal_history
  model: string;                // 实际用的 grader 模型 (便于成本归因)
  durationMs: number;
  costUsd: number;              // grader 自身 cost (阶段 2 占位 0, 阶段 4 归因)
}

// 功能: 调小模型评判「goal 是否达成」, 返回三态 verdict + reason + 模型元信息.
// 关注点:
//   - goalText 空 → throw "grader_goal_text_empty" (caller 视为 not_yet_met).
//   - SDK 失败 (网络/鉴权/429) → runSingleTurnLlm 内部已 catch 返 null, 这里
//     把 null 翻译成 throw "grader_sdk_failed" (caller 视为 not_yet_met 续跑).
//   - JSON 解析失败 (regex 不命中) → throw "grader_json_parse_failed" (同上).
//   - verdict 越界 (不是 3 个合法值之一, D14) → 不抛, 收窄到 not_yet_met,
//     reason 写 "grader_verdict_invalid: <raw>" + console.warn 日志, caller
//     可在日志里审计, 不阻断 task.
//   - reason 字段缺失 / 不是字符串 → 用空字符串兜底, 不抛 (D30 兼容简化 JSON
//     `{"verdict": "met"}` 输出).
//   - durationMs 用 Date.now() 包 runSingleTurnLlm; costUsd 阶段 2 占位 0.
//   - 🔴 D26 根因修复: 解析 task owner 的 LLM 凭证 (api_key/base_url) 走
//     resolveLlmConfig 注入 SDK 子进程 env — 否则 SDK 走 process.env 真
//     Anthropic endpoint → 鉴权失败 → raw = "Not logged in" → regex 不命中 →
//     grader_json_parse_failed → reach max_goal_rounds → failed. 对照
//     summarizeTitle (llm-summarize.ts:144-175) 已正确处理, gradeGoal 漏了一步.
//   - 🆕 D28: selfReport 替代 transcriptSummary 作主依据. transcriptSummary
//     改 optional, 仅在 selfReport 为空时 caller 传. 详见 SYSTEM_PROMPT.
//   - 模型: grader_model 仍走 getGoalGraderModel() (Haiku 4.5 默认, 廉价),
//     凭证解耦 = grader 永远小模型, 但 key 走用户 = 谁发的 task 谁付钱.
//   - api_key 为空 → throw "grader_no_api_key" (跟现有抛错语义一致, caller
//     catch 后视为 not_yet_met 续跑).
export async function gradeGoal(input: GoalGradeInput): Promise<GoalGradeResult> {
  if (!input.goalText || !input.goalText.trim()) {
    throw new Error("grader_goal_text_empty");
  }

  // D26: 解析 task owner 的 LLM 凭证. resolveLlmConfig 内部已带 fallback:
  //   env → admin default (granted) → user default → project default →
  //   task.llm_config_id → template.llm_config_id → task.model → env.
  //   task.model 走 schema default, 这里显式不传 (避免覆盖用户的显式选择)
  //   —— 让 task.llm_config_id 优先于 model 兜底.
  const config = resolveLlmConfig({
    model: input.taskModel ?? null,
    owner_id: input.taskOwnerId ?? null,
    project_id: input.taskProjectId ?? null,
    llm_config_id: input.llmConfigId ?? null,
  });
  if (!config.api_key) {
    throw new Error("grader_no_api_key");
  }

  // 组装 envOverrides: 只在 caller 提供的值非空时覆盖 (避免 undefined 字符串).
  const envOverrides: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: config.api_key,
  };
  if (config.base_url) envOverrides.ANTHROPIC_BASE_URL = config.base_url;

  const userPrompt = buildUserPrompt(
    input.goalText,
    input.selfReport,
    input.transcriptSummary,
  );
  const model = getGoalGraderModel();

  const startMs = Date.now();
  const raw = await runSingleTurnLlm(SYSTEM_PROMPT, userPrompt, model, envOverrides);
  const durationMs = Date.now() - startMs;

  if (raw === null) {
    // SDK 失败 → 抛给 caller. caller (阶段 3 active-session) catch 后视为 not_yet_met.
    throw new Error("grader_sdk_failed");
  }

  // regex 兜底解析. 命中后用 JSON.parse 再做严格校验.
  const match = raw.match(VERDICT_REASON_JSON_RE);
  if (!match) {
    throw new Error(`grader_json_parse_failed: ${raw.slice(0, 200)}`);
  }

  let parsed: { verdict?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `grader_json_parse_failed: ${(err as Error).message} (raw=${raw.slice(0, 200)})`,
    );
  }

  const rawVerdict = typeof parsed.verdict === "string" ? parsed.verdict : "";
  const reason =
    typeof parsed.reason === "string"
      ? parsed.reason.trim().slice(0, MAX_REASON_CHARS)
      : "";

  // verdict 越界 (D14): 不在三态 → 视为 not_yet_met, reason 写
  // "grader_verdict_invalid: <raw>" + console.warn 日志. 不抛, 避免模型一次
  // typo 把整个 task 卡死 (caller 重跑还会再越界 = 死循环).
  if (!VALID_VERDICTS.has(rawVerdict as GoalVerdict)) {
    const invalidReason = `grader_verdict_invalid: ${rawVerdict || "(empty)"}`;
    console.warn(
      `[goal-grader] task=${input.taskId} verdict "${rawVerdict}" not in {met, not_yet_met, impossible}; treating as not_yet_met`,
    );
    return {
      verdict: "not_yet_met",
      reason: invalidReason,
      model,
      durationMs,
      costUsd: 0, // 阶段 2 占位
    };
  }

  return {
    verdict: rawVerdict as GoalVerdict,
    reason: reason || "(no reason provided)",
    model,
    durationMs,
    costUsd: 0, // 阶段 2 占位
  };
}
