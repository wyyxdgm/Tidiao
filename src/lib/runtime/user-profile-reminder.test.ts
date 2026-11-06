/**
 * v518 (飞书 R222): 用户身份注入 (userProfileReminder).
 *
 * 机制: start() 全新会话首条 prompt 前拼一段 system-reminder (内容直注, 不指路
 * 文件 —— 昵称+简介总共几行, 多一次 Read turn 反而亏). 解析规则 (R222 原文):
 * 配置了就用配置的; 昵称没配默认「用户」; 自我介绍没配省略整行.
 * 每 task 会话一次, 不是每轮对话都嵌 (resume 带历史不重注).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: 抓首条 yield 的 user message, 然后立刻 result 收尾 (与 model-guidance 同款).
const h = vi.hoisted(() => ({
  firstMessage: undefined as { message: { content: unknown } } | undefined,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})),
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
    async function* stream() {
      const first = await prompt.next();
      h.firstMessage = first.value as { message: { content: unknown } };
      yield { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0, result: "ok" };
    }
    return stream();
  }),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import { setUserProfile } from "../db/users";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-userprofile-rt-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "profile-rt@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "user-profile-rt", ownerId: userId }).id;

  h.firstMessage = undefined;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(opts?: { noOwner?: boolean }): Task {
  const task = createTask({
    title: "user-profile-rt",
    prompt: "干点活",
    project_id: projectId,
    cwd: tmpDir,
  });
  if (!opts?.noOwner) {
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  }
  return getTaskById(task.id)!;
}

const firstContent = () => h.firstMessage!.message.content as string;

describe("v518 用户身份注入 (userProfileReminder)", () => {
  it("昵称+bio 已配 → 首条 prompt 前拼身份 reminder, 原 prompt 保留", async () => {
    setUserProfile(userId, "老王", "偏好简洁汇报");
    const task = makeTask();
    await new ActiveSession(task).start(task);

    const content = firstContent();
    expect(content).toContain("当前用户身份");
    expect(content).toContain("称呼：老王");
    expect(content).toContain("自我介绍：偏好简洁汇报");
    expect(content).toContain("<system-reminder>");
    // 原任务 prompt 保留在 reminder 之后
    expect(content).toContain("干点活");
    expect(content.indexOf("干点活")).toBeGreaterThan(content.indexOf("</system-reminder>"));
  });

  it("只配 bio → 昵称行回落「用户」, bio 行出现", async () => {
    setUserProfile(userId, null, "喜欢被叫老板");
    const task = makeTask();
    await new ActiveSession(task).start(task);

    const content = firstContent();
    expect(content).toContain("称呼：用户");
    expect(content).toContain("自我介绍：喜欢被叫老板");
  });

  it("未配置 → 仍注入默认「用户」, 无自我介绍行 (R222: 没配就默认成用户)", async () => {
    const task = makeTask();
    await new ActiveSession(task).start(task);

    const content = firstContent();
    expect(content).toContain("称呼：用户");
    expect(content).not.toContain("自我介绍：");
  });

  it("task 无 owner (owner_id NULL) → 不注入, prompt 原样", async () => {
    // task.owner_id 从 project 继承 (v15), 所以无 owner 要连 project 一起无 owner.
    const anonProject = createProject({ name: "user-profile-anon" }).id;
    const task = createTask({
      title: "user-profile-anon",
      prompt: "干点活",
      project_id: anonProject,
      cwd: tmpDir,
    });
    await new ActiveSession(task).start(task);

    const content = firstContent();
    expect(content).not.toContain("当前用户身份");
    expect(content).toContain("干点活");
  });

  it("bio 空白串 → 视同未配置, 省略整行", async () => {
    setUserProfile(userId, "老王", "   ");
    const task = makeTask();
    await new ActiveSession(task).start(task);

    const content = firstContent();
    expect(content).toContain("称呼：老王");
    expect(content).not.toContain("自我介绍：");
  });
});
