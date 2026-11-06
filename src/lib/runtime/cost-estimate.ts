// 功能: 把 token 用量折算成美元估算值, 用于「SDK 没给 total_cost_usd」的场景
//   (会话被 interrupt/pause/cancel 打断, 永远走不到 result 消息).
// 关注点:
//   - 🔴 这是估算, 不是账单. 落库时必须同时标 cost_source='estimated', 否则
//     它会假装成实测值污染成本统计.
//   - 单价是「一个量级正确的折中值」: 平台跨多家供应商(Anthropic / 火山方舟 Ark /
//     glm / astron), 各家单价不同且会变, 这里不做 per-model 定价表 —— 维护
//     一张会过期的价格表比一个标注为估算的量级值更危险(过期的表看起来精确).
//     需要精确成本时看 cost_source='measured' 的那些任务。
//   - cache_read 单价远低于 input(约 1/10), 分开折算, 否则长会话会高估几倍。

// 每百万 token 单价(USD). 取值依据: 本机 14 天实测 197 条 measured 任务,
// 均价 $2.74/任务, 用这组单价回算量级吻合。
const USD_PER_MTOK_INPUT = 3.0;
const USD_PER_MTOK_OUTPUT = 15.0;
const USD_PER_MTOK_CACHE_READ = 0.3;
const USD_PER_MTOK_CACHE_WRITE = 3.75;

// 拿不到任何 token 时给的最小估算值. 不能是 0 —— 调用方普遍用 `cost > 0` 判断
// 「有没有数据」, 返回 0 会让它重新退回 NULL, 而 NULL 正是本次要消灭的东西。
const MIN_ESTIMATE_USD = 0.0001;

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// per-model 单价 (USD / 百万 token). 来自 llm_configs 的 price_* 列, null = 该档未配置.
export interface ModelPrices {
  in: number | null;
  out: number | null;
  cacheRead: number | null;
}

// 功能: 判断是否配置了至少一档单价 (全空 = 没配, 调用方应回落原机制).
export function hasAnyPrice(p: ModelPrices | null): p is ModelPrices {
  if (!p) return false;
  return [p.in, p.out, p.cacheRead].some((v) => v != null && v > 0);
}

// 功能: 按配置单价折算 token → 美元 (cost_source='priced' 的数据源).
// 关注点: 未配置的档位按 0 计, 不回落折中价 —— 半配置时「缺档补折中价」会拼接出
//   两个来源的杂交值, 比单纯低估更难排查. 所以调用方必须先过 hasAnyPrice.
//   cache_write 平台代理普遍不回传 (实测 125 条估算任务全 0), 不设价, 按 0 计.
export function estimateCostWithPrices(u: TokenUsage, p: ModelPrices): number {
  const cost =
    ((u.input || 0) * (p.in || 0) +
      (u.output || 0) * (p.out || 0) +
      (u.cacheRead || 0) * (p.cacheRead || 0)) /
    1_000_000;
  if (!Number.isFinite(cost) || cost <= 0) return MIN_ESTIMATE_USD;
  return Math.max(MIN_ESTIMATE_USD, Math.round(cost * 1e6) / 1e6);
}

// 功能: 系数基准价 = 输入价 + 输出价 (headline 两档直加).
// 关注点: 刻意不用 token 量加权 —— 系数是给用户看的「相对贵几倍」直观值, 不是账单;
//   各平台 token 配比不同, 加权反而引入一个解释不了的隐含参数. cache 价差约一个
//   量级且平台代理 output 常缺报, 都不进系数.
export function blendedPrice(p: ModelPrices): number {
  return (p.in || 0) + (p.out || 0);
}

// 功能: 模型系数 = 本配置基准价 / 基准配置基准价; 基准未配价或分母 ≤0 返 null (UI 显「—」).
export function priceCoefficient(p: ModelPrices, baseline: ModelPrices): number | null {
  const denom = blendedPrice(baseline);
  if (denom <= 0) return null;
  const ratio = blendedPrice(p) / denom;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return Math.round(ratio * 100) / 100;
}

// 功能: token → 美元估算. 恒返回 >0 的数(见 MIN_ESTIMATE_USD 的理由).
export function estimateCostUsd(u: TokenUsage): number {
  const cost =
    ((u.input || 0) * USD_PER_MTOK_INPUT +
      (u.output || 0) * USD_PER_MTOK_OUTPUT +
      (u.cacheRead || 0) * USD_PER_MTOK_CACHE_READ +
      (u.cacheWrite || 0) * USD_PER_MTOK_CACHE_WRITE) /
    1_000_000;
  if (!Number.isFinite(cost) || cost <= 0) return MIN_ESTIMATE_USD;
  // 保留 6 位, 避免浮点尾巴写进库里
  return Math.max(MIN_ESTIMATE_USD, Math.round(cost * 1e6) / 1e6);
}
