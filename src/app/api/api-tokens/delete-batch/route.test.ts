// POST /api/api-tokens/delete-batch 集成测试.
//
// 覆盖:
//   1. 401 (无 x-user-id)
//   2. 400: 非 JSON / body 不是 object / ids 缺失 / ids 非数组 / ids 空 / 超 100 / 含非字符串
//   3. 200 正常批量删除, 返回 {deleted, requested}, DB 真的删了
//   4. 跨用户 id 静默忽略, 不计入 deleted; 其他用户的 token 不受影响
//   5. 输入含不存在 id 同样不影响, 只返回实际删数

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { closeDb, getDb } from "@/lib/db";
import {
  createApiToken,
  listApiTokens,
  deleteApiToken,
} from "@/lib/db/api-tokens";

let tmpDir: string;
let userId: string;
let otherUserId: string;

function postReq(opts: {
  body?: string | null;
  userIdHeader?: string | null;
}): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.userIdHeader !== null && opts.userIdHeader !== undefined) {
    headers["x-user-id"] = opts.userIdHeader;
  }
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: "POST",
    headers,
  };
  if (opts.body !== null && opts.body !== undefined) init.body = opts.body;
  return new NextRequest("http://localhost/api/api-tokens/delete-batch", init);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-api-tokens-batch-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  userId = uuidv4();
  otherUserId = uuidv4();
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );
  ins.run(userId, `${userId}@example.com`, "x", "user");
  ins.run(otherUserId, `${otherUserId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/api-tokens/delete-batch", () => {
  it("missing x-user-id -> 401", async () => {
    const res = await POST(
      postReq({ body: JSON.stringify({ ids: ["x"] }), userIdHeader: null })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("invalid json body -> 400", async () => {
    const res = await POST(postReq({ body: "{not json", userIdHeader: userId }));
    expect(res.status).toBe(400);
  });

  it("body not object -> 400", async () => {
    // 123 parse 后 typeof !== "object"，会触发 body must be object
    const res = await POST(postReq({ body: "123", userIdHeader: userId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("body must be object");
  });

  it("ids missing -> 400", async () => {
    const res = await POST(
      postReq({ body: JSON.stringify({}), userIdHeader: userId })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ids must be array");
  });

  it("ids empty -> 400", async () => {
    const res = await POST(
      postReq({ body: JSON.stringify({ ids: [] }), userIdHeader: userId })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ids must not be empty");
  });

  it("ids exceeds 100 -> 400", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = await POST(
      postReq({ body: JSON.stringify({ ids }), userIdHeader: userId })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/max batch size/);
  });

  it("ids with non-string entry -> 400", async () => {
    const res = await POST(
      postReq({
        body: JSON.stringify({ ids: ["ok", 123, "also-ok"] }),
        userIdHeader: userId,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ids must be non-empty strings");
  });

  it("empty-string id -> 400", async () => {
    const res = await POST(
      postReq({
        body: JSON.stringify({ ids: ["ok", ""] }),
        userIdHeader: userId,
      })
    );
    expect(res.status).toBe(400);
  });

  it("200: deletes all matching rows, returns {deleted, requested}", async () => {
    const a = createApiToken(userId, "a", "ao_a");
    const b = createApiToken(userId, "b", "ao_b");
    const c = createApiToken(userId, "c", "ao_c");

    const res = await POST(
      postReq({
        body: JSON.stringify({ ids: [a.id, b.id, c.id] }),
        userIdHeader: userId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3, requested: 3 });
    expect(listApiTokens(userId)).toHaveLength(0);
  });

  it("cross-user ids silently ignored; other user's tokens untouched", async () => {
    const mine = createApiToken(userId, "m", "ao_m");
    const othersRow = createApiToken(otherUserId, "o", "ao_o");

    const res = await POST(
      postReq({
        body: JSON.stringify({ ids: [mine.id, othersRow.id] }),
        userIdHeader: userId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, requested: 2 });

    expect(listApiTokens(userId)).toHaveLength(0);
    expect(listApiTokens(otherUserId)).toHaveLength(1);
  });

  it("non-existent ids count as 0 deletions", async () => {
    const real = createApiToken(userId, "r", "ao_r");
    const res = await POST(
      postReq({
        body: JSON.stringify({ ids: [real.id, "phantom-1", "phantom-2"] }),
        userIdHeader: userId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, requested: 3 });
    expect(listApiTokens(userId)).toHaveLength(0);
  });

  it("re-deleting already-deleted ids returns deleted:0 (idempotent)", async () => {
    const a = createApiToken(userId, "a", "ao_a");
    deleteApiToken(userId, a.id);

    const res = await POST(
      postReq({
        body: JSON.stringify({ ids: [a.id] }),
        userIdHeader: userId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0, requested: 1 });
  });
});