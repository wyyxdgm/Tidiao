// /api/tasks/page 的 R165 条件拉取 (ETag / If-None-Match) 路由层测试.
//
// 关注点 (每条都是"错了会静默出错数据"的方向):
//   - 200 必须带 ETag; 客户端靠它做下次的 If-None-Match.
//   - 带 If-None-Match 且指纹未变 → 304 且 body 为空 (省 payload 是本特性的全部意义).
//   - 带 If-None-Match 但期间有写入 → 200 全量 (假 304 = 用户永远看不到新数据).
//   - 翻页 (offset 变) 必须让 ETag 变, 否则 304 会把上一页数据当本页返回.
//   - 参数校验 (statusGroup 必填 / project 归属) 不因 ETag 分支被绕过.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, updateTaskStatus, setQueuedReason } from "@/lib/db/tasks";
import { GET } from "./route";

let tmpDir: string;
let ownerId: string;
let projectId: string;

function makeReq(url: string, ifNoneMatch?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-user-id": ownerId,
  };
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  return new NextRequest(url, { method: "GET", headers });
}

const url = (q: Record<string, string>) =>
  `http://localhost:3000/api/tasks/page?${new URLSearchParams(q).toString()}`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-page-route-etag-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "etg-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/tasks/page: ETag", () => {
  it("returns an ETag on the first 200", async () => {
    createTask({ title: "t1", prompt: "p", project_id: projectId });
    const res = await GET(makeReq(url({ statusGroup: "all", project: projectId })));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\//);
  });

  it("emits an ETag with no whitespace in it (RFC 9110 entity-tag)", async () => {
    // 回归: 早期版本用空格分隔页窗口段, 浏览器/代理/curl 回传时被截断,
    // 条件拉取永远命中不了 (e2e 实测: 带 INM 也回 200). 空格必须没有.
    createTask({ title: "t1", prompt: "p", project_id: projectId });
    const res = await GET(
      makeReq(url({ statusGroup: "all", project: projectId, limit: "10", offset: "0" }))
    );
    const etag = res.headers.get("etag")!;
    expect(etag).not.toMatch(/\s/);
    // 窗口段还在, 只是换了分隔符.
    expect(etag).toMatch(/\|10-0$/);
  });

  it("returns 304 with an empty body when nothing changed", async () => {
    createTask({ title: "t1", prompt: "p", project_id: projectId });
    const first = await GET(makeReq(url({ statusGroup: "all", project: projectId })));
    const etag = first.headers.get("etag")!;

    const second = await GET(
      makeReq(url({ statusGroup: "all", project: projectId }), etag)
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("returns 200 again after a write lands", async () => {
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const first = await GET(makeReq(url({ statusGroup: "all", project: projectId })));
    const etag = first.headers.get("etag")!;

    updateTaskStatus(t.id, "running");
    const second = await GET(
      makeReq(url({ statusGroup: "all", project: projectId }), etag)
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as { items: { status: string }[] };
    expect(body.items[0].status).toBe("running");
  });

  it("changes the ETag when the page window changes (offset)", async () => {
    for (let i = 0; i < 3; i++) {
      createTask({ title: `t${i}`, prompt: "p", project_id: projectId });
    }
    const p1 = await GET(
      makeReq(url({ statusGroup: "all", project: projectId, limit: "2", offset: "0" }))
    );
    const p2 = await GET(
      makeReq(url({ statusGroup: "all", project: projectId, limit: "2", offset: "2" }))
    );
    expect(p1.headers.get("etag")).not.toBe(p2.headers.get("etag"));

    // 拿第一页的 ETag 去要第二页 → 必须 200, 不能 304 (否则返回上一页的行).
    const page2 = await GET(
      makeReq(url({ statusGroup: "all", project: projectId, limit: "2", offset: "2" }), p1.headers.get("etag")!)
    );
    expect(page2.status).toBe(200);
  });

  it("does not let a stale ETag bypass param validation", async () => {
    const first = await GET(makeReq(url({ statusGroup: "all", project: projectId })));
    const etag = first.headers.get("etag")!;
    const bad = await GET(makeReq(url({ project: projectId }), etag));
    expect(bad.status).toBe(400);
  });

  it("projects queued_reason into page items (v531)", async () => {
    const t = createTask({ title: "t1", prompt: "p", project_id: projectId });
    // 模拟调度器标因: 先翻 queued 再写原因 (不变量: 原因只挂在 queued 行);
    // pageSql 白名单投影必须带回 (openbot waiting-visibility plan §8 集成断言),
    // 否则 SPA 排队卡片拿不到原因.
    updateTaskStatus(t.id, "queued");
    setQueuedReason(t.id, "全局并发已满 (1/1), 等待运行中的任务释放槽位");

    const res = await GET(makeReq(url({ statusGroup: "all", project: projectId })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; status: string; queued_reason: string | null }[];
    };
    const row = body.items.find((i) => i.id === t.id);
    expect(row).toBeDefined();
    expect(row!.queued_reason).toContain("全局并发已满");

    // 离开 queued 后原因清空, 投影回 NULL (不变量 UI 守卫的数据侧前提).
    updateTaskStatus(t.id, "running");
    const res2 = await GET(makeReq(url({ statusGroup: "all", project: projectId })));
    const body2 = (await res2.json()) as {
      items: { id: string; queued_reason: string | null }[];
    };
    expect(body2.items.find((i) => i.id === t.id)!.queued_reason).toBeNull();
  });
});
