"use client";

// 功能: 标准分页组件 — URL ?page=&?pageSize= 持久化, 支持跳转指定页 + 每页数量可调.
// 关注点:
//   - 完全由 URL 驱动, 组件内不持有页码 state. 调用方把 total 传进来, 由组件计算
//     totalPages = ceil(total / pageSize) 并按 URL 同步.
//   - page <= 1 时从 URL 删除 ?page= (保持 URL 干净); pageSize 用 URL ?pageSize=,
//     不传时用 pageSizeOptions[0] 兜底 (默认 50).
//   - "跳转指定页" 用 input + Enter 触发, 失焦也触发; 输入非法 (≤0 / >totalPages)
//     时不更新 URL (与 disabled 按钮语义一致).
//   - children render prop 提供当前页数据 { pageItems, page, pageSize }, 单一真相,
//     调用方不再重算 pageSize (R122 第三轮 #4 修复: 选 10 显示 50 的 bug).
//   - 三处未来复用点: global-list-view (本组件登场), requirements 列表 (后续),
//     schedules-client (后续). URL paramKey 可定制避免撞名.
//   - 「每页数量」下拉直接走 Select 组件, 跟现有风格统一.
//   - 容器内分两段: children (内容) + 底部 footer (页码按钮). 两者间用 flex-1 衔接,
//     让调用方表格定高时整体滚动, 分页条始终可见 (R122 第三轮 #5).

import { useState, useCallback, useEffect, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Select from "@/components/Select";

export interface PaginationRenderProps<T> {
  pageItems: T[];
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PaginationProps<T = unknown> {
  // 全部数据 — children 用 pageItems 拿当前页切片. Pagination 自己 slice, 调用方不重算.
  items: T[];
  total?: number; // 兼容旧调用 (不传 items 时用 total 算 totalPages)
  // URL 参数键, 默认 { page: "page", size: "pageSize" }.
  paramKey?: { page?: string; size?: string };
  // 每页选项, 默认 [10, 20, 50, 100]. 第一个选项 = 默认 pageSize.
  pageSizeOptions?: number[];
  // 自定义 className 容器.
  className?: string;
  // 内容区 render prop — 拿当前页 items 渲染. 不传则不渲染内容 (兼容旧调用).
  children?: (props: PaginationRenderProps<T>) => ReactNode;
}

export default function Pagination<T = unknown>({
  items,
  total: totalProp,
  paramKey,
  pageSizeOptions = [10, 20, 50, 100],
  className = "",
  children,
}: PaginationProps<T>) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const pageKey = paramKey?.page ?? "page";
  const sizeKey = paramKey?.size ?? "pageSize";

  const pageSizeRaw = parseInt(searchParams.get(sizeKey) || "", 10);
  const pageSize = pageSizeOptions.includes(pageSizeRaw) ? pageSizeRaw : pageSizeOptions[0];
  // 兼容旧调用: 不传 items 时用 totalProp (但旧调用没 children, 仅显示分页条).
  const total = items ? items.length : (totalProp ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageRaw = parseInt(searchParams.get(pageKey) || "1", 10);
  const page = Math.min(Math.max(1, pageRaw || 1), totalPages);
  const pageItems = (items ? items.slice((page - 1) * pageSize, page * pageSize) : []) as T[];

  // 跳页 input — 受控, 仅 Enter/失焦触发更新.
  const [pageInput, setPageInput] = useState(String(page));
  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const updateUrl = useCallback(
    (next: { page?: number; pageSize?: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.page !== undefined) {
        if (next.page <= 1) params.delete(pageKey);
        else params.set(pageKey, String(next.page));
      }
      if (next.pageSize !== undefined) {
        if (next.pageSize === pageSizeOptions[0]) params.delete(sizeKey);
        else params.set(sizeKey, String(next.pageSize));
      }
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams, pageKey, sizeKey, pageSizeOptions],
  );

  const commitPageInput = () => {
    const n = parseInt(pageInput, 10);
    if (!Number.isFinite(n) || n < 1 || n > totalPages) {
      setPageInput(String(page));
      return;
    }
    if (n !== page) updateUrl({ page: n });
  };

  if (total === 0) return null;

  // 分页 footer (永远渲染在 children 之后). 内容区交给 children render prop.
  const footer = (
    <div className={`flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600 pt-3 ${className}`}>
      {/* 左: 总数 + 每页数量 */}
      <div className="flex items-center gap-3">
        <span>
          共 <span className="font-medium text-gray-900">{total}</span> 条
        </span>
        <div className="flex items-center gap-1.5">
          <span>每页</span>
          <div className="w-20">
            <Select
              value={String(pageSize)}
              onChange={(v) => updateUrl({ pageSize: Number(v), page: 1 })}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        </div>
      </div>

      {/* 右: 跳页按钮组 */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => updateUrl({ page: 1 })}
          disabled={page <= 1}
          className="px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="首页"
          aria-label="首页"
        >
          «
        </button>
        <button
          onClick={() => updateUrl({ page: page - 1 })}
          disabled={page <= 1}
          className="px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="上一页"
          aria-label="上一页"
        >
          ‹
        </button>
        <span className="px-1.5">
          <input
            type="number"
            min={1}
            max={totalPages}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitPageInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageInput();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="w-14 text-center border border-gray-300 rounded px-1.5 py-1 text-sm"
            aria-label="跳转到指定页"
          />
          <span className="mx-1 text-gray-400">/</span>
          <span className="font-medium">{totalPages}</span>
        </span>
        <button
          onClick={() => updateUrl({ page: page + 1 })}
          disabled={page >= totalPages}
          className="px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="下一页"
          aria-label="下一页"
        >
          ›
        </button>
        <button
          onClick={() => updateUrl({ page: totalPages })}
          disabled={page >= totalPages}
          className="px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="末页"
          aria-label="末页"
        >
          »
        </button>
      </div>
    </div>
  );

  if (!children) return footer;
  return (
    <>
      {children({ pageItems, page, pageSize, totalPages })}
      {footer}
    </>
  );
}
