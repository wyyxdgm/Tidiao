// listTasksPage() 的 statusGroup 参数语义:
//   "active"   → status IN (pending, queued, running, paused, reviewing) — 用户
//                实际盯着的「在飞」状态, 通常 <20 行, 永远全量加载 + SSE.
//   "terminal" → status IN (completed, failed, rejected, cancelled) — 历史包袱,
//                300+ 行常见, 走分页 + 客户端虚拟滚动.
//   "all"      → 不加 status 条件.
//
// ACTIVE_STATUSES 故意把 paused/reviewing 纳入 (它们"在等人/系统", 不是终态),
// PAGE_TERMINAL_STATUSES 把 rejected 纳入 (跟 TERMINAL_TASK_STATUSES 区分:
// schedule 防重派闸门不把 rejected 当终态, 但看板视图里 rejected 就是终态之一).
//
// 关注点:
//   - "active" / "terminal" 的 status 集合是看板分流的真相之源. 一旦错位 (比如
//     把 completed 放进 active), 客户端会把 300+ 完成态塞进 SSE realtime 路径,
//     改造彻底失败.
//   - "all" 与「不加 statusGroup 参数」行为一致 (兼容未来的 unset 默认值).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createTask, updateTaskStatus, listTasksPage, ACTIVE_STATUSES, PAGE_TERMINAL_STATUSES } from "./tasks";
import type { TaskStatus } from "../runtime/types";
import { ALL_STATUSES } from "../constants";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-page-group-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "page-group-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 集合层面的契约: ACTIVE_STATUSES 与 PAGE_TERMINAL_STATUSES 互不相交, 也不漏
// status. 这条不变量是看板分流「物理层」的保证 — 即便 listTasksPage 实现里有人
// 拼错了 WHERE 子句, 集合本身也应该是对的.
describe("status group constants", () => {
  it("ACTIVE_STATUSES and PAGE_TERMINAL_STATUSES do not overlap", () => {
    for (const s of ACTIVE_STATUSES) {
      expect(PAGE_TERMINAL_STATUSES).not.toContain(s);
    }
  });

  it("ACTIVE ∪ TERMINAL covers ALL_STATUSES minus no one", () => {
    const union = new Set<TaskStatus>([...ACTIVE_STATUSES, ...PAGE_TERMINAL_STATUSES]);
    expect(union.size).toBe(ALL_STATUSES.length);
    for (const s of ALL_STATUSES) {
      expect(union.has(s as TaskStatus)).toBe(true);
    }
  });

  // 🆕 DAG P3 加 verifying + R131 加 await_user (2026-09-15), ACTIVE 现在 7 个.
  //   之前期望集 (5 个) 是 D3 拍板时的快照, 后两次扩 ACTIVE 都没同步这个断言,
  //   本轮借机修.
  it("ACTIVE_STATUSES contains the 7 expected states", () => {
    expect(new Set(ACTIVE_STATUSES)).toEqual(
      new Set<TaskStatus>(["pending", "queued", "running", "paused", "reviewing", "verifying", "await_user"])
    );
  });

  it("PAGE_TERMINAL_STATUSES contains the 4 expected states", () => {
    expect(new Set(PAGE_TERMINAL_STATUSES)).toEqual(
      new Set<TaskStatus>(["completed", "failed", "rejected", "cancelled"])
    );
  });
});

// 一行一个 status, 验证 statusGroup 过滤的 SQL 语义. 这是看板分流「行为层」
// 的保证 — statusGroup 选错, 看板就完全错位.
describe("listTasksPage: statusGroup filtering", () => {
  // 在 beforeEach 里跑不了 (active/terminal 测试需要各自种对应状态), 所以
  // 在 it 里本地种数据.
  async function seedAllStatuses() {
    const titles: TaskStatus[] = [...ALL_STATUSES] as TaskStatus[];
    const tasks: Record<TaskStatus, string> = {} as Record<TaskStatus, string>;
    for (const s of titles) {
      const t = createTask({ title: `t-${s}`, prompt: "x", project_id: projectId });
      updateTaskStatus(t.id, s);
      tasks[s] = t.id;
    }
    return tasks;
  }

  // 🆕 DAG P3 + R131 后 active 是 7 个 (见上). 描述同步.
  it('statusGroup="active" returns only the 7 active states', async () => {
    await seedAllStatuses();
    const { items, total } = listTasksPage({ statusGroup: "active", ownerId });

    expect(total).toBe(ACTIVE_STATUSES.length);
    const statuses = new Set(items.map((t) => t.status));
    for (const s of ACTIVE_STATUSES) {
      expect(statuses.has(s)).toBe(true);
    }
    for (const s of PAGE_TERMINAL_STATUSES) {
      expect(statuses.has(s)).toBe(false);
    }
  });

  it('statusGroup="terminal" returns only the 4 terminal states', async () => {
    await seedAllStatuses();
    const { items, total } = listTasksPage({ statusGroup: "terminal", ownerId });

    expect(total).toBe(PAGE_TERMINAL_STATUSES.length);
    const statuses = new Set(items.map((t) => t.status));
    // 历史 rejected 显示兼容 (2026-11-01): rejected 种子行以 cancelled 形态返回,
    // items 不再出现 rejected 原值 — completed/failed/cancelled 必在, rejected 必不在.
    for (const s of ["completed", "failed", "cancelled"] as const) {
      expect(statuses.has(s)).toBe(true);
    }
    expect(statuses.has("rejected")).toBe(false);
    for (const s of ACTIVE_STATUSES) {
      expect(statuses.has(s)).toBe(false);
    }
  });

  it('statusGroup="all" returns every status', async () => {
    await seedAllStatuses();
    const { items, total } = listTasksPage({ statusGroup: "all", ownerId });

    expect(total).toBe(ALL_STATUSES.length);
    expect(items.length).toBe(ALL_STATUSES.length);
  });

  it("statusGroup partition: active + terminal === all", async () => {
    await seedAllStatuses();
    const active = listTasksPage({ statusGroup: "active", ownerId });
    const terminal = listTasksPage({ statusGroup: "terminal", ownerId });
    const all = listTasksPage({ statusGroup: "all", ownerId });

    expect(active.total + terminal.total).toBe(all.total);
  });

  it("soft-deleted tasks are excluded by default (and respect includeDeleted)", () => {
    const a = createTask({ title: "alive", prompt: "x", project_id: projectId });
    const d = createTask({ title: "dead", prompt: "x", project_id: projectId });

    // 软删 d: 用 DB 直接 UPDATE, 走 softDelete API 不必要, 这里只测过滤
    getDb()
      .prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?")
      .run(d.id);

    const visible = listTasksPage({ statusGroup: "all", ownerId });
    expect(visible.items.map((t) => t.id).sort()).toEqual([a.id].sort());

    const withDeleted = listTasksPage({
      statusGroup: "all",
      ownerId,
      includeDeleted: true,
    });
    expect(withDeleted.items.map((t) => t.id).sort()).toEqual([a.id, d.id].sort());
  });
});

// 飞书 AO-DEV R236: statuses 精确状态集 — AND 语义, 在 statusGroup 段内收窄.
// 场景: 全局看板「活跃/历史」改成 chip 宏后, 用户跨组混选 (running + completed) —
// 前端拉两段 (active + terminal), 每段服务端 AND 出组内选中子集, 两段不相交,
// 拼接不重不漏. (曾做成「优先于 statusGroup」, 实测两段返回同一份混合行集 →
// 前端每条渲染两次 + total 翻倍, 已废弃该语义, 本组测试钉死 AND 契约.)
describe("listTasksPage: statuses precise filter (R236, AND semantics)", () => {
  async function seedAllStatuses() {
    const titles: TaskStatus[] = [...ALL_STATUSES] as TaskStatus[];
    const tasks: Record<TaskStatus, string> = {} as Record<TaskStatus, string>;
    for (const s of titles) {
      const t = createTask({ title: `t-${s}`, prompt: "x", project_id: projectId });
      updateTaskStatus(t.id, s);
      tasks[s] = t.id;
    }
    return tasks;
  }

  it("cross-group mix via two segments: union is exact, segments disjoint (running + completed)", async () => {
    await seedAllStatuses();
    // 前端混选 running+completed 时的真实请求形态: active 段 + terminal 段各带全量选中集
    const activeSeg = listTasksPage({
      statusGroup: "active",
      statuses: ["running", "completed"], // 组外状态 (completed) 被 AND 掉
      ownerId,
    });
    const terminalSeg = listTasksPage({
      statusGroup: "terminal",
      statuses: ["running", "completed"], // 组外状态 (running) 被 AND 掉
      ownerId,
    });

    // 每段只回自己组内的选中状态
    expect(activeSeg.total).toBe(1);
    expect(activeSeg.items.map((t) => t.status)).toEqual(["running"]);
    expect(terminalSeg.total).toBe(1);
    expect(terminalSeg.items.map((t) => t.status)).toEqual(["completed"]);

    // 拼接不重不漏 = 混选目标的精确集
    const merged = [...activeSeg.items, ...terminalSeg.items];
    expect(merged.length).toBe(2);
    expect(new Set(merged.map((t) => t.id)).size).toBe(2);
    expect(new Set(merged.map((t) => t.status))).toEqual(new Set(["running", "completed"]));

    // 前端 total = 两段 total 之和 (页码数学)
    expect(activeSeg.total + terminalSeg.total).toBe(2);
  });

  it("AND semantics: statusGroup=terminal + statuses=[running] → empty (组外状态被排除)", async () => {
    await seedAllStatuses();
    const { items, total, statusCounts } = listTasksPage({
      statusGroup: "terminal",
      statuses: ["running"],
      ownerId,
    });
    expect(total).toBe(0);
    expect(items).toEqual([]);
    expect(statusCounts).toEqual({});
  });

  it("single-status subset narrows total within a group", async () => {
    await seedAllStatuses();
    const { total } = listTasksPage({
      statusGroup: "active",
      statuses: ["pending"],
      ownerId,
    });
    expect(total).toBe(1);
  });

  it("fingerprint differs across different selections (no fake 304)", async () => {
    await seedAllStatuses();
    const { listTasksPageFingerprint, runTasksPageStatusRows } = await import("./tasks");
    const fpRunning = listTasksPageFingerprint(
      { statusGroup: "active", statuses: ["running"], ownerId },
      undefined,
    );
    const fpPending = listTasksPageFingerprint(
      { statusGroup: "active", statuses: ["pending"], ownerId },
      undefined,
    );
    // 不同选择集 → counts 段不同 → 指纹必不同 (同缓存键下不会假 304)
    expect(fpRunning).not.toBe(fpPending);

    // statusRows 复用路径: 传入的 rows 与 filter 同 WHERE 时指纹一致
    const rows = runTasksPageStatusRows({ statusGroup: "active", statuses: ["running"], ownerId });
    const fpWithRows = listTasksPageFingerprint(
      { statusGroup: "active", statuses: ["running"], ownerId },
      rows,
    );
    expect(fpWithRows).toBe(fpRunning);
  });

  it("group-level macro: statuses = full ACTIVE set ≡ statusGroup=active", async () => {
    await seedAllStatuses();
    const viaGroup = listTasksPage({ statusGroup: "active", ownerId });
    const viaStatuses = listTasksPage({
      statusGroup: "active",
      statuses: [...ACTIVE_STATUSES],
      ownerId,
    });
    expect(viaStatuses.total).toBe(viaGroup.total);
    expect(viaStatuses.items.map((t) => t.id).sort()).toEqual(viaGroup.items.map((t) => t.id).sort());
  });
});