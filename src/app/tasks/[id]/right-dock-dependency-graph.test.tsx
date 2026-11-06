// DAG P4 (2026-09-06) — 任务详情页 right-dock 依赖段 DAG 布局烟雾测试.
//
// 功能: 验证 DetailsPanelBody 内的 3 段式 DAG 布局存在 + 渲染分支正确.
//   - 无依赖 (上游 0 + 下游 0) → 显示"此任务无依赖关系"占位
//   - 有上游有下游 → 上游 (蓝色 border-l)/ 当前 (蓝填高亮) / 下游 (绿色 border-l) 三段
//   - 派发自/本任务派发保持独立显示 (DAG 不破坏派发关系)
//
// 关注点:
//   - 跟本仓其他 client 组件测试一致, 不引 testing-library/jsdom (vitest 没
//     配环境); 走读源文件静态校验模式 (create-task-button.test.tsx /
//     status-flow.test.tsx 同款).
//   - 不验完整渲染, 只验关键字符串 + 结构符号存在, 防回归 "新代码删除" 类
//     破坏. JSX 编译后切碎标识符, 源码层稳定.
//   - "deleted 任务过滤" 在 page.tsx 层 (getTaskById 默认排除 deleted) 已
//     天然保证, 不在 right-dock 测试覆盖范围; 测试 3 改写为 "依赖 0 时不
//     渲染子节点", 等价覆盖 page.tsx 过滤 deleted 后的最终结果.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./right-dock.tsx"), "utf8");
}

// 抽取 DAG 布局段 (从 <SubSection title="依赖图" ...> 到 </SubSection> 闭
// 合). 用于隔离"派发自/本任务派发"两块不变结构 + 上方 prompt / 需求点关联
// 段, 单独校验 DAG 3 段逻辑. 锚点用 title="依赖图" 因为它在 SubSection 标
// 签 prop 里, JSX 编译后切碎其他标识符但 prop 值字符串保留.
function extractDagSegment(src: string): string {
  const anchor = src.indexOf('title="依赖图"');
  if (anchor < 0) return "";
  // SubSection 起点 = anchor 之前的 <SubSection 关键字.
  const subSectionStart = src.lastIndexOf("<SubSection", anchor);
  if (subSectionStart < 0) return "";
  // SubSection 终点 = anchor 之后第一个 `</SubSection>`.
  const subSectionEnd = src.indexOf("</SubSection>", anchor);
  return subSectionEnd < 0 ? src.slice(subSectionStart) : src.slice(subSectionStart, subSectionEnd + 14);
}

describe("RightDock DAG P4 (smoke)", () => {
  it("测试 1 (无依赖): DAG 段存在 + 显示'此任务无依赖关系'占位", () => {
    const src = readSrc();
    const dag = extractDagSegment(src);

    // 段存在 = 关键 regression 守卫 (防止 P4 改动被 revert).
    expect(dag).toContain('data-testid="dependency-graph"');
    expect(dag).toContain("依赖图");

    // 占位文案 = 测试 1 的核心断言.
    expect(dag).toContain("此任务无依赖关系");

    // hasDeps false 时当前任务高亮块不渲染 (避免无依赖 task 还显示当前块).
    expect(dag).toMatch(/\{hasDeps\s*&&\s*\(/);
  });

  it("测试 2 (有上游有下游): 3 段结构 + 颜色映射正确", () => {
    const src = readSrc();
    const dag = extractDagSegment(src);

    // 上游段 (蓝色 border-l) — className 字符串里要含 border-blue-200.
    expect(dag).toContain("border-blue-200");
    expect(dag).toContain("上游（依赖）");

    // 当前任务高亮段 (蓝色填充).
    expect(dag).toContain("border-blue-500");
    expect(dag).toContain("bg-blue-50");
    expect(dag).toContain("当前任务");

    // 下游段 (绿色 border-l).
    expect(dag).toContain("border-green-200");
    expect(dag).toContain("下游（被依赖）");
  });

  it("测试 3 (依赖 0 时不渲染子节点 + 不破坏派发关系)", () => {
    const src = readSrc();

    // 依赖 0 时不渲染上游 / 下游子段.
    // 写法 1: {dependsOnTasks.length > 0 && (...)} 阻断空数组渲染.
    expect(src).toMatch(/\{dependsOnTasks\.length\s*>\s*0\s*&&\s*\(/);
    expect(src).toMatch(/\{dependentTasks\.length\s*>\s*0\s*&&\s*\(/);

    // 派发自/本任务派发 保持独立显示 (dispatcherTask / dispatchedTasks 在
    // 独立的 "派发与依赖" SubSection, 跟 DAG 段分离). DAG SubSection 不能
    // 覆盖或破坏它们.
    expect(src).toContain("派发自（上游任务）");
    expect(src).toContain("本任务派发（下游任务）");

    // DAG 段独立成 SubSection "依赖图" (P4 重构: 不再嵌在 "派发与依赖"
    // 里, 即使无依赖也会渲染, 让占位文案始终可见).
    expect(src).toContain('title="依赖图"');
  });

  it("补充: 节点数超 5 时显示'还有 N 个'折叠提示 (不引入 <details>)", () => {
    const src = readSrc();
    const dag = extractDagSegment(src);

    // MAX_VISIBLE = 5 常量 (跟设计稿 §4.4 "超 5 个折叠" 一致).
    expect(dag).toMatch(/MAX_VISIBLE\s*=\s*5/);

    // 隐藏计数提示文案 (上游/下游各一).
    expect(dag).toContain("还有");
    expect(dag).toMatch(/还有\s*\{upstreamHidden\}\s*个上游/);
    expect(dag).toMatch(/还有\s*\{downstreamHidden\}\s*个下游/);

    // 不引入 <details> (跟 right-dock 现有扁平风格一致, <details> 会引
    // 额外的折叠状态 + 服务端/客户端 hydration 复杂度).
    expect(dag).not.toMatch(/<details[\s>]/);
  });

  it("补充: P3 verifying 状态在 right-dock 视觉映射已补 (B4 拍板 2026-09-05)", () => {
    // P3 加了 verifying 状态, 但原 STATUS_DOT/STATUS_LABELS 漏补, 导致
    // verifying 任务在 right-dock/timeline 等位置 dot 色掉 fallback. P4
    // 顺手补 = UI 完整性, 与 DAG 一起改最自然, 不动其他逻辑.
    const src = readSrc();
    expect(src).toMatch(/verifying:\s*"bg-yellow-400"/);
    expect(src).toMatch(/verifying:\s*"验收中"/);
  });

  it("补充: 不引入图库 (react-flow / d3) — 设计稿 §4.4 否决", () => {
    const src = readSrc();
    expect(src).not.toMatch(/from\s+["'](react-flow|d3|@d3\/|cytoscape|g6)/);
    // package.json 同款兜底 (防止有人在另一个文件 import 后这里转一道).
    const pkg = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../package.json"), "utf8");
    expect(pkg).not.toMatch(/"react-flow|"d3"|"cytoscape"|"@antv\/g6/);
  });
});
