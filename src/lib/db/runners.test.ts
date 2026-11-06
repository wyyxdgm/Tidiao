// src/lib/db/runners.ts 的真 SQLite 测试.
// 模式参考 src/lib/db/schedule-update-fields.test.ts: tmpdir + 关/开 DB +
// 直接 insert users 表来搭最小环境. 这一层只测 DB 模块, 路由层在
// route.test.ts 里另外走 NextRequest 入口.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db/index";
import {
  createRunner,
  getRunnerById,
  listRunners,
  deleteRunner,
  updateRunnerHeartbeat,
  markRunnerDead,
  updateRunnerHealth,
  verifyRunnerToken,
  isRunnerDecryptable,
  _readRunnerAuthColumns,
  OS_TYPES,
} from "@/lib/db/runners";

let tmpDir: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runners-db-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex, 锁定测试用密钥
  closeDb();
  getDb();
  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createRunner + getRunnerById", () => {
  it("创建返回 (runner, token) — token 64-hex 明文", () => {
    const { runner, token } = createRunner({
      name: "mac-build",
      host: "192.168.3.243",
      port: 8081,
      os_type: "macos",
      ownerId,
    });
    expect(runner.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(runner.owner_id).toBe(ownerId);
    expect(runner.host).toBe("192.168.3.243");
    expect(runner.port).toBe(8081);
    expect(runner.os_type).toBe("macos");
    expect(runner.status).toBe("offline");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GET 接口不返回 auth 列 (不暴露密文更不暴露明文)", () => {
    const { runner, token } = createRunner({
      name: "r1", host: "h1", port: 1, os_type: "linux", ownerId,
    });
    const fetched = getRunnerById(runner.id)!;
    expect(fetched).toBeTruthy();
    // auth_token_encrypted/iv/tag 与 plaintext 都不会进 Runner 接口
    expect(Object.keys(fetched)).not.toContain("auth_token_encrypted");
    expect(Object.keys(fetched)).not.toContain("auth_token");
    expect(Object.keys(fetched)).not.toContain("token");
  });

  it("owner 隔离: 别的 user 取不到该 row", () => {
    const { runner } = createRunner({
      name: "r", host: "h", port: 1, os_type: "linux", ownerId,
    });
    const otherUser = uuidv4();
    expect(getRunnerById(runner.id, otherUser)).toBeNull();
    expect(getRunnerById(runner.id)).not.toBeNull();
  });

  it("UNIQUE (host, port): 重复注册在 DB 层抛错, 由 route 层转 409", () => {
    createRunner({ name: "a", host: "h", port: 8080, os_type: "linux", ownerId });
    expect(() =>
      createRunner({ name: "b", host: "h", port: 8080, os_type: "linux", ownerId })
    ).toThrow(/UNIQUE/i);
  });

  it("不支持的 os_type 在 DB 层被 CHECK 拒掉", () => {
    // better-sqlite3 准备语句时不会校验 CHECK; 只有 execute 才校验.
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO runners (id, name, host, port, os_type,
           auth_token_encrypted, auth_token_iv, auth_token_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(uuidv4(), "x", "x", 1, "freebsd", "e", "i", "t")
    ).toThrow(/CHECK/i);
  });

  it("非法 status 在 DB 层被 CHECK 拒掉", () => {
    const { runner } = createRunner({
      name: "ck", host: "ckhost", port: 7, os_type: "linux", ownerId,
    });
    // SQLite 不在 UPDATE 时校验无关列, 但 CHECK 是列级约束, status 是新值就重跑.
    expect(() =>
      getDb()
        .prepare(`UPDATE runners SET status = ? WHERE id = ?`)
        .run("weird", runner.id)
    ).toThrow(/CHECK/i);
  });

  it("ownerId 不传 → owner_id 是 NULL (legacy / admin 注册路径)", () => {
    const { runner } = createRunner({
      name: "orphan", host: "h", port: 2, os_type: "windows",
    });
    expect(runner.owner_id).toBeNull();
  });

  it("OS_TYPES 覆盖三个值", () => {
    expect(OS_TYPES).toEqual(["macos", "windows", "linux"]);
  });
});

describe("listRunners + deleteRunner", () => {
  it("listRunners 默认按 created_at DESC", () => {
    // datetime('now') 是秒精度, 同秒插入的 row 之间次序不定义.
    // sleep 1.1s 越过边界, 让 created_at 真正能区分.
    const a = createRunner({ name: "a", host: "ha", port: 1, os_type: "macos", ownerId });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return wait(1100).then(() => {
      const b = createRunner({ name: "b", host: "hb", port: 2, os_type: "linux", ownerId });
      const list = listRunners(ownerId);
      expect(list.map((r) => r.id)).toEqual([b.runner.id, a.runner.id]);
    });
  });

  it("listRunners 不传 userId → admin 看全部", () => {
    createRunner({ name: "owned", host: "h1", port: 1, os_type: "linux", ownerId });
    createRunner({ name: "global", host: "h2", port: 2, os_type: "linux" });
    expect(listRunners()).toHaveLength(2);
    expect(listRunners(ownerId)).toHaveLength(1);
  });

  it("deleteRunner 返回 boolean, 删除后 get 不到", () => {
    const { runner } = createRunner({
      name: "d", host: "h", port: 1, os_type: "linux", ownerId,
    });
    expect(deleteRunner(runner.id)).toBe(true);
    expect(getRunnerById(runner.id)).toBeNull();
    expect(deleteRunner(runner.id)).toBe(false);
  });
});

describe("heartbeat / dead / health", () => {
  it("updateRunnerHeartbeat → status='online' + last_heartbeat_at 被设", () => {
    const { runner } = createRunner({
      name: "h", host: "h", port: 1, os_type: "linux", ownerId,
    });
    expect(runner.status).toBe("offline");
    expect(runner.last_heartbeat_at).toBeNull();
    updateRunnerHeartbeat(runner.id);
    const after = getRunnerById(runner.id, ownerId)!;
    expect(after.status).toBe("online");
    expect(after.last_heartbeat_at).not.toBeNull();
  });

  it("markRunnerDead → status='dead'", () => {
    const { runner } = createRunner({
      name: "h", host: "h", port: 2, os_type: "linux", ownerId,
    });
    updateRunnerHeartbeat(runner.id);
    markRunnerDead(runner.id);
    expect(getRunnerById(runner.id, ownerId)!.status).toBe("dead");
  });

  it("updateRunnerHealth 落 JSON 字符串 (不解析, 留给上层)", () => {
    const { runner } = createRunner({
      name: "h", host: "h", port: 3, os_type: "linux", ownerId,
    });
    updateRunnerHealth(runner.id, '{"os":"darwin","uptime_s":42}');
    expect(getRunnerById(runner.id, ownerId)!.last_health_json).toBe(
      '{"os":"darwin","uptime_s":42}'
    );
  });
});

describe("verifyRunnerToken", () => {
  it("正确 token 返回 true", () => {
    const { runner, token } = createRunner({
      name: "v", host: "h", port: 1, os_type: "linux", ownerId,
    });
    expect(verifyRunnerToken(runner.id, token)).toBe(true);
  });
  it("verifyRunnerToken 永远不抛 (DB 层契约)", () => {
    // sanity: 不管 row 缺 / 列坏 / 长度错 / 字节不等, 调用 verifyRunnerToken
    // 都只该返回 false. 任何 throw 都是契约违反, 这里守住底线.
    expect(() => verifyRunnerToken("nope", "x")).not.toThrow();
    const { runner, token } = createRunner({
      name: "v", host: "h2", port: 9999, os_type: "linux", ownerId,
    });
    getDb()
      .prepare(`UPDATE runners SET auth_token_iv = ? WHERE id = ?`)
      .run("not-hex", runner.id);
    expect(() => verifyRunnerToken(runner.id, token)).not.toThrow();
  });

  it("错 token 返回 false, 不抛", () => {
    const { runner, token } = createRunner({
      name: "v", host: "h", port: 2, os_type: "linux", ownerId,
    });
    expect(verifyRunnerToken(runner.id, token + "x")).toBe(false);
    expect(verifyRunnerToken(runner.id, "")).toBe(false);
    expect(verifyRunnerToken(runner.id, token.slice(0, -1) + "0")).toBe(false);
  });

  it("不存在的 runner id 返回 false", () => {
    expect(verifyRunnerToken(uuidv4(), "anything")).toBe(false);
  });

  it("DB 里手工写坏的密文 (tag 错) → verify 返回 false, 不抛 (heartbeat handler 走 401 + warn)", () => {
    const { runner, token } = createRunner({
      name: "v", host: "h", port: 4, os_type: "linux", ownerId,
    });
    const cols = _readRunnerAuthColumns(runner.id)!;
    // 把 tag 整段写坏 (仍然是合法 hex 但跟密文不匹配); decrypt 会抛鉴权失败
    getDb()
      .prepare(`UPDATE runners SET auth_token_tag = ? WHERE id = ?`)
      .run("00".repeat(16), runner.id);
    expect(verifyRunnerToken(runner.id, token)).toBe(false);
  });

  it("DB 里 iv 写成非 hex → decrypt 抛, verify 吞掉 + 返回 false", () => {
    const { runner, token } = createRunner({
      name: "v", host: "h", port: 5, os_type: "linux", ownerId,
    });
    getDb()
      .prepare(`UPDATE runners SET auth_token_iv = ? WHERE id = ?`)
      .run("not-hex", runner.id);
    expect(verifyRunnerToken(runner.id, token)).toBe(false);
  });

  it("长度不同一律 false (即使 hex 看起来对得上也不比)", () => {
    const { runner } = createRunner({
      name: "v", host: "h", port: 6, os_type: "linux", ownerId,
    });
    expect(verifyRunnerToken(runner.id, "a".repeat(63))).toBe(false); // 一字节短
    expect(verifyRunnerToken(runner.id, "a".repeat(65))).toBe(false); // 一字节长
  });
});

describe("isRunnerDecryptable", () => {
  it("健康 runner -> true", () => {
    const { runner } = createRunner({
      name: "dec", host: "dec-h", port: 1, os_type: "linux", ownerId,
    });
    expect(isRunnerDecryptable(runner.id)).toBe(true);
  });

  it("不存在的 id -> false (跟 verify_runner_token 一样)", () => {
    expect(isRunnerDecryptable(uuidv4())).toBe(false);
  });

  it("auth 列被改坏 -> false (decrypt 抛被内部 catch)", () => {
    const { runner } = createRunner({
      name: "dec2", host: "dec-h2", port: 2, os_type: "linux", ownerId,
    });
    getDb()
      .prepare(`UPDATE runners SET auth_token_iv = ? WHERE id = ?`)
      .run("not-hex", runner.id);
    expect(isRunnerDecryptable(runner.id)).toBe(false);
  });

  it("调用从不抛", () => {
    expect(() => isRunnerDecryptable("missing")).not.toThrow();
  });
});

describe("end-to-end: 创建 → 心跳 → 验证 → 标死", () => {
  it("happy path", () => {
    const { runner, token } = createRunner({
      name: "e2e", host: "h", port: 99, os_type: "macos", ownerId,
    });
    expect(verifyRunnerToken(runner.id, token)).toBe(true);
    updateRunnerHeartbeat(runner.id);
    expect(getRunnerById(runner.id, ownerId)!.status).toBe("online");
    markRunnerDead(runner.id);
    expect(getRunnerById(runner.id, ownerId)!.status).toBe("dead");
    // verify 在 dead 状态下仍然过 (verify 只看密文, 跟 status 无关)
    expect(verifyRunnerToken(runner.id, token)).toBe(true);
    deleteRunner(runner.id);
    expect(verifyRunnerToken(runner.id, token)).toBe(false);
  });
});
