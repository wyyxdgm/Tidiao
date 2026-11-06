// Tests for requirement_revisions 模块 (R63 字段级变更时间线).
//
// 覆盖范围:
//   - recordRevision: 写入成功 + actor 字段透传 + null old/new
//   - listRevisions: 时间倒序 + limit 截断
//   - getLatestRevisions: N 个 id 一次取最近 + 空数组返回空 Map
//   - 集成: updateRequirement 落 diff (字段级) + softDelete 落 status='closed' diff

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  createRequirement,
  getRequirementById,
  updateRequirement,
  softDeleteRequirement,
} from "./requirements";
import {
  recordRevision,
  listRevisions,
  getLatestRevisions,
  revisionStringify,
  listRevisionsByTimeRange,
  encodeRevisionCursor,
  decodeRevisionCursor,
} from "./requirement-revisions";

let tmpDir: string;
let ownerA: string;
let projectA: string;

function seedUser(email: string): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(id, email, "x");
  return id;
}
function seedProject(ownerId: string, name: string): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
    .run(id, name);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-req-rev-"));
  // 必须显式设 ORCHESTRATOR_DB_PATH: getDb() 的 ORCHESTRATOR_DB_PATH 是 runtime 读,
  // 而 DB_DIR (= ORCHESTRATOR_HOME) 是 module-load 捕获, 改 env 来不及.
  // 漏这一行 = 测试写到生产 ~/.agent-orchestrator/orchestrator.db (2026-09-03
  // 污染 2037 个 P 项目 + 2037 个 a-@x 用户的根因).
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  ownerA = seedUser(`a-${uuidv4()}@x`);
  projectA = seedProject(ownerA, "P");
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_HOME;
});

describe("recordRevision + listRevisions", () => {
  it("writes a row and returns it via listRevisions", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    // createRequirement 内部已落 1 条 title; 此处再追加 status 变更.
    recordRevision(r.id, "status", "pending", "done", { type: "agent", id: "gpt-x", task_id: "tk-1" });

    const revs = listRevisions(r.id);
    expect(revs.length).toBe(2);
    expect(revs[0].field).toBe("status"); // 最新在上 (status 后写)
    expect(revs[0].actor_type).toBe("agent");
    expect(revs[0].actor_id).toBe("gpt-x");
    expect(revs[0].task_id).toBe("tk-1");
    expect(revs[0].old_value).toBe("pending");
    expect(revs[0].new_value).toBe("done");
    expect(revs[1].field).toBe("title");
    expect(revs[1].actor_type).toBe("user");
  });

  it("respects limit", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    for (let i = 0; i < 5; i++) {
      recordRevision(r.id, "title", `v${i}`, `v${i + 1}`, { type: "user", id: ownerA });
    }
    expect(listRevisions(r.id).length).toBe(6); // 1 from create + 5
    expect(listRevisions(r.id, 3).length).toBe(3);
  });

  it("returns empty for unknown id", () => {
    expect(listRevisions("nope").length).toBe(0);
  });
});

describe("getLatestRevisions", () => {
  it("returns latest per requirement_id in 1 query", () => {
    const r1 = createRequirement(projectA, { title: "A" }, ownerA);
    const r2 = createRequirement(projectA, { title: "B" }, ownerA);
    // r2 自身在 createRequirement 落了 title, 再 recordRevision 落 status = 后写 = 最新.
    recordRevision(r1.id, "title", "A", "A2", { type: "user", id: ownerA });
    recordRevision(r2.id, "status", "pending", "done", { type: "agent", id: "bot" });

    const map = getLatestRevisions([r1.id, r2.id]);
    expect(map.size).toBe(2);
    expect(map.get(r1.id)?.field).toBe("title");
    expect(map.get(r1.id)?.new_value).toBe("A2");
    expect(map.get(r2.id)?.field).toBe("status");
    expect(map.get(r2.id)?.actor_type).toBe("agent");
  });

  it("returns empty Map for empty input", () => {
    expect(getLatestRevisions([]).size).toBe(0);
  });
});

describe("updateRequirement integration (R63 diff)", () => {
  it("records one row per changed field, skips no-op writes", () => {
    const r = createRequirement(projectA, { title: "T", description: "D", priority: 2 }, ownerA);
    const beforeCount = listRevisions(r.id).length; // create 落了 1 条 title

    updateRequirement(
      r.id,
      { title: "T2", description: "D2", priority: 2 /* no-op */, tags: ["x"] },
      ownerA,
      { type: "agent", id: "agent-1", task_id: "tk-1" }
    );

    const after = listRevisions(r.id);
    // 新增 3 条 (title, description, tags) -- priority 跳过.
    expect(after.length - beforeCount).toBe(3);
    const newRows = after.slice(0, 3); // 最新 3 条
    const fields = newRows.map((x) => x.field);
    expect(fields).toContain("title");
    expect(fields).toContain("description");
    expect(fields).toContain("tags");
    const titleRow = newRows.find((x) => x.field === "title");
    expect(titleRow?.actor_type).toBe("agent");
    expect(titleRow?.actor_id).toBe("agent-1");
    expect(titleRow?.task_id).toBe("tk-1");
    expect(titleRow?.old_value).toBe("T");
    expect(titleRow?.new_value).toBe("T2");
  });

  it("does not record when patch has no whitelisted fields", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const before = listRevisions(r.id).length;
    updateRequirement(r.id, { /* nothing valid */ } as any, ownerA);
    expect(listRevisions(r.id).length).toBe(before);
  });
});

describe("softDeleteRequirement integration (R63 diff)", () => {
  it("records status: pending -> closed", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    expect(softDeleteRequirement(r.id, ownerA, { type: "user", id: ownerA })).toBe(true);
    const revs = listRevisions(r.id);
    const closed = revs.find((x) => x.field === "status" && x.new_value === "closed");
    expect(closed).toBeDefined();
    expect(closed!.old_value).toBe("pending");
  });

  it("no-op on already-closed does not record", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    softDeleteRequirement(r.id, ownerA);
    const before = listRevisions(r.id).length;
    expect(softDeleteRequirement(r.id, ownerA)).toBe(false);
    expect(listRevisions(r.id).length).toBe(before);
  });
});

describe("revisionStringify", () => {
  it("handles status / tags / numbers / null", () => {
    expect(revisionStringify("status", "done")).toBe("done");
    expect(revisionStringify("tags", ["a", "b"])).toBe('["a","b"]');
    expect(revisionStringify("priority", 3)).toBe("3");
    expect(revisionStringify("title", "x")).toBe("x");
    expect(revisionStringify("title", null)).toBe(null);
    expect(revisionStringify("title", undefined)).toBe(null);
  });
});

describe("listRevisionsByTimeRange (R63 N 列: 全局增量端点)", () => {
  let ownerB: string;

  beforeEach(() => {
    ownerB = seedUser(`b-${uuidv4()}@x`);
  });

  it("跨 requirement 倒序列出, owner 隔离生效", () => {
    const r1 = createRequirement(projectA, { title: "A" }, ownerA);
    const r2 = createRequirement(projectA, { title: "B" }, ownerB);
    // ownerB 改 r2 (status) —— 应被 ownerA 查询过滤掉.
    recordRevision(r2.id, "status", "pending", "done", { type: "agent", id: "bot" });

    const result = listRevisionsByTimeRange({}, ownerA);
    // ownerA 只看到 r1 的 1 条 (create 落的 title), 看不到 r2 的 agent 改的.
    expect(result.items.every((x) => x.requirement_id === r1.id)).toBe(true);
    expect(result.items.length).toBe(1);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it("since 过滤生效 (半开区间 [since, until))", () => {
    createRequirement(projectA, { title: "T" }, ownerA);

    // since 在未来 = 应看不到任何东西.
    const future = "2099-01-01 00:00:00";
    const futureResult = listRevisionsByTimeRange({ since: future }, ownerA);
    expect(futureResult.items.length).toBe(0);

    // until = '1970' = 应看到全部.
    const all = listRevisionsByTimeRange({ until: "2099-01-01 00:00:00" }, ownerA);
    expect(all.items.length).toBe(1);
    expect(all.items[0].field).toBe("title");

    // since = '1970', until = '1970' = 半开 [1970, 1970) = 空 (端点互斥).
    const empty = listRevisionsByTimeRange(
      { since: "1970-01-01 00:00:00", until: "1970-01-01 00:00:00" },
      ownerA
    );
    expect(empty.items.length).toBe(0);
  });

  it("actor_type 过滤生效", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    // create 落 1 条 user.
    recordRevision(r.id, "status", "pending", "done", { type: "agent", id: "gpt" });

    const onlyAgent = listRevisionsByTimeRange({ actor_type: "agent" }, ownerA);
    expect(onlyAgent.items.length).toBe(1);
    expect(onlyAgent.items[0].field).toBe("status");
    expect(onlyAgent.items[0].actor_type).toBe("agent");

    const onlyUser = listRevisionsByTimeRange({ actor_type: "user" }, ownerA);
    expect(onlyUser.items.length).toBe(1);
    expect(onlyUser.items[0].field).toBe("title");
  });

  it("requirement_id 限定单条", () => {
    const r1 = createRequirement(projectA, { title: "A" }, ownerA);
    const r2 = createRequirement(projectA, { title: "B" }, ownerA);
    recordRevision(r2.id, "status", "pending", "blocked", { type: "user", id: ownerA });

    const out = listRevisionsByTimeRange({ requirement_id: r2.id }, ownerA);
    expect(out.items.every((x) => x.requirement_id === r2.id)).toBe(true);
    expect(out.items.some((x) => x.field === "status" && x.new_value === "blocked")).toBe(true);

    void r1;
  });

  it("cursor 翻页: 第一页 limit=1 → 第二页 = 第二条", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    recordRevision(r.id, "status", "pending", "done", { type: "user", id: ownerA });
    recordRevision(r.id, "description", null, "D", { type: "agent", id: "bot" });

    const page1 = listRevisionsByTimeRange({ limit: 1 }, ownerA);
    expect(page1.items.length).toBe(1);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = listRevisionsByTimeRange(
      { limit: 1, cursor: page1.next_cursor ?? undefined },
      ownerA
    );
    expect(page2.items.length).toBe(1);
    // 两次取到的 id 不重叠.
    expect(page2.items[0].id).not.toBe(page1.items[0].id);

    void r;
  });

  it("limit 上限 500", () => {
    // 实际只创建 3 条, 验证 limit clamp 不报错.
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    recordRevision(r.id, "title", "T", "T2", { type: "user", id: ownerA });
    recordRevision(r.id, "title", "T2", "T3", { type: "user", id: ownerA });

    const out = listRevisionsByTimeRange({ limit: 1000 }, ownerA); // 上限 500
    expect(out.items.length).toBe(3);
    expect(out.has_more).toBe(false);
    void r;
  });

  it("乱序 cursor 解码失败 → 静默忽略", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const out = listRevisionsByTimeRange({ cursor: "garbage!!!" }, ownerA);
    // 应等价无 cursor: 全收 (这里只有 1 条 create).
    expect(out.items.length).toBe(1);
    void r;
  });

  it("多 requirement 多 actor 混合 → 全集正确, owner 隔离通过", () => {
    const r1 = createRequirement(projectA, { title: "A" }, ownerA);
    const r2 = createRequirement(projectA, { title: "B" }, ownerA);
    recordRevision(r1.id, "status", "pending", "done", { type: "agent", id: "bot" });
    recordRevision(r2.id, "description", null, "x", { type: "system" });

    const out = listRevisionsByTimeRange({}, ownerA);
    // 共 4 条: r1.create (title,user) + r1.status (agent) + r2.create (title,user) +
    //          r2.description (system). 不依赖具体顺序 (uuid v4 不是时间序, 同秒
    //          多写的次序随机), 只断言存在.
    expect(out.items.length).toBe(4);
    const descRow = out.items.find((x) => x.field === "description" && x.actor_type === "system");
    expect(descRow).toBeDefined();
    expect(descRow?.requirement_id).toBe(r2.id);
    const statusRow = out.items.find(
      (x) => x.field === "status" && x.actor_type === "agent" && x.requirement_id === r1.id
    );
    expect(statusRow).toBeDefined();
    // 全是 ownerA 的, owner 隔离通过 (因为 r1/r2 都属 ownerA).
    expect(out.items.every((x) => [r1.id, r2.id].includes(x.requirement_id))).toBe(true);
  });
});

describe("encodeRevisionCursor / decodeRevisionCursor", () => {
  it("round-trips", () => {
    const original = { created_at: "2026-09-03 10:00:00", id: "abc-123" };
    const encoded = encodeRevisionCursor(original);
    const decoded = decodeRevisionCursor(encoded);
    expect(decoded).toEqual({ v: 1, ...original });
  });

  it("handles invalid input gracefully", () => {
    expect(decodeRevisionCursor("not-base64!!!")).toBeNull();
    expect(decodeRevisionCursor(encodeRevisionCursor({ created_at: "x", id: "y" }))).toEqual({
      v: 1,
      created_at: "x",
      id: "y",
    });
    // 编码含 + / / (本测试无, 验证 url-safe 替换即可)
  });

  it("url-safe: no padding, no + or /", () => {
    const encoded = encodeRevisionCursor({ created_at: "2026-09-03 10:00:00", id: "id" });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});