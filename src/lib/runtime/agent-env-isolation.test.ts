/**
 * agent 子进程 env 隔离.
 *
 * SDK 的 `env` 选项**整体替换** process.env(sdk.mjs: `env:c={...process.env}` 是
 * 解构默认值), 所以 buildEnv() 返回什么, agent 子进程就只有什么。平台自身由 pm2 以
 * NODE_ENV=production + PORT 启动, 这几个值泄漏下去都是静默事故:
 *   - NODE_ENV=production -> npm 的 `omit` 默认值变成 `dev`, agent 跑
 *     `npm install <pkg>` 静默裁掉 devDependencies (已实测踩过)
 *   - PORT -> agent 起的 dev server 绑到平台端口
 *
 * 断言: 黑名单一个都不许出现, 白名单(任务身份 + 隔离 config dir)必须在。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: 只抓 options.env, 然后立刻 result 收尾。
const h = vi.hoisted(() => ({ env: undefined as Record<string, string | undefined> | undefined }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  // createSdkMcpServer: ActiveSession.start 会建 media MCP server (sdk-tools.ts),
  // mock 里缺这个 export 会让所有用例炸在 start 路径上 (HEAD 上本文件已红,
  // 2026-10-03 补). 返回空对象即可 —— 本文件只断言 env, 不碰 MCP.
  createSdkMcpServer: vi.fn(() => ({})),
  query: vi.fn(
    ({
      prompt,
      options,
    }: {
      prompt: AsyncGenerator<unknown>;
      options: { env?: Record<string, string | undefined> };
    }) => {
      h.env = options.env;
      async function* stream() {
        await prompt.next();
        yield { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0, result: "ok" };
      }
      return stream();
    }
  ),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";
import { upsertMediaKey, getMediaKey } from "../db/media-keys";
import { decrypt } from "../crypto";
import { ORCHESTRATOR_HOME } from "../constants";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;
let savedNodeEnv: string | undefined;
// @types/node 把 NODE_ENV 标成 readonly, 测试要改它必须绕一层。
const penv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-env-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "env-test@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "env-test", ownerId: userId }).id;

  h.env = undefined;
});

afterEach(() => {
  closeDb();
  if (savedNodeEnv === undefined) delete penv.NODE_ENV;
  else penv.NODE_ENV = savedNodeEnv;
  delete process.env.PORT;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(): Task {
  const task = createTask({
    title: "env-isolation",
    prompt: "noop",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

describe("agent 子进程 env 隔离", () => {
  it("平台自身的 NODE_ENV / PORT / NEXT_PUBLIC_APP_URL 不泄漏下去", async () => {
    penv.NODE_ENV = "production";
    process.env.PORT = "13000";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:13000";

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env).toBeDefined();
    expect(h.env).not.toHaveProperty("NODE_ENV");
    expect(h.env).not.toHaveProperty("PORT");
    expect(h.env).not.toHaveProperty("NEXT_PUBLIC_APP_URL");
  });

  it("任务身份与隔离 config dir 照常注入", async () => {
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.ORCHESTRATOR_TASK_ID).toBe(task.id);
    expect(h.env!.ORCHESTRATOR_PROJECT_ID).toBe(projectId);
    expect(h.env!.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(h.env!.ANTHROPIC_API_KEY).toBe("sk-test-key");
  });

  // ---- minimax mmx-cli 多模态 key 注入 (v48 user_media_keys) ----

  it("用户配了 mmx key → 注入 MINIMAX_API_KEY + MMX_CONFIG_DIR + MINIMAX_REGION", async () => {
    upsertMediaKey(userId, { api_key: "sk-mmx-test-key", region: "global" });
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.MINIMAX_API_KEY).toBe("sk-mmx-test-key");
    expect(h.env!.MMX_CONFIG_DIR).toBe(path.join(ORCHESTRATOR_HOME, "users", userId, ".mmx"));
    expect(h.env!.MINIMAX_REGION).toBe("global");
  });

  it("用户没配 mmx key → 三个 env 都被 delete (无 key 不注入, 防平台残留泄漏)", async () => {
    // 模拟平台进程残留同名 env
    process.env.MINIMAX_API_KEY = "platform-leaked-key";
    process.env.MMX_CONFIG_DIR = "/root/.mmx";
    process.env.MINIMAX_REGION = "cn";

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env).not.toHaveProperty("MINIMAX_API_KEY");
    expect(h.env).not.toHaveProperty("MMX_CONFIG_DIR");
    expect(h.env).not.toHaveProperty("MINIMAX_REGION");
  });

  it("解密失败 (ENCRYPTION_KEY 漂移) → 不注入 env, 不抛错", async () => {
    upsertMediaKey(userId, { api_key: "sk-test", region: "cn" });
    // 模拟 ENCRYPTION_KEY 漂移: 直接 UPDATE 把 iv 改成非法 hex
    getDb()
      .prepare(`UPDATE user_media_keys SET api_key_iv = 'deadbeef' WHERE user_id = ?`)
      .run(userId);

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env).not.toHaveProperty("MINIMAX_API_KEY");
    expect(h.env).not.toHaveProperty("MMX_CONFIG_DIR");
    expect(h.env).not.toHaveProperty("MINIMAX_REGION");
  });

  it("未配 region → MINIMAX_REGION 不注入 (mmx 用 cli 默认 cn), key + dir 照常", async () => {
    upsertMediaKey(userId, { api_key: "sk-no-region", region: null });
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.MINIMAX_API_KEY).toBe("sk-no-region");
    expect(h.env!.MMX_CONFIG_DIR).toBe(path.join(ORCHESTRATOR_HOME, "users", userId, ".mmx"));
    expect(h.env).not.toHaveProperty("MINIMAX_REGION");
  });

  // ---- 账号级 git 提交身份注入 (v515, 飞书 R178) ----
  // beforeEach 里 seed 的用户 email = env-test@example.com → 默认前缀 env-test.

  it("未配置 → 注入默认身份: author/committer = 邮箱前缀 + 账号邮箱", async () => {
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.GIT_AUTHOR_NAME).toBe("env-test");
    expect(h.env!.GIT_AUTHOR_EMAIL).toBe("env-test@example.com");
    expect(h.env!.GIT_COMMITTER_NAME).toBe("env-test");
    expect(h.env!.GIT_COMMITTER_EMAIL).toBe("env-test@example.com");
  });

  it("显式配置 → 覆盖默认 (name + email 都生效)", async () => {
    getDb()
      .prepare(`UPDATE users SET git_name = ?, git_email = ? WHERE id = ?`)
      .run("Alice Coder", "alice@corp.com", userId);
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.GIT_AUTHOR_NAME).toBe("Alice Coder");
    expect(h.env!.GIT_AUTHOR_EMAIL).toBe("alice@corp.com");
    expect(h.env!.GIT_COMMITTER_NAME).toBe("Alice Coder");
    expect(h.env!.GIT_COMMITTER_EMAIL).toBe("alice@corp.com");
  });

  it("平台进程残留的 GIT_* env 被覆盖, 不泄漏", async () => {
    // 模拟平台进程残留 (CI / 脚本环境常见)
    process.env.GIT_AUTHOR_NAME = "platform-leaked";
    process.env.GIT_AUTHOR_EMAIL = "leak@platform";
    process.env.GIT_COMMITTER_NAME = "platform-leaked";
    process.env.GIT_COMMITTER_EMAIL = "leak@platform";

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.GIT_AUTHOR_NAME).toBe("env-test");
    expect(h.env!.GIT_AUTHOR_EMAIL).toBe("env-test@example.com");
    expect(h.env!.GIT_COMMITTER_NAME).toBe("env-test");
    expect(h.env!.GIT_COMMITTER_EMAIL).toBe("env-test@example.com");
  });

  it("decrypt 真能解 (sanity)", () => {
    upsertMediaKey(userId, { api_key: "sk-sanity-check", region: "cn" });
    const row = getMediaKey(userId)!;
    const plaintext = decrypt(row.api_key_encrypted!, row.api_key_iv!, row.api_key_tag!);
    expect(plaintext).toBe("sk-sanity-check");
  });

  // ---- AO_TOKEN 自动注入 (v52): agent 免手动 login.sh ----

  it("注入 AO_TOKEN, 以「switch-account」命名的 api_tokens 行存在 → 返回对应 jwt", async () => {
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.AO_TOKEN).toMatch(/^ao_/);
    // 校验 api_tokens 里有「switch-account」行
    const row = getDb()
      .prepare(`SELECT * FROM api_tokens WHERE user_id = ? AND name = ?`)
      .get(userId, "switch-account") as { id: string } | undefined;
    expect(row).toBeDefined();
  });

  it("重复 start() 复用同一 token (不会越攒越多 api_tokens 行)", async () => {
    const task = makeTask();
    await new ActiveSession(task).start(task);
    const firstToken = h.env!.AO_TOKEN;

    await new ActiveSession(task).start(task);
    const secondToken = h.env!.AO_TOKEN;

    expect(secondToken).toBe(firstToken);
    const rows = getDb()
      .prepare(`SELECT COUNT(*) as n FROM api_tokens WHERE user_id = ? AND name = ?`)
      .get(userId, "switch-account") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("平台进程 env 残留 AO_TOKEN → 仍按本账号覆盖注入 (不会被残留值静默透传)", async () => {
    process.env.AO_TOKEN = "ao_LEAKED_FROM_PLATFORM_PROCESS";
    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.AO_TOKEN).not.toBe("ao_LEAKED_FROM_PLATFORM_PROCESS");
    expect(h.env!.AO_TOKEN).toMatch(/^ao_/);
  });

  it("跨 user 隔离: 另一个 user 的 task 不会拿到本 user 的 token", async () => {
    const otherUserId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(otherUserId, "other@example.com", "x", "user");
    upsertLlmConfig("user", otherUserId, { api_key: "sk-other-key" });
    const otherProjectId = createProject({ name: "env-test-2", ownerId: otherUserId }).id;
    const otherTask = createTask({
      title: "other-env-isolation",
      prompt: "noop",
      project_id: otherProjectId,
      cwd: tmpDir,
    });
    getDb()
      .prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`)
      .run(otherUserId, otherTask.id);
    const freshOther = getTaskById(otherTask.id)!;

    // 先跑本 user 的 task 让 userId 有 switch-account 行
    const myTask = makeTask();
    await new ActiveSession(myTask).start(myTask);
    const myToken = h.env!.AO_TOKEN;

    // 再跑 other user 的 task
    await new ActiveSession(freshOther).start(freshOther);
    const otherToken = h.env!.AO_TOKEN;

    expect(myToken).toMatch(/^ao_/);
    expect(otherToken).toMatch(/^ao_/);
    expect(myToken).not.toBe(otherToken);

    const myRow = getDb()
      .prepare(`SELECT id FROM api_tokens WHERE user_id = ? AND name = ?`)
      .get(userId, "switch-account") as { id: string } | undefined;
    const otherRow = getDb()
      .prepare(`SELECT id FROM api_tokens WHERE user_id = ? AND name = ?`)
      .get(otherUserId, "switch-account") as { id: string } | undefined;
    expect(myRow?.id).toBeDefined();
    expect(otherRow?.id).toBeDefined();
    expect(myRow!.id).not.toBe(otherRow!.id);
  });
});
