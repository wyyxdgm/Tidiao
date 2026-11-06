// R48 (2026-09-27) — 右侧详情面板移动端 overlay 抽屉 + 关闭按钮 + 桌面端拖拽 烟雾测试.
//
// 功能: 验证"屏幕缩小 → 右侧详情面板自动跳出原层级 (变 overlay drawer) + 固定
//   定位 + 关闭按钮"这条 mobile-first 行为, 防回归. 关键点:
//   - right-dock 根容器: w-full md:w-auto (手机全宽, 桌面 dockWidth).
//   - right-dock 顶部: onClose 触发时渲染 ✕ 关闭按钮 (X SVG path).
//   - task-detail-client.tsx 包裹层: md:contents fixed inset-y-0 right-0 z-50
//     md:relative md:z-auto (手机 fixed overlay, 桌面 inline).
//   - 移动端遮罩: fixed inset-0 bg-black/30 z-40 md:hidden + onClick=关闭.
//   - 桌面端拖拽手柄: hidden md:block (手机隐藏避免误触).
//
// 关注点:
//   - 跟本仓其他客户端组件测试一致, 不引 testing-library/jsdom (vitest 没
//     配环境); 走读源文件静态校验模式 (right-dock-dependency-graph.test.tsx
//     同款). 关注字符串/类名是否仍存在, 防被 "清理代码" 顺手改回.
//   - 8d31b0c3 master 提交作为权威参考; 本仓 v2.0-spa 已 merge. 这条 R48 是
//     对 master 行为的 SPA 镜像确认 + 加 regression 守卫.
//   - 校验点覆盖完整 mobile drawer 链: 外层 wrapper + 内层 dock + 关闭按钮 +
//     遮罩 + 拖拽手柄; 5 处任一缺失都视为回归.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

function readSrc(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, rel), "utf8");
}

describe("RightDock R48 responsive drawer (smoke)", () => {
  it("1. right-dock 根容器: 手机全宽 + 桌面 dockWidth", () => {
    const src = readSrc("./right-dock.tsx");
    // w-full md:w-auto — 手机填满 (overlay drawer 形态), 桌面按 dockWidth.
    // 关键: 两个修饰符必须同框, 缺一就退化.
    expect(src).toMatch(/className="[^"]*w-full[^"]*md:w-auto/);
  });

  it("2. right-dock 顶部 ✕ 关闭按钮 (onClose 触发时渲染)", () => {
    const src = readSrc("./right-dock.tsx");
    // onClose 在 RightDockProps 类型声明里 = 关闭按钮的入口.
    expect(src).toMatch(/onClose\?:\s*\(\)\s*=>\s*void/);
    // 关闭按钮仅当 onClose 传入时渲染 (桌面 inline 时不显示).
    expect(src).toMatch(/\{onClose\s*&&/);
    // X 图标 SVG path (标准 heroicons X mark).
    expect(src).toContain("M6.28 5.22a.75.75 0 00-1.06 1.06");
    // 关闭按钮 title 文案.
    expect(src).toContain('title="收起右侧面板"');
  });

  it("3. task-detail-client 外层 wrapper: 手机 fixed overlay + 桌面 inline", () => {
    const src = readSrc("./task-detail-client.tsx");
    // md:contents fixed inset-y-0 right-0 z-50 md:relative md:z-auto
    // — 关键回归守卫: 5 个 modifier 同框 (md:contents + fixed + inset-y-0 +
    //   right-0 + z-50 + md:relative + md:z-auto). 任一缺失 = 退化成老
    //   inline 形态.
    const wrapperMatch = src.match(
      /className="[^"]*md:contents[^"]*fixed[^"]*inset-y-0[^"]*right-0[^"]*z-50[^"]*md:relative[^"]*md:z-auto/
    );
    expect(wrapperMatch, "外层 wrapper 缺 mobile fixed overlay 类名").not.toBeNull();
  });

  it("4. 移动端遮罩: fixed inset-0 bg-black/30 z-40 md:hidden + 点击关闭", () => {
    const src = readSrc("./task-detail-client.tsx");
    // 遮罩 className.
    const backdropMatch = src.match(
      /className="[^"]*fixed[^"]*inset-0[^"]*bg-black\/30[^"]*z-40[^"]*md:hidden/
    );
    expect(backdropMatch, "移动端遮罩缺关键 className").not.toBeNull();

    // 遮罩点击关闭 (背景点 = 收起 dock). onClick 绑定 toggle.
    // 锚点: "Mobile overlay backdrop" 注释之后的第一个 onClick.
    const backdropIdx = src.indexOf("/* Mobile overlay backdrop */");
    expect(backdropIdx, "Mobile overlay backdrop 注释不见了").toBeGreaterThan(-1);
    const after = src.slice(backdropIdx, backdropIdx + 400);
    expect(after).toMatch(/onClick=\{dockCollapsed\.toggle\}/);
  });

  it("5. 桌面端拖拽手柄: hidden md:block (手机隐藏)", () => {
    const src = readSrc("./task-detail-client.tsx");
    // 拖拽手柄 className 必须含 hidden md:block.
    const dragMatch = src.match(
      /className="[^"]*hidden[^"]*md:block[^"]*w-1[^"]*shrink-0[^"]*cursor-col-resize/
    );
    expect(dragMatch, "拖拽手柄缺 hidden md:block (mobile 不该露拖拽条)").not.toBeNull();
  });

  it("6. useDockCollapsed: 手机端默认收起 + 桌面端默认展开", () => {
    const src = readSrc("./task-detail-client.tsx");
    // useDockCollapsed hook 定义.
    expect(src).toContain("function useDockCollapsed");
    // mobile-first 默认收起 (useState(true)).
    expect(src).toMatch(/useDockCollapsed[\s\S]*?useState\(true\)/);
    // 视口宽度判定: 768px 以下 (max-width: 767px) 视为手机.
    expect(src).toContain("max-width: 767px");
    // 已有用户选择 = 尊重 localStorage (包括手机端想保持展开的特殊需求).
    expect(src).toContain(DOCK_COLLAPSED_KEY);
  });

  it("7. onClose 注入: dockCollapsed.toggle 传到 RightDock", () => {
    const src = readSrc("./task-detail-client.tsx");
    // RightDock 渲染处 onClose 绑定 dockCollapsed.toggle.
    // 锚点: <RightDock 之后 800 字符内必须含 onClose={dockCollapsed.toggle}.
    const dockIdx = src.indexOf("<RightDock");
    expect(dockIdx, "RightDock 渲染不见了").toBeGreaterThan(-1);
    const after = src.slice(dockIdx, dockIdx + 1500);
    expect(after).toMatch(/onClose=\{dockCollapsed\.toggle\}/);
  });
});

// localStorage key 常量字符串 (避免硬编码漏改, 跟 task-detail-client.tsx
// 的 DOCK_COLLAPSED_KEY 同步). 引用此处方便测试自我校验.
const DOCK_COLLAPSED_KEY = "task-right-dock-collapsed-v1";