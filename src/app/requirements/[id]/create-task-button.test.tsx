// 飞书 R60 §3.1 — 详情页「+ 新建任务」按钮 + 弹窗表单 烟雾测试.
//
// 功能: 验证 CreateTaskButton client 组件的最小契约 (走 POST /api/tasks +
//   携带 requirement_id/project_id/version_id, 不引 testing-library).
// 关注点:
//   - JSX 编译后组件标识会被切碎成 _Select / Select_default 等, 直接
//     toString().contains("Select") 不稳. 改用读源文件 (源码层稳定).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import CreateTaskButton from "./create-task-button";

// 用 __dirname 等价的绝对路径读 tsx 源文件 (vitest 跑在 ESM 模式下).
function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./create-task-button.tsx"), "utf8");
}

describe("CreateTaskButton (smoke)", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof CreateTaskButton).toBe("function");
  });

  it("走 POST /api/tasks 端点 + 携带 requirement_id", () => {
    const src = readSrc();
    // 必须走 POST /api/tasks, 防止误把端点改成 GET.
    expect(src).toMatch(/method:\s*"POST"/);
    expect(src).toMatch(/["']\/api\/tasks["']/);
    // 必须把 requirement_id 喂给 POST body, 否则需求点 ↔ 任务关联不上.
    expect(src).toContain("requirement_id:");
    // 必须把 project_id 喂给 POST body, 否则服务端 400 PROJECT_REQUIRED.
    expect(src).toContain("project_id:");
  });

  it("关闭弹窗: 支持 Esc 键 + backdrop click", () => {
    const src = readSrc();
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain("backdrop-blur-sm"); // backdrop className
  });

  it("成功/失败提示: 用 Toast, 不用原生 alert/confirm", () => {
    const src = readSrc();
    expect(src).toContain("useToastActions");
    expect(src).toContain("toastSuccess");
    expect(src).toContain("toastError");
    // UI 组件规范硬规定: 禁用原生 confirm/alert. (R64 立规)
    expect(src).not.toMatch(/\bwindow\.alert\b|\bwindow\.confirm\b/);
  });

  it("使用封装组件: Select 而非原生 <select>", () => {
    const src = readSrc();
    // 必须 import 封装组件, 不用原生 <select>.
    expect(src).toMatch(/import\s+Select\s+from\s+["']@\/components\/Select["']/);
    // 源码里不应该出现原生 <select 标签.
    expect(src).not.toMatch(/<select[\s>]/);
  });

  it("R78 W1 §4.2: 启动时机 toggle 存在 + 默认立即启动 + 切换文案分支", () => {
    const src = readSrc();
    // toggle state 必带.
    expect(src).toContain("autoStart");
    // 默认 true (立即启动) = 保持现有行为.
    expect(src).toMatch(/useState\s*\(\s*true\s*\)/);
    // 启动路径: 创建后调 /api/tasks/[id]/start.
    expect(src).toContain("/api/tasks/");
    expect(src).toContain("/start");
    // 留待启动分支文案 (用来区分 toast).
    expect(src).toContain("留待启动");
  });

  it("R78 W1 §4.3 invariant 前置: type 字段透传到 POST body", () => {
    const src = readSrc();
    // 必须把 taskType 写入 POST body, 否则 invariant 校验无数据可用.
    expect(src).toContain("type:");
    // TASK_TYPE_OPTIONS 必含 4 个阶段.
    expect(src).toContain("TASK_TYPE_OPTIONS");
    expect(src).toContain("design");
    expect(src).toContain("dev");
    expect(src).toContain("test");
    expect(src).toContain("deploy");
  });
});