"use client";

// 功能: terminal 卡片虚拟滚动容器. 看板 cards 视图的 terminal 部分(<md 单列,
// ≥md 也单列因为虚拟器与 CSS grid 不兼容, 见 glimmering-wibbling-teacup.md
// 决策)走这个组件, 300+ 卡片只渲染视口附近的 ~20 个 DOM 节点.
//
// 关注点:
//   - 容器高度 = 视口高减去 header/filter 高度. 用户实际可滚动区域.
//   - estimateSize 140 是卡片平均高度的估值, 真实高度靠 measureElement 回调
//     从 DOM 实测, 第一次渲染后虚拟器会用真实值替换.
//   - overscan 6: 视口外多渲染 6 张, 滚动时不容易看到空白.
//   - items 用 position:absolute + transform 定位, 容器 div 给总高度让滚动条
//     知道内容多长.
//   - renderItem 由调用方传入, 卡片样式与 board-client / global-board 现有卡片
//     一致 (不重复定义).

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface VirtualizedCardsProps<T> {
  items: T[];
  // 从 items[index] 拿主键. React key 用, 不是虚拟器的内部 key.
  getKey: (item: T, index: number) => string;
  // 渲染单张卡片. 外部已经包好 border / padding / link, 这里只管内容.
  renderItem: (item: T, index: number) => ReactNode;
  // 视口高度 (Tailwind: h-[xxx]). 默认 calc(100vh - 240px) 留出 header/filter/
  // 顶部留白. 传字符串可覆盖.
  height?: string;
  estimateSize?: number;
  overscan?: number;
}

export default function VirtualizedCards<T>({
  items,
  getKey,
  renderItem,
  height = "calc(100vh - 240px)",
  estimateSize = 140,
  overscan = 6,
}: VirtualizedCardsProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    // measureElement 从真实 DOM 拿卡片高度, 解决"估值不准 + 卡片变高"
    // 问题. 每次 layout 变更都会触发 (filter / search 改了之后).
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  return (
    <div
      ref={parentRef}
      className="overflow-auto"
      style={{ height }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          return (
            <div
              key={getKey(item, virtualItem.index)}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
                paddingBottom: "0.75rem", // gap-3 的一半
              }}
            >
              {renderItem(item, virtualItem.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}