// listTasksPage() 精简投影的契约: 大字段 (prompt/result/error) 不出现在 items
// 里, 替换为 prompt_preview/result_preview/error_preview. 信封 {items,total,
// hasMore} 形态正确. SUBSTR(prompt, -150) 取末尾 150 字符, 命中增强版 prompt
// 尾部的用户实际诉求 (preflight/dispatcher/role preamble 在头部).
//
// 为什么要写专门的测试文件: 投影是性能改造的「可信边界」—— 前端按 TaskTrimmed
// 类型访问, 如果某天有人手抖把 SUBSTR 写反 (0, 150) 或者漏掉 COALESCE, 看板
// 会立刻显示 preflight 噪音或运行时崩. 这个文件守住投影本身; 状态分组的语义
// 由 tasks-page-status-group.test.ts 覆盖, 索引由 tasks-owner-status-index.
// test.ts 覆盖.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createTask } from "./tasks";
import { listTasksPage } from "./tasks";
import { updateTaskStatus } from "./tasks";
import { createRequirement, updateRequirement } from "./requirements";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-page-proj-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs migrations

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "page-projection-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 投影字段集合: TaskTrimmed 应有 26 个字段, 任何大字段 (prompt/result/error/
// session_id/metadata 等) 都不能出现在 items 里. v32 dispatched_by_task_id + v61
// awaiting_markers 已加入 TaskTrimmed (Q2/Q3 R39), R99 schedule_id 加入 (定时 chip 标记).
describe("listTasksPage: projection shape", () => {
  it("returns only TaskTrimmed fields, never the full Task", () => {
    createTask({ title: "t", prompt: "do work", project_id: projectId });
    const { items } = listTasksPage({
      statusGroup: "all",
      ownerId,
    });

    expect(items.length).toBe(1);
    const item = items[0];

    // 必须存在 (TaskTrimmed 字段)
    expect(item.id).toBeTypeOf("string");
    expect(item.title).toBe("t");
    expect(item.prompt_preview).toBeTypeOf("string");
    expect(item.result_preview).toBeTypeOf("string");
    expect(item.error_preview).toBeTypeOf("string");
    expect(item.status).toBeTypeOf("string");

    // 不能存在 (会撑爆 payload 的字段)
    expect((item as unknown as Record<string, unknown>).prompt).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).result).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).error).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).session_id).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).metadata).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).structured_output).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).cwd).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).allowed_tools).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).forked_from_session_id).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).depends_on).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).preflight_result).toBeUndefined();
    // v32 dispatched_by_task_id: 已纳入 TaskTrimmed (R39 Q2 显示 [by] 角标), 必存
    expect((item as unknown as Record<string, unknown>).dispatched_by_task_id).toBeDefined();
    // v61 awaiting_markers: 已纳入 TaskTrimmed (R39 Q3 多类型 marker), 必存
    expect((item as unknown as Record<string, unknown>).awaiting_markers).toBeDefined();
    // R94: requirement_status 字段必存在, 无关联需求时为 null
    expect((item as unknown as Record<string, unknown>).requirement_status).toBeNull();
    // R99: schedule_id 字段必存在, 无定时任务派发时为 null
    expect((item as unknown as Record<string, unknown>).schedule_id).toBeNull();
  });

  it("prompt_preview is the LAST 150 chars of the augmented prompt (user input lives at the end)", () => {
    // 用户实际输入要能被 preview 拿到 — 这是 SUBSTR(prompt, -150) 设计的核心
    // 动机. 反向断言: 如果有人把 SUBSTR 写成 SUBSTR(prompt, 0, 150), 这个测试
    // 会立刻失败 (preview 会显示 preflight 文本而不是用户输入).
    const USER_INPUT = "USER_INPUT_MARKER_XYZ_THIS_IS_THE_ACTUAL_REQUEST";
    // 故意把用户输入放在 prompt 的尾部 (createTask 会把 preflight/preamble 拼在头)
    createTask({
      title: "long-prompt",
      // prompt 字段拼到末尾 — createTask 把它当用户输入
      prompt: USER_INPUT,
      project_id: projectId,
    });

    const { items } = listTasksPage({
      statusGroup: "all",
      ownerId,
    });

    expect(items.length).toBe(1);
    // 即使整段 prompt < 150 字符, preview 也必须包含用户输入
    expect(items[0].prompt_preview).toContain("USER_INPUT_MARKER_XYZ");
  });

  it("prompt_preview is exactly 150 chars (or full prompt if shorter)", () => {
    const longInput = "A".repeat(500); // 用户输入 500 字符
    createTask({
      title: "long",
      prompt: longInput,
      project_id: projectId,
    });

    const { items } = listTasksPage({ statusGroup: "all", ownerId });

    expect(items.length).toBe(1);
    // preview 必须是末尾 150 字符, 不多不少
    expect(items[0].prompt_preview.length).toBe(150);
    expect(items[0].prompt_preview.endsWith("A".repeat(150))).toBe(true);
  });

  it("result_preview and error_preview are empty strings when source columns are NULL", () => {
    // 新建的 task 没有 result/error
    createTask({ title: "t", prompt: "x", project_id: projectId });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });

    expect(items[0].result_preview).toBe("");
    expect(items[0].error_preview).toBe("");
  });

  it("result_preview is the FIRST 150 chars of result (head, not tail)", () => {
    // 与 prompt 不同: result 是 agent 最终输出, 头部通常是「摘要/标题」段,
    // 摘要段对列表预览更有用. 所以 result 用 SUBSTR(result, 1, 150) (头部).
    // createTask 不写 result, 用 updateTaskStatus 在 task 跑完后写入.
    const t = createTask({ title: "t", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "completed", { result: "R".repeat(500) });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });

    expect(items[0].result_preview.length).toBe(150);
    expect(items[0].result_preview.startsWith("R".repeat(150))).toBe(true);
  });
});

// 信封 {items,total,hasMore} 形态正确. hasMore 计算逻辑是核心: 客户端拿这个
// 决定要不要显示「加载更多」按钮. 算错会要么永远隐藏要么永远显示.
describe("listTasksPage: envelope shape", () => {
  it("returns total=0 and hasMore=false for empty result", () => {
    const { items, total, hasMore } = listTasksPage({
      statusGroup: "all",
      ownerId,
    });

    expect(items).toEqual([]);
    expect(total).toBe(0);
    expect(hasMore).toBe(false);
  });

  it("reports total correctly when more rows exist beyond limit", () => {
    for (let i = 0; i < 7; i++) {
      createTask({ title: `t-${i}`, prompt: "x", project_id: projectId });
    }

    const page1 = listTasksPage({
      statusGroup: "all",
      ownerId,
      limit: 3,
      offset: 0,
    });

    expect(page1.items.length).toBe(3);
    expect(page1.total).toBe(7);
    expect(page1.hasMore).toBe(true);
  });

  it("reports hasMore=false on the final partial-or-exact page", () => {
    for (let i = 0; i < 5; i++) {
      createTask({ title: `t-${i}`, prompt: "x", project_id: projectId });
    }

    // offset=3, limit=3 → items 长度 2, offset+items=5 === total=5 → hasMore false
    const lastPage = listTasksPage({
      statusGroup: "all",
      ownerId,
      limit: 3,
      offset: 3,
    });

    expect(lastPage.items.length).toBe(2);
    expect(lastPage.total).toBe(5);
    expect(lastPage.hasMore).toBe(false);
  });

  it("respects default limit=50 when none provided", () => {
    for (let i = 0; i < 60; i++) {
      createTask({ title: `t-${i}`, prompt: "x", project_id: projectId });
    }

    const { items, total, hasMore } = listTasksPage({
      statusGroup: "all",
      ownerId,
    });

    expect(items.length).toBe(50);
    expect(total).toBe(60);
    expect(hasMore).toBe(true);
  });

  it("applies project_id and version_id filters (verified via low-level SQL)", () => {
    // 第二个 project, 验证 project_id 过滤
    const otherProjectId = createProject({ name: "page-projection-other", ownerId }).id;
    createTask({ title: "in-default", prompt: "x", project_id: projectId });
    createTask({ title: "in-other", prompt: "x", project_id: otherProjectId });

    const onlyDefault = listTasksPage({
      statusGroup: "all",
      ownerId,
      project_id: projectId,
    });
    expect(onlyDefault.total).toBe(1);
    expect(onlyDefault.items[0].title).toBe("in-default");

    const onlyOther = listTasksPage({
      statusGroup: "all",
      ownerId,
      project_id: otherProjectId,
    });
    expect(onlyOther.total).toBe(1);
    expect(onlyOther.items[0].title).toBe("in-other");
  });

  it("respects owner_id isolation (cross-tenant not leaked)", () => {
    const strangerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(strangerId, `${strangerId}@example.com`, "x", "user");
    const strangerProject = createProject({ name: "stranger-proj", ownerId: strangerId }).id;
    createTask({ title: "mine", prompt: "x", project_id: projectId });
    createTask({ title: "stranger", prompt: "x", project_id: strangerProject });

    const mine = listTasksPage({ statusGroup: "all", ownerId });
    expect(mine.items.map((t) => t.title)).toEqual(["mine"]);

    const theirs = listTasksPage({ statusGroup: "all", ownerId: strangerId });
    expect(theirs.items.map((t) => t.title)).toEqual(["stranger"]);
  });
});

// R94: 任务列表投影带回关联需求点 status, 用于聊天列表/看板卡片显示「等回复 / 有建议 /
// 需拍板」chip. LEFT JOIN + owner 隔离保证越权/孤儿需求不污染 UI.
// 重点覆盖:
//   - 三个中间态 (awaiting_reply / has_suggestion / blocked) 正确带值;
//   - pending / done / closed 不带 (虽然字段值会被回, 但 UI 仅在 chips 三态渲染);
//   - task 无关联 / 关联到另一 owner 的需求 → null (LEFT JOIN 兜底);
//   - 多租户: cross-tenant 关联不漏.
// 任务 status 字段不影响 SQL 派生 (SQL 只读 requirements.status), UI 层只在 reviewing
// 时渲染 chip, 因此这里只断言 SQL 投影即可, UI 渲染由 component 测试或人工验收.
describe("listTasksPage: requirement_status projection (R94)", () => {
  it("returns null when task has no requirement_id", () => {
    createTask({ title: "lone", prompt: "x", project_id: projectId });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    expect(items).toHaveLength(1);
    expect(items[0].requirement_status).toBeNull();
  });

  it("projects awaiting_reply / has_suggestion / blocked (chip-visible 三态)", () => {
    const req1 = createRequirement(projectId, { title: "r1" }, ownerId);
    const req2 = createRequirement(projectId, { title: "r2" }, ownerId);
    const req3 = createRequirement(projectId, { title: "r3" }, ownerId);
    updateRequirement(req1.id, { status: "awaiting_reply" }, ownerId);
    updateRequirement(req2.id, { status: "has_suggestion" }, ownerId);
    updateRequirement(req3.id, { status: "blocked" }, ownerId);

    createTask({ title: "t-await", prompt: "x", project_id: projectId, requirement_id: req1.id });
    createTask({ title: "t-sugg", prompt: "x", project_id: projectId, requirement_id: req2.id });
    createTask({ title: "t-block", prompt: "x", project_id: projectId, requirement_id: req3.id });

    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const byTitle = Object.fromEntries(items.map((t) => [t.title, t.requirement_status]));
    expect(byTitle["t-await"]).toBe("awaiting_reply");
    expect(byTitle["t-sugg"]).toBe("has_suggestion");
    expect(byTitle["t-block"]).toBe("blocked");
  });

  it("also projects pending / done / closed (字段值带回, 由 UI 决定是否渲染)", () => {
    const reqPending = createRequirement(projectId, { title: "r-pending" }, ownerId);
    const reqDone = createRequirement(projectId, { title: "r-done" }, ownerId);
    updateRequirement(reqDone.id, { status: "done" }, ownerId);
    // closed 走 updateRequirement 的 status 字段, 但因为 CHECK 包含 'closed', 应当允许.
    const reqClosed = createRequirement(projectId, { title: "r-closed" }, ownerId);
    updateRequirement(reqClosed.id, { status: "closed" }, ownerId);

    createTask({ title: "t-p", prompt: "x", project_id: projectId, requirement_id: reqPending.id });
    createTask({ title: "t-d", prompt: "x", project_id: projectId, requirement_id: reqDone.id });
    // createTask 校验拒绝 closed 关联 (防误关联), 这里绕过校验直接写库模拟「旧数据 / 跨版本演进」场景.
    const closedTaskId = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, project_id, requirement_id, owner_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(closedTaskId, "t-c", "x", projectId, reqClosed.id, ownerId);

    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const byTitle = Object.fromEntries(items.map((t) => [t.title, t.requirement_status]));
    expect(byTitle["t-p"]).toBe("pending");
    expect(byTitle["t-d"]).toBe("done");
    expect(byTitle["t-c"]).toBe("closed");
  });

  it("returns null when requirement belongs to another owner (multi-tenant isolation)", () => {
    // 另一个 owner 的需求点, 即使 requirement_id 撞到本 owner task 上, JOIN 的 owner 条件
    //   会让 req 行匹配不到 → requirement_status 为 NULL.
    const strangerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(strangerId, `${strangerId}@example.com`, "x", "user");
    const strangerProject = createProject({ name: "stranger-proj", ownerId: strangerId }).id;
    const strangerReq = createRequirement(strangerProject, { title: "stranger-req" }, strangerId);
    updateRequirement(strangerReq.id, { status: "has_suggestion" }, strangerId);

    // 本 owner task 直接写一个指向 stranger 需求 id 的 requirement_id, 不通过 createTask
    //   (createTask 会校验 owner 一致并拒掉, 这里我们绕开校验模拟异常脏数据场景).
    const taskId = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, project_id, requirement_id, owner_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, "t-cross", "x", projectId, strangerReq.id, ownerId);

    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const mine = items.find((t) => t.id === taskId);
    expect(mine).toBeDefined();
    expect(mine!.requirement_status).toBeNull(); // JOIN owner 不匹配, req 行被过滤掉
  });

  it("LEFT JOIN does not duplicate task rows (1 task + 1 req = 1 row)", () => {
    // 反向: 多 owner 的同一 requirement_id 撞库, JOIN 不会让 1 行变 2 行.
    const req = createRequirement(projectId, { title: "single" }, ownerId);
    updateRequirement(req.id, { status: "awaiting_reply" }, ownerId);
    createTask({ title: "single-task", prompt: "x", project_id: projectId, requirement_id: req.id });

    const { items, total } = listTasksPage({ statusGroup: "all", ownerId });
    // 过滤出 requirement_status 为 awaiting_reply 的 task — 应至少 1 条 (single-task).
    expect(items.filter((t) => t.requirement_status === "awaiting_reply").length).toBeGreaterThanOrEqual(1);
    expect(items.find((t) => t.title === "single-task")!.requirement_status).toBe("awaiting_reply");
    // total = 1, 不重复
    expect(total).toBe(1);
  });
});
// R182: statusCounts — 同 WHERE 下 per-status 计数 (GROUP BY status).
// 场景: terminal 段 completed 淹没 failed (55 个 failed 只有 1 个排进前 200),
// 前端 chip 靠这个计数显示「失败 N」让错误状态可见. 三个断言点:
//   1) 计数只算本 owner + 本 statusGroup 段 (隔离性);
//   2) 状态迁移后计数跟着变 (running→failed 后 failed+1 running-1);
//   3) includeDeleted=false 不算软删行.
describe("listTasksPage: statusCounts (R182)", () => {
  it("counts per status within the filter's statusGroup and owner", () => {
    const c = createTask({ title: "c1", prompt: "x", project_id: projectId });
    const f = createTask({ title: "f1", prompt: "x", project_id: projectId });
    const p = createTask({ title: "p1", prompt: "x", project_id: projectId });
    updateTaskStatus(c.id, "completed");
    updateTaskStatus(f.id, "failed");
    // p 不动 (createTask 默认 pending)

    const { statusCounts } = listTasksPage({ statusGroup: "terminal", ownerId });
    expect(statusCounts["failed"]).toBe(1);
    expect(statusCounts["completed"]).toBe(1);
    // pending 不在 terminal 段
    expect(statusCounts["pending"]).toBeUndefined();

    const active = listTasksPage({ statusGroup: "active", ownerId }).statusCounts;
    expect(active["pending"]).toBe(1);
    expect(active["running"]).toBeUndefined();
    void p;
  });

  it("reflects a running→failed transition (the damo-reported scenario)", () => {
    const t = createTask({ title: "will-fail", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "running");
    let counts = listTasksPage({ statusGroup: "active", ownerId }).statusCounts;
    expect(counts["running"]).toBe(1);
    expect(counts["failed"]).toBeUndefined();

    updateTaskStatus(t.id, "failed", { error: "boom" });
    counts = listTasksPage({ statusGroup: "terminal", ownerId }).statusCounts;
    expect(counts["failed"]).toBe(1);
    // total 与 counts 之和一致 (信封自洽)
    const { total } = listTasksPage({ statusGroup: "terminal", ownerId });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("excludes soft-deleted rows when includeDeleted is false", () => {
    const t = createTask({ title: "gone", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "failed");
    getDb().prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?`).run(t.id);

    const { statusCounts } = listTasksPage({ statusGroup: "terminal", ownerId });
    expect(statusCounts["failed"]).toBeUndefined();

    const withDeleted = listTasksPage({ statusGroup: "terminal", ownerId, includeDeleted: true }).statusCounts;
    expect(withDeleted["failed"]).toBe(1);
  });
});

// 历史 rejected 显示兼容 (2026-09-15 review-state-machine-refactor 决策; 2026-11-01
// 落地读路径): rejected 已废弃不再写入, listTasksPage 把遗留行统一按 cancelled 返回 —
// 行集 status 字段、statuses 过滤、statusCounts 计数三处同口径. 场景: damo 在全局
// 看板看到「等待中 3」幽灵 chip, 点进去全是打回的历史件 (本来该显示已取消).
describe("listTasksPage: legacy rejected → cancelled display compat", () => {
  it("maps legacy rejected rows to cancelled in items", () => {
    const t = createTask({ title: "legacy-rejected", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "rejected");

    const { items } = listTasksPage({ statusGroup: "terminal", ownerId });
    const row = items.find((x) => x.title === "legacy-rejected");
    expect(row).toBeDefined();
    expect(row!.status).toBe("cancelled");
  });

  it("merges rejected count into cancelled in statusCounts (no rejected key)", () => {
    const a = createTask({ title: "r1", prompt: "x", project_id: projectId });
    const b = createTask({ title: "r2", prompt: "x", project_id: projectId });
    const c = createTask({ title: "c-merge", prompt: "x", project_id: projectId });
    updateTaskStatus(a.id, "rejected");
    updateTaskStatus(b.id, "rejected");
    updateTaskStatus(c.id, "cancelled");

    const { statusCounts, total } = listTasksPage({ statusGroup: "terminal", ownerId });
    expect(statusCounts["rejected"]).toBeUndefined();
    expect(statusCounts["cancelled"]).toBe(3);
    // 信封自洽: counts 之和 = total
    expect(Object.values(statusCounts).reduce((x, y) => x + y, 0)).toBe(total);
  });

  it("statuses filter ['cancelled'] pulls legacy rejected rows (and stale ['rejected'] too)", () => {
    const t = createTask({ title: "r3", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "rejected");

    // 前端点「已取消」chip 只传 cancelled → 也要带出 rejected 遗留行
    const viaCancelled = listTasksPage({ statusGroup: "terminal", ownerId, statuses: ["cancelled"] });
    expect(viaCancelled.items.some((x) => x.title === "r3")).toBe(true);

    // stale URL 传 rejected → 归到 cancelled 桶, 返回行 status 已映射
    const viaRejected = listTasksPage({ statusGroup: "terminal", ownerId, statuses: ["rejected"] });
    expect(viaRejected.items.some((x) => x.title === "r3")).toBe(true);
    expect(viaRejected.items.every((x) => x.status === "cancelled")).toBe(true);
  });
});
