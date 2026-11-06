// /api/channels/[id] PATCH + DELETE 路由层测试 (docs/plans/channel-role-ui.md D3).
// 关注点:
//   - owner 隔离: 跨 owner 的 PATCH/DELETE 一律 404 CHANNEL_NOT_FOUND (no existence leak)
//   - PATCH undefined = 不改; secret 留空 ('') = 不改 (route 层语义, db 层 '' 是清除)
//   - PATCH role_id: null = 清除; 不存在的 role -> 400 ROLE_NOT_FOUND
//   - DELETE 不级联 intake thread (只断渠道, 历史保留由 db 层保证, 这里只断言渠道删除)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { PATCH, DELETE } from "./route";
import { createChannelConfig } from "@/lib/db/channel-configs";
import { createProject } from "@/lib/db/projects";
import { createRole } from "@/lib/db/roles";
import { decrypt } from "@/lib/crypto";

let tmpDir: string;
let alice: string;
let bob: string;
let projectId: string;
let channelId: string;
const ORIGINAL_SECRET = "tok_original_value";

function makeReq(
  url: string,
  init: { method?: string; body?: unknown; userId?: string } = {},
) {
  return new NextRequest(url, {
    method: init.method ?? "PATCH",
    headers: {
      "content-type": "application/json",
      "x-user-id": init.userId ?? alice,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function dbSecret(id: string): string | null {
  const row = getDb()
    .prepare("SELECT secret_encrypted, secret_iv, secret_tag FROM channel_configs WHERE id = ?")
    .get(id) as any;
  if (!row?.secret_encrypted) return null;
  return decrypt(row.secret_encrypted, row.secret_iv, row.secret_tag);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-channels-id-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  alice = uuidv4();
  bob = uuidv4();
  for (const id of [alice, bob]) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`)
      .run(id, `${id}@example.com`, "x");
  }
  projectId = createProject({ name: "proj", ownerId: alice }).id;
  channelId = createChannelConfig({
    channel: "telegram",
    name: "bot",
    secret: ORIGINAL_SECRET,
    bound_project_id: projectId,
    owner_id: alice,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PATCH /api/channels/[id]", () => {
  it("未登录 -> 401", async () => {
    const req = new NextRequest(`http://localhost/api/channels/${channelId}`, {
      method: "PATCH", headers: {}, body: JSON.stringify({}),
    });
    expect((await PATCH(req, { params: Promise.resolve({ id: channelId }) })).status).toBe(401);
  });

  it("跨 owner -> 404 CHANNEL_NOT_FOUND (不泄漏存在性)", async () => {
    const res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, {
        userId: bob, body: { name: "hacked" },
      }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("CHANNEL_NOT_FOUND");
  });

  it("不存在的 id -> 404", async () => {
    const res = await PATCH(
      makeReq(`http://localhost/api/channels/ch_missing`, { body: { name: "x" } }),
      { params: Promise.resolve({ id: "ch_missing" }) },
    );
    expect(res.status).toBe(404);
  });

  it("只传 name: secret / bound_project_id / role_id 原样保留 (undefined = 不改)", async () => {
    const res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { name: "renamed" } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    const body = await res.json();
    expect(body.name).toBe("renamed");
    expect(body.has_secret).toBe(true);
    expect(body.bound_project_id).toBe(projectId);
    expect(body.role_id).toBeNull();
    expect(dbSecret(channelId)).toBe(ORIGINAL_SECRET);
  });

  it("secret 留空 '' = 不改 (route 层语义; 响应不含明文)", async () => {
    const res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { secret: "" } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    const body = await res.json();
    expect(body.has_secret).toBe(true);
    expect(dbSecret(channelId)).toBe(ORIGINAL_SECRET);
    expect(JSON.stringify(body)).not.toContain(ORIGINAL_SECRET);
  });

  it("secret 传新值 = 替换", async () => {
    await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { secret: "tok_rotated" } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect(dbSecret(channelId)).toBe("tok_rotated");
  });

  it("role_id null = 清除; role 不存在 -> 400 ROLE_NOT_FOUND", async () => {
    const role = createRole({ name: "R", system_prompt: "sp", ownerId: alice });
    await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { role_id: role.id } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    let res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { role_id: null } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect((await res.json()).role_id).toBeNull();

    res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { role_id: "role_missing" } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ROLE_NOT_FOUND");
  });

  it("跨 owner 的 role -> 400 ROLE_NOT_FOUND", async () => {
    const bobRole = createRole({ name: "BobR", system_prompt: "sp", ownerId: bob });
    const res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { role_id: bobRole.id } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ROLE_NOT_FOUND");
  });

  it("enabled false = 停用", async () => {
    const res = await PATCH(
      makeReq(`http://localhost/api/channels/${channelId}`, { body: { enabled: false } }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect((await res.json()).enabled).toBe(false);
  });
});

describe("DELETE /api/channels/[id]", () => {
  it("跨 owner -> 404, 渠道仍在", async () => {
    const res = await DELETE(
      makeReq(`http://localhost/api/channels/${channelId}`, { method: "DELETE", userId: bob }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect(res.status).toBe(404);
    expect(dbSecret(channelId)).toBe(ORIGINAL_SECRET); // 未被删
  });

  it("owner 删除成功 -> 行消失", async () => {
    const res = await DELETE(
      makeReq(`http://localhost/api/channels/${channelId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: channelId }) },
    );
    expect(res.status).toBe(200);
    expect(
      getDb().prepare("SELECT id FROM channel_configs WHERE id = ?").get(channelId),
    ).toBeUndefined();
  });
});
