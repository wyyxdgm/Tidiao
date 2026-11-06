// bge-small — Code Knowledge Index L3 Embedding 层 (飞书 R92 第二阶段, T4).
//
// 设计要点:
//   - 用本地 bge-small-en-v1.5 (Xenova/transformers.js 量化版, 384 维, 33MB).
//   - D3 拍板本地模型: 离线可用, 中文一般 (cosine ~0.6), 英文 / 代码 symbol 较好.
//   - 懒加载: 首次调 embed() 才拉模型 (358ms 冷启动), 后续走缓存.
//   - 批量支持: embedBatch() 并发跑, 对 100 个 chunk ~2s.
//   - 永不抛错: 任何失败 (模型未下 / OOM / 输入空) 返空 Float32Array (0 维),
//     caller 据 score=0 过滤.
//   - 8000 字符截断: bge-small 实际 token 上限 512, 8000 字符 ≈ 2000 token,
//     留 buffer 给 tokenizer 兜底.
//
// 关注点:
//   - @xenova/transformers 是 ESM (type: module), 本仓 CJS — 必须用 dynamic
//     import() 才能从 CJS 调, 顶层 import 会让 vitest / next build 崩.
//   - env.allowRemoteModels = false (D3 不引 OpenAI, 但 transformers 自身也走
//     HF Hub, 关掉 remote 防止意外拉远端模型, 强制走本地).
//   - 模型本地路径: node_modules/@xenova/transformers/models/Xenova/bge-small-en-v1.5/
//     (transformers 默认 localModelPath), 模型文件 5 个, 共 ~34MB. 首次拉:
//       mkdir -p node_modules/@xenova/transformers/models/Xenova/bge-small-en-v1.5/onnx
//       从 HF Hub curl 5 个文件到上路径. 见 plan §3.3 已知坑.
//   - 不在生产禁用 cache (env.allowLocalModels = true 是 transformers 自己的开关).

import { createHash } from "node:crypto";

const MODEL_ID = "Xenova/bge-small-en-v1.5";
const MAX_INPUT_CHARS = 8000; // 截断上限 (plan §3.3 + 任务提示词 §4.1)

// ---- 动态 import ESM module ----

type TransformersModule = typeof import("@xenova/transformers");

let transformersModule: TransformersModule | null = null;

async function getTransformers(): Promise<TransformersModule | null> {
  if (transformersModule) return transformersModule;
  try {
    // dynamic import — ESM 模块从 CJS 调的唯一合规姿势.
    transformersModule = (await import("@xenova/transformers")) as TransformersModule;
    // 强制本地模式 — 防止意外走 HF Hub (D3 兜底 + 网络隔离).
    transformersModule.env.allowRemoteModels = false;
    transformersModule.env.allowLocalModels = true;
    return transformersModule;
  } catch {
    return null;
  }
}

// ---- pipeline 懒加载 ----

type FeatureExtractor = (
  input: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<FeatureExtractor | null> | null = null;

async function getExtractor(): Promise<FeatureExtractor | null> {
  if (!extractorPromise) {
    extractorPromise = (async (): Promise<FeatureExtractor | null> => {
      const t = await getTransformers();
      if (!t) return null;
      try {
        const ex = await t.pipeline("feature-extraction", MODEL_ID);
        return ex as unknown as FeatureExtractor;
      } catch {
        return null;
      }
    })();
  }
  return extractorPromise;
}

// ---- 公开接口 ----

/**
 * 把单段文本编码为 384 维 Float32 向量 (已 L2 归一化, norm=1).
 * 失败返长度 0 的 Float32Array (永不抛错).
 *
 * @requirement 飞书 R92
 * @feature knowledge-recall
 * @module knowledge
 * @see-exclusive src/lib/db/code-embeddings.ts:42 searchByVector
 */
export async function embed(text: string): Promise<Float32Array> {
  try {
    const input = (text ?? "").slice(0, MAX_INPUT_CHARS);
    if (!input.trim()) return new Float32Array(0);
    const ex = await getExtractor();
    if (!ex) return new Float32Array(0);
    const out = await ex(input, { pooling: "mean", normalize: true });
    // out.data 已是 Float32Array (transformers.js 返回类型), 不转 Buffer.
    return out.data;
  } catch {
    return new Float32Array(0);
  }
}

/**
 * 批量嵌入 — 给 scripts/extract-code-embeddings.ts 用.
 * 失败项返 0 维 Float32Array (caller 据此过滤); 不整体抛错.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  // transformers.js 内部已并行 + 复用 ONNX session, 直接并发调最快.
  return Promise.all(texts.map((t) => embed(t)));
}

// ---- BLOB 序列化工具 (DB 存 vector BLOB) ----

/**
 * Float32Array → Buffer (BLOB). 顺序: little-endian float32 (Node 默认).
 */
export function float32ToBuffer(vec: Float32Array): Buffer {
  if (!vec || vec.length === 0) return Buffer.alloc(0);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Buffer (BLOB) → Float32Array (cosine 计算前还原).
 */
export function bufferToFloat32(buf: Buffer): Float32Array {
  if (!buf || buf.byteLength === 0) return new Float32Array(0);
  // Buffer 可直接 view 为 Float32Array (与 Node Buffer 共享 ArrayBuffer).
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---- cosine similarity ----

/**
 * 两个 L2 归一化向量的 cosine similarity. 输入为空或长度不等返 0.
 * bge-small 默认 normalize=true 输出 norm=1 向量, 故 dot = cosine.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  // 已归一化 → dot 即 cosine; clamp 防浮点误差 > 1.
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}

/**
 * 给定 query 向量 + N 个候选向量 + 各自 file:line 元数据, 返回 score desc topK.
 * threshold 默认 0.7 (plan §5 约束 2); 低于阈值过滤掉 (不显示 = 不误导).
 */
export function topKByCosine(
  queryVec: Float32Array,
  candidates: Array<{ id: string; vector: Buffer; meta: Record<string, unknown> }>,
  options: { limit?: number; threshold?: number } = {}
): Array<{ id: string; score: number; meta: Record<string, unknown> }> {
  const threshold = options.threshold ?? 0.7;
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  if (!queryVec || queryVec.length === 0) return [];

  const scored: Array<{ id: string; score: number; meta: Record<string, unknown> }> = [];
  for (const c of candidates) {
    const vec = bufferToFloat32(c.vector);
    const score = cosineSimilarity(queryVec, vec);
    if (score >= threshold) {
      scored.push({ id: c.id, score, meta: c.meta });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---- 预热 / 健康检查 ----

/**
 * 测试 / 自检用 — 主动触发模型加载, 把 358ms 冷启动挪到启动期.
 * 失败不抛错 (永返回 false), caller 据此判断是否禁用 embedding 源.
 */
export async function warmup(): Promise<boolean> {
  try {
    const ex = await getExtractor();
    if (!ex) return false;
    // 跑一个最小 embedding 触发 ONNX session 完整初始化.
    await ex("warmup", { pooling: "mean", normalize: true });
    return true;
  } catch {
    return false;
  }
}

// ---- id 派生 (file chunk: 整文件 hash; 与 code_symbols.id 算法不同) ----

/**
 * file chunk 的 id = sha1(file_path).slice(0,16) (16 hex = 64 bit, 比 L1 多
 * 几位, 减少同文件多次嵌入冲突). L1 用 sha1(absPath).slice(0,8) + ":line" —
 * 这里不用 line, 因为 file chunk 没 line 概念 (整文件一段).
 */
export function fileChunkId(relFile: string): string {
  return createHash("sha1").update(relFile).digest("hex").slice(0, 16);
}
