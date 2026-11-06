// PATCH /api/user/me nickname + bio 集成测试 (v518, 飞书 R222).
//
// 覆盖:
//   1. 鉴权: 无 x-user-id → 401
//   2. 任一字段出现即触发: 俩字段一起写 / 只写一个另一保持现值
//   3. null / "" = 清空回落默认 (昵称→「用户」由 resolveUserProfile 兜, 这里验库值 NULL)
//   4. 校验: 昵称含换行 → 400; 类型错 → 400; bio 超 2000 → 400
//   5. GET /api/user/me 透出 nickname / bio (非秘密)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { GET as meGet, PATCH as mePatch } from "./route";
import { closeDb, getDb } from "@/lib/db";
import { resolveUserProfile } from "@/lib/db/users";

let tmpDir: string;
let userId: string;

function meRequest(body: unknown, userIdOverride?: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const uid = userIdOverride === undefined ? userId : userIdOverride;
  if (uid !== null) headers["x-user-id"] = uid;
  return new Request("http://localhost/api/user/me", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-profme-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`)
    .run(userId, "alice@example.com", "x");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PATCH /api/user/me 用户身份", () => {
  it("无 x-user-id → 401", async () => {
    const res = await mePatch(meRequest({ nickname: "x" }, null) as any);
    expect(res.status).toBe(401);
  });

  it("用户不存在 → 404", async () => {
    const res = await mePatch(meRequest({ nickname: "x" }, uuidv4()) as any);
    expect(res.status).toBe(404);
  });

  it("俩字段一起写 + 响应回 SafeUser", async () => {
    const res = await mePatch(
      meRequest({ nickname: "老王", bio: "偏好简洁" }) as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nickname).toBe("老王");
    expect(body.bio).toBe("偏好简洁");
  });

  it("只写 nickname, bio 保持现值", async () => {
    await mePatch(meRequest({ nickname: "老王", bio: "v1" }) as any);
    const res = await mePatch(meRequest({ nickname: "大王" }) as any);
    const body = await res.json();
    expect(body.nickname).toBe("大王");
    expect(body.bio).toBe("v1");
  });

  it('null / "" = 清空 (库值 NULL, 解析回落「用户」)', async () => {
    await mePatch(meRequest({ nickname: "老王", bio: "简介" }) as any);
    const res = await mePatch(meRequest({ nickname: null, bio: "" }) as any);
    const body = await res.json();
    expect(body.nickname).toBeNull();
    expect(body.bio).toBeNull();
    expect(resolveUserProfile(userId)).toEqual({ nickname: "用户", bio: null });
  });

  it("昵称含换行 → 400", async () => {
    const res = await mePatch(meRequest({ nickname: "两\n行" }) as any);
    expect(res.status).toBe(400);
  });

  it("昵称非字符串 → 400", async () => {
    const res = await mePatch(meRequest({ nickname: 123 }) as any);
    expect(res.status).toBe(400);
  });

  it("bio 超 2000 字符 → 400", async () => {
    const res = await mePatch(meRequest({ bio: "a".repeat(2001) }) as any);
    expect(res.status).toBe(400);
  });

  it("GET 透出 nickname / bio", async () => {
    await mePatch(meRequest({ nickname: "老王", bio: "简介" }) as any);
    const res = await meGet(
      new Request("http://localhost/api/user/me", {
        headers: { "x-user-id": userId },
      }) as any,
    );
    const body = await res.json();
    expect(body.nickname).toBe("老王");
    expect(body.bio).toBe("简介");
  });
});
