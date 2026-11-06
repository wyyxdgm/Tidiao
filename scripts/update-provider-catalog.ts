/**
 * update-provider-catalog.ts — 供应商目录模型列表日更 (R240).
 *
 * 对 catalog.json 里每家 provider.models_fetch 配置的 OpenAI 兼容 /models 端点
 * 拉最新模型列表, 过滤非 LLM 条目 (embedding/rerank/tts 等), 写回 catalog.json
 * (排序稳定, 便于 git diff). key 从环境变量拿:
 *   PROVIDER_ARK_API_KEY / PROVIDER_DEEPSEEK_API_KEY / PROVIDER_ZHIPU_API_KEY /
 *   PROVIDER_MOONSHOT_API_KEY / PROVIDER_MINIMAX_API_KEY / PROVIDER_BAILIAN_API_KEY /
 *   PROVIDER_SILICONFLOW_API_KEY / PROVIDER_HUNYUAN_API_KEY
 * 没 key 的厂商跳过并保留原列表 (脚本 exit 0, 部分成功也算成功 — 日更 cron 别因单家失败挂掉).
 *
 * 用法:
 *   jiti scripts/update-provider-catalog.ts           # 拉取 + 写回 catalog.json
 *   jiti scripts/update-provider-catalog.ts --check   # 只 diff 不写 (cron 里先 check 后写)
 *
 * cron 建议 (平台 ao cron, 每日一次):
 *   cd <repo> && jiti scripts/update-provider-catalog.ts && git add src/lib/provider-catalog/catalog.json && git commit -m "chore: provider catalog daily models update" || true
 *
 * 关注点: 单家 fetch 12s 超时 + 失败不阻断其他家; 写回走 JSON.stringify(2) 与
 *         手工编辑格式一致, 避免全文件重写噪声 diff; models_fetch 为 null 的厂商跳过.
 */

import fs from "node:fs";
import path from "node:path";

interface ModelsFetch {
  url: string;
  auth?: string;
}
interface Provider {
  id: string;
  name: string;
  models_fetch?: ModelsFetch | null;
  models: string[];
  models_updated_at: string;
  [k: string]: unknown;
}
interface Catalog {
  schema_version: number;
  updated_at: string;
  providers: Provider[];
}

const CHECK_ONLY = process.argv.includes("--check");
const FETCH_TIMEOUT_MS = 12_000;
const TODAY = new Date().toISOString().slice(0, 10);

// 非 LLM 条目过滤 — OpenAI 兼容 /models 会混入 embedding/audio 等, Anthropic 协议用不上.
const EXCLUDE_RE =
  /embedding|rerank|moderation|tts|asr|speech|audio|voice|whisper|vector|image|vision-enc|ocr|translat|dubbing/i;

function catalogPath(): string {
  return path.join(process.cwd(), "src", "lib", "provider-catalog", "catalog.json");
}

function keyEnvName(id: string): string {
  return `PROVIDER_${id.toUpperCase()}_API_KEY`;
}

/** 宽松解析: 标准是 {data:[{id}]}, 兜底 {models:[{id}|"x"]} / 裸数组. */
function extractModelIds(body: unknown): string[] {
  const arr: unknown[] =
    (body as { data?: unknown[] })?.data ??
    (body as { models?: unknown[] })?.models ??
    (Array.isArray(body) ? body : []);
  return arr
    .map((m) => (typeof m === "string" ? m : (m as { id?: string })?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function fetchModels(p: Provider): Promise<{ added: string[]; removed: string[]; error?: string }> {
  const key = process.env[keyEnvName(p.id)];
  if (!p.models_fetch) return { added: [], removed: [], error: "no models_fetch config" };
  if (!key) return { added: [], removed: [], error: `missing env ${keyEnvName(p.id)}` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(p.models_fetch.url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { added: [], removed: [], error: `HTTP ${res.status}` };
    }
    const body: unknown = await res.json();
    const ids = extractModelIds(body).filter((id) => !EXCLUDE_RE.test(id));
    const next = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const prev = new Set(p.models);
    return {
      added: next.filter((m) => !prev.has(m)),
      removed: p.models.filter((m) => !next.includes(m)),
      // 写回时用 next
      ...( { __next: next } as object),
    } as { added: string[]; removed: string[]; error?: string };
  } catch (e) {
    return { added: [], removed: [], error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const file = catalogPath();
  const catalog = JSON.parse(fs.readFileSync(file, "utf-8")) as Catalog;
  let changed = 0;
  let skipped = 0;

  for (const p of catalog.providers) {
    const r = await fetchModels(p);
    const nextList = (r as { __next?: string[] }).__next;
    if (r.error || !nextList) {
      console.log(`[skip] ${p.id}: ${r.error}`);
      skipped++;
      continue;
    }
    if (r.added.length === 0 && r.removed.length === 0) {
      console.log(`[ok]   ${p.id}: 无变化 (${nextList.length} models)`);
      p.models = nextList; // 仍回写排序后的列表, 归一化手工编辑残留
      continue;
    }
    console.log(
      `[upd]  ${p.id}: +${r.added.length} -${r.removed.length}` +
        (r.added.length <= 10 ? `  新增: ${r.added.join(", ")}` : "") +
        (r.removed.length <= 10 && r.removed.length > 0 ? `  移除: ${r.removed.join(", ")}` : ""),
    );
    p.models = nextList;
    p.models_updated_at = TODAY;
    changed++;
  }

  if (changed > 0) catalog.updated_at = TODAY;

  if (CHECK_ONLY) {
    console.log(
      `\n--check 完成: ${changed} 家有变化, ${skipped} 家跳过 (无 key/失败). 未写回.`,
    );
    process.exit(changed > 0 ? 1 : 0); // 有变化 exit 1, 方便 cron 判断
  }

  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`\n已写回 ${path.relative(process.cwd(), file)}: ${changed} 家更新, ${skipped} 家跳过.`);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(2);
});
