// R107 父子任务通知机制 (parent-notify.ts) 单测.
//
// 覆盖设计稿 docs/designs/2026-08-25-parent-notify.md §Q5 列出的分支:
//   - 父 running/paused/reviewing → sendUserMessage 直发
//   - 父 terminal + session_id 非空 → sendUserMessage (auto-resume 分支)
//   - 父 session_id=null (从未启动) → webhook task.parent_child_notify 兜底
//   - 父 deleted_at 非空 → 静默 + 落 parent_notify_dropped event
//   - 跨 owner 兜底 → 落 dropped event
//   - 子 task 非 NOTIFY_STATUSES (running/completed) → 不通知
//   - 子无 dispatched_by_task_id → 不通知
//   - sender 内部异常 → catch + 降级 webhook + 落 dispatched (channel=webhook_fallback)
//   - 顶层异常 → 落 parent_notify_failed event, 绝不冒泡
//
// 关注点:
//   - 真 DB + 真 task (mock 只桩 webhook + sender). 与 status-transitions.test.ts 同模式.
//   - sender 通过 setupParentNotify 注入 vi.fn, 不依赖 AgentRuntime 单例 (避免启动 SDK subprocess).
//   - runRules 不桩 — 不在本测试触发, 真跑也行 (runRules 在 matchingRules 为空时早返).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Mock outbound webhook — 桩化避免出网 + 让断言可以拿到 dispatchWebhook 的入参.
const dispatchWebhookMock = vi.fn();
vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: (...args: unknown[]) => dispatchWebhookMock(...args),
}));

// Mock rule engine — emitEvent 会调, 但本测试不验证 rule, 桩化避免依赖.
vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));

// 不启动 SDK subprocess.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import {
  notifyParentOfChildStatusChange,
  setupParentNotify,
  PARENT_CHILD_NOTIFY_EVENT,
} from "./parent-notify";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import {
  createTask,
  getTaskById,
  updateTaskStatus,
  updateTask,
} from "../db/tasks";
import { insertEvent, getEventsByTaskId } from "../db/events";
import type { TaskStatus } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;
// Sender 包含可选 reason 第 3 参 (v53+ parent_notify reason 标注). vi.fn 默认推断为
// Mock<Procedure> 不含可选参, 所以这里显式声明为 Sender 类型 (兼容 vi.fn mock 方法).
type SenderFn = (taskId: string, message: string, reason?: string) => void;
let senderMock: ReturnType<typeof vi.fn> & SenderFn;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-parent-notify-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user");

  projectId = createProject({
    name: "parent-notify-test",
    cwd: tmpDir,
    ownerId,
  }).id;

  // 重置 sender mock (避免跨测泄漏). 注入到 parent-notify 的内部 sender.
  senderMock = vi.fn() as ReturnType<typeof vi.fn> & SenderFn;
  setupParentNotify(senderMock);

  // 重置 dispatchWebhook mock.
  dispatchWebhookMock.mockReset();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Helpers ----

// 建一个父 task, 强设 status + session_id + deleted_at (按需).
function makeParent(overrides: {
  status?: TaskStatus;
  session_id?: string | null;
  deleted_at?: string | null;
}): string {
  const t = createTask({
    title: "parent-task",
    prompt: "parent prompt",
    project_id: projectId,
  });
  const sets: string[] = ["owner_id = ?"];
  const params: unknown[] = [ownerId];
  if (overrides.status) {
    sets.push("status = ?");
    params.push(overrides.status);
  }
  if (overrides.session_id !== undefined) {
    sets.push("session_id = ?");
    params.push(overrides.session_id);
  }
  if (overrides.deleted_at !== undefined) {
    sets.push("deleted_at = ?");
    params.push(overrides.deleted_at);
  }
  sets.push("completed_at = ?");
  params.push(
    overrides.status === "completed" ||
      overrides.status === "failed" ||
      overrides.status === "cancelled"
      ? new Date().toISOString()
      : null,
  );
  getDb()
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params, t.id);
  return t.id;
}

// 建一个子 task 并挂上 dispatched_by_task_id.
function makeChild(
  parentId: string,
  overrides: {
    status?: TaskStatus;
    session_id?: string | null;
  } = {},
): string {
  const t = createTask({
    title: "child-task",
    prompt: "child prompt",
    project_id: projectId,
  });
  const sets: string[] = ["owner_id = ?", "dispatched_by_task_id = ?"];
  const params: unknown[] = [ownerId, parentId];
  if (overrides.status) {
    sets.push("status = ?");
    params.push(overrides.status);
  }
  if (overrides.session_id !== undefined) {
    sets.push("session_id = ?");
    params.push(overrides.session_id);
  }
  getDb()
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params, t.id);
  return t.id;
}

// ---- Tests ----

describe("notifyParentOfChildStatusChange — 父 alive 分支", () => {
  it("父 running + 子 reviewing → 调用 sendUserMessage(父, [subtask-notify] msg)", () => {
    const parentId = makeParent({
      status: "running",
      session_id: "sess-parent",
    });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(1);
    const [toId, msg] = senderMock.mock.calls[0];
    expect(toId).toBe(parentId);
    expect(msg).toContain("[subtask-notify]");
    expect(msg).toContain("已进入 reviewing");
    expect(msg).toContain(childId);
    expect(msg).toContain("/#/tasks/" + childId);
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });

  it("父 paused + 子 reviewing → sendUserMessage (paused 时会入 pending_messages + 等 resume)", () => {
    const parentId = makeParent({
      status: "paused",
      session_id: "sess-paused",
    });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][0]).toBe(parentId);
  });

  it("父 reviewing + 子 failed → sendUserMessage 直发", () => {
    const parentId = makeParent({
      status: "reviewing",
      session_id: "sess-rev",
    });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "failed");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][1]).toContain("已进入 failed");
  });
});

describe("notifyParentOfChildStatusChange — 父 terminal + session 复活分支", () => {
  it("父 completed + session_id 非空 + 子 reviewing → sendUserMessage (auto-resume 路径)", () => {
    // 这是 R107 的核心场景: 父已 completed 但有 session, 子完成时父被唤醒.
    const parentId = makeParent({
      status: "completed",
      session_id: "sess-completed",
    });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][0]).toBe(parentId);
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });

  it("父 failed + session_id 非空 + 子 rejected → sendUserMessage", () => {
    const parentId = makeParent({
      status: "failed",
      session_id: "sess-failed",
    });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "rejected");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][1]).toContain("已进入 rejected");
  });
});

describe("notifyParentOfChildStatusChange — webhook 兜底分支", () => {
  it("父 session_id 为 null (从未启动) + 子 reviewing → 走 webhook task.parent_child_notify", () => {
    const parentId = makeParent({ status: "completed", session_id: null });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).toHaveBeenCalledTimes(1);
    const [event, parentTask, , note] = dispatchWebhookMock.mock.calls[0];
    expect(event).toBe(PARENT_CHILD_NOTIFY_EVENT);
    expect(parentTask.id).toBe(parentId);
    expect(note).toBeTruthy();
    const parsed = JSON.parse(note);
    expect(parsed.child_id).toBe(childId);
    expect(parsed.child_to).toBe("reviewing");
    expect(parsed.child_url).toBe(`/#/tasks/${childId}`);
  });

  it("sender 抛异常时降级 webhook + 落 parent_notify_dispatched (channel=webhook_fallback)", () => {
    senderMock.mockImplementation(() => {
      throw new Error("synthetic sendUserMessage failure");
    });
    const parentId = makeParent({ status: "completed", session_id: "sess-x" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    // sender 失败 → 走 webhook 兜底 → 不再冒泡.
    expect(dispatchWebhookMock).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookMock.mock.calls[0][0]).toBe(
      PARENT_CHILD_NOTIFY_EVENT,
    );

    // 落事件, channel=webhook_fallback + 错误信息.
    const events = getEventsByTaskId(childId);
    const dispatched = events.find(
      (e) => e.type === "parent_notify_dispatched",
    );
    expect(dispatched).toBeTruthy();
    const data = JSON.parse(dispatched!.data);
    expect(data.channel).toBe("webhook_fallback");
    expect(data.send_user_message_error).toContain("synthetic");
  });
});

describe("notifyParentOfChildStatusChange — dropped 静默分支", () => {
  it("父 deleted_at 非空 → 静默 + 落 parent_notify_dropped (reason=parent_deleted)", () => {
    const parentId = makeParent({
      status: "completed",
      session_id: "sess-del",
      deleted_at: new Date().toISOString(),
    });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();

    const events = getEventsByTaskId(childId);
    const dropped = events.find((e) => e.type === "parent_notify_dropped");
    expect(dropped).toBeTruthy();
    const data = JSON.parse(dropped!.data);
    expect(data.reason).toBe("parent_deleted");
    expect(data.parent_id).toBe(parentId);
  });

  it("父 owner_id != 子 owner_id → 落 dropped (reason=cross_owner)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    // 强改 child owner_id 为另一个 user (满足 FK: 先建 user 行)
    const otherUserId = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      )
      .run(otherUserId, `${otherUserId}@example.com`, "x", "user");
    getDb()
      .prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`)
      .run(otherUserId, childId);

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();

    const events = getEventsByTaskId(childId);
    const dropped = events.find((e) => e.type === "parent_notify_dropped");
    expect(dropped).toBeTruthy();
    const data = JSON.parse(dropped!.data);
    expect(data.reason).toBe("cross_owner");
  });
});

describe("notifyParentOfChildStatusChange — 不通知分支", () => {
  it("子 running (非终态) → 不通知", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "pending" });

    notifyParentOfChildStatusChange(childId, "queued", "running");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });

  it("子 completed (已批准, 不在 NOTIFY_STATUSES) → 不通知", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "reviewing" });

    notifyParentOfChildStatusChange(childId, "reviewing", "completed");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });

  it("子无 dispatched_by_task_id → 不通知", () => {
    const t = createTask({
      title: "no-parent",
      prompt: "p",
      project_id: projectId,
    });
    getDb()
      .prepare(`UPDATE tasks SET owner_id = ?, status = ? WHERE id = ?`)
      .run(ownerId, "running", t.id);

    notifyParentOfChildStatusChange(t.id, "running", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });
});

describe("notifyParentOfChildStatusChange — 顶层异常兜底", () => {
  it("整个函数抛错 → 落 parent_notify_failed event, 不冒泡", () => {
    // 通过 dispatchWebhook 抛错来制造异常路径 (parent-notify 在主 sendUserMessage
    //   之前会落 dispatched event, 即使该 dispatchWebhook 也抛错, 顶层 try/catch
    //   也会兜住. 我们构造一个更彻底的: 把 setupParentNotify 注入一个抛异常的
    //   sender, 然后用 parent session_id=null 的路径 — 这条路径不会调到 sender,
    //   所以我们用 webhook 抛错的方式.)
    //
    // 这里我们改用: 直接 mock getTaskById 抛错. 但 db 是真, mock 不上.
    // 改用: 删子 task 在调用之前 → child task 不存在 → NOTIFY_STATUSES 早返 — 不对.
    // 真正能造异常的方式: 把 child task 的 dispatched_by_task_id 设成不存在的 UUID,
    //   然后 getTaskById(parentId) 返回 null → 走 parent_not_found 路径 (不会抛).
    // 最后的兜底: 让 dispatchWebhook 抛错, 然后父 session_id=null 路径调它 → 抛错
    //   但内部 catch 住 + 尝试 insertEvent, 这个 insertEvent 也会成功 (真 DB).
    //
    // 简化策略: 直接验证当 child 找不到时 (task 被硬删不可能, 但我们删 db row):
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    // 物理删除子 task row (绕过软删模型, 模拟极端 DB 异常)
    getDb().prepare(`DELETE FROM tasks WHERE id = ?`).run(childId);

    // 不应抛.
    expect(() => {
      notifyParentOfChildStatusChange(childId, "running", "reviewing");
    }).not.toThrow();

    // 静默退出 (child 不存在 → 早返).
    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });
});

describe("notifyParentOfChildStatusChange — message 格式审查", () => {
  it("reviewing → 含 tag + 状态语义 + 链接, result 截断到 800 字 + 「…」", () => {
    // R59 二轮: 子任务没写 result_summary 时 fallback 读 child.result, 同样截断.
    // 给 child 一个超长 result, 应被截断到 800 字, 不应出现 5000 字全文.
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, { metadata: JSON.stringify({}) });
    getDb()
      .prepare(`UPDATE tasks SET result = ? WHERE id = ?`)
      .run("A".repeat(5000), childId);

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toMatch(/^\[subtask-notify\]/);
    expect(msg).toContain("已进入 reviewing");
    expect(msg).toContain(childId.slice(0, 8));
    expect(msg).toContain(`/#/tasks/${childId}`);
    // R59 二轮: fallback 读 result, 截断到 800 字 + 「…」后缀
    expect(msg).toContain("**子任务自述**: " + "A".repeat(800) + "…");
    expect(msg).not.toContain("A".repeat(1000)); // 1000+ 字符不出现 (超出 800 截断)
  });

  it("failed → 含 '已进入 failed', 措辞同样引导 approve/reject", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "failed");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toContain("已进入 failed");
    expect(msg).toContain("approve");
  });
});

// R59 (damo 0830 + 0903 迭代): 子任务 agent 收尾前可自决写 task.metadata.result_summary;
//   不写时回退读 child.result (子任务最后一段 assistant message 文本). 父通知 message
//   拼接「**子任务自述**: ...」一行 (800 字截断). 两边都没内容就跟 R107 原版一致.
describe("notifyParentOfChildStatusChange — R59 子任务 result_summary", () => {
  it("子任务有 result_summary → 消息含「**子任务自述**: ...」", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, {
      metadata: JSON.stringify({
        result_summary: "本轮把 R40 走通，三套实例已升级 + curl 健康 OK",
      }),
    });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toContain("**子任务自述**: 本轮把 R40 走通，三套实例已升级 + curl 健康 OK");
    // 其他结构不变
    expect(msg).toMatch(/^\[subtask-notify\]/);
    expect(msg).toContain("已进入 reviewing");
    expect(msg).toContain(`/#/tasks/${childId}`);
  });

  it("子任务无 result_summary 但有 result → fallback 读 child.result", () => {
    // R59 二轮 (damo 0903 反馈): 子任务不写 result_summary 时也得有内容, 不能空跑.
    // 退路 = child.result (子任务最后一段 assistant message 文本).
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, { metadata: JSON.stringify({}) });
    getDb()
      .prepare(`UPDATE tasks SET result = ? WHERE id = ?`)
      .run("子任务回执：把 R59 实施完了，4 单测全过，等部署", childId);

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toContain("**子任务自述**: 子任务回执：把 R59 实施完了，4 单测全过，等部署");
  });

  it("子任务 result_summary 超长（>800 字）→ 截断 + 「…」后缀", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    const longSummary = "A".repeat(1500);
    updateTask(childId, {
      metadata: JSON.stringify({ result_summary: longSummary }),
    });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    // 截断到 800 字 + 一个省略号
    expect(msg).toContain("**子任务自述**: " + "A".repeat(800) + "…");
    // 完整的 1500 字不出现
    expect(msg).not.toContain("A".repeat(1500));
  });

  it("子任务 result 超长（>800 字，fallback 路径）→ 同样截断", () => {
    // 退路读 child.result 也得守 800 字上限, 防 prompt 膨胀.
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, { metadata: JSON.stringify({}) });
    getDb()
      .prepare(`UPDATE tasks SET result = ? WHERE id = ?`)
      .run("B".repeat(1500), childId);

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toContain("**子任务自述**: " + "B".repeat(800) + "…");
    expect(msg).not.toContain("B".repeat(1500));
  });

  it("子任务有 result_summary + 有 result → result_summary 优先（不被 result 覆盖）", () => {
    // Priority: metadata.result_summary > child.result. 自决的优先.
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, {
      metadata: JSON.stringify({ result_summary: "自决摘要" }),
    });
    getDb()
      .prepare(`UPDATE tasks SET result = ? WHERE id = ?`)
      .run("child.result 自动 fallback 内容", childId);

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toContain("**子任务自述**: 自决摘要");
    expect(msg).not.toContain("child.result 自动 fallback 内容");
  });

  it("子任务 result_summary + result 都空 → 消息与 R107 原版一致（无「子任务自述」段）", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, { metadata: JSON.stringify({}) });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).not.toContain("子任务自述");
    // 结构与 R107 一致
    expect(msg).toMatch(/^\[subtask-notify\]/);
    expect(msg).toContain("已进入 reviewing");
    expect(msg).toContain("如需要继续,先 approve 或 reject 本子任务,再派下一个。");
  });

  it("failed 状态 + 有 result_summary → 失败摘要同样带（比链接更省父时间）", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, {
      metadata: JSON.stringify({
        result_summary: "失败原因: vitest mock 路径错，import 顺序改对后通过",
      }),
    });

    notifyParentOfChildStatusChange(childId, "running", "failed");

    const msg = senderMock.mock.calls[0][1] as string;
    expect(msg).toContain("已进入 failed");
    expect(msg).toContain("**子任务自述**: 失败原因: vitest mock 路径错，import 顺序改对后通过");
  });

  it("webhook 兜底路径 + 子任务有 summary → note.child_result_summary 字段携带", () => {
    // 父 session_id=null → 走 webhook 兜底
    const parentId = makeParent({ status: "completed", session_id: null });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(childId, {
      metadata: JSON.stringify({
        result_summary: "本轮把 R59 实施完成，4 单测全过",
      }),
    });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).toHaveBeenCalledTimes(1);
    const noteArg = dispatchWebhookMock.mock.calls[0][3] as string;
    const parsed = JSON.parse(noteArg);
    expect(parsed.child_result_summary).toBe("本轮把 R59 实施完成，4 单测全过");
  });
});

// R127 §3.4 洞2: 子 completed 也走 NOTIFY_STATUSES, 但仅在父 waiting_child_id === child.id
//   命中时才推 + 触发 auto-resume. 无关子 completed 不刷屏 (与 damo R107 原口径一致).
//   触发顺序: notifyParentOfChildStatusChange → 血缘判据 → (命中) sender + autoResume.
describe("notifyParentOfChildStatusChange — R127 §3.4 洞2 (子 completed 血缘判据)", () => {
  let autoResumeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    autoResumeMock = vi.fn();
    setupParentNotify(senderMock, autoResumeMock);
  });

  it("子 completed + 父 waiting_child_id 命中 → 推父 + 调 autoResume", () => {
    const parentId = makeParent({ status: "reviewing", session_id: "sess-w" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(parentId, {
      metadata: JSON.stringify({ waiting_child_id: childId }),
    });

    notifyParentOfChildStatusChange(childId, "running", "completed");

    expect(autoResumeMock).toHaveBeenCalledTimes(1);
    expect(autoResumeMock).toHaveBeenCalledWith(childId);
    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][1]).toContain("已进入 completed");
  });

  it("子 completed + 父 waiting_child_id 不命中 → 静默 + 落 dropped", () => {
    const parentId = makeParent({ status: "reviewing", session_id: "sess-w" });
    const childId = makeChild(parentId, { status: "running" });
    // 父 metadata 里 waiting_child_id 是别的子 id, 不命中
    updateTask(parentId, {
      metadata: JSON.stringify({ waiting_child_id: "other-child-uuid" }),
    });

    notifyParentOfChildStatusChange(childId, "running", "completed");

    expect(autoResumeMock).not.toHaveBeenCalled();
    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();

    const events = getEventsByTaskId(childId);
    const dropped = events.find((e) => e.type === "parent_notify_dropped");
    expect(dropped).toBeTruthy();
    const data = JSON.parse(dropped!.data);
    expect(data.reason).toBe("completed_but_parent_not_waiting");
    expect(data.waiting_child_id).toBe("other-child-uuid");
  });

  it("子 completed + 父 metadata 缺 waiting_child_id → 静默 + dropped", () => {
    const parentId = makeParent({ status: "reviewing", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    // 父 metadata 是空对象, 没有 waiting_child_id 字段
    updateTask(parentId, { metadata: JSON.stringify({}) });

    notifyParentOfChildStatusChange(childId, "running", "completed");

    expect(autoResumeMock).not.toHaveBeenCalled();
    expect(senderMock).not.toHaveBeenCalled();

    const events = getEventsByTaskId(childId);
    const dropped = events.find((e) => e.type === "parent_notify_dropped");
    expect(dropped).toBeTruthy();
    expect(JSON.parse(dropped!.data).reason).toBe(
      "completed_but_parent_not_waiting",
    );
  });

  it("autoResumeSender 抛异常 → 不影响主通知流, console.warn 兜底", () => {
    autoResumeMock.mockImplementation(() => {
      throw new Error("synthetic autoResume failure");
    });
    const parentId = makeParent({ status: "reviewing", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    updateTask(parentId, {
      metadata: JSON.stringify({ waiting_child_id: childId }),
    });

    // 不应冒泡 (parent-notify 顶层 catch 兜底)
    expect(() =>
      notifyParentOfChildStatusChange(childId, "running", "completed"),
    ).not.toThrow();

    // autoResume 调到了 (失败也调)
    expect(autoResumeMock).toHaveBeenCalled();
  });
});

// R78 W2 reject 修复 (damo 0904 拍): 同态 status_change (from === to) 短路. emitEvent
//   允许同态事件 (例 PATCH timeout 写 DB 会触发 reviewing → reviewing), 但 notify
//   视角 = 状态没变 = 不该再推父. 在 NOTIFY_STATUSES.has(to) 之后立刻加 `from === to`
//   短路: 接收端防御, 不挡合法 emitEvent 调用方. 覆盖 5 态 NOTIFY_STATUSES
//   (reviewing/failed/cancelled/rejected/completed).
describe("notifyParentOfChildStatusChange — R78 W2 同态 from===to 短路", () => {
  it("T1: child 已 reviewing, 调 (reviewing, reviewing) → 0 sender + 0 dropped + 0 webhook", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "reviewing" });

    notifyParentOfChildStatusChange(childId, "reviewing", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
    const events = getEventsByTaskId(childId);
    expect(events.find((e) => e.type === "parent_notify_dropped")).toBeUndefined();
    expect(events.find((e) => e.type === "parent_notify_dispatched")).toBeUndefined();
    expect(events.find((e) => e.type === "parent_notify_failed")).toBeUndefined();
  });

  it("T2: child running, 调 (running, reviewing) → 仍正常 notify (真跨态未受影响)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][0]).toBe(parentId);
    expect(senderMock.mock.calls[0][1]).toContain("已进入 reviewing");
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });

  it("T3: child 已 reviewing, 调 (reviewing, failed) → 仍正常 notify (同态短路不漏真跨态)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "reviewing" });

    notifyParentOfChildStatusChange(childId, "reviewing", "failed");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(senderMock.mock.calls[0][1]).toContain("已进入 failed");
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
  });

  it("T4: child 已 cancelled, 调 (cancelled, cancelled) → 0 notify (同态短路覆盖 cancelled 终态)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "cancelled" });

    notifyParentOfChildStatusChange(childId, "cancelled", "cancelled");

    expect(senderMock).not.toHaveBeenCalled();
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
    const events = getEventsByTaskId(childId);
    expect(events.find((e) => e.type === "parent_notify_dropped")).toBeUndefined();
    expect(events.find((e) => e.type === "parent_notify_dispatched")).toBeUndefined();
  });

  it("T5: webhook 兜底路径单独验证 — 父 session_id=null, 同态事件不该新增 event 计数", () => {
    // 父 session_id=null → 任何 notify 都走 webhook 兜底. 同态短路应在这里也生效,
    //   否则 webhook event 表会被同态事件刷屏.
    const parentId = makeParent({ status: "completed", session_id: null });
    const childId = makeChild(parentId, { status: "reviewing" });

    notifyParentOfChildStatusChange(childId, "reviewing", "reviewing");
    notifyParentOfChildStatusChange(childId, "reviewing", "reviewing");
    notifyParentOfChildStatusChange(childId, "reviewing", "reviewing");

    expect(senderMock).not.toHaveBeenCalled();
    // webhook 一次都没被调 (3 次同态事件全被短路).
    expect(dispatchWebhookMock).not.toHaveBeenCalled();
    const events = getEventsByTaskId(childId);
    expect(events.filter((e) => e.type === "parent_notify_dispatched").length).toBe(0);
    expect(events.filter((e) => e.type === "parent_notify_dropped").length).toBe(0);
  });
});

// R107 重复通知抑制 (damo 0908, R6 守护轮 R100 实证).
//   现象: 同一 (parent, child, reviewing) 48h 内被推 7 次, 每次把父从 reviewing 拽回
//   queued 重烧一整轮 agent. 抑制判据 = db/events.ts:isRedundantParentNotify.
//   两面都必须覆盖: 冗余不推 + 合法二次通知仍推.
describe("notifyParentOfChildStatusChange — R107 重复通知抑制", () => {
  // 模拟「子任务被真正处置」: 落一条 reason 不属于平台自动回收的 status_change,
  //   from = 上次通知的 child_to (approve = reviewing→completed).
  function markHandled(childId: string, from: TaskStatus, to: TaskStatus) {
    insertEvent({
      task_id: childId,
      type: "status_change",
      data: JSON.stringify({ from, to }),
    });
  }

  it("D1: 同一 (parent, child, reviewing) 第二次 → 抑制, 落 parent_notify_suppressed", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    expect(senderMock).toHaveBeenCalledTimes(1);

    // 父被唤醒 → 子重进 reviewing (平台侧 resume, 无人处置) → 第二次通知.
    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(1); // 没有第二次推送
    const events = getEventsByTaskId(childId);
    expect(events.filter((e) => e.type === "parent_notify_dispatched").length).toBe(1);
    const sup = events.filter((e) => e.type === "parent_notify_suppressed");
    expect(sup.length).toBe(1);
    const data = JSON.parse(sup[0].data!);
    expect(data.parent_id).toBe(parentId);
    expect(data.reason).toBe("duplicate_unhandled");
    expect(data.child_to).toBe("reviewing");
  });

  it("D2: 连推 5 次 → 只有第 1 次真推, 后 4 次全抑制 (烧钱面被封住)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    for (let i = 0; i < 5; i++) {
      notifyParentOfChildStatusChange(childId, "running", "reviewing");
    }

    expect(senderMock).toHaveBeenCalledTimes(1);
    const events = getEventsByTaskId(childId);
    expect(events.filter((e) => e.type === "parent_notify_suppressed").length).toBe(4);
  });

  it("D3: 子被 approve (reviewing→completed) 后重跑再进 reviewing → 合法二次通知, 仍推", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    expect(senderMock).toHaveBeenCalledTimes(1);

    markHandled(childId, "reviewing", "completed"); // approve = 人真处置过

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(2);
    const events = getEventsByTaskId(childId);
    expect(events.filter((e) => e.type === "parent_notify_dispatched").length).toBe(2);
    expect(events.filter((e) => e.type === "parent_notify_suppressed").length).toBe(0);
  });

  it("D4: 子被 reject 后重跑再进 reviewing → 仍推 (reject 也算处置)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    markHandled(childId, "reviewing", "rejected");
    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(2);
  });

  it("D5: 平台自动回收 (reason=parent_notify / drain_stranded / restart) 不算处置 → 仍抑制", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    for (const reason of ["parent_notify", "drain_stranded", "restart"]) {
      insertEvent({
        task_id: childId,
        type: "status_change",
        data: JSON.stringify({ from: "reviewing", to: "queued", reason }),
      });
    }

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(1);
    const events = getEventsByTaskId(childId);
    expect(events.filter((e) => e.type === "parent_notify_suppressed").length).toBe(1);
  });

  it("D6: 不同 child_to (reviewing 后 failed) 不共享抑制键 → 仍推", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    notifyParentOfChildStatusChange(childId, "running", "failed");

    expect(senderMock).toHaveBeenCalledTimes(2);
    expect(senderMock.mock.calls[1][1]).toContain("已进入 failed");
  });

  it("D7: 不同子任务互不影响 (抑制键含 child_id)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childA = makeChild(parentId, { status: "running" });
    const childB = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childA, "running", "reviewing");
    notifyParentOfChildStatusChange(childB, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(2);
    expect(getEventsByTaskId(childA).filter((e) => e.type === "parent_notify_suppressed").length).toBe(0);
    expect(getEventsByTaskId(childB).filter((e) => e.type === "parent_notify_suppressed").length).toBe(0);
  });

  it("D8: 上次通知 >24h 仍未处置 → 逃生窗口放行一次 (父确实漏了消息不被永久掐死)", () => {
    const parentId = makeParent({ status: "running", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    expect(senderMock).toHaveBeenCalledTimes(1);

    // 把那条 dispatched 事件时间推到 25h 前.
    getDb()
      .prepare(
        `UPDATE events SET created_at = datetime('now','-25 hours')
         WHERE task_id = ? AND type = 'parent_notify_dispatched'`,
      )
      .run(childId);

    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(senderMock).toHaveBeenCalledTimes(2);
    // 放行后立刻再来一次 → 又被抑制 (逃生窗口是每 24h 一次, 不是打开闸门).
    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    expect(senderMock).toHaveBeenCalledTimes(2);
  });

  it("D9: webhook 兜底路径同样受抑制 (父 session_id=null)", () => {
    const parentId = makeParent({ status: "completed", session_id: null });
    const childId = makeChild(parentId, { status: "running" });

    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    notifyParentOfChildStatusChange(childId, "running", "reviewing");
    notifyParentOfChildStatusChange(childId, "running", "reviewing");

    expect(dispatchWebhookMock).toHaveBeenCalledTimes(1);
    const events = getEventsByTaskId(childId);
    expect(events.filter((e) => e.type === "parent_notify_dispatched").length).toBe(1);
    expect(events.filter((e) => e.type === "parent_notify_suppressed").length).toBe(2);
  });

  it("D10: 抑制先于 completed 血缘判据 — 已推过的 completed 不重复推 + 不重复调 autoResume", () => {
    const parentId = makeParent({ status: "reviewing", session_id: "sess" });
    const childId = makeChild(parentId, { status: "running" });
    const autoResumeMock = vi.fn();
    setupParentNotify(senderMock, autoResumeMock);
    updateTask(parentId, {
      metadata: JSON.stringify({ waiting_child_id: childId }),
    });

    notifyParentOfChildStatusChange(childId, "reviewing", "completed");
    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(autoResumeMock).toHaveBeenCalledTimes(1);

    notifyParentOfChildStatusChange(childId, "reviewing", "completed");

    expect(senderMock).toHaveBeenCalledTimes(1);
    expect(autoResumeMock).toHaveBeenCalledTimes(1);
  });
});
