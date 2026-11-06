// R200 批次 (damo 1007 chat): 卡片摘要「完成后后台预热」— 与 result-layers-store
// 同款骨架. damo 反馈: 卡片「干啥/有啥用」也是打开画布才排队 LLM (并发 3, 慢),
// 期望任务完成那一刻后台直接生成, 打开即显.
//
// 来源两级: metadata 缓存 (card_summary_v6) → LLM 生成 (统一 summary 链,
// card-summary-llm). 保留 card-summary 路由的迭代 9 闸门: result 为空 (非终态/
// failed 没留总结) 不调 LLM 不写缓存, 回 source:pending — 预热入口同样跳过.
// 缓存键 bump v5→v6 (damo 1010 拍板「该对齐就对齐」): 缓存加 result_len 校验,
// 任务重跑 (result 被覆盖) 后旧摘要判废重算, 与 result_layers_v3 防陈旧口径一致;
// 存量 v5 缓存一律按新标准重算 (懒生成或跑 scripts/warm-result-layers.ts 回填).

import { getTaskById, mutateTaskMetadata } from "../db/tasks";
import { generateCardSummary, type CardSummary } from "./card-summary-llm";
import type { Task } from "../db/tasks";

export const CARD_SUMMARY_CACHE_KEY = "card_summary_v6";

interface CachedCardSummary extends CardSummary {
  result_len: number; // result 长度变了 = 任务重跑过 → 缓存失效重算
  at: string; // ISO 时间, 审计用
}

export type EnsureCardSummarySource = "cache" | "llm" | "failed" | "pending";

export interface EnsureCardSummaryResult {
  summary: CachedCardSummary | null;
  source: EnsureCardSummarySource;
}

// 功能: 读 metadata 缓存里的卡片摘要 (干啥/有啥用, 空 shell / result_len 不匹配当没缓存).
// 关注点: 只读不生成 — 调用方 (任务详情路由) 用它把摘要直接带进 task payload,
//   信息面板不再走 Console 按需接口; 要生成走 ensureCardSummary.
export function readCachedCardSummary(task: Task): CachedCardSummary | null {
  if (!task.metadata) return null;
  try {
    const cached = JSON.parse(task.metadata)[CARD_SUMMARY_CACHE_KEY] as
      | CachedCardSummary
      | undefined;
    if (
      cached &&
      (cached.what || cached.why) &&
      typeof cached.result_len === "number" &&
      cached.result_len === (task.result || "").trim().length
    ) {
      return cached;
    }
  } catch {
    // metadata 脏 JSON → 当没缓存
  }
  return null;
}

function writeCache(task: Task, summary: CardSummary): void {
  const payload: CachedCardSummary = {
    ...summary,
    result_len: (task.result || "").trim().length,
    at: new Date().toISOString(),
  };
  try {
    mutateTaskMetadata(task.id, (meta) => {
      (meta as Record<string, unknown>)[CARD_SUMMARY_CACHE_KEY] = payload;
      return true;
    });
  } catch (err) {
    // 缓存写失败不阻断 (下次多算一次, 可接受)
    console.warn(`[card-summary] cache write failed for ${task.id}:`, err);
  }
}

// 进程内去重: 同任务并发 ensure (画布请求 + warm hook 竞态) 只跑一次.
const inflight = new Map<string, Promise<EnsureCardSummaryResult>>();

// 功能: 统一入口 — 缓存 → LLM 两级取卡片摘要, 结果写缓存.
// 关注点: 迭代 9 闸门前置 (result 空 → source:pending, 不调 LLM 不写缓存);
//   LLM 失败返回 source:failed 不写缓存 (下次还能重试); 同任务进程内去重.
export async function ensureCardSummary(
  task: Task,
  opts: { refresh?: boolean } = {},
): Promise<EnsureCardSummaryResult> {
  const existing = inflight.get(task.id);
  if (existing) return existing;

  const run = (async (): Promise<EnsureCardSummaryResult> => {
    const resultText = (task.result || "").trim();
    if (!resultText) return { summary: null, source: "pending" };

    if (!opts.refresh) {
      const cached = readCachedCardSummary(task);
      if (cached) return { summary: cached, source: "cache" };
    }

    const { summary } = await generateCardSummary(task);
    if (!summary) return { summary: null, source: "failed" };
    writeCache(task, summary);
    return {
      summary: { ...summary, result_len: resultText.length, at: new Date().toISOString() },
      source: "llm",
    };
  })();

  inflight.set(task.id, run);
  try {
    return await run;
  } finally {
    inflight.delete(task.id);
  }
}

// 功能: 后台预热入口 (active-session reviewing 落库后 fire-and-forget 调).
// 关注点: 永不 throw (调用点在关键路径上); 内部重取 task (调用方给的引用可能
//   已旧); result 空 (非终态) 由 ensureCardSummary 的 pending 闸门兜住.
export function warmCardSummaryForTask(taskId: string): void {
  void (async () => {
    try {
      const task = getTaskById(taskId);
      if (!task) return;
      await ensureCardSummary(task);
    } catch (err) {
      console.warn(`[card-summary] warm failed for ${taskId}:`, err);
    }
  })();
}
