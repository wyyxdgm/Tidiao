// 功能: 国内 LLM 厂商供应商目录 (R240) — 读取 catalog.json, 校验 + 缓存 + 查询.
// catalog.json 由 scripts/update-provider-catalog.ts 日更 (拉各厂商 /models merge),
// 用 fs 读而非 import → 脚本更新后 API 无需 rebuild 即生效.
// 关注点: 5s TTL 缓存 (高频请求不打盘); JSON 损坏时抛错带原因不静默吞;
//         matchProviderByBaseUrl 做大小写/尾斜杠归一后前缀匹配.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ModelsFetchSchema = z.object({
  /** OpenAI 兼容 models 列表端点 (GET). */
  url: z.string().url(),
  /** 目前只支持 bearer; 留扩展位. */
  auth: z.literal("bearer").default("bearer"),
});

const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  vendor: z.string().min(1),
  website: z.string().url(),
  api_key_url: z.string().url(),
  /** Anthropic 兼容端点 (裸 base, SDK 拼 /v1/messages). */
  anthropic_base_url: z.string().url(),
  /** 最近一次人工/脚本验证端点可达的日期 (YYYY-MM-DD). */
  anthropic_verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  models_fetch: ModelsFetchSchema.nullish(),
  models: z.array(z.string().min(1)),
  models_updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().nullish(),
});

export const CatalogSchema = z.object({
  schema_version: z.number().int().min(1),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providers: z.array(ProviderSchema),
});

export type Provider = z.infer<typeof ProviderSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

const CACHE_TTL_MS = 5_000;
let cache: { data: Catalog; loadedAt: number } | null = null;

function catalogPath(): string {
  return path.join(process.cwd(), "src", "lib", "provider-catalog", "catalog.json");
}

// 功能: 读取并校验供应商目录, 5s TTL 缓存.
// 关注点: fs.readFileSync 每次冷读走盘但 TTL 内复用; 解析/校验失败抛错 (调用方 500 带原因).
export function getProviderCatalog(): Catalog {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.data;
  const raw = fs.readFileSync(catalogPath(), "utf-8");
  const parsed = CatalogSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `provider-catalog: catalog.json 校验失败: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
    );
  }
  cache = { data: parsed.data, loadedAt: now };
  return parsed.data;
}

// 功能: 按 id 查单家供应商; 没有 → null.
export function getProviderById(id: string): Provider | null {
  return getProviderCatalog().providers.find((p) => p.id === id) ?? null;
}

// 功能: 按 base_url 反查供应商 (编辑已有 LLM 配置时自动高亮匹配项).
// 关注点: 归一化 = 去尾斜杠 + 小写 host 后「配置 url 以 provider url 为前缀」匹配;
//         claude-code-proxy 这类长路径天然满足前缀; 匹配不到返回 null (自定义中转站常态).
export function matchProviderByBaseUrl(baseUrl: string | null | undefined): Provider | null {
  if (!baseUrl) return null;
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  const target = norm(baseUrl);
  if (!target) return null;
  return (
    getProviderCatalog().providers.find(
      (p) => target === norm(p.anthropic_base_url) || target.startsWith(norm(p.anthropic_base_url)),
    ) ?? null
  );
}

/** 测试与脚本复用: 清缓存 (脚本写回 catalog.json 后强制下次冷读). */
export function resetCatalogCacheForTest(): void {
  cache = null;
}
