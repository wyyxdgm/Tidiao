// PATCH /api/projects/[id] 接 runners 字段的端到端测试.
// 关注点:
//   - valid runners JSON 数组 (含存在的 runner_id) -> 200, DB 落库
//   - runners: null -> 200, DB 列变 NULL (置空)
//   - 非数组 -> 400 + message
//   - runner_id 不存在 -> 400 + message
//   - command_patterns 超 32 条 -> 400 + message
//   - 缺必填字段 (purpose / cwd_mapping / runner_id) -> 400
//   - 不动 PATCH 透传到的其他字段 (回归 — 之前 updateProject 的更新链路没碰到)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject, getProjectById } from "@/lib/db/projects";
import { createRunner } from "@/lib/db/runners";
import { PATCH } from "./route";

let tmpDir: string;
let ownerId: string;
let projectId: string;
let runnerId: string;

async function patch(body: unknown) {
  const req = new NextRequest(`http://localhost/api/projects/${projectId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-user-id": ownerId,
      "x-user-role": "user",
    },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: projectId }) });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-proj-runners-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "p-runners", ownerId }).id;
  const out = createRunner({
    name: "r-proj",
    host: "rh",
    port: 9999,
    os_type: "linux",
  });
  runnerId = out.runner.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PATCH /api/projects/[id] — runners 字段", () => {
  it("正向: 单条 entry 真的落库", async () => {
    const { status, json } = await patch({
      runners: [
        {
          runner_id: runnerId,
          purpose: "build_macos",
          cwd_mapping: "/Users/user/workspace/agent-orchestrator-dev",
          command_patterns: ["cargo tauri build"],
        },
      ],
    });
    expect(status).toBe(200);
    expect(json.project.runners).toContain("build_macos");
    expect(json.project.runners).toContain("cargo tauri build");
    // DB 直读
    const p = getProjectById(projectId, ownerId)!;
    const arr = JSON.parse(p.runners!);
    expect(arr).toHaveLength(1);
    expect(arr[0].purpose).toBe("build_macos");
  });

  it("正向: null 显式置空", async () => {
    // 先设一条, 再清
    await patch({
      runners: [
        {
          runner_id: runnerId,
          purpose: "x",
          cwd_mapping: "/x",
          command_patterns: ["x"],
        },
      ],
    });
    expect(getProjectById(projectId, ownerId)!.runners).not.toBeNull();
    const { status } = await patch({ runners: null });
    expect(status).toBe(200);
    expect(getProjectById(projectId, ownerId)!.runners).toBeNull();
  });

  it("反向: runners 不是数组 -> 400", async () => {
    const { status, json } = await patch({ runners: "not array" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/runners/);
    // 没真写库
    expect(getProjectById(projectId, ownerId)!.runners).toBeNull();
  });

  it("反向: runner_id 不在 runners 表 -> 400", async () => {
    const { status, json } = await patch({
      runners: [
        {
          runner_id: "00000000-0000-0000-0000-000000000000",
          purpose: "x",
          cwd_mapping: "/x",
          command_patterns: ["x"],
        },
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/不存在的 runner_id/);
  });

  it("反向: command_patterns 超 32 条 -> 400", async () => {
    const patterns = Array.from({ length: 33 }, (_, i) => `cmd${i}`);
    const { status, json } = await patch({
      runners: [
        {
          runner_id: runnerId,
          purpose: "x",
          cwd_mapping: "/x",
          command_patterns: patterns,
        },
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/最多 32 条/);
  });

  it("反向: 缺 purpose -> 400", async () => {
    const { status, json } = await patch({
      runners: [
        {
          runner_id: runnerId,
          // 缺 purpose
          cwd_mapping: "/x",
          command_patterns: ["x"],
        } as unknown as Record<string, unknown>,
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/purpose/);
  });

  it("反向: 空 cwd_mapping -> 400 (必填, 否则平台 cwd 直接 exec 必失败)", async () => {
    const { status, json } = await patch({
      runners: [
        {
          runner_id: runnerId,
          purpose: "x",
          cwd_mapping: "   ",
          command_patterns: ["x"],
        },
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/cwd_mapping/);
  });

  it("回归: 不传 runners 字段名仍能改其它字段 (name)", async () => {
    const { status, json } = await patch({ name: "新名字" });
    expect(status).toBe(200);
    expect(json.project.name).toBe("新名字");
    // runners 列没被动
    expect(getProjectById(projectId, ownerId)!.runners).toBeNull();
  });

  it("回归: PATCH {} 不动 runners", async () => {
    await patch({
      runners: [
        {
          runner_id: runnerId,
          purpose: "x",
          cwd_mapping: "/x",
          command_patterns: ["x"],
        },
      ],
    });
    const before = getProjectById(projectId, ownerId)!.runners;
    const { status } = await patch({});
    expect(status).toBe(200);
    expect(getProjectById(projectId, ownerId)!.runners).toBe(before);
  });
});
