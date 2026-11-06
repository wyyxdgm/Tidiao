// /api/runners/[id]/heartbeat 测试.
// 关注点:
//   - 正确 token -> 200 + DB 状态 online + last_heartbeat_at 被更新
//   - 错 token -> 401 + error=token_mismatch, **不**动 DB
//   - 没 Authorization -> 401 + error=header_malformed
//   - Bearer 后面空 -> 401 + error=token_missing
//   - 不存在的 id + 任意 token -> 401 + error=token_mismatch
//     (与「token 错」同 body, 不泄漏 id 存在性; 2026-08-28 手测发现的
//      调试三件套缺口补齐 —— 401 body 必须是结构化错误类型, 见
//      docs/plans/runners.md「调试性约束」)
//   - decrypt 失败的 token (DB 列写坏) -> 401 + error=decrypt_failed
//     + markRunnerDead + console.warn
//   - 没经过 admin gating (midlleware bypass 的目的就是让这条路进得来)
//   - middleware bypass 也必须存在: 模拟 middleware 不注入 x-user-id,
//     这条路由仍然通过 (鉴权完全靠 bearer secret)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import {
  createRunner,
  getRunnerById,
  verifyRunnerToken,
  _readRunnerAuthColumns,
} from "@/lib/db/runners";
import { POST } from "./route";

let tmpDir: string;
let token: string;
let runnerId: string;

function heartbeat(tokenValue: string | null, id = runnerId) {
  const headers: Record<string, string> = {};
  if (tokenValue !== null) {
    headers.authorization = `Bearer ${tokenValue}`;
  }
  // 故意**不**设 x-user-id/x-user-role —— 这条路由走 middleware bypass.
  // 即使有这种环境(例如 CLI mock 场景, 验证路由真的公开可调用).
  const req = new NextRequest(`http://localhost/api/runners/${id}/heartbeat`, {
    method: "POST",
    headers,
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-hb-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  const out = createRunner({
    name: "hb-test",
    host: "hb-host",
    port: 1234,
    os_type: "linux",
  });
  runnerId = out.runner.id;
  token = out.token;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/runners/[id]/heartbeat", () => {
  it("🔴 正确 token -> 200 + status='online' + last_heartbeat_at 被设", async () => {
    const res = await heartbeat(token);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const after = getRunnerById(runnerId)!;
    expect(after.status).toBe("online");
    expect(after.last_heartbeat_at).not.toBeNull();
  });

  it("错 token -> 401 + token_mismatch, 不改 DB 状态", async () => {
    const res = await heartbeat(token + "0");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token_mismatch");
    const after = getRunnerById(runnerId)!;
    expect(after.status).toBe("offline");
    expect(after.last_heartbeat_at).toBeNull();
  });

  it("没 Authorization header -> 401 + token_missing", async () => {
    const res = await heartbeat(null);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token_missing");
  });

  it("Bearer 后面空 (HTTP 规范化剥掉尾随空格成 'Bearer') -> 401 + header_malformed", async () => {
    const res = await heartbeat("");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("header_malformed");
  });

  it("不存在的 runner id -> 401 + token_mismatch (与 token 错同 body)", async () => {
    const res = await heartbeat(token, uuidv4());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token_mismatch");
  });

  it("🔴 P5 e2e fix: heartbeat 路由 → in-memory registry 同步 (启动后才注册的 runner 也走 lazy-add)", async () => {
    // 模拟「平台启动后才注册这个 runner」: DB 有行但 registry Map 没有.
    // 第一次 heartbeat 后, routing 层就能看到 (listOnlineConnections).
    const { resetForTest, listOnlineConnections } = await import(
      "@/lib/runners/registry"
    );
    resetForTest();
    expect(
      listOnlineConnections().some((c) => c.runner.id === runnerId),
    ).toBe(false);

    const res = await heartbeat(token);
    expect(res.status).toBe(200);

    // 路由调了 recordHeartbeat → 内存 Map 同步 → listOnline 可见
    expect(
      listOnlineConnections().some((c) => c.runner.id === runnerId),
    ).toBe(true);
  });

  it("🟡 decrypt 失败 (auth 列被改坏) -> 401 + markRunnerDead + console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 把 tag 改成跟密文不匹配的 hex, 触发 GCM 认证失败 -> decrypt 抛 ->
      // verifyRunnerToken 内部 catch 后返 false. heartbeat route 不知道是
      // decrypt 错还是 token 错 (都是 false), 所以这里走另外路径: 我们让
      // verifyRunnerToken 本身抛, 触发外层 try/catch 里的 console.warn +
      // markRunnerDead (更罕见场景, 测一遍行为).
      const cols = _readRunnerAuthColumns(runnerId)!;
      getDb()
        .prepare(`UPDATE runners SET auth_token_encrypted = ? WHERE id = ?`)
        .run("not-hex", runnerId); // Buffer.from(x, 'hex') 对非 hex 字符抛
      const res = await heartbeat(token);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("decrypt_failed");
      const after = getRunnerById(runnerId)!;
      expect(after.status).toBe("dead");
      expect(warnSpy).toHaveBeenCalled();
      // sanity: verify 也认不出这个坏密文
      expect(verifyRunnerToken(runnerId, token)).toBe(false);
      // cols 没用上, 加个引用避免 lint 抱怨
      void cols;
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("正确 token 路径不调 markRunnerDead", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await heartbeat(token);
      expect(res.status).toBe(200);
      const after = getRunnerById(runnerId)!;
      expect(after.status).toBe("online");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
