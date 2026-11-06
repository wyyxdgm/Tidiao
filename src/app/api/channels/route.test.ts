// /api/channels 列表 + 创建的路由层测试 (docs/plans/channel-role-ui.md D3).
// 关注点:
//   - owner 隔离: A 建的渠道 B 的 GET 列表看不到
//   - secret 掩码: 响应不含 secret / webhook_secret 字段与明文, 只有 has_secret 布尔
//   - role 校验: 不存在 / 跨 owner 的 role_id -> 400 ROLE_NOT_FOUND (no existence leak)
//   - channel 枚举: 不在 INTAKE_CHANNELS -> 400 INVALID_CHANNEL

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";
import { createChannelConfig } from "@/lib/db/channel-configs";
import { createProject } from "@/lib/db/projects";
import { createRole } from "@/lib/db/roles";
import { createVersion } from "@/lib/db/versions";

let tmpDir: string;
let alice: string;
let bob: string;
let aliceProjectId: string;

function makeReq(
  url: string,
  init: { method?: string; body?: unknown; userId?: string } = {},
) {
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-user-id": init.userId ?? alice,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-channels-route-"));
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
  aliceProjectId = createProject({ name: "alice-proj", ownerId: alice }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/channels", () => {
  it("未登录 -> 401", async () => {
    const req = new NextRequest("http://localhost/api/channels", { headers: {} });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("owner 隔离: alice 建的渠道不出现在 bob 的列表", async () => {
    createChannelConfig({
      channel: "telegram",
      name: "alice-bot",
      secret: "tok_alice_secret",
      bound_project_id: aliceProjectId,
      owner_id: alice,
    });
    const res = await GET(makeReq("http://localhost/api/channels", { userId: bob }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("列表连带 project_name + role_name, secret 掩码成 has_secret", async () => {
    const role = createRole({ name: "IntakeR", system_prompt: "sp", ownerId: alice });
    createChannelConfig({
      channel: "telegram",
      name: "alice-bot",
      secret: "tok_SUPER_secret_value",
      bound_project_id: aliceProjectId,
      role_id: role.id,
      owner_id: alice,
    });
    const res = await GET(makeReq("http://localhost/api/channels"));
    const list = (await res.json()) as any[];
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row.project_name).toBe("alice-proj");
    expect(row.role_name).toBe("IntakeR");
    expect(row.has_secret).toBe(true);
    // 掩码红线: 明文与凭据字段一律不出现在响应体
    expect(JSON.stringify(row)).not.toContain("tok_SUPER_secret_value");
    expect(row.secret).toBeUndefined();
    expect(row.webhook_secret).toBeUndefined();
    expect(row.bind_code).toBeTruthy();
  });
});

describe("POST /api/channels", () => {
  it("未登录 -> 401", async () => {
    const req = new NextRequest("http://localhost/api/channels", {
      method: "POST",
      headers: {},
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("缺必填 -> 400", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: { channel: "telegram", name: "x" }, // 缺 bound_project_id
    }));
    expect(res.status).toBe(400);
  });

  it("channel 不在枚举 -> 400 INVALID_CHANNEL", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: { channel: "slack", name: "x", bound_project_id: aliceProjectId },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CHANNEL");
  });

  it("role 不存在 -> 400 ROLE_NOT_FOUND", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "x",
        bound_project_id: aliceProjectId, role_id: "role_missing",
      },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ROLE_NOT_FOUND");
  });

  it("跨 owner 的 role -> 同样 400 ROLE_NOT_FOUND (no existence leak)", async () => {
    const bobRole = createRole({ name: "BobR", system_prompt: "sp", ownerId: bob });
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "x",
        bound_project_id: aliceProjectId, role_id: bobRole.id,
      },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ROLE_NOT_FOUND");
  });

  it("成功 -> 201, 响应不含明文 secret, 建的行可查", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "my-bot", secret: "tok_new_plain",
        bound_project_id: aliceProjectId,
      },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("my-bot");
    expect(body.has_secret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("tok_new_plain");
    // 落库 secret 已加密 (密文 != 明文)
    const dbRow = getDb()
      .prepare("SELECT secret_encrypted FROM channel_configs WHERE id = ?")
      .get(body.id) as any;
    expect(dbRow.secret_encrypted).toBeTruthy();
    expect(dbRow.secret_encrypted).not.toContain("tok_new_plain");
  });
});

describe("bound_version_id (v529): 绑定粒度到版本", () => {
  let versionId: string;
  let otherProjectVersionId: string;
  let otherProjectId: string;

  beforeEach(() => {
    const v = createVersion({ project_id: aliceProjectId, name: "v1.0" });
    versionId = v.id;
    otherProjectId = createProject({ name: "alice-proj-2", ownerId: alice }).id;
    otherProjectVersionId = createVersion({ project_id: otherProjectId, name: "v2.0" }).id;
  });

  it("POST 带 bound_version_id → 201 + 响应连带 version_name; GET 列表同", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "bot-v", secret: "tok",
        bound_project_id: aliceProjectId, bound_version_id: versionId,
      },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bound_version_id).toBe(versionId);
    expect(body.version_name).toBe("v1.0");

    const list = await GET(makeReq("http://localhost/api/channels"));
    const rows = await list.json();
    const hit = rows.find((r: any) => r.id === body.id);
    expect(hit.bound_version_id).toBe(versionId);
    expect(hit.version_name).toBe("v1.0");
  });

  it("POST bound_version_id 不属于 bound_project_id → 400 VERSION_PROJECT_MISMATCH", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "bot-x", secret: "tok",
        bound_project_id: aliceProjectId, bound_version_id: otherProjectVersionId,
      },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VERSION_PROJECT_MISMATCH");
  });

  it("POST 不传 bound_version_id → null (跟随 current_version, 行为不变)", async () => {
    const res = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "bot-plain", secret: "tok",
        bound_project_id: aliceProjectId,
      },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bound_version_id).toBeNull();
    expect(body.version_name).toBeNull();
  });

  it("PATCH: 换版本 / null 清除 / 不传不改; 换绑项目时校验新项目归属", async () => {
    const created = await POST(makeReq("http://localhost/api/channels", {
      method: "POST",
      body: {
        channel: "telegram", name: "bot-p", secret: "tok",
        bound_project_id: aliceProjectId, bound_version_id: versionId,
      },
    }));
    const { id } = await created.json();

    // 不传 = 不改
    const keep = await PATCH(makeReq(`http://localhost/api/channels/${id}`, {
      method: "PATCH", body: { name: "bot-p2" },
    }), { params: Promise.resolve({ id }) });
    expect((await keep.json()).bound_version_id).toBe(versionId);

    // 换到同项目另一版本 (合法)
    const v3 = createVersion({ project_id: aliceProjectId, name: "v3.0" });
    const swap = await PATCH(makeReq(`http://localhost/api/channels/${id}`, {
      method: "PATCH", body: { bound_version_id: v3.id },
    }), { params: Promise.resolve({ id }) });
    expect((await swap.json()).bound_version_id).toBe(v3.id);

    // 换绑项目但版本属于旧项目 → 400
    const bad = await PATCH(makeReq(`http://localhost/api/channels/${id}`, {
      method: "PATCH",
      body: { bound_project_id: otherProjectId },
    }), { params: Promise.resolve({ id }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("VERSION_PROJECT_MISMATCH");

    // 清除 (null) = 跟随 current_version
    const cleared = await PATCH(makeReq(`http://localhost/api/channels/${id}`, {
      method: "PATCH", body: { bound_version_id: null },
    }), { params: Promise.resolve({ id }) });
    const clearedBody = await cleared.json();
    expect(clearedBody.bound_version_id).toBeNull();
    expect(clearedBody.version_name).toBeNull();
  });
});
