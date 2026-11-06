/**
 * 任务派发时的飞书 sheet 绑定注入.
 *
 * 背景(2026-08-16 task 75d4f0ad): 用户 prompt 说「飞书 E2」, 期望是任务所属
 * project/version 绑定的那张表, 但平台没把绑定传下去, agent 只能自己猜 -- 拿
 * feishu.sh 当时的硬编码默认表读了**别的项目**的 1.6期 表, 静默错表.
 *
 * 修法: buildEnv() 按 task.version_id(缺省 project.current_version_id) 解析
 * 绑定, 注入 FEISHU_SHEET_URL / FEISHU_SHEET_NAME(feishu.sh 原生读这俩 env)。
 * 断言: 绑定了就注入; 没绑定(或只绑 URL 没绑 sheet 名)时, 平台进程 env 里
 * 残留的 FEISHU_* 也不许泄漏下去 -- 泄漏同样是静默错表.
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
  createSdkMcpServer: vi.fn(() => ({})), // media MCP (start 路径) — mock 缺这个 export 会全红, 2026-10-03 补
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
import { createVersion } from "../db/versions";
import { createTask, getTaskById } from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-feishu-env-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "feishu-env@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "feishu-env-test", ownerId: userId }).id;

  h.env = undefined;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.FEISHU_SHEET_URL;
  delete process.env.FEISHU_SHEET_NAME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(versionId?: string): Task {
  const task = createTask({
    title: "feishu-env",
    prompt: "noop",
    project_id: projectId,
    cwd: tmpDir,
    ...(versionId ? { version_id: versionId } : {}),
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

describe("飞书 sheet 绑定注入 (task env)", () => {
  it("project 的 current version 绑了表 -> 注入 URL + sheet 名", async () => {
    // createVersion 会把首个版本自动设为 project 的 current (类比 HEAD)
    createVersion({
      project_id: projectId,
      name: "v1.0",
      feishu_url: "https://my.feishu.cn/wiki/BOUND_DOC",
      feishu_sheet: "AO-DEV",
    });

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.FEISHU_SHEET_URL).toBe("https://my.feishu.cn/wiki/BOUND_DOC");
    expect(h.env!.FEISHU_SHEET_NAME).toBe("AO-DEV");
  });

  it("task 显式带 version_id -> 以 task 的为准", async () => {
    const bound = createVersion({
      project_id: projectId,
      name: "v1.0",
      feishu_url: "https://my.feishu.cn/wiki/BOUND_DOC",
      feishu_sheet: "AO-DEV",
    });
    const unbound = createVersion({ project_id: projectId, name: "v2.0-manual", sync_strategy: "manual" });

    const t1 = makeTask(unbound.id);
    await new ActiveSession(t1).start(t1);

    expect(h.env).not.toHaveProperty("FEISHU_SHEET_URL");
    expect(h.env).not.toHaveProperty("FEISHU_SHEET_NAME");
    // sanity: 同一 task 若指向绑定的 version, 是能注入的
    const t2 = makeTask(bound.id);
    await new ActiveSession(t2).start(t2);
    expect(h.env!.FEISHU_SHEET_URL).toBe("https://my.feishu.cn/wiki/BOUND_DOC");
  });

  it("version 只绑 URL 没绑 sheet 名 -> 只注入 URL, 不注入 NAME", async () => {
    createVersion({
      project_id: projectId,
      name: "v1.0",
      feishu_url: "https://my.feishu.cn/wiki/BOUND_DOC",
      // feishu_sheet 不传 -> DB 列默认 'Sheet2'? 不: createVersion 写 null
    });

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env!.FEISHU_SHEET_URL).toBe("https://my.feishu.cn/wiki/BOUND_DOC");
    expect(h.env).not.toHaveProperty("FEISHU_SHEET_NAME");
  });

  it("没绑表时, 平台 env 残留的 FEISHU_* 不许泄漏下去", async () => {
    process.env.FEISHU_SHEET_URL = "https://my.feishu.cn/wiki/STALE_DOC";
    process.env.FEISHU_SHEET_NAME = "STALE_SHEET";
    createVersion({ project_id: projectId, name: "v1.0-manual", sync_strategy: "manual" });

    const task = makeTask();
    await new ActiveSession(task).start(task);

    expect(h.env).not.toHaveProperty("FEISHU_SHEET_URL");
    expect(h.env).not.toHaveProperty("FEISHU_SHEET_NAME");
  });
});
