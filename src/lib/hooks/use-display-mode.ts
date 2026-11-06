"use client";

import { useEffect, useState, useCallback } from "react";

export type DisplayMode = "all" | "text-only" | "expanded";

const STORAGE_KEY = "task-display-mode-v1";
const MODES: DisplayMode[] = ["text-only", "all", "expanded"];

const MODE_LABELS: Record<DisplayMode, string> = {
  "text-only": "纯文本",
  all: "标准",
  expanded: "详情",
};

const MODE_ICONS: Record<DisplayMode, string> = {
  "text-only": "📄",
  all: "🔧",
  expanded: "📋",
};

export function useDisplayMode() {
  const [mode, setMode] = useState<DisplayMode>("all");

  // Read from localStorage only on client after mount — avoids SSR hydration
  // mismatch (localStorage is unavailable during server rendering).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw && MODES.includes(raw as DisplayMode)) {
        setMode(raw as DisplayMode);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {}
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((prev) => {
      const idx = MODES.indexOf(prev);
      return MODES[(idx + 1) % MODES.length];
    });
  }, []);

  return { mode, setMode, cycle, labels: MODE_LABELS, icons: MODE_ICONS };
}
