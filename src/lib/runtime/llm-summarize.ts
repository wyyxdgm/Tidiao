// R122 T5-A: inline LLM summarize helper for auto-rename (reviewing → 提标题)
// + Goal-driven loop 阶段 2 (D19) 共用 runSingleTurnLlm() 入口.
//
// 用途:
//   - summarizeTitle(): 给 generateAutoTitle() 在「prompt 提取不出信息量 +
//     checkpoint 缺失」的情况下, 跑一次 single-turn agent session 提炼一句 ≤ 40
//     字符的标题. 调用时机: rule-engine fire-and-forget 内 (auto_rename_title rule).
//   - runSingleTurnLlm(): 共享的 single-turn SDK wrapper, goal-grader.gradeGoal()
//     也调它. 行为契约固化在 llm-summarize.test.ts (cwd=tmpdir, allowedTools=[],
//     maxTurns=1, env 三件套, finally 清 tmpdir, 失败返 null).
//
// 设计点 (见 docs/decisions/2026-08-29-r122-t4-frontend-stats.md §2.1 表 7-1):
//   - 模型 = task.model 跟随 (走 resolveLlmConfig 链, 不引入新配额项)
//   - 输入 = prompt 头 400 字符 + checkpoint summaries (取最近 5 条) +
//     最近 transcript (≤ 4KB, 取自最新 checkpoint 的 transcript_slice)
//   - 输出 = 1 行 ≤ 40 字符的中文标题 (实际期望 8-36 字, 40 是 hard cap,
//     damo 1004 从 R144 的 22 放宽; 展示层 CSS 自己截)
//   - 失败 = 抛异常或 return null, 不污染外层
//   - 单次成本 ≈ $0.005 (input ~1.5k tok + output ~30 tok)
//
// R144 (damo 0915): 飞书 R144 反馈「标题自动总结」三个问题
//   - 字数太长 → 系统 prompt 里必须前置硬字数约束, 不是软提示
//   - 模型输出超长被截断带「…」→ MAX_OUTPUT_CHARS 作 hard 后盾 (R144 时 22,
//     damo 1004 放宽到 40)
//   - 没读整段对话 → 输入加 transcript (取最新 checkpoint 的 transcript_slice,
//     summarizeTranscriptForGrader 截到 4KB), 标题反映"做了什么"而不是"开头问了什么"
//
// 关注点:
//   - SDK query() 是 agent 全功能入口 (cwd + tools + hooks + env), inline 用
//     须把无关项收敛: cwd 用 os.tmpdir() 子目录 (避免污染任务 cwd), allowedTools=[],
//     maxTurns=1, 不挂 hooks / canUseTool. 任一缺漏都会拖慢或卡死 (实测 active-
//     session.ts:1414 /compact 也是同款 min-config 模式).
//   - env 注入 ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL + ANTHROPIC_MODEL (走
//     resolveLlmConfig 解出的字段), 不要把整 process.env 透传 — 任务 agent
//     注入的 session vars (ORCHESTRATOR_*) 会影响 SDK 子进程判断, 隔离更稳.
//   - SDK 不为该调用提供 canUseTool → 不会落审批 UI, 但也不挡危险操作. 把
//     allowedTools=[] 等于禁止任何写操作, 足够安全.
//   - 撞 429 / 鉴权失败 / 网络抖动 → SDK 抛异常, 我们 catch 后返 null 让 caller
//     回退到非 LLM 路径.
//   - runSingleTurnLlm 返回 null = 「SDK 调用失败」语义, caller 必须区分「null
//     失败」vs 「成功但拿到空字符串」. 抽空字符串当正常返回 (空 prompt 的合法
//     结果是空, 不是失败).

import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "os";
import path from "path";
import fs from "fs";
import { runSummaryLlmTurn } from "./summary-llm";
import { stripRuntimeMarkers } from "./runtime-markers";
import type { Task } from "../db/tasks";

const MAX_INPUT_PROMPT_CHARS = 400;   // 与 auto-rename.ts 的 PROMPT_HEAD_CHARS 对齐
const MAX_CHECKPOINT_SUMMARIES = 5;   // 取最近 5 条, 总量控制在 ~1k token
const MAX_TRANSCRIPT_CHARS = 4096;    // R144: 取自 summarizeTranscriptForGrader 同款 4KB cap
// 标题 hard cap. R144 曾从 60 降到 22 (当时 tab 显示截 12 字符); damo 1004 拍板
//      放宽到 40 —— 展示层 (CSS ellipsis/line-clamp) 自己截, 存储端留全信息.
//      系统 prompt 期望 ≤ 36 字符; 40 是 backstop (清洗后还超就带「…」截断).
const MAX_OUTPUT_CHARS = 40;

export interface SummarizeTitleInput {
  task: Task;
  /** prompt 头 N 字符 (caller 已 slice 过, 兜底再截一次). */
  promptHead: string;
  /** checkpoint summaries, 越靠前越新 (caller 决定顺序). */
  checkpointSummaries: string[];
  /**
   * R144: 最近一次 checkpoint 的 transcript_slice 摘录. 模型读完 prompt 头 +
   * checkpoint summaries 还是只能看到「开头问了什么」, 加这一段让标题反映
   * 「实际做了什么」. caller (auto-rename.ts) 从 getCheckpointsByTaskId 末尾
   * 取 transcript_slice; 内部再 summarizeTranscriptForGrader 截到 4KB.
   */
  latestTranscript?: string | null;
  /**
   * damo 1004 (回归 task 7b921e1b): agent 最终总结 (task.result), 内容最全的
   * 单一数据源. reviewing 转换时 result 已落库 (active-session.ts 先
   * updateTaskStatus(result) 后 emitEvent → rule-engine), caller 直读 task 即得.
   * 空安全: 任务没写 result 时传 null/undefined, 模型回退其余三段.
   */
  taskResult?: string | null;
}

// 功能: 跑一次 single-turn SDK session, 让模型按 caller 提供的 system + user prompt
//   返回一行字符串. 共享给 summarizeTitle (auto-rename 兜底) + gradeGoal (goal
//   loop 评判). 失败语义: SDK 异常 / result subtype != success / 空 result → 返 null.
//
// 入参 envOverrides: caller 想覆盖 SDK env 的字段 (如 ANTHROPIC_API_KEY).
//   不传 = 用 process.env 已有值 (active-session 在 task 启动时已注入). 传 =
//   覆盖 (summarizeTitle 走 task.model 解析的 config, 不依赖 process.env).
//
// 关注点:
//   - cwd 走 os.tmpdir() 子目录, finally 清理 (实测 SDK 写 session 元数据到这里).
//   - 显式 allowedTools=[] / maxTurns=1 / 不传 hooks / 不传 canUseTool — inline 调用
//     不走 agent 审批链, 禁工具是安全网.
//   - env 注入 ANTHROPIC_API_KEY + (可选) ANTHROPIC_BASE_URL + ANTHROPIC_MODEL, 不
//     透传整 process.env (避免任务 agent 注入的 ORCHESTRATOR_* session vars 影响
//     子进程判断). 注意: 我们确实 spread process.env 再覆盖 — 是为了不丢 SDK
//     自身需要的 PATH / HOME 等基础 env, 不是「整包透传」.
//   - 失败一律 null, 不 throw. caller (summarizeTitle / gradeGoal) 自己决定怎么
//     兜底 — summarizeTitle 用 null = 回退到 prompt 提取; gradeGoal 用 null = 抛给
//     上层 active-session 当 not_yet_met 续跑.
export async function runSingleTurnLlm(
  systemPrompt: string,
  userPrompt: string,
  modelId: string,
  envOverrides?: Record<string, string | undefined>,
): Promise<string | null> {
  if (!modelId) return null;

  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-summarize-"));
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_MODEL: modelId,
      ...(envOverrides ?? {}),
    };
    // 覆盖项里显式 undefined = 要求剔除该变量 (如 summary 链传 ANTHROPIC_AUTH_TOKEN:
    //   undefined 清残留占位, 与 active-session buildEnv 的 delete 政策对齐) —
    //   spread 只会置 undefined 不删键, 这里真删, 防子进程拿到非字符串值.
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete env[k];
    }
    // 摘要链模式 (caller 显式传 envOverrides = 显式管理鉴权): 给 CLI 一个空白
    //   config dir, 隔离 ~/.claude 里的本地状态 —— WSL 实测 (1008 凌晨): 脚本
    //   上下文里 CLI 读到 ~/.claude 的旧网关配置后 403 authorization failed 顶掉
    //   链上的 key (curl 直连同 key 200), CLAUDE_CONFIG_DIR 指空白目录后立即恢复.
    //   仅 envOverrides 模式生效, 不动 goal-grader 等继承 process.env 的调用方.
    if (envOverrides) {
      env.CLAUDE_CONFIG_DIR = path.join(tmpCwd, "claude-config");
    }

    const q = query({
      prompt: userPrompt,
      options: {
        cwd: tmpCwd,
        model: modelId,
        allowedTools: [],           // 显式禁止工具, 防写文件 / 跑命令
        maxTurns: 1,                // single-turn, 收一次 result 即停
        includePartialMessages: false,
        env,
      },
    });

    let resultText: string | null = null;
    for await (const msg of q) {
      // 嵌套 if 而非两个平级 if: 跨语句的 msg.subtype !== "success" 会让 TS
      // 流分析把 subtype 提前收窄到 error subtypes, 报 "no overlap" 比较错误.
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          // R182: SDK 在 API 层错误 (429 限流 / 鉴权失败等) 时也会发 subtype=success
          //   的 result, msg.result 即错误文本 (实测 task c6d50986 标题被写成
          //   「API Error: Request re…」就是这条链; 401 形态是 "Failed to
          //   authenticate. API Error: ..." 前缀, 同样覆盖). 命中按失败处理返
          //   null, 让 caller 回退到 prompt 提取档, 别把错误文本当标题.
          //   1007 追加: 配额死/网关 429 时 SDK 吐「Not logged in · Please run
          //   /login」前缀 (ao-prod 实证), 同样按失败处理.
          if (
            typeof msg.result === "string" &&
            (msg.result.trim().startsWith("API Error") ||
              msg.result.trim().startsWith("Failed to authenticate") ||
              msg.result.trim().startsWith("Not logged in"))
          ) {
            // 2026-10-14: 静默 null 让 grader_sdk_failed 无从排查 (0955d855 七轮
            //   全败只有笼统 fallback reason, 带外复现全通过). 补一行错误文本留痕.
            console.warn(
              `[llm-summarize] runSingleTurnLlm synthetic error (model=${modelId}): ${msg.result.trim().slice(0, 200)}`,
            );
            return null;
          }
          resultText = msg.result;
          break; // single-turn 第一个 result 就是终态, 早停节省 SDK 子进程占用
        }
        // 失败 (rate_limit / auth / max_turns 等) → 直接 null
        // 2026-10-14: 同上, 非 success subtype 以前也是静默 null, 排查无门.
        console.warn(
          `[llm-summarize] runSingleTurnLlm non-success result (model=${modelId}): subtype=${msg.subtype}`,
        );
        return null;
      }
    }
    if (!resultText) return null;
    return resultText;
  } catch (err) {
    // 任何 SDK 异常 (网络 / 鉴权 / 超时) → null, caller 回退
    console.warn(
      `[llm-summarize] runSingleTurnLlm failed (model=${modelId}):`,
      (err as Error).message,
    );
    return null;
  } finally {
    // 清理临时目录 (SDK 写 session 元数据到这里), 失败不阻断主流程
    try {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    } catch {
      // ignore: tmpdir 清理失败不致命, OS 会回收
    }
  }
}

// 功能: 跑一次 single-turn SDK session, 让模型从「prompt 头 + checkpoint
//   summaries」提炼 ≤ MAX_OUTPUT_CHARS 字符的中文标题.
// 关注点:
//   - 返回 null = 调用失败, caller 应回退到非 LLM 路径 (不要在 caller 重试,
//     撞 429 时重试 = 加剧配额压力).
//   - SDK 子进程起动 + 收 result ≈ 2-5s; 失败一律 null, 不要 throw (外层
//     generateAutoTitle 已 try/catch + 记 rule_failed event).
//   - cwd 用临时子目录, 不污染 task.cwd (实测 SDK 会写 session 元数据到 cwd).
//   - 复用 runSingleTurnLlm: 把 resolveLlmConfig 解出的 api_key/base_url/model
//     透传给 helper (不走 process.env 假设), 保证 task 路径的 config 与 SDK 实际
//     看到的 env 一致.
export async function summarizeTitle(input: SummarizeTitleInput): Promise<string | null> {
  // R200 turn2: 模型走系统 summary 链 (summary 配置 + fallback_ids → 任务配置链
  // → env), 不再本地 resolveLlmConfig 单跳 — 链内死 key 自动跳下一跳.

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(
    input.promptHead,
    input.checkpointSummaries,
    input.latestTranscript,
    input.taskResult,
  );

  const { raw } = await runSummaryLlmTurn(systemPrompt, userPrompt, input.task);
  if (!raw) return null;
  return cleanResultText(raw);
}

// 功能: 构造 system prompt (R144 强化版: 字数硬约束 + 质量要求 + 整段对话视角).
// 关注点:
//   - 字数硬约束前置到第一句, 不是埋在要求列表第 (1) 条 — 飞书 R144 反馈
//     "提示词里提醒一下" 实测放列表里模型还是会写超, 必须开篇强调.
//   - "不要写省略号" 是因为超长 → cleanResultText 会加 "…", 飞书 R144 截图里
//     标题结尾的「…」就是这个; 让模型自己别写就少一次截断.
//   - "反映整段对话" 督促模型综合 transcript + checkpoint + prompt 三段, 而不是
//     只看 prompt 第一句.
//   - 举例: 给个具体长度的"好"标题样本, 比单纯说"≤ 36 字符"管用.
function buildSystemPrompt(): string {
  return [
    "你是任务标题提炼助手。",
    "",
    "【硬约束】输出严格 ≤ 36 字符的精简中文标题（hard cap 40, 超出会被截断加省略号, 失去信息）。",
    "不要写省略号、不要写 \"...\"、不要写 \"...\".  不要 \"修一下/看一下/测试\" 等泛词。",
    "",
    "【质量要求】",
    "1. 综合任务 prompt 开头 + checkpoint 摘要 + 最近 transcript + 执行结果, 提炼「整段对话做了什么」, 不只是 prompt 第一句",
    "2. 名词短语优先（动宾结构也行），描述任务核心目标",
    "3. 反映实际产出（如「修复 R144 飞书标题字数」、「加 checkpoint 短路」），不照抄原话",
    "4. 任务涉及需求编号（如 R176）时, 标题必须包含该编号 + 实际改动对象（如「修 R176 卡片摘要空话」）；不许只写实现细节而不带编号",
    "",
    "【格式】纯中文, 一行, 无 markdown / 引号 / 编号 / 解释。无信息量时输出 \"untitled\"。",
    "",
    "【示例】",
    "好: 「修复 R144 飞书标题字数」、「加 checkpoint 短路逻辑」、「迁移 P1 数据到新表」",
    "坏: 「修一下」、「看一下」、「复现一个 bug」、「R144...」、「帮我看看这个任务」(太长且泛词)",
  ].join("\n");
}

// 功能: 把 prompt 头 + checkpoint summaries + 最新 transcript 拼成 user prompt.
// 关注点:
//   - prompt 头再次截断一次 (defensive, caller 可能传完整 prompt).
//   - checkpoint summaries 取最近 N 条; 空数组时省略该段 (避免占位噪音).
//   - transcript 走 summarizeTranscriptForGrader 同款 4KB cap (防御 caller 传整
//     个会话 — SDK transcript 可能十几 KB, 一次全塞 LLM 不划算).
//   - 三段都给空时仍然输出"请输出标题:" — 模型自己判断 "untitled" 或基于 prompt 头.
//   - 段落顺序: prompt → checkpoint summaries → transcript → 执行结果 (按
//     "先意图后实践"读, result 是最终产出放最后压轴).
function buildUserPrompt(
  promptHead: string,
  checkpointSummaries: string[],
  latestTranscript?: string | null,
  taskResult?: string | null,
): string {
  const head = (promptHead || "").slice(0, MAX_INPUT_PROMPT_CHARS).trim();
  const recent = checkpointSummaries
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .slice(0, MAX_CHECKPOINT_SUMMARIES);
  // checkpoint/awaiting 标记是管线符号, 剥掉防模型把它们当内容提炼进标题
  const transcript = summarizeTranscriptForGrader(
    stripRuntimeMarkers(latestTranscript || ""),
    MAX_TRANSCRIPT_CHARS,
  );
  const result = summarizeTranscriptForGrader(
    stripRuntimeMarkers(taskResult || ""),
    MAX_TRANSCRIPT_CHARS,
  );

  const lines: string[] = [];
  lines.push("【任务 prompt 开头】");
  lines.push(head || "(空)");
  if (recent.length > 0) {
    lines.push("");
    lines.push("【最近 checkpoint 摘要】");
    recent.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (transcript.length > 0) {
    lines.push("");
    lines.push("【最近 transcript】");
    lines.push(transcript);
  }
  if (result.length > 0) {
    lines.push("");
    lines.push("【执行结果 / 最终总结】");
    lines.push(result);
  }
  lines.push("");
  lines.push("请输出标题 (≤ 36 字符, 一行):");
  return lines.join("\n");
}

// Goal-driven loop 阶段 3 (D20, damo 2026-09-14 拍板): 拿 SDK transcript (raw
//   JSONL dump 或 SDK history) 截成 ≤4KB 字符串给 goal-grader 当 summary.
//   不调 LLM —— 节省成本 + 避免 LLM 自己总结自己时引入幻觉 + 阶段 2 gradeGoal
//   已经在 system prompt 里说「摘要可能不完整」, 让模型按「信息不足 → not_yet_met」
//   兜底 (§9.1 D5 + D13).
//
// 行为契约:
//   - 输入 transcript = 任意长度字符串. 大概率来自 SDK getSessionHistory() 拼出来的
//     "[user]: ...\n[assistant]: ...\n..." 文本.
//   - 输出 ≤ maxBytes 字符 (默认 4KB = 与 §9.1 plan transcript_summary cap 对齐).
//   - 超过 maxBytes → 截断 + 末尾追加 "\n\n[truncated: <原始字节数> -> <截断字节数>]"
//     标记, grader 能从「看到 truncated 标记」判断「信息可能不全」 → not_yet_met.
//   - maxBytes ≤ 0 → 兜底用默认 4KB, 防御 caller 传错.
export function summarizeTranscriptForGrader(
  transcript: string,
  maxBytes: number = 4096,
): string {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 4096;
  const raw = typeof transcript === "string" ? transcript : "";
  if (raw.length <= cap) {
    return raw;
  }
  const truncated = raw.slice(0, cap);
  return `${truncated}\n\n[truncated: ${raw.length} -> ${cap}]`;
}

// 功能: 把模型输出整理成 ≤ MAX_OUTPUT_CHARS 字符的「干净」标题.
// 关注点:
//   - 模型可能返回 markdown (例如 **标题**) / 包裹引号 / 编号前缀 / 解释尾巴;
//     全部剥掉, 与 auto-rename.ts 的清洗逻辑保持一致.
//   - 长度超限 → 截断 + 加省略号 (与 R15 sub-2 truncate 行为一致).
//   - 清洗后为空 → 返 null (caller 当失败处理).
function cleanResultText(raw: string): string | null {
  let s = (raw || "").trim();
  if (!s) return null;

  // 剥 markdown 噪音
  s = s.replace(/^#+\s*/, "");
  s = s.replace(/`/g, "");
  s = s.replace(/^>\s*/, "");
  // 剥包裹引号
  s = s.replace(/^["'"'"「」『』\[]+/, "");
  s = s.replace(/["'"'"」』\]]+$/, "");
  // 剥前缀编号 (1. 2. - * 等)
  s = s.replace(/^[\-\*\.\d]+\s+/, "");
  // 截断
  s = s.trim();
  if (!s) return null;
  // 超 hard cap 直接截断不加省略号 (damo 1007: 结尾「…」= 总结不到位; 展示层
  // CSS 自己截, 存储端留干净文本)
  if (s.length > MAX_OUTPUT_CHARS) {
    s = s.slice(0, MAX_OUTPUT_CHARS).trimEnd();
  }
  return s;
}
