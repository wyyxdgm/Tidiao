// R79 (2026-09-28) — SPA 任务详情右侧信息面板: 桌面态不该出灰蒙层 (回归守卫).
//
// 功能: 锁住 "PC 点面板 = 一片灰蒙层, 面板点不动" 这个 bug 的修复. 根因 =
//   spa/src/views/TaskDetailView.vue 里 .dock-backdrop 规则写在 @media 之外,
//   而模板里 backdrop 的 v-if 只看 !dockCollapsed — 桌面态 dock 默认展开, 于是
//   整屏 (88px 以下) 被 30% 黑蒙层盖住, 且 z-index 55 压住 .side-col
//   (桌面 z-index auto), 点面板任意位置都落在蒙层上 → 手感 = "点了没反应 /
//   一片灰". master 等价物是 `fixed inset-0 bg-black/30 z-40 md:hidden`,
//   关键是 md:hidden; SPA 移植 (R59 drawer) 时把 media 包裹漏掉了.
//
// 关注点:
//   - 放在 src/app/tasks/[id]/ 而非 spa/tests/: spa/tsconfig.json extends
//     @vue/tsconfig (仓根解析不到), 放 spa/ 下会被根 vitest 的 transform 拒掉.
//   - 跟仓内其他客户端 smoke test 一致: 不引 jsdom/@vue/test-utils, 走读源
//     文件静态校验 (right-dock-responsive-drawer.test.ts 同款). 关注选择器与
//     media 包裹是否还在, 防被 "清理 CSS" 顺手改回.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const SPA_VIEW = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spa/src/views/TaskDetailView.vue",
);

const vueSrc: string = readFileSync(SPA_VIEW, "utf8");
const styleSrc: string = vueSrc.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? "";

/** 取出 `@media <cond> { ... }` 的花括号内内容 (支持嵌套花括号配平). */
function mediaBlock(cond: string): string {
  const start = styleSrc.indexOf(cond);
  if (start === -1) return "";
  const open = styleSrc.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < styleSrc.length; i++) {
    const ch = styleSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return styleSrc.slice(open + 1, i);
    }
  }
  return "";
}

describe("SPA task-detail RightDock 桌面态蒙层回归 (R79)", () => {
  const drawerMedia = mediaBlock("@media (max-width: 900px)");

  it("1. .dock-backdrop 规则只在 ≤900px 抽屉态生效 (桌面不出灰蒙层)", () => {
    // 只允许存在一条 .dock-backdrop 规则 —— 若同时还有全局规则, 桌面照样被盖.
    const rules = styleSrc.match(/\.dock-backdrop\s*\{/g) ?? [];
    expect(rules, "`.dock-backdrop` 规则出现多次, 桌面可能被全局规则盖住").toHaveLength(1);
    // 唯一那条必须在 900px media 块内 (master `md:hidden` 的 SPA 等价物).
    expect(drawerMedia, "找不到 @media (max-width: 900px) 抽屉块").toContain(".dock-backdrop");
  });

  it("2. 抽屉动画关键帧仍在 (backdrop fade-in 不丢)", () => {
    expect(styleSrc).toContain("@keyframes dock-backdrop-in");
  });

  it("3. H5 上藏桌面拖拽手柄 (选择器须是模板真实用的 dock-resize-handle)", () => {
    // 旧代码写的是不存在的 .dock-resizer, 规则空转, H5 上留了一条 8px 灰线.
    expect(drawerMedia).toMatch(/\.dock-resize-handle\s*\{[^}]*display:\s*none/);
    expect(styleSrc, "`.dock-resizer` 选择器不存在, 应改为 .dock-resize-handle").not.toMatch(
      /\.dock-resizer\s*\{/,
    );
  });

  it("4. 抽屉形态本身没被改坏 (side-col fixed + open 类 + 模板节点)", () => {
    // 修复只动 backdrop / 手柄作用域, 抽屉定位链必须原样保留.
    expect(drawerMedia).toMatch(/\.side-col\s*\{[^}]*position:\s*fixed/);
    expect(drawerMedia).toContain(".side-col--drawer-open");
    expect(vueSrc).toContain("side-col--drawer-open");
    // backdrop 节点仍在模板里 (v-if 只看 dockCollapsed, 由 CSS 决定桌面不显示).
    expect(vueSrc).toMatch(/v-if="!dockCollapsed"[\s\S]{0,120}class="dock-backdrop"/);
  });
});
