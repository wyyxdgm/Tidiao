"use client";

// useAvailableModels — 聚合模型下拉数据源.
// 数据 = llm_configs.model (用户配的) + MODEL_OPTIONS 常量 (兜底) + 历史 task.model.
// 三者并集去重, label 带 source 标记 [已配置] / [内置] / [历史], 方便用户区分来源.
//
// 选项顺序:
//   1. 默认空 option (前端用 "value=''" 走链路默认)
//   2. configured (从用户 llm_configs.model, 含 admin_grant)
//   3. builtin (MODEL_OPTIONS 常量, 但只在 configured 没覆盖时)
//   4. used (历史 task.model, 但只在上面都没覆盖时)
//
// 关注点:
//   - SSR-safe: 不在模块顶层 fetch; useEffect 内挂载后才拉, 首屏返回 loading 状态.
//   - fetch 失败 → 不阻塞 UI, 退化成只显示 MODEL_OPTIONS (兜底常在).
//   - 不暴露 api_key/has_api_key (AvailableLlmConfig 不含, 安全).

import { useEffect, useState, useMemo } from "react";
import { MODEL_OPTIONS } from "@/lib/constants";

export type ModelOptionSource = "default" | "configured" | "builtin" | "used";

export interface ModelOption {
  value: string;
  label: string;
  source: ModelOptionSource;
}

export interface AvailableLlmConfigSummary {
  id: string;
  source: "self" | "admin_grant";
  name: string;
  type: string;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
}

export interface UseAvailableModelsResult {
  options: ModelOption[];
  loading: boolean;
  error: string | null;
}

export const DEFAULT_MODEL_OPTION: ModelOption = {
  value: "",
  label: "默认（按解析链）",
  source: "default",
};

/** 纯函数: 把 configs + used models + MODEL_OPTIONS 合并成去重 + source 标记的下拉选项.
 *  单独导出便于单元测试 (无 React 渲染依赖). */
export function aggregateModelOptions(
  configs: AvailableLlmConfigSummary[],
  usedModels: string[]
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [DEFAULT_MODEL_OPTION];
  seen.add("");

  const pushUnique = (model: string, source: ModelOptionSource, label?: string) => {
    const m = model?.trim();
    if (!m || seen.has(m)) return;
    seen.add(m);
    const prefix =
      source === "configured" ? " [已配置]"
      : source === "used"      ? " [历史]"
      : "";
    out.push({
      value: m,
      label: `${m}${prefix}${label ? ` (${label})` : ""}`,
      source,
    });
  };

  // 1) configured — 优先 (用户主动配的, 含 admin_grant)
  for (const c of configs) {
    if (c.model) pushUnique(c.model, "configured", c.name);
  }

  // 2) builtin — 兜底 (MODEL_OPTIONS 里还没出现的)
  for (const opt of MODEL_OPTIONS) {
    if (!opt.value) continue;
    if (seen.has(opt.value)) continue;
    pushUnique(opt.value, "builtin", opt.label);
  }

  // 3) used — 历史 (上面都还没出现的; 旧 task 没有 llm_configs.model 的数据)
  for (const m of usedModels) {
    pushUnique(m, "used");
  }

  return out;
}

export function useAvailableModels(): UseAvailableModelsResult {
  const [configs, setConfigs] = useState<AvailableLlmConfigSummary[]>([]);
  const [usedModels, setUsedModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, usedRes] = await Promise.all([
          fetch("/api/user/llm-config/available"),
          fetch("/api/user/used-models"),
        ]);
        const [cfgData, usedData] = await Promise.all([
          cfgRes.ok ? await cfgRes.json().catch(() => null) : null,
          usedRes.ok ? await usedRes.json().catch(() => null) : null,
        ]);
        if (cancelled) return;
        setConfigs(cfgData?.configs ?? []);
        setUsedModels(usedData?.models ?? []);
        // 任一 401 都报错 (说明 session 失效)
        if (cfgRes.status === 401 || usedRes.status === 401) {
          setError("unauthorized");
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message || "fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () => aggregateModelOptions(configs, usedModels),
    [configs, usedModels]
  );

  return { options, loading, error };
}
