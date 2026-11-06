// PATCH /api/user/me git_name + git_email 集成测试 (v515, 飞书 R178).
//
// 覆盖:
//   1. 鉴权: 无 x-user-id → 401
//   2. 任一字段出现即触发: 俩字段一起写 / 只写一个另一保持现值
//   3. null / "" = 清空回落默认
//   4. 校验: name 含 < > 换行 → 400; email 格式错 → 400
//   5. email 撞其他账号注册邮箱 → 409 (防冒名); 撞自己的 → 放行 (清空重写自己邮箱)
//   6. GET /api/user/me 透出 git_name / git_email (非秘密)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { GET as meGet, PATCH as mePatch } from "./route";
import { closeDb, getDb } from "@/lib/db";
import { resolveGitIdentity } from "@/lib/db/users";

let tmpDir: string;
let userId: string;
let otherUserId: string;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-gitme-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`)
    .run(userId, "alice@example.com", "x");
  otherUserId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`)
    .run(otherUserId, "bob@example.com", "x");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PATCH /api/user/me git 身份", () => {
  it("无 x-user-id → 401", async () => {
    const res = await mePatch(meRequest({ git_name: "x" }, null) as any);
    expect(res.status).toBe(401);
  });

  it("俩字段一次写 + resolve 生效", async () => {
    const res = await mePatch(meRequest({ git_name: "Alice Coder", git_email: "alice@corp.com" }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git_name).toBe("Alice Coder");
    expect(body.git_email).toBe("alice@corp.com");
    expect(resolveGitIdentity(userId)).toEqual({
      name: "Alice Coder",
      email: "alice@corp.com",
    });
  });

  it("只传 git_name → git_email 保持现值 (null 不被误清)", async () => {
    await mePatch(meRequest({ git_name: "Alice", git_email: "alice@corp.com" }) as any);
    const res = await mePatch(meRequest({ git_name: "Alice2" }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git_name).toBe("Alice2");
    expect(body.git_email).toBe("alice@corp.com");
  });

  it("空串 = 清空回落默认", async () => {
    await mePatch(meRequest({ git_name: "Alice", git_email: "alice@corp.com" }) as any);
    const res = await mePatch(meRequest({ git_name: "", git_email: null }) as any);
    expect(res.status).toBe(200);
    expect(resolveGitIdentity(userId)).toEqual({
      name: "alice",
      email: "alice@example.com",
    });
  });

  it("name 含 < > → 400; email 格式错 → 400", async () => {
    const bad1 = await mePatch(meRequest({ git_name: "Alice <bot>" }) as any);
    expect(bad1.status).toBe(400);
    const bad2 = await mePatch(meRequest({ git_email: "not-an-email" }) as any);
    expect(bad2.status).toBe(400);
  });

  it("email 撞他人注册邮箱 → 409 且不落库; 撞自己 → 放行", async () => {
    const clash = await mePatch(meRequest({ git_email: "bob@example.com" }) as any);
    expect(clash.status).toBe(409);
    expect(resolveGitIdentity(userId)!.email).toBe("alice@example.com");

    const self = await mePatch(meRequest({ git_email: "alice@example.com" }) as any);
    expect(self.status).toBe(200);
  });
});

describe("GET /api/user/me 透出 git 身份", () => {
  it("git_name / git_email 在响应里 (非秘密)", async () => {
    await mePatch(meRequest({ git_name: "Alice", git_email: "alice@corp.com" }) as any);
    const req = new Request("http://localhost/api/user/me", {
      headers: { "x-user-id": userId },
    });
    const res = await meGet(req as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git_name).toBe("Alice");
    expect(body.git_email).toBe("alice@corp.com");
    expect(body).not.toHaveProperty("password_hash");
  });
});
