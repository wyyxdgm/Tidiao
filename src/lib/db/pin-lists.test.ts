// Tests for pin_lists/pin_list_items/dashboard_blocks (v522/v523, idea-canvas P0/P3).
//
// 覆盖验收 (docs/plans/idea-canvas.md §3 D4 + §8):
//   1) 列表 owner 隔离 + 白名单更新 + 删列表清条目不动 ref 本体
//   2) 多态条目: UNIQUE 防重 (同 ref 二次添加抛错) / ref 归属校验 (别人 task → REF_NOT_FOUND)
//   3) listItemsWithRefs 批量解引用: task/idea/node 三类 join + missing 标记 (ref 已删)
//   4) reorderPinListItems 整组替换
//   5) dashboard_blocks: save 整组替换原子性 + 非法 block_type 拒收

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import {
  createPinList,
  getPinList,
  listPinLists,
  updatePinList,
  deletePinList,
  addPinListItem,
  removePinListItem,
  reorderPinListItems,
  listItemsWithRefs,
  listDashboardBlocks,
  saveDashboardBlocks,
} from "./pin-lists";
import { createIdea, createIdeaNode } from "./ideas";

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

function seedTask(ownerId: string, title = "seed-task"): string {
  const id = uuidv4();
  getDb()
    .prepare(`INSERT INTO tasks (id, title, status, owner_id, prompt) VALUES (?, ?, 'pending', ?, '')`)
    .run(id, title, ownerId);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-pinlists-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  ownerA = seedUser(`a-${uuidv4()}@example.com`);
  ownerB = seedUser(`b-${uuidv4()}@example.com`);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("pin_lists CRUD", () => {
  it("owner 隔离 + 白名单更新 + 删列表清条目不动 ref 本体", () => {
    const list = createPinList({ owner_id: ownerA, title: "下期做" });
    expect(getPinList(list.id, ownerB)).toBeNull();
    const taskId = seedTask(ownerA, "一个任务");
    const item = addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: taskId });
    expect(item!.added_by).toBe("damo");
    const u = updatePinList(list.id, ownerA, { title: "下期做 v2", hack: 1 });
    expect(u!.title).toBe("下期做 v2");
    expect(deletePinList(list.id, ownerA)).toBe(true);
    // ref 本体还活着
    const row = getDb().prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    expect(row).toBeTruthy();
    expect(listPinLists(ownerA)).toHaveLength(0);
  });
});

describe("多态条目", () => {
  it("同 ref 重复添加抛 UNIQUE 错 (防重)", () => {
    const list = createPinList({ owner_id: ownerA, title: "L" });
    const taskId = seedTask(ownerA);
    addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: taskId });
    expect(() =>
      addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: taskId })
    ).toThrowError();
  });

  it("别人的 task / 不存在的 node → REF_NOT_FOUND (归属校验)", () => {
    const list = createPinList({ owner_id: ownerA, title: "L" });
    const otherTask = seedTask(ownerB);
    expect(() =>
      addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: otherTask })
    ).toThrowError(/REF_NOT_FOUND|not found or not owned/);
    expect(() =>
      addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "node", ref_id: "nope" })
    ).toThrowError(/REF_NOT_FOUND|not found or not owned/);
  });

  it("listItemsWithRefs 三类批量解引用 + missing 标记", () => {    const list = createPinList({ owner_id: ownerA, title: "L" });
    const taskId = seedTask(ownerA, "一个修复");
    const idea = createIdea({ owner_id: ownerA, title: "一个构思" });
    const node = createIdeaNode({ idea_id: idea.id, owner_id: ownerA, title: "一个节点" });
    addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: taskId });
    addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "idea", ref_id: idea.id });
    addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "node", ref_id: node.id });
    // 删 task 制造 missing
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    const items = listItemsWithRefs(list.id, ownerA);
    expect(items).toHaveLength(3);
    const t = items.find((i) => i.ref_type === "task")!;
    expect(t.missing).toBe(true);
    expect(t.title).toBe("(已删除)");
    expect(items.find((i) => i.ref_type === "idea")!.title).toBe("一个构思");
    expect(items.find((i) => i.ref_type === "node")!.title).toBe("一个节点");
    // 删 idea 级联清 node 条目? 不会 —— node 删除时才清 pin 条目; 这里 idea 删除会留 missing node 条目
    removePinListItem(items.find((i) => i.ref_type === "idea")!.id, ownerA);
    expect(listItemsWithRefs(list.id, ownerA)).toHaveLength(2);
  });

  it("v530 plan 条目: 存在的仓内路径可加, 穿越路径拒绝, 渲染 title 用 note", () => {
    const list = createPinList({ owner_id: ownerA, title: "L" });
    // 仓内真实存在的文档 (相对 process.cwd() = 仓根)
    const item = addPinListItem({
      list_id: list.id, owner_id: ownerA, ref_type: "plan",
      ref_id: "package.json", note: "计划条目测试",
    });
    expect(item).toBeTruthy();
    // .. 穿越拒绝
    expect(() =>
      addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "plan", ref_id: "../etc/passwd" })
    ).toThrowError(/REF_NOT_FOUND|not found or not owned/);
    // 绝对路径拒绝
    expect(() =>
      addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "plan", ref_id: "/etc/passwd" })
    ).toThrowError(/REF_NOT_FOUND|not found or not owned/);
    // 不存在的路径拒绝
    expect(() =>
      addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "plan", ref_id: "docs/plans/__no_such__.md" })
    ).toThrowError(/REF_NOT_FOUND|not found or not owned/);
    const items = listItemsWithRefs(list.id, ownerA);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("计划条目测试");
    expect(items[0]!.missing).toBe(false);
  });

  it("reorderPinListItems 整组替换", () => {
    const list = createPinList({ owner_id: ownerA, title: "L" });
    const t1 = seedTask(ownerA, "t1");
    const t2 = seedTask(ownerA, "t2");
    const i1 = addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: t1 })!;
    const i2 = addPinListItem({ list_id: list.id, owner_id: ownerA, ref_type: "task", ref_id: t2 })!;
    reorderPinListItems(list.id, ownerA, [i2.id, i1.id]);
    const items = listItemsWithRefs(list.id, ownerA);
    expect(items[0].id).toBe(i2.id);
    expect(items[1].id).toBe(i1.id);
  });
});

describe("dashboard_blocks", () => {
  it("save 整组替换 + owner 隔离 + 非法 block_type 拒收", () => {
    saveDashboardBlocks(ownerA, [
      { block_type: "list", ref_id: "l1", x: 0, y: 0, w: 4, h: 3 },
      { block_type: "idea_canvas", x: 4, y: 0, w: 8, h: 6 },
    ]);
    expect(listDashboardBlocks(ownerA)).toHaveLength(2);
    saveDashboardBlocks(ownerA, [{ block_type: "stats", x: 0, y: 0, w: 12, h: 1 }]);
    const blocks = listDashboardBlocks(ownerA);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe("stats");
    expect(listDashboardBlocks(ownerB)).toHaveLength(0);
    expect(() => saveDashboardBlocks(ownerA, [{ block_type: "hack" }])).toThrowError(/BLOCK_TYPE_INVALID|invalid block_type/);
  });
});
