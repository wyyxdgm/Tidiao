// /api/ideas + /api/pin-lists 路由集成测试 (idea-canvas P0)
//
// 覆盖:
//   1. 鉴权: 401 (无 x-user-id)
//   2. POST /api/ideas 建构思 (带假设/判据/窗口) + 404 no existence leak
//   3. PATCH 白名单 + 非法 status 400
//   4. POST /api/tasks 带 idea_id/node_id: 归属校验 (别人的 idea → 404; node/idea 不一致 → 400)
//   5. pin-lists 闭环: 建列表 → 加 task 条目 → 重复加 409 → items 解引用
//   6. export md: 含标题/假设/mermaid/收益
//
// 模式与 assets/route.test.ts 同款: 直调 route handler + 真 SQLite 临时库.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";

import { GET as listIdeasRoute, POST as createIdeaRoute } from "./route";
import { PATCH as patchIdeaRoute, GET as getIdeaRoute } from "./[id]/route";
import { POST as createNodeRoute } from "./[id]/nodes/route";
import { GET as exportIdeaRoute } from "./[id]/export/route";
import { POST as createListRoute, GET as listListsRoute } from "../pin-lists/route";
import { POST as addItemRoute } from "../pin-lists/[id]/items/route";
import { POST as createTaskRoute } from "../tasks/route";
import { closeDb, getDb } from "@/lib/db";
import { createProject } from "@/lib/db/projects";

let tmpDir: string;
let userA: string;
let userB: string;
let projectId: string;
let projectIdB: string;

function req(method: string, url: string, body?: any, userId?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-user-id": userId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  userA = uuidv4();
  userB = uuidv4();
  const db = getDb();
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userA, `${userA}@example.test`, "x", "user");
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userB, `${userB}@example.test`, "x", "user");
  const proj = createProject({ ownerId: userA, name: "pA", });
  projectId = proj.id;
  projectIdB = createProject({ ownerId: userB, name: "pB", }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
});

// createTask 走完整 runtime 校验链（location/preflight），这里保持与 assets/route.test.ts 同款直调。

describe("/api/ideas", () => {
  it("401 无 x-user-id", async () => {
    const res = await listIdeasRoute(req("GET", "/api/ideas"));
    expect(res.status).toBe(401);
  });

  it("POST 建构思(带假设/判据/窗口) → GET 列表含计数 → PATCH 非法 status 400", async () => {
    const created = await createIdeaRoute(
      req("POST", "/api/ideas", {
        title: "AO 变现",
        hypothesis: "相信成本归因会让外包公司付费",
        success_criteria: "2 周内 ≥3 真实询问",
        deadline: "2026-12-06",
      }, userA)
    );
    expect(created.status).toBe(201);
    const idea = await created.json();
    expect(idea.status).toBe("germinating");
    expect(idea.hypothesis).toContain("成本归因");

    const list = await listIdeasRoute(req("GET", "/api/ideas", undefined, userA));
    const body = await list.json();
    expect(body.ideas).toHaveLength(1);
    expect(body.links).toEqual([]);

    // B 看不到 A 的
    const listB = await (listIdeasRoute(req("GET", "/api/ideas", undefined, userB)));
    expect((await listB.json()).ideas).toHaveLength(0);

    const bad = await patchIdeaRoute(req("PATCH", `/api/ideas/${idea.id}`, { status: "flying" }, userA), {
      params: Promise.resolve({ id: idea.id }),
    });
    expect(bad.status).toBe(400);

    // 不存在的 idea 404 (no existence leak: B 查 A 的也是 404)
    const nf = await getIdeaRoute(req("GET", `/api/ideas/${idea.id}`, undefined, userB), {
      params: Promise.resolve({ id: idea.id }),
    });
    expect(nf.status).toBe(404);
  });

  it("POST /api/tasks 挂 idea/node: 归属校验 + 不一致 400 + 正常写入", async () => {
    const ideaRes = await createIdeaRoute(req("POST", "/api/ideas", { title: "i1" }, userA));
    const idea = await ideaRes.json();
    const nodeRes = await createNodeRoute(req("POST", `/api/ideas/${idea.id}/nodes`, { title: "n1" }, userA), {
      params: Promise.resolve({ id: idea.id }),
    });
    expect(nodeRes.status).toBe(201);
    const node = await nodeRes.json();

    // 别人的 idea → 404
    const foreign = await createTaskRoute(
      req("POST", "/api/tasks", {
        title: "t", prompt: "p", project_id: projectId, idea_id: idea.id,
      }, userB)
    );
    expect(foreign.status).toBe(404);

    // node/idea 不一致 → 400
    const idea2 = await (await createIdeaRoute(req("POST", "/api/ideas", { title: "i2" }, userA))).json();
    const mismatch = await createTaskRoute(
      req("POST", "/api/tasks", {
        title: "t", prompt: "p", project_id: projectId, idea_id: idea2.id, node_id: node.id,
      }, userA)
    );
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).code).toBe("NODE_IDEA_MISMATCH");

    // 正常: task 带 idea_id + node_id + work_class
    const ok = await createTaskRoute(
      req("POST", "/api/tasks", {
        title: "验证任务", prompt: "p", project_id: projectId,
        idea_id: idea.id, node_id: node.id, work_class: "plan",
      }, userA)
    );
    expect(ok.status).toBe(201);
    const task = await ok.json();
    expect(task.idea_id).toBe(idea.id);
    expect(task.node_id).toBe(node.id);
    expect(task.work_class).toBe("plan");
  });
});

describe("/api/pin-lists 闭环", () => {
  it("建列表 → 加 task 条目 → 重复加 409 → GET 解引用", async () => {
    const listRes = await createListRoute(req("POST", "/api/pin-lists", { title: "下期做" }, userA));
    expect(listRes.status).toBe(201);
    const list = await listRes.json();

    const taskRes = await createTaskRoute(
      req("POST", "/api/tasks", { title: "一个任务", prompt: "p", project_id: projectId }, userA)
    );
    const task = await taskRes.json();

    const addRes = await addItemRoute(
      req("POST", `/api/pin-lists/${list.id}/items`, { ref_type: "task", ref_id: task.id, added_by: "damo" }, userA),
      { params: Promise.resolve({ id: list.id }) }
    );
    expect(addRes.status).toBe(201);

    const dup = await addItemRoute(
      req("POST", `/api/pin-lists/${list.id}/items`, { ref_type: "task", ref_id: task.id }, userA),
      { params: Promise.resolve({ id: list.id }) }
    );
    expect(dup.status).toBe(409);

    // 别人的 task → 404 REF_NOT_FOUND
    const foreignTask = await createTaskRoute(
      req("POST", "/api/tasks", { title: "b-task", prompt: "p", project_id: projectIdB }, userB)
    );
    const foreignTaskBody = await foreignTask.json();
    const foreignAdd = await addItemRoute(
      req("POST", `/api/pin-lists/${list.id}/items`, { ref_type: "task", ref_id: foreignTaskBody.id }, userA),
      { params: Promise.resolve({ id: list.id }) }
    );
    expect(foreignAdd.status).toBe(404);
    expect((await foreignAdd.json()).code).toBe("REF_NOT_FOUND");

    const listGet = await listListsRoute(req("GET", "/api/pin-lists", undefined, userA));
    const listBody = await listGet.json();
    expect(listBody.lists).toHaveLength(1);
    expect(listBody.lists[0].items).toHaveLength(1);
    expect(listBody.lists[0].items[0].title).toBe("一个任务");
  });
});

describe("/api/ideas/[id]/export", () => {
  it("导出 md 含标题/假设/mermaid/收益", async () => {
    const idea = await (
      await createIdeaRoute(req("POST", "/api/ideas", {
        title: "AO 变现",
        hypothesis: "相信成本归因会让外包公司付费",
        success_criteria: "2 周内 ≥3 真实询问",
        deadline: "2026-12-06",
      }, userA))
    ).json();
    await createNodeRoute(req("POST", `/api/ideas/${idea.id}/nodes`, { title: "节点1", deps: [] }, userA), {
      params: Promise.resolve({ id: idea.id }),
    });
    await createTaskRoute(
      req("POST", "/api/tasks", { title: "验证任务", prompt: "p", project_id: projectId, idea_id: idea.id }, userA)
    );

    const res = await exportIdeaRoute(req("GET", `/api/ideas/${idea.id}/export`, undefined, userA), {
      params: Promise.resolve({ id: idea.id }),
    });
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain("# 构思：AO 变现");
    expect(md).toContain("相信成本归因会让外包公司付费");
    expect(md).toContain("```mermaid");
    expect(md).toContain("收益面板");
    // B 导不出 A 的
    const resB = await exportIdeaRoute(req("GET", `/api/ideas/${idea.id}/export`, undefined, userB), {
      params: Promise.resolve({ id: idea.id }),
    });
    expect(resB.status).toBe(404);
  });
});
