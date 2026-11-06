// cwd 本机校验单测 (damo 2026-10-31: 写路径必须过这道门).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { checkCwdPath, validateCwdFromBody } from "./cwd-validate";

let tmp: string;
let home: string;
const HOST = "test-host";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-validate-"));
  home = path.join(tmp, "home");
  // 布局: home/workspace/{exists, foo} + 一个同名文件
  fs.mkdirSync(path.join(home, "workspace", "exists"), { recursive: true });
  fs.mkdirSync(path.join(home, "workspace", "foo"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "afile"), "x");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("checkCwdPath", () => {
  it("本机存在的目录 → ok", () => {
    const p = path.join(home, "workspace", "exists");
    expect(checkCwdPath(p, { _home: home, _host: HOST }).ok).toBe(true);
  });

  it("相对路径 → CWD_INVALID", () => {
    const r = checkCwdPath("workspace/rel", { _home: home, _host: HOST });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("CWD_INVALID");
  });

  it("路径存在但是文件 → CWD_INVALID", () => {
    const r = checkCwdPath(path.join(tmp, "afile"), { _home: home, _host: HOST });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("CWD_INVALID");
  });

  it("不存在 + 无放行参数 → CWD_NOT_FOUND, 提示含前缀映射候选", () => {
    // Mac 形态路径, 本机(假 home)下 /workspace/exists 真实存在 → 候选应给出映射路径
    const mapped = path.join(home, "workspace", "exists");
    const r = checkCwdPath("/Users/user/workspace/exists", { _home: home, _host: HOST });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("CWD_NOT_FOUND");
      expect(r.failure.hint.home_prefixed).toBe(mapped);
      expect(r.failure.hint.home_prefixed_exists).toBe(true);
      expect(r.failure.hint.candidates).toContain(mapped);
      expect(r.failure.hint.under_home).toBe(false);
      expect(r.failure.error).toContain("本机对应路径");
    }
  });

  it("家目录下同名目录 → 进 candidates", () => {
    const r = checkCwdPath("/Users/user/other/foo", { _home: home, _host: HOST });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.hint.candidates).toContain(path.join(home, "workspace", "foo"));
  });

  it("不存在 + create_if_missing → mkdir 放行", () => {
    const p = path.join(tmp, "brand-new", "proj");
    const r = checkCwdPath(p, { _home: home, _host: HOST, create_if_missing: true });
    expect(r.ok).toBe(true);
    expect(fs.statSync(p).isDirectory()).toBe(true);
  });

  it("不存在 + git_remote 指向本地空仓 → clone 放行", () => {
    const src = path.join(tmp, "src-repo");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "README.md"), "hi");
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(`git init -q "${src}" && git -C "${src}" add . && git -C "${src}" -c user.email=t@t -c user.name=t commit -qm init`);
    const dst = path.join(tmp, "cloned");
    const r = checkCwdPath(dst, { _home: home, _host: HOST, git_remote: src });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dst, "README.md"))).toBe(true);
  });

  it("git_remote 指向坏地址 → CWD_PROVISION_FAILED", () => {
    const r = checkCwdPath(path.join(tmp, "clone-fail"), { _home: home, _host: HOST, git_remote: "/nonexistent/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("CWD_PROVISION_FAILED");
  });
});

describe("validateCwdFromBody", () => {
  it("cwd 未传/null/空串 → 放行", () => {
    expect(validateCwdFromBody({})).toBeNull();
    expect(validateCwdFromBody({ cwd: null })).toBeNull();
    expect(validateCwdFromBody({ cwd: "" })).toBeNull();
  });

  it("cwd 非字符串 → CWD_INVALID", () => {
    const f = validateCwdFromBody({ cwd: 123 });
    expect(f?.code).toBe("CWD_INVALID");
  });

  it("通过时剥掉放行参数 (不透传进 DB 层)", () => {
    const body: Record<string, unknown> = { cwd: path.join(home, "workspace", "exists"), create_if_missing: true, git_remote: "x" };
    expect(validateCwdFromBody(body)).toBeNull();
    expect(body.create_if_missing).toBeUndefined();
    expect(body.git_remote).toBeUndefined();
  });

  it("拒绝时不剥参数 (调用方可原样重试)", () => {
    const missing = path.join(tmp, "guaranteed-missing-2");
    const body: Record<string, unknown> = { cwd: missing, create_if_missing: true };
    // 带标志位 → 放行并真的建目录 (证明标志位生效)
    expect(validateCwdFromBody(body)).toBeNull();
    expect(fs.statSync(missing).isDirectory()).toBe(true);
    // 不带标志位 → 拒绝
    const body2: Record<string, unknown> = { cwd: path.join(tmp, "guaranteed-missing-3") };
    const f = validateCwdFromBody(body2);
    expect(f?.code).toBe("CWD_NOT_FOUND");
    expect(fs.existsSync(path.join(tmp, "guaranteed-missing-3"))).toBe(false);
  });
});
