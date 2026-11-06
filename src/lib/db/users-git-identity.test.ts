/**
 * v515 (飞书 R178): 账号级 git 提交身份 — DB 层测试.
 *
 * 覆盖: migration 列存在 / setter 往返+清空 / resolveGitIdentity 默认回落
 * (email→账号邮箱, name→前缀) / 显式覆盖 / 自定义 email 时 name 前缀跟
 * 同一来源 / isValidGitName 边界 / toSafeUser 透出 (非秘密).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  getUserById,
  setUserGitIdentity,
  resolveGitIdentity,
  isValidGitName,
  toSafeUser,
} from "./users";

let tmpDir: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-gitid-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // migrations (含 v515)

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

describe("v515 users.git_name / git_email", () => {
  it("migration 已加列, 老行 NULL", () => {
    const cols = getDb()
      .prepare(`PRAGMA table_info(users)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("git_name");
    expect(names).toContain("git_email");

    const u = getUserById(userId)!;
    expect(u.git_name).toBeNull();
    expect(u.git_email).toBeNull();
  });

  it("setUserGitIdentity 往返 + 清空归 NULL", () => {
    const updated = setUserGitIdentity(userId, "Alice Code", "alice@corp.com")!;
    expect(updated.git_name).toBe("Alice Code");
    expect(updated.git_email).toBe("alice@corp.com");

    const cleared = setUserGitIdentity(userId, "  ", "")!;
    expect(cleared.git_name).toBeNull();
    expect(cleared.git_email).toBeNull();
  });

  it("setUserGitIdentity 用户不存在 → null", () => {
    expect(setUserGitIdentity(uuidv4(), "x", "x@y.com")).toBeNull();
  });
});

describe("resolveGitIdentity 默认回落", () => {
  it("未配置 → email=账号邮箱, name=邮箱前缀", () => {
    expect(resolveGitIdentity(userId)).toEqual({
      name: "alice",
      email: "alice@example.com",
    });
  });

  it("只配 name → email 回落账号邮箱", () => {
    setUserGitIdentity(userId, "Alice Coder", null);
    expect(resolveGitIdentity(userId)).toEqual({
      name: "Alice Coder",
      email: "alice@example.com",
    });
  });

  it("只配 email → name 前缀取自定义 email (同源, 不混账号邮箱前缀)", () => {
    setUserGitIdentity(userId, null, "dev@corp.com");
    expect(resolveGitIdentity(userId)).toEqual({
      name: "dev",
      email: "dev@corp.com",
    });
  });

  it("配空串 (脏数据防御) → 当作未配置回落默认", () => {
    getDb()
      .prepare(`UPDATE users SET git_name = '  ', git_email = '' WHERE id = ?`)
      .run(userId);
    expect(resolveGitIdentity(userId)).toEqual({
      name: "alice",
      email: "alice@example.com",
    });
  });

  it("用户不存在 → null (调用方跳过注入)", () => {
    expect(resolveGitIdentity(uuidv4())).toBeNull();
  });
});

describe("isValidGitName", () => {
  it("合法名通过", () => {
    expect(isValidGitName("Alice Coder")).toBe(true);
    expect(isValidGitName("张三")).toBe(true);
    expect(isValidGitName("a".repeat(128))).toBe(true);
  });

  it("git 硬性禁的字符拒绝", () => {
    expect(isValidGitName("Alice <bot>")).toBe(false);
    expect(isValidGitName("line\nbreak")).toBe(false);
    expect(isValidGitName("tab\tchar")).toBe(false);
  });

  it("空 / 超长拒绝", () => {
    expect(isValidGitName("")).toBe(false);
    expect(isValidGitName("   ")).toBe(false);
    expect(isValidGitName("a".repeat(129))).toBe(false);
  });
});

describe("toSafeUser 透出 git 身份 (非秘密, 提交本来就公开)", () => {
  it("包含 git_name / git_email", () => {
    setUserGitIdentity(userId, "Alice", "alice@corp.com");
    const safe = toSafeUser(getUserById(userId)!);
    expect(safe.git_name).toBe("Alice");
    expect(safe.git_email).toBe("alice@corp.com");
    expect(safe).not.toHaveProperty("password_hash");
  });
});
