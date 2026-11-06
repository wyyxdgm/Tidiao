// Tests for 构思层 ideas/idea_nodes/idea_links/idea_signals (v520/v521, idea-canvas P0).
//
// 覆盖验收 (docs/plans/idea-canvas.md §2 D2/D3 + §3):
//   1) createIdea/getIdea owner 隔离 (B 看不到 A 的 idea, no existence leak)
//   2) listIdeas 计数 (node/task/signal 三列)
//   3) updateIdea 白名单字段写: 非法 status 抛 STATUS_INVALID; 白名单外字段静默忽略
//   4) concludeIdea: conclusion + concluded_at + status 一次写入
//   5) deleteIdea: 级联清 nodes/links/signals/pin 条目, tasks.idea_id/node_id 置 NULL (弱引用 D3)
//   6) 节点: 错 owner 建 → null; setNodeDeps 自依 → DEP_SELF; 跨 idea → DEP_CROSS_IDEA;
//      环 → DEP_CYCLE; 合法 deps 整组替换语义
//   7) signals: add/list/get owner 校验; getIdeaROI 成本汇总 + kind 汇总 + overdue 标记
//   8) updateIdeaNode 非法 status 抛 STATUS_INVALID
//
// 模式与 requirements.test.ts 同款: 真 SQLite 临时库 + closeDb() 重启 + getDb() 跑 migration.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import {
  createIdea,
  getIdea,
  listIdeas,
  updateIdea,
  concludeIdea,
  deleteIdea,
  createIdeaNode,
  getIdeaNode,
  listIdeaNodes,
  updateIdeaNode,
  setNodeDeps,
  addIdeaLink,
  removeIdeaLink,
  listIdeaLinks,
  addIdeaSignal,
  listIdeaSignals,
  getIdeaSignal,
  getIdeaROI,
} from "./ideas";
import { createPinList, addPinListItem, listPinLists } from "./pin-lists";
import { createTask } from "./tasks";
import { createProject } from "./projects";
import { createVersion } from "./versions";

let tmpDir: string;
let ownerA: string;
let ownerB: string;

function seedUser(email: string): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(id, email, "x");
  return id;
}

function seedTask(ownerId: string, opts: { idea_id?: string; node_id?: string; cost_usd?: number } = {}): string {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, status, owner_id, prompt, idea_id, node_id, cost_usd)
       VALUES (?, 'seed-task', 'completed', ?, '', ?, ?, ?)`
    )
    .run(id, ownerId, opts.idea_id ?? null, opts.node_id ?? null, opts.cost_usd ?? null);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ideas-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑 migrations (含 v520-v523)
  ownerA = seedUser(`a-${uuidv4()}@example.com`);
  ownerB = seedUser(`b-${uuidv4()}@example.com`);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("ideas CRUD + owner 隔离", () => {
  it("createIdea 默认 germinating; B 看不到 A 的 idea (no existence leak)", () => {
    const idea = createIdea({ owner_id: ownerA, title: "idea 画布", hypothesis: "相信 X 让 Y" });
    expect(idea.status).toBe("germinating");
    expect(idea.hypothesis).toBe("相信 X 让 Y");
    expect(getIdea(idea.id, ownerB)).toBeNull();
  });

  it("listIdeas 计数三列: node/task/signal", () => {
    const idea = createIdea({ owner_id: ownerA, title: "i1" });
    createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n1" });
    createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n2" });
    seedTask(ownerA, { idea_id: idea.id, cost_usd: 0.5 });
    addIdeaSignal({ idea_id: idea.id, owner_id: ownerA, kind: "inquiry" });
    const list = listIdeas(ownerA);
    expect(list).toHaveLength(1);
    expect(list[0].node_count).toBe(2);
    expect(list[0].task_count).toBe(1);
    expect(list[0].signal_count).toBe(1);
  });

  it("updateIdea 白名单: 非法 status 抛 STATUS_INVALID; 白名单外字段忽略; pinned 转 0/1", () => {
    const idea = createIdea({ owner_id: ownerA, title: "t" });
    expect(() => updateIdea(idea.id, ownerA, { status: "nope" })).toThrowError(/STATUS_INVALID|invalid idea status/);
    const u1 = updateIdea(idea.id, ownerA, { hack: "x", title: "t2", pinned: true });
    expect(u1!.title).toBe("t2");
    expect(u1!.pinned).toBe(1);
    expect(u1!.hypothesis).toBeNull(); // hack 字段没被写进来
  });

  it("concludeIdea: 结论 + concluded_at + status 一次落", () => {
    const idea = createIdea({ owner_id: ownerA, title: "t" });
    const c = concludeIdea(idea.id, ownerA, "证伪：2 周零询问 (task 3de8)", "rejected");
    expect(c!.status).toBe("rejected");
    expect(c!.conclusion).toContain("证伪");
    expect(c!.concluded_at).toBeTruthy();
  });

  it("deleteIdea: 级联清子表 + pin 条目, tasks 弱引用置 NULL (D3)", () => {
    const idea = createIdea({ owner_id: ownerA, title: "t" });
    const node = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n" })!;
    const taskId = seedTask(ownerA, { idea_id: idea.id, node_id: node.id });
    const list = createPinList({ owner_id: ownerA, title: "候选池" });
    addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "idea", ref_id: idea.id });
    expect(deleteIdea(idea.id, ownerA)).toBe(true);
    expect(getIdea(idea.id, ownerA)).toBeNull();
    expect(getIdeaNode(node.id, ownerA)).toBeNull();
    expect(listIdeaSignals(idea.id, ownerA)).toHaveLength(0);
    const taskRow = getDb().prepare("SELECT idea_id, node_id FROM tasks WHERE id = ?").get(taskId) as any;
    expect(taskRow.idea_id).toBeNull();
    expect(taskRow.node_id).toBeNull();
    // pin 列表本体还在，条目被清
    expect(listPinLists(ownerA)).toHaveLength(1);
  });
});

describe("idea_nodes + 依赖", () => {
  it("错 owner 建节点 → null; updateIdeaNode 非法 status 抛 STATUS_INVALID", () => {
    const idea = createIdea({ owner_id: ownerA, title: "t" });
    expect(createIdeaNode({ idea_id: idea.id, owner_id: ownerB, title: "x" })).toBeNull();
    const node = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n" });
    expect(() => updateIdeaNode(node!.id, ownerA, { status: "flying" })).toThrowError(/STATUS_INVALID|invalid node status/);
    const u = updateIdeaNode(node!.id, ownerA, { status: "running" });
    expect(u!.status).toBe("running");
  });

  it("setNodeDeps: 自依 DEP_SELF / 跨 idea DEP_CROSS_IDEA / 环 DEP_CYCLE / 合法整组替换", () => {
    const idea = createIdea({ owner_id: ownerA, title: "t" });
    const n1 = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n1" })!;
    const n2 = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n2" })!;
    const n3 = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "n3" })!;
    expect(() => setNodeDeps(n1.id, ownerA, [n1.id])).toThrowError(/DEP_SELF|cannot depend on itself/);
    const otherIdea = createIdea({ owner_id: ownerA, title: "other" });
    const on = createIdeaNode({ idea_id: otherIdea.id, owner_id: ownerA, title: "on" })!;
    expect(() => setNodeDeps(n1.id, ownerA, [on.id])).toThrowError(/DEP_CROSS_IDEA|not in same idea/);
    // n1→n2, n2→n3 之后再加 n3→n1 = 环
    setNodeDeps(n2.id, ownerA, [n1.id]);
    setNodeDeps(n3.id, ownerA, [n2.id]);
    expect(() => setNodeDeps(n1.id, ownerA, [n3.id])).toThrowError(/DEP_CYCLE|dependency cycle/);
    // 合法: n3 依赖 n1, n2; 整组替换 (再设 [n1] 后只剩一条)
    setNodeDeps(n3.id, ownerA, [n1.id, n2.id]);
    expect(listIdeaNodes(idea.id, ownerA).find((n) => n.id === n3.id)!.depends_on.sort()).toEqual([n1.id, n2.id].sort());
    setNodeDeps(n3.id, ownerA, [n1.id]);
    expect(listIdeaNodes(idea.id, ownerA).find((n) => n.id === n3.id)!.depends_on).toEqual([n1.id]);
  });

  it("idea_links: 自链抛错 / 双方归属校验 / 去重更新 / 删", () => {
    const a = createIdea({ owner_id: ownerA, title: "a" });
    const b = createIdea({ owner_id: ownerA, title: "b" });
    const c = createIdea({ owner_id: ownerB, title: "c" });
    expect(() => addIdeaLink(ownerA, a.id, a.id)).toThrowError(/LINK_SELF|cannot link idea to itself/);
    expect(addIdeaLink(ownerA, a.id, c.id)).toBe(false); // c 属 B, no existence leak
    expect(addIdeaLink(ownerA, a.id, b.id, "depends", 2)).toBe(true);
    addIdeaLink(ownerA, a.id, b.id, "related", 1); // upsert
    const links = listIdeaLinks(ownerA);
    expect(links).toHaveLength(1);
    expect(links[0].relation).toBe("related");
    expect(removeIdeaLink(ownerA, a.id, b.id)).toBe(true);
    expect(listIdeaLinks(ownerA)).toHaveLength(0);
  });
});

describe("createTask 构思上下文注入 (P4)", () => {
  it("挂 idea+node 的任务, prompt 注入 [idea context] (假设/判据/节点/验证指引)", () => {
    const pid = createProject({ ownerId: ownerA, name: `p-${uuidv4()}`, }).id;
    const vid = createVersion({ project_id: pid, name: "v1" }).id;
    const idea = createIdea({
      owner_id: ownerA, title: "AO 变现",
      hypothesis: "相信成本归因会让外包公司付费",
      success_criteria: "2 周内 ≥3 真实询问",
    });
    const node = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "Design Partner 访谈", detail: "访谈 5 家外包公司" })!;
    const t = createTask({
      title: "访谈任务", prompt: "去做访谈", project_id: pid, version_id: vid,
      idea_id: idea.id, node_id: node.id, work_class: "plan",
    });
    expect(t.prompt).toContain("[idea context]");
    expect(t.prompt).toContain("构思: AO 变现");
    expect(t.prompt).toContain("假设: 相信成本归因会让外包公司付费");
    expect(t.prompt).toContain("验证判据: 2 周内 ≥3 真实询问");
    expect(t.prompt).toContain("节点: Design Partner 访谈");
    expect(t.prompt).toContain("节点要求: 访谈 5 家外包公司");
    expect(t.prompt).toContain("去做访谈"); // 原 prompt 完整保留
    // 不挂 idea 的任务不注入
    const t2 = createTask({ title: "普通任务", prompt: "p2", project_id: pid, version_id: vid });
    expect(t2.prompt).not.toContain("[idea context]");
  });
});

describe("idea_signals + ROI", () => {
  it("add/list/get owner 校验; deleteIdeaSignal 幂等安全", () => {
    const idea = createIdea({ owner_id: ownerA, title: "t" });
    const sig = addIdeaSignal({ idea_id: idea.id, owner_id: ownerA, kind: "payment", value: 100, ref: "wxp-1" });
    expect(sig!.kind).toBe("payment");
    expect(getIdeaSignal(sig!.id, ownerB)).toBeNull();
    expect(listIdeaSignals(idea.id, ownerA)).toHaveLength(1);
  });

  it("getIdeaROI: 成本汇总 + 按 kind 计数/求和 + overdue 标记", () => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const idea = createIdea({ owner_id: ownerA, title: "t", deadline: past });
    seedTask(ownerA, { idea_id: idea.id, cost_usd: 0.5 });
    seedTask(ownerA, { idea_id: idea.id, cost_usd: 1.25 });
    addIdeaSignal({ idea_id: idea.id, owner_id: ownerA, kind: "inquiry" });
    addIdeaSignal({ idea_id: idea.id, owner_id: ownerA, kind: "payment", value: 30000 });
    const roi = getIdeaROI(idea.id, ownerA)!;
    expect(roi.cost_usd).toBeCloseTo(1.75);
    expect(roi.task_count).toBe(2);
    expect(roi.inquiry_count).toBe(1);
    expect(roi.payment_total).toBe(30000);
    expect(roi.overdue).toBe(true); // 过窗未出结论
    // 出结论后不再 overdue
    concludeIdea(idea.id, ownerA, "证伪", "rejected");
    expect(getIdeaROI(idea.id, ownerA)!.overdue).toBe(false);
  });
});
