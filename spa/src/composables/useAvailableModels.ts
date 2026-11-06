// 功能: 模型下拉数据源 composable — Vue 3 复刻 master useAvailableModels.
//
// 数据 = llm_configs.model (用户配的) + MODEL_OPTIONS 常量 (兜底) + 历史 task.model.
// 三者并集去重, label 带 source 标记 [已配置] / [内置] / [历史].
//
// 选项顺序:
//   1. 默认空 option (前端用 "value=''" 走链路默认)
//   2. configured (从用户 llm_configs.model, 含 admin_grant)
//   3. builtin (MODEL_OPTIONS 常量, 但只在 configured 没覆盖时)
//   4. used (历史 task.model, 但只在上面都没覆盖时)
//
// 关注点:
//   - SSR-safe: fetch 在 onMounted 后触发, 首屏返回 loading 状态.
//   - 任一 fetch 失败 → 不阻塞 UI, 退化成只显示 MODEL_OPTIONS (兜底常在).
//   - 不暴露 api_key/has_api_key (AvailableLlmConfig 不含, 安全).

import { ref, computed, onMounted, type Ref, type ComputedRef } from 'vue';
import { i18n } from '@/i18n';

export type ModelOptionSource = 'default' | 'configured' | 'builtin' | 'used';

export interface ModelOption {
  value: string;
  label: string;
  source: ModelOptionSource;
}

interface AvailableLlmConfigRaw {
  id?: string;
  source?: string;
  name?: string;
  model?: string | null;
}

/** MODEL_OPTIONS 常量兜底 — 与 master src/lib/constants.ts MODEL_OPTIONS 对齐.
 *  i18n (W4.5b): label 含中文的走 locale (聚合函数运行时 t(), 语言切换跟新). */
const BUILTIN_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string | (() => string) }> = [
  { value: 'astron-code-latest', label: () => i18n.global.t('misc.models.astronCode') },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'glm-latest', label: 'GLM-Latest' },
  { value: 'MiniMax-M3', label: 'MiniMax-M3' },
  { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
  { value: 'doubao-seed-2.1-turbo', label: 'Doubao-Seed-2.1-Turbo' },
  { value: 'doubao-seed-2.0-pro', label: 'Doubao-Seed-2.0-Pro' },
  { value: 'doubao-seed-2.0-lite', label: 'Doubao-Seed-2.0-Lite' },
];

/** 纯函数: 把 configs + used models + MODEL_OPTIONS 合并成去重 + source 标记的下拉选项.
 * 单独导出便于测试 / 复用到非 setup 上下文. */
export function aggregateModelOptions(
  configs: AvailableLlmConfigRaw[],
  usedModels: string[],
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [
    // i18n (W4.5b): 复用 misc.templates.llmDefault 同文案 key (模板下拉已用).
    { value: '', label: i18n.global.t('misc.templates.llmDefault'), source: 'default' },
  ];
  seen.add('');

  const pushUnique = (model: string, source: ModelOptionSource, label?: string | (() => string)) => {
    const m = model?.trim();
    if (!m || seen.has(m)) return;
    seen.add(m);
    const prefix =
      source === 'configured' ? ` ${i18n.global.t('misc.models.suffixConfigured')}`
      : source === 'used'      ? ` ${i18n.global.t('misc.models.suffixUsed')}`
      : '';
    const labelStr = typeof label === 'function' ? label() : label;
    out.push({
      value: m,
      label: `${m}${prefix}${labelStr ? ` (${labelStr})` : ''}`,
      source,
    });
  };

  for (const c of configs) {
    if (c.model) pushUnique(c.model, 'configured', c.name);
  }
  for (const opt of BUILTIN_MODEL_OPTIONS) {
    if (!opt.value) continue;
    if (seen.has(opt.value)) continue;
    pushUnique(opt.value, 'builtin', opt.label);
  }
  for (const m of usedModels) {
    pushUnique(m, 'used');
  }

  return out;
}

export interface UseAvailableModelsResult {
  options: ComputedRef<ModelOption[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
}

export function useAvailableModels(): UseAvailableModelsResult {
  const configs = ref<AvailableLlmConfigRaw[]>([]);
  const usedModels = ref<string[]>([]);
  const loading = ref<boolean>(true);
  const error = ref<string | null>(null);

  onMounted(() => {
    let cancelled = false;
    void (async () => {
      try {
        // SPA 已有 listAvailableLlmConfigs via api/templates, 但这里直接 fetch 走
        // 通用 /api/user/llm-config/available, 避免和 templates.ts 强耦合.
        const [cfgRes, usedRes] = await Promise.all([
          fetch('/api/user/llm-config/available', { credentials: 'include' }),
          fetch('/api/user/used-models', { credentials: 'include' }),
        ]);
        const [cfgData, usedData] = await Promise.all([
          cfgRes.ok ? await cfgRes.json().catch(() => null) : null,
          usedRes.ok ? await usedRes.json().catch(() => null) : null,
        ]);
        if (cancelled) return;
        configs.value = cfgData?.configs ?? [];
        usedModels.value = usedData?.models ?? [];
        if (cfgRes.status === 401 || usedRes.status === 401) {
          error.value = 'unauthorized';
        }
      } catch (e) {
        if (cancelled) return;
        error.value = (e as Error).message || 'fetch failed';
      } finally {
        if (!cancelled) loading.value = false;
      }
    })();
    return () => { cancelled = true; };
  });

  const options = computed<ModelOption[]>(() =>
    aggregateModelOptions(configs.value, usedModels.value),
  );

  return { options, loading, error };
}