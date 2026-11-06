// GET /api/tasks/[id] 关系对象补齐的回归测试 (damo 飞书 AO-DEV-spa R62).
//
// 背景: 详情页 SSR (src/app/tasks/[id]/page.tsx) 在 server 侧 hydrate 好
// dependsOnTasks / dispatcherTask / parentTask / dispatchedTasks 当 props 传下去;
// SPA 是纯客户端 fetch, 而 GET 以前只回 *_ids → SPA 的 RightDock 依赖图恒为空
// (派发 / 继承 / 依赖 三种关系一条都渲染不出来)。
//
// 关注点:
//   - *_ids 字段保留 (下游脚本在用), 本次只「加 hydrate 对象」不改既有语义。
//   - 非 owner 的关联 task 必须被 getTaskById(userId) 过滤掉 (多租户不变量),
//     不能因为补齐对象就把别的 owner 的 task 泄出去 —— ids 仍按 DB 原样回。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { createRequirement } from "@/lib/db/requirements";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let otherOwnerId: string;
let projectId: string;
let upstreamId: string;
let downstreamId: string;

function makeUser(uid: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(uid, `${uid}@example.com`, "x", "user");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-rel-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  otherOwnerId = uuidv4();
  makeUser(ownerId);
  makeUser(otherOwnerId);
  projectId = createProject({ name: "rel-proj", ownerId }).id;
  upstreamId = createTask({ title: "前置任务", prompt: "u", project_id: projectId }).id;
  downstreamId = createTask({
    title: "后续任务",
    prompt: "d",
    project_id: projectId,
    dependsOn: [upstreamId],
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function getReq(id: string, uid = ownerId) {
  return new NextRequest(`http://localhost/api/tasks/${id}`, {
    headers: { "x-user-id": uid },
  });
}

async function loadRoute() {
  return (await import("./route")).GET;
}

async function getJson(id: string, uid = ownerId): Promise<Record<string, any>> {
  const GET = await loadRoute();
  const res = await GET(getReq(id, uid), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

const ids = (rows: { id: string }[] | undefined) => (rows ?? []).map((r) => r.id);
const titles = (rows: { title: string }[] | undefined) => (rows ?? []).map((r) => r.title);

describe("GET /api/tasks/[id]: 关系对象补齐 (SPA 依赖图)", () => {
  it("依赖 / 被依赖: 同时回 ids 和 hydrated 对象", async () => {
    const body = await getJson(downstreamId);
    expect(body.depends_on_ids).toEqual([upstreamId]);
    expect(ids(body.depends_on_tasks)).toEqual([upstreamId]);
    expect(titles(body.depends_on_tasks)).toEqual(["前置任务"]);

    const upstreamBody = await getJson(upstreamId);
    expect(upstreamBody.dependent_task_ids).toEqual([downstreamId]);
    expect(ids(upstreamBody.dependent_tasks)).toEqual([downstreamId]);
  });

  it("派发链: dispatched_tasks 回对象, dispatcher_task 回上游对象", async () => {
    const parent = createTask({ title: "派发方", prompt: "p", project_id: projectId }).id;
    createTask({
      title: "被派发方",
      prompt: "c",
      project_id: projectId,
      dispatched_by_task_id: parent,
    });

    const body = await getJson(parent);
    expect(body.dispatched_task_ids).toHaveLength(1);
    expect(titles(body.dispatched_tasks)).toEqual(["被派发方"]);

    const childBody = await getJson(body.dispatched_task_ids[0]);
    expect(childBody.dispatcher_task.id).toBe(parent);
    expect(childBody.dispatcher_task.title).toBe("派发方");
  });

  it("无任何关系时字段存在且为空 (SPA 不用 undefined 兜底)", async () => {
    const solo = createTask({ title: "孤立", prompt: "s", project_id: projectId }).id;
    const body = await getJson(solo);
    expect(body.depends_on_tasks).toEqual([]);
    expect(body.dependent_tasks).toEqual([]);
    expect(body.dispatched_tasks).toEqual([]);
    expect(body.requirement_siblings).toEqual([]);
    expect(body.requirement_link).toBeNull();
    expect(body.parent_task).toBeNull();
    expect(body.dispatcher_task).toBeNull();
  });

  it("非 owner 的关联 task 不进 hydrated 对象 (多租户不变量)", async () => {
    const foreignProject = createProject({ name: "foreign", ownerId: otherOwnerId }).id;
    const foreign = createTask({ title: "别人家的", prompt: "f", project_id: foreignProject }).id;
    const target = createTask({
      title: "目标",
      prompt: "p",
      project_id: projectId,
      dependsOn: [foreign],
    }).id;

    const body = await getJson(target);
    // ids 仍按 DB 原样回 (调用方拿 id 自行判), 对象层被 userId 收窄。
    expect(body.depends_on_ids).toEqual([foreign]);
    expect(body.depends_on_tasks).toEqual([]);
  });

  it("需求点关联: requirement_link + 同需求其他 task (去重本 task)", async () => {
    const req = createRequirement(projectId, { title: "需求点" }, ownerId);
    const t1 = createTask({
      title: "挂需求的 task",
      prompt: "p",
      project_id: projectId,
      requirement_id: req.id,
    }).id;
    createTask({
      title: "同需求兄弟",
      prompt: "s",
      project_id: projectId,
      requirement_id: req.id,
    });

    const body = await getJson(t1);
    expect(body.requirement_link.id).toBe(req.id);
    expect(body.requirement_link.title).toBe("需求点");
    expect(titles(body.requirement_siblings)).toEqual(["同需求兄弟"]);
  });
});
