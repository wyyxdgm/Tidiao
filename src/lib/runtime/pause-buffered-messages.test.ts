/**
 * 2026-08-22 task e43eeb0d 回归.
 *
 * 场景: 用户点「暂停」时, SDK subprocess 正在跑 sleep 100 / bash 等阻塞 tool.
 * SDK Query.close() 只 end stdin (subprocess 收 EOF 后才退出), 不杀阻塞中的 tool.
 * 期间 subprocess 还会 emit 缓冲消息甚至 result message.
 * 旧版 ActiveSession.consumeMessages 无条件 updateTaskStatus("reviewing")
 * 覆盖 paused 状态, 用户看到「点暂停几秒后又开始输出 + 状态回 reviewing」.
 *
 * 解法双层:
 *   (1) pauseTask/cancelTask 同步 markExternallyTerminated, for-await 循环 drop
 *       后续消息 (除 result 外都不处理).
 *   (2) 即便 flag 没及时生效 (recoverOrphanedTasks/server_restart 路径), result
 *       分支读 task.status: 已非 running 时不再写 reviewing/failed, 把 cost
 *       落库后 break 让 for-await 退出.
 *
 * 测试覆盖:
 *   - markExternallyTerminated 后 for-await 不再 emit assistant_message / tool_use
 *   - 库 status 守卫 (无 mark 也能挡): result 到达时 task.status != running
 *     不写 reviewing
 *   - 正常完成路径 (task.status === running) 仍写 reviewing — 不回归
 *   - pauseTask/cancelTask 调用 mark 在 interrupt/close 之前 — 不回归
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Mock SDK: query() 返回一个受脚本控制的 message stream.
// 用一个共享的 promise/resolve 队列, 让测试同步 push 消息并主动结束.
// 平台侧调 close() 时, 队列清空 + 阻塞 promise resolve, 让 for-await 干净退出.
const h = vi.hoisted(() => ({
  // 平台还没 pop 的待 yield 消息.
  messages: [] as unknown[],
  // 测试结束流 (close 调用时 resolve 这个 promise, 让生成器从 await 里返回).
  endResolvers: [] as Array<() => void>,
  eventsSeen: [] as Array<{ kind: string; detail?: unknown }>,
  // close() 是否被调过, 用来断 generate 循环.
  closed: false,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})), // media MCP (start 路径) — mock 缺这个 export 会全红, 2026-10-03 补
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
    async function* stream() {
      await prompt.next(); // 吃掉初始 prompt
      while (!h.closed) {
        if (h.messages.length > 0) {
          const msg = h.messages.shift();
          yield msg;
          continue;
        }
        // 没消息就阻塞, 等测试 push 或 close
        await new Promise<void>((resolve) => h.endResolvers.push(resolve));
        if (h.closed) return;
      }
    }
    const it = stream();
    // close() 是 session.close() 期待的接口. 把 close 暴露到外层状态.
    (it as unknown as { close: () => void }).close = () => {
      h.closed = true;
      while (h.endResolvers.length > 0) {
        const r = h.endResolvers.shift()!;
        r();
      }
    };
    return it;
  }),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { AgentRuntime } from "./agent-runtime";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";
import { getEventsByTaskId } from "../db/events";
import { upsertLlmConfig } from "../db/llm-configs";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-pause-buf-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "pause-buf@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test" });
  projectId = createProject({ name: "pause-buf-test", ownerId: userId }).id;

  h.messages = [];
  h.endResolvers = [];
  h.closed = false;
  h.eventsSeen = [];
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunningTask(): Task {
  const task = createTask({
    title: "pause-buffer-test",
    prompt: "test prompt",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  updateTaskStatus(task.id, "running", {
    session_id: `sess-${task.id.slice(0, 8)}`,
    started_at: new Date().toISOString(),
  });
  return getTaskById(task.id)!;
}

// 给 session 装个钩子, 把 ActiveSession 走过的关键 SSE event 类型记下来.
// 我们尤其关心的是 assistant_message / tool_use 在 markExternallyTerminated 之后
// 是否还继续 emit — 它们就是用户在前端看到的「还在输出」.
function installDropProbe(session: ActiveSession): void {
  session.onEvent((event) => {
    if (event.type === "assistant_message") {
      h.eventsSeen.push({ kind: "assistant_message" });
    } else if (event.type === "tool_use") {
      h.eventsSeen.push({ kind: "tool_use" });
    } else if (event.type === "status_change") {
      h.eventsSeen.push({ kind: "status_change", detail: { from: event.from, to: event.to } });
    } else if (event.type === "stream_delta") {
      h.eventsSeen.push({ kind: "stream_delta" });
    }
  });
}

// 构造带 hang query 的 runtime, 把 session 直接装到 sessions Map, 不走 scheduler.
function attachSession(runtime: AgentRuntime, task: Task): ActiveSession {
  const session = new ActiveSession(task);
  installDropProbe(session);
  (runtime as unknown as { sessions: Map<string, ActiveSession> }).sessions.set(task.id, session);
  return session;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("pauseTask: status guard narrow to externally-decided statuses", () => {
  it("task.status=pending 时不触发 result 守卫 (scheduler 未翻状态不应拦)", async () => {
    // scheduler 还没从 pending 翻到 running 时 result 就到了 — 这是测试场景
    // (跳过 scheduler 直接 await session.start). 守卫只拦 paused/cancelled/
    // failed, 否则会把 pending 误判为「外部结束」, 跳过 bg-agent-guard 注入等
    // 正常流程.
    const runtime = new AgentRuntime();
    const task = createTask({
      title: "guard-narrow",
      prompt: "p",
      project_id: projectId,
      cwd: tmpDir,
    });
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
    updateTaskStatus(task.id, "pending");
    const t = getTaskById(task.id)!;

    const session = attachSession(runtime, t);

    h.messages.push({
      type: "result",
      session_id: t.session_id || "sess-x",
      subtype: "success",
      total_cost_usd: 0.01,
      result: "ok",
    });

    const startP = session.start(t).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    // 守卫没拦, status 写成了 reviewing (正常路径)
    const after = getTaskById(t.id);
    expect(after?.status).toBe("reviewing");

    // 没有 result_after_status_change 留痕
    const events = getEventsByTaskId(t.id);
    const guard = events.find(
      (e) => e.type === "warning" && JSON.parse(e.data).kind === "result_after_status_change"
    );
    expect(guard).toBeFalsy();

    await session.close();
    await startP;
  });
});

describe("pauseTask: drop buffered messages from dying SDK subprocess", () => {
  it("markExternallyTerminated 后 for-await 不再 emit assistant_message", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 模拟 sleep/bash 期间用户点暂停 — 同步 mark
    session.markExternallyTerminated();
    // 暂停后 SDK subprocess 又吐的 3 条 assistant_message — 应该全部 drop
    h.messages.push({
      type: "assistant",
      uuid: "msg-1",
      session_id: task.session_id,
      content: [{ type: "text", text: "after pause 1" }],
      message: { content: [{ type: "text", text: "after pause 1" }] },
    });
    h.messages.push({
      type: "assistant",
      uuid: "msg-2",
      session_id: task.session_id,
      content: [{ type: "text", text: "after pause 2" }],
      message: { content: [{ type: "text", text: "after pause 2" }] },
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    // markExternallyTerminated 后所有非 result 消息都被 drop.
    const assistantSeen = h.eventsSeen.filter((e) => e.kind === "assistant_message");
    expect(assistantSeen.length).toBe(0);

    await session.close();
    await startP;
  });

  it("markExternallyTerminated 后 for-await 不再 emit tool_use (流式 content_block_start)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    session.markExternallyTerminated();
    // 模拟 SDK 在 pause 后 emit content_block_start tool_use — 应该被 drop
    h.messages.push({
      type: "stream_event",
      session_id: task.session_id,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
      },
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    const toolSeen = h.eventsSeen.filter((e) => e.kind === "tool_use");
    expect(toolSeen.length).toBe(0);

    await session.close();
    await startP;
  });

  it("task.status 已被外部改成 paused 时, 后续 result 不写 reviewing", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 不调 markExternallyTerminated (模拟 recoverOrphanedTasks 路径: 没 ActiveSession
    // 实例能挂 flag). 模拟外部把 status 改成 paused (如服务端断电恢复).
    updateTaskStatus(task.id, "paused", { session_id: task.session_id });

    // 现在 SDK subprocess 终于跑完 sleep, 发 result success — 但 status 已经不是 running.
    // 守卫应该 break + 不写 reviewing.
    h.messages.push({
      type: "result",
      session_id: task.session_id,
      subtype: "success",
      total_cost_usd: 0.05,
      result: "should be dropped",
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    // 库 status 仍是 paused, 没被覆盖
    const after = getTaskById(task.id);
    expect(after?.status).toBe("paused");

    // SSE 没有发 status_change running→reviewing
    const statusChanges = h.eventsSeen.filter(
      (e) => e.kind === "status_change" && (e.detail as any)?.to === "reviewing"
    );
    expect(statusChanges.length).toBe(0);

    // 事件流里有 result_after_status_change 留痕
    const events = getEventsByTaskId(task.id);
    const guard = events.find(
      (e) => e.type === "warning" && JSON.parse(e.data).kind === "result_after_status_change"
    );
    expect(guard).toBeTruthy();

    await session.close();
    await startP;
  });

  it("正常完成路径不受影响: task.status=running 时 result 仍写 reviewing", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 不 mark, status 保持 running, 模拟正常完成路径
    h.messages.push({
      type: "result",
      session_id: task.session_id,
      subtype: "success",
      total_cost_usd: 0.1,
      result: "done normally",
    });

    const startP = session.start(task).catch(() => {});
    // 等待 result 被消费 + status 改 reviewing
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    // 走的是正常路径: reviewing
    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    const statusChanges = h.eventsSeen.filter(
      (e) => e.kind === "status_change" && (e.detail as any)?.to === "reviewing"
    );
    expect(statusChanges.length).toBe(1);

    // 清场: 通知 mock 流结束 (result 处理后 closed 标志由 session 内部管, mock
    // 这边需要外部触发 close 让生成器退出, 否则 startP 永远 await).
    await session.close();
    await startP;
  });
});

describe("pauseTask: ordering — mark before interrupt+close", () => {
  it("AgentRuntime.pauseTask 调用 session.markExternallyTerminated 在 interrupt 之前", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // spy 调用顺序
    const calls: string[] = [];
    const origMark = session.markExternallyTerminated.bind(session);
    const origInterrupt = session.interrupt.bind(session);
    const origClose = session.close.bind(session);
    session.markExternallyTerminated = () => {
      calls.push("mark");
      origMark();
    };
    session.interrupt = async () => {
      calls.push("interrupt");
      await origInterrupt();
    };
    session.close = async () => {
      calls.push("close");
      await origClose();
    };

    await runtime.pauseTask(task.id, "manual");

    // mark 必须在 interrupt 之前, interrupt 在 close 之前
    expect(calls.indexOf("mark")).toBeLessThan(calls.indexOf("interrupt"));
    expect(calls.indexOf("interrupt")).toBeLessThan(calls.indexOf("close"));
  });

  it("AgentRuntime.cancelTask 调用 session.markExternallyTerminated 在 interrupt 之前", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    const calls: string[] = [];
    const origMark = session.markExternallyTerminated.bind(session);
    const origInterrupt = session.interrupt.bind(session);
    const origClose = session.close.bind(session);
    session.markExternallyTerminated = () => {
      calls.push("mark");
      origMark();
    };
    session.interrupt = async () => {
      calls.push("interrupt");
      await origInterrupt();
    };
    session.close = async () => {
      calls.push("close");
      await origClose();
    };

    await runtime.cancelTask(task.id, "manual");

    expect(calls.indexOf("mark")).toBeLessThan(calls.indexOf("interrupt"));
    expect(calls.indexOf("interrupt")).toBeLessThan(calls.indexOf("close"));
  });
});