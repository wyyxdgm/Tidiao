// R200 (damo 1006 飞书): 细节流程「后台自主处理 + 打开即显」— 结果分层的缓存
// 与统一写入层. damo 反馈: LLM 分层只在点开弹窗时才生成, 慢到不可接受; 期望
// 后台自主处理, 打开直接显示.
//
// R200 turn2 (damo 1006 chat): 原「checkpoints 组装」中间层整层撤除 — damo
// 反馈 checkpoints 质量不好、不可控 (切片常是半句黑话), 细节流程一律走 LLM
// 生成 (统一 summary 链, result-layers-llm). 来源收敛为两级:
//   1. metadata 缓存 (result_layers_v2, 沿用 R190 v2 键 — 老路由也能直接读)
//   2. LLM 生成 (result-layers-llm, 50s 竞速超时, R190 原路径)
// 结果统一写回 metadata 缓存 — 前端永远读缓存形态, 打开即显.
//
// 后台自主处理 (damo「关页面也继续」): active-session 在 result → reviewing
// 落库后 fire-and-forget 调 warmResultLayersForTask — 进程内跑完写缓存,
// 与浏览器无关. 存量任务走 scripts/warm-result-layers.ts 批量回填.

import { getTaskById, mutateTaskMetadata } from "../db/tasks";
import { generateResultLayers, type ResultLayers } from "./result-layers-llm";
import type { Task } from "../db/tasks";

/** 缓存键 — v3 (damo 1007): 口径升级 (概览收紧 1~3 句优先 + 新增【下一步】段 +
 *  输入剥运行时标记), 存量 v2 缓存按新标准全部重算; 打开懒生成或跑
 *  scripts/warm-result-layers.ts 回填. */
export const RESULT_LAYERS_CACHE_KEY = "result_layers_v3";

export interface CachedResultLayers extends ResultLayers {
  result_len: number; // result 长度变了 = 任务重跑过 → 缓存失效重算
  at: string; // ISO 时间, 审计用
  src: "llm"; // 生成来源 (R200 turn2 起 checkpoints 来源退役, 仅剩 llm)
}

export type EnsureLayersSource = "cache" | "llm" | "failed";

export interface EnsureLayersResult {
  layers: CachedResultLayers | null;
  source: EnsureLayersSource;
}

// 功能: 读 metadata 缓存里的分层总结 (带 result_len/src 校验, 不匹配当没缓存).
// 关注点: 只读不生成 — 调用方 (任务详情路由) 用它把总结直接带进 task payload,
//   信息面板不再走 Console 按需接口; 要生成走 ensureResultLayers.
export function readCachedResultLayers(task: Task): CachedResultLayers | null {
  if (!task.metadata) return null;
  try {
    const cached = JSON.parse(task.metadata)[RESULT_LAYERS_CACHE_KEY] as
      | CachedResultLayers
      | undefined;
    if (
      cached &&
      // R200 turn2: 仅 src='llm' 算有效 — 旧 checkpoints 源缓存一律重算
      cached.src === "llm" &&
      typeof cached.result_len === "number" &&
      cached.result_len === (task.result || "").trim().length &&
      (cached.brief || (cached.details?.length ?? 0) > 0)
    ) {
      return cached;
    }
  } catch {
    // metadata 脏 JSON → 当没缓存
  }
  return null;
}

function writeCache(task: Task, layers: ResultLayers): void {
  const payload: CachedResultLayers = {
    ...layers,
    result_len: (task.result || "").trim().length,
    at: new Date().toISOString(),
    src: "llm",
  };
  try {
    mutateTaskMetadata(task.id, (meta) => {
      (meta as Record<string, unknown>)[RESULT_LAYERS_CACHE_KEY] = payload;
      return true;
    });
  } catch (err) {
    // 缓存写失败不阻断 (下次多算一次, 可接受)
    console.warn(`[result-layers] cache write failed for ${task.id}:`, err);
  }
}

// 进程内去重: 同任务并发 ensure (弹窗打开 + warm hook 竞态) 只跑一次.
const inflight = new Map<string, Promise<EnsureLayersResult>>();

// 功能: 统一入口 — 缓存 → LLM 两级取分层, 结果写缓存.
// 关注点: 同任务进程内去重 (inflight Map); LLM 失败返回 source:failed 不写缓存
//   (下次还能重试); 调用方 (路由 / runtime warm / 回填脚本) 共享同一逻辑.
export async function ensureResultLayers(
  task: Task,
  opts: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<EnsureLayersResult> {
  const existing = inflight.get(task.id);
  if (existing) return existing;

  const run = (async (): Promise<EnsureLayersResult> => {
    const resultLen = (task.result || "").trim().length;
    if (!opts.refresh) {
      const cached = readCachedResultLayers(task);
      if (cached) return { layers: cached, source: "cache" };
    }

    // timeoutMs 透传 (回填脚本传 180s 宽窗口; 默认 50s 用户点开场景)
    const { layers } = await generateResultLayers(task, { timeoutMs: opts.timeoutMs });
    if (!layers || (!layers.brief && layers.details.length === 0)) {
      return { layers: null, source: "failed" };
    }
    writeCache(task, layers);
    return {
      layers: { ...layers, result_len: resultLen, at: new Date().toISOString(), src: "llm" },
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
//   已旧); 短 result 直接跳过 (与路由 skip 阈值同口径, 阈值判断在路由/脚本侧).
export function warmResultLayersForTask(taskId: string): void {
  void (async () => {
    try {
      const task = getTaskById(taskId);
      if (!task || !(task.result || "").trim()) return;
      // 1008 线上实证: warm 用交互档 50s 会系统性超时 (thinking 模型单跳实测
      //   22~35s, 服务器有并发负载时冲不进 50s → 任务完成时预热全灭, 详情永远
      //   没有细节流程). warm 无人在等, 与回填脚本同款 180s 宽窗口.
      await ensureResultLayers(task, { timeoutMs: 180_000 });
    } catch (err) {
      console.warn(`[result-layers] warm failed for ${taskId}:`, err);
    }
  })();
}
