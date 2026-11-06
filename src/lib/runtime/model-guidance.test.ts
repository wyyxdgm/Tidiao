/**
 * 模型感知 + 模型专属引导注入.
 *
 * 背景: MiniMax-M3 等弱模型在平台实测有「汇报口径与实际行为不一致」等问题
 * (2026-08-16 task 36422466: 声称按 AGENT_WRITABLE 写列, 实际另写 7 列越权).
 * 机制: ① buildEnv() 注入 ORCHESTRATOR_MODEL(resolved 链最终值), agent 可感知
 * 自己跑在什么模型上; ② 模型命中 MODEL_GUIDANCE 且引导文件存在时, 首条 prompt
 * 前拼一段指路 system-reminder, agent 自己 Read 引导文件(平台不塞内容, 省 token).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: 抓 options.env + 首条 yield 的 user message, 然后立刻 result 收尾。
const h = vi.hoisted(() => ({
  env: undefined as Record<string, string | undefined> | undefined,
  firstMessage: undefined as { message: { content: unknown } } | undefined,
  queryCalls: [] as Array<Record<string, string | undefined> | undefined>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})), // media MCP (start 路径) — mock 缺这个 export 会全红, 2026-10-03 补
  query: vi.fn(
    ({
      prompt,
      options,
    }: {
      prompt: AsyncGenerator<unknown>;
      options: { env?: Record<string, string | undefined> };
    }) => {
      h.queryCalls.push(options.env);
      h.env = options.env;
      async function* stream() {
        const first = await prompt.next();
        h.firstMessage = first.value as { message: { content: unknown } };
        yield { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0, result: "ok" };
      }
      return stream();
    }
  ),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

// constants 的 CLAUDE_CONFIG_DIR 是 import 时从 env 定死的常量, 而 ORCHESTRATOR_HOME
// 要到 beforeEach 才指向 tmp 目录 -- 用 getter 覆盖成惰性求值, 其余导出原样透传.
vi.mock("../constants", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../constants")>();
  return {
    ...orig,
    get CLAUDE_CONFIG_DIR() {
      return path.join(process.env.ORCHESTRATOR_HOME || orig.ORCHESTRATOR_HOME, "claude-config");
    },
  };
});

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;
// @types/node 把它标 readonly, 测试要清掉必须绕一层。
const penv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-model-guide-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  delete penv.ANTHROPIC_MODEL;
  delete penv.ORCHESTRATOR_MODEL;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "model-guide@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "model-guide-test", ownerId: userId }).id;

  h.env = undefined;
  h.firstMessage = undefined;
  h.queryCalls = [];
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(model?: string): Task {
  const task = createTask({
    title: "model-guide",
    prompt: "干点活",
    project_id: projectId,
    cwd: tmpDir,
    ...(model ? { model } : {}),
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

const GUIDE_ABS = () => path.join(tmpDir, "claude-config", "docs", "model-guidance", "minimax-m3.md");

function plantGuidanceFile() {
  fs.mkdirSync(path.dirname(GUIDE_ABS()), { recursive: true });
  fs.writeFileSync(GUIDE_ABS(), "# MiniMax-M3 运行引导（测试桩）\n");
}

describe("模型感知 (ORCHESTRATOR_MODEL env)", () => {
  // 🔴 断言用 queryCalls[0] (主任务会话的 env), 不用 h.env —— h.env 被「最后一次
  //   query 调用」覆盖, 而 start() 成功后会触发 auto-rename / card-summary /
  //   self-report 等完工后置 query, 各自带自己的 env (2026-10-31 实证: 单测里
  //   主会话 env 正确, h.env 却是后置流的, 两个用例因此假红).
  it("resolved 模型注入 env", async () => {
    const task = makeTask("MiniMax-M3");
    await new ActiveSession(task).start(task);
    expect(h.queryCalls[0]!.ORCHESTRATOR_MODEL).toBe("MiniMax-M3");
  });

  it("没有模型时不注入(不出现空值键)", async () => {
    const task = makeTask();
    await new ActiveSession(task).start(task);
    expect(h.queryCalls[0]).not.toHaveProperty("ORCHESTRATOR_MODEL");
  });
});

describe("模型专属引导注入 (MiniMax)", () => {
  it("命中模型 + 文件存在 -> 首条 prompt 前拼指路 reminder", async () => {
    plantGuidanceFile();
    const task = makeTask("MiniMax-M3");
    await new ActiveSession(task).start(task);

    const content = h.firstMessage!.message.content as string;
    expect(content).toMatch(/^<system-reminder>/);
    expect(content).toContain(GUIDE_ABS());
    expect(content).toContain("MiniMax-M3");
    // 原任务 prompt 保留在 reminder 之后
    expect(content).toContain("干点活");
  });

  it("命中模型但文件不存在 -> 不注入, prompt 原样(不死指针)", async () => {
    const task = makeTask("MiniMax-M3");
    await new ActiveSession(task).start(task);
    const content = h.firstMessage!.message.content as string;
    // v518 (R222) 起首条 prompt 总带用户身份 reminder (owner 存在即注入),
    // 「prompt 原样」判据收紧为「不含模型引导指路」—— 死指针意图不变.
    expect(content).not.toContain(GUIDE_ABS());
    expect(content).not.toContain("已知弱点");
    expect(content).toContain("干点活");
  });

  it("未命中模型 -> 即使文件存在也不注入", async () => {
    plantGuidanceFile();
    const task = makeTask("claude-opus-5");
    await new ActiveSession(task).start(task);
    const content = h.firstMessage!.message.content as string;
    // v518 (R222) 起首条 prompt 总带用户身份 reminder (<system-reminder> 开头),
    // 「不注入」判据 = 不含模型引导指路, 不再断言 startsWith.
    expect(content).not.toContain(GUIDE_ABS());
    expect(content).not.toContain("已知弱点");
    expect(content).toContain("干点活");
    expect(h.queryCalls[0]!.ORCHESTRATOR_MODEL).toBe("claude-opus-5");
  });
});

// R56 复发 (damo 2026-10-31) 防删护栏: minimax-m3.md 红线 7 必须点名 canned STOP
// 文本 + 「不是叫停」处置. 历史: 同款红线曾是 R56 修复的 §8, 2026-09-15 bca31ac2
// 以「后续未再撞」为由删除 → 10-09/10-31 复发. 本测试 = 下次有人清理该文件时,
// 删红线会被测试拦住 (撞红了先读这条注释再动手, 别直接删断言).
describe("minimax-m3 红线 7 防删护栏 (canned STOP 误判)", () => {
  it("源文件必须点名 canned STOP 文本与「不是叫停整个任务」处置", () => {
    const src = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "docs",
      "claude-config",
      "docs",
      "model-guidance",
      "minimax-m3.md",
    );
    const md = fs.readFileSync(src, "utf-8");
    expect(md).toContain("STOP what you are doing");
    expect(md).toContain("The user doesn't want to proceed");
    expect(md).toContain("不是叫停整个任务");
  });
});
