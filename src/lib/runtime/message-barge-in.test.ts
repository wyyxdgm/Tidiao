// R216 (damo 2026-10-08 飞书 AO-DEV): 插话打断 + 多条合并
//
// damo 原话: 「现在持续发送消息, 是会走暂停, 再恢复吗? 最好走一下, 不然感觉
// 消息进不去. 多条可以合并」
//
// 背景: turn 进行中用户发消息, 消息只能等 SDK turn 边界才被拉取 —— 长工具调用
// 期间持续排队, 体感「消息进不去」. 修复三件套:
//   1. pushMessage 时 turn 在跑 → 主动 interrupt 当前 turn (等价轻量 pause→resume,
//      session 不断), 消息在下一个 turn 立即被处理.
//   2. 被打断 turn 以 error_during_execution result 收尾 —— 吞掉不翻 failed
//      (shouldSwallowBargeInResult 纯判定 + consumeMessages 集成点).
//   3. live 连发的多条消息在 generator 排空时合并为一条投递 (damo: 「多条可以合并」).
//
// 这里断言 1/2(纯判定)/3; consumeMessages 集成点是两行接线 (shouldSwallow 命中
// → continue), 由 2 的用例覆盖判定逻辑.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask } from "../db/tasks";
import { ActiveSession } from "./active-session";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-barge-in-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x");

  projectId = createProject({
    name: "barge-in-test",
    cwd: tmpDir,
    ownerId,
  }).id;
});

afterEach(async () => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function newSession(title: string): { session: ActiveSession; interrupt: ReturnType<typeof vi.fn> } {
  const task = createTask({ title, prompt: "test prompt", project_id: projectId });
  const session = new ActiveSession(task as Task);
  const interrupt = vi.fn(async () => undefined);
  // mock queryInstance: 真 query 需要起 CLI subprocess, 这里只验证 interrupt 调用;
  // close 是 session.close() 收尾用的, mock 成 no-op.
  (session as unknown as { queryInstance: unknown }).queryInstance = {
    interrupt,
    close: vi.fn(),
  };
  return { session, interrupt };
}

// ---- 1. pushMessage 触发插话 interrupt ----

describe("R216 pushMessage 插话打断", () => {
  it("turnActive=true + queryInstance 在 → interrupt 被调用, messageInterruptAt 记录", () => {
    const { session, interrupt } = newSession("插话-触发");
    (session as unknown as { turnActive: boolean }).turnActive = true;

    session.pushMessage("喂, 停一下");

    expect(interrupt).toHaveBeenCalledTimes(1);
    const s = session as unknown as { messageInterruptAt: number | null };
    expect(s.messageInterruptAt).not.toBeNull();
  });

  it("turnActive=false (turn 已结束) → 不 interrupt, 消息照常排队等 turn 边界", () => {
    const { session, interrupt } = newSession("插话-不触发");
    // turnActive 初始 false; generator 未启动 (无 resolver) → 走排队分支

    session.pushMessage("turn 空闲期消息");

    expect(interrupt).not.toHaveBeenCalled();
    expect((session as unknown as { pendingMessages: string[] }).pendingMessages).toEqual([
      "turn 空闲期消息",
    ]);
  });

  it("连发多条 2s debounce 内 → interrupt 只发起一次 (每条都进队)", () => {
    const { session, interrupt } = newSession("插话-去抖");
    (session as unknown as { turnActive: boolean }).turnActive = true;

    session.pushMessage("第一条");
    session.pushMessage("第二条");
    session.pushMessage("第三条");

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect((session as unknown as { pendingMessages: string[] }).pendingMessages).toHaveLength(3);
  });

  it("externallyTerminated (pause/cancel 中) → 不 interrupt", () => {
    const { session, interrupt } = newSession("插话-外部终止");
    (session as unknown as { turnActive: boolean }).turnActive = true;
    (session as unknown as { externallyTerminated: boolean }).externallyTerminated = true;

    session.pushMessage("外部终止中的消息");

    expect(interrupt).not.toHaveBeenCalled();
  });
});

// ---- 2. 被打断 turn 的 result 不翻 failed (纯判定) ----

describe("R216 shouldSwallowBargeInResult", () => {
  function freshSession(): ActiveSession {
    return newSession("swallow-判定").session;
  }

  it("error_during_execution + 窗口内 → true (吞掉, 让 generator 续跑)", () => {
    const session = freshSession();
    (session as unknown as { messageInterruptAt: number | null }).messageInterruptAt = Date.now();
    const s = session as unknown as { shouldSwallowBargeInResult: (t: unknown) => boolean };
    expect(s.shouldSwallowBargeInResult("error_during_execution")).toBe(true);
  });

  it("error_max_turns + 窗口内 → false (真错误照旧翻 failed)", () => {
    const session = freshSession();
    (session as unknown as { messageInterruptAt: number | null }).messageInterruptAt = Date.now();
    const s = session as unknown as { shouldSwallowBargeInResult: (t: unknown) => boolean };
    expect(s.shouldSwallowBargeInResult("error_max_turns")).toBe(false);
  });

  it("error_during_execution + 无插话 flag → false (非打断错误不豁免)", () => {
    const session = freshSession();
    const s = session as unknown as { shouldSwallowBargeInResult: (t: unknown) => boolean };
    expect(s.shouldSwallowBargeInResult("error_during_execution")).toBe(false);
  });

  it("error_during_execution + 超窗 (31s 前) → false (过窗走原失败逻辑)", () => {
    const session = freshSession();
    (session as unknown as { messageInterruptAt: number | null }).messageInterruptAt =
      Date.now() - 31_000;
    const s = session as unknown as { shouldSwallowBargeInResult: (t: unknown) => boolean };
    expect(s.shouldSwallowBargeInResult("error_during_execution")).toBe(false);
  });
});

// ---- 3. 多条消息合并为一条投递 ----

describe("R216 createMessageGenerator 多条合并", () => {
  it("pushMessage 排队的 3 条消息 → generator yield 一条合并消息 (\\n\\n 连接)", async () => {
    const { session } = newSession("合并-三条");
    // turnActive=false, pushMessage 全部进 pendingMessages 队列
    session.pushMessage("先改 A 文件");
    session.pushMessage("再跑测试");
    session.pushMessage("最后 commit");

    const gen = (
      session as unknown as {
        createMessageGenerator: (p: string, pre: string[]) => AsyncGenerator<unknown>;
      }
    ).createMessageGenerator("", []);

    const first = await gen.next();
    expect(first.done).toBe(false);
    const msg = first.value as { message: { content: string } };
    expect(msg.message.content).toBe("先改 A 文件\n\n再跑测试\n\n最后 commit");

    // 队列已排空
    expect((session as unknown as { pendingMessages: string[] }).pendingMessages).toHaveLength(0);
    // unansweredUserTurn 记录的是合并后文本 (pause 回填口径一致)
    expect((session as unknown as { unansweredUserTurn: string | null }).unansweredUserTurn).toBe(
      "先改 A 文件\n\n再跑测试\n\n最后 commit",
    );

    await session.close();
  });

  it("preMessages (resume 场景) 保持逐条投递, 不被合并语义波及", async () => {
    const { session } = newSession("合并-preMessages-逐条");
    const gen = (
      session as unknown as {
        createMessageGenerator: (p: string, pre: string[]) => AsyncGenerator<unknown>;
      }
    ).createMessageGenerator("", ["旧指令一", "旧指令二"]);

    const first = await gen.next();
    const second = await gen.next();
    expect((first.value as { message: { content: string } }).message.content).toBe("旧指令一");
    expect((second.value as { message: { content: string } }).message.content).toBe("旧指令二");

    await session.close();
  });

  it("generator yield 前 turnActive 置 true (插话判据的置位来源)", async () => {
    const { session } = newSession("合并-turnActive");
    session.pushMessage("一条");
    const gen = (
      session as unknown as {
        createMessageGenerator: (p: string, pre: string[]) => AsyncGenerator<unknown>;
      }
    ).createMessageGenerator("", []);

    expect((session as unknown as { turnActive: boolean }).turnActive).toBe(false);
    await gen.next();
    expect((session as unknown as { turnActive: boolean }).turnActive).toBe(true);

    await session.close();
  });
});

// ---- 4. R56 复发 (damo 2026-10-31): 插话消息投递附 canned STOP 纠正注记 ----
//
// 背景: 插话 interrupt 时 SDK CLI 原生注入 canned tool_result「The user doesn't
// want to proceed... STOP what you are doing and wait for the user to tell you how
// to proceed.」(措辞在 native 二进制里, 平台改不了). 弱模型直球当成「用户叫停」→
// ack「收到，停」+ end_turn 空等 (R56 7+ 例; 删防线后复发 10-09/10-31).
// 修复: wasRecentBargeIn() 窗口内命中 → 投递插话消息前附 BARGE_IN_CONTEXT_NOTE.

describe("R56 复发: 插话投递附纠正注记", () => {
  function makeGen(session: ActiveSession) {
    return (
      session as unknown as {
        createMessageGenerator: (p: string, pre: string[]) => AsyncGenerator<unknown>;
      }
    ).createMessageGenerator("", []);
  }

  it("插话 interrupt 后投递 → 消息前附纠正注记, 正文完整在末尾", async () => {
    const { session } = newSession("注记-插话后");
    (session as unknown as { turnActive: boolean }).turnActive = true;
    session.pushMessage("先看这个通知");

    const first = (await makeGen(session).next()) as { value: { message: { content: string } } };
    const content = first.value.message.content;
    expect(content).toContain("STOP what you are doing");
    expect(content).toContain("不是叫停任务");
    expect(content.endsWith("先看这个通知")).toBe(true);
    // unansweredUserTurn 保持纯消息文本 (pause 回填 / goal 评分口径不变)
    expect((session as unknown as { unansweredUserTurn: string | null }).unansweredUserTurn).toBe(
      "先看这个通知",
    );

    await session.close();
  });

  it("无插话 → 投递不带注记 (R216 合并语义原样回归)", async () => {
    const { session } = newSession("注记-无插话");
    session.pushMessage("普通排队消息");

    const first = (await makeGen(session).next()) as { value: { message: { content: string } } };
    expect(first.value.message.content).toBe("普通排队消息");

    await session.close();
  });

  it("插话超窗 (31s 前) → 不附注记", async () => {
    const { session } = newSession("注记-超窗");
    (session as unknown as { turnActive: boolean }).turnActive = true;
    session.pushMessage("迟到投递");
    (session as unknown as { lastBargeInAt: number }).lastBargeInAt = Date.now() - 31_000;

    const first = (await makeGen(session).next()) as { value: { message: { content: string } } };
    expect(first.value.message.content).toBe("迟到投递");

    await session.close();
  });
});
