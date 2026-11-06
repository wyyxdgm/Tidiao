// Config snapshot CRUD + v52 (llm_config_id) round-trip 回归测试.
// 关注点: 用 ORCHESTRATOR_DB_PATH 指向临时库, 与生产库隔开; 不污染真实数据.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";

let tmpDir: string;
let testUserId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-snap-cfg-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  closeDb();
  getDb(); // 跑全部 migrations (含 v52) 到临时库
  testUserId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(testUserId, `${testUserId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config_snapshots llm_config_id (v52)", () => {
  it("createConfigSnapshot: 写入并读回 llm_config_id", async () => {
    const { createConfigSnapshot, getConfigSnapshotById } = await import("./config-snapshots");
    const llmId = uuidv4();
    const snap = createConfigSnapshot({
      name: "with-llm",
      scope: "global",
      llmConfigId: llmId,
      ownerId: testUserId,
    });
    expect(snap.llm_config_id).toBe(llmId);

    const readBack = getConfigSnapshotById(snap.id, testUserId)!;
    expect(readBack.llm_config_id).toBe(llmId);
  });

  it("createConfigSnapshot: 不传 llm_config_id 默认 NULL (向后兼容)", async () => {
    const { createConfigSnapshot, getConfigSnapshotById } = await import("./config-snapshots");
    const snap = createConfigSnapshot({
      name: "legacy",
      scope: "global",
      ownerId: testUserId,
    });
    expect(snap.llm_config_id).toBeNull();

    const readBack = getConfigSnapshotById(snap.id, testUserId)!;
    expect(readBack.llm_config_id).toBeNull();
  });

  it("updateConfigSnapshot: 改 llm_config_id 与清空 (undefined -> 保留; 空串 -> NULL)", async () => {
    const { createConfigSnapshot, updateConfigSnapshot, getConfigSnapshotById } = await import("./config-snapshots");
    const oldId = uuidv4();
    const newId = uuidv4();
    const snap = createConfigSnapshot({
      name: "swap",
      scope: "global",
      llmConfigId: oldId,
      ownerId: testUserId,
    });
    expect(snap.llm_config_id).toBe(oldId);

    // 改到另一个 id
    const updated = updateConfigSnapshot(
      snap.id,
      { name: "swap", scope: "global", llmConfigId: newId },
      testUserId
    );
    expect(updated?.llm_config_id).toBe(newId);

    // 再清空 (传空串 -> NULL, 与 model 等其它列规则一致)
    const cleared = updateConfigSnapshot(
      snap.id,
      { name: "swap", scope: "global", llmConfigId: "" },
      testUserId
    );
    expect(cleared?.llm_config_id).toBeNull();

    // 读回也对
    const readBack = getConfigSnapshotById(snap.id, testUserId)!;
    expect(readBack.llm_config_id).toBeNull();
  });
});
