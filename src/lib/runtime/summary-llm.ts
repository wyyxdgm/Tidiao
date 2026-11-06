// R200 turn2 (damo 1006 chat 反馈): 系统统一 summary 模型 + 运行时 fallback 链.
//
// 背景: result-layers / card-summary / auto-rename 标题 三处摘要类 LLM 调用
//   原先各自走「任务配置链一跳 → env 兜底」的复制粘贴骨架, 且 v514 (R175) 给
//   llm_configs 建的 fallback_ids 链只有存储和 UI, 运行时从未消费 (死机制).
//   damo 拍板: 摘要类调用统一走系统配置的 summary 模型, 且要支持 fallback 链.
//
// 链序 (resolveSummaryLlmChain):
//   1. app_settings.summary_llm_config_id 指向的配置 (系统统一 summary 模型)
//      + 该配置自身的 fallback_ids 链 (R175 已有字段, 本模块首次真正消费)
//   2. 任务自身 LLM 配置链 (resolveLlmConfig, 原行为兜底)
//   3. server env 凭据 (ANTHROPIC_* / bigmodel→glm-5.3, 原第二跳)
// 每跳模型名强制跟配置走 (13001 实测: A 家 key 配 B 家模型名 → 400).
//
// 消费方: result-layers-llm / card-summary-llm / llm-summarize.summarizeTitle
//   统一改调 runSummaryLlmTurn — 一处链序, 三处复用.

import {
  getLlmConfigById,
  parseFallbackIds,
  resolveLlmConfig,
} from "../db/llm-configs";
import { getSetting } from "../db/settings";
import { decrypt } from "../crypto";
import { runSingleTurnLlm } from "./llm-summarize";
import type { LlmConfig } from "../db/llm-configs";
import type { Task } from "../db/tasks";

/** app_settings 键: 系统 summary 模型 = 指向一条 llm_config (fallback 链跟它的 fallback_ids). */
export const KEY_SUMMARY_LLM_CONFIG_ID = "summary_llm_config_id";

export interface SummaryLlmEntry {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  source: string; // 调试用: summary_config / fallback:<i> / task_chain / env
}

// SDK 把鉴权失败/配额死当 success result 文本吐回 (不 throw) — 识别后跳下一跳.
// 🔴 1007 线上实证: ark 配置月配额爆掉 (AccountQuotaExceeded 429) 时 SDK 吐
//   「Not logged in · Please run /login」—— 不在旧正则里 → 链停在死跳, 后面
//   健康 hop 永远轮不到 (ao-prod 全部 summary 失败的根因). 三类都要认.
const AUTH_FAIL_RE =
  /failed to authenticate|invalid api key|unauthorized|401|not logged in|please run\s*\/login|quotaexceeded|quota exceeded/i;

// 功能: 解密单条配置 → 链成员. key 没配 / 解密失败 → null (跳过该跳).
// 关注点: 没存 key 的配置必产出「Not logged in」死跳 (SDK 无凭据可用) — 直接
//   跳过, 不让它进链浪费一跳.
function toEntry(cfg: LlmConfig | null, source: string): SummaryLlmEntry | null {
  if (!cfg) return null;
  let apiKey: string | undefined;
  if (cfg.api_key_encrypted && cfg.api_key_iv && cfg.api_key_tag) {
    try {
      apiKey = decrypt(cfg.api_key_encrypted, cfg.api_key_iv, cfg.api_key_tag);
    } catch (err) {
      console.warn(`[summary-llm] decrypt failed for config ${cfg.id}:`, (err as Error).message);
      return null;
    }
  }
  if (!cfg.model) return null;
  if (!apiKey) return null; // 无 key 配置 = 必死跳, 不进链
  return { model: cfg.model, apiKey, baseUrl: cfg.base_url || undefined, source };
}

// 功能: 解析 summary LLM 的完整 fallback 链 (纯读, 不发请求).
// 关注点: 配置被删 / 键缺失 / 解密失败 → 静默跳过该跳 (warn 落日志), 链永远
//   以 env 兜底收尾 — 调用方无需处理空链.
export function resolveSummaryLlmChain(task: Task): SummaryLlmEntry[] {
  const entries: SummaryLlmEntry[] = [];
  const push = (e: SummaryLlmEntry | null) => {
    if (!e) return;
    // 去重: 同 model+key+base 的重复跳没意义 (重试同死配置纯浪费)
    const dup = entries.some(
      (x) => x.model === e.model && x.apiKey === e.apiKey && x.baseUrl === e.baseUrl,
    );
    if (!dup) entries.push(e);
  };

  // 1) 系统统一 summary 配置 + 其 fallback_ids 链
  const sid = (getSetting(KEY_SUMMARY_LLM_CONFIG_ID) || "").trim();
  if (sid) {
    const head = getLlmConfigById(sid);
    push(toEntry(head, "summary_config"));
    for (const fid of parseFallbackIds(head?.fallback_ids ?? null)) {
      push(toEntry(getLlmConfigById(fid), `fallback:${fid.slice(0, 8)}`));
    }
  }

  // 2) 任务自身配置链 (原第一跳, 行为兼容)
  const taskCfg = resolveLlmConfig({
    model: task.model,
    owner_id: task.owner_id,
    project_id: task.project_id,
    llm_config_id:
      (task as unknown as { llm_config_id?: string | null }).llm_config_id ?? null,
  });
  push({
    model: taskCfg.model || "",
    apiKey: taskCfg.api_key,
    baseUrl: taskCfg.base_url,
    source: "task_chain",
  });

  // 3) env 兜底 (原第二跳; 模型名匹配网关: bigmodel → glm-5.3)
  const base = process.env.ANTHROPIC_BASE_URL || "";
  push({
    model:
      process.env.ANTHROPIC_MODEL ||
      (base.includes("bigmodel") ? "glm-5.3" : "") ||
      taskCfg.model ||
      "",
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: base || undefined,
    source: "env",
  });

  return entries.filter((e) => e.model);
}

// 功能: summary 类调用的统一入口 — 按链逐跳跑 single-turn LLM, 死 key / 鉴权
//   失败自动跳下一跳, 全链失败返 raw=null.
// 关注点: systemPrompt 不进 SDK (runSingleTurnLlm 限制), caller 必须把指令拼进
//   userPrompt (三处消费方现状已如此); 空 raw 字符串是合法成功, 由 caller 的
//   解析函数判废.
export async function runSummaryLlmTurn(
  systemPrompt: string,
  userPrompt: string,
  task: Task,
): Promise<{ raw: string | null; model: string }> {
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const chain = resolveSummaryLlmChain(task);
  let lastModel = chain[0]?.model || "";
  for (const entry of chain) {
    lastModel = entry.model;
    const envOverrides: Record<string, string | undefined> = {
      ANTHROPIC_MODEL: entry.model,
      // 与任务主路径 (active-session buildEnv) 同政策: 显式 delete 残留的
      //   AUTH_TOKEN 占位, 防 CLI 优先用无效 Bearer 凭据吐「Not logged in」.
      ANTHROPIC_AUTH_TOKEN: undefined,
    };
    if (entry.apiKey) envOverrides.ANTHROPIC_API_KEY = entry.apiKey;
    if (entry.baseUrl) envOverrides.ANTHROPIC_BASE_URL = entry.baseUrl;
    const raw = await runSingleTurnLlm(systemPrompt, fullPrompt, entry.model, envOverrides);
    if (raw === null) continue; // SDK 异常 / 非成功 subtype → 下一跳
    if (AUTH_FAIL_RE.test(raw.slice(0, 200))) continue; // 鉴权失败文本 → 下一跳
    return { raw, model: entry.model };
  }
  return { raw: null, model: lastModel };
}
