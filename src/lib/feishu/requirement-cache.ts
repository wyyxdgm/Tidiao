// requirement-cache — 飞书 requirement_cache 表同步层 stub (飞书 R92 第二阶段, T3 档 0).
//
// 设计 (docs/plans/code-knowledge-index.md §3.2.4 档 0):
//   - 这是 JSDoc 档 0 bootstrap 要求的 6 个入口之一 (`refreshRequirementCache`).
//   - 实际需求缓存同步逻辑落在 caller (searchKnowledge.listStaleCacheErrors 提示路径),
//     本文件只暴露一个最小 stub 函数让 `@requirement` / `@feature` 标签能挂.
//   - 真要做同步拉取可另起 task (R92 后置), 不在 T3 范围.
//
// 关注点:
//   - refreshRequirementCache() = noop, 仅写库端契约. UI 触发走 /api/knowledge/refresh-cache.
//   - 路径存在 = L1 extract-code-symbols 能抽到 refreshRequirementCache 这个 export,
//     让 L2 业务衔接层 (T3) 的 code_business_links 找到对应 symbol_id.

/**
 * Stub: 触发 requirement_cache 表重新拉取 (飞书镜像同步). 当前为 noop 占位.
 *
 * @requirement 飞书 R92
 * @feature knowledge-recall
 * @module knowledge
 * @see-exclusive src/lib/db/knowledge.ts:574 listStaleCacheErrors
 * @see-info scripts/ao-recall.sh --refresh-cache
 */
export function refreshRequirementCache(versionId?: string): {
  refreshed: number;
  errors: string[];
} {
  // 占位实现: 当前 caller 走 POST /api/knowledge/refresh-cache (R92),
  // 本函数无业务逻辑, 仅作为 JSDoc 档 0 的 6 个入口之一.
  void versionId;
  return { refreshed: 0, errors: ["refreshRequirementCache 是 T3 档 0 stub; 实际同步走 /api/knowledge/refresh-cache"] };
}