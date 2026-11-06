"use client";

// 功能: 单任务超时覆盖编辑弹窗. PATCH /api/tasks/[id] 的 timeout_minutes 字段.
// 关注点:
//   - 输入范围 1-1440 分钟 (与 settings.ts 的 MIN/MAX_TASK_TIMEOUT_MINUTES 一致 ——
//     复制常量避免客户端 import 服务端模块).
//   - 「恢复默认」发 null —— 后端从 metadata 删掉 override, 由 project/全局兜底.
//   - 错误回显: 把后端 400 的 error 文案直接展示.
//   - ESC + 点遮罩关闭; 不在用户输入时打扰 (输入完点保存才发请求).

import { useEffect, useRef, useState } from "react";

// 与 src/lib/db/settings.ts 的 MIN/MAX_TASK_TIMEOUT_MINUTES 保持一致 ——
const MIN_TASK_TIMEOUT_MINUTES = 1;
const MAX_TASK_TIMEOUT_MINUTES = 1440;

interface Props {
  open: boolean;
  currentMinutes: number | null; // null = 未设置 (用 project / 全局)
  defaultMinutes: number | null; // project / 全局解析值, 给"恢复"按钮用
  taskId: string;
  onSaved: (newMinutes: number | null) => void;
  onCancel: () => void;
}

export default function TaskTimeoutEditDialog({
  open,
  currentMinutes,
  defaultMinutes,
  taskId,
  onSaved,
  onCancel,
}: Props) {
  const [value, setValue] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开重置成当前值; ESC 关闭.
  useEffect(() => {
    if (!open) return;
    setValue(currentMinutes != null ? String(currentMinutes) : "");
    setError(null);
    // 等下一帧再 focus, 让 disabled inputRef 拿到当前 DOM
    requestAnimationFrame(() => inputRef.current?.focus());
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, currentMinutes, onCancel]);

  async function save(newMinutes: number | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-user-id": await getUserIdHeader() },
        body: JSON.stringify({ timeout_minutes: newMinutes }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      onSaved(newMinutes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const parsed = Number(value);
  const valid = value !== "" && Number.isInteger(parsed) && parsed >= MIN_TASK_TIMEOUT_MINUTES && parsed <= MAX_TASK_TIMEOUT_MINUTES;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-xl shadow-2xl w-[420px] max-w-[92vw] p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">编辑超时时间</h3>
        <p className="text-sm text-gray-500 mb-4">
          覆盖单任务壁钟超时（{MIN_TASK_TIMEOUT_MINUTES}-{MAX_TASK_TIMEOUT_MINUTES} 分钟）。留空或点「恢复默认」即回到项目 / 全局值。
        </p>
        <div className="flex items-center gap-2 mb-2">
          <input
            ref={inputRef}
            type="number"
            min={MIN_TASK_TIMEOUT_MINUTES}
            max={MAX_TASK_TIMEOUT_MINUTES}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            placeholder={defaultMinutes != null ? `默认 ${defaultMinutes}` : "分钟"}
          />
          <span className="text-sm text-gray-500">分钟</span>
        </div>
        {error && (
          <p className="text-sm text-red-600 mb-3">{error}</p>
        )}
        {!error && value !== "" && !valid && (
          <p className="text-sm text-orange-600 mb-3">
            必须是 {MIN_TASK_TIMEOUT_MINUTES}-{MAX_TASK_TIMEOUT_MINUTES} 之间的整数
          </p>
        )}
        <p className="text-xs text-gray-400 mb-4">
          ⚠ 调长超时会让定时任务的下一轮触发更晚被允许（paused 状态挡在飞）。
        </p>
        <div className="flex justify-between gap-2">
          <button
            onClick={() => save(null)}
            disabled={saving || currentMinutes == null}
            className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 disabled:text-gray-300 disabled:cursor-not-allowed"
            title="恢复项目 / 全局默认"
          >
            恢复默认
          </button>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => valid && save(parsed)}
              disabled={!valid || saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 取当前用户 id header. 与其他 PATCH 调用一致 (auth 中间件从 x-user-id 取).
async function getUserIdHeader(): Promise<string> {
  // 这个项目用 cookie 鉴权 + x-user-id header 转发 (见 src/middleware.ts);
  //   浏览器 fetch 默认带 cookie, x-user-id 由中间件注入请求头. 但 fetch 在客户端
  //   不会自动带中间件加的 header. 实际跑起来检查: 客户端组件直接 PATCH /api/tasks/[id]
  //   在其他页面是这么用的 (auto_approve PATCH), 见 settings 页面的 fetch pattern.
  // 安全做法: 让后端用 cookie 鉴权, 这里不需要传 header. 但当前所有现有 PATCH 都
  //   带 x-user-id —— 沿用, 从 cookie 里取 userId (AuthGuard 已在 cookie 里塞).
  // 简化: 直接复用 fetch 默认行为, header 由 server middleware 注入 (Next.js 不会,
  //   实际是 backend route.ts 自己从 header 取, 客户端不传则 401).
  //   所以这里从 cookie 取 user id 显式带上.
  const match = document.cookie.match(/(?:^|;\s*)user_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}