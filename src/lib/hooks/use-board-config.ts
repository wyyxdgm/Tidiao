"use client";

// Board configuration — persisted per scope in localStorage.
// Manages: view mode, selected statuses (which columns are visible),
// column display order, and sync level.
//
// Sync levels:
//   "scope"   = per project+version (default)
//   "project" = shared across all versions of a project
//   "account" = shared across all projects (global)

import { useEffect, useState, useCallback } from "react";
import { ALL_STATUSES, getVisibleStatuses } from "@/lib/constants";

export type BoardViewMode = "cards" | "kanban" | "chat" | "list" | "grouped";
const MODES: BoardViewMode[] = ["cards", "kanban", "chat", "list", "grouped"];

export type SyncLevel = "scope" | "project" | "account";

export type BoardConfig = {
  viewMode: BoardViewMode;
  selectedStatuses: string[];
  columnOrder: string[];
  syncLevel: SyncLevel;
};

const DEFAULT_VIEW_MODE: BoardViewMode = "cards";
// 🆕 DAG P3 收尾 (2026-09-21): verifying 默认值要按开关过滤, 否则开过又关掉时
//   localStorage 残留的 selectedStatuses / columnOrder 含 verifying 会让 UI 留
//   死按钮. 用包函数按 showVerifying 算 — 不存死值, 开关变化时默认值跟着切.
const HIDDEN_BY_DEFAULT = ["rejected", "cancelled"];
function buildDefaults(showVerifying: boolean): { selected: string[]; order: string[] } {
  const visible = getVisibleStatuses(showVerifying);
  return {
    selected: visible.filter((s) => !HIDDEN_BY_DEFAULT.includes(s)),
    order: [...visible],
  };
}
const DEFAULT_SYNC_LEVEL: SyncLevel = "scope";

function resolveStorageKey(scopeKey: string, syncLevel: SyncLevel): string {
  // scopeKey = "projectId:versionId" or "projectId:unversioned"
  if (syncLevel === "account") {
    return "board-config-account";
  }
  if (syncLevel === "project") {
    const projectId = scopeKey.split(":")[0];
    return `board-config-${projectId}`;
  }
  return `board-config-${scopeKey}`;
}

// Try to load config from localStorage, trying each sync level in priority order
function loadConfig(scopeKey: string, showVerifying: boolean): BoardConfig | null {
  // Try in order: scope → project → account
  const tryKeys = [
    resolveStorageKey(scopeKey, "scope"),
    resolveStorageKey(scopeKey, "project"),
    resolveStorageKey(scopeKey, "account"),
  ];
  const { selected, order } = buildDefaults(showVerifying);
  for (const key of tryKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          viewMode: MODES.includes(parsed.viewMode) ? parsed.viewMode : DEFAULT_VIEW_MODE,
          // 🆕 过滤掉不可见状态 — 老 localStorage 可能含 verifying, 开关关时不要复活.
          selectedStatuses: Array.isArray(parsed.selectedStatuses)
            ? parsed.selectedStatuses.filter((s: string) => showVerifying || s !== "verifying")
            : selected,
          columnOrder: Array.isArray(parsed.columnOrder)
            ? parsed.columnOrder.filter((s: string) => showVerifying || s !== "verifying")
            : order,
          syncLevel: parsed.syncLevel || DEFAULT_SYNC_LEVEL,
        };
      }
    } catch {}
  }
  return null;
}

export function useBoardConfig(scopeKey: string, opts?: { showVerifying?: boolean }) {
  const showVerifying = opts?.showVerifying ?? false;
  // 🆕 默认值按开关算; hook 调用方没传 = 默认 false (与 L1 默认开关一致, byte-identical).
  const { selected: defaultSelected, order: defaultOrder } = buildDefaults(showVerifying);
  const [config, setConfig] = useState<BoardConfig>({
    viewMode: DEFAULT_VIEW_MODE,
    selectedStatuses: defaultSelected,
    columnOrder: defaultOrder,
    syncLevel: DEFAULT_SYNC_LEVEL,
  });
  const [mounted, setMounted] = useState(false);

  // Hydrate from localStorage after mount
  useEffect(() => {
    const loaded = loadConfig(scopeKey, showVerifying);
    if (loaded) {
      setConfig(loaded);
    }
    setMounted(true);
  }, [scopeKey, showVerifying]);

  // Persist on change
  useEffect(() => {
    if (!mounted) return;
    try {
      const key = resolveStorageKey(scopeKey, config.syncLevel);
      localStorage.setItem(key, JSON.stringify(config));
    } catch {}
  }, [config, mounted, scopeKey]);

  const setViewMode = useCallback((mode: BoardViewMode) => {
    setConfig((c) => ({ ...c, viewMode: mode }));
  }, []);

  const setColumnOrder = useCallback((order: string[]) => {
    setConfig((c) => ({ ...c, columnOrder: order }));
  }, []);

  const toggleStatus = useCallback((status: string) => {
    setConfig((c) => {
      const next = new Set(c.selectedStatuses);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return { ...c, selectedStatuses: [...next] };
    });
  }, []);

  const setSelectedStatuses = useCallback((statuses: string[]) => {
    setConfig((c) => ({ ...c, selectedStatuses: statuses }));
  }, []);

  const setSyncLevel = useCallback((level: SyncLevel) => {
    setConfig((c) => ({ ...c, syncLevel: level }));
  }, []);

  return {
    viewMode: config.viewMode,
    setViewMode,
    selectedStatuses: new Set(config.selectedStatuses),
    toggleStatus,
    setSelectedStatuses,
    columnOrder: config.columnOrder,
    setColumnOrder,
    syncLevel: config.syncLevel,
    setSyncLevel,
  };
}
