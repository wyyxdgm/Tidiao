// 功能: 供应商目录 composable (R240) — 拉 /api/provider-catalog, 给 LLM 编辑表单的
// 「快捷选择供应商」下拉喂数据. 选中厂商 → 表单自动填 base_url + 模型 datalist 切到
// 该厂商 models → 用户只需填 key.
// 关注点: fetch 失败不阻塞表单 (下拉隐藏, 手填流程照旧); SSR-safe onMounted 后拉.

import { ref, onMounted, type Ref } from 'vue';

export interface CatalogProvider {
  id: string;
  name: string;
  vendor: string;
  website: string;
  api_key_url: string;
  anthropic_base_url: string;
  anthropic_verified: string;
  models: string[];
  models_updated_at: string;
  notes?: string | null;
}

export interface ProviderCatalog {
  schema_version: number;
  updated_at: string;
  providers: CatalogProvider[];
}

export interface UseProviderCatalogResult {
  providers: Ref<CatalogProvider[]>;
  catalogUpdatedAt: Ref<string | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
}

export function useProviderCatalog(): UseProviderCatalogResult {
  const providers = ref<CatalogProvider[]>([]);
  const catalogUpdatedAt = ref<string | null>(null);
  const loading = ref<boolean>(true);
  const error = ref<string | null>(null);

  onMounted(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/provider-catalog', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ProviderCatalog = await res.json();
        if (cancelled) return;
        providers.value = data.providers ?? [];
        catalogUpdatedAt.value = data.updated_at ?? null;
      } catch (e) {
        if (cancelled) return;
        error.value = (e as Error).message || 'fetch failed';
      } finally {
        if (!cancelled) loading.value = false;
      }
    })();
    return () => { cancelled = true; };
  });

  return { providers, catalogUpdatedAt, loading, error };
}
