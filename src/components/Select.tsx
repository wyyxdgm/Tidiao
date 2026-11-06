"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
}

export default function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  className = "",
  title,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  // Dropdown 展开方向：默认朝下；底部空间不够时翻到上方（聊天输入栏旁的模型选择器常被这问题挡）。
  const [direction, setDirection] = useState<"down" | "up">("down");
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label || placeholder || "";

  // 估算下拉高度：max-h-60 = 240px，再加 8px gap 和一点缓冲。
  // 关注点：实际高度由内容决定（≤ 240），这里只用作「够不够」的粗判。
  const DROPDOWN_NEEDED = 248;

  const recomputeDirection = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    setDirection(spaceBelow < DROPDOWN_NEEDED ? "up" : "down");
  }, []);

  // 打开时 + 打开期间（滚动/resize）持续重算方向，保证跨容器/跨滚动都能自适应。
  useEffect(() => {
    if (!open) return;
    recomputeDirection();
    window.addEventListener("resize", recomputeDirection);
    window.addEventListener("scroll", recomputeDirection, true);
    return () => {
      window.removeEventListener("resize", recomputeDirection);
      window.removeEventListener("scroll", recomputeDirection, true);
    };
  }, [open, recomputeDirection]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Scroll selected into view on open
  useEffect(() => {
    if (!open || !listRef.current) return;
    const idx = options.findIndex((o) => o.value === value);
    if (idx < 0) return;
    const item = listRef.current.children[idx] as HTMLElement;
    item?.scrollIntoView({ block: "nearest" });
  }, [open, options, value]);

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  return (
    <div ref={ref} title={title} className={`relative ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={`
          w-full flex items-center justify-between gap-2
          border border-gray-300 rounded-lg px-3 py-2 text-sm text-left
          bg-white transition-colors
          ${disabled ? "bg-gray-100 cursor-not-allowed" : "hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"}
          ${!selected && placeholder ? "text-gray-400" : "text-gray-700"}
        `}
      >
        <span className="truncate">{displayLabel}</span>
        <svg
          className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && !disabled && (
        <ul
          ref={listRef}
          className={`absolute z-50 w-full max-h-60 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg animate-select-in ${
            direction === "down" ? "mt-1" : "bottom-full mb-1"
          }`}
        >
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                onClick={() => handleSelect(opt.value)}
                className={`
                  w-full text-left px-3 py-2 text-sm transition-colors
                  ${opt.value === value
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-gray-700 hover:bg-gray-50"
                  }
                `}
              >
                {opt.label}
              </button>
            </li>
          ))}
          {options.length === 0 && (
            <li className="px-3 py-2 text-sm text-gray-400">无选项</li>
          )}
        </ul>
      )}

      </div>
  );
}
