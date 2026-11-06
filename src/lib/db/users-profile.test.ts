/**
 * v518 (飞书 R222): 账号级用户身份 (昵称 + 自我介绍) — DB 层测试.
 *
 * 覆盖: migration 列存在 / setter 往返+清空归 NULL / resolveUserProfile
 * 默认回落 (昵称→「用户」, bio→null) / 显式覆盖 / 用户不存在仍返默认身份 /
 * isValidNickname / isValidBio 边界 / toSafeUser 透出 (非秘密).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  getUserById,
  setUserProfile,
  resolveUserProfile,
  isValidNickname,
  isValidBio,
  toSafeUser,
} from "./users";

let tmpDir: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-userprofile-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // migrations (含 v518)

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

describe("v518 users.nickname / bio", () => {
  it("migration 已加列, 老行 NULL", () => {
    const cols = getDb()
      .prepare(`PRAGMA table_info(users)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("nickname");
    expect(names).toContain("bio");

    const u = getUserById(userId)!;
    expect(u.nickname).toBeNull();
    expect(u.bio).toBeNull();
  });

  it("setUserProfile 往返 + 清空归 NULL", () => {
    const updated = setUserProfile(userId, "老王", "叫我老王, 偏好 terse 汇报")!;
    expect(updated.nickname).toBe("老王");
    expect(updated.bio).toBe("叫我老王, 偏好 terse 汇报");

    const cleared = setUserProfile(userId, "  ", "")!;
    expect(cleared.nickname).toBeNull();
    expect(cleared.bio).toBeNull();
  });

  it("setUserProfile 俩字段独立清空 (只改一个, 另一个保持)", () => {
    setUserProfile(userId, "老王", "简介 v1")!;
    const onlyNickname = setUserProfile(userId, "大王", null)!;
    expect(onlyNickname.nickname).toBe("大王");
    expect(onlyNickname.bio).toBeNull();
  });

  it("setUserProfile 用户不存在 → null", () => {
    expect(setUserProfile(uuidv4(), "x", "y")).toBeNull();
  });

  it("resolveUserProfile 未配置 → 昵称回落「用户」, bio null (R222 口径)", () => {
    expect(resolveUserProfile(userId)).toEqual({ nickname: "用户", bio: null });
  });

  it("resolveUserProfile 配置了就用配置的; bio 空白归 null (省略整行)", () => {
    setUserProfile(userId, "老王", "  ")!;
    expect(resolveUserProfile(userId)).toEqual({ nickname: "老王", bio: null });
    setUserProfile(userId, "老王", "喜欢简洁汇报")!;
    expect(resolveUserProfile(userId)).toEqual({ nickname: "老王", bio: "喜欢简洁汇报" });
  });

  it("resolveUserProfile 用户不存在 → 仍返默认身份 (不因 DB 异常丢注入)", () => {
    expect(resolveUserProfile(uuidv4())).toEqual({ nickname: "用户", bio: null });
    expect(resolveUserProfile("")).toEqual({ nickname: "用户", bio: null });
  });

  it("isValidNickname: 空白 false / 换行 false / 控制字符 false / 64 字上限", () => {
    expect(isValidNickname("")).toBe(false);
    expect(isValidNickname("  ")).toBe(false);
    expect(isValidNickname("两\n行")).toBe(false);
    expect(isValidNickname("带\x01控制符")).toBe(false);
    expect(isValidNickname("a".repeat(64))).toBe(true);
    expect(isValidNickname("a".repeat(65))).toBe(false);
    expect(isValidNickname("老王")).toBe(true);
  });

  it("isValidBio: ≤2000 字 true, 超 false (多行允许)", () => {
    expect(isValidBio("多\n行\n简介")).toBe(true);
    expect(isValidBio("a".repeat(2000))).toBe(true);
    expect(isValidBio("a".repeat(2001))).toBe(false);
  });

  it("toSafeUser 透出 nickname / bio (非秘密)", () => {
    setUserProfile(userId, "老王", "简介")!;
    const safe = toSafeUser(getUserById(userId)!);
    expect(safe.nickname).toBe("老王");
    expect(safe.bio).toBe("简介");
  });
});
