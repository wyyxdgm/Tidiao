"use client";

// Right-dock per-panel collapsed state + heights (vertical stack layout).
// All 4 panels are always present in the dock; `collapsed` toggles between
// header-only row (reserves `COLLAPSED_H` ≈33px) and full body (reserves
// its stored `height`).
//
// Mode (R35): the dock runs in ACCORDION mode — at any time exactly one
// panel is expanded (the others stay header-only). Activating a collapsed
// panel auto-collapses whatever was expanded and gives the new one the full
// dock interior height. Activating the currently-expanded panel collapses
// it (all-collapsed is allowed; user clicks to re-open). Multi-panel +
// drag-resize was removed because R35 explicitly asks for "每次一个激活".
//
// Panel heights are still stored per-panel so the previously-expanded one
// keeps its own height when re-opened later. `normalizeHeights` remains
// available for the on-mount redistribution; in steady-state with at most
// one expanded panel it's a no-op for collapsed panels.
//
// Persisted in a single localStorage key. Bumped to v2 because the shape /
// semantics changed (no more multi-open + drag-resize — old stored widths
// are ignored now).

import { useEffect, useState, useCallback } from "react";

export type DockPanelId = "details" | "timeline" | "checkpoints" | "commits";

export const DOCK_ORDER: DockPanelId[] = [
  "details",
  "timeline",
  "checkpoints",
  "commits",
];

export const MIN_H = 120;
export const MAX_H = 1200;

// Header row height (matches the actual rendered `py-2` header band).
export const COLLAPSED_H = 33;

export type DockState = {
  height: Record<DockPanelId, number>;
  collapsed: Record<DockPanelId, boolean>;
};

const STORAGE_KEY = "task-right-dock-v1";

const DEFAULT_STATE: DockState = {
  // Initial heights — stored per-panel so when a panel is re-opened later
  // it gets back its previous height. In accordion mode only one panel is
  // expanded at a time, so the "real" height used on first render is just
  // the single expanded panel's stored height.
  height: { details: 800, timeline: 600, checkpoints: 600, commits: 600 },
  // Accordion default: 详情 展开;其他 3 个默认折叠（只占 header 行）.
  collapsed: { details: false, timeline: true, checkpoints: true, commits: true },
};

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// Distribute `total` across panels so that:
//   - collapsed panels reserve exactly COLLAPSED_H
//   - expanded panels share the remainder proportionally to current heights
//   - each expanded panel is at least MIN_H
// Returns a new height map; never mutates input.
function redistribute(
  total: number,
  state: DockState
): Record<DockPanelId, number> {
  const collapsedTotal = DOCK_ORDER.reduce(
    (acc, p) => acc + (state.collapsed[p] ? COLLAPSED_H : 0),
    0
  );
  const expandedIds = DOCK_ORDER.filter((p) => !state.collapsed[p]);
  const available = Math.max(0, total - collapsedTotal);

  if (expandedIds.length === 0) {
    return { ...state.height };
  }

  const currentExpandedSum = expandedIds.reduce(
    (acc, p) => acc + state.height[p],
    0
  );
  const scale = currentExpandedSum === 0 ? 1 : available / currentExpandedSum;

  const next = { ...state.height };
  for (const p of expandedIds) {
    next[p] = Math.max(MIN_H, Math.round(state.height[p] * scale));
  }
  // Floating-point rounding may leave 1-2px off; absorb the residual
  // into the largest expanded panel so the sum equals `total` exactly.
  const sum = DOCK_ORDER.reduce((acc, p) => acc + next[p], 0);
  const residual = total - sum;
  if (residual !== 0) {
    const biggest = expandedIds.reduce((a, b) => (next[a] >= next[b] ? a : b));
    next[biggest] = Math.max(MIN_H, next[biggest] + residual);
  }
  return next;
}

export function useDockState() {
  const [state, setState] = useState<DockState>(DEFAULT_STATE);
  const [mounted, setMounted] = useState(false);

  // Hydrate from localStorage after mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Accordion invariant (R35): after load, AT MOST one panel is
        // expanded. If a stale v1 storage has multiple expanded (or zero —
        // user collapsed the only one), fall back to defaults for collapsed
        // bits. Heights are still hydrated per-panel.
        const storedCollapsed = { ...DEFAULT_STATE.collapsed, ...(parsed.collapsed ?? {}) };
        const expandedCount = DOCK_ORDER.filter((p) => !storedCollapsed[p]).length;
        if (expandedCount !== 1) {
          // 0 or ≥2 expanded: enforce accordion default (only details open).
          storedCollapsed.details = false;
          storedCollapsed.timeline = true;
          storedCollapsed.checkpoints = true;
          storedCollapsed.commits = true;
        }
        const storedHeight = {
          ...DEFAULT_STATE.height,
          ...(parsed.height ?? parsed.width ?? {}),
        };
        // R36 修复: hydrate 后立即用合理兜底 dock 高度 (800px, 桌面
        // 聊天面板典型 viewport) normalize 一次. 解决根因: right-dock
        // mount 早期 ResizeObserver 拿到 flex 父级未稳定的中间高度
        // (e.g. 219), normalize 算 details.height = MIN_H=120; 之后 dock
        // 撑开到 828 但 contentRect.height 看起来没变, RO 不再 fire,
        // state.height.details 永远卡在 120. 在 hydrate 这里先 normalize
        // 一次 (用真实兜底 800) 保证至少有个合理高度, 后续 right-dock
        // mount 后 RO/RAF 再 normalize 用真实高度收尾. 收尾值跟这里算出
        // 的值差别 ≤ 几 px (chat-view 高度弹性), 用户无感.
        const seedDockHeight = 800;
        const normalizedHeight = redistribute(seedDockHeight, {
          height: storedHeight,
          collapsed: storedCollapsed,
        });
        setState({
          height: normalizedHeight,
          collapsed: storedCollapsed,
        });
      }
    } catch {
      // ignore — fall back to defaults
    }
    setMounted(true);
  }, []);

  // Persist on change (skip until mounted so we don't overwrite stored values
  // with defaults on the very first render).
  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state, mounted]);

  // Normalize: redistribute heights so the 4 panels (each at COLLAPSED_H or
  // its expanded share) sum to the dock's available height. Caller passes
  // `totalHeight` measured from the dock container.
  const normalizeHeights = useCallback((totalHeight: number) => {
    if (totalHeight <= 0) return;
    setState((s) => ({ ...s, height: redistribute(totalHeight, s) }));
  }, []);

  const setHeight = useCallback((p: DockPanelId, h: number) => {
    setState((s) => ({
      ...s,
      height: { ...s.height, [p]: clamp(h, MIN_H, MAX_H) },
    }));
  }, []);

  const toggleCollapsed = useCallback(
    (p: DockPanelId, opts?: { availableHeight?: number }) => {
      setState((s) => {
        const willExpand = s.collapsed[p]; // true→展开 / false→折叠

        if (willExpand) {
          // Accordion: activating p forces every OTHER panel to collapsed.
          // Then size p to the full available dock interior (subtract each
          // collapsed sibling's header row), so it fills 100% as R35 asks.
          const nextCollapsed: Record<DockPanelId, boolean> = {
            details: true,
            timeline: true,
            checkpoints: true,
            commits: true,
          };
          nextCollapsed[p] = false;

          let target = s.height[p];
          if (opts?.availableHeight !== undefined) {
            // 3 sibling headers (always collapsed when p expands), 3 * COLLAPSED_H.
            const siblingHeads = (DOCK_ORDER.length - 1) * COLLAPSED_H;
            const available = Math.max(MIN_H, opts.availableHeight - siblingHeads);
            target = clamp(available, MIN_H, MAX_H);
          }

          return {
            ...s,
            collapsed: nextCollapsed,
            height: { ...s.height, [p]: target },
          };
        }

        // Collapsing the currently-expanded panel → all-collapsed is allowed
        // (user clicks again to re-open something).
        return {
          ...s,
          collapsed: { ...s.collapsed, [p]: true },
        };
      });
    },
    []
  );

  // setCollapsed was used by the drag-resize branch (`startDrag` force-expanded
// the dragged panel). With accordion mode it still works for that one call,
// but to keep the invariant clean we route through the same accordion
// logic: expanding panel p collapses everything else, collapsing p just
// flips its bit. Callers that just want to flip a bit (drag-resize mid-gesture)
// should use toggleCollapsed instead.
  const setCollapsed = useCallback((p: DockPanelId, v: boolean) => {
    setState((s) => {
      if (v) {
        // collapse p — leave the rest as-is (could land us at 0 expanded,
        // which is allowed in accordion mode)
        return { ...s, collapsed: { ...s.collapsed, [p]: true } };
      }
      // expand p — collapse all others (accordion rule)
      const nextCollapsed: Record<DockPanelId, boolean> = {
        details: true,
        timeline: true,
        checkpoints: true,
        commits: true,
      };
      nextCollapsed[p] = false;
      return { ...s, collapsed: nextCollapsed };
    });
  }, []);

  // Resize panel p by `delta`. Accordion-mode (R35) only ever has one
  // expanded panel, so the old "compensate an adjacent expanded panel to
  // keep total height constant" logic has no partner to compensate; we
  // just resize p in place. Caller (`right-dock.tsx`) hides drag handles
  // entirely in accordion mode so this branch is rarely hit; kept for
  // signature compatibility / future re-introduction of drag-resize.
  const setHeightPair = useCallback((p: DockPanelId, delta: number) => {
    setState((s) => ({
      ...s,
      height: { ...s.height, [p]: clamp(s.height[p] + delta, MIN_H, MAX_H) },
    }));
  }, []);

  return {
    state,
    mounted,
    setHeight,
    setHeightPair,
    normalizeHeights,
    toggleCollapsed,
    setCollapsed,
  };
}