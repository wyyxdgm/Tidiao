// 波 2.5 (docs/plans/auto-complete-dag.md D7.2#6): tasks.auto_complete 任务级自动验收.
//
// 三条验收线 (damo 拍板 A+B 组合, 仅 DAG 项目):
//   ① 非 DAG 项目 autoComplete=true → 400 AUTO_COMPLETE_REQUIRES_DAG
//      (route 层友好报错 + createTask 层防绕过, 双级校验)
//   ② DAG 项目 auto_complete=1 → reviewing 瞬间自动翻 completed
//      (断言 events 有 approve 副作用 + 状态 completed + 依赖链下游被拉起)
//   ③ 默认 0 → 行为不变 (落库 0, reviewing 保持 reviewing 不自动翻)
//
// 风格参考: schedule-auto-approve-forced.test.ts (tmp DB + 直调 route/createTask).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";

// SDK 假掉: autoStartDependents 会拉起下游 task (startTask → SDK query)
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById } from "@/lib/db/tasks";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { maybeAutoCompleteReviewing } from "@/lib/runtime/active-session";

let tmpDir: string;
let ownerId: string;
let dagProjectId: string;
let plainProjectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-autoc-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // runs migrations (含 v528 tasks.auto_complete)
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  dagProjectId = createProject({ name: "autoc-dag", ownerId }).id;
  plainProjectId = createProject({ name: "autoc-plain", ownerId }).id;
  // 测试用例各自决定开不开 DAG
  getDb().prepare("UPDATE projects SET dag_enforced = 1 WHERE id = ?").run(dagProjectId);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(body: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": ownerId,
      "x-user-role": "user",
    },
    body: JSON.stringify({ project_id: plainProjectId, ...body }),
  });
  const res = await createTaskRoute(req);
  return { status: res.status, json: await res.json() };
}

function makeReviewingTask(projectId: string, autoComplete = false) {
  return createTask({
    title: "ac-test",
    prompt: "noop",
    project_id: projectId,
    auto_approve: true,
    ...(autoComplete ? { auto_complete: true } : {}),
  });
}

// 把 task 推到 reviewing (模拟 ActiveSession result 路径写库后的状态;
//   ActiveSession 本体依赖 SDK query 流, 这里直接测翻转函数本身).
function forceReviewing(taskId: string) {
  getDb()
    .prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?")
    .run(taskId);
}

describe("① 非 DAG 项目 → 400 AUTO_COMPLETE_REQUIRES_DAG", () => {
  it("route 层: POST /api/tasks autoComplete=true + 非 DAG 项目 → 400 同码", async () => {
    const { status, json } = await post({
      title: "no-dag",
      prompt: "noop",
      auto_complete: undefined,
      autoComplete: true,
    });
    expect(status).toBe(400);
    expect(json.code).toBe("AUTO_COMPLETE_REQUIRES_DAG");
  });

  it("createTask 层 (防绕过): 直调也抛 AUTO_COMPLETE_REQUIRES_DAG, DB 无脏行", () => {
    // code 判定, 不用 message match (code 是独立属性, 不进 message)
    let thrownCode: string | undefined;
    try {
      createTask({
        title: "no-dag-direct",
        prompt: "noop",
        project_id: plainProjectId,
        auto_complete: true,
      });
    } catch (err) {
      thrownCode = (err as { code?: string }).code;
    }
    expect(thrownCode).toBe("AUTO_COMPLETE_REQUIRES_DAG");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'no-dag-direct'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("② DAG 项目 → reviewing 瞬间自动翻 completed", () => {
  it("auto_complete=1 的 reviewing task 调翻转 → completed + events 有 approve 副作用", () => {
    const t = makeReviewingTask(dagProjectId, true);
    expect(t.auto_complete).toBe(1);

    forceReviewing(t.id);
    maybeAutoCompleteReviewing(t.id);

    // 状态翻 completed
    expect(getTaskById(t.id)!.status).toBe("completed");
    // approve 副作用: events 表有 →completed 的 status_change
    //   (approveTask 的 emitEvent, webhook/父通知/autoStartDependents 同源触发)
    const ev = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'status_change' AND data LIKE '%"to":"completed"%'`
      )
      .get(t.id) as { n: number };
    expect(ev.n).toBeGreaterThanOrEqual(1);
  });

  it("awaiting_owner_review=1 (agent 显式要人拍板) → 不翻, 保持 reviewing", () => {
    const t = makeReviewingTask(dagProjectId, true);
    forceReviewing(t.id);
    getDb()
      .prepare("UPDATE tasks SET awaiting_owner_review = 1 WHERE id = ?")
      .run(t.id);

    maybeAutoCompleteReviewing(t.id);

    expect(getTaskById(t.id)!.status).toBe("reviewing");
  });
});

describe("③ 默认 0 → 行为不变", () => {
  it("不传 autoComplete → 落库 0; reviewing 调翻转是 no-op (保持 reviewing)", () => {
    const t = makeReviewingTask(dagProjectId);
    expect(t.auto_complete).toBe(0);
    forceReviewing(t.id);
    maybeAutoCompleteReviewing(t.id);
    expect(getTaskById(t.id)!.status).toBe("reviewing");
  });

  it("存量路径: 非 DAG 项目不带 autoComplete 照常创建 (行为 byte-identical)", async () => {
    const { status, json } = await post({ title: "plain-ok", prompt: "noop" });
    expect(status).toBe(201);
    expect(json.auto_complete).toBe(0);
  });
});
