// channel_configs CRUD + 加密 roundtrip + 绑定码查询 (飞书 R184).
// 覆盖:
//   1. createChannelConfig: secret 加密落库 (DB 里无明文), bind_code 自动生成
//   2. getChannelConfigById 命中/miss; secret 解密 roundtrip
//   3. getChannelConfigByBindCode: 大小写不敏感 + disabled 不命中
//   4. updateChannelConfig: 部分更新不覆盖其他字段; rotate_bind_code 换码; secret 清除
//   5. deleteChannelConfig + listChannelConfigs
//   6. role_id (v526 D3): create 带 role 读回; role 不存在/跨 owner 抛错;
//      update 换 role / null 清除; 默认 NULL 行为不变

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  createChannelConfig,
  getChannelConfigById,
  getChannelConfigByBindCode,
  updateChannelConfig,
  deleteChannelConfig,
  listChannelConfigs,
} from "./channel-configs";
import { createRole } from "./roles";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-channel-configs-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  ownerId = uuidv4();
  projectId = uuidv4();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("channel_configs", () => {
  it("create 加密落库 + bind_code 自动生成 + 读回解密", () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "intake bot",
      secret: "123456:ABC-token",
      bound_project_id: projectId,
      owner_id: ownerId,
      webhook_secret: "whsec-abc",
    });

    expect(cfg.id).toMatch(/^ch_/);
    expect(cfg.bind_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/); // 无 0/O/1/I
    expect(cfg.secret).toBe("123456:ABC-token");
    expect(cfg.enabled).toBe(true);

    // DB 里不存在明文 token
    const raw = getDb()
      .prepare("SELECT secret_encrypted FROM channel_configs WHERE id = ?")
      .get(cfg.id) as { secret_encrypted: string };
    expect(raw.secret_encrypted).not.toContain("ABC-token");
  });

  it("getChannelConfigById miss 返 null", () => {
    expect(getChannelConfigById("ch_nonexist")).toBeNull();
  });

  it("getChannelConfigByBindCode 大小写不敏感, disabled 不命中", () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    expect(getChannelConfigByBindCode(cfg.bind_code.toLowerCase())?.id).toBe(cfg.id);

    updateChannelConfig(cfg.id, { enabled: false });
    expect(getChannelConfigByBindCode(cfg.bind_code)).toBeNull();
  });

  it("update 部分字段 + rotate_bind_code 换码 + secret 清除", () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      secret: "tok",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const renamed = updateChannelConfig(cfg.id, { name: "bot-2" })!;
    expect(renamed.name).toBe("bot-2");
    expect(renamed.secret).toBe("tok"); // 未动的字段保持

    const rotated = updateChannelConfig(cfg.id, { rotate_bind_code: true })!;
    expect(rotated.bind_code).not.toBe(cfg.bind_code);

    const cleared = updateChannelConfig(cfg.id, { secret: "" })!;
    expect(cleared.secret).toBeNull();
  });

  it("delete + list", () => {
    const a = createChannelConfig({
      channel: "telegram",
      name: "a",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    createChannelConfig({
      channel: "telegram",
      name: "b",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    expect(listChannelConfigs()).toHaveLength(2);
    deleteChannelConfig(a.id);
    expect(listChannelConfigs()).toHaveLength(1);
    expect(listChannelConfigs()[0].name).toBe("b");
  });

  // ---- v526 (D3) 渠道默认角色 ----

  // 造合法 role 前置行 (roles.owner_id REFERENCES users, roles 表校验依赖 users 行)
  function ensureUser(id: string): void {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", "user");
  }

  it("create 带 role_id 读回; 默认不传 role_id 为 NULL (行为不变)", () => {
    ensureUser(ownerId);
    const role = createRole({ name: "sales", system_prompt: "你是售前", ownerId });

    const withRole = createChannelConfig({
      channel: "telegram",
      name: "with-role",
      bound_project_id: projectId,
      owner_id: ownerId,
      role_id: role.id,
    });
    expect(withRole.role_id).toBe(role.id);
    expect(getChannelConfigById(withRole.id)!.role_id).toBe(role.id);

    const withoutRole = createChannelConfig({
      channel: "telegram",
      name: "no-role",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    expect(withoutRole.role_id).toBeNull();
  });

  it("create/update role 不存在 → 抛错不落库", () => {
    ensureUser(ownerId);
    expect(() =>
      createChannelConfig({
        channel: "telegram",
        name: "bad-role",
        bound_project_id: projectId,
        owner_id: ownerId,
        role_id: "role_nonexistent",
      }),
    ).toThrow(/not found/);

    const cfg = createChannelConfig({
      channel: "telegram",
      name: "later-role",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    expect(() => updateChannelConfig(cfg.id, { role_id: "role_nonexistent" })).toThrow(/not found/);
    // 失败的 update 不落库
    expect(getChannelConfigById(cfg.id)!.role_id).toBeNull();
  });

  it("create/update 跨 owner role → 抛错", () => {
    ensureUser(ownerId);
    const otherOwner = uuidv4();
    ensureUser(otherOwner);
    const foreignRole = createRole({ name: "foreign", system_prompt: "x", ownerId: otherOwner });

    expect(() =>
      createChannelConfig({
        channel: "telegram",
        name: "foreign-role",
        bound_project_id: projectId,
        owner_id: ownerId,
        role_id: foreignRole.id,
      }),
    ).toThrow(/not found/);

    const cfg = createChannelConfig({
      channel: "telegram",
      name: "own-role",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    expect(() => updateChannelConfig(cfg.id, { role_id: foreignRole.id })).toThrow(/not found/);
  });

  it("update 换 role / null 清除 / undefined 不动", () => {
    ensureUser(ownerId);
    const roleA = createRole({ name: "role-a", system_prompt: "a", ownerId });
    const roleB = createRole({ name: "role-b", system_prompt: "b", ownerId });

    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
      role_id: roleA.id,
    });

    // undefined = 不改 (其他字段照常更新)
    const renamed = updateChannelConfig(cfg.id, { name: "bot-2" })!;
    expect(renamed.name).toBe("bot-2");
    expect(renamed.role_id).toBe(roleA.id);

    // 换 role
    expect(updateChannelConfig(cfg.id, { role_id: roleB.id })!.role_id).toBe(roleB.id);

    // null = 清除
    expect(updateChannelConfig(cfg.id, { role_id: null })!.role_id).toBeNull();
  });
});

describe("channel_configs.bound_version_id (v529)", () => {
  it("create 带 bound_version_id 读回; 不传为 NULL (行为不变)", () => {
    const withV = createChannelConfig({
      channel: "telegram",
      name: "bot-pinned",
      bound_project_id: projectId,
      owner_id: ownerId,
      bound_version_id: "ver_abc",
    });
    expect(withV.bound_version_id).toBe("ver_abc");

    const withoutV = createChannelConfig({
      channel: "telegram",
      name: "bot-follow",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    expect(withoutV.bound_version_id).toBeNull();
  });

  it("update: set / null 清除 / undefined 不改", () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      bound_project_id: projectId,
      owner_id: ownerId,
      bound_version_id: "ver_1",
    });

    // undefined = 不改
    expect(updateChannelConfig(cfg.id, { name: "renamed" })!.bound_version_id).toBe("ver_1");

    // 换版本
    expect(updateChannelConfig(cfg.id, { bound_version_id: "ver_2" })!.bound_version_id).toBe("ver_2");

    // null / 空串 = 清除 (跟随项目 current_version)
    expect(updateChannelConfig(cfg.id, { bound_version_id: null })!.bound_version_id).toBeNull();
    expect(updateChannelConfig(cfg.id, { bound_version_id: "" })!.bound_version_id).toBeNull();
  });
});
