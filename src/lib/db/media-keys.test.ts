// media-keys CRUD + region 校验 + 解密失败 warning.
//
// 覆盖:
//   1. upsert + get 加密落地 (encrypted 不等于明文, 三件套均存)
//   2. clear_api_key 三态 (undefined=keep, true=clear, string=update)
//   3. region 校验: undefined=keep, null=clear, 'cn'/'global'=set, 非法 throw
//   4. toSafeMediaKey 解密失败返警告文案 (mock crypto.decrypt 抛错)
//   5. deleteMediaKey 真删行 (changes > 0), 不存在返 false

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { getMediaKey, upsertMediaKey, deleteMediaKey, toSafeMediaKey } from "./media-keys";

let tmpDir: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-media-keys-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // run all migrations (incl. v48) against the fresh temp DB
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("media-keys", () => {
  it("upsert stores encrypted triple (not plaintext)", () => {
    upsertMediaKey(userId, { api_key: "sk-test-plaintext-key", region: "cn" });

    const row = getMediaKey(userId);
    expect(row).not.toBeNull();
    expect(row!.api_key_encrypted).not.toBe("sk-test-plaintext-key");
    expect(row!.api_key_encrypted).toMatch(/^[0-9a-f]+$/);
    expect(row!.api_key_iv).toMatch(/^[0-9a-f]+$/);
    expect(row!.api_key_tag).toMatch(/^[0-9a-f]+$/);
    expect(row!.region).toBe("cn");
  });

  it("clear_api_key: keep vs clear vs update", () => {
    upsertMediaKey(userId, { api_key: "sk-original", region: "cn" });

    // keep: omit api_key → encrypted triple unchanged
    const before = getMediaKey(userId);
    upsertMediaKey(userId, { region: "global" }); // region change, key keep
    const afterKeep = getMediaKey(userId);
    expect(afterKeep!.api_key_encrypted).toBe(before!.api_key_encrypted);
    expect(afterKeep!.region).toBe("global");

    // update: api_key 变更 → 三件套都换
    upsertMediaKey(userId, { api_key: "sk-rotated" });
    const afterUpdate = getMediaKey(userId);
    expect(afterUpdate!.api_key_encrypted).not.toBe(before!.api_key_encrypted);

    // clear: clear_api_key=true → 三件套都置 null
    upsertMediaKey(userId, { clear_api_key: true });
    const afterClear = getMediaKey(userId);
    expect(afterClear!.api_key_encrypted).toBeNull();
    expect(afterClear!.api_key_iv).toBeNull();
    expect(afterClear!.api_key_tag).toBeNull();
    expect(afterClear!.region).toBe("global"); // region 不受 clear_api_key 影响
  });

  it("region validation: undefined keeps, null clears, 'cn'/'global' set, others throw", () => {
    upsertMediaKey(userId, { api_key: "sk-test", region: "cn" });

    // undefined = keep
    upsertMediaKey(userId, {});
    expect(getMediaKey(userId)!.region).toBe("cn");

    // null = clear
    upsertMediaKey(userId, { region: null });
    expect(getMediaKey(userId)!.region).toBeNull();

    // 'cn' / 'global' = set
    upsertMediaKey(userId, { region: "global" });
    expect(getMediaKey(userId)!.region).toBe("global");

    // invalid → throw
    expect(() => upsertMediaKey(userId, { region: "us-east" })).toThrow(/invalid region/);
    expect(() => upsertMediaKey(userId, { region: "" })).toThrow(/invalid region/);
  });

  it("toSafeMediaKey: success returns masked, never plaintext", () => {
    upsertMediaKey(userId, { api_key: "sk-very-long-test-key-12345", region: "cn" });
    const safe = toSafeMediaKey(getMediaKey(userId));
    expect(safe).not.toBeNull();
    expect(safe!.has_api_key).toBe(true);
    expect(safe!.api_key_masked).toMatch(/^sk-/); // maskApiKey: first 4
    expect(safe!.api_key_masked).not.toContain("very-long-test-key-12345");
    expect(safe!.api_key_masked).toMatch(/345$/); // last 3
    expect(safe!.region).toBe("cn");
  });

  it("toSafeMediaKey: decryption failure returns warning marker (does not throw)", () => {
    upsertMediaKey(userId, { api_key: "sk-test", region: "cn" });

    // Simulate ENCRYPTION_KEY 漂移: 直接 UPDATE 把 iv 改成非法 hex, 让 decrypt() 抛错.
    // (更真实: 换 ENCRYPTION_KEY env, 但要重新跑 getDb() 才能生效, 太重.)
    getDb()
      .prepare(`UPDATE user_media_keys SET api_key_iv = 'deadbeef' WHERE user_id = ?`)
      .run(userId);

    const safe = toSafeMediaKey(getMediaKey(userId));
    expect(safe).not.toBeNull();
    expect(safe!.has_api_key).toBe(true);
    expect(safe!.api_key_masked).toBe("*** (解密失败, 请重新输入)");
  });

  it("toSafeMediaKey: null row returns null", () => {
    expect(toSafeMediaKey(null)).toBeNull();
  });

  it("toSafeMediaKey: row with no key (after clear) returns has_api_key=false", () => {
    upsertMediaKey(userId, { region: "cn" }); // region-only, no key
    const safe = toSafeMediaKey(getMediaKey(userId));
    expect(safe!.has_api_key).toBe(false);
    expect(safe!.api_key_masked).toBeNull();
    expect(safe!.region).toBe("cn");
  });

  it("deleteMediaKey removes row, returns false when missing", () => {
    expect(deleteMediaKey(userId)).toBe(false); // 不存在
    upsertMediaKey(userId, { api_key: "sk-test" });
    expect(deleteMediaKey(userId)).toBe(true); // 真删
    expect(getMediaKey(userId)).toBeNull();
    expect(deleteMediaKey(userId)).toBe(false); // 再删 = 已无
  });
});