// 飞书 R86: SchedulesClient LogViewerDialog SSE 流式改造 smoke 测试
//
// 关注点:
//   - 本仓未装 @testing-library/react (见 src/app/stats/tabs/dimensions.test.tsx),
//     既有 client test 全走「读源文件 + typeof 检测」的 smoke 风格
//     (参考 src/app/requirements/[id]/create-task-button.test.tsx)。
//   - 3a/3b/3c:useEffect 启动/卸载/收 completed 调 EventSource.close() —— 验证源码契约。
//   - 3d/3e:数据流优先 live → fallback DB —— 验证渲染分支代码结构。
//
// 测试不能真正 render (没 RTL), 但能锁住关键调用序列, 防止以后重构把
// EventSource.onmessage / .close() 顺序改错。

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import SchedulesClient from "./schedules-client";

// 顶层 readSrc —— R86 + R53 两组 describe 都复用, 不重复实现。
// 之前 R86 写在 describe 内部 (closure 私有), 跨 describe 不能用;
function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./schedules-client.tsx"), "utf8");
}

describe("R86 LogViewerDialog SSE 流式改造 (smoke)", () => {
  it("3a) 打开 modal 时 (logDialogRun 非空): useEffect 内 new EventSource(url)", () => {
    const src = readSrc();
    // 必须 new EventSource, 不能用 fetch + setInterval (那不是真正的 SSE)
    expect(src).toContain("new EventSource");
    // URL 模式: /api/schedules/runs/{runId}/stream (可以是字面量或先赋值给 url 变量)
    expect(src).toContain("/api/schedules/runs/${logDialogRun.id}/stream");
    expect(src).toMatch(/new\s+EventSource\s*\(/);
    // useEffect 依赖 logDialogRun
    expect(src).toMatch(/useEffect\s*\(/);
    expect(src).toMatch(/\},\s*\[logDialogRun\]\)/);
  });

  it("3b) onmessage 收到 completed:true 时, EventSource.close() 被调", () => {
    const src = readSrc();
    // onmessage 解析 payload 后判 completed
    expect(src).toContain("es.onmessage");
    expect(src).toContain("payload.completed");
    // 提取 es.onmessage 之后的整段 (从 `es.onmessage = (ev) => {` 起到 function 末
    // 的 `};` 结束)。从 `es.onmessage` 往后 slice 到 function 结束标志 `};`。
    const idx = src.indexOf("es.onmessage = (ev)");
    expect(idx).toBeGreaterThanOrEqual(0);
    // 找下一个 `};` (function 表达式结束),但要排除 type assertion 里的 `};`。
    //   - type assertion 长这样:`as { ... };` —— 紧跟 `}` 的是 `;`。
    //   - function end 是 `};\n` 后还有 statement 间隔。直接搜 `};\n` 边界。
    const slice = src.slice(idx);
    // 找最后 `};` 之前应该有 \n    es.onerror
    const endIdx = slice.indexOf("es.onerror");
    expect(endIdx).toBeGreaterThanOrEqual(0);
    const onMessageBody = slice.slice(0, endIdx);
    expect(onMessageBody).toContain("es.close()");
    // 确保 es.close 在 payload.completed 分支里, 而不是在 unmount 时
    expect(onMessageBody).toMatch(/payload\.completed[\s\S]{0,400}es\.close/);
  });

  it("3c) 卸载 / 关闭 modal 时 (useEffect cleanup): EventSource.close() 被调 (防泄漏)", () => {
    const src = readSrc();
    // 找 useEffect(... new EventSource ...) 块。从 new EventSource 往左找 useEffect 起点,
    //   往右找依赖数组结束 `}, [logDialogRun]);`。这之间是 useEffect body, cleanup return 必须在 body 末。
    const idxNew = src.indexOf("new EventSource");
    expect(idxNew).toBeGreaterThanOrEqual(0);
    // 往左找最近的 useEffect(
    const sliceLeft = src.slice(0, idxNew);
    const idxUseEffect = sliceLeft.lastIndexOf("useEffect(");
    expect(idxUseEffect).toBeGreaterThanOrEqual(0);
    // 往右找依赖数组结束。
    const sliceRight = src.slice(idxNew);
    const idxDepEnd = sliceRight.indexOf("}, [logDialogRun]);");
    expect(idxDepEnd).toBeGreaterThanOrEqual(0);
    const block = src.slice(idxUseEffect, idxNew + idxDepEnd + "}, [logDialogRun]);".length);
    // cleanup: return () => { es.close(); ... }
    expect(block).toMatch(/return\s*\(\s*\)\s*=>\s*\{/);
    expect(block).toMatch(/es\.close\(\)/);
  });

  it("3d) 渲染数据源优先 live (liveStdout/liveStderr) → fallback DB (logDialogRun.output/.error)", () => {
    const src = readSrc();
    // 渲染层用 || fallback: liveStdout || logDialogRun.output
    expect(src).toMatch(/liveStdout\s*\|\|\s*logDialogRun\.output/);
    expect(src).toMatch(/liveStderr\s*\|\|\s*logDialogRun\.error/);
    // 字符数显示走 (a || b) ?? "" 的合并表达式, 反映 fallback 行为。
    expect(src).toContain("logDialogRun.output");
    expect(src).toContain("logDialogRun.error");
    // 优先 live (liveStdout/liveStderr) 而不是 logDialogRun.output —— 顺序决定 fallback 方向
    const stdoutExpr = src.match(/\(liveStdout\s*\|\|\s*logDialogRun\.output\)/);
    expect(stdoutExpr).not.toBeNull();
  });

  it("3e) onmessage 解析 payload 后更新 state (liveStdout / liveStderr / liveCompleted / liveExitCode)", () => {
    const src = readSrc();
    const idx = src.indexOf("es.onmessage = (ev)");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = src.slice(idx);
    const endIdx = slice.indexOf("es.onerror");
    expect(endIdx).toBeGreaterThanOrEqual(0);
    const body = slice.slice(0, endIdx);
    // 必更新 4 个 state
    expect(body).toMatch(/setLiveStdout/);
    expect(body).toMatch(/setLiveStderr/);
    expect(body).toMatch(/setLiveCompleted/);
    expect(body).toMatch(/setLiveExitCode/);
    // JSON.parse(ev.data) 拿 payload
    expect(body).toContain("JSON.parse(ev.data)");
    // 解析失败要 swallow (catch {}), 否则一帧错就断流
    expect(body).toMatch(/catch\s*\{/);
  });

  it("SchedulesClient 默认导出 = 函数组件 (type guard)", () => {
    expect(typeof SchedulesClient).toBe("function");
  });
});

// 飞书 R53 S 列: 「立即执行」按钮 smoke 测试
//
// 关注点:
//   - 按钮存在 + 文案 = "立即执行"; loading 时文案切 "触发中…"
//   - onClick 调 POST /api/schedules/{id}/runs (后端 triggerSchedule 入口)
//   - 软删除的 schedule 按钮 disabled (避免误点; 后端没挡, 前端兜住)
//   - 用与 R86 一致的「读源文件 + 正则」smoke 风格, 不依赖 @testing-library/react
//   - 复用文件顶部的 readSrc() (上面 R86 describe 里定义的), 不重写以免重复
//
// 🆕 R53 R 列追加 (第二轮迭代):
//   - triggerNow 成功后自动刷新触发历史 (runsOpen 打开时立即看到新 run)
//   - 「查看日志」按钮在 RunsPanel 每行必出 (agent → /tasks/{id}, shell → modal)
describe("R53 立即执行按钮 + 迭代 (smoke)", () => {
  it("R53-a) 按钮文案 '立即执行' 与 loading 态文案 '触发中…' 都存在", () => {
    const src = readSrc();
    expect(src).toContain("立即执行");
    expect(src).toContain("触发中…");
  });

  it("R53-b) 按钮 onClick 调 POST /api/schedules/{id}/runs (triggerNow handler)", () => {
    const src = readSrc();
    expect(src).toMatch(/function\s+triggerNow\s*\(/);
    // POST /api/schedules/${s.id}/runs (模板字符串拼接)
    expect(src).toMatch(/`\/api\/schedules\/\$\{[^}]+\}\/runs`/);
    // method 必须是 POST
    expect(src).toMatch(/method:\s*["']POST["']/);
  });

  it("R53-c) 软删除 (s.deleted_at) 触发时早返回 + 错误 toast", () => {
    const src = readSrc();
    // triggerNow 函数体前段必须有 deleted_at 检查 + toastError
    const fnStart = src.indexOf("async function triggerNow");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const slice = src.slice(fnStart);
    // 函数末 setTriggering((m) => ({ ...m, [s.id]: false })) 作为锚点
    const body = slice.slice(
      0,
      slice.indexOf("setTriggering((m) => ({ ...m, [s.id]: false }))")
    );
    expect(body).toMatch(/if\s*\(\s*s\.deleted_at\s*\)/);
    expect(body).toMatch(/toastError\s*\(\s*["']已软删除/);
  });

  it("R53-d) 按钮渲染到操作按钮组最左 (group-hover 渐显容器内)", () => {
    const src = readSrc();
    // 找「立即执行」按钮 onClick=triggerNow 的 <button> 块
    const btnIdx = src.indexOf("onClick={() => triggerNow(s)}");
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    // 它的左侧 (往前看) 应该是 group-hover 操作按钮组的容器 div 起点
    const left = src.slice(0, btnIdx);
    // 找最近一个 absolute bottom-3 right-3 z-10 容器起点 (按钮组容器)
    const containerIdx = left.lastIndexOf("absolute bottom-3 right-3 z-10");
    expect(containerIdx).toBeGreaterThanOrEqual(0);
    // 容器起点到按钮之间不能有另一个</button> (否则按钮在另一个按钮组里)
    const between = src.slice(containerIdx, btnIdx);
    expect(between).not.toMatch(/<\/button>/);
    // 按钮的 disabled 条件包含 deleted_at (软删除禁用)
    const btnSlice = src.slice(btnIdx, btnIdx + 600);
    expect(btnSlice).toMatch(/disabled=\{!!triggering\[s\.id\]\s*\|\|\s*!!s\.deleted_at\}/);
  });

  // 🆕 R53 R 列追加 (1): 触发成功后自动刷新触发历史
  it("R53-e) triggerNow 成功路径调 fetchRuns(s.id, 0) + 重置 runsPage (触发历史自动刷新)", () => {
    const src = readSrc();
    const fnStart = src.indexOf("async function triggerNow");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const slice = src.slice(fnStart);
    const body = slice.slice(
      0,
      slice.indexOf("setTriggering((m) => ({ ...m, [s.id]: false }))")
    );
    // 成功分支 (if (res.ok)) 后必须刷新 runs 数据
    expect(body).toMatch(/setRunsPage\s*\(\s*\(m\)\s*=>\s*\(\{\s*\.\.\.m,\s*\[s\.id\]:\s*0\s*\}\)\s*\)/);
    expect(body).toMatch(/void\s+fetchRuns\s*\(\s*s\.id\s*,\s*0\s*\)/);
  });

  // 🆕 R53 R 列追加 (2): 「查看日志」按钮统一放在 RunsPanel, 不再 hasAnyLog 门控
  it("R53-f) RunsPanel 每行都有「查看日志」按钮 (不再 hasAnyLog 门控)", () => {
    const src = readSrc();
    // 旧 hasAnyLog 门控应被移除 (R79 注释提到"有 output 或 error 才显示",
    //   R53 R 列追加后改为每行必出, 所以按钮不能再被 hasAnyLog 包住)
    // 找「查看日志」按钮块
    const btnIdx = src.indexOf("查看日志 →");
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    // 往前找最近的 <button> 起点
    const btnStart = src.lastIndexOf("<button", btnIdx);
    expect(btnStart).toBeGreaterThanOrEqual(0);
    const btnBlock = src.slice(btnStart, btnIdx + 10);
    //   必带 onClick + 文案 "查看日志"
    expect(btnBlock).toMatch(/onClick=/);
    expect(btnBlock).toMatch(/查看日志/);
    // 关键的: 按钮不能在 {hasAnyLog && (...)} 这种条件渲染里 — 检查前 80 字符内是否含 `&&`
    const before = src.slice(Math.max(0, btnStart - 100), btnStart);
    expect(before).not.toMatch(/hasAnyLog\s*&&/);
  });

  // 🆕 R53 R 列追加 (2 续): agent 类型点击跳 /tasks/{task_id}, shell 类型打开 modal
  it("R53-g) 「查看日志」按钮分支: agent → /tasks/{id}; shell → onShowFullLog (LogViewerDialog)", () => {
    const src = readSrc();
    // 找「查看日志」按钮的 onClick 函数体
    const btnIdx = src.indexOf("查看日志 →");
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    // onClick={() => { ... }} 块从 "onClick={() =>" 往后找
    const onClickIdx = src.lastIndexOf("onClick={() =>", btnIdx);
    expect(onClickIdx).toBeGreaterThanOrEqual(0);
    // onClick body 从 "{" 开始, 找下一个匹配的 "}" 之前
    const bodyStart = src.indexOf("{", onClickIdx);
    // body 末 (找 "</button>")
    const bodyEnd = src.indexOf("</button>", onClickIdx);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThanOrEqual(0);
    const body = src.slice(bodyStart, bodyEnd);
    // agent 分支跳 /tasks/{task_id}
    expect(body).toMatch(/schedule\.exec_type\s*===\s*["']agent["']/);
    expect(body).toMatch(/window\.location\.href\s*=\s*`\/tasks\/\$\{r\.task_id\}`/);
    // shell 分支调 onShowFullLog(r)
    expect(body).toMatch(/onShowFullLog\(r\)/);
  });

  // 🆕 R53 R 列追加 (2 兜底): agent 无 task_id 时按钮 disabled
  it("R53-h) agent 无 task_id 时「查看日志」按钮 disabled (兜底)", () => {
    const src = readSrc();
    const btnIdx = src.indexOf("查看日志 →");
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    // 往前找最近的 <button 起点
    const btnStart = src.lastIndexOf("<button", btnIdx);
    expect(btnStart).toBeGreaterThanOrEqual(0);
    const btnBlock = src.slice(btnStart, btnIdx);
    // disabled 表达式含 agent && !r.task_id
    expect(btnBlock).toMatch(/disabled=\{schedule\.exec_type\s*===\s*["']agent["']\s*&&\s*!r\.task_id\}/);
  });

  // 🆕 R53 R 列第 3-5 轮: 「查看日志 →」按钮应可见可点 (damo 多轮反馈换行)
  //   第 6 轮把按钮独立成 6th 「操作」列, 老测试 (flex 容器 / max-w-md / ml-auto)
  //   全部失效。本测试改为只锁「按钮在 6th 列 + 操作 header + table-fixed + colgroup」,
  //   而非逐轮记录 layout 细节 (5 轮迭代下来 layout 已稳定, 不再过度约束)。
  it("R53-i) 第 6 轮: 「查看日志 →」按钮独立在 6th 「操作」列 (table-fixed + colgroup 控列宽)", () => {
    const src = readSrc();
    // 1. <table> 用 table-fixed (锁定布局, 不再 auto-expand)
    expect(src).toMatch(/<table\s+className="[^"]*table-fixed/);
    // 2. <colgroup> 显式控列宽 (5 个固定 + 1 个自适应 = 6 列)
    expect(src).toContain("<colgroup>");
    expect(src).toContain("<col className=\"w-24\"");
    // 3. 表头有「操作」列
    expect(src).toContain(">操作</th>");
    // 4. 「查看日志 →」按钮所在的 <td> 在每个 row 里出现, 且 text-right 让按钮靠右
    const btnIdx = src.indexOf("查看日志 →");
    expect(btnIdx).toBeGreaterThanOrEqual(0);
    const left = src.slice(0, btnIdx);
    // 找最近的 <td className 起点 (是 6th 列的 td, 不是 5th 列)
    const tdStart = left.lastIndexOf('<td className=');
    expect(tdStart).toBeGreaterThanOrEqual(0);
    const tdAttrEnd = src.indexOf(">", tdStart);
    expect(tdAttrEnd).toBeGreaterThanOrEqual(0);
    const tdAttr = src.slice(tdStart, tdAttrEnd);
    expect(tdAttr).toMatch(/text-right/);
    // 5. 按钮独立 cell, 不再带 shrink-0 / ml-auto (button 已是独占列, 不再 flex 内)
    const btnStart = left.lastIndexOf("<button", btnIdx);
    expect(btnStart).toBeGreaterThanOrEqual(0);
    const btnBlock = src.slice(btnStart, btnIdx);
    expect(btnBlock).not.toMatch(/shrink-0/);
    expect(btnBlock).not.toMatch(/ml-auto/);
    // 6. hover + padding 等装饰仍保留
    expect(btnBlock).toMatch(/hover:bg-blue-50/);
    expect(btnBlock).toMatch(/px-1\.5\s+py-0\.5|rounded/);
  });

  // 🆕 R53 R 列第 6 轮: 5th 「命令 / 输出 / 错误」列不再含按钮
  it("R53-j) 第 6 轮: 5th 「命令 / 输出 / 错误」列不再含按钮 (操作已独立成列)", () => {
    const src = readSrc();
    // 5th 列内容含 task_id link / command / stdout/stderr, 但不再含 button
    // 验证: task_id slice(0, 8) Link 仍存在
    expect(src).toMatch(/r\.task_id\.slice\(0,\s*8\)/);
    // code 元素仍存在
    expect(src).toMatch(/<code\s+className="font-mono/);
    // 但 code 不再含 max-w-md flex-1 (cell 宽度由 colgroup 控制, code 不需要这些 hack)
    const codeStart = src.indexOf('<code className="font-mono');
    expect(codeStart).toBeGreaterThanOrEqual(0);
    const codeEnd = src.indexOf(">", codeStart + 10);
    expect(codeEnd).toBeGreaterThanOrEqual(0);
    const codeAttr = src.slice(codeStart, codeEnd);
    expect(codeAttr).not.toMatch(/max-w-md/);
    expect(codeAttr).not.toMatch(/flex-1/);
    expect(codeAttr).not.toMatch(/min-w-0/);
  });
});