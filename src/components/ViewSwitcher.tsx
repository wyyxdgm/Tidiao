"use client";

// Segmented control for switching between Cards / Kanban / Chat views.

import type { BoardViewMode } from "@/lib/hooks/use-board-config";

interface ViewSwitcherProps {
  mode: BoardViewMode;
  onChange: (mode: BoardViewMode) => void;
}

const OPTIONS: { value: BoardViewMode; label: string; icon: React.ReactNode }[] = [
  {
    value: "cards",
    label: "卡片",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
        <rect x="1" y="1" width="7" height="7" rx="1.5" />
        <rect x="12" y="1" width="7" height="7" rx="1.5" />
        <rect x="1" y="12" width="7" height="7" rx="1.5" />
        <rect x="12" y="12" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    value: "kanban",
    label: "看板",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
        <rect x="1" y="1" width="4" height="18" rx="1" />
        <rect x="8" y="1" width="4" height="12" rx="1" />
        <rect x="15" y="1" width="4" height="15" rx="1" />
      </svg>
    ),
  },
  {
    value: "chat",
    label: "聊天",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
        <rect x="1" y="1" width="18" height="14" rx="2" />
        <path d="M6 15l2 4 2-4" />
      </svg>
    ),
  },
  {
    value: "list",
    label: "列表",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
        <rect x="1" y="3" width="18" height="2" rx="0.5" />
        <rect x="1" y="9" width="18" height="2" rx="0.5" />
        <rect x="1" y="15" width="18" height="2" rx="0.5" />
      </svg>
    ),
  },
  {
    value: "grouped",
    label: "按项目",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
        <rect x="1" y="1" width="8" height="8" rx="1" />
        <rect x="11" y="1" width="8" height="5" rx="1" />
        <rect x="1" y="11" width="8" height="8" rx="1" />
        <rect x="11" y="8" width="8" height="11" rx="1" />
      </svg>
    ),
  },
];

export default function ViewSwitcher({ mode, onChange }: ViewSwitcherProps) {
  return (
    <div className="inline-flex items-center bg-gray-100 rounded-lg p-0.5 gap-0.5">
      {OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`
              flex items-center gap-1 px-3 py-1.5 rounded-md text-sm transition-all
              ${active
                ? "bg-white shadow-sm text-gray-900 font-medium"
                : "text-gray-500 hover:text-gray-700"
              }
            `}
            title={opt.label}
          >
            {opt.icon}
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
