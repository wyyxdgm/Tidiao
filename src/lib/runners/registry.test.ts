// R3 registry 单元测试.
//
// 关注点:
//   - recordHeartbeat 已知 runner → 刷 lastSeen + status='online'
//   - recordHeartbeat 未知 runner (启动后才注册的, 不在 Map) → lazy-add
//     (从 DB 读 + decrypt + 放进 Map) + 刷 lastSeen/status. 这是 P5 e2e 修
//     复点: 修前 heartbeat 路由不调 recordHeartbeat, Map 永远没有新 runner.
//   - recordHeartbeat 行不存在 / decrypt 失败 → 静默 no-op, Map 不动
//   - loadRunnersFromDb 已存在测试已覆盖, 这里只补 recordHeartbeat lazy-add
//     (回归用例: 启动后注册的 runner 第一次心跳后即可被 listOnlineConnections
//      看到)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db/index";
import { createRunner } from "@/lib/db/runners";
import {
  loadRunnersFromDb,
  recordHeartbeat,
  listOnlineConnections,
  _listAllConnections,
  resetForTest,
} from "./registry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-registry-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  resetForTest();
});

afterEach(() => {
  resetForTest();
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSyncSync?.(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordHeartbeat — 已知 runner (启动时已 load)", () => {
  it("刷 lastSeen + status='online'", () => {
    const { runner } = createRunner({
      name: "known",
      host: "h",
      port: 1,
      os_type: "linux",
    });
    loadRunnersFromDb();
    // 先把 status 标成 offline (模拟 stale)
    const conn = _listAllConnections().find((c) => c.runner.id === runner.id)!;
    conn.status = "offline";
    conn.lastSeenAtMs = 1;

    recordHeartbeat(runner.id, 1234);

    expect(conn.status).toBe("online");
    expect(conn.lastSeenAtMs).toBe(1234);
    expect(listOnlineConnections().some((c) => c.runner.id === runner.id)).toBe(true);
  });
});

describe("recordHeartbeat — 未知 runner (启动后才注册) [P5 e2e fix]", () => {
  it("lazy-add: 从 DB 读 + decrypt + 放进 Map, status=online", () => {
    // 平台启动时 Map 为空 (resetForTest + 不调 loadRunnersFromDb).
    // 然后 admin POST /api/runners 创建一个 runner (DB 有了, Map 还没有).
    const { runner } = createRunner({
      name: "post-startup",
      host: "192.168.3.243",
      port: 8081,
      os_type: "macos",
    });
    // 模拟启动后 DB 有 row 但 Map 没有 (这是 P5 e2e 原状).
    expect(_listAllConnections().some((c) => c.runner.id === runner.id)).toBe(false);

    recordHeartbeat(runner.id, Date.now());

    // 第一次心跳后 lazy-add: Map 有了 + status=online + token 解密成功.
    const conn = _listAllConnections().find((c) => c.runner.id === runner.id);
    expect(conn).toBeDefined();
    expect(conn!.status).toBe("online");
    expect(conn!.authToken).toMatch(/^[0-9a-f]{64}$/); // createRunner 生成的 64-hex
    expect(conn!.runner.host).toBe("192.168.3.243");
    expect(conn!.runner.port).toBe(8081);
    // routing 层可见
    expect(listOnlineConnections().some((c) => c.runner.id === runner.id)).toBe(true);
  });

  it("行不存在 → 静默 no-op, Map 不动", () => {
    const fakeId = uuidv4();
    recordHeartbeat(fakeId, Date.now());
    expect(_listAllConnections()).toHaveLength(0);
  });
});
