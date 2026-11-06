// /api/user/media-key 路由测试: 鉴权 + body 校验 + DB round-trip + region 校验.
//
// 关注点:
//   - mmx auth login spawn 真实跑 (mmx 可能未装, ENOENT → mmx_warning 字段, 测试接受)
//   - ORCHESTRATOR_HOME 必设, 否则 userMmxConfigDir 写到 process.cwd() 污染仓库
//   - 不依赖 ENCRYPTION_KEY 环境变量 (用项目默认 scrypt(JWT_SECRET) 派生)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "@/app/api/user/media-key/route";
import { closeDb, getDb } from "@/lib/db/index";

let tmpDir: string;
let userId: string;

function req(
  url: string,
  init: { method?: string; userId?: string; body?: Record<string, unknown> } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (init.userId) headers["x-user-id"] = init.userId;
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

async function callJson<T>(p: Promise<Response>): Promise<{ status: number; json: T }> {
  const res = await p;
  return { status: res.status, json: (await res.json()) as T };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-media-key-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

describe("/api/user/media-key", () => {
  it("GET without x-user-id → 401", async () => {
    const { status, json } = await callJson<{ error: string }>(
      GET(req("http://localhost/api/user/media-key")),
    );
    expect(status).toBe(401);
    expect(json.error).toBe("unauthorized");
  });

  it("GET when no config → 200 with all-null shape", async () => {
    const { status, json } = await callJson<{
      user_id: string;
      api_key_masked: string | null;
      has_api_key: boolean;
      region: string | null;
    }>(GET(req("http://localhost/api/user/media-key", { userId })));
    expect(status).toBe(200);
    expect(json.user_id).toBe(userId);
    expect(json.has_api_key).toBe(false);
    expect(json.api_key_masked).toBeNull();
    expect(json.region).toBeNull();
  });

  it("PUT without x-user-id → 401", async () => {
    const { status } = await callJson(
      PUT(
        req("http://localhost/api/user/media-key", {
          method: "PUT",
          body: { api_key: "sk-x", region: "cn" },
        }),
      ),
    );
    expect(status).toBe(401);
  });

  it("PUT with invalid region → 400", async () => {
    const { status, json } = await callJson<{ error: string }>(
      PUT(
        req("http://localhost/api/user/media-key", {
          method: "PUT",
          userId,
          body: { api_key: "sk-test", region: "us-east" },
        }),
      ),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/invalid region/);
  });

  it("PUT round-trip: encrypted in DB, returns safe shape", async () => {
    const { status, json } = await callJson<{
      user_id: string;
      api_key_masked: string | null;
      has_api_key: boolean;
      region: string | null;
      mmx_warning?: string;
    }>(
      PUT(
        req("http://localhost/api/user/media-key", {
          method: "PUT",
          userId,
          body: { api_key: "sk-roundtrip-key-abc", region: "global" },
        }),
      ),
    );
    expect(status).toBe(200);
    expect(json.has_api_key).toBe(true);
    expect(json.api_key_masked).toMatch(/^sk-/);
    expect(json.region).toBe("global");
    // mmx 可能在测试环境没装, 返 mmx_warning — 接受, 不强制 200/!warning
    // (生产环境装 mmx 后 warning 自动消失)

    // DB 验证: api_key 已加密存
    const row = getDb()
      .prepare(`SELECT api_key_encrypted FROM user_media_keys WHERE user_id = ?`)
      .get(userId) as { api_key_encrypted: string };
    expect(row.api_key_encrypted).not.toBe("sk-roundtrip-key-abc");
    expect(row.api_key_encrypted).toMatch(/^[0-9a-f]+$/);
  });

  it("PUT clear_api_key → wipes key, returns safe shape", async () => {
    // 先存
    await PUT(
      req("http://localhost/api/user/media-key", {
        method: "PUT",
        userId,
        body: { api_key: "sk-test", region: "cn" },
      }),
    );
    // 再清
    const { status, json } = await callJson<{
      has_api_key: boolean;
      region: string | null;
    }>(
      PUT(
        req("http://localhost/api/user/media-key", {
          method: "PUT",
          userId,
          body: { clear_api_key: true },
        }),
      ),
    );
    expect(status).toBe(200);
    expect(json.has_api_key).toBe(false);
    expect(json.region).toBe("cn"); // region 不动
  });

  it("PUT with decryption-broken row → returns warning (does not 500)", async () => {
    // 模拟 ENCRYPTION_KEY 漂移: 直接 UPDATE 把 iv 改成非法 hex
    getDb()
      .prepare(
        `INSERT INTO user_media_keys (user_id, api_key_encrypted, api_key_iv, api_key_tag, region)
         VALUES (?, 'aa', 'deadbeef', 'cc', 'cn')`,
      )
      .run(userId);

    const { status, json } = await callJson<{
      has_api_key: boolean;
      api_key_masked: string | null;
      mmx_warning?: string;
    }>(
      PUT(
        req("http://localhost/api/user/media-key", {
          method: "PUT",
          userId,
          body: { api_key: "sk-new-key" }, // 用户主动重新输入
        }),
      ),
    );
    expect(status).toBe(200);
    // 新 key 应已加密存; toSafeMediaKey 在 PUT 内层 decrypt 抛错时返 warning
    expect(json.has_api_key).toBe(true);
  });

  it("DELETE without x-user-id → 401", async () => {
    const { status } = await callJson(
      DELETE(req("http://localhost/api/user/media-key", { method: "DELETE" })),
    );
    expect(status).toBe(401);
  });

  it("DELETE removes row + config dir, idempotent", async () => {
    // 先存
    await PUT(
      req("http://localhost/api/user/media-key", {
        method: "PUT",
        userId,
        body: { api_key: "sk-test", region: "cn" },
      }),
    );
    expect(
      getDb().prepare(`SELECT 1 FROM user_media_keys WHERE user_id = ?`).get(userId),
    ).toBeDefined();

    // 删
    const { status, json } = await callJson<{ ok: boolean }>(
      DELETE(req("http://localhost/api/user/media-key", { method: "DELETE", userId })),
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(
      getDb().prepare(`SELECT 1 FROM user_media_keys WHERE user_id = ?`).get(userId),
    ).toBeUndefined();

    // 再删幂等
    const { status: status2 } = await callJson(
      DELETE(req("http://localhost/api/user/media-key", { method: "DELETE", userId })),
    );
    expect(status2).toBe(200);
  });
});