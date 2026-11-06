"use client";

// 最近激活的 project/version — chat 视图"新建聊天"默认沿用.
// 持久化在 localStorage (key: ao-recent-project-version), 跨页面保留偏好.
// 沿用 use-board-config 的 mounted 守卫防 hydration mismatch.

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "ao-recent-project-version";

export interface RecentProject {
  projectId: string;
  versionId: string | null;
  updatedAt: number;
}

function readRecent(): RecentProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.projectId !== "string") return null;
    return {
      projectId: parsed.projectId,
      versionId: typeof parsed.versionId === "string" ? parsed.versionId : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function useRecentProject() {
  // 服务端 / 首次客户端渲染统一返回 null,水合后 mount 再读 localStorage
  const [recent, setRecentState] = useState<RecentProject | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecentState(readRecent());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const setRecent = useCallback((next: RecentProject) => {
    setRecentState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  return { recent, setRecent, mounted };
}