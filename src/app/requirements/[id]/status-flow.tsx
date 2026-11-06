"use client";

// 飞书 R60 §3.1 + plan §6.6 — 详情页头部状态 badge 改为可点击下拉, 切换 6 态.
//
// 功能: 把当前 STATUS_LABEL + STATUS_COLOR badge 改为 dropdown trigger; 点开
//   后列出 6 态 (pending/done/awaiting_reply/has_suggestion/blocked/closed),
//   选中即 PATCH /api/requirements/[id] body {status}; 切 closed 走
//   ConfirmDialog (danger variant) 二次确认 (软删语义, 改回成本 = 重新
//   PATCH 回来, 但要二次确认避免误操作).
//
// 关注点:
//   - status 取值校验交由 PATCH 路由 (REQUIREMENT_STATUSES 白名单), 前端
//     只是把 6 个固定值喂进去, 不重复校验.
//   - PATCH 成功后 router.refresh() 让 server shell 重渲染 (status + 时间线).
//   - 失败用 Toast; 不关 dropdown (保留当前选择 + 让用户重试或取消).
//   - 用 Select 封装组件还是自定义下拉? 用 ConfirmDialog 同样套路的 button +
//     ul dropdown 与 Select 太重 (Select 是 form 控件, 走 onChange 即触发,
//     这里需要点开/关闭流程). 借鉴 Select 的视觉风格, 自写 dropdown (与
//     /tasks/[id]/page.tsx 的 status 切换模式一致).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToastActions } from "@/components/Toast";

// 与 src/lib/db/requirements.ts REQUIREMENT_STATUSES 同源, 客户端重复是因为
// db/requirements.ts 引 better-sqlite3, 不能进 client bundle. 两边枚举要保持
// 同步 (任何一处改动都连带改另一处).
type RequirementStatus =
  | "pending"
  | "done"
  | "awaiting_reply"
  | "has_suggestion"
  | "blocked"
  | "closed";
const REQUIREMENT_STATUSES: RequirementStatus[] = [
  "pending",
  "done",
  "awaiting_reply",
  "has_suggestion",
  "blocked",
  "closed",
];

// 与 src/app/requirements/[id]/page.tsx STATUS_LABEL/STATUS_COLOR 同源, 重复
// 是为了 client component 不依赖 server-only imports.
const STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: "未开始",
  done: "已完成",
  awaiting_reply: "等回复",
  has_suggestion: "有建议",
  blocked: "需拍板",
  closed: "已关闭",
};

const STATUS_COLOR: Record<RequirementStatus, string> = {
  pending: "bg-gray-100 text-gray-700 hover:bg-gray-200",
  done: "bg-green-100 text-green-700 hover:bg-green-200",
  awaiting_reply: "bg-blue-100 text-blue-700 hover:bg-blue-200",
  has_suggestion: "bg-purple-100 text-purple-700 hover:bg-purple-200",
  blocked: "bg-orange-100 text-orange-700 hover:bg-orange-200",
  closed: "bg-gray-200 text-gray-500 hover:bg-gray-300",
};

interface StatusFlowProps {
  requirementId: string;
  initialStatus: RequirementStatus;
  // R78 W1 §4.3 (c): 当想从 dropdown 选 done 但 eligibleForDone=false 时,
  // dropdown 中的「已完成」项 disabled + tooltip 解释为什么不能选.
  // 由 server (page.tsx) 通过 GET /api/requirements/[id] 一次性算好, 不在 dropdown 打开时再查.
  eligibleForDone: boolean;
}

export default function StatusFlow({ requirementId, initialStatus, eligibleForDone }: StatusFlowProps) {
  const router = useRouter();
  const { success: toastSuccess, error: toastError } = useToastActions();
  const [status, setStatus] = useState<RequirementStatus>(initialStatus);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // closed 二次确认对话框 state
  const [confirmClosed, setConfirmClosed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click outside / Esc 关 dropdown
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function patchStatus(next: RequirementStatus) {
    setPending(true);
    try {
      const res = await fetch(`/api/requirements/${requirementId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
      }
      setStatus(next);
      toastSuccess(`状态已改为「${STATUS_LABEL[next]}」`);
      setOpen(false);
      router.refresh();
    } catch (err: any) {
      toastError(`改状态失败: ${err?.message || "未知错误"}`);
    } finally {
      setPending(false);
    }
  }

  function onPick(next: RequirementStatus) {
    if (next === status) {
      setOpen(false);
      return;
    }
    if (next === "closed") {
      // closed = 软删语义, 弹 ConfirmDialog 二次确认
      setConfirmClosed(true);
      return;
    }
    // R78 W1 §4.3 (c): 「已完成」项需要至少一个 dev/test/deploy task 已 completed
    // 才可选. 设计/调研任务完成不计入 (damo 痛点核心: 防止调研态被自动标 done).
    if (next === "done" && !eligibleForDone) {
      toastError(
        "需要至少一个「实现/测试/部署」任务完成, 才能把需求点标为已完成。"
      );
      return;
    }
    patchStatus(next);
  }

  return (
    <>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => !pending && setOpen((o) => !o)}
          disabled={pending}
          className={`text-xs px-3 py-1 rounded-full whitespace-nowrap ${STATUS_COLOR[status]} ${pending ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          title="点击切换状态"
        >
          {pending ? "更新中…" : STATUS_LABEL[status]}
          <span className="ml-1 opacity-60">▾</span>
        </button>

        {open && (
          <ul className="absolute right-0 mt-1 z-50 w-44 max-h-60 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
            {REQUIREMENT_STATUSES.map((s) => {
              // R78 W1 §4.3 (c): done 项在没满足 invariant 时 disabled.
              const doneDisabled = s === "done" && !eligibleForDone;
              return (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => onPick(s)}
                    disabled={doneDisabled}
                    title={
                      doneDisabled
                        ? "需要至少一个「实现/测试/部署」任务完成"
                        : undefined
                    }
                    className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between ${
                      s === status
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : doneDisabled
                          ? "text-gray-400 cursor-not-allowed"
                          : "text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span>{STATUS_LABEL[s]}</span>
                    {s === status && <span className="text-xs">✓</span>}
                  </button>
                </li>
              );
            })}
            <li className="px-3 py-1.5 text-[10px] text-gray-400 border-t">
              closed = 软删, 后续可改回
            </li>
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmClosed}
        title="关闭这个需求点？"
        message={`关闭后状态变为「${STATUS_LABEL.closed}」，可随时改回。`}
        confirmLabel="确认关闭"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => {
          setConfirmClosed(false);
          patchStatus("closed");
        }}
        onCancel={() => setConfirmClosed(false)}
      />
    </>
  );
}