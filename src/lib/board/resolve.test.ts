// Board 文件解析单测 (R91): 项目 cwd 优先 + 平台回落 + 回落面收窄.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBoardFile, resolvePlatformBoard, platformBoardRoot } from "./resolve";

let tmp: string;
let projectCwd: string;
let platformRoot: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "board-resolve-")));
  projectCwd = path.join(tmp, "project");
  platformRoot = path.join(tmp, "platform");
  fs.mkdirSync(path.join(projectCwd, "boards"), { recursive: true });
  fs.mkdirSync(path.join(platformRoot, "boards", "nested"), { recursive: true });
  fs.mkdirSync(path.join(platformRoot, "docs"), { recursive: true });

  fs.writeFileSync(path.join(platformRoot, "boards", "project-progress.md"), "PLATFORM-PROGRESS");
  fs.writeFileSync(path.join(platformRoot, "boards", "overridden.md"), "PLATFORM-OVERRIDDEN");
  fs.writeFileSync(path.join(platformRoot, "boards", "nested", "deep.md"), "PLATFORM-DEEP");
  // 平台仓里的敏感文件 —— 回落绝不能读到
  fs.writeFileSync(path.join(platformRoot, "docs", "deploy-secrets.md"), "JWT_SECRET=hunter2");
  fs.writeFileSync(path.join(platformRoot, "ecosystem.config.cjs"), "module.exports={}");

  fs.writeFileSync(path.join(projectCwd, "boards", "overridden.md"), "PROJECT-OVERRIDDEN");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveBoardFile", () => {
  it("prefers the project's own board file", () => {
    const r = resolveBoardFile(projectCwd, "boards/overridden.md", platformRoot);
    expect(r?.origin).toBe("project");
    expect(r?.content).toBe("PROJECT-OVERRIDDEN");
    expect(r?.root).toBe(projectCwd);
  });

  it("falls back to the platform built-in board when the project has none", () => {
    const r = resolveBoardFile(projectCwd, "boards/project-progress.md", platformRoot);
    expect(r?.origin).toBe("platform");
    expect(r?.content).toBe("PLATFORM-PROGRESS");
    expect(r?.root).toBe(fs.realpathSync(platformRoot));
  });

  it("supports nested paths under boards/", () => {
    const r = resolveBoardFile(projectCwd, "boards/nested/deep.md", platformRoot);
    expect(r?.origin).toBe("platform");
    expect(r?.content).toBe("PLATFORM-DEEP");
  });

  it("returns null when neither side has the file", () => {
    expect(resolveBoardFile(projectCwd, "boards/nope.md", platformRoot)).toBeNull();
  });

  // 🔴 安全断言: 回落面只有 boards/ 一层
  it("never falls back outside boards/ (no reading platform docs/ or repo root)", () => {
    expect(resolveBoardFile(projectCwd, "docs/deploy-secrets.md", platformRoot)).toBeNull();
    expect(resolveBoardFile(projectCwd, "ecosystem.config.cjs", platformRoot)).toBeNull();
    expect(resolvePlatformBoard("docs/deploy-secrets.md", platformRoot)).toBeNull();
    expect(resolvePlatformBoard("boards", platformRoot)).toBeNull();
  });

  it("rejects traversal and hidden segments", () => {
    expect(resolveBoardFile(projectCwd, "boards/../docs/deploy-secrets.md", platformRoot)).toBeNull();
    expect(resolveBoardFile(projectCwd, "../platform/boards/project-progress.md", platformRoot)).toBeNull();
    expect(resolveBoardFile(projectCwd, "boards/.hidden.md", platformRoot)).toBeNull();
    expect(resolveBoardFile(projectCwd, "", platformRoot)).toBeNull();
  });

  it("rejects symlinks escaping the platform boards dir", () => {
    const link = path.join(platformRoot, "boards", "escape.md");
    fs.symlinkSync(path.join(platformRoot, "docs", "deploy-secrets.md"), link);
    try {
      expect(resolveBoardFile(projectCwd, "boards/escape.md", platformRoot)).toBeNull();
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("tolerates a platform root without boards/", () => {
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare, { recursive: true });
    expect(resolveBoardFile(projectCwd, "boards/project-progress.md", bare)).toBeNull();
  });
});

describe("platformBoardRoot", () => {
  it("honors ORCHESTRATOR_APP_ROOT override, defaults to process.cwd()", () => {
    const prev = process.env.ORCHESTRATOR_APP_ROOT;
    process.env.ORCHESTRATOR_APP_ROOT = "/tmp/whatever";
    expect(platformBoardRoot()).toBe("/tmp/whatever");
    delete process.env.ORCHESTRATOR_APP_ROOT;
    expect(platformBoardRoot()).toBe(process.cwd());
    if (prev !== undefined) process.env.ORCHESTRATOR_APP_ROOT = prev;
  });
});
