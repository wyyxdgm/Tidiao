"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  // ReactNode 兼容字符串 + 富内容 (驳回弹框含 textarea 等). 文本居中样式由调用方
  // 在外层自己控 (这里不再加 text-center, 避免对富内容误伤).
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // 用 ref 存最新的 onCancel,避免它每次 render 都是新箭头函数导致 effect 重跑
  // (重跑会调 confirmRef.current?.focus() 抢走用户在 input/select 的焦点).
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  // Auto-focus confirm button on open; ESC to cancel
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  if (!open) return null;

  const btnBase = "px-4 py-2 rounded-lg text-sm font-medium btn-press focus:outline-none focus:ring-2 focus:ring-offset-2";
  const btnConfirm = variant === "danger"
    ? `${btnBase} bg-red-600 text-white hover:bg-red-700 focus:ring-red-500`
    : `${btnBase} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`;
  const btnCancel = `${btnBase} border border-gray-300 text-gray-700 hover:bg-gray-50 focus:ring-gray-400`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="relative bg-white rounded-xl shadow-2xl w-[400px] max-w-[92vw] p-6 animate-scale-in">
        {/* Icon */}
        <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
          variant === "danger" ? "bg-red-100" : "bg-blue-100"
        }`}>
          {variant === "danger" ? (
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          ) : (
            <svg className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
            </svg>
          )}
        </div>
        {/* Title */}
        <h3 className="text-center text-lg font-semibold text-gray-900 mb-2">{title}</h3>
        {/* Message — 富内容时调用方自己布局; 默认 wrapper 加 text-center 兜底. */}
        <div className="text-center text-sm text-gray-500 mb-6">{message}</div>
        {/* Buttons */}
        <div className="flex gap-3 justify-center">
          <button onClick={onCancel} className={btnCancel}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} onClick={onConfirm} className={btnConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
      </div>
  );
}
