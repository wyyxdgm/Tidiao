// createTask() max_turns 平台规则: < 200 时 console.warn + clamp 到 200。
// force_max_turns:true 跳过 clamp（仅内部 flag, 不进 /api/tasks 白名单）。
//
// 覆盖三条路径:
//   1) def.maxTurns 直传（API / CLI）
//   2) role.max_turns 继承（role 自己不被 clamp, 任务侧 clamp 解析后的值）
//   3) def.maxTurns + force_max_turns 跳过 clamp

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createRole } from "./roles";
import { createTask, getTaskById } from "./tasks";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-mt-clamp-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "mt-clamp-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createTask: max_turns 平台规则 (< 200 → warn + clamp 200)", () => {
  it("def.maxTurns=50 → 库里 200 + console.warn 被调", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = createTask({
        title: "t",
        prompt: "p",
        project_id: projectId,
        maxTurns: 50,
      });
      expect(getTaskById(t.id)!.max_turns).toBe(200);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((c) => /max_turns/.test(String(c[0])))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("def.maxTurns=0 / -1 也走 clamp（不再 throw）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t0 = createTask({ title: "t0", prompt: "p", project_id: projectId, maxTurns: 0 });
      expect(getTaskById(t0.id)!.max_turns).toBe(200);
      const tNeg = createTask({ title: "tn", prompt: "p", project_id: projectId, maxTurns: -1 });
      expect(getTaskById(tNeg.id)!.max_turns).toBe(200);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("def.maxTurns=200 直通, 不 warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = createTask({ title: "t", prompt: "p", project_id: projectId, maxTurns: 200 });
      expect(getTaskById(t.id)!.max_turns).toBe(200);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("def.maxTurns=1.5 → throw (malformed, 不是「太低」)", () => {
    expect(() => createTask({
      title: "t", prompt: "p", project_id: projectId, maxTurns: 1.5,
    })).toThrow(/maxTurns/);
  });

  it("force_max_turns:true 保留 def.maxTurns=50 原值, 不 warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = createTask({
        title: "t",
        prompt: "p",
        project_id: projectId,
        maxTurns: 50,
        force_max_turns: true,
      });
      expect(getTaskById(t.id)!.max_turns).toBe(50);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("createTask: role.max_turns 继承也走 clamp", () => {
  // role 自己不被 clamp（不在派发路径上），但 task 解析 resolved 值时 clamp。
  it("role.max_turns=50 → task 继承后落库 200 + warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const role = createRole({
        name: "low-cap-role",
        system_prompt: "x",
        max_turns: 50,
        ownerId,
      });
      const t = createTask({
        title: "t",
        prompt: "p",
        project_id: projectId,
        role_id: role.id,
      });
      expect(getTaskById(t.id)!.max_turns).toBe(200);
      expect(warnSpy).toHaveBeenCalled();
      // role 本身保持 50（不在派发路径上, 不该被 clamp 静默改写）
      const stored = getDb()
        .prepare("SELECT max_turns FROM roles WHERE id = ?")
        .get(role.id) as { max_turns: number | null };
      expect(stored.max_turns).toBe(50);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("def.maxTurns 显式覆盖 role.max_turns=50 → task 落库 200 (def 也被 clamp)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const role = createRole({
        name: "low-cap-role",
        system_prompt: "x",
        max_turns: 50,
        ownerId,
      });
      const t = createTask({
        title: "t",
        prompt: "p",
        project_id: projectId,
        role_id: role.id,
        maxTurns: 80,
      });
      expect(getTaskById(t.id)!.max_turns).toBe(200);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("不传 maxTurns + role.max_turns=250 → 落库 250, 不 warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const role = createRole({
        name: "high-cap-role",
        system_prompt: "x",
        max_turns: 250,
        ownerId,
      });
      const t = createTask({
        title: "t",
        prompt: "p",
        project_id: projectId,
        role_id: role.id,
      });
      expect(getTaskById(t.id)!.max_turns).toBe(250);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});